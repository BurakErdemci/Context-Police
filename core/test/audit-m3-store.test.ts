// M3 denetiminin depo/kilit tarafındaki bulguları. Her test bir PROBE'un
// iddiasını kalıcılaştırıyor: probe dosyaları .delegate-runs altında geçici,
// buradaki iddialar takımda kalıcı.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { openStore } from "../src/store/db.ts";
import { acquireScanLock, releaseScanLock, ScanLockBusy, stampHolderIdentity } from "../src/store/lock.ts";
import { tmpDir, tmpStorePath } from "./helpers.ts";

// --- 1) ölü sahip kilidi: hemen devralınmalı (dead-lock-blocks-retry) ---

/** Var olmayan bir PID. process.kill(pid,0) ESRCH atmalı; atmıyorsa test yanılır. */
const DEAD_PID = 99999999;

test("ölü sahip kilidi TAZE damgayla bile hemen devralınır", () => {
  assert.throws(() => process.kill(DEAD_PID, 0), /ESRCH/, "ölü PID seçimi geçersiz");

  const store = openStore(":memory:");
  // Ctrl-C sonrası finally koşmadığında diskte kalan satırın birebir hâli:
  // sahip ölmüş ama damga yepyeni.
  store.run(
    "INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)",
    `pid:${DEAD_PID}`,
    new Date().toISOString(),
  );

  const holder = `pid:${process.pid}`;
  assert.doesNotThrow(() => acquireScanLock(store, holder), "ölü sahip yeniden denemeyi bir saat engelliyor");
  // Diskteki sahip dizesi ARTIK kimlik damgalı (PID + süreç başlangıç zamanı):
  // acquireScanLock damgayı kendisi basıyor, çağıranın holder'ı ham kalıyor.
  assert.equal(
    store.get<{ holder: string }>("SELECT holder FROM scan_lock WHERE id = 1")?.holder,
    stampHolderIdentity(holder),
  );

  const ev = store.get<{ detail: string }>("SELECT detail FROM events WHERE kind = 'scan_lock_stolen'");
  assert.ok(ev, "devralma sessiz olmamalı");
  assert.equal(JSON.parse(ev.detail).reason, "dead_holder");
  store.close();
});

// --- 2) geri dönüştürülmüş PID (pid-alias-keeps-stale-lock) ---

test("kimliği DAMGASIZ, canlı PID'li kilit STALE_MS'ten sonra devralınır", () => {
  const store = openStore(":memory:");
  // Bu süreç kilidi ALMADI; canlı PID'si, sahibi öldükten sonra aynı numarayı
  // devralan yabancı bir sürecin yerine geçiyor. Satır damgasız (yabancı/eski
  // bir yazıcı): kimlik doğrulanamaz, geriye tek ölçüt olarak yaş kalır.
  store.run(
    "INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)",
    `pid:${process.pid}`,
    "2000-01-01T00:00:00.000Z",
  );

  assert.doesNotThrow(
    () => acquireScanLock(store, "pid:999999999"),
    "yaş kontrolü canlı PID tarafından kısa devre ediliyor: kilit süresiz",
  );
  const ev = store.get<{ detail: string }>("SELECT detail FROM events WHERE kind = 'scan_lock_stolen'");
  // Gerekçe AYRIK: bu devralma "yaşlandı" değil "kimliği ölçemedim, yaşa düştüm"
  // demek. Ayrı isim, düşüşün kaç kez olduğunu günlükten ölçülebilir kılıyor.
  assert.equal(JSON.parse(ev!.detail).reason, "identity_unverifiable_stale_age");
  store.close();
});

test("okunamayan damga süresiz tutma hakkı vermez", () => {
  const store = openStore(":memory:");
  store.run("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)", `pid:${process.pid}`, "bozuk-damga");
  assert.doesNotThrow(() => acquireScanLock(store, "pid:999999999"));
  store.close();
});

// --- 2b) kimlik = PID + süreç başlangıç zamanı (live-lock-stolen-after-hour) ---

