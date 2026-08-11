// observe komutunun karar mantığı — cli.ts'ten ayrı, çünkü koruma kapıları
// (sel, maliyet) testle sabitlenmek zorunda; süreç çıkışı test edilemez.

import type { Store } from "./store/db.ts";
import { getWatermark, setWatermark, type Watermark } from "./store/watermarks.ts";
import { readIncremental, type IncrementalResult } from "./adapters/claude-code.ts";
import type { DeliveryRange } from "./observer/batch.ts";

/**
 * Sel koruması (D-M2-4): hiç taranmamış depoda observe TÜM geçmişi Codex'e
 * akıtır (ölçüldü: ~500 çağrı). Bilinçli olmayan ilk koşum reddedilir.
 */
export function observeGuard(store: Store, allowBackfill: boolean): { ok: boolean; reason?: string } {
  if (allowBackfill) return { ok: true };
  const n = store.get<{ n: number }>("SELECT COUNT(*) n FROM cursors")?.n ?? 0;
  if (n === 0)
    return {
      ok: false,
      reason:
        "depoda hiç imleç yok: ilk koşum TÜM transcript geçmişini gözlemciye akıtır.\n" +
        "önce taban çizgisi için `context-police scan` koşun (gözlemcisiz, imleçleri ilerletir),\n" +
        "ya da bunun bilinçli bir geçmiş taraması olduğunu --yes ile söyleyin.",
    };
  return { ok: true };
}

/** Süzülmüş bayt sayısından tahmini PARTİ sayısı: parti = batchTokens*4 bayt. */
export function estimateSessionCalls(filteredBytes: number, batchTokens: number): number {
  return Math.ceil(filteredBytes / (batchTokens * 4));
}

/**
 * Bir partinin harcayabileceği EN FAZLA yürütücü çağrısı. Sayı uydurma değil,
 * observer.ts `callWithRecovery` yolundan sayıldı: (1) ilk çağrı; (2) yürütücü
 * hatası tekrarı; (3) geçerli çıkış ama bozuk JSON için düzeltme turu. En kötü
 * yol "1 yürütücü hatası + 1 bozuk JSON" = 3 çağrı, 0 bulgu.
 *
 * Neden gerekli (denetim: retry-blind-call-budget): eski tahmin yalnız PARTİ
 * sayıyordu. Sağlayıcı her isteği reddettiğinde "20 çağrı" diye onaysız kabul
 * edilen iş 40 gerçek çağrı yaptı — kullanıcının parası, onaysız.
 */
export const WORST_CASE_CALLS_PER_BATCH = 3;

/**
 * --yes verilmedikçe bir observe koşumunun yapabileceği en fazla yürütücü
 * çağrısı. Her çağrı kullanıcının parasını harcıyor ve projenin kurucu ilkesi
 * "onaysız hiçbir şey olmamalı" — bu maliyet için de geçerli.
 */
export const DEFAULT_CALL_BUDGET = 20;

/** Observer'a verilecek sert tavan: --yes yoksa bütçe, varsa sınırsız. */
export function callBudget(allowCost: boolean): number | undefined {
  return allowCost ? undefined : DEFAULT_CALL_BUDGET;
}

export interface CallEstimate {
  /** Kesilecek parti sayısı. */
  batches: number;
  /** Her parti ilk denemede tutarsa yapılacak çağrı. */
  expected: number;
  /** Her parti kurtarma turlarını sonuna kadar kullanırsa yapılacak çağrı. */
  worst: number;
}

export function estimateCalls(filteredBytes: number, batchTokens: number): CallEstimate {
  const batches = estimateSessionCalls(filteredBytes, batchTokens);
  return { batches, expected: batches, worst: batches * WORST_CASE_CALLS_PER_BATCH };
}

/**
 * Maliyet kapısı. Karar BEKLENEN değil EN KÖTÜ duruma göre verilir: kullanıcı
 * onayı, en kötü ihtimalle ne kadar harcanacağının onayıdır. Tahmin yine de
 * ekranda gösterilir ki kapı keyfî görünmesin.
 */
export function costGate(est: CallEstimate, allowCost: boolean): { ok: boolean; reason?: string } {
  if (allowCost) return { ok: true };
  if (est.worst <= DEFAULT_CALL_BUDGET) return { ok: true };
  return {
    ok: false,
    reason:
      `maliyet kapısı: ${est.batches} parti → beklenen ~${est.expected}, ` +
      `en kötü ${est.worst} Codex çağrısı (kurtarma turlarıyla; parti başına en fazla ` +
      `${WORST_CASE_CALLS_PER_BATCH}).\n` +
      `onaysız üst sınır ${DEFAULT_CALL_BUDGET} çağrı. Onaylıyorsanız --yes ekleyin, ` +
      `ya da --batch-tokens'ı büyüterek parti sayısını düşürün (D-M2-4).`,
  };
}

