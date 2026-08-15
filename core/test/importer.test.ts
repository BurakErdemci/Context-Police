import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, symlinkSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { importMemoryDir } from "../src/importer/import.ts";
import { MAX_NOTE_CHARS, noteTimestamp } from "../src/importer/parse.ts";
import { listActive, getFinding, getAnchors } from "../src/store/findings.ts";
import { listEvents } from "../src/store/events.ts";
import { tmpDir } from "./helpers.ts";

function setup() {
  // Ham mkdtemp yerine helper: süreç sonunda kendini siliyor (temizlik birinci sınıf).
  const dir = tmpDir("cp-imp-");
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES ('/p','claude-code','/t')",
  ).lastInsertRowid);
  return { dir, store, projectId };
}

// class: body-date-fallback-dead-in-production
// noteTimestamp grew a body fallback with a green unit test, but the only
// production caller never passed `body`, so `source: "body"` was unreachable
// outside the tests and the golden-set tooling. Measured 15 Aug 2026 over
// ~/.claude/projects/*/memory/*.md: 21 of 83 notes are datable only from the
// body and every one of them fell to the import moment, emptying its churn
// window. The assertion is on the STORED stamp, since that is what the unit
// test could not see.
test("frontmatter'ı tarihsiz not: damga gövdeden gelir, import anına düşmez", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "b.md"),
    `---\nname: b\ndescription: d\n---\n4 Mar 2026 ölçümü: \`scanOnce\` core/src/scan.ts içinde`);
  await importMemoryDir(store, projectId, dir);
  const [f] = listActive(store, projectId);
  assert.equal(f!.createdAt, "2026-03-04T00:00:00.000Z");
});

// class: body-example-controls-audit-window
// Found by the verification round over the fix above. A date inside a fenced
// example is part of what the note DESCRIBES, not evidence of when it was
// written, but the body scan took it as authoritative: a note whose only date
// was `const releaseDate = '2001-01-01'` was stamped 2001, moving its churn
// window back ~25 years and spending git budget on it. Code regions are now
// stripped before the scan; prose dates, including quoted prose, still count.
test("kod bloğundaki tarih notun damgası olmaz", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "d.md"),
    "---\nname: d\ndescription: d\n---\n" +
    "Örnek:\n\n```ts\nconst releaseDate = '2001-01-01';\n```\n\n" +
    "`scanOnce` core/src/scan.ts içinde");
  await importMemoryDir(store, projectId, dir);
  const [f] = listActive(store, projectId);
  assert.ok(f!.createdAt > "2020-01-01", `kod örneği damgayı belirledi: ${f!.createdAt}`);
});

// class: markdown-code-date-leak / prose-date-overstripped
// Verification round two found the strip wrong in BOTH directions. An
// unterminated opening fence makes the rest of a CommonMark document code, but
// the pattern demanded a closing fence and leaked those dates. And a span was
// matched between backtick runs of DIFFERENT lengths, which CommonMark treats
// as prose — over-stripping is the more expensive half, because it drops the
// note back to the import-time fallback that the body scan exists to avoid.
test("kapanmamış fence kod sayılır, eşleşmeyen backtick düzyazı kalır", () => {
  const leak = noteTimestamp({}, "2026-08-15T00:00:00.000Z", {
    body: "```ts\nconst d = '2001-01-01';\n",
  });
  assert.notEqual(leak.source, "body", "kapanmamış fence içindeki tarih damga oldu");

  const prose = noteTimestamp({}, "2026-08-15T00:00:00.000Z", {
    body: "`not closed 2026-03-04``",
  });
  assert.equal(prose.source, "body", "eşleşmeyen backtick düzyazıyı sildi");
  assert.equal(prose.iso, "2026-03-04T00:00:00.000Z");
});

// The body is untrusted text, so widening the stamp's source widens what a note
// can assert about its own audit window. Only the FUTURE is clamped: a past
// stamp tightens the window, a future one would close it.
test("gövde tarihi GELECEKTE ise kelepçelenir: not kendi denetim penceresini kapatamaz", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "c.md"),
    `---\nname: c\ndescription: d\n---\n2099-01-01 tarihli \`scanOnce\` core/src/scan.ts notu`);
  await importMemoryDir(store, projectId, dir);
  const [f] = listActive(store, projectId);
  assert.ok(f!.createdAt < "2099-01-01", `gelecek damga kelepçelenmedi: ${f!.createdAt}`);
});

