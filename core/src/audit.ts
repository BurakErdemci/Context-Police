// Denetim orkestrasyonu: import → sinyaller → skor/status → olaylar.
// K9: hiçbir memory dosyasına yazım yok — çıktı yalnız depo + olay günlüğü.
//
// LLM yalnız çelişki sınıflamasında kullanılır. Maliyet muhasebesi tek toplu
// çağrıyı TEK Codex koşumu saymaz: classify.ts'te yürütücü hatası tekrarı ve
// bozuk-JSON düzeltme turu aynı sayaca yazıyor, yani bir sınıflama 1–3 gerçek
// koşum olabilir (Görev 9 raporu, şerh 1). Gerçek sayı `classifyCalls`tadır;
// başka hiçbir yerde tahmin edilmez.

import type { Store } from "./store/db.ts";
import type { ExecutorAdapter } from "./adapters/executor.ts";
import { importMemoryDir, type ImportSummary } from "./importer/import.ts";
import { openGit } from "./signals/git.ts";
import {
  checkAnchors, scoreDrift, SUSPICION_THRESHOLD,
  type AnchorState, type AnchorVerdict,
} from "./signals/anchor-drift.ts";
import { hasStatusPattern } from "./signals/status-pattern.ts";
import { findCandidates, type NoteView } from "./signals/contradiction.ts";
import { classifyCandidates, MAX_CLASSIFY_ITEMS } from "./signals/classify.ts";
import { listActive, getAnchors, setSuspicion, markSuspect, clearSuspect } from "./store/findings.ts";
import { parseNote } from "./importer/parse.ts";
import { logEvent } from "./store/events.ts";

export { SUSPICION_THRESHOLD };

export interface AuditOptions {
  /** null: sınıflama atlanır (yalnız testte anlamlı — CLI, K2 gereği detect'ten geçirir). */
  executor: ExecutorAdapter | null;
  fetch?: boolean;
  /** Ölçüm pin'i (D-M3-8): origin/<default> yerine bu ref. */
  originRef?: string;
  maxClassifyItems?: number;
}

export interface AuditSummary {
  import: ImportSummary | null;
  gitAvailable: boolean;
  checked: number;
  suspects: number;
  cleared: number;
  candidates: number;
  classified: boolean;
  contradictions: number;
  classifyDropped: number;
  classifyCalls: number;
  /**
   * Koşumdaki TÜM çapaların durum dağılımı. Şüphe skoru bunun yalnız bir
   * kısmından üretiliyor (WEIGHT üç duruma bakıyor); `unverifiable` ve
   * `never_existed` hiç skor üretmediği için başka hiçbir alandan okunamaz.
   * M2'nin "%10 uydurma çapa" borcunun ölçüsü tam olarak bu iki sayı.
   */
  anchorStates: Record<AnchorState, number>;
}

interface ScoreEntry {
  score: number;
  reasons: string[];
  /** Yalnız SIFIR OLMAYAN durumlar — olay detayını gereksiz şişirmemek için. */
  states: Partial<Record<AnchorState, number>>;
}

function emptyAnchorStates(): Record<AnchorState, number> {
  return { ok: 0, missing_now: 0, never_existed: 0, symbol_lost: 0, churned: 0, unverifiable: 0 };
}

function countStates(verdicts: AnchorVerdict[]): Partial<Record<AnchorState, number>> {
  const out: Partial<Record<AnchorState, number>> = {};
  for (const v of verdicts) out[v.state] = (out[v.state] ?? 0) + 1;
  return out;
}

