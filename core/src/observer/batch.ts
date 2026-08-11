// Saf partileyici: I/O yok, depo yok. Gözlemci bağlamını sınırlı tutmanın
// mekanik yarısı (spec §2.2) — diğer yarısı prompt.ts'teki başlık listesi.

import type { Turn } from "../types.ts";

export interface Batch {
  turns: Turn[];
  /** Partideki uuid taşıyan SON turn — filigran bu değere ilerler. */
  lastUuid: string | null;
  estTokens: number;
}

/** Kaba ama deterministik: bayt/4. Amaç bütçe, hassasiyet değil. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/**
 * Filigrana kadar olan turn'leri düşürür (D-M2-2). Filigran uuid'i akışta
 * bulunamazsa hiçbir şey düşürülmez: normal durumda imleç zaten filigranla
 * hizalıdır ve gelen her turn yenidir; bulamamak tekrar-teslim DEĞİL demektir.
 */
export function dropThroughWatermark(turns: Turn[], lastUuid: string | null): Turn[] {
  if (lastUuid == null) return turns;
  const i = turns.findIndex((t) => t.uuid === lastUuid);
  return i === -1 ? turns : turns.slice(i + 1);
}

/**
 * Turn'leri sırayı bozmadan ~maxTokens'lık partilere böler. Tek başına eşiği
 * aşan turn kendi partisi olur ve metni kısaltılır — 50k token'lık tek bir
 * yapıştırma gözlemci bağlamını patlatmamalı; kısaltma görünür iz bırakır.
 */
export function cutBatches(turns: Turn[], maxTokens: number): Batch[] {
  const batches: Batch[] = [];
  let current: Turn[] = [];
  let tokens = 0;

  const close = () => {
    if (current.length === 0) return;
    const lastUuid = [...current].reverse().find((t) => t.uuid != null)?.uuid ?? null;
    batches.push({ turns: current, lastUuid, estTokens: tokens });
    current = [];
    tokens = 0;
  };

  for (const turn of turns) {
    let t = turn;
    let cost = estimateTokens(t.text);
    if (cost > maxTokens) {
      const originalBytes = Buffer.byteLength(t.text, "utf8");
      // Bayt sınırında kes; çok baytlı karakter ortadan bölünürse toFixed
      // etmeye değmez — Buffer.toString geçersiz kuyruğu atar.
      const clipped = Buffer.from(t.text, "utf8").subarray(0, maxTokens * 4 - 64).toString("utf8");
      t = { ...t, text: `${clipped}\n[kısaltıldı: ${originalBytes} bayt]` };
      cost = estimateTokens(t.text);
      close();               // dev turn kendi partisine
      current = [t];
      tokens = cost;
      close();
      continue;
    }
    current.push(t);
    tokens += cost;
    if (tokens >= maxTokens) close();
  }
  close(); // eşik altı kuyruk da gönderilir (D-M2-1)
  return batches;
}