test("ilk import: not eklenir, çapaları çıkar, MEMORY.md atlanır, tarih frontmatter'dan", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "MEMORY.md"), "- [x](a.md) — indeks");
  writeFileSync(join(dir, "a.md"),
    `---\nname: a\ndescription: d\nmodified: 2026-08-01T10:00:00.000Z\n---\n\`scanOnce\` core/src/scan.ts içinde`);
  const sum = await importMemoryDir(store, projectId, dir);
  assert.deepEqual({ ...sum },
    { files: 1, added: 1, unchanged: 0, replaced: 0, deleted: 0, skipped: 1, rejected: 0, errors: 0 });
  const [f] = listActive(store, projectId);
  assert.equal(f!.source, "imported");
  assert.equal(f!.createdAt, "2026-08-01T10:00:00.000Z");
  // Çapa sırası öncelik sırasıdır, metin sırası değil — tür bazlı karşılaştırılır.
  const kinds = getAnchors(store, f!.id).map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["file_path", "symbol"]);
});

test("değişmeyen dosya ikinci koşumda hiçbir kayıt üretmez (idempotent)", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "a.md"), "içerik");
  await importMemoryDir(store, projectId, dir);
  const sum2 = await importMemoryDir(store, projectId, dir);
  assert.equal(sum2.unchanged, 1);
  assert.equal(sum2.added + sum2.replaced, 0);
  assert.equal(listActive(store, projectId).length, 1);
});

test("değişen dosya: eski temsil superseded + yenisine bağlı; silinen dosya: temsil superseded", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "a.md"), "v1");
  writeFileSync(join(dir, "b.md"), "kalıcı");
  await importMemoryDir(store, projectId, dir);
  const oldId = listActive(store, projectId).find((f) => f.content === "v1")!.id;

  writeFileSync(join(dir, "a.md"), "v2");
  rmSync(join(dir, "b.md"));
  const sum = await importMemoryDir(store, projectId, dir);
  assert.equal(sum.replaced, 1);
  assert.equal(sum.deleted, 1);

  const old = getFinding(store, oldId)!;
  assert.equal(old.status, "superseded");
  const next = getFinding(store, old.supersededBy!)!;
  assert.equal(next.content, "v2");
  // silinen dosyanın temsili superseded ama superseded_by YOK (yerine geçen kayıt yok)
  const alive = listActive(store, projectId).map((f) => f.content).sort();
  assert.deepEqual(alive, ["v2"]);
});

// --- Girdi tipi: hafıza dizini dışına çıkan symlink (denetim: import-follows-symlink,
// memory-symlink-read). İddia GÜVENLİK DEĞİL DOĞRULUK: symlink koyabilen aktör aynı
// baytları düz bir .md olarak da yazabilir, yeni yetenek yok. Kusur şu: source_ref
// dizin içi bir yol gösterirken içerik başka ağaçtan geliyor, ve o notun çapaları
// YANLIŞ repoya karşı ölçülüyor.

/** Hafıza dizinini bir kök altına kurar: "dışarısı" da aynı geçici kökte kalsın. */
function nested() {
  const root = tmpDir("cp-imp-link-");
  const dir = join(root, "memory");
  mkdirSync(dir);
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES ('/p','claude-code','/t')",
  ).lastInsertRowid);
  return { root, dir, store, projectId };
}

test("dizin dışına çıkan symlink import edilmez, sessiz de kalmaz (mutlak ve göreli)", async () => {
  const { root, dir, store, projectId } = nested();
  writeFileSync(join(root, "outside.md"), "OUTSIDE_MEMORY_MARKER");
  symlinkSync(join(root, "outside.md"), join(dir, "abs.md"));   // mutlak hedef
  symlinkSync("../outside.md", join(dir, "rel.md"));            // göreli hedef

  const sum = await importMemoryDir(store, projectId, dir);
  assert.equal(sum.added, 0);
  assert.equal(sum.rejected, 2);
  assert.deepEqual(listActive(store, projectId).map((f) => f.content), []);
  const rejected = listEvents(store, { projectId, kind: "import_entry_rejected" });
  assert.equal(rejected.length, 2);
});

test("dizin İÇİNDE kalan symlink import edilir — kısıt yol değil ağaç kısıtı", async () => {
  const { dir, store, projectId } = nested();
  writeFileSync(join(dir, "real.md"), "İÇERDEKİ NOT");
  symlinkSync(join(dir, "real.md"), join(dir, "alias.md"));

  const sum = await importMemoryDir(store, projectId, dir);
  assert.equal(sum.rejected, 0);
  assert.equal(sum.added, 2); // aynı içerik iki source_ref: ikisi de dizin içi
  assert.deepEqual(listActive(store, projectId).map((f) => f.content), ["İÇERDEKİ NOT", "İÇERDEKİ NOT"]);
});

