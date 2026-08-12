// Denetim orkestrasyonu: import → sinyaller → skor/status → olaylar.
// K9: hiçbir memory dosyasına yazım yok — çıktı yalnız depo + olay günlüğü.
//
// LLM yalnız çelişki sınıflamasında kullanılır. Maliyet muhasebesi tek toplu
// çağrıyı TEK Codex koşumu saymaz: classify.ts'te yürütücü hatası tekrarı ve
// bozuk-JSON düzeltme turu AYNI sayaca yazıyor. Üst sınır 3'tür — çağrı 1
// yürütücü hatası verir, çağrı 2 koşar ama geçersiz JSON döner, çağrı 3
// düzeltme turudur. (Görev 9 raporunun "en kötü 2" şerhi eksik saymış: iki
// kurtarma yolunun ARDIŞIK işleyebildiğini atlıyor.) Gerçek sayı yine de
// tahmin edilmez, `classifyCalls`tan okunur.

import type { Store } from "./store/db.ts";
import type { ExecutorAdapter } from "./adapters/executor.ts";
import { importMemoryDir, type ImportSummary } from "./importer/import.ts";
import { openGit } from "./signals/git.ts";
import {
  checkAnchors, scoreDrift, createGitBudget, SUSPICION_THRESHOLD,
  type AnchorState, type AnchorVerdict, type GitBudget,
} from "./signals/anchor-drift.ts";
import { hasStatusPattern } from "./signals/status-pattern.ts";
import { findCandidates, type NoteView } from "./signals/contradiction.ts";
import { classifyCandidates, MAX_CLASSIFY_ITEMS } from "./signals/classify.ts";
import { listActive, getAnchors, setSuspicion, markSuspect, clearSuspect } from "./store/findings.ts";
import { parseNote } from "./importer/parse.ts";
import { logEvent, type EventKind } from "./store/events.ts";

export { SUSPICION_THRESHOLD };

/**
 * Bozuk bir repoda not × çapa başına olay yazılırdı: 500 notluk bir depoda tek
 * koşum binlerce satır demek, ve `events` silinemez bir tablo (şema tetikleyici
 * ile koruyor) — yani şişme geri alınamaz. Aynı gerekçe scan.ts'teki
 * MAX_UNKNOWN_TYPES_PER_SCAN'in gerekçesi; sayı da bilerek onunla aynı.
 */
export const MAX_MEASUREMENT_EVENTS_PER_AUDIT = 20;

/**
 * `--origin-ref` verildi ama git o ref'i çözemedi. Ayrı tip, çünkü SESSİZ
 * düşmek kabul edilemez: ölçüldü (mimar, 2026-08-11), bayrak-şekilli değerler
 * git tarafından reddediliyor, `originRef` null oluyor ve denetim kullanıcıya
 * hiçbir şey söylemeden yalnız HEAD'e karşı koşuyordu. Altın set ölçümü tam da
 * bu pine dayandığı için sessiz düşüş ölçümün kendisini geçersiz kılar.
 */
export class OriginRefUnresolved extends Error {
  readonly ref: string;
  readonly repoRoot: string;
  constructor(ref: string, repoRoot: string) {
    super(
      `--origin-ref çözülemedi: ${ref}\n` +
      `repo: ${repoRoot}\n` +
      `denetim yalnız HEAD'e karşı koşardı — pin'li ölçüm bunu sessizce kabul edemez. ` +
      `Ref'i doğrulayın (\`git rev-parse --verify <ref>^{commit}\`) ya da --origin-ref'i kaldırın.`,
    );
    this.name = "OriginRefUnresolved";
    this.ref = ref;
    this.repoRoot = repoRoot;
  }
}

