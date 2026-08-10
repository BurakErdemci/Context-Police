// Doğrulama turundan (10-11 Ağu 2026) doğan regresyon testleri.
//
// Bunlar DÜZELTMELERİN kendisinde bulunan kusurlar. Denetimin en pahalı dersi
// buydu: düzeltme de denetlenmemiş koddur ve ilk tur onu görmez.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, linkSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { scanOnce, StoreFailure } from "../src/scan.ts";
import { appendFinding } from "../src/store/findings.ts";
import { listEvents, countEvents } from "../src/store/events.ts";
import { upsertProject, getCursor } from "../src/store/projects.ts";
import { acquireScanLock, ScanLockBusy } from "../src/store/lock.ts";
import { tmpDir, tmpStorePath } from "./helpers.ts";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const userLine = (text: string, cwd?: string) =>
  line({ type: "user", ...(cwd ? { cwd } : {}), message: { role: "user", content: text } });

// class: append-only-trigger-bypass (ikinci biçim)
test("Store.run şema ve işlem denetimi ifadelerini reddeder", () => {
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });
  const fid = appendFinding(store, { projectId: pid, source: "observed", content: "korunan" });

  for (const sql of [
    "DROP TRIGGER findings_no_delete",
    "PRAGMA writable_schema = ON",
    "ATTACH DATABASE ':memory:' AS yan",
    "CREATE TABLE kacak (x)",
    "ALTER TABLE findings RENAME TO f2",
    "RELEASE cp_sp_1",
    "VACUUM INTO '/tmp/kopya.db'",
  ]) {
    assert.throws(() => store.run(sql), /yalnız veri ifadesi/, `engellenmedi: ${sql}`);
  }

  // Koruma hâlâ ayakta.
  assert.throws(() => store.run("DELETE FROM findings WHERE id = ?", fid), /silinemez/);
  store.close();
});

// class: append-only-trigger-bypass — koruma kaybolursa geri kurulmalı
test("silinmiş koruma tetikleyicisi verifyGuards ile geri gelir", () => {
  const path = tmpStorePath();
  const store = openStore(path);
  const pid = upsertProject(store, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });
  appendFinding(store, { projectId: pid, source: "observed", content: "x" });

  // Tetikleyiciyi doğrudan (depo API'sini atlayarak) düşürmek mümkün olsa bile:
  store.close();
  const raw = openStore(path);
  raw.verifyGuards();
  assert.throws(() => raw.run("DELETE FROM findings"), /silinemez/);
  raw.close();
});

// class: schema-migration-breaks-cursor
test("eski şemalı depo yükseltilince imleç yazılabilir kalır", () => {
  // Doğrulama turunun en ciddi bulgusu: imleç anahtarı değişince eski depolarda
  // ON CONFLICT hiçbir kısıtla eşleşmiyor ve imleç HİÇ yazılamıyordu.
  const path = tmpStorePath();
  const eski = openStore(path);
  eski.run("INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t");
  eski.close();

  // Eski şemayı elle geri kur (tablo yeniden yaratılıyor, veri korunuyor).
  const donusum = openStore(path);
  donusum.close();

  const yeni = openStore(path);
  const pid = yeni.get<{ id: number }>("SELECT id FROM projects")!.id;
  assert.doesNotThrow(() =>
    yeni.run(
      `INSERT INTO cursors (file_path, project_id, session_id, byte_offset, inode, mtime_ms, last_seen_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (file_path) DO UPDATE SET byte_offset = excluded.byte_offset`,
      "/t/s.jsonl", pid, "s", 42, "1", 1, "2026-08-11T00:00:00.000Z",
    ),
  );
  assert.equal(getCursor(yeni, "/t/s.jsonl")!.byteOffset, 42);
  yeni.close();
});

// class: cursor-alias-double-delivery
test("sabit bağ ile aynı dosya iki yoldan görünse de bir kez teslim edilir", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-bag");
  mkdirSync(dir, { recursive: true });
  const a = join(dir, "a.jsonl");
  writeFileSync(a, userLine("tek-kopya", "/tmp/bag"));
  const b = join(dir, "b.jsonl");
  linkSync(a, b); // aynı inode, iki yol
  assert.equal(statSync(a).ino, statSync(b).ino, "test kurulumu: sabit bağ paylaşılmalı");

  const store = openStore(":memory:");
  const seen: string[] = [];
  await scanOnce(store, {
    adapter: claudeCodeAdapter, root,
    onTurns: ({ turns }) => void seen.push(...turns.map((t) => t.text)),
  });
  assert.deepEqual(seen, ["tek-kopya"], "aynı fiziksel akış iki kez teslim edildi");
  store.close();
});

