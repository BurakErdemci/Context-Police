// Çapa değerinin ORTAK normalize + hüküm kapısı.
//
// KATMAN GEREKÇESİ (prompt-fence.ts ile aynı sınıf): çapa değeri iki ÜRÜN
// YÜZEYİNDE doğuyor — importer/parse.ts not metninden çıkarıyor,
// observer/prompt.ts model çıktısından okuyor. İki katmanın ortak ihtiyacı iki
// katmandan da bağımsız bir modülde durmalı; aksi hâlde biri diğerinden sessizce
// ayrışır. Ayrışmıştı da (denetim: inconsistent-anchor-prefix-normalization,
// 14 Ağu 2026) — ölçülen tablo:
//
//   girdi          | extractAnchors  | parseObserverOutput | sonuç
//   " src/a.ts"    | ["src/a.ts"]    | [" src/a.ts"]       | FARKLI değer
//   " -src/a.ts"   | []              | [" -src/a.ts"]      | bayrak hükmü ATLANIYOR
//   "—src/a.ts"    | ["src/a.ts"]    | ["—src/a.ts"]       | FARKLI değer
//
// Aynı dosya için iki farklı çapa değeri üretmek bu projenin ANA ölçüsünü
// (çapa kayması) yanlış ölçtürür: iki değerden biri git'te bulunamaz ve
// `missing_now` sinyali sahte ateşlenir.
//
// Sözleşme, bu sırayla: (1) normalize — baştaki/sondaki boşluk kırpılır;
// (2) hüküm — bayrak şekilli önek reddedilir. Hüküm normalize SONRASI çalışır,
// çünkü " -src/a.ts" bir boşluk yüzünden hükümden kaçamamalı.

/**
 * Baştaki bayrak-şekilli önek deseni. Kapsam: Unicode `Pd` (Dash_Punctuation)
 * kategorisi + görsel olarak tire yerine geçen üç `Pd` dışı kod noktası
 * (U+2212 MINUS SIGN, U+02D7 MODIFIER LETTER MINUS SIGN, U+2796 HEAVY MINUS
 * SIGN). Ölçüldü (Node 24, tüm kod noktası uzayı tarandı): desen TAM olarak
 * şu 30 kod noktasını kapsıyor —
 *
 *   U+002D U+02D7 U+058A U+05BE U+1400 U+1806 U+2010 U+2011 U+2012 U+2013
 *   U+2014 U+2015 U+2212 U+2796 U+2E17 U+2E1A U+2E3A U+2E3B U+2E40 U+2E5D
 *   U+301C U+3030 U+30A0 U+FE31 U+FE32 U+FE58 U+FE63 U+FF0D U+10D6E U+10EAD
 *
 * Neden ASCII tirenin ötesi: argv'de yalnız U+002D bayrak açar, ama bir çapa
 * değeri tek tüketicili değil — depoya girip metin olarak karşılaştırılıyor ve
 * gösteriliyor. Unicode varyant, ASCII tireyle GÖRSEL olarak aynı olduğu için
 * bir yüzeyde reddedilip diğerinde kabul edilmesi tam da yukarıdaki ayrışmayı
 * üretiyordu. Tek hüküm, tek küme.
 *
 * KAPSAM DIŞI — U+00AD SOFT HYPHEN (Cf): görünmez, ekranda tire DEĞİL, ve
 * observer/prompt.ts'in kasten dar tutulmuş "kabul edilenler" listesinde adıyla
 * geçiyor. Görünmezlik bir gösterim meselesi (M5 dashboard kaçışlayacak), veri
 * sınırı meselesi değil.
 */
export const DASH_LIKE_PREFIX_RE = /^[\p{Pd}−˗➖]/u;

/**
 * Normalize adımı: yalnız baştaki/sondaki boşluk. Değerin İÇİ dokunulmaz —
 * "normalize" burada kırpma değil, sınır temizliğidir. Baştaki tireleri kırpmak
 * bilinçli olarak YAPILMIYOR (importer/parse.ts'teki uzun gerekçe): var olmayan
 * bir yol uydurur ve şansa gerçek bir dosyaya denk gelirse sahte kayma sinyali
 * üretir. Bayrak şekilli değerin hükmü kırpma değil RED.
 */
export function normalizeAnchorValue(raw: string): string {
  return raw.trim();
}

/**
 * Normalize edilmiş değerin ortak hükmü; dönen null "geçti", dize ise sebep.
 * Türe özgü denetimler (hex sha, glob, `..`, mutlak yol) çağıranda kalır —
 * burada yalnız HER türde aynı olan iki hüküm var.
 */
export function anchorValueError(value: string): string | null {
  if (value.length === 0) return "boş (ya da yalnız boşluk)";
  if (DASH_LIKE_PREFIX_RE.test(value)) return "tire ile başlıyor (bayrak şekilli)";
  return null;
}
