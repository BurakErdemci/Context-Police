import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNote, extractAnchors, noteTimestamp, capNoteContent,
  MAX_ANCHORS_PER_NOTE, PER_KIND_QUOTA, MAX_NOTE_CHARS,
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
    // camelCase şart: M4.6'dan beri tek-kelime küçük harfli bir sembol seçici
    // sayılmıyor ve çapa üretmiyor (m4-6-anchor-quality.test.ts).
    Array.from({ length: 10 }, (_, i) => `\`sembolAdi${i}\``).join(" ") + " " +
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

test("parseNote: metadata altındaki girintili alanlar okunur, üst seviye kazanır", () => {
  // Ölçüm (altın set §5.4): gerçek Claude Code not biçiminde `modified` alanı
  // `metadata:` altında girintili duruyor; okunamayınca 28 notun 28'inde
  // noteTimestamp import anına düştü ve churn penceresi kullanılamaz oldu.
  const raw = "---\nname: n\ndescription: \"d\"\nmetadata: \n" +
    "  node_type: memory\n  modified: 2026-08-11T21:57:39.156Z\n---\n\ngövde";
  const p = parseNote(raw);
  assert.equal(p.frontmatter.modified, "2026-08-11T21:57:39.156Z");
  assert.equal(p.frontmatter.node_type, "memory");
  assert.equal(p.frontmatter.metadata, undefined); // eşleme başlığı hâlâ değer değil
  assert.equal(p.body.trim(), "gövde");
  // Geri düşüş burada TAVAN da olduğu için (kelepçe) notun tarihinden sonrası seçildi.
  assert.equal(noteTimestamp(p.frontmatter, "2026-08-12T00:00:00Z").iso, "2026-08-11T21:57:39.156Z");

  // Çakışmada üst seviye kazanır: girintili alan onu EZEMEZ.
  const cakisma = parseNote("---\nmodified: 2026-01-02T00:00:00Z\nmetadata:\n  modified: 2020-01-01T00:00:00Z\n---\nx");
  assert.equal(cakisma.frontmatter.modified, "2026-01-02T00:00:00Z");
});

