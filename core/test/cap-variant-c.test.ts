// Çapa tavanı "varyant C" sözleşmesi (17 Ağu 2026).
//
// Bağlam: f161e14 sembol çapalarını GÖSTERİM-ONLY yaptı — artık skorlamıyorlar,
// çapa kayması onları `unverifiable/displayOnly` diye kısa devre yapıyor. Ama
// tavan hâlâ ölçülebilir çapalarla AYNI 16 slotu paylaştırıyordu: skorlamayan
// bir sembol, skorlayan bir yolu tavandan atabiliyordu.
//
// Varyant C: ölçülebilir türler (file_path / commit_sha / external_path) 16
// slot için SEMBOLSÜZ yarışır; semboller kendi 6'lık gösterim bütçesini alır ve
// ölçülebilirlerin ARTIRDIĞI boşluğu — eskiden olduğu gibi — devralır.
//
// Sözleşme 98 notluk gerçek korpusta ölçüldü: 0 çıkarma, 0 sıra değişimi,
// +38 ekleme. Bu dosya o "yalnızca EKLEME" özelliğini temsili notlarda
// dondurur: eski algoritmanın seçtiği her çapa hâlâ seçili ve aynı göreli
// sırada; üstüne yenileri gelir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAnchors, MAX_ANCHORS_PER_NOTE, PER_KIND_QUOTA } from "../src/importer/parse.ts";
import type { Anchor } from "../src/types.ts";

const sym = (n: number) => Array.from({ length: n }, (_, i) => `\`camelSym${i}\``).join(" ");
const file = (n: number) => Array.from({ length: n }, (_, i) => `src/mod${i}/file${i}.ts`).join(" ");
const ext = (n: number) => Array.from({ length: n }, (_, i) => `/tmp/dir${i}/ext${i}.ts`).join(" ");
const sha = (n: number) => Array.from({ length: n }, (_, i) => `abcdef${i}`).join(" ");

const FIXTURES: Record<string, string> = {
  symbolHeavy: `${sym(12)} ${file(2)}`,
  pathHeavy: file(20),
  crowdOut: `${sym(8)} ${file(20)}`,
  pathological: `${sym(20)} ${file(20)} ${sha(10)} ${ext(20)}`,
  fits: `${sym(2)} ${file(2)} ${ext(1)}`,
  exactly16: `${sym(9)} ${file(16)}`,
};

/**
 * Değişiklikten ÖNCE koşturulan algoritmanın çıktısı, elle donduruldu
 * (`kind:value`). Kaynağı bir yardımcı fonksiyon DEĞİL: yeni algoritmayla
 * hesaplanan bir beklenti, regresyonu kendi hatasıyla doğrular.
 */
const OLD: Record<string, string[]> = {
  symbolHeavy: [
    ...Array.from({ length: 12 }, (_, i) => `symbol:camelSym${i}`),
    "file_path:src/mod0/file0.ts", "file_path:src/mod1/file1.ts",
  ],
  pathHeavy: Array.from({ length: 16 }, (_, i) => `file_path:src/mod${i}/file${i}.ts`),
  crowdOut: [
    ...Array.from({ length: 8 }, (_, i) => `symbol:camelSym${i}`),
    ...Array.from({ length: 8 }, (_, i) => `file_path:src/mod${i}/file${i}.ts`),
  ],
  pathological: [
    ...Array.from({ length: 6 }, (_, i) => `symbol:camelSym${i}`),
    ...Array.from({ length: 6 }, (_, i) => `file_path:src/mod${i}/file${i}.ts`),
    ...Array.from({ length: 4 }, (_, i) => `commit_sha:abcdef${i}`),
  ],
  fits: [
    "symbol:camelSym0", "symbol:camelSym1",
    "file_path:src/mod0/file0.ts", "file_path:src/mod1/file1.ts",
    "external_path:/tmp/dir0/ext0.ts",
  ],
  exactly16: [
    ...Array.from({ length: 9 }, (_, i) => `symbol:camelSym${i}`),
    ...Array.from({ length: 7 }, (_, i) => `file_path:src/mod${i}/file${i}.ts`),
  ],
};