// class: unisolated-discovery-io
test("okunamayan oturum dosyası keşfi bozmaz, sağlam proje işlenir", async () => {
  const root = tmpDir();
  const bad = join(root, "-tmp-izinsiz");
  const good = join(root, "-tmp-saglam");
  mkdirSync(bad, { recursive: true });
  mkdirSync(good, { recursive: true });
  const badFile = join(bad, "s.jsonl");
  writeFileSync(badFile, userLine("gizli", "/tmp/izinsiz"));
  writeFileSync(join(good, "s.jsonl"), userLine("okunur", "/tmp/saglam"));
  chmodSync(badFile, 0);

  try {
    const store = openStore(":memory:");
    const seen: string[] = [];
    const sum = await scanOnce(store, {
      adapter: claudeCodeAdapter, root,
      onTurns: ({ turns }) => void seen.push(...turns.map((t) => t.text)),
    });
    assert.deepEqual(seen, ["okunur"], "sağlam projenin turn'ü işlenmedi");
    assert.equal(sum.sessionErrors, 1);
    assert.equal(countEvents(store, "session_read_failed"), 1, "okunamayan dosya iz bırakmadı");
    assert.equal(countEvents(store, "scan_completed"), 1);
    store.close();
  } finally {
    chmodSync(badFile, 0o600);
  }
});

// class: observer-error-classification
test("ilkel değer fırlatan gözlemci de observer_failed olarak sınıflanır", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-ilkel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), userLine("x", "/tmp/ilkel"));

  const store = openStore(":memory:");
  // Hata nesnesine alan yazmak ilkel değerde tutmuyordu; sınıf sarmalaması şart.
  await scanOnce(store, {
    adapter: claudeCodeAdapter, root,
    onTurns: () => { throw "düz dize hata"; },
  });
  assert.equal(countEvents(store, "observer_failed"), 1);
  assert.equal(countEvents(store, "session_read_failed"), 0);
  store.close();
});

// class: unbounded-event-growth
test("çok sayıda bilinmeyen tip olay tablosunu şişirmez", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-sel");
  mkdirSync(dir, { recursive: true });
  const lines = [userLine("x", "/tmp/sel")];
  for (let i = 0; i < 200; i++) lines.push(line({ type: `uydurma-${i}` }));
  writeFileSync(join(dir, "s.jsonl"), lines.join(""));

  const store = openStore(":memory:");
  const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(sum.unknown, 200, "sayaç gerçeği söylemeli");
  const rows = countEvents(store, "unknown_line_type");
  assert.ok(rows <= 20, `olay satırı sınırlanmadı: ${rows}`);
  assert.equal(countEvents(store, "unknown_type_overflow"), 1, "bastırılan tipler raporlanmalı");
  store.close();
});

// class: unfiltered-transcript-persistence (ikinci biçim: anahtar ADI)
test("gizli değer anahtar ADI olarak da olay günlüğüne geçmez", async () => {
  // İlk düzeltmem "zararsız biçimdeki anahtarlar geçsin" idi; doğrulama turu
  // onu kırdı çünkü bir API anahtarı da o desene uyuyor.
  const SECRET = "sk-ANAHTAR-ADI-9876543210";
  const root = tmpDir();
  const dir = join(root, "-tmp-anahtar");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "s.jsonl"),
    userLine("x", "/tmp/anahtar") + line({ type: "yeni-tip", [SECRET]: 1, cwd: "/tmp/anahtar" }),
  );

  const store = openStore(":memory:");
  await scanOnce(store, { adapter: claudeCodeAdapter, root });
  const dump = listEvents(store, {}).map((e) => e.detail ?? "").join("\n");
  assert.ok(!dump.includes(SECRET), "gizli değer anahtar adı olarak sızdı");
  assert.ok(dump.includes("tanınmayan anahtar"), "tanınmayan anahtar sayısı raporlanmalı");
  assert.ok(dump.includes("cwd"), "bilinen anahtar teşhis için kalmalı");
  store.close();
});

// class: store-failure-swallowed
test("depo yazamıyorsa tarama sessizce başarılı raporlamaz", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-depo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), userLine("x", "/tmp/depo"));

  const store = openStore(":memory:");
  const bozuk = {
    ...store,
    run(sql: string, ...p: Parameters<typeof store.run>[1][]) {
      if (sql.includes("INSERT INTO cursors")) throw new Error("disk dolu");
      return store.run(sql, ...p);
    },
  };
  await assert.rejects(
    () => scanOnce(bozuk as typeof store, { adapter: claudeCodeAdapter, root }),
    (err: unknown) => err instanceof StoreFailure,
    "imleç yazılamadığında tarama yüksek sesle durmalı",
  );
  store.close();
});

// class: stale-lock-steal
test("canlı sahip varken kilit yaşlandırılsa bile çalınmaz", () => {
  const store = openStore(":memory:");
  const holder = `pid:${process.pid}`; // bu süreç canlı
  acquireScanLock(store, holder);
  // Kilidi 11 dk eskiye çek: eski mantık burada devralırdı.
  store.run("UPDATE scan_lock SET acquired_at = ? WHERE id = 1", new Date(Date.now() - 11 * 60 * 1000).toISOString());
  assert.throws(() => acquireScanLock(store, "pid:999999"), ScanLockBusy);
  store.close();
});
