// Kapsama rotasyonu: TETİKLEYİCİSİ OLMAYAN notu da sıraya sokan yüzey.
//
// Ölçülen kusur (altın set, 28 not): kapsama tetikleyiciye bağlıydı ve tetikleyici
// çapa hareketiydi — 14 notun hiç `file_path` çapası yok, 2'si de yolunu
// kaybediyor, yani 28'in yalnız 12'si bir hareket sinyali üretebiliyor. Çapasız
// nota ulaşan tek yol çelişki adaylığıydı: bir başka notla çakışmıyorsa hiç
// bakılmıyordu. Sessizce çürüyen not tam olarak budur — ürünün var oluş sebebi
// olan arıza, ürünün içinde.
//
// Çözüm bir sinyal DEĞİL bir SIRA: her nota sonlu bir "en son ne zaman
// bakıldı" üst sınırı. Aday çıktısı sınıflama bütçesine giriyor ve rotasyon
// damgasını (store/classify_stamps) aynı mekanizmadan alıyor — ikinci bir
// rotasyon kurmak, kapatılan beş açlık biçiminin altıncısını yeni bir yerde
// açmak olurdu.

import type { Candidate, NoteView } from "./contradiction.ts";

/**
 * Çapa etiketinin gerekçeye giren sınırı. Çapa değeri sınırsız olabiliyor
 * (ölçüldü: 200.007 karakterlik tek bir yol çapası) ve gerekçe hem prompt'a hem
 * olay detayına akıyor; contradiction.ts'teki MAX_LABEL_CHARS ile aynı sebep.
 */
const MAX_REASON_ANCHORS = 3;
const MAX_ANCHOR_CHARS = 80;

/**
 * Bu koşumda BAŞKA hiçbir adaya girmemiş notlar için birer kapsama adayı.
 *
 * Ölçüt "çapası yok" DEĞİL "adayı yok": çapası olup hiç kımıldamayan ve
 * kimseyle çelişmeyen not da aynı sessizlikte. Zaten bir adaya girmiş not
 * kuyruğa ikinci kez konmuyor — var olan rotasyon onu zaten taşıyor.
 *
 * Sıra bulgu id'sine göre: seçim sırasını damga belirliyor (classify.ts), ama
 * üretim sırasının deterministik olması eşitlik durumunda tekrarlanabilirliği
 * taşıyor.
 */
export function findCoverageCandidates(notes: NoteView[], candidates: Candidate[]): Candidate[] {
  const covered = new Set<number>();
  for (const c of candidates) {
    covered.add(c.aId);
    if (c.bId !== null) covered.add(c.bId);
  }
  return notes
    .filter((n) => !covered.has(n.findingId))
    .sort((a, b) => a.findingId - b.findingId)
    .map((n) => ({ kind: "coverage" as const, aId: n.findingId, bId: null, reason: reasonFor(n) }));
}

function reasonFor(n: NoteView): string {
  if (n.anchors.length === 0) return "çapasız not — ölçüm yalnız metnin kendi iddialarından";
  const shown = n.anchors.slice(0, MAX_REASON_ANCHORS)
    .map((a) => (a.value.length > MAX_ANCHOR_CHARS ? a.value.slice(0, MAX_ANCHOR_CHARS) + "…" : a.value));
  const rest = n.anchors.length - shown.length;
  return `çapalar: ${shown.join(", ")}${rest > 0 ? ` (+${rest})` : ""}`;
}