// Değişmez kural (doğrulama turu, probe: rejected-import-event-not-atomic):
// bir SONUCU anlatan olay, o sonuçla AYNI transaction'da commit edilir ya da
// hiç edilmez. Reddetme olayı girdi döngüsünde tek başına autocommit ediliyor,
// reddedilen yolun eski kaydı ise çok sonra süpürmede superseded oluyordu —
// arada bir ölüm "reddedildi" yazan bir günlük ve hâlâ `active` bir not
// bırakıyordu.
test("reddedilen girdi: olay ve eski kaydın supersede'i ya birlikte ya hiç", async () => {
  const { root, dir, store, projectId } = nested();
  const note = join(dir, "note.md");
  writeFileSync(note, "ÖNCEKİ CANLI NOT");
  writeFileSync(join(root, "outside.md"), "DIŞARIDAN İÇERİK");
  await importMemoryDir(store, projectId, dir);
  assert.equal(listActive(store, projectId).length, 1);

  // Aynı yol artık ağaç dışını gösteriyor: girdi reddedilecek.
  rmSync(note);
  symlinkSync(join(root, "outside.md"), note);

  // Supersede yazımını patlat: kırılma noktası tam olarak olay ile sonucun
  // arasına düşüyor.
  let injected = false;
  const bozuk = {
    ...store,
    run(sql: string, ...p: Parameters<typeof store.run>[1][]) {
      if (sql.startsWith("UPDATE findings SET status = 'superseded'")) {
        injected = true;
        throw new Error("enjekte edilen supersede hatası");
      }
      return store.run(sql, ...p);
    },
  };
  await assert.rejects(() => importMemoryDir(bozuk as typeof store, projectId, dir));
  assert.ok(injected, "test kendi kırılma noktasına ulaşamadıysa hiçbir şey kanıtlamaz");

  // İkisi de yok: tx geri alındı. "Reddedildi yazılı ama not canlı" hâli
  // artık üretilemiyor.
  assert.equal(listEvents(store, { projectId, kind: "import_entry_rejected" }).length, 0);
  assert.equal(listActive(store, projectId).length, 1);
});

test("reddedilen girdinin eski kaydı süpürmeyi beklemeden, olayla aynı anda superseded olur", async () => {
  const { root, dir, store, projectId } = nested();
  const note = join(dir, "note.md");
  writeFileSync(note, "ÖNCEKİ CANLI NOT");
  writeFileSync(join(root, "outside.md"), "DIŞARIDAN İÇERİK");
  await importMemoryDir(store, projectId, dir);
  const oldId = listActive(store, projectId)[0]!.id;

  rmSync(note);
  symlinkSync(join(root, "outside.md"), note);
  const sum = await importMemoryDir(store, projectId, dir);

  assert.equal(sum.rejected, 1);
  assert.equal(getFinding(store, oldId)!.status, "superseded");
  assert.equal(listEvents(store, { projectId, kind: "import_entry_rejected" }).length, 1);
  const sup = listEvents(store, { projectId, kind: "finding_superseded" });
  assert.equal(sup.length, 1);
  assert.equal(JSON.parse(sup[0]!.detail!).reason, "entry_rejected");
  // Süpürme aynı kaydı İKİNCİ kez ele almaz (zaten superseded).
  assert.equal(listEvents(store, { projectId, kind: "import_file_deleted" }).length, 0);
});

test("kırık symlink: kayıt üretmez, süpürme onu 'yok' sayar", async () => {
  const { dir, store, projectId } = nested();
  symlinkSync(join(dir, "yok-olan-hedef.md"), join(dir, "dangling.md"));
  const sum = await importMemoryDir(store, projectId, dir);
  assert.equal(sum.added, 0);
  assert.equal(listActive(store, projectId).length, 0);
});

// --- Listeleme ile okuma arasındaki pencere (denetim: disappearing-note-stays-live).

test("listeleme ile okuma arasında SİLİNEN not canlı kalmaz", async (t) => {
  const { dir, store, projectId } = nested();
  writeFileSync(join(dir, "b.md"), "OLD-NOTE");
  await importMemoryDir(store, projectId, dir);
  const oldId = listActive(store, projectId)[0]!.id;

  // a.md bir FIFO: sıralamada önce geldiği için readdir İKİ adı da döndürdükten
  // sonra readFile burada bloke olur — listeleme/okuma penceresini deterministik
  // açan tek bağımlılıksız yol.
  const fifo = join(dir, "a.md");
  if (spawnSync("mkfifo", [fifo]).status !== 0) { t.skip("mkfifo yok"); return; }

  const running = importMemoryDir(store, projectId, dir);
  // O_NONBLOCK: okuyucu yokken açma ENXIO ile HEMEN döner. Bloke eden bir yazma,
  // import FIFO'yu hiç okumazsa testi süresiz asardı.
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  for (let i = 0; i < 200 && fh === undefined; i++) {
    try { fh = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK); }
    catch { await delay(10); }
  }
  assert.ok(fh, "import FIFO'yu okumaya açmadı: pencere kurulamadı");
  rmSync(join(dir, "b.md"));  // okuma sürerken not kayboluyor
  await fh.write("barrier");
  await fh.close();

  const sum = await running;
  assert.equal(sum.errors, 1);      // b.md okunamadı ve bu sessiz kalmadı
  assert.equal(sum.deleted, 1);     // ...ve "artık diskte yok" süpürmesi onu gördü
  assert.equal(getFinding(store, oldId)!.status, "superseded");
});

