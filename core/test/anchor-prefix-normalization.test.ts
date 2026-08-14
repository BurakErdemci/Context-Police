// Denetim (M4.1, 2. dalga): inconsistent-anchor-prefix-normalization.
//
// Aynı çapa değeri iki ÜRÜN YÜZEYİNDE farklı normalize ediliyordu —
// importer/parse.ts `extractAnchors` metinden çıkarırken, observer/prompt.ts
// `parseObserverOutput` model çıktısını okurken. Sonuç iki yönlü zarardı:
//   (a) aynı dosya için iki farklı çapa değeri (" src/a.ts" ≠ "src/a.ts"),
//       ki bu projenin ANA ölçüsünü — çapa kaymasını — yanlış ölçtürür;
//   (b) bayrak şekilli değerin reddi (bilinçli bir hüküm, parse.ts'te gerekçeli)
//       gözlemci yüzeyinde bir boşluk ya da unicode tire varyantıyla ATLANIYORDU.
//
// Kaynak probe: probes/anchor-prefix-normalization.sh (düzeltme öncesi rc=1,
// sonrası rc=0, 14 Ağu 2026). Aşağıdaki tablo o probe'un altı girdisinin
// tamamını sabitler — `[]` "çapa üretilmedi" demek.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAnchors } from "../src/importer/parse.ts";
import { parseObserverOutput } from "../src/observer/prompt.ts";
import { DASH_LIKE_PREFIX_RE, anchorValueError, normalizeAnchorValue } from "../src/anchor-value.ts";

/** Gözlemci yüzeyini tek bir çapa değeriyle koşturur. */
function observerAnchors(value: string): { values: string[]; batchRejected: boolean; dropped: number } {
  const raw = JSON.stringify({
    findings: [{ content: "probe", anchors: [{ kind: "file_path", value }], supersedes: null }],
  });
  const parsed = parseObserverOutput(raw);
  if (!parsed.ok) return { values: [], batchRejected: true, dropped: 0 };
  return {
    values: parsed.items[0]!.anchors.map((a) => a.value),
    batchRejected: false,
    dropped: parsed.droppedAnchors,
  };
}

// Probe'un tablosu birebir. Beklenen sütun TEK: iki yüzey aynı değeri üretir.
const TABLO: readonly { kind: string; value: string; expected: string[] }[] = [
  { kind: "ordinary", value: "src/a.ts", expected: ["src/a.ts"] },
  { kind: "ascii-hyphen", value: "-src/a.ts", expected: [] },
  { kind: "leading-space", value: " src/a.ts", expected: ["src/a.ts"] },
  { kind: "space-before-hyphen", value: " -src/a.ts", expected: [] },
  { kind: "unicode-em-dash", value: "—src/a.ts", expected: [] },
  { kind: "empty", value: "", expected: [] },
];

test("inconsistent-anchor-prefix-normalization: iki yüzey altı girdinin hepsinde AYNI değeri üretir", () => {
  for (const { kind, value, expected } of TABLO) {
    const importer = extractAnchors(value).anchors.map((a) => a.value);
    const observer = observerAnchors(value);
    assert.deepEqual(importer, expected, `${kind}: importer beklenmeyen çıktı`);
    assert.deepEqual(observer.values, expected, `${kind}: observer beklenmeyen çıktı`);
    assert.deepEqual(importer, observer.values, `${kind}: iki yüzey ayrıştı`);
  }
});

test("inconsistent-anchor-prefix-normalization: boş değer PARTİYİ değil yalnız çapayı düşürür", () => {
  // Kapsam hizalaması: importer boş değer üretemediği için "çapa yok" veriyor;
  // gözlemci ise tüm partiyi reddediyordu, yani aynı girdi iki yüzeyde farklı
  // KAPSAMDA cezalandırılıyordu. Parti reddinin bedeli ölçülmüş ve tek yönlü:
  // turn'ler "işlenemedi" diye checkpoint'lenir, bulgular kalıcı kaybolur.
  for (const value of ["", " ", "    "]) {
    const r = observerAnchors(value);
    assert.equal(r.batchRejected, false, `parti reddedildi: ${JSON.stringify(value)}`);
    assert.deepEqual(r.values, [], `boş çapa kabul edildi: ${JSON.stringify(value)}`);
    assert.equal(r.dropped, 1, "düşen çapa sayılmadı (sessiz yutma)");
  }
  // Bulgunun kendisi yaşamalı: çapasız not `unanchored` sınıfına düşer (M0-D5,
  // nötr) — kaybolmaz.
  const parsed = parseObserverOutput(
    JSON.stringify({ findings: [{ content: "bulgu yaşamalı", anchors: [{ kind: "file_path", value: "" }] }] }),
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.items[0]!.content, "bulgu yaşamalı");

  // SEKME ("\t") bu kapsama girmez ve girmemeli: U+0009 karakter filtresinin
  // yasak kümesinde ve o denetim normalize ÖNCESİ, ham değerde koşuyor.
  // Normalize sonrası denetlemek `trim()`'in kırptığı kontrol karakterlerini
  // (U+0009/000A/000D, U+2028/2029, U+FEFF) sessizce meşrulaştırırdı — istenen
  // hizalama bu değil, gevşetme yok. Kayıt: bu ayrım bilinçli.
  const sekme = parseObserverOutput(
    JSON.stringify({ findings: [{ content: "x", anchors: [{ kind: "file_path", value: "\t \t" }] }] }),
  );
  assert.equal(sekme.ok, false, "sekmeli değer parti reddinden çıktı (karakter filtresi gevşedi)");
  if (!sekme.ok) assert.match(sekme.error, /kontrol\/görünmez karakter/);
});