test("noteTimestamp: frontmatter modified > created > geri düşüş, geçerli tarih ISO'ya normalize edilir", () => {
  const now = "2026-08-11T00:00:00Z";
  assert.equal(noteTimestamp({ modified: "2026-08-01T10:00:00.000Z" }, now).iso, "2026-08-01T10:00:00.000Z");
  assert.equal(noteTimestamp({}, now).iso, now);
  assert.equal(noteTimestamp({ modified: "bozuk-tarih" }, now).iso, now); // ayrıştırılamayan → geri düşüş
  // ISO olmayan ama ayrıştırılabilir giriş. Saat dilimi GMT olarak yazıldı: dilimsiz
  // yazılsaydı beklenen değer testi koşturan makinenin diliminden değişirdi.
  assert.equal(noteTimestamp({ created: "11 Aug 2026 00:00:00 GMT" }, "2026-08-20T00:00:00Z").iso,
    "2026-08-11T00:00:00.000Z");
  assert.equal(noteTimestamp({ modified: "2026-08-01T10:00:00Z" }, now).iso, "2026-08-01T10:00:00.000Z");
  // Geri düşüş değeri ayrıştırılamıyorsa TAVAN da yok: uydurma bir pencere
  // dayatmak yerine notun değeri olduğu gibi kullanılır (çağıranın hatası,
  // sessizce yanlış ölçüm değil).
  assert.equal(noteTimestamp({ modified: "2099-01-01T00:00:00Z" }, "F").iso, "2099-01-01T00:00:00.000Z");
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

// ─── Dalga B: güvenilmez girdi (denetim 12 Ağu 2026) ──────────────────────────

test("noteTimestamp: gelecekteki damga içe aktarma anına kelepçelenir (untrusted-audit-window)", () => {
  // Probe terfisi: future-modified-suppresses-churn.sh. Not kendi denetim
  // penceresini kapatabiliyordu — `modified: 2099` `--since` sınırını bugünün
  // ötesine iterek churn'ü sıfırlıyor, aynı çapa `churned`/0,2 yerine `ok`/0
  // veriyordu.
  const now = "2026-08-12T00:00:00.000Z";
  const r = noteTimestamp({ modified: "2099-01-01T00:00:00Z" }, now);
  assert.equal(r.iso, now, "gelecek damga kelepçelenmedi");
  assert.deepEqual(r.clamped, { field: "modified", value: "2099-01-01T00:00:00Z" });

  // SINIF KAPANIŞI — orijinal repro yalnız `modified` kullanıyordu; diğer iki
  // alan da aynı yoldan geçiyor.
  assert.equal(noteTimestamp({ created: "2099-01-01T00:00:00Z" }, now).iso, now);
  assert.equal(noteTimestamp({ created: "2099-01-01T00:00:00Z" }, now).clamped?.field, "created");
  assert.equal(noteTimestamp({ date: "3000-05-05" }, now).iso, now);
  assert.equal(noteTimestamp({ date: "3000-05-05" }, now).clamped?.field, "date");
  // ISO olmayan ama ayrıştırılabilir gelecek yazımı da kelepçelenir.
  assert.equal(noteTimestamp({ modified: "1 Jan 2099 00:00:00 GMT" }, now).iso, now);

  // Geçmiş damga MEŞRU: eski not gerçekten eskidir ve geniş pencere denetimi
  // sıkılaştırır. Kelepçe onu bozmamalı.
  const gecmis = noteTimestamp({ modified: "2020-03-04T05:06:07Z" }, now);
  assert.equal(gecmis.iso, "2020-03-04T05:06:07.000Z");
  assert.equal(gecmis.clamped, undefined);
  // Sınır: tam import anı gelecek DEĞİL, kelepçelenmez.
  assert.equal(noteTimestamp({ modified: now }, now).clamped, undefined);
});

test("noteTimestamp: ayrıştırılamayan damga sessizce atlanmaz, hangi alan olduğu bildirilir", () => {
  const now = "2026-08-12T00:00:00.000Z";
  const r = noteTimestamp({ modified: "bozuk-tarih", created: "2026-01-01T00:00:00Z" }, now);
  assert.equal(r.iso, "2026-01-01T00:00:00.000Z"); // bir sonraki alana geçiş korunuyor
  assert.deepEqual(r.unparsable, [{ field: "modified", value: "bozuk-tarih" }]);
  // Yankılanan değer kırpılır: olay günlüğü 256 KiB'lık bir frontmatter değerini taşımamalı.
  const uzun = noteTimestamp({ modified: "x".repeat(5000) }, now);
  assert.equal(uzun.unparsable![0]!.value.length, 201); // 200 + "…"
});

test("parseNote: girintili alan yalnız `metadata:` altında kabul edilir (frontmatter-scope-confusion)", () => {
  // Probe terfisi: nested-frontmatter-parent.sh. Girintili `key: value` satırları
  // EBEVEYNE bakılmadan tek düz haritaya toplanıyordu; `presentation:` altındaki
  // `modified:` gerçek denetim damgası sanılıyordu.
  const p = parseNote("---\npresentation:\n  modified: 2099-01-01T00:00:00Z\n---\nDURUM: eski\n");
  assert.equal(p.frontmatter.modified, undefined, "yabancı ebeveyn altındaki alan sızdı");
  assert.equal(noteTimestamp(p.frontmatter, "2026-08-12T00:00:00.000Z").iso, "2026-08-12T00:00:00.000Z");

  // SINIF KAPANIŞI — farklı ebeveyn adları, aynı hüküm.
  for (const parent of ["frontmatter", "display", "Metadata", "meta"]) {
    const q = parseNote(`---\n${parent}:\n  modified: 2099-01-01T00:00:00Z\n---\nx`);
    assert.equal(q.frontmatter.modified, undefined, `${parent} altındaki alan sızdı`);
  }
  // metadata GEÇERLİ ebeveyn olmaya devam ediyor (altın set §5.4 ölçümü).
  assert.equal(
    parseNote("---\nmetadata:\n  modified: 2026-08-11T21:57:39.156Z\n---\nx").frontmatter.modified,
    "2026-08-11T21:57:39.156Z",
  );
  // Dolu değerli bir üst seviye anahtar başlık DEĞİL: altındaki girinti kapsam dışı.
  assert.equal(parseNote("---\nmetadata: v\n  modified: 2099-01-01T00:00:00Z\n---\nx").frontmatter.modified, undefined);
  // Başlık bağlamı boş satırla bozulmaz.
  assert.equal(parseNote("---\nmetadata:\n\n  modified: 2026-01-01T00:00:00Z\n---\nx").frontmatter.modified,
    "2026-01-01T00:00:00Z");
  // metadata kapandıktan SONRA gelen başka başlık altındaki alan alınmaz.
  assert.equal(
    parseNote("---\nmetadata:\n  a: 1\nother:\n  modified: 2099-01-01T00:00:00Z\n---\nx").frontmatter.modified,
    undefined,
  );
});

test("parseNote: BOŞ değerli üst seviye anahtar girintili namesake ile ezilemez", () => {
  // Yorumdaki "üst seviye her zaman kazanır" iddiası bu durumda YANLIŞTI: değeri
  // boş olan üst seviye anahtar haritaya hiç yazılmadığı için `metadata` altındaki
  // aynı adlı alan onu ezebiliyordu.
  const p = parseNote("---\nmodified:\nmetadata:\n  modified: 2099-01-01T00:00:00Z\n---\nx");
  assert.equal(p.frontmatter.modified, undefined, "boş üst seviye anahtar girintiliyle ezildi");
  // Dolu üst seviye anahtar da kazanmaya devam ediyor (mevcut sözleşme).
  assert.equal(
    parseNote("---\nmodified: 2026-01-02T00:00:00Z\nmetadata:\n  modified: 2020-01-01T00:00:00Z\n---\nx")
      .frontmatter.modified,
    "2026-01-02T00:00:00Z",
  );
});

test("capNoteContent: tavan üstü not kırpılır, kırpma sayılır, vekil çifti bölünmez", () => {
  const kucuk = "a".repeat(1000);
  assert.deepEqual(capNoteContent(kucuk), { content: kucuk, truncated: 0 });

  const buyuk = "a".repeat(MAX_NOTE_CHARS + 500);
  const r = capNoteContent(buyuk);
  assert.equal(r.content.length, MAX_NOTE_CHARS);
  assert.equal(r.truncated, 500);

  // Kesim noktasına tam bir vekil çifti oturt: yüksek vekil son karakter olursa
  // geriye tek başına kalır ve UTF-8'e kodlanamaz.
  const bolen = "a".repeat(MAX_NOTE_CHARS - 1) + "😀" + "b".repeat(10);
  const s = capNoteContent(bolen);
  assert.equal(s.content.length, MAX_NOTE_CHARS - 1, "yalnız kalan yüksek vekil kırpılmadı");
  assert.equal(Buffer.from(s.content, "utf8").toString("utf8"), s.content);
});