export async function auditProject(
  store: Store,
  project: { id: number; path: string; memoryDir: string | null },
  opts: AuditOptions,
): Promise<AuditSummary> {
  const sum: AuditSummary = {
    import: null, gitAvailable: false, checked: 0, suspects: 0, cleared: 0,
    candidates: 0, classified: false, contradictions: 0, classifyDropped: 0, classifyCalls: 0,
    anchorStates: emptyAnchorStates(),
  };

  if (project.memoryDir !== null) sum.import = await importMemoryDir(store, project.id, project.memoryDir);

  const ctx = await openGit(project.path, { fetch: opts.fetch, originRef: opts.originRef });
  sum.gitAvailable = ctx !== null;
  if (ctx === null)
    logEvent(store, { projectId: project.id, kind: "anchor_signal_disabled", detail: { path: project.path } });

  // Skorlar: active + suspect. unanchored NÖTR (M0-D5) — döngüye girmez ama
  // çelişki adaylığına aşağıda katılır (çapasız not da çelişebilir).
  const all = listActive(store, project.id);
  const scores = new Map<number, ScoreEntry>();

  for (const f of all) {
    if (f.status === "unanchored") continue;
    const anchors = getAnchors(store, f.id);
    const statusPattern = hasStatusPattern(f.content);
    const verdicts = ctx !== null ? await checkAnchors(ctx, anchors, f.createdAt) : [];
    const drift = scoreDrift(verdicts, statusPattern);
    const states = countStates(verdicts);
    for (const [state, n] of Object.entries(states)) sum.anchorStates[state as AnchorState] += n;
    scores.set(f.id, { score: drift.score, reasons: drift.reasons, states });
    sum.checked++;
  }

  // Çelişki: mekanik adaylar → tek toplu sınıflama.
  const views: NoteView[] = all.map((f) => ({
    findingId: f.id,
    content: f.content,
    anchors: getAnchors(store, f.id),
    description: f.source === "imported" ? (parseNote(f.content).frontmatter["description"] ?? null) : null,
    hasStatus: hasStatusPattern(f.content),
  }));
  const { candidates, skippedAnchors } = findCandidates(views);
  sum.candidates = candidates.length;
  if (skippedAnchors > 0)
    logEvent(store, { projectId: project.id, kind: "classify_overflow",
      detail: { skippedAnchors, note: "ayırt edici olmayan ortak çapalar çift üretmedi" } });

  if (candidates.length > 0 && opts.executor !== null) {
    const notesById = new Map(views.map((v) => [v.findingId, v]));
    const res = await classifyCandidates(opts.executor, candidates, notesById,
      { maxItems: opts.maxClassifyItems ?? MAX_CLASSIFY_ITEMS });
    sum.classifyCalls = res.calls;
    sum.classifyDropped = res.dropped;
    if (res.dropped > 0)
      logEvent(store, { projectId: project.id, kind: "classify_overflow", detail: { droppedCandidates: res.dropped } });
    if (!res.ok) {
      logEvent(store, { projectId: project.id, kind: "classify_failed", detail: { error: res.error, calls: res.calls } });
    } else {
      sum.classified = true;
      sum.contradictions = res.confirmed.length;
      for (const c of res.confirmed) {
        // Çelişki onaylanırsa İKİ taraf da yükselir (spec §3.4) — en az 0.7.
        for (const id of [c.aId, c.bId]) {
          if (id === null) continue;
          const cur = scores.get(id) ?? { score: 0, reasons: [], states: {} };
          scores.set(id, {
            score: Math.max(cur.score, 0.7),
            reasons: [...cur.reasons, `çelişki onaylandı (${c.kind}: ${c.reason})`],
            states: cur.states,
          });
        }
        // Olay, yazım döngüsünden BAĞIMSIZ düşer: çelişkinin bir tarafı
        // unanchored ise skoru yazılmaz (M0-D5) ama bulgu kaybolmaz — sessiz
        // yutma yasağının bu yoldaki karşılığı bu kayıt.
        logEvent(store, { projectId: project.id, kind: "contradiction_confirmed",
          detail: { kind: c.kind, aId: c.aId, bId: c.bId, reason: c.reason } });
      }
    }
  }

  // Yazım: skor SIFIRDAN (D-M3-3), geçiş active↔suspect (D-M3-9), her şey olaylı.
  store.tx(() => {
    for (const f of all) {
      if (f.status === "unanchored") continue;
      const s = scores.get(f.id) ?? { score: 0, reasons: [], states: {} };
      setSuspicion(store, f.id, s.score);
      logEvent(store, { projectId: project.id, kind: "signal_scored",
        detail: { findingId: f.id, score: s.score, reasons: s.reasons, states: s.states } });
      if (s.score >= SUSPICION_THRESHOLD && f.status === "active") {
        markSuspect(store, f.id);
        sum.suspects++;
        logEvent(store, { projectId: project.id, kind: "finding_suspect", detail: { findingId: f.id, score: s.score } });
      } else if (s.score < SUSPICION_THRESHOLD && f.status === "suspect") {
        clearSuspect(store, f.id);
        sum.cleared++;
        logEvent(store, { projectId: project.id, kind: "finding_cleared", detail: { findingId: f.id, score: s.score } });
      } else if (s.score >= SUSPICION_THRESHOLD) sum.suspects++;
    }
  });

  return sum;
}