export interface AuditOptions {
  /** null: sınıflama atlanır (yalnız testte anlamlı — CLI, K2 gereği detect'ten geçirir). */
  executor: ExecutorAdapter | null;
  fetch?: boolean;
  /** Ölçüm pin'i (D-M3-8): origin/<default> yerine bu ref. */
  originRef?: string;
  maxClassifyItems?: number;
  /**
   * Koşumun git alt süreç tavanı. Verilmezse çapa sayısından türetilir
   * (anchor-drift.ts `createGitBudget` — sayının ölçüm gerekçesi orada).
   * Testte küçük bir değerle kapıyı açıkça sınamak için var.
   */
  maxGitCalls?: number;
  /**
   * Koşum kimliği. Olay günlüğü append-only ve KOŞUMLAR ARASI idempotent değil:
   * ölçüldü (2026-08-11), üç ardışık başarılı koşum `contradiction_confirmed`
   * olayını 1→2→3 yazıyor. Altın set ölçümü bu günlükten okunduğu için
   * "bu koşumda kaç çelişki onaylandı" sorusunun cevaplanabilir olması şart;
   * kimlik olmadan mükerrer sayım ölçümü bozuyor. (Yeniden faturalandırma ayrı
   * bir tasarım kararı — burada ÇÖZÜLMÜYOR, yalnız sayılabilir kılınıyor.)
   */
  runId?: string;
}

/** Kimlik verilmediyse (test, gömülü kullanım) yine de koşumlar ayrışsın. */
function newRunId(): string {
  return `${new Date().toISOString()}-${process.pid}`;
}

export interface AuditSummary {
  /** Bu özeti üreten koşumun kimliği — olay günlüğüyle eşleştirmek için. */
  runId: string;
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
   * Sınıflamaya girip HÜKÜM DÖNMEYEN aday sayısı. `contradictions` (onaylanan)
   * ve `classifyDropped` (bütçeye girmeyen) ile birlikte okunur: üçü de sıfırsa
   * çelişki boyutu gerçekten ölçüldü ve temiz çıktı.
   */
  classifyUnclassified: number;
  /**
   * Çelişki boyutu ÖLÇÜLEMEDİĞİ için önceki `suspect` hükmü korunan not sayısı.
   * "Bu not hâlâ suspect çünkü çelişki var" ile "…çünkü ölçüm yapılamadı"
   * ayrımının özetteki karşılığı.
   */
  heldUnmeasured: number;
  /** Git bütçesi dolduğu için HİÇ ölçülmemiş çapa sayısı (arıza değil, maliyet sınırı). */
  budgetExhaustedAnchors: number;
  /**
   * Koşumdaki TÜM çapaların durum dağılımı. Şüphe skoru bunun yalnız bir
   * kısmından üretiliyor (WEIGHT üç duruma bakıyor); `unverifiable` ve
   * `never_existed` hiç skor üretmediği için başka hiçbir alandan okunamaz.
   * M2'nin "%10 uydurma çapa" borcunun ölçüsü tam olarak bu iki sayı.
   */
  anchorStates: Record<AnchorState, number>;
  /**
   * Kaç çapa ölçülemedi (git söyleyemedi). `anchorStates.unverifiable`ten AYRI:
   * orada "sha yok" gibi meşru cevaplar da var, burada yalnız ARIZA sayılıyor.
   * CLI bunu ekrana basıyor — "git söyleyemedi" ile "dosya duruyor"u kullanıcı
   * ancak böyle ayırt edebiliyor.
   */
  measurementFailures: number;
  /**
   * `--fetch` istendi ama fetch arızalandı: origin ref'i BAYAT olabilir.
   * Ayrı bir alan, çünkü çapa sinyali yine de koşuyor — yani hiçbir sayaçta iz
   * bırakmıyor ve sessiz kalırsa kullanıcı bayat bir ölçümü taze sanıyor.
   */
  fetchFailed: boolean;
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
  const runId = opts.runId ?? newRunId();
  const sum: AuditSummary = {
    runId, import: null, gitAvailable: false, checked: 0, suspects: 0, cleared: 0,
    candidates: 0, classified: false, contradictions: 0, classifyDropped: 0, classifyCalls: 0,
    classifyUnclassified: 0, heldUnmeasured: 0, budgetExhaustedAnchors: 0,
    anchorStates: emptyAnchorStates(), measurementFailures: 0, fetchFailed: false,
  };

