import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNote, extractAnchors, noteTimestamp, MAX_ANCHORS_PER_NOTE, PER_KIND_QUOTA,
} from "../src/importer/parse.ts";

test("parseNote: frontmatter düz alanları okur, gövdeyi ayırır; frontmatter'sız dosya tamamen gövde", () => {
  const raw = `---\nname: test-notu\ndescription: "kısa özet"\nmetadata:\n  type: project\n---\n\ngövde metni`;
  const p = parseNote(raw);
  assert.equal(p.frontmatter.name, "test-notu");
  assert.equal(p.frontmatter.description, "kısa özet");
  assert.equal(p.frontmatter.metadata, undefined); // iç içe alan bilerek atlanır
  assert.match(p.body, /^\s*gövde metni$/);
  assert.equal(parseNote("düz metin").body, "düz metin");
});

test("extractAnchors: sha / göreli yol / dış yol / backtick sembol ayrımı, mükerrersiz", () => {
  const text =
    "Düzeltme `fdfd4fe` commit'inde. `core/src/scan.ts` içindeki `scanOnce` fonksiyonu; " +
    "ayar ~/.gemini/settings.json dosyasında. Tekrar: core/src/scan.ts ve `scanOnce`.";
  const { anchors, dropped } = extractAnchors(text);
  const byKind = (k: string) => anchors.filter((a) => a.kind === k).map((a) => a.value);
  assert.deepEqual(byKind("commit_sha"), ["fdfd4fe"]);
  assert.deepEqual(byKind("file_path"), ["core/src/scan.ts"]);
  assert.deepEqual(byKind("external_path"), ["~/.gemini/settings.json"]);
  assert.deepEqual(byKind("symbol"), ["scanOnce"]);
  assert.equal(dropped, 0);
});

test("extractAnchors: uuid parçaları sha sanılmaz, düz metindeki gerçek sha çıkar", () => {
  // Gerçek hafıza notu biçimi (Görev 4 ölçümü): frontmatter'daki oturum kimliği
  // 6 notun 6'sında sahte sha üretiyordu ve çapasız notu `unanchored` olmaktan
  // çıkarıp M0-D5 nötrlüğünü siliyordu.
  const not = "---\noriginSessionId: dfbcaaaf-3368-467c-a28b-15fce5e3e148\n---\n\ncommit kuralı: push yalnız istekle.";
  assert.deepEqual(extractAnchors(not).anchors, []);

  const duz = extractAnchors("Düzeltme fdfd4fe commit'inde; `de78903` de aynı sınıf.");
  assert.deepEqual(duz.anchors.filter((a) => a.kind === "commit_sha").map((a) => a.value), ["fdfd4fe", "de78903"]);
});

test("extractAnchors: tavan aşımı sessiz kırpılmaz, dropped sayılır", () => {
  const text = Array.from({ length: 30 }, (_, i) => `dosya src/mod${i}/dosya${i}.ts burada`).join(" ");
  const { anchors, dropped } = extractAnchors(text);
  assert.equal(anchors.length, MAX_ANCHORS_PER_NOTE);
  assert.equal(dropped, 30 - MAX_ANCHORS_PER_NOTE);
});

test("extractAnchors: tavan M0-D4 önceliğine uyar — yol seli içinde sembol hayatta kalır", () => {
  const paths = Array.from({ length: 30 }, (_, i) => `src/mod${i}/dosya${i}.ts`).join(" ");
  const { anchors, dropped } = extractAnchors(`${paths} ve \`scanOnce\` fonksiyonu`);
  assert.equal(anchors.length, MAX_ANCHORS_PER_NOTE);
  assert.equal(dropped, 31 - MAX_ANCHORS_PER_NOTE);
  assert.deepEqual(anchors.filter((a) => a.kind === "symbol").map((a) => a.value), ["scanOnce"]);
  // Aynı tür içinde metin sırası korunur: ilk yollar kalır, kuyruktakiler düşer.
  assert.equal(anchors[1]!.value, "src/mod0/dosya0.ts");
  assert.equal(anchors.at(-1)!.value, `src/mod${MAX_ANCHORS_PER_NOTE - 2}/dosya${MAX_ANCHORS_PER_NOTE - 2}.ts`);
});

// M3 altın set ölçümü §5.1: 260 çapanın %81'i sembol, 28 notun 18'inde SIFIR
// file_path çapası kaldı — sembol seli tavanı doldurduğu için. Sonuç: `missing_now`
// ve `churned` sinyalleri (ikisi de yalnız file_path yüzeyinde çalışır) altın
// sette HİÇ ateşlenmedi. Tür başına kota tam olarak bunu kırar.
test("extractAnchors: sembol seli file_path'i tavandan atamaz (tür kotası)", () => {
  const semboller = Array.from({ length: 30 }, (_, i) => `\`sembolAdi${i}\``).join(" ");
  const yollar = "src/a/bir.ts src/b/iki.ts src/c/uc.ts";
  const { anchors, dropped } = extractAnchors(`${semboller} ${yollar}`);
  assert.equal(anchors.length, MAX_ANCHORS_PER_NOTE);
  const byKind = (k: string) => anchors.filter((a) => a.kind === k).map((a) => a.value);
  // Eski davranışta bu liste BOŞ dönüyordu (16'nın 16'sı sembol).
  assert.deepEqual(byKind("file_path"), ["src/a/bir.ts", "src/b/iki.ts", "src/c/uc.ts"]);
  assert.equal(byKind("symbol").length, MAX_ANCHORS_PER_NOTE - 3);
  assert.equal(dropped, 33 - MAX_ANCHORS_PER_NOTE);
});