const key = (a: Anchor) => `${a.kind}:${a.value}`;

test("varyant C: eski seçimin ÜSTÜNE ekler — çıkarma yok, sıra değişimi yok", () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    const now = extractAnchors(text).anchors.map(key);
    const old = OLD[name]!;
    const missing = old.filter((k) => !now.includes(k));
    assert.deepEqual(missing, [], `${name}: eski çapa düştü`);
    // Göreli sıra: yeni listeden eski çapalar süzülünce eski liste birebir çıkmalı.
    assert.deepEqual(now.filter((k) => old.includes(k)), old, `${name}: sıra değişti`);
    assert.ok(now.length >= old.length, `${name}: liste kısaldı`);
  }
});

test("varyant C: ölçülebilir çapalar sembol yüzünden tavandan atılmaz", () => {
  // crowdOut: 8 sembol + 20 yol. Eskiden semboller paylaşılan 16'nın 8'ini
  // yiyordu ve yalnız 8 yol kalıyordu; şimdi semboller kendi bütçesinden
  // beslendiği için yol sayısı 8'den 14'e çıkıyor.
  const now = extractAnchors(FIXTURES.crowdOut!).anchors;
  assert.equal(now.filter((a) => a.kind === "file_path").length, 14);
  assert.equal(now.filter((a) => a.kind === "symbol").length, 8);
});

test("varyant C tavanı: patolojik not 16 ölçülebilir + 6 sembolü aşmaz", () => {
  const now = extractAnchors(FIXTURES.pathological!).anchors;
  const measurable = now.filter((a) => a.kind !== "symbol");
  const symbols = now.filter((a) => a.kind === "symbol");
  assert.equal(measurable.length, MAX_ANCHORS_PER_NOTE);
  assert.equal(symbols.length, PER_KIND_QUOTA);
  assert.equal(now.length, MAX_ANCHORS_PER_NOTE + PER_KIND_QUOTA);
  // Toplam tavan her fixture'da geçerli: sembol paylı bütçe 16'yı büyütemez.
  for (const [name, text] of Object.entries(FIXTURES)) {
    const a = extractAnchors(text).anchors;
    assert.ok(a.length <= MAX_ANCHORS_PER_NOTE + PER_KIND_QUOTA, `${name}: 22 tavanı aşıldı`);
    assert.ok(a.filter((x) => x.kind !== "symbol").length <= MAX_ANCHORS_PER_NOTE, `${name}: ölçülebilir 16'yı aştı`);
  }
});

test("varyant C: kırpma olayı yalnız GERÇEKTEN düşen çapa varken ateşlenir", () => {
  // Sığan not: dropped 0 — import_anchor_overflow yazılmamalı.
  assert.equal(extractAnchors(FIXTURES.fits!).dropped, 0);
  // symbolHeavy: 12 sembol + 2 yol = 14 ham çapa, ikisi de bütçeye sığıyor.
  assert.equal(extractAnchors(FIXTURES.symbolHeavy!).dropped, 0);

  // Bölünmüş bütçeyi yansıtan sayılar: pathological'da 70 ham çapa
  // (20 sembol + 20 yol + 10 sha + 20 dış yol), 22 tutuldu.
  const p = extractAnchors(FIXTURES.pathological!);
  assert.equal(p.anchors.length, 22);
  assert.equal(p.dropped, 70 - 22);

  // crowdOut: 28 ham (8 sembol + 20 yol), 22 tutuldu (14 yol + 8 sembol).
  const c = extractAnchors(FIXTURES.crowdOut!);
  assert.equal(c.anchors.length, 22);
  assert.equal(c.dropped, 28 - 22);
});