test("SAĞLIKLI ve uzun süren sahip kilidini bir saat sonra da kaybetmez", () => {
  const store = openStore(":memory:");
  const holder = `pid:${process.pid}`;
  acquireScanLock(store, holder); // damgayı acquire basıyor: kimlik doğrulanabilir
  // 61 dakika: eski mantıkta yaş TEK BAŞINA devralma yetkisiydi ve kilit
  // çalınıyordu — iki sağlıklı yazıcı üst üste biniyor, mükerrer teslimat
  // yarışı geri geliyordu (ölçüldü, doğrulama turu).
  store.run("UPDATE scan_lock SET acquired_at = ? WHERE id = 1",
    new Date(Date.now() - 61 * 60 * 1000).toISOString());

  assert.throws(() => acquireScanLock(store, "pid:99999999"), ScanLockBusy,
    "kimliği doğrulanmış CANLI sahibin kilidi yaşı ne olursa olsun çalınamaz");
  assert.equal(store.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE kind = 'scan_lock_stolen'")?.n, 0);
  releaseScanLock(store, holder);
  store.close();
});

test("geri dönüştürülmüş PID: kayıttaki başlangıç zamanı tutmazsa hemen devralınır", () => {
  const store = openStore(":memory:");
  // Canlı PID (bu süreç) ama BAŞKA bir başlangıç zamanı: eski sahip ölmüş,
  // numarası yeniden kullanılmış. Yaş TAZE — yine de beklenmez.
  store.run(
    "INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)",
    `pid:${process.pid}@started:Thu Jan  1 00:00:00 1970`,
    new Date().toISOString(),
  );
  assert.doesNotThrow(() => acquireScanLock(store, "pid:999999999"));
  const ev = store.get<{ detail: string }>("SELECT detail FROM events WHERE kind = 'scan_lock_stolen'");
  assert.equal(JSON.parse(ev!.detail).reason, "pid_reused");
  store.close();
});

test("kimliği hiç ölçülemeyen sahip: taze kilit korunur, yaşlı kilit devralınır", () => {
  // Tanımadığımız holder biçimi = başlangıç zamanının hiç ölçülemediği durumun
  // deterministik karşılığı (paylaşılan depo, farklı makine, `ps` yok). Yaşa
  // düşülür ama SIRALAMA korunur: taze kilit hâlâ dokunulmaz.
  const fresh = openStore(":memory:");
  fresh.run("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)",
    "worker-baska-makine", new Date().toISOString());
  assert.throws(() => acquireScanLock(fresh, "pid:999999999"), ScanLockBusy);
  fresh.close();

  const old = openStore(":memory:");
  old.run("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)",
    "worker-baska-makine", "2000-01-01T00:00:00.000Z");
  assert.doesNotThrow(() => acquireScanLock(old, "pid:999999999"));
  const ev = old.get<{ detail: string }>("SELECT detail FROM events WHERE kind = 'scan_lock_stolen'");
  assert.equal(JSON.parse(ev!.detail).reason, "identity_unverifiable_stale_age");
  old.close();
});

test("kilidi alan süreç onu bırakabilir: damga release'te yeniden üretilir", () => {
  // Damga acquire'da basılıyor, çağıran ham holder tutuyor. Release sahip
  // eşleşmesiyle siliyor: biçimler ayrışırsa kendi kilidimizi bırakamazdık ve
  // satır bir saat diskte kalırdı.
  const store = openStore(":memory:");
  const holder = `pid:${process.pid}`;
  acquireScanLock(store, holder);
  releaseScanLock(store, holder);
  assert.equal(store.get("SELECT holder FROM scan_lock WHERE id = 1"), undefined);
  store.close();
});

test("canlı sahip + taze kilit hâlâ devralınamaz (kilidin asıl işi)", () => {
  const store = openStore(":memory:");
  const holder = `pid:${process.pid}`;
  acquireScanLock(store, holder);
  assert.throws(() => acquireScanLock(store, "pid:999999999"), ScanLockBusy);
  releaseScanLock(store, holder);
  store.close();
});

// --- 3) eşzamanlı yazıcı (startup-does-not-wait-for-writer) ---

test("busy timeout ayarlı: açılış eşzamanlı yazıcıyı bekler, anında düşmez", async (t) => {
  const path = tmpStorePath();
  const held = 500;

  // Yazıcı AYRI SÜREÇTE olmak zorunda: aynı süreçte SQLite'ın bekleme döngüsü
  // event loop'u bloke ederdi ve kilidi bırakacak zamanlayıcı hiç ateşlenmezdi.
  const writer = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(path)});
       db.exec("CREATE TABLE onceden (x)");
       db.exec("BEGIN IMMEDIATE");
       db.exec("INSERT INTO onceden VALUES (1)");
       process.stdout.write("held\\n");
       setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, ${held});`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => writer.kill("SIGKILL"));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("yazıcı kilidi alamadı")), 5000);
    writer.stdout.setEncoding("utf8");
    writer.stdout.on("data", (d: string) => {
      if (d.includes("held")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const t0 = Date.now();
  const store = openStore(path); // senkron: yazıcı bırakana kadar bloke olmalı
  const waited = Date.now() - t0;
  assert.ok(waited >= held / 2, `açılış beklemedi (${waited} ms) — busy timeout yok`);
  assert.equal(Number(store.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout) > 0, true);
  store.close();
});

// --- 4) üst dizin izinleri (store-parent-chmod) ---

test("var olan üst dizinin izinlerine dokunulmaz, gevşekse uyarılır", () => {
  const parent = join(tmpDir(), "var-olan");
  mkdirSync(parent, { mode: 0o755 });
  assert.equal(statSync(parent).mode & 0o777, 0o755, "test kurulumu 0755 dizin yaratamadı");

  const uyarilar: string[] = [];
  const eski = console.warn;
  console.warn = (...a: unknown[]) => void uyarilar.push(a.join(" "));
  try {
    const store = openStore(join(parent, "store.db"));
    store.close();
  } finally {
    console.warn = eski;
  }

  assert.equal(statSync(parent).mode & 0o777, 0o755, "bize ait olmayan dizinin izinleri değiştirildi");
  assert.ok(uyarilar.some((u) => u.includes(parent)), "gevşek dizin sessizce kabul edildi");
});

test("bizim yarattığımız dizin 0700 kalır, depo dosyaları 0600", () => {
  const path = join(tmpDir(), "yeni-alt-dizin", "store.db");
  const store = openStore(path);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  for (const f of [path, `${path}-wal`]) {
    if (existsSync(f)) assert.equal(statSync(f).mode & 0o777, 0o600, `${f} başkasına okunur`);
  }
  store.close();
});

// --- 5) append-only kapsamı (external-replace-bypasses-append-only) ---

function seedFinding(path: string): void {
  const store = openStore(path);
  store.run("INSERT INTO projects (id,path,adapter_id,transcript_dir) VALUES (1,'/p','a','/t')");
  store.run(
    "INSERT INTO findings (id,project_id,source,content,created_at,status,suspicion) VALUES (1,1,'observed','ÖZGÜN','2026-01-01','active',0)",
  );
  store.close();
}

test("recursive_triggers bu bağlantıda gerçekten açık (varsayılmıyor, ölçülüyor)", () => {
  const store = openStore(":memory:");
  assert.equal(Number(store.get<{ recursive_triggers: number }>("PRAGMA recursive_triggers")?.recursive_triggers), 1);
  store.close();
});

test("DIŞARIDAN açılan varsayılan bağlantı da INSERT OR REPLACE ile içeriği yeniden yazamaz", () => {
  const path = tmpStorePath();
  seedFinding(path);

  // openStore'un pragmaları bağlantı-yerel; bu bağlantı onları görmüyor.
  const disarisi = new DatabaseSync(path);
  assert.equal(Number((disarisi.prepare("PRAGMA recursive_triggers").get() as { recursive_triggers: number }).recursive_triggers), 0);
  assert.throws(
    () =>
      disarisi.exec(
        "INSERT OR REPLACE INTO findings (id,project_id,source,content,created_at,status,suspicion) VALUES (1,1,'observed','ELE GEÇİRİLDİ','2026-01-01','active',0)",
      ),
    /append-only|silinemez|yasak/i,
  );
  assert.equal((disarisi.prepare("SELECT content FROM findings WHERE id=1").get() as { content: string }).content, "ÖZGÜN");
  disarisi.close();
});

test("VAR OLAN depoda eksik REPLACE koruması açılışta geri kuruluyor", () => {
  const path = tmpStorePath();
  seedFinding(path);

  // Düzeltmeden ÖNCE yaratılmış bir depoyu taklit et: korumayı dışarıdan düşür.
  const eski = new DatabaseSync(path);
  eski.exec("DROP TRIGGER IF EXISTS findings_no_replace");
  eski.exec("DROP TRIGGER IF EXISTS events_no_replace");
  eski.close();

  const store = openStore(path); // göç yolu: var olan dosya üzerinde
  const triggers = store
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='trigger'")
    .map((r) => r.name);
  assert.ok(triggers.includes("findings_no_replace"), "koruma var olan depoya geri kurulmadı");
  assert.ok(triggers.includes("events_no_replace"));
  assert.equal(store.get<{ content: string }>("SELECT content FROM findings WHERE id=1")?.content, "ÖZGÜN");
  store.close();

  const disarisi = new DatabaseSync(path);
  assert.throws(() =>
    disarisi.exec(
      "INSERT OR REPLACE INTO findings (id,project_id,source,content,created_at,status,suspicion) VALUES (1,1,'observed','ELE GEÇİRİLDİ','2026-01-01','active',0)",
    ),
  );
  disarisi.close();
});

test("REPLACE koruması normal eklemeyi engellemez", () => {
  const store = openStore(":memory:");
  store.run("INSERT INTO projects (id,path,adapter_id,transcript_dir) VALUES (1,'/p','a','/t')");
  for (let i = 0; i < 5; i++) {
    store.run(
      "INSERT INTO findings (project_id,source,content,created_at) VALUES (1,'observed',?,'2026-01-01')",
      `bulgu-${i}`,
    );
    store.run("INSERT INTO events (project_id, at, kind) VALUES (1,'2026-01-01','scan_started')");
  }
  assert.equal(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM findings")?.n, 5);
  assert.equal(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")?.n, 5);
  store.close();
});
