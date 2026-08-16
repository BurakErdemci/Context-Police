import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, openStoreReadonly } from "../src/store/db.ts";
import { appendFinding } from "../src/store/findings.ts";
import { tmpStorePath } from "./helpers.ts";

function seedFile(): string {
  const path = tmpStorePath();
  const store = openStore(path);
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/p", "claude-code", "/t",
  ).lastInsertRowid);
  appendFinding(store, {
    projectId, source: "imported", content: "DURUM: eski",
    sourceRef: "n.md", anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });
  store.close();
  return path;
}

test("readonly açılış var olan depoyu okur", () => {
  const path = seedFile();
  const ro = openStoreReadonly(path);
  const row = ro.get<{ content: string }>("SELECT content FROM findings WHERE id = 1");
  assert.equal(row?.content, "DURUM: eski");
  assert.equal(ro.all("SELECT id FROM projects").length, 1);
  ro.close();
});

test("readonly bağlantıdan yazmak fiziken imkânsız", () => {
  const path = seedFile();
  const ro = openStoreReadonly(path);
  assert.throws(
    () => ro.all("INSERT INTO events (at, kind) VALUES ('x','manual_test')"),
    /readonly|READONLY/,
  );
  ro.close();
});

test("olmayan dosya için açılış fırlatır (dosya YARATMAZ)", () => {
  const path = tmpStorePath();
  assert.throws(() => openStoreReadonly(path));
});
