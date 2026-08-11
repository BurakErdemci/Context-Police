// Saf partileyici: I/O yok, depo yok. Gözlemci bağlamını sınırlı tutmanın
// mekanik yarısı (spec §2.2) — diğer yarısı prompt.ts'teki başlık listesi.

import type { Turn } from "../types.ts";

export interface Batch {
  turns: Turn[];
  /** Partideki uuid taşıyan SON turn — filigran bu değere ilerler. */
  lastUuid: string | null;
  /**
   * Partideki EN BÜYÜK timestamp. uuid'siz partide filigranın tek kimliği bu
   * (denetim: missing-checkpoint-identity) — uuid taşımayan parti checkpoint
   * yazamayınca sonsuz yeniden deneme oluyordu.
   */
  lastTs: string | null;
  estTokens: number;
}

/**
 * Filigran eşleşmesinin HANGİ kimlikle kurulduğu. `none` tekrar-teslimin
 * elenemediğini söyler: mükerrer bulgu riski oradadır ve çağıran bunu görünür
 * kılmak zorunda (sessiz "hepsi yeni" varsayımı order-sensitive-watermark
 * bulgusunun kendisiydi).
 */
export type WatermarkMatch = "no-watermark" | "uuid" | "timestamp" | "none";

export interface DropResult {
  fresh: Turn[];
  match: WatermarkMatch;
}

/** Kaba ama deterministik: bayt/4. Amaç bütçe, hassasiyet değil. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/**
 * Filigrana kadar olan turn'leri düşürür (D-M2-2), İKİ kimlikle.
 *
 * Eski hâl yalnız uuid'e ve KONUMA bakıyordu: uuid dizide yoksa "hepsi yeni"
 * denip her şey yeniden işleniyordu (denetim: order-sensitive-watermark).
 * Arıza probe'la üredi — daha kısa/eski bir teslimat filigranı geri sarıyor,
 * aynı turn'ler ikinci kez bulguya dönüşüyordu.
 *
 * Sıra: (1) uuid dizide bulunursa konumsal kesim — en kesin bilgi; (2) yoksa
 * zaman damgası kesimi: lastTs'ten KÜÇÜK VEYA EŞİT olan turn'ler düşer;
 * (3) ikisi de yoksa hepsi yeni sayılır ama `match: "none"` ile görünür kalır.
 *
 * Zaman damgaları sözlüksel karşılaştırılıyor: kaynak biçim ISO-8601 UTC
 * (`2026-08-11T10:23:45.123Z`) ve bu biçimde sözlüksel sıra = kronolojik sıra.
 * Karma biçim gelirse kesim yanlış olur — o yüzden biçim varsayımı burada yazılı.
 */
export function dropThroughWatermarkDetailed(
  turns: Turn[],
  lastUuid: string | null,
  lastTs: string | null = null,
): DropResult {
  if (lastUuid == null && lastTs == null) return { fresh: turns, match: "no-watermark" };

  if (lastUuid != null) {
    const i = turns.findIndex((t) => t.uuid === lastUuid);
    if (i !== -1) return { fresh: turns.slice(i + 1), match: "uuid" };
  }

  // Zaman damgası taşımayan turn eleme dışı: at-least-once'ta mükerrer bulgu
  // (geri alınabilir) kayıp bulgudan (geri alınamaz) ucuz.
  if (lastTs != null && turns.some((t) => t.timestamp != null)) {
    const ts = lastTs;
    return { fresh: turns.filter((t) => t.timestamp == null || t.timestamp > ts), match: "timestamp" };
  }

  return { fresh: turns, match: "none" };
}

/** İnce sarmalayıcı: yalnız turn listesi isteyen çağıranlar için (cli.ts inspect). */
export function dropThroughWatermark(
  turns: Turn[],
  lastUuid: string | null,
  lastTs: string | null = null,
): Turn[] {
  return dropThroughWatermarkDetailed(turns, lastUuid, lastTs).fresh;
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
    // SON değil EN BÜYÜK: transcript satır sırası zaman sırasıyla birebir
    // olmayabiliyor (paralel araç yanıtları), filigran ise geri gitmemeli.
    let lastTs: string | null = null;
    for (const t of current) if (t.timestamp != null && (lastTs === null || t.timestamp > lastTs)) lastTs = t.timestamp;
    batches.push({ turns: current, lastUuid, lastTs, estTokens: tokens });
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