test("okunamayan ama VAR OLAN not silinmiş sayılmaz", async () => {
  const { dir, store, projectId } = nested();
  writeFileSync(join(dir, "a.md"), "CANLI");
  await importMemoryDir(store, projectId, dir);
  const id = listActive(store, projectId)[0]!.id;

  // Yolu okunamaz kıl ama YOK ETME: dizin (EISDIR) chmod'a göre deterministik ve
  // root olarak koşulduğunda da hata veriyor. ENOENT dışı her hata "dosya yok"
  // demediği için kayıt canlı kalmalı.
  rmSync(join(dir, "a.md"));
  mkdirSync(join(dir, "a.md"));
  const sum = await importMemoryDir(store, projectId, dir);
  assert.equal(sum.errors, 1);
  assert.equal(sum.deleted, 0);
  assert.notEqual(getFinding(store, id)!.status, "superseded"); // çapasız not 'unanchored' doğuyor

});

test("başka bir notun okunamaması, gerçekten silinmiş notun süpürülmesini engellemez", async () => {
  const { dir, store, projectId } = nested();
  writeFileSync(join(dir, "a.md"), "OKUNAMAZ OLACAK");
  writeFileSync(join(dir, "b.md"), "SİLİNECEK");
  await importMemoryDir(store, projectId, dir);

  rmSync(join(dir, "a.md"));
  mkdirSync(join(dir, "a.md"));
  rmSync(join(dir, "b.md"));
  const sum = await importMemoryDir(store, projectId, dir);
  assert.equal(sum.deleted, 1);
  assert.deepEqual(listActive(store, projectId).map((f) => f.content), ["OKUNAMAZ OLACAK"]);
});

// ─── Dalga B: güvenilmez girdi (denetim 12 Ağu 2026) ──────────────────────────

test("import: gelecekteki frontmatter damgası kelepçelenir ve olay yazılır", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "a.md"), "---\nmodified: 2099-01-01T00:00:00Z\n---\ncore/src/scan.ts\n");
  await importMemoryDir(store, projectId, dir);
  const [f] = listActive(store, projectId);
  assert.ok(f!.createdAt < "2099", `createdAt kelepçelenmedi: ${f!.createdAt}`);
  const ev = listEvents(store, { projectId, kind: "import_timestamp_clamped" });
  assert.equal(ev.length, 1, "kelepçe sessiz kaldı");
  assert.equal(JSON.parse(ev[0]!.detail!).field, "modified");
});

test("import: ayrıştırılamayan damga olayla bildirilir", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "a.md"), "---\nmodified: dün\n---\ncore/src/scan.ts\n");
  await importMemoryDir(store, projectId, dir);
  assert.equal(listEvents(store, { projectId, kind: "import_timestamp_unparsable" }).length, 1);
});

test("import: tavan üstü not kırpılarak saklanır, kırpma olayı yazılır (unbounded-note-size)", async () => {
  // Probe terfisi: unbounded-note-size.sh. Boyut/sayı tavanı yoktu; 100 MB'lık
  // tek dosya 100 MB'lık tek kayıt olarak saklanıyordu ve bu depoda hiçbir kayıt
  // silinmiyor (spec §3.2).
  const { dir, store, projectId } = setup();
  // Kısa satırlar: tek kesintisiz `[\w.-]` koşusu PATH_RE'yi karesel yola sokuyor
  // (M4'e ertelenen ayrı karar) ve bu test tavanı ölçüyor, regex'i değil —
  // patolojik dolgu testi 64 saniyeye çıkarıyordu.
  const buyuk = ("x".repeat(63) + "\n").repeat((MAX_NOTE_CHARS + 4096) / 64);
  writeFileSync(join(dir, "buyuk.md"), buyuk);
  await importMemoryDir(store, projectId, dir);
  const [f] = listActive(store, projectId);
  assert.equal(f!.content.length, MAX_NOTE_CHARS, "gövde tavana kırpılmadı");
  const ev = listEvents(store, { projectId, kind: "import_note_truncated" });
  assert.equal(ev.length, 1, "kırpma sessiz kaldı");
  assert.equal(JSON.parse(ev[0]!.detail!).truncated, 4096);
});