  /**
   * Her denetim olayı koşum kimliği taşır — tek yazma yolu bu.
   *
   * Kalan `ev` çağrıları (audit_started/failed/completed, anchor_signal_disabled,
   * git_fetch_failed, anchor_measurement_failed/overflow, classify_overflow,
   * classify_failed) bilerek kendi başlarına commit ediliyor: hiçbirinin depoda
   * bir SONUCU yok, gözlemin kendisi olayın tamamı. "Sonucu anlatan olay o
   * sonuçla aynı tx'te" kuralı yalnız bir kayıt yazan/superseded eden yollara
   * uygulanır; audit_started'ın kendi işleminde olması ise zorunlu (aşağıda).
   */
  const ev = (kind: EventKind, detail: Record<string, unknown>): void =>
    logEvent(store, { projectId: project.id, kind, detail: { runId, ...detail } });

  // Başlangıç kaydı HER ŞEYDEN önce ve kendi işleminde: import bir transaction'da,
  // skorlar çok sonra BAŞKASINDA commit ediliyor. Arada süreç ölürse not
  // `active`/skor 0 kalıyor ve bu "ölçüldü, temiz çıktı"dan ayırt edilemiyordu
  // (ölçüldü: Node varsayılanı SIGINT/SIGTERM'de finally'leri koşturmuyor,
  // yani Ctrl-C tam bu durumu üretiyor). `audit_started` var + `audit_completed`
  // yok = yarım denetim, ve bu artık DEPODAN okunabiliyor.
  ev("audit_started", { path: project.path, memoryDir: project.memoryDir });
  try {
    return await runAudit();
  } catch (err) {
    ev("audit_failed", { reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    throw err;
  }

  async function runAudit(): Promise<AuditSummary> {
    if (project.memoryDir !== null) sum.import = await importMemoryDir(store, project.id, project.memoryDir);

    const ctx = await openGit(project.path, { fetch: opts.fetch, originRef: opts.originRef });
    sum.gitAvailable = ctx !== null;
    if (ctx === null)
      ev("anchor_signal_disabled", { path: project.path });
    // Fetch arızası sinyali KAPATMAZ (yerel geçmiş hâlâ ölçülebilir) ama tazelik
    // iddiasını düşürür: bayat bir origin ref'ine karşı ölçüp bunu taze sanmak,
    // ölçümü sessizce yanlış yapar. Bu yüzden hem günlüğe hem özete.
    if (ctx?.fetchFailed !== undefined) {
      sum.fetchFailed = true;
      ev("git_fetch_failed", { path: project.path, reason: ctx.fetchFailed.reason.slice(0, 200) });
    }
    // Pin İSTENDİ ama tutmadı: sessizce yalnız HEAD'e karşı koşmak yerine dur.
    // (git yoksa hüküm zaten tümden kapalı ve `anchor_signal_disabled` yazılı —
    // orada ayrıca patlamak kullanıcıya yeni bir şey söylemezdi.)
    if (opts.originRef !== undefined && ctx !== null && ctx.originRef === null)
      throw new OriginRefUnresolved(opts.originRef, ctx.repoRoot);

    // Skorlar: active + suspect. unanchored NÖTR (M0-D5) — döngüye girmez ama
    // çelişki adaylığına aşağıda katılır (çapasız not da çelişebilir).
    const all = listActive(store, project.id);
    const scores = new Map<number, ScoreEntry>();
    /** Skor yazımıyla AYNI tx'te commit edilecek çelişki olayları (gerekçe altta). */
    const pendingContradictionEvents: Record<string, unknown>[] = [];
    let measurementEvents = 0;

    // Çapalar TEK seferde okunuyor: bütçe koşumun tamamı için kurulacağı için
    // toplam çapa sayısı döngüden ÖNCE bilinmeli, ve aşağıdaki `views` zaten
    // aynı okumayı ikinci kez yapıyordu.
    const anchorsById = new Map(all.map((f) => [f.id, getAnchors(store, f.id)]));
    const anchorCount = [...anchorsById.values()].reduce((n, a) => n + a.length, 0);
    const budget: GitBudget = opts.maxGitCalls !== undefined
      ? { limit: opts.maxGitCalls, used: 0 }
      : createGitBudget(anchorCount);

    for (const f of all) {
      if (f.status === "unanchored") continue;
      const anchors = anchorsById.get(f.id)!;
      const statusPattern = hasStatusPattern(f.content);
      const verdicts = ctx !== null ? await checkAnchors(ctx, anchors, f.createdAt, budget) : [];
      const drift = scoreDrift(verdicts, statusPattern);
      const states = countStates(verdicts);
      for (const [state, n] of Object.entries(states)) sum.anchorStates[state as AnchorState] += n;
      // Ölçüm arızası (A dalgası devri): artık hükme dönüşmüyor ama sessiz de
      // kalamaz — "git söyleyemedi" ile "dosya duruyor" kullanıcı için aynı şey
      // değil, ve arızanın kendisi (bozuk klon, erişilemez promisor) düzeltilebilir
      // bir durum. Bilgi şu ana kadar yalnız dönüş değerinde taşınıyordu.
      for (const v of verdicts) {
        if (v.budgetExhausted === true) sum.budgetExhaustedAnchors++;
        if (v.measurementFailed === undefined) continue;
        sum.measurementFailures++;
        if (measurementEvents >= MAX_MEASUREMENT_EVENTS_PER_AUDIT) continue;
        measurementEvents++;
        ev("anchor_measurement_failed", {
          findingId: f.id,
          anchorKind: v.anchor.kind,
          // Çapa değeri kullanıcı verisi ve SINIRSIZ olabiliyor: ölçüldü
          // (denetim: classify-reason-unbounded) 200 bin karakterlik tek bir yol
          // çapası. Olay satırı teşhis içindir, arşiv değil.
          anchor: v.anchor.value.slice(0, 200),
          command: v.measurementFailed.command.slice(0, 200),
          reason: v.measurementFailed.reason.slice(0, 200),
        });
      }
      scores.set(f.id, { score: drift.score, reasons: drift.reasons, states });
      sum.checked++;
    }
    // Tavan üstü arıza tek özet satırıyla sayılır (scan.ts unknown_type_overflow
    // kalıbı): sayı kaybolmasın ama `events` de şişmesin.
    if (sum.measurementFailures > measurementEvents)
      ev("anchor_measurement_overflow", {
        suppressed: sum.measurementFailures - measurementEvents, logged: measurementEvents,
      });

    // Bütçe tükenişi arıza DEĞİL maliyet sınırı (bu yüzden measurementFailures'a
    // yazılmıyor), ama sessiz de kalamaz: kalan çapalar hiç ölçülmedi ve bu,
    // "ölçüldü, temiz çıktı"dan ayırt edilebilmeli. Koşum başına TEK satır —
    // çapa başına yazmak, maliyet sınırını yüzlerce arıza gibi gösterirdi
    // (aynı gerekçe: observer_budget_halt).
    if (sum.budgetExhaustedAnchors > 0)
      ev("anchor_signal_disabled", {
        path: project.path, reason: "git_budget_exhausted",
        limit: budget.limit, used: budget.used,
        unmeasuredAnchors: sum.budgetExhaustedAnchors, totalAnchors: anchorCount,
      });

    // Çelişki: mekanik adaylar → tek toplu sınıflama.
    const views: NoteView[] = all.map((f) => ({
      findingId: f.id,
      content: f.content,
      anchors: anchorsById.get(f.id)!,
      description: f.source === "imported" ? (parseNote(f.content).frontmatter["description"] ?? null) : null,
      hasStatus: hasStatusPattern(f.content),
    }));
    const { candidates, skippedAnchors } = findCandidates(views);
    sum.candidates = candidates.length;
    if (skippedAnchors > 0)
      ev("classify_overflow", { skippedAnchors, note: "ayırt edici olmayan ortak çapalar çift üretmedi" });

    /**
     * Çelişki boyutu ÖLÇÜLEMEYEN notlar. Ölçüm arızası suçlamaya dönmez —
     * ama AKLAMAYA da dönmemeli: bu notların önceki `suspect` hükmü, yeni bir
     * ölçüm olmadığı için düşürülmez (aşağıdaki yazım döngüsü).
     *
     * Küme aday BAZINDA kuruluyor, koşum bazında değil: hiç adaya girmemiş bir
     * not sınıflama çökse de normal temizleme geçişini görür. Aksi hâlde bir
     * sınıflama arızası, çelişkiyle hiç ilgisi olmayan notları da dondururdu —
     * aşırı-koruma da bir yanlış karardır.
     */
    const unmeasuredFindings = new Set<number>();

    if (candidates.length > 0 && opts.executor !== null) {
      const notesById = new Map(views.map((v) => [v.findingId, v]));
      const res = await classifyCandidates(opts.executor, candidates, notesById,
        { maxItems: opts.maxClassifyItems ?? MAX_CLASSIFY_ITEMS });
      sum.classifyCalls = res.calls;
      sum.classifyDropped = res.dropped;
      sum.classifyUnclassified = res.unclassified;
      for (const c of res.unmeasured)
        for (const id of [c.aId, c.bId]) if (id !== null) unmeasuredFindings.add(id);
      if (res.dropped > 0)
        ev("classify_overflow", { droppedCandidates: res.dropped });
      // Hüküm dönmeyen aday sessiz kalamaz: "sınıflandı, temiz çıktı" ile
      // "karar verilmedi" ayrımı yalnız burada görünüyor.
      if (res.unclassified > 0)
        ev("classify_overflow", {
          unclassified: res.unclassified,
          note: "gösterilen adaya hüküm dönmedi — temiz sayılmadı",
        });
      if (!res.ok) {
        ev("classify_failed", {
          error: res.error, calls: res.calls,
          unmeasuredFindings: [...unmeasuredFindings],
        });
      } else {
        sum.classified = true;
        sum.contradictions = res.confirmed.length;
        for (const c of res.confirmed) {
          // Çelişki onaylanırsa İKİ taraf da yükselir (spec §3.4) — en az 0.7.
          // Taraf `unanchored` olsa bile: burada kayıt açılıyor ve yazım döngüsü
          // onu görüyor. Çapasız notun tek denetlenebilir yolu bu.
          for (const id of [c.aId, c.bId]) {
            if (id === null) continue;
            const cur = scores.get(id) ?? { score: 0, reasons: [], states: {} };
            scores.set(id, {
              score: Math.max(cur.score, 0.7),
              reasons: [...cur.reasons, `çelişki onaylandı (${c.kind}: ${c.reason})`],
              states: cur.states,
            });
          }
          // Olay HEMEN yazılmıyor, yazım tx'ine ertelendi. Aynı değişmez kural
          // (bkz. importer/import.ts): bir sonucu anlatan olay o sonuçla aynı
          // transaction'da commit edilir ya da hiç edilmez. Buradaki sonuç
          // yukarıdaki skor — ve o skor çok sonra, BAŞKA bir tx'te yazılıyor.
          // Arada ölüm: günlük "çelişki onaylandı" derken iki not da `active`
          // ve skoru 0 kalırdı, yani denetim günlüğü depoyu yanlış anlatırdı.
          // Erteleme burada mümkün çünkü olayın içeriği zaten elde; importer'da
          // mümkün değildi (orada sonucu üreten döngü olayı hiç görmüyor).
          pendingContradictionEvents.push({ kind: c.kind, aId: c.aId, bId: c.bId, reason: c.reason });
        }
      }
    }

    // Yazım: skor SIFIRDAN (D-M3-3), geçiş active↔suspect (D-M3-9), her şey olaylı.
    store.tx(() => {
      for (const c of pendingContradictionEvents) ev("contradiction_confirmed", c);
      for (const f of all) {
        // Skor kaydı olmayan tek küme: hiç çelişkiye girmemiş `unanchored` not.
        // Yukarıdaki skor döngüsü onu atladı (M0-D5: çapa sinyali çapasız nota
        // dokunmaz) ve çelişki de bir katkı koymadıysa nota HİÇ dokunulmaz —
        // skor 0 bile yazılmaz, olay bile düşmez. Çelişki bir katkı koyduysa
        // kayıt vardır ve aşağıdaki yol çapalı notunkiyle aynıdır: nötrlük çapa
        // sinyaline özgüdür, içsel sinyale değil (mimar kararı, düzeltme turu).
        const s = scores.get(f.id);
        if (s === undefined) continue;
        // "Ölçemedim" ile "temiz" aynı şey değil — ürünün en temel ayrımı.
        // Denetim (2026-08-12, `classify-failure-clears-suspect`) ölçtü: ilk
        // denetim çelişkiyi onaylayıp suspect/0,7 yazıyor, ikinci denetimde
        // yürütücü çökünce not `active`/0'a DÖNÜYORDU. Yeni skor yalnız çapa
        // boyutundan geliyor; çelişki boyutu ölçülemediği için o boyutun
        // ürettiği şüphe DÜŞÜRÜLEMEZ. Çapa katkısı yine de yükseltebilir,
        // o yüzden max.
        if (unmeasuredFindings.has(f.id) && f.status === "suspect" && s.score < SUSPICION_THRESHOLD) {
          const held = Math.max(s.score, f.suspicion);
          setSuspicion(store, f.id, held);
          ev("signal_scored", {
            findingId: f.id, score: held, states: s.states, heldUnmeasured: true,
            reasons: [...s.reasons,
              `çelişki boyutu ÖLÇÜLEMEDİ — önceki hüküm korundu (çapa skoru: ${s.score})`],
          });
          sum.suspects++;
          sum.heldUnmeasured++;
          continue;
        }
        setSuspicion(store, f.id, s.score);
        ev("signal_scored", { findingId: f.id, score: s.score, reasons: s.reasons, states: s.states });
        if (s.score >= SUSPICION_THRESHOLD && (f.status === "active" || f.status === "unanchored")) {
          markSuspect(store, f.id);
          sum.suspects++;
          ev("finding_suspect", { findingId: f.id, score: s.score });
        } else if (s.score < SUSPICION_THRESHOLD && f.status === "suspect") {
          clearSuspect(store, f.id);
          sum.cleared++;
          ev("finding_cleared", { findingId: f.id, score: s.score });
        } else if (s.score >= SUSPICION_THRESHOLD) sum.suspects++;
      }
    });

    // Bitiş kaydı YAZIMDAN SONRA: daha erken yazılırsa "tamamlandı" yarım bir
    // denetimi de kapsar ve `audit_started`/`audit_completed` çifti hiçbir şey
    // ayırt etmez olurdu.
    ev("audit_completed", {
      checked: sum.checked, suspects: sum.suspects, cleared: sum.cleared,
      candidates: sum.candidates, contradictions: sum.contradictions,
      classifyCalls: sum.classifyCalls, measurementFailures: sum.measurementFailures,
      classifyUnclassified: sum.classifyUnclassified, heldUnmeasured: sum.heldUnmeasured,
      budgetExhaustedAnchors: sum.budgetExhaustedAnchors,
      fetchFailed: sum.fetchFailed,
      importErrors: sum.import?.errors ?? 0, importRejected: sum.import?.rejected ?? 0,
    });
    return sum;
  }
}
