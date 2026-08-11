// DURUM-kalıbı dedektörü — en güçlü ucuz sinyal (M0-D1: çürüyen 17 notun 9'u bu
// sınıf). Kalıplar M0 raporunun ÖLÇTÜĞÜ listeden; listeye kalıp EKLENMEZ,
// genişletme ancak yeni bir ölçümle olur. Sebep: buradaki her kalıp bir şüphe
// skoru üretiyor; ölçülmemiş bir kalıp ölçülmemiş bir yanlış-pozitif oranı demek.
// Türkçe: prototipin tüm notları Türkçe (D-M2-7 ile aynı gerekçe).
//
// Saf modül: I/O yok, durum yok. Aynı metin her zaman aynı sonucu verir.

/**
 * Türkçe-duyarlı kelime sınırı. `\b` KULLANILAMAZ: JS'de `\w` yalnız
 * `[A-Za-z0-9_]`, yani 'ş' bir kelime karakteri değil. Ölçüldü — `/\bşu an\b/i`
 * "şu an refactor ortasındayız" metnini yakalamıyor, çünkü dize başındaki
 * konumda 'ş' kelime karakteri sayılmadığı için sınır oluşmuyor. Lookaround +
 * `\p{L}` (u bayrağı) tüm Türkçe harfleri kapsıyor.
 */
const B_BEFORE = "(?<![\\p{L}\\p{N}])";
const B_AFTER = "(?![\\p{L}\\p{N}])";

const STATUS_PATTERNS: readonly RegExp[] = [
  /^DURUM\s*:/im,
  new RegExp(`${B_BEFORE}şu an${B_AFTER}`, "iu"),
  new RegExp(`${B_BEFORE}henüz${B_AFTER}`, "iu"),
  /sıradaki iş/i,
  /commit edilmedi/i,
  /push(?:lanmadı|lanmamış| edilmedi)/i,
];

export function hasStatusPattern(text: string): boolean {
  return STATUS_PATTERNS.some((re) => re.test(text));
}

/** Hangi kalıpların tetiklediği — olay detayına yazılır, skor değil kanıt taşır. */
export function matchedStatusPatterns(text: string): string[] {
  return STATUS_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}
