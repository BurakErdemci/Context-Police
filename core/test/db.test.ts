import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store/db.ts";
import { tmpStorePath } from "./helpers.ts";

test("şema uygulanınca beş tablo da var", () => {
  const s = openStore(":memory:");
  const names = s
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => r.name);
  for (const t of ["anchors", "cursors", "events", "findings", "projects"]) {
    assert.ok(names.includes(t), `${t} tablosu yok`);
  }
  s.close();
});

test("ikinci açılış idempotent — veri korunuyor", () => {
  const path = tmpStorePath();
  const a = openStore(path);
  a.run("INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t");
  a.close();

  const b = openStore(path);
  const row = b.get<{ path: string }>("SELECT path FROM projects");
  assert.equal(row?.path, "/p");
  b.close();
});

test("status CHECK'i geçersiz değeri reddeder, yeni statüleri kabul eder", () => {
  const s = openStore(":memory:");
  const pid = s.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/p",
    "claude-code",
    "/t",
  ).lastInsertRowid;

  const ins = (status: string) =>
    s.run(
      "INSERT INTO findings (project_id, source, content, created_at, status) VALUES (?,?,?,?,?)",
      pid,
      "observed",
      "x",
      "2026-08-10T00:00:00.000Z",
      status,
    );

  // M0-D2 ve M0-D5'in şemadaki karşılığı
  assert.doesNotThrow(() => ins("born_invalid"));
  assert.doesNotThrow(() => ins("unanchored"));
  assert.throws(() => ins("silindi"), /CHECK|constraint/i);
  s.close();
});

test("suspicion 0..1 aralığı dışına çıkamaz", () => {
  const s = openStore(":memory:");
  const pid = s.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/p",
    "claude-code",
    "/t",
  ).lastInsertRowid;
  assert.throws(
    () =>
      s.run(
        "INSERT INTO findings (project_id, source, content, created_at, suspicion) VALUES (?,?,?,?,?)",
        pid,
        "observed",
        "x",
        "2026-08-10T00:00:00.000Z",
        1.5,
      ),
    /CHECK|constraint/i,
  );
  s.close();
});

test("tx: hata atınca geri alınıyor", () => {
  const s = openStore(":memory:");
  assert.throws(() =>
    s.tx(() => {
      s.run("INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "a", "/t");
      throw new Error("patla");
    }),
  );
  assert.equal(s.all("SELECT * FROM projects").length, 0);
  s.close();
});

test("node:sqlite yalnız db.ts'de import ediliyor", async () => {
  // Spec K12: takas tek dosyalık iş kalmalı. Bu test kuralı yorumdan çıkarıp
  // sabitliyor — başka bir dosya import ederse kırmızı olur.
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const out = execFileSync("grep", ["-rl", "node:sqlite", srcDir], { encoding: "utf8" })
    .trim()
    .split("\n");
  assert.deepEqual(
    out.map((p) => p.split("/").pop()),
    ["db.ts"],
  );
});