test("extractAnchors: kota tavanı KÜÇÜLTMEZ — az türlü notta 16 dolu kullanılır", () => {
  // Kotanın bedeli olmamalı: tek türlü bir not eskiden de 16 çapa veriyordu,
  // şimdi de vermeli (önce kota kadar, sonra artıklar öncelikle doldurur).
  const text = Array.from({ length: 30 }, (_, i) => `\`tekTurSembol${i}\``).join(" ");
  const { anchors } = extractAnchors(text);
  assert.equal(anchors.length, MAX_ANCHORS_PER_NOTE);
  assert.ok(MAX_ANCHORS_PER_NOTE > PER_KIND_QUOTA, "kota tek başına tavanı doldurmamalı");
});

test("extractAnchors: dört tür de kotasından pay alır, öncelik sırası korunur", () => {
  const text =
    Array.from({ length: 10 }, (_, i) => `\`sembol${i}\``).join(" ") + " " +
    Array.from({ length: 10 }, (_, i) => `src/m${i}/d${i}.ts`).join(" ") + " " +
    Array.from({ length: 10 }, (_, i) => `abcdef${i}0`).join(" ") + " " +
    Array.from({ length: 10 }, (_, i) => `~/dis${i}/y${i}.json`).join(" ");
  const { anchors } = extractAnchors(text);
  const count = (k: string) => anchors.filter((a) => a.kind === k).length;
  assert.equal(anchors.length, MAX_ANCHORS_PER_NOTE);
  // Her tür kotası kadar alır: 6+6+6+6 = 24 > 16, o yüzden öncelik sırası kotayı
  // baştan doldurur ve son türe yer kalmayabilir — ama ilk ikisi tam kotalı.
  assert.equal(count("symbol"), PER_KIND_QUOTA);
  assert.equal(count("file_path"), PER_KIND_QUOTA);
  assert.equal(count("commit_sha"), MAX_ANCHORS_PER_NOTE - 2 * PER_KIND_QUOTA);
  assert.equal(count("external_path"), 0);
  // Çıktı sırası öncelik sırasına göre kararlı kalır.
  assert.equal(anchors[0]!.kind, "symbol");
  assert.equal(anchors.at(-1)!.kind, "commit_sha");
});

test("noteTimestamp: frontmatter modified > created > geri düşüş, geçerli tarih ISO'ya normalize edilir", () => {
  assert.equal(noteTimestamp({ modified: "2026-08-01T10:00:00.000Z" }, "2026-08-11T00:00:00Z"), "2026-08-01T10:00:00.000Z");
  assert.equal(noteTimestamp({}, "2026-08-11T00:00:00Z"), "2026-08-11T00:00:00Z");
  assert.equal(noteTimestamp({ modified: "bozuk-tarih" }, "F"), "F"); // ayrıştırılamayan → geri düşüş
  // ISO olmayan ama ayrıştırılabilir giriş. Saat dilimi GMT olarak yazıldı: dilimsiz
  // yazılsaydı beklenen değer testi koşturan makinenin diliminden değişirdi.
  assert.equal(noteTimestamp({ created: "11 Aug 2026 00:00:00 GMT" }, "F"), "2026-08-11T00:00:00.000Z");
  assert.equal(noteTimestamp({ modified: "2026-08-01T10:00:00Z" }, "F"), "2026-08-01T10:00:00.000Z");
});

// Denetim: imported-flag-anchor. `--output/tmp/audit.txt` gibi bir token yol
// şeklinde olduğu için çapa olarak saklanıyordu. Bugün sömürülebilir DEĞİL —
// çapayı tüketen git çağrılarının hepsi ya `--` ayracı kullanıyor ya değeri
// `<ref>:` ile birleştiriyor — ama koruma değerde değil çağrı yerinde olduğu
// için `--`'sız yeni bir tüketici eklendiği an bayrağa dönüşür.
test("extractAnchors: tire ile başlayan yol çapası üretilmez", () => {
  const { anchors } = extractAnchors("not metni: --output/tmp/audit.txt ve -x/y.ts burada");
  assert.deepEqual(anchors, [], `bayrak şekilli çapa çıktı: ${JSON.stringify(anchors)}`);
});

test("extractAnchors: meşru yollar tire kuralından etkilenmez", () => {
  // Tire yasağı yalnız BAŞ karakterde: iç tire (`my-mod`) ve `~/`/`/` önekli
  // yollar argv'de bayrak konumuna düşemez, dokunulmaz.
  const { anchors } = extractAnchors(
    "core/src/scan.ts, docs/x.md, src/my-mod/a-b.ts, ~/.gemini/settings.json, /tmp/-tuhaf/ad.txt",
  );
  assert.deepEqual(anchors.map((a) => a.value), [
    "core/src/scan.ts", "docs/x.md", "src/my-mod/a-b.ts", "~/.gemini/settings.json", "/tmp/-tuhaf/ad.txt",
  ]);
});