test("inconsistent-anchor-prefix-normalization: bayrak hükmü tire varyantlarını da kapsar, iki yüzeyde de", () => {
  // ASCII tirenin ötesi: U+2010 HYPHEN, U+2013 EN DASH, U+2014 EM DASH,
  // U+2212 MINUS SIGN, U+FF0D FULLWIDTH HYPHEN-MINUS. Hepsi ekranda tire.
  for (const dash of ["-", "‐", "–", "—", "−", "－"]) {
    const value = `${dash}src/a.ts`;
    assert.deepEqual(extractAnchors(value).anchors, [], `importer kabul etti: ${JSON.stringify(value)}`);
    assert.deepEqual(observerAnchors(value).values, [], `observer kabul etti: ${JSON.stringify(value)}`);
    // Baştaki boşluk hükümden kaçırmamalı (normalize ÖNCE, hüküm SONRA).
    assert.deepEqual(observerAnchors(`  ${value}`).values, [], `boşlukla kaçtı: ${JSON.stringify(value)}`);
  }
  // Hüküm yalnız BAŞ karakterde: iç tire ve tire içeren meşru yollar dokunulmaz
  // (parse.ts'teki mevcut hükmün kapsamı genişlemedi).
  assert.deepEqual(extractAnchors("src/my-mod/a-b.ts").anchors.map((a) => a.value), ["src/my-mod/a-b.ts"]);
  assert.deepEqual(observerAnchors("src/my-mod/a-b.ts").values, ["src/my-mod/a-b.ts"]);
});

test("inconsistent-anchor-prefix-normalization: hüküm importer'da metindeki TOKEN'a bakar", () => {
  // PATH_RE'nin karakter sınıfı ASCII tireyi içerdiği için "-x/y.ts" tireyle
  // başlayan bir eşleşme veriyor; unicode varyantı ise eşleşmenin DIŞINDA
  // kalıp hükmü atlatıyordu. Bir önceki karaktere bakmak o boşluğu kapatır.
  assert.deepEqual(extractAnchors("not: —core/src/scan.ts burada").anchors, []);
  // Yaygın yazım biçimi (tire + BOŞLUK + yol) etkilenmiyor — altın setteki
  // ölçüm bu yüzden değişmiyor (92 not / 129 yol eşleşmesi, 0 etkilenen).
  assert.deepEqual(
    extractAnchors("not: — core/src/scan.ts burada").anchors.map((a) => a.value),
    ["core/src/scan.ts"],
  );
});

test("inconsistent-anchor-prefix-normalization: ortak kapı tek kaynak", () => {
  // Sözleşme doğrudan: normalize yalnız SINIRDAKİ boşluğu kırpar, içi bozmaz.
  assert.equal(normalizeAnchorValue("  a b/c.ts \n"), "a b/c.ts");
  assert.equal(anchorValueError("src/a.ts"), null);
  assert.match(anchorValueError("")!, /boş/);
  assert.match(anchorValueError("-x")!, /bayrak/);
  // Küme ölçümü: desen tam olarak 30 kod noktasını kapsıyor (anchor-value.ts'te
  // listeli). Sayı sabitlenmezse küme sessizce genişleyip/daralıp iki yüzeyi
  // yeniden ayrıştırabilir.
  let n = 0;
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (DASH_LIKE_PREFIX_RE.test(String.fromCodePoint(c))) n++;
  }
  assert.equal(n, 30, "tire-benzeri kod noktası kümesi değişti");
  // U+00AD SOFT HYPHEN kapsam DIŞI: görünmez, ekranda tire değil ve
  // prompt.ts'in kabul listesinde adıyla geçiyor.
  assert.equal(DASH_LIKE_PREFIX_RE.test("­x"), false);
});
