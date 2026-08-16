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
import { nowIso } from "./store/db.ts";
import type { ExecutorAdapter } from "./adapters/executor.ts";
import { importMemoryDir, type ImportSummary } from "./importer/import.ts";
import { openGit } from "./signals/git.ts";
import {
  checkAnchors, scoreDrift, createGitBudget, SUSPICION_THRESHOLD,
  type AnchorState, type AnchorVerdict, type GitBudget,
} from "./signals/anchor-drift.ts";
import { hasStatusPattern } from "./signals/status-pattern.ts";
import { findCandidates, type Candidate, type NoteView } from "./signals/contradiction.ts";
import { findCoverageCandidates } from "./signals/coverage.ts";
import { classifyCandidates, MAX_CLASSIFY_ITEMS } from "./signals/classify.ts";
import { listActive, getAnchors, setSuspicion, markSuspect, clearSuspect } from "./store/findings.ts";
import { readRotationState, writeClassifyStamps } from "./store/classify-stamps.ts";
import { recordVerdict, getLiveVerdict, type VerdictValue } from "./store/verdicts.ts";
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
  /**
   * `candidates` içindeki KAPSAMA ROTASYONU adayları: hiçbir tetikleyicisi
   * olmadığı için sıraya konmuş notlar. Ayrı sayılıyor, çünkü "kaç çelişki
   * adayı vardı" ile "kaç nota sırası geldiği için bakıldı" farklı sorular ve
   * ikincisi kapsama sınırının tek görünür ölçüsü.
   */
  coverageCandidates: number;
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
   * Bir BOYUTU ölçülemediği için önceki `suspect` hükmü korunan not sayısı.
   * "Bu not hâlâ suspect çünkü çelişki var" ile "…çünkü ölçüm yapılamadı"
   * ayrımının özetteki karşılığı. İki boyut da sayılır: çelişki (sınıflama
   * arızası/kırpması) ve çapa (git bütçesi tükendi ya da git söyleyemedi).
   */
  heldUnmeasured: number;
  /**
   * Rotasyon açlığı yüzünden bu koşumda kaydı açılan not sayısı. Sıfırdan farklı
   * olması notlar hakkında değil BÜTÇE/ROTASYON hakkında bir sinyal: aday üretimi
   * bütçenin dönebileceğinden hızlı büyüyor demek.
   */
  starvedFindings: number;
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
  /**
   * Bu koşumda depoya YENİ yazılan hüküm satırı sayısı (store/verdicts.ts).
   * Değişmeyen bir sonuç satır açmadığı için bu sayı "kaç not çürük" değil,
   * "kullanıcının onay kuyruğunda ne değişti" demek.
   */
  verdictsRecorded: number;
}

interface ScoreEntry {
  score: number;
  reasons: string[];
  /** Yalnız SIFIR OLMAYAN durumlar — olay detayını gereksiz şişirmemek için. */
  states: Partial<Record<AnchorState, number>>;
  /** Kesin çapa kanıtı: git ölçtü ve yüzey gitmiş. Yoksa null (bkz. anchorEvidence). */
  decisive: AnchorEvidence | null;
  /** Çapa boyutu bu koşumda GERÇEKTEN ölçüldü mü (git vardı ve çapa vardı). */
  anchorsMeasured: boolean;
}

interface AnchorEvidence {
  verdict: VerdictValue;
  decayType: string | null;
  evidence: string;
}

/** Kanıt metninde listelenecek çapa sayısı: teşhise yeter, satırı şişirmez. */
const MAX_EVIDENCE_ANCHORS = 5;

function evidenceLine(state: AnchorState, verdicts: AnchorVerdict[]): string {
  const values = verdicts.map((v) => v.anchor.value.slice(0, 200)).sort();
  const shown = values.slice(0, MAX_EVIDENCE_ANCHORS).join(", ");
  const rest = values.length > MAX_EVIDENCE_ANCHORS ? ` (+${values.length - MAX_EVIDENCE_ANCHORS})` : "";
  return `${state}: ${shown}${rest}`;
}

