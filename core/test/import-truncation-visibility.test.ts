// D dalgası (12 Ağu 2026 doğrulama turu): ÖNCEKİ düzeltmelerin kendi getirdiği
// kusur. Probe ana ağaca karşı rc=1 ölçüldü; buradaki testler o probe'un terfi
// edilmiş hâli + sınıf kapanışı varyantları.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { importMemoryDir } from "../src/importer/import.ts";
import { MAX_NOTE_CHARS } from "../src/importer/parse.ts";
import { tmpDir } from "./helpers.ts";

// --- 4) kırpma her koşumda görünür --------------------------------------------

function memoryProject(): { store: ReturnType<typeof openStore>; dir: string; id: number } {
  const dir = tmpDir("cp-wave-d-mem-");
  const store = openStore(":memory:");
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    "/probe/project", "probe", "/probe/transcripts", dir,
  ).lastInsertRowid);
  return { store, dir, id };
}

const truncCount = (store: ReturnType<typeof openStore>): number =>
  store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = ?", "import_note_truncated")!.n;

/**
 * Tavan dolduran gövde. Satırlara BÖLÜNMÜŞ olması testin süresi için şart:
 * tek satırlık 256 KiB bir gövdede import 65 sn sürüyor (ölçüldü, bu testin ilk
 * hâli), satırlı gövdede milisaniyeler. Ayrı bir bulgu — burada yalnız not ediliyor.
 */
const oversize = (tail: string): string => {
  const line = "x".repeat(63) + "\n";
  return line.repeat(Math.ceil(MAX_NOTE_CHARS / line.length)).slice(0, MAX_NOTE_CHARS) + tail;
};

test("kırpılan not içerik değişmese de HER koşumda import_note_truncated yazıyor", async () => {
  const { store, dir, id } = memoryProject();
  writeFileSync(join(dir, "buyuk.md"), oversize("KUYRUK"));

  const first = await importMemoryDir(store, id, dir);
  assert.equal(first.added, 1);
  assert.equal(truncCount(store), 1);

  const second = await importMemoryDir(store, id, dir);
  assert.equal(second.unchanged, 1, "kırpılmış gövde değişmedi: kayıt yeniden açılmamalı");
  assert.equal(truncCount(store), 2, "kırpma yalnız ilk koşumda görünüyor — not her koşumda kırpılıyor");
  store.close();
});

test("varyant: tavan üstü KUYRUK değişimi 'unchanged' kalır (belgelenmiş takas) ama kırpma görünür", async () => {
  const { store, dir, id } = memoryProject();
  const path = join(dir, "buyuk.md");
  writeFileSync(path, oversize("KUYRUK-A"));
  await importMemoryDir(store, id, dir);

  writeFileSync(path, oversize("KUYRUK-B"));
  const second = await importMemoryDir(store, id, dir);
  // İçerik yarısı KABUL EDİLEN TAKAS: tavan üstü baytlar hiç denetlenmiyor,
  // dolayısıyla hükmü değiştiremezler (import.ts'teki gerekçe).
  assert.equal(second.unchanged, 1);
  assert.equal(second.replaced, 0);
  // Görünürlük yarısı: kullanıcı her koşumda kırpıldığını görüyor.
  assert.equal(truncCount(store), 2);
  store.close();
});

test("varyant: kırpılMAYAN not değişmediğinde hiç kırpma olayı yazılmıyor", async () => {
  const { store, dir, id } = memoryProject();
  writeFileSync(join(dir, "kucuk.md"), "kısa bir not\n");
  await importMemoryDir(store, id, dir);
  const second = await importMemoryDir(store, id, dir);
  assert.equal(second.unchanged, 1);
  assert.equal(truncCount(store), 0, "kırpılmamış not için kırpma olayı uydurulmuş");
  store.close();
});
