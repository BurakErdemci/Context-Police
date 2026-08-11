// ÇAPA KARAKTER FİLTRESİ — kök tasarım kararının kalıcı testi (11 Ağu 2026).
//
// Üç doğrulama turu boyunca filtre SALINDI: her düzeltme bir yönü kapatıp
// diğerini açtı (gerekçenin tamamı src/observer/prompt.ts'de). Kök çare filtreyi
// DARALTMAK oldu: çapa bir veri parçası, doğruluğu M3'ün sinyal motorunun işi.
// Burada yalnız "metni yeniden yönlendiren / terminali kandıran" dar küme reddedilir.
//
// Bu dosyanın işi salınımı durdurmak: İKİ YÖN de sabit. Bir yönü tek başına
// tutan test, ölçüldüğü gibi, öbür yöne kayan bir düzeltmeyi geçirir.

import test from "node:test";
import assert from "node:assert/strict";

import { parseObserverOutput } from "../src/observer/prompt.ts";

/**
 * Görünmez karakterler kod noktasıyla yazılıyor: kaynak dosyada literal
 * durmaları testin kendisini okunamaz ve düzenlenemez kılardı — ve hangi
 * karakterin sınandığı gözden kaybolurdu.
 */
const cp = (n: number) => String.fromCodePoint(n);

/** Tek çapalı, başka her açıdan geçerli bir model çıktısı. */
const anchorOutput = (value: string, kind = "file_path") =>
  JSON.stringify({ findings: [{ content: "ölçülmüş bulgu", anchors: [{ kind, value }], supersedes: null }] });

const parseAnchor = (value: string, kind?: string) => parseObserverOutput(anchorOutput(value, kind));

// --- YÖN 1: zararlı küme reddediliyor ---

test("[çapa-filtresi] zararlı karakter sınıfı çapa değerine giremez", () => {
  const zararli: readonly (readonly [string, number])[] = [
    ["C0 alt sınır (U+0000)", 0x0000],
    ["C0 (U+0001)", 0x0001],
    ["sekme (U+0009)", 0x0009],
    ["satır sonu (U+000A)", 0x000a],
    ["satır başı (U+000D)", 0x000d],
    ["C0 üst sınır (U+001F)", 0x001f],
    ["DEL (U+007F)", 0x007f],
    ["C1 alt sınır (U+0080)", 0x0080],
    ["C1 NEL (U+0085)", 0x0085],
    ["C1 üst sınır (U+009F)", 0x009f],
    ["satır ayırıcı (U+2028)", 0x2028],
    ["paragraf ayırıcı (U+2029)", 0x2029],
    ["ALM (U+061C)", 0x061c],
    ["LRM (U+200E)", 0x200e],
    ["RLM (U+200F)", 0x200f],
    ["bidi gömme LRE (U+202A)", 0x202a],
    ["bidi override RLO (U+202E)", 0x202e],
    ["bidi izolat LRI (U+2066)", 0x2066],
    ["bidi izolat PDI (U+2069)", 0x2069],
    ["yalnız kalan vekil (U+D800)", 0xd800],
  ];
  for (const [ad, n] of zararli) {
    // U+D800 tek başına String.fromCodePoint ile üretilebiliyor; JSON.stringify
    // onu \ud800 olarak kaçışlar, yani model çıktısından gelen yolun aynısı.
    const r = parseAnchor(`src/a${cp(n)}b.ts`);
    assert.equal(r.ok, false, `${ad} kabul edildi`);
    assert.match(r.ok === false ? r.error : "", /kontrol\/görünmez karakter/, ad);
  }
});

test("[çapa-filtresi] tek zararlı çapa PARTİYİ düşürür: sahte çapa depoya yazılamaz", () => {
  // U+202E ile "a.ts<RLO>gnp.exe" ekranda "a.tsexe.png" görünür. Görünenle
  // saklanan ayrışıyorsa çapa çapa değildir; M3/M5 o değeri tüketirdi.
  const r = parseObserverOutput(JSON.stringify({
    findings: [
      { content: "temiz bulgu", anchors: [{ kind: "file_path", value: "src/a.ts" }], supersedes: null },
      { content: "zehirli bulgu", anchors: [{ kind: "file_path", value: `src/a.ts${cp(0x202e)}gnp.exe` }], supersedes: null },
    ],
  }));
  assert.equal(r.ok, false, "zehirli çapa taşıyan parti kabul edildi");
});

// --- YÖN 2: meşru içerik kabul ediliyor ---

