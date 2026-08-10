import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { upsertProject, getCursor, setCursor, listProjects } from "../src/store/projects.ts";
import { appendFinding, supersede, restore, listActive, getAnchors, getFinding } from "../src/store/findings.ts";
import { logEvent, listEvents, countEvents } from "../src/store/events.ts";

function seed() {
  const s = openStore(":memory:");
  const pid = upsertProject(s, { path: "/proj", adapterId: "claude-code", transcriptDir: "/t" });
  return { s, pid };
}

// --- projeler ve imleç ---

test("aynı yol iki kez upsert → tek satır, aynı id", () => {
  const { s, pid } = seed();
  const again = upsertProject(s, { path: "/proj", adapterId: "claude-code", transcriptDir: "/t", memoryDir: "/m" });
  assert.equal(again, pid);
  assert.equal(listProjects(s).length, 1);
  assert.equal(listProjects(s)[0]!.memory_dir, "/m", "memory_dir sonradan bulununca güncellenmeli");
  s.close();
});

test("imleç yazılıp okunuyor; yoksa null", () => {
  const { s, pid } = seed();
  assert.equal(getCursor(s, pid, "sess-1"), null);
  setCursor(s, pid, "sess-1", { filePath: "/t/sess-1.jsonl", byteOffset: 120, inode: "42" });
  assert.deepEqual(getCursor(s, pid, "sess-1"), {
    filePath: "/t/sess-1.jsonl",
    byteOffset: 120,
    inode: "42",
  });
  s.close();
});

test("imleç geri gidemez — ama inode değişince sıfırlanabilir", () => {
  const { s, pid } = seed();
  setCursor(s, pid, "sess-1", { filePath: "/f", byteOffset: 500, inode: "42" });

  assert.throws(
    () => setCursor(s, pid, "sess-1", { filePath: "/f", byteOffset: 10, inode: "42" }),
    /geri alınamaz/,
  );

  // Dosyanın yerine yenisi konmuş: bilinçli sıfırlama meşru.
  assert.doesNotThrow(() => setCursor(s, pid, "sess-1", { filePath: "/f", byteOffset: 0, inode: "99" }));
  assert.equal(getCursor(s, pid, "sess-1")!.byteOffset, 0);
  s.close();
});

// --- findings: append-only invariantları ---

test("findings.content UPDATE edilemez (şema tetikleyicisi)", () => {
  const { s, pid } = seed();
  const id = appendFinding(s, { projectId: pid, source: "observed", content: "eski", anchors: [{ kind: "file_path", value: "a.ts" }] });
  assert.throws(() => s.run("UPDATE findings SET content = ? WHERE id = ?", "yeni", id), /append-only/);
  assert.equal(getFinding(s, id)!.content, "eski");
  s.close();
});

test("findings ve events silinemez", () => {
  const { s, pid } = seed();
  const id = appendFinding(s, { projectId: pid, source: "observed", content: "x" });
  assert.throws(() => s.run("DELETE FROM findings WHERE id = ?", id), /silinemez/);
  logEvent(s, { projectId: pid, kind: "scan_completed" });
  assert.throws(() => s.run("DELETE FROM events"), /silinemez/);
  s.close();
});

test("depo yüzeyinde delete/drop API'si yok", () => {
  // Silme operasyonu "yapılmıyor" değil "yok" olmalı (spec §3.2).
  const storeDir = fileURLToPath(new URL("../src/store", import.meta.url));
  for (const f of readdirSync(storeDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(storeDir, f), "utf8");
    const exported = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]!);
    const offenders = exported.filter((n) => /delete|remove|drop|purge/i.test(n));
    assert.deepEqual(offenders, [], `${f} içinde silme API'si: ${offenders.join(", ")}`);
  }
});

test("supersede eskiyi listeden çıkarır, restore geri getirir", () => {
  const { s, pid } = seed();
  const oldId = appendFinding(s, { projectId: pid, source: "imported", content: "eski gerçek", anchors: [{ kind: "symbol", value: "foo" }] });
  const newId = appendFinding(s, { projectId: pid, source: "imported", content: "yeni gerçek", anchors: [{ kind: "symbol", value: "foo" }] });

  supersede(s, oldId, newId);
  assert.deepEqual(listActive(s, pid).map((f) => f.id), [newId]);
  assert.equal(getFinding(s, oldId)!.supersededBy, newId);

  // Yanlış işaretin bedeli sıfır: tek adımda dönüş.
  restore(s, oldId);
  assert.deepEqual(listActive(s, pid).map((f) => f.id).sort(), [oldId, newId].sort());
  s.close();
});

test("çapasız bulgu unanchored girer ve şüphe üretmez (M0-D5)", () => {
  const { s, pid } = seed();
  const id = appendFinding(s, { projectId: pid, source: "observed", content: "tercih kaydı" });
  const f = getFinding(s, id)!;
  assert.equal(f.status, "unanchored");
  assert.equal(f.suspicion, 0);
  // Nötr: ajanın okuduğu aktif kümede kalır.
  assert.ok(listActive(s, pid).some((x) => x.id === id));
  s.close();
});

test("çapalar kaydediliyor ve geri okunuyor", () => {
  const { s, pid } = seed();
  const id = appendFinding(s, {
    projectId: pid, source: "observed", content: "x",
    anchors: [
      { kind: "symbol", value: "openStore", takenAtCommit: "abc123" },
      { kind: "file_path", value: "src/store/db.ts" },
      { kind: "external_path", value: "~/.gemini/settings.json" },
    ],
  });
  const got = getAnchors(s, id);
  assert.equal(got.length, 3);
  assert.equal(got.find((a) => a.kind === "symbol")!.takenAtCommit, "abc123");
  // M0-D6: repo dışı çapa şemada meşru.
  assert.ok(got.some((a) => a.kind === "external_path"));
  s.close();
});

// --- events ---

test("olaylar yazılıyor, filtreleniyor, sayılıyor", () => {
  const { s, pid } = seed();
  logEvent(s, { projectId: pid, kind: "unknown_line_type", detail: { lineType: "uydurma", sample: '{"type":"uydurma"}' } });
  logEvent(s, { projectId: pid, kind: "unknown_line_type", detail: "ikinci" });
  logEvent(s, { projectId: pid, kind: "scan_completed" });

  assert.equal(countEvents(s, "unknown_line_type", pid), 2);
  const rows = listEvents(s, { projectId: pid, kind: "unknown_line_type" });
  assert.equal(rows.length, 2);
  assert.match(rows[1]!.detail!, /uydurma/);
  assert.match(rows[0]!.at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  s.close();
});
