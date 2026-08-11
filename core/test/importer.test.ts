import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { importMemoryDir } from "../src/importer/import.ts";
import { listActive, getFinding, getAnchors } from "../src/store/findings.ts";
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
  assert.deepEqual({ ...sum }, { files: 1, added: 1, unchanged: 0, replaced: 0, deleted: 0, skipped: 1, errors: 0 });
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