/**
 * Bütçe dolduğunda kullanıcıya söylenecek. Sessiz yarım iş olmaz: kaç çağrı
 * yapıldığı, işin bittiği DEĞİL yarıda kaldığı ve nasıl sürdürüleceği yazılı.
 */
export function budgetExhaustedMessage(calls: number, maxCalls: number | undefined): string {
  return (
    `⚠ maliyet bütçesi doldu: ${calls} Codex çağrısı yapıldı (sınır ${maxCalls ?? DEFAULT_CALL_BUDGET}).\n` +
    `İŞ YARIDA KALDI — kalan partiler işlenmedi ve filigran ilerletilmedi, ` +
    `yani hiçbir turn kaybolmadı; aynı komutu tekrar koşarsanız kaldığı yerden devam eder.\n` +
    `Sınırsız sürdürmek için --yes ekleyin (maliyeti kabul etmiş olursunuz).`
  );
}

// ── Denetim (audit) maliyet kapısı ─────────────────────────────────────────
// Bu dosya artık İKİ komutun maliyet kararlarını taşıyor. Gerekçe: `audit`in
// kapısı `observe`unkiyle aynı sözleşmeye uymak zorunda ("onaysız hiçbir şey
// olmamalı") ve iki ayrı kopya kaçınılmaz olarak ayrışıyor — ölçüldü (denetim
// 2026-08-11): observe'un kapısı üç turda sıkılaştırılırken audit'te hiç kapı
// yoktu, tek bir argümansız koşum 11-33 ücretli Codex çağrısı yapabiliyordu.

/**
 * Bir PROJENİN çelişki sınıflamasının harcayabileceği en fazla yürütücü çağrısı.
 * Sayı classify.ts'ten sayıldı, uydurma değil: (1) ilk çağrı, (2) yürütücü
 * hatası tekrarı, (3) geçerli çıkış ama bozuk JSON için düzeltme turu. Üçü
 * ARDIŞIK işleyebiliyor (audit.ts başlık yorumu, Görev 9 şerhinin düzeltmesi).
 */
export const WORST_CASE_CALLS_PER_AUDIT = 3;

/**
 * Denetim tahmini. Aday sayısı koşum ÖNCESİ bilinemez — adaylar import'tan
 * sonra doğuyor — ama üst sınır YAPISAL: proje başına en fazla TEK toplu
 * sınıflama partisi var (classify.ts tavanı aşan adayı ikinci partiye değil
 * `dropped`a yazıyor). Yani "kaç proje" tahmin için yeterli.
 *
 * Tahmin karamsar olmak zorunda: ölçüldü (2026-08-11), bu makinede 11 hafıza
 * dizininin 11'i de aday üretiyor (123 aday) — `frontmatter`ında `description`
 * olan ya da DURUM kalıbı taşıyan her not TEK BAŞINA aday doğurduğu için
 * "belki hiç aday çıkmaz" iyimserliği sahaya uymuyor.
 */
export function estimateAuditCalls(projects: number): CallEstimate {
  return { batches: projects, expected: projects, worst: projects * WORST_CASE_CALLS_PER_AUDIT };
}

/**
 * Denetimin ön kapısı. observe'unkiyle aynı ölçüt: karar BEKLENEN değil EN KÖTÜ
 * duruma göre verilir, çünkü onay "en kötü ihtimalle şu kadar harcanacak"ın
 * onayıdır. Tahmin yine de ekranda gösterilir ki kapı keyfî görünmesin.
 */
export function auditCostGate(
  projects: number,
  allowCost: boolean,
): { ok: boolean; est: CallEstimate; reason?: string } {
  const est = estimateAuditCalls(projects);
  if (allowCost || est.worst <= DEFAULT_CALL_BUDGET) return { ok: true, est };
  return {
    ok: false,
    est,
    reason:
      `maliyet kapısı: ${projects} proje → beklenen ~${est.expected}, en kötü ${est.worst} ` +
      `Codex çağrısı (proje başına en fazla ${WORST_CASE_CALLS_PER_AUDIT} koşum: ilk çağrı + ` +
      `yürütücü tekrarı + bozuk-JSON düzeltme turu).\n` +
      `onaysız üst sınır ${DEFAULT_CALL_BUDGET} çağrı. Onaylıyorsanız --yes ekleyin, ` +
      `ya da --project / --path ile tek projeye daraltın.`,
  };
}

/**
 * Koşum boyunca PAYLAŞILAN sert tavan. Tahminden ayrı bir katman, çünkü tahmin
 * yanılabilir (bir proje beklenenden çok kurtarma turu harcar) ama tavan
 * yanılmaz. Asıl koruma bu; tahmin yalnız kullanıcıya bilgi.
 */
