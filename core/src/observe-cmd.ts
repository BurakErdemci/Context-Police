// observe komutunun karar mantığı — cli.ts'ten ayrı, çünkü koruma kapıları
// (sel, maliyet) testle sabitlenmek zorunda; süreç çıkışı test edilemez.

import type { Store } from "./store/db.ts";

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

/** Süzülmüş bayt sayısından tahmini Codex çağrısı: parti = batchTokens*4 bayt. */
export function estimateSessionCalls(filteredBytes: number, batchTokens: number): number {
  return Math.ceil(filteredBytes / (batchTokens * 4));
}

/** Varsayılan parti eşiği — Observer'ın kendi varsayılanıyla aynı (spec §3.3). */
export const DEFAULT_BATCH_TOKENS = 8000;

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
  if (!Number.isInteger(n) || n < 500) throw new Error("geçersiz --batch-tokens: en az 500 olmalı");
  return n;
}