/**
 * Mekanik katmanın hüküm verebildiği TEK durum: git bir yüzeyin gittiğini
 * ÖLÇTÜ. Geri kalan her şey (temiz çapa, churn, DURUM kalıbı) şüphedir — ve
 * şüphe hüküm değildir, çünkü hiçbiri notun METNİNİ okumuyor. `gecerli` bu
 * yüzden buradan hiç dönmez: çapası duran bir not pekâlâ yanlış olabilir.
 *
 * Sıra ağırlığı izliyor (anchor-drift WEIGHT): dosya yoksa sembolün durumu
 * ikincil bilgidir.
 *
 * `never_existed` → `dogustan-yanlis`, çünkü o hüküm ancak sonek çözümlemesi
 * SIFIR eşleşme döndükten sonra ayakta kalıyor (anchor-drift.ts): yol hiçbir
 * commit'te yoktu, yani not yazıldığı gün de yanlıştı. `decay_type` bilerek
 * null — çürüme sözlüğü yalnız `curuk` içindir (tools/altin-set/validate.ts).
 */
function decisiveAnchorEvidence(verdicts: AnchorVerdict[]): AnchorEvidence | null {
  const of = (s: AnchorState) => verdicts.filter((v) => v.state === s);
  const missing = of("missing_now");
  if (missing.length > 0)
    return { verdict: "curuk", decayType: "dosya-silindi", evidence: evidenceLine("missing_now", missing) };
  const lost = of("symbol_lost");
  if (lost.length > 0)
    return { verdict: "curuk", decayType: "sembol-kayboldu", evidence: evidenceLine("symbol_lost", lost) };
  const never = of("never_existed");
  if (never.length > 0)
    return { verdict: "dogustan-yanlis", decayType: null, evidence: evidenceLine("never_existed", never) };
  return null;
}