export class SpendBudget {
  spent = 0;
  /** undefined = sınırsız (--yes verildi). */
  readonly limit: number | undefined;
  constructor(limit: number | undefined) {
    this.limit = limit;
  }

  /**
   * Sorulan şey "yerim var mı" değil "EN KÖTÜSÜ sığıyor mu": başlamış bir
   * sınıflama kurtarma turlarının ortasında kesilemiyor, dolayısıyla tavan
   * ancak işi başlatmadan önce sorulursa gerçekten tavan olur.
   */
  canAfford(worst: number): boolean {
    return this.limit === undefined || this.spent + worst <= this.limit;
  }

  spend(calls: number): void {
    this.spent += calls;
  }
}

/**
 * Bütçe koşumu yarıda kestiğinde söylenecek. observe'un mesajıyla aynı ilke:
 * yarım iş sessizce rc=0 dönmez — kaç çağrı yapıldığı, kaç projenin denetlendiği
 * ve nasıl sürdürüleceği yazılı.
 */
export function auditBudgetExhaustedMessage(
  spent: number, done: number, total: number, limit: number | undefined,
): string {
  return (
    `⚠ maliyet bütçesi doldu: ${spent} Codex çağrısı yapıldı (sınır ${limit ?? DEFAULT_CALL_BUDGET}).\n` +
    `İŞ YARIDA KALDI — ${done}/${total} proje denetlendi, kalanlara HİÇ bakılmadı ` +
    `(depoda o projelerin skorları eski koşumdan kalmadır, yeni ölçüm değildir).\n` +
    `Sürdürmek için --yes ekleyin (maliyeti kabul etmiş olursunuz) ya da --project ile tek tek koşun.`
  );
}

/**
 * scanOnce yolunda bütçe bitişini imleç ilerlemeden ÖNCE durdurmak için atılır.
 *
 * Gerekçe (bu kanca olmadan bütçe veri kaybettiriyor): scan.ts imleci onTurns
 * NORMAL döndükten sonra yazıyor; Observer ise bütçe bitince bilinçli olarak
 * istisna atmadan dönüyor. İkisi birleşince imleç, hiç gözlemlenmemiş turn'lerin
 * ötesine geçerdi — imleç gözlemcinin değil taramanın olduğu için o turn'ler bir
 * daha hiç okunmaz, yani kalıcı gözlem boşluğu. İstisna atmak scan.ts'in
 * en-az-bir-kez yoluna girer: imleç yazılmaz, turn'ler sonraki koşumda geri gelir.
 */
export class BudgetHalt extends Error {
  constructor() {
    super("maliyet bütçesi doldu: imleç bilerek ilerletilmedi, turn'ler sonraki koşumda yeniden gelecek");
    this.name = "BudgetHalt";
  }
}

/** onTurns kancasını bütçeye karşı sarar; bütçe bitmişse BudgetHalt atar. */
export function budgetGuardedOnTurns<C>(
  isExhausted: () => boolean,
  inner: (ctx: C) => void | Promise<void>,
): (ctx: C) => Promise<void> {
  return async (ctx: C) => {
    // Önce: önceki teslimde bütçe bitmişse bu oturumun imleci de ilerlememeli.
    if (isExhausted()) throw new BudgetHalt();
    await inner(ctx);
    // Sonra: bütçe TAM BU teslimde bittiyse partilerin bir kısmı işlenmedi.
    // İşlenenlerin filigranı yazılı, tekrar teslim onunla elenir.
    if (isExhausted()) throw new BudgetHalt();
  };
}

/** Varsayılan parti eşiği — Observer'ın kendi varsayılanıyla aynı (spec §3.3). */
export const DEFAULT_BATCH_TOKENS = 8000;

/**
 * Üst sınır. Gerekçe iki katmanlı:
 * (1) Anlam: gözlemci bağlamı bunun ÇOK altında çalışıyor (varsayılan 8000) ve
 *     tek bir partiye 200k token'lık transcript koymak §2.2'nin (sınırlı gözlemci
 *     bağlamı) doğrudan ihlali olurdu. Bu değeri aşan bir girdi yazım hatasıdır.
 * (2) Aritmetik (denetim: numeric-budget-overflow): eski doğrulama yalnız tam
 *     sayı ve alt sınır arıyordu, 1e308 geçiyordu; batchTokens*4 Infinity'ye
 *     taşıyor, Math.ceil(bayt/Infinity) = 0 oluyor ve maliyet ekranı da onay
 *     kapısı da gerçek çağrıyı SIFIR gösteriyordu. 200_000 ile en büyük çarpım
 *     800_000 — güvenli tamsayı aralığının çok içinde.
 */
export const MAX_BATCH_TOKENS = 200_000;