test("[çapa-filtresi] meşru Unicode içerik REDDEDİLMEZ: aşırı düzeltme veri kaybettirir", () => {
  // Bedeli ölçüldü ve tek yönlü: tek bir çapa yüzünden partinin TAMAMI
  // reddedilip turn'ler "işlenemedi" diye checkpoint'leniyor
  // (probes/emoji-anchor-rejected.sh) — yani doğrudan veri kaybı.
  //
  // Emoji dizileri okunabilirlik için literal; içlerindeki U+FE0F/U+200D
  // kasten oradadır ve yorumda kod noktalarıyla yazılı.
  const mesru: readonly (readonly [string, string])[] = [
    ["düz emoji", "docs/🚀.md"],
    ["VS16'lı emoji (U+2764 U+FE0F)", "docs/❤️.md"],
    ["VS16 + Türkçe", "docs/☕️-notları.md"],
    ["VS15 metin sunumu (U+2764 U+FE0E)", `docs/${cp(0x2764)}${cp(0xfe0e)}.md`],
    ["ZWJ'li emoji dizisi (U+1F3F3 FE0F 200D 1F308)", "symbols/🏳️‍🌈-durumu.md"],
    ["ten tonu + ZWJ", "docs/👩🏽‍💻-notu.md"],
    ["keycap dizisi (rakam + FE0F + 20E3)", "docs/1️⃣-adim.md"],
    ["emoji-tag dizisi (U+E0020-E007F)", "docs/🏴󠁧󠁢󠁥󠁮󠁧󠁿.md"],
    ["CJK ideografik varyasyon dizisi (U+845B U+E0100)", `日本語/${cp(0x845b)}${cp(0xe0100)}.ts`],
    ["CJK düz", "日本語/パス.ts"],
    ["Türkçe karakterli yol", "src/çekirdek/görüntü-İĞÜŞÖÇığüşöç.ts"],
    ["aksanlı Latin", "naïve café/über.ts"],
    ["boşluklu yol", "docs/uzun dosya adı.md"],
    ["her iki yol ayıracı", "a/b\\c"],
    ["yol gezinmesi (doğrulaması M3'ün işi)", "../repo-disi/not.md"],
    ["mutlak yol", "/Users/x/.claude/settings.json"],
  ];
  for (const [ad, value] of mesru) {
    const r = parseAnchor(value);
    assert.equal(r.ok, true, `meşru çapa reddedildi: ${ad} → ${r.ok ? "" : r.error}`);
  }
});

test("[çapa-filtresi] görünmez-ama-zararsız kod noktaları VERİ sayılır", () => {
  // Kasıtlı, ve tasarım kararının kendisi: bunlar metni yeniden yönlendirmez,
  // yalnız görünmezdir. "Görünmez"in elle üretilen her tanımı üç turda da
  // delindi ve aynı tanım meşru dosya adlarını yuttu. Görünmezlik bir
  // GÖRÜNTÜLEME sorunudur — dashboard (M5) çapayı gösterirken kaçışlayacak;
  // var olmayan bir çapa ise M3'te git'e karşı kendiliğinden düşer.
  //
  // Bu test bir "iyi davranış" değil, KARARIN kaydı: geri alınacaksa bilerek
  // alınsın, sessiz bir filtre genişletmesiyle değil.
  const veri: readonly (readonly [string, string])[] = [
    ["birleştirici grafem birleştirici (U+034F)", `src/a${cp(0x034f)}b.ts`],
    ["Hangul choseong doldurucu (U+115F)", `src/a${cp(0x115f)}b.ts`],
    ["Mongolian free variation selector (U+180B)", `src/a${cp(0x180b)}b.ts`],
    ["Hangul doldurucu (U+3164)", `src/a${cp(0x3164)}b.ts`],
    ["yumuşak tire (U+00AD)", `src/a${cp(0x00ad)}b.ts`],
    ["sıfır genişlikli boşluk (U+200B)", `src/a${cp(0x200b)}b.ts`],
    ["kelime birleştirici (U+2060)", `src/a${cp(0x2060)}b.ts`],
    ["eski biçim denetimi (U+206A)", `src/a${cp(0x206a)}b.ts`],
    ["Mongolian vowel separator (U+180E)", `src/a${cp(0x180e)}b.ts`],
    ["BOM/ZWNBSP (U+FEFF)", `src/a${cp(0xfeff)}b.ts`],
    ["harfler arası ZWJ (U+200D)", `src/a${cp(0x200d)}b.ts`],
    ["harften sonra VS16 (U+FE0F)", `src/a${cp(0xfe0f)}b.ts`],
    ["piktograf-ZWJ-piktograf", `symbols/${cp(0x1f600)}${cp(0x200d)}${cp(0x1f600)}`],
  ];
  for (const [ad, value] of veri) {
    const r = parseAnchor(value, "symbol");
    assert.equal(r.ok, true, `veri sayılması gereken çapa reddedildi: ${ad}`);
  }
});

// --- değişmeyen sınırlar (gerileme koruması) ---

test("[çapa-filtresi] uzunluk ve boşluk denetimi daraltmadan ETKİLENMEDİ", () => {
  assert.equal(parseAnchor("a".repeat(512)).ok, true, "512 sınırdadır, kabul edilmeliydi");
  assert.equal(parseAnchor("a".repeat(513)).ok, false, "512 üstü çapa kabul edildi");
  assert.equal(parseAnchor("").ok, false, "boş çapa kabul edildi");
  assert.equal(parseAnchor("   ").ok, false, "yalnız boşluktan oluşan çapa kabul edildi");
});
