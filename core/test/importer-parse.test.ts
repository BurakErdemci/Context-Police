import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, extractAnchors, noteTimestamp, MAX_ANCHORS_PER_NOTE } from "../src/importer/parse.ts";

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

test("noteTimestamp: frontmatter modified > created > geri düşüş, geçerli tarih ISO'ya normalize edilir", () => {
  assert.equal(noteTimestamp({ modified: "2026-08-01T10:00:00.000Z" }, "2026-08-11T00:00:00Z"), "2026-08-01T10:00:00.000Z");
  assert.equal(noteTimestamp({}, "2026-08-11T00:00:00Z"), "2026-08-11T00:00:00Z");
  assert.equal(noteTimestamp({ modified: "bozuk-tarih" }, "F"), "F"); // ayrıştırılamayan → geri düşüş
  // ISO olmayan ama ayrıştırılabilir giriş. Saat dilimi GMT olarak yazıldı: dilimsiz
  // yazılsaydı beklenen değer testi koşturan makinenin diliminden değişirdi.
  assert.equal(noteTimestamp({ created: "11 Aug 2026 00:00:00 GMT" }, "F"), "2026-08-11T00:00:00.000Z");
  assert.equal(noteTimestamp({ modified: "2026-08-01T10:00:00Z" }, "F"), "2026-08-01T10:00:00.000Z");
});