/**
 * --batch-tokens girdisi doğrulanır, çünkü küçük değer iki ayrı şekilde zarar
 * veriyor (Görev 4 ölçümü): (1) cutBatches maxTokens<16'da `maxTokens*4-64`
 * negatife düşüyor ve kırpma mantığı bozuluyor; (2) küçük parti = çok parti =
 * çok Codex çağrısı, yani maliyet patlaması. Alt sınır 500 ikisini de kapatır.
 * Verilmezse Observer varsayılanı geçerli.
 */
export function validateBatchTokens(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BATCH_TOKENS;
  const n = Number(raw);
  // Number.isSafeInteger, isInteger'ın kaçırdığını yakalar: 1e308 "tam sayı"dır
  // ama 2^53-1'in üstünde ve *4 çarpımı Infinity'ye taşar (numeric-budget-overflow).
  if (!Number.isSafeInteger(n) || n < 500 || n > MAX_BATCH_TOKENS)
    throw new Error(`geçersiz --batch-tokens: 500 ile ${MAX_BATCH_TOKENS} arasında bir tam sayı olmalı`);
  return n;
}

/** codex.ts CodexOptions.reasoningEffort ile aynı küme — tek kaynak orası. */
export const EFFORT_VALUES = ["minimal", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORT_VALUES)[number];
export const DEFAULT_EFFORT: Effort = "low";

/**
 * --effort ÇALIŞMA ZAMANINDA doğrulanmak zorunda; TypeScript union'ına cast
 * etmek hiçbir şey doğrulamaz (denetim: unvalidated-executor-option-data-loss).
 * Ölçülen zincir: yazım hatası → Codex her çağrıyı reddediyor → zehirli parti
 * yolu 2 denemeden sonra partiyi "işlenemedi" yazıp FİLİGRANI İLERLETİYOR → o
 * turn'ler bir daha hiç gözlemlenmiyor. Yani tek harf hatası kalıcı gözlem
 * boşluğu üretiyordu; kullanım hatasının bedeli veri olmamalı.
 */
export function validateEffort(raw: string | undefined): Effort {
  if (raw === undefined) return DEFAULT_EFFORT;
  if (!(EFFORT_VALUES as readonly string[]).includes(raw))
    throw new Error(`geçersiz --effort: ${EFFORT_VALUES.join(" | ")} olmalı`);
  return raw as Effort;
}

/**
 * --model'in ucuz kapısı, aynı sınıf. Değer doğrulanamaz (model listesi bizde
 * yok) ama iki hâli kesin hatadır: boş değer, ve tire ile başlayan değer —
 * `--model --yes` yazıldığında arg() "--yes" döndürüyor, o da Codex'e bayrak
 * gibi gidip her çağrıyı bozuyor. Bozuk çağrının bedeli yukarıdaki zincir.
 */
export function validateModel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim() === "") throw new Error("geçersiz --model: boş olamaz");
  if (raw.startsWith("-"))
    throw new Error(`geçersiz --model: tire ile başlayamaz (bayrakla karışıyor): ${raw}`);
  return raw;
}

/**
 * `--session` okuma kararı. cli.ts'ten ayrı, çünkü test edilebilir olmak zorunda:
 * eski hâli `readIncremental(path, from, null, null)` çağırıyordu ve iki null
 * yerinde-yazım tespitini (claude-code.ts `replacedInPlace`) kapatıyordu — aynı
 * boyutta yeniden yazılan bir dosya "hiç değişmemiş" görünüyor, saklanan ofset
 * BAŞKA baytları işlenmiş sayıyordu (M3 borç 2). Filigranın inode/mtime'ı
 * artık geçiriliyor; politika zaten adaptörde, eksik olan yalnız veriydi.
 */
export async function readSessionIncremental(
  store: Store,
  projectId: number,
  sessionId: string,
  sessionPath: string,
): Promise<{ wm: Watermark | null; res: IncrementalResult; range: DeliveryRange }> {
  const wm = getWatermark(store, projectId, sessionId);
  const from = wm?.byteOffset ?? 0;
  const res = await readIncremental(sessionPath, from, wm?.inode ?? null, wm?.mtimeMs ?? null);
  return {
    wm,
    res,
    range: { from: res.truncated ? 0 : from, to: res.byteOffset, truncated: res.truncated },
  };
}

/**
 * Okunan dosyanın kimliğini filigrana işler. Karar alanlarına (ofset, teslimat)
 * DOKUNMAZ: kısmi yazım kuralı gereği verilmeyen alan olduğu gibi kalır, yani
 * bu çağrı gözlemcinin ilerlemesini geri saramaz.
 */
export function recordSessionFreshness(
  store: Store,
  projectId: number,
  sessionId: string,
  res: { inode: string; mtimeMs: number },
): void {
  setWatermark(store, { projectId, sessionId, inode: res.inode, mtimeMs: res.mtimeMs });
}
