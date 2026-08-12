// D dalgası (12 Ağu 2026 doğrulama turu): ÖNCEKİ düzeltmelerin kendi getirdiği
// kusur. Probe ana ağaca karşı rc=1 ölçüldü; buradaki testler o probe'un terfi
// edilmiş hâli + sınıf kapanışı varyantları.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_GENERATION, StoreGenerationTooNew } from "../src/store/db.ts";
import { tmpStorePath } from "./helpers.ts";

// --- 3) kuşak kontrolü dosyaya dokunmadan ÖNCE ---------------------------------

const journalMode = (path: string): string => {
  const db = new DatabaseSync(path, { readOnly: true });
  const m = String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  db.close();
  return m.toLowerCase();
};

test("daha yeni kuşaklı depo reddedilirken dosyanın journal_mode'u DEĞİŞMİYOR", () => {
  const path = tmpStorePath();
  const seed = new DatabaseSync(path);
  seed.exec(`PRAGMA journal_mode = DELETE; PRAGMA user_version = ${SCHEMA_GENERATION + 1}`);
  seed.close();

  assert.throws(() => openStore(path), StoreGenerationTooNew);
  // İddia "dosyaya dokunmadan reddediyoruz" idi; WAL'a geçiş KALICI bir dosya
  // değişikliği, yani iddia yanlıştı. Sonucu hafif, iddia olmak zorunda.
  assert.equal(journalMode(path), "delete", "reddedilen depo yine de WAL'a çevrildi");
});

test("varyant: eski kuşaklı VAR OLAN depo hâlâ sorunsuz açılıyor (göç + damga + WAL)", () => {
  const path = tmpStorePath();
  const ilk = openStore(path);
  ilk.run("INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t");
  ilk.close();
  const eski = new DatabaseSync(path);
  eski.exec("PRAGMA user_version = 0");
  eski.close();

  const yeni = openStore(path);
  assert.equal(yeni.get<{ user_version: number }>("PRAGMA user_version")?.user_version, SCHEMA_GENERATION);
  assert.equal(yeni.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")?.n, 1, "göç veri kaybetti");
  yeni.close();
  assert.equal(journalMode(path), "wal", "kabul edilen depo WAL'a alınmadı");
});

test("varyant: kuşağı EŞİT depo reddedilmiyor ve WAL'a alınıyor", () => {
  const path = tmpStorePath();
  const ilk = openStore(path);
  ilk.close();
  const yeni = openStore(path); // user_version zaten SCHEMA_GENERATION
  assert.equal(yeni.get<{ user_version: number }>("PRAGMA user_version")?.user_version, SCHEMA_GENERATION);
  yeni.close();
  assert.equal(journalMode(path), "wal");
});
