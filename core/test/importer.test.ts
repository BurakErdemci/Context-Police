import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, symlinkSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { importMemoryDir } from "../src/importer/import.ts";
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
