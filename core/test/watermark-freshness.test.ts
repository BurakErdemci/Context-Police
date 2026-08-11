// Filigran tazeliği (M2 borcu 2): `--session` yolu readIncremental'a inode/mtime
// GEÇİRMEDİĞİ için yerinde-yazım tespiti (claude-code.ts replacedInPlace) ölüydü.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { getWatermark, setWatermark } from "../src/store/watermarks.ts";
import { readSessionIncremental, recordSessionFreshness } from "../src/observe-cmd.ts";
import { Observer } from "../src/observer/observer.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";

// CLAUDE.md §7: göç VAR OLAN depo dosyası üzerinde doğrulanır — taze depoda
// çalışması kanıt değil. Aynı sınıf üç denetimde üç kez kanadı.
test("göç: M2-sonu (konumsal ama tazeliksiz) depo açılır, satır korunur, yeni alanlar yazılabilir", () => {
  const path = join(tmpDir("cp-wm-"), "eski.db");

  // M2 sonundaki gerçek şema: byte_offset var, inode/mtime_ms yok.
  const eski = new DatabaseSync(path);
  eski.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, adapter_id TEXT NOT NULL,
      transcript_dir TEXT NOT NULL, memory_dir TEXT, last_scanned_at TEXT
    );
    CREATE TABLE observer_watermarks (
      project_id     INTEGER NOT NULL REFERENCES projects(id),
      session_id     TEXT NOT NULL,
      byte_offset    INTEGER,
      delivery_key   TEXT,
      delivery_turns INTEGER,
      last_uuid      TEXT,
      last_ts        TEXT,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    INSERT INTO projects (id, path, adapter_id, transcript_dir) VALUES (1, '/p', 'claude-code', '/t');
    INSERT INTO observer_watermarks
      VALUES (1, 's1', 4200, 'b:0:4200:7', 7, 'u-7', '2026-08-11T00:00:00Z', '2026-08-11T00:00:01Z');
  `);
  eski.close();

  const store = openStore(path);
  const wm = getWatermark(store, 1, "s1");
  assert.equal(wm?.byteOffset, 4200);   // veri korunmuş
  assert.equal(wm?.inode, null);        // yeni alan var ve boş
  setWatermark(store, { projectId: 1, sessionId: "s1", inode: "12345", mtimeMs: 111.5 });
  const wm2 = getWatermark(store, 1, "s1");
  assert.equal(wm2?.inode, "12345");
  assert.equal(wm2?.mtimeMs, 111.5);
  assert.equal(wm2?.byteOffset, 4200);  // kısmi yazım ofseti silmedi
  store.close();
});

// Gerçek akış reprosu (m2-denetim-dersleri §3): aynı boyutta yerinde yeniden
// yazım. Düzeltme geri alınırsa (null, null geçilirse) bu test KIRMIZI kalır.
test("--session yolu: aynı boyutta yerinde yeniden yazılan dosya yeniden gözlemlenir", async () => {
  const dir = tmpDir("cp-sess-");
  const sessionPath = join(dir, "abc.jsonl");
  const line = (uuid: string, text: string) =>
    JSON.stringify({
      type: "user", uuid, timestamp: "2026-08-11T10:00:00Z",
      message: { role: "user", content: [{ type: "text", text }] }, cwd: "/p",
    }) + "\n";
  // İKİ sürüm aynı bayt uzunluğunda: yalnız metin harfleri değişiyor.
  writeFileSync(sessionPath, line("u1", "AAAA") + line("u2", "BBBB"));

  const store = openStore(join(dir, "store.db"));
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES ('/p','claude-code',?)", dir,
  ).lastInsertRowid);
  const observer = new Observer({
    store,
    executor: fakeExecutor([{ output: '{"findings":[]}' }, { output: '{"findings":[]}' }]),
  });

  // 1. koşum: her şey taze; sonunda tazelik kaydı düşer.
  const r1 = await readSessionIncremental(store, projectId, "abc", sessionPath);
  await observer.handleTurns({ projectId, sessionId: "abc", turns: r1.res.turns, range: r1.range });
  recordSessionFreshness(store, projectId, "abc", r1.res);
  assert.equal(getWatermark(store, projectId, "abc")?.inode, r1.res.inode);

  // Yerinde yeniden yazım: aynı uzunluk, farklı içerik → mtime değişir, boyut değişmez.
  await new Promise((r) => setTimeout(r, 20)); // mtime çözünürlüğü
  await writeFile(sessionPath, line("u1", "CCCC") + line("u2", "DDDD"));

  const r2 = await readSessionIncremental(store, projectId, "abc", sessionPath);
  assert.equal(r2.res.truncated, true);   // yeniden yazım GÖRÜLDÜ
  assert.equal(r2.range.truncated, true);
  assert.equal(r2.res.turns.length, 2);   // dosyanın tamamı yeniden okundu
  store.close();
});