/** Mekanik katmanın geri alabileceği hükümler: kendi verdikleri. */
const MECHANICAL_WITHDRAWABLE = new Set<VerdictValue>(["curuk", "dogustan-yanlis"]);

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
    candidates: 0, coverageCandidates: 0, classified: false, contradictions: 0,
    classifyDropped: 0, classifyCalls: 0,
    classifyUnclassified: 0, heldUnmeasured: 0, starvedFindings: 0, budgetExhaustedAnchors: 0,
    anchorStates: emptyAnchorStates(), measurementFailures: 0, fetchFailed: false,
    verdictsRecorded: 0,
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
    /**
     * ÇAPA boyutu bu notlar için eksik ölçüldü: bütçe tükendiği için hiç
     * koşmayan ya da koşup arızalanan bir git çağrısı var.
     *
     * Neden küme (denetim: doğrulama turu, `budget-exhaustion-acquits-existing-suspect`):
     * bütçe kapısı ölçülmeyen çapayı `unverifiable`/sıfır ağırlığa çeviriyor,
     * yani düşük bir skor üretiyor — ve o düşük skor, sınıflama tarafında zaten
     * kurulmuş olan "ölçemedim ≠ temiz" korumasının OLMADIĞI bu yolda var olan
     * bir `suspect` hükmünü temizleyebiliyordu. Ölçüldü: çapa SIRASI hangi
     * kanıtın kaybolacağını belirliyordu — 15 var olmamış yolun ardındaki
     * silinmiş `victim.ts` bütçeye takılınca 0,9'luk suspect aklanıyor, geniş
     * bütçeyle aynı koşum suspect tutuyordu.
     *
     * Koruma NOT BAZINDA: bütçe tükendi diye koşumun tamamı dondurulmaz —
     * çapaları tam ölçülmüş notlar normal temizleme geçişini görür (aynı gerekçe
     * `unmeasuredFindings`te yazılı: aşırı-koruma da bir yanlış karardır).
     */
    const unmeasuredAnchorFindings = new Set<number>();
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
      // Without git NOTHING was measured, so the loop below — which fills
      // unmeasuredAnchorFindings from the verdicts — never runs and the acquittal
      // guard downstream saw an empty `missing`. The verdict path was already
      // protected (it reads anchorsMeasured); the suspicion path was not, so a
      // single run on a machine without git cleared every anchored suspect in the
      // project while the verdicts table still said `curuk` — two tables, two
      // different answers to the same question. Anchorless findings stay out:
      // their anchor dimension is not unmeasured, it is empty.
      if (ctx === null && anchors.length > 0) unmeasuredAnchorFindings.add(f.id);
      const drift = scoreDrift(verdicts, statusPattern);
      const states = countStates(verdicts);
      for (const [state, n] of Object.entries(states)) sum.anchorStates[state as AnchorState] += n;
      // Ölçüm arızası (A dalgası devri): artık hükme dönüşmüyor ama sessiz de
      // kalamaz — "git söyleyemedi" ile "dosya duruyor" kullanıcı için aynı şey
      // değil, ve arızanın kendisi (bozuk klon, erişilemez promisor) düzeltilebilir
      // bir durum. Bilgi şu ana kadar yalnız dönüş değerinde taşınıyordu.
      for (const v of verdicts) {
        // Bütçe tükenmesi (komut hiç koşmadı) ile ölçüm arızası (komut koştu,
        // cevap vermedi) maliyet/arıza ayrımı gereği ayrı sayaçlarda durur; ama
        // ikisi de AYNI şeyi söylüyor: bu çapa hakkında bilgimiz yok. Hüküm
        // korumasında bu yüzden birlikte ele alınıyorlar.
        if (v.budgetExhausted === true) { sum.budgetExhaustedAnchors++; unmeasuredAnchorFindings.add(f.id); }
        if (v.measurementFailed === undefined) continue;
        unmeasuredAnchorFindings.add(f.id);
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
      scores.set(f.id, {
        score: drift.score, reasons: drift.reasons, states,
        decisive: decisiveAnchorEvidence(verdicts),
        // Git yoksa ya da notun çapası yoksa çapa boyutu ÖLÇÜLMEDİ. Aşağıdaki
        // geri alma yolu buna bakmak zorunda: aksi hâlde git'i olmayan bir
        // makinede koşan tek bir denetim, ölçülmüş bir çürük hükmünü "kanıt
        // kalmadı" diye geri çekerdi (ölçmemek asla hüküm değildir).
        anchorsMeasured: ctx !== null && anchors.length > 0,
      });
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
    const { candidates: contradictions, skippedAnchors } = findCandidates(views);
    // Kapsama rotasyonu: hiçbir çelişki adayına girmemiş not da sıraya girer.
    // Ölçüldü (altın set, 28 not): 14'ünün hiç dosya çapası yok, 2'si yolunu
    // kaybediyor — 28'in yalnız 12'si bir HAREKET sinyali üretebiliyor. Tetikleyici
    // beklemek, kalan 16'yı bir daha hiç bakılmayan nota çeviriyordu.
    const coverage = findCoverageCandidates(views, contradictions);
    const candidates = [...contradictions, ...coverage];
    sum.coverageCandidates = coverage.length;
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
    /**
     * Not → o notun çelişki boyutunun NEDEN ölçülemediği. Kullanıcıya açılan
     * `olculemez` kaydının `sub_reason`ı buradan geliyor: "sınıflandırıcı hiç
     * koşmadı" ile "koştu ama bu adaya cevap dönmedi" kullanıcı için farklı iki
     * iş kalemi — ilki bir yapılandırma sorunu, ikincisi bir ölçüm arızası.
     */
    const unmeasuredReasons = new Map<number, string>();
    /** Rotasyonda üç tam tur boyunca sırası gelmemiş adayların notları. */
    const starvedFindings = new Set<number>();
    /**
     * Bir sonraki koşumun aday rotasyon damgaları (+ bu koşumun damga değeri);
     * null = bu koşumda sınıflama hiç çalışmadı, damgalara dokunulmaz.
     */
    let rotation:
      | { stamps: Record<string, number>; seen: Record<string, number>; stamp: number; renumbered: boolean }
      | null = null;

    /**
     * Çelişki boyutu ölçülemeyen adayları işaretler ve sebebini saklar.
     *
     * `answered` = bu koşumda EN AZ BİR adaya hüküm döndü mü. Kapsama adayları
     * yalnız o zaman korunuyor, ve kural sınıflama arızası ile yürütücüsüz koşum
     * için AYNI: kapsama yüzeyinde her not aday olduğu için, hiçbir cevap
     * dönmediğinde "ölçülemedi" kümesi deponun tamamı demek — bu, tek bir not
     * hakkında bir kanıt değil. Cevap dönmüşse sessizlik NOTA ÖZGÜ bir arıza ve
     * korunması gereken tam da o. Çelişki yüzeylerinde (cross/intra/frontmatter)
     * aday olmak notun kendi içeriğinden geliyor, kütüğün tamamından değil —
     * orada koşul yok.
     */
    const markUnmeasured = (cands: Candidate[], answered: boolean, reason: string): void => {
      for (const c of cands) {
        if (c.kind === "coverage" && !answered) continue;
        for (const id of [c.aId, c.bId]) {
          if (id === null) continue;
          unmeasuredFindings.add(id);
          // İlk sebep kalıyor: aynı not iki yüzeyden gelebilir, ve ikisi de
          // "ölçülemedi" diyor — kullanıcıya iki satır değil bir satır gider.
          if (!unmeasuredReasons.has(id)) unmeasuredReasons.set(id, reason);
        }
      }
    };

    // Yürütücü YOKSA çelişki boyutu hiç kimse için ölçülmedi. Eskiden bu yol
    // hiçbir işaret bırakmıyordu: skorlama sıfır skoru ÖLÇÜLMÜŞ sayıp var olan
    // şüpheyi temizliyordu (probe: classifier-off-clears-suspect.mjs, suspect/0,9
    // → unanchored/0 ve özet bir AKLAMA raporluyordu). `ctx === null` çapa
    // yolunda kapatılan deliğin (851246d) çelişki boyutundaki kardeşi.
    // `answered: true` GEÇİLİYOR, ve bu kasıtlı: yürütücünün YOKLUĞU bir arıza
    // değil bir YAPILANDIRMA. Çağıran çelişki boyutunu bilerek kapattı, yani
    // "hiç kimse için ölçülmedi" bu koşum hakkında kesin bir olgu — geçici bir
    // sinyal değil. Kapsama adaylarını burada dışarıda bırakmak, sınıfın
    // ÇOĞUNLUK vakasını açık bırakıyordu: içeriğinden çelişki adayı doğmayan
    // bir not (description'sız, iç çelişkisiz — notların tipik hâli) yalnız
    // kapsama adayı üretir, o da atlanınca korumasız kalır ve şüphesi
    // temizlenir. Ölçüldü (probe `coverage-only-clears.ts`, 16 Ağu, denetim
    // bulgusu): aynı `executor: null` koşumunda kapsama-only not
    // `suspect/0,9 → unanchored/0` aklanırken frontmatter adayı olan not
    // korunuyordu — tek koşum, iki not, zıt sonuç.
    //
    // Sınıflandırıcı KOŞUP cevap vermediğinde (`ok:false` ya da sıfır hüküm)
    // aynı şey yapılmıyor; oradaki koşul duruyor. Fark, kaza ile seçim arasında:
    // geçici bir yürütücü çökmesinin tüm depoyu dondurması aşırı-korumadır,
    // kullanıcının kapattığı bir boyutun dondurması ise doğru cevaptır — ve
    // artık onay kuyruğunda görünüyor.
    if (candidates.length > 0 && opts.executor === null)
      markUnmeasured(candidates, true, "classifier-not-run");

    if (candidates.length > 0 && opts.executor !== null) {
      const notesById = new Map(views.map((v) => [v.findingId, v]));
      const state = readRotationState(store, project.id);
      const res = await classifyCandidates(opts.executor, candidates, notesById, {
        maxItems: opts.maxClassifyItems ?? MAX_CLASSIFY_ITEMS,
        stamps: state.selected,
        seen: state.seen,
        // Çalışma kökü DENETLENEN projedir (`projects.path`) — CLI'nin nereden
        // çağrıldığı değil. Bkz. classifyCandidates'taki sınır notu: kök seçmek
        // okumayı hapsetmez.
        cwd: project.path,
      });
      rotation = {
        stamps: res.nextStamps, seen: res.nextSeen, stamp: res.rotationStamp, renumbered: res.renumbered,
      };
      sum.classifyCalls = res.calls;
      sum.classifyDropped = res.dropped;
      sum.classifyUnclassified = res.unclassified;
      markUnmeasured(res.undecided, res.measured.length > 0, "classify-undecided");
      // Açlık şüpheyi DONDURMAZ (sırası gelmemek notların normal hâli) ama sessiz
      // de kalamaz: bir aday üç tam rotasyon turu boyunca seçilmediyse ölçülmeyen
      // şey notun kendisi değil ROTASYONUN ADALETİ, ve onu ancak kullanıcı
      // düzeltebilir (bütçe, aday seli, yüzey kotası).
      for (const c of res.starvedLong) for (const id of [c.aId, c.bId]) if (id !== null) starvedFindings.add(id);
      // Rotasyon imleci kırpma olayının İÇİNDE: "20 aday atıldı" tek başına
      // okunduğunda hep aynı 20'sinin atıldığı sanılabilir — pencerenin
      // ilerlediği ancak burada görünür. (Kırpma görünürlüğü, D dalgası.)
      if (res.dropped > 0)
        ev("classify_overflow", {
          droppedCandidates: res.dropped,
          // Damga haritasının TAMAMI değil, bu koşumun damgası ve seçilen
          // kimlikler: harita proje ömrüyle büyüyor, olay detayı büyümemeli.
          rotation: { stamp: res.rotationStamp, selected: sum.candidates - res.dropped },
        });
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
            const cur = scores.get(id) ?? { score: 0, reasons: [], states: {}, decisive: null, anchorsMeasured: false };
            scores.set(id, {
              score: Math.max(cur.score, 0.7),
              reasons: [...cur.reasons, c.kind === "coverage"
                // Kapsama hükmü bir ÇELİŞKİ değil: karşı taraf başka bir not
                // değil deponun kendisi. Aynı metni kullanmak, gerekçeyi okuyan
                // kişiye var olmayan bir ikinci notu aratırdı.
                ? `kapsama ölçümü: not bugünkü depoyla uyuşmuyor (${c.reason})`
                : `çelişki onaylandı (${c.kind}: ${c.reason})`],
              states: cur.states,
              // Çelişki bir ÇAPA kanıtı değil: kesin kanıt ve ölçülmüşlük
              // bayrağı çapa döngüsünden ne aldıysa o kalır.
              decisive: cur.decisive, anchorsMeasured: cur.anchorsMeasured,
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

    /**
     * Skoru hükme çevirir — ve çoğu zaman ÇEVİRMEZ.
     *
     * Üç dal var, üçüncüsü "hiçbir şey yapma" ve en sık işleyen o:
     *   1. Kesin çapa kanıtı VE eşik üstü skor → `curuk`/`dogustan-yanlis`.
     *      Eşik koşulu kozmetik değil: tek bir `missing_now` 0,5 ağırlık verir,
     *      yani denetim notu şüpheli bile saymaz. Onay kuyruğuna, aracın kendi
     *      yüzeyinde şüpheli görünmeyen bir not düşemez.
     *   2. Kanıt YOKSA ama elde bizim verdiğimiz bir çürük hüküm varsa ve çapa
     *      boyutu bu koşumda gerçekten ölçüldüyse → hüküm `olculemez`
     *      (`anchor-evidence-cleared`) ile geri alınır. Silme yok (§3.2): eski
     *      satır kanıtıyla birlikte duruyor, yalnız supersede ediliyor. Geri alma
     *      `gecerli` DEĞİL, çünkü çapasının durması notun metnini doğrulamaz.
     *   3. Aksi hâlde dokunulmaz. Özellikle: hakemin (`adjudicator`) hükmü ucuz
     *      katman tarafından geri alınamaz — pahalı ölçümü, hiç metin okumamış
     *      bir sinyalin sessizce ezmesi olurdu.
     *
     * `correction` mekanik yolda hep null: git bir notun yanlış olduğunu
     * kanıtlayabilir, doğrusunun ne olduğunu bilemez. Alanı dolduracak olan
     * hakem (M5 sonrası).
     */
    function persistVerdict(findingId: number, s: ScoreEntry): void {
      const method = "anchor-drift (git)";
      if (s.decisive !== null && s.score >= SUSPICION_THRESHOLD) {
        const r = recordVerdict(store, {
          projectId: project.id, findingId, verdict: s.decisive.verdict,
          decayType: s.decisive.decayType, evidence: s.decisive.evidence,
          method, source: "mechanical", runId,
        });
        if (r.recorded) sum.verdictsRecorded++;
        return;
      }
      if (!s.anchorsMeasured) return;
      const live = getLiveVerdict(store, findingId);
      if (live === undefined || live.source !== "mechanical" || !MECHANICAL_WITHDRAWABLE.has(live.verdict)) return;
      const r = recordVerdict(store, {
        projectId: project.id, findingId, verdict: "olculemez",
        subReason: "anchor-evidence-cleared",
        evidence: `önceki hükmün çapa kanıtı bu ölçümde yok (${live.evidence ?? "kanıt kaydı yok"})`,
        method, source: "mechanical", runId,
      });
      if (r.recorded) sum.verdictsRecorded++;
    }

    // Yazım: skor SIFIRDAN (D-M3-3), geçiş active↔suspect (D-M3-9), her şey olaylı.
    store.tx(() => {
      for (const c of pendingContradictionEvents) ev("contradiction_confirmed", c);
      // Rotasyon imleci skorlarla AYNI tx'te: imleç ilerleyip skor yazılmazsa
      // (arada ölüm) pencere, sonucu hiç yazılmamış bir ölçümün üstünden atlardı.
      if (rotation !== null)
        writeClassifyStamps(store, project.id, rotation.stamps, rotation.stamp,
          { seen: rotation.seen, rewriteAll: rotation.renumbered });
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
        // Aynı koruma İKİ boyut için de geçerli. Çapa boyutu sonradan eklendi
        // (denetim: `budget-exhaustion-acquits-existing-suspect`): ölçülmeyen
        // çapa yolu, sınıflama yolunda çoktan kurulmuş olan bu korumanın dışında
        // kalmıştı ve tek başına aklama üretiyordu.
        const missing = [
          ...(unmeasuredFindings.has(f.id) ? ["çelişki"] : []),
          ...(unmeasuredAnchorFindings.has(f.id) ? ["çapa"] : []),
        ];
        if (missing.length > 0 && f.status === "suspect" && s.score < SUSPICION_THRESHOLD) {
          const held = Math.max(s.score, f.suspicion);
          setSuspicion(store, f.id, held);
          ev("signal_scored", {
            findingId: f.id, score: held, states: s.states, heldUnmeasured: true,
            unmeasuredDimensions: missing,
            reasons: [...s.reasons,
              `${missing.join(" + ")} boyutu ÖLÇÜLEMEDİ — önceki hüküm korundu (yeni skor: ${s.score})`],
          });
          sum.suspects++;
          sum.heldUnmeasured++;
          // DONDURMAK TEK BAŞINA BİR KARAR DEĞİL, kullanıcı adına verilmiş bir
          // karardır — ve ürünün sözleşmesi (§2.1) araç karar vermez, ÖNERİR.
          // Eskiden bu dal `continue` ile çıkıyordu, yani `persistVerdict` hiç
          // koşmuyordu ve donmuş not hiçbir yerde görünmüyordu: onay kuyruğu
          // `verdicts` tablosundan okunuyor, oraya satır yazılmıyordu. Ne sessiz
          // aklama ne sessiz dondurma; ikisi de kullanıcıyı devre dışı bırakıyor.
          //
          // Hacim kendiliğinden sınırlı: bu dal yalnız ZATEN suspect olan notlar
          // için işliyor, ve `recordVerdict` aynı sonucu ikinci kez yazmıyor
          // (`sameConclusion`) — tekrarlayan koşum yeni satır üretmez.
          //
          // `olculemez` MECHANICAL_WITHDRAWABLE'da DEĞİL: aksi hâlde bir sonraki
          // çapa turu bu kaydı, kullanıcı görmeden `anchor-evidence-cleared` ile
          // sessizce geri çekerdi.
          // Ama var olan bir hükmü EZMEZ. `recordVerdict` supersede ediyor, ve
          // canlı bir `curuk`un üstüne "ölçemedim" yazmak o hükmü ölçüm yapmadan
          // geri çekmek olurdu — MECHANICAL_WITHDRAWABLE'ın ve
          // `ölçmemek hüküm değildir` muhafızının yasakladığı şeyin ta kendisi.
          // Zaten hükmü olan not onay kuyruğunda GÖRÜNÜYOR; bu dalın çözdüğü
          // "kullanıcıya hiç ulaşmıyor" sorunu orada yok.
          const liveNow = getLiveVerdict(store, f.id);
          if (liveNow !== undefined && liveNow.verdict !== "olculemez") continue;
          const r = recordVerdict(store, {
            projectId: project.id, findingId: f.id, verdict: "olculemez",
            subReason: unmeasuredFindings.has(f.id)
              ? unmeasuredReasons.get(f.id) ?? "classify-undecided"
              : "anchor-unmeasured",
            evidence: `${missing.join(" + ")} boyutu bu koşumda ölçülemedi; ` +
              `önceki şüphe (${held}) düşürülmedi`,
            method: "unmeasured-dimension", source: "mechanical", runId,
          });
          if (r.recorded) sum.verdictsRecorded++;
          continue;
        }
        setSuspicion(store, f.id, s.score);
        ev("signal_scored", { findingId: f.id, score: s.score, reasons: s.reasons, states: s.states });
        persistVerdict(f.id, s);
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

      // Açlık kaydı skor döngüsünün DIŞINDA: aç bir not `active`/0 olabilir,
      // yani o döngünün hiçbir dalı ona uğramaz. Yine de ölçülemeyen bir şey var
      // ve kullanıcıya ulaşması gereken de bu.
      for (const id of starvedFindings) {
        // Hükmü olan nota dokunulmaz — ne ezilir (ölçüm yapılmadı) ne tekrar
        // yazılır (zaten kuyrukta).
        if (getLiveVerdict(store, id) !== undefined) continue;
        const r = recordVerdict(store, {
          projectId: project.id, findingId: id, verdict: "olculemez",
          subReason: "rotation-starved",
          evidence: "aday üç tam rotasyon turudur sınıflama bütçesine giremedi — " +
            "ölçülemeyen şey notun içeriği değil rotasyonun kendisi",
          method: "classify-rotation", source: "mechanical", runId,
        });
        if (r.recorded) { sum.verdictsRecorded++; sum.starvedFindings++; }
      }
    });

    // Bitiş kaydı YAZIMDAN SONRA: daha erken yazılırsa "tamamlandı" yarım bir
    // denetimi de kapsar ve `audit_started`/`audit_completed` çifti hiçbir şey
    // ayırt etmez olurdu.
    ev("audit_completed", {
      checked: sum.checked, suspects: sum.suspects, cleared: sum.cleared,
      candidates: sum.candidates, coverageCandidates: sum.coverageCandidates,
      contradictions: sum.contradictions,
      classifyCalls: sum.classifyCalls, measurementFailures: sum.measurementFailures,
      classifyUnclassified: sum.classifyUnclassified, heldUnmeasured: sum.heldUnmeasured,
      starvedFindings: sum.starvedFindings,
      budgetExhaustedAnchors: sum.budgetExhaustedAnchors,
      fetchFailed: sum.fetchFailed, verdictsRecorded: sum.verdictsRecorded,
      importErrors: sum.import?.errors ?? 0, importRejected: sum.import?.rejected ?? 0,
    });
    return sum;
  }
}
