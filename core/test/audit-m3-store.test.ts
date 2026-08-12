// M3 denetiminin depo/kilit tarafındaki bulguları. Her test bir PROBE'un
// iddiasını kalıcılaştırıyor: probe dosyaları .delegate-runs altında geçici,
// buradaki iddialar takımda kalıcı.
//
// NOT: kilidin DEVRALMA sözleşmesi (kalp atışı) artık lock-heartbeat.test.ts'te.
// Buradaki kilit testleri yalnız devralmadan BAĞIMSIZ olanlar: uzun tutmanın
// görünürlüğü ve meşgul hâlinin sunumu.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { openStore } from "../src/store/db.ts";
import { acquireScanLock, releaseScanLock, renewScanLock, newLockHolder, ScanLockBusy } from "../src/store/lock.ts";
import { tmpDir, tmpStorePath } from "./helpers.ts";

// --- 1) meşgul kilit: sunum ve tekrar deneme --------------------------------

test("ölü sahibin bıraktığı satır yeniden denemeyi SÜRESİZ engellemez", () => {
  // Ctrl-C'de `finally` koşmuyor ve kilit satırı diskte kalıyor. Eski modelde
  // bu satır "sahip PID'si canlı mı" tahminiyle çözülüyordu; artık ölçüt tek:
  // atış kesildiyse devralınır. Ölü bir sahip tanım gereği atmaz.
  const store = openStore(":memory:");
  const olu = newLockHolder();
  acquireScanLock(store, olu);
  // Sahibin öldüğü ana denk gelen hâl: satır duruyor, atış donmuş.
  store.run("UPDATE scan_lock SET heartbeat_at = ? WHERE id = 1",
    new Date(Date.now() - 11 * 60_000).toISOString());

  const yeni = newLockHolder();
  assert.doesNotThrow(() => acquireScanLock(store, yeni), "ölü sahip yeniden denemeyi engelliyor");
  assert.equal(store.get<{ holder: string }>("SELECT holder FROM scan_lock WHERE id = 1")?.holder, yeni);
  const ev = store.get<{ detail: string }>("SELECT detail FROM events WHERE kind = 'scan_lock_stolen'");
  assert.ok(ev, "devralma sessiz olmamalı");
  assert.equal(JSON.parse(ev.detail).reason, "heartbeat_stale");
  store.close();
});

test("kilidi alan süreç onu bırakabilir", () => {
  const store = openStore(":memory:");
  const holder = newLockHolder();
  acquireScanLock(store, holder);
  releaseScanLock(store, holder);
  assert.equal(store.get("SELECT holder FROM scan_lock WHERE id = 1"), undefined);
  store.close();
});

test("taze kilit devralınamaz (kilidin asıl işi)", () => {
  const store = openStore(":memory:");
  const holder = newLockHolder();
  acquireScanLock(store, holder);
  assert.throws(() => acquireScanLock(store, newLockHolder()), ScanLockBusy);
  releaseScanLock(store, holder);
  store.close();
});

// --- 2) uzun tutulan kilit görünür -------------------------------------------

/** Kilidi geriye tarihlemek: uzun-tutma ölçüsü `acquired_at`, bayatlık DEĞİL. */
function backdateAcquired(store: ReturnType<typeof openStore>, ms: number): void {
  store.run("UPDATE scan_lock SET acquired_at = ? WHERE id = 1", new Date(Date.now() - ms).toISOString());
}

const HOUR = 60 * 60 * 1000;

test("çok uzun tutulan CANLI kilit: devralma YOK ama olay VAR", () => {
  // Sahip düzenli atıyor, yani meşru. Ama yedi saattir kilidi tutuyorsa ya
  // asılmış ya da gerçekten çok uzun bir denetim koşuyor: ikisi de bakılmayı
  // hak ediyor. Kilit ÇALINMIYOR — görünür kılınıyor.
  const store = openStore(":memory:");
  const holder = newLockHolder();
  acquireScanLock(store, holder);
  backdateAcquired(store, 7 * HOUR); // LONG_HELD_MS = 6 saat
  assert.equal(renewScanLock(store, holder), true, "sahip canlı: atışı taze");

  assert.throws(() => acquireScanLock(store, newLockHolder()), ScanLockBusy,
    "uzun tutma kilidi ÇALDIRMAZ: atışı süren sahip meşru");
  assert.equal(store.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE kind = 'scan_lock_stolen'")?.n, 0, "devralma olmamalı");

  const ev = store.get<{ detail: string }>("SELECT detail FROM events WHERE kind = 'scan_lock_held_long'");
  assert.ok(ev, "takılı kalmış olabilecek kilit sessiz kalmamalı");
  const d = JSON.parse(ev.detail);
  assert.equal(d.holder, holder, "detay sahibi taşımalı");
  assert.ok(d.ageMs >= 7 * HOUR - 60_000, `yaş taşınmalı, gelen: ${d.ageMs}`);
  assert.equal(d.stolen, false, "devralınmadığı gerçeği detayda yazılı olmalı");

  releaseScanLock(store, holder);
  store.close();
});

test("uzun tutma olayı gürültü yapmaz: aynı kilit satırı için tek kayıt", () => {
  // Takılı bir kilide her tarama çarpar. Tekrar yazmak `events`'i geri
  // alınamaz şekilde şişirir ve sayacı "kaç kez takıldık" değil "kaç kez
  // denedik" ölçmeye başlar.
  const store = openStore(":memory:");
  const holder = newLockHolder();
  acquireScanLock(store, holder);
  backdateAcquired(store, 7 * HOUR);
  for (let i = 0; i < 3; i++) {
    assert.throws(() => acquireScanLock(store, newLockHolder()), ScanLockBusy);
  }
  assert.equal(store.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE kind = 'scan_lock_held_long'")?.n, 1);

  // Kilit bırakılıp YENİDEN alınırsa bu başka bir takılmadır: susmak,
  // ikinci arızayı birincinin arkasına gizlemek olurdu.
  releaseScanLock(store, holder);
  acquireScanLock(store, holder);
  // 8 saat, 7 değil: `acquired_at` ms çözünürlüklü ve aynı milisaniyede yeniden
  // tarihlenirse dize BİREBİR aynı çıkar — test tekilleştirmeyi kırık sanardı.
  backdateAcquired(store, 8 * HOUR);
  assert.throws(() => acquireScanLock(store, newLockHolder()), ScanLockBusy);
  assert.equal(store.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE kind = 'scan_lock_held_long'")?.n, 2);
  releaseScanLock(store, holder);
  store.close();
});

test("eşik bayatlama süresinden ÇOK büyük: iki saatlik sağlıklı denetim olay yazmaz", () => {
  // HEARTBEAT_STALE_MS (10 dk) üstü ama LONG_HELD_MS (6 saat) altı. Eşik
  // bayatlığa yakın seçilseydi olay her uzun denetimde yanar, gürültüye karışır
  // ve "birine bak" sinyali olmaktan çıkardı.
  const store = openStore(":memory:");
  const holder = newLockHolder();
  acquireScanLock(store, holder);
  backdateAcquired(store, 2 * HOUR);
  assert.throws(() => acquireScanLock(store, newLockHolder()), ScanLockBusy);
  assert.equal(store.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE kind = 'scan_lock_held_long'")?.n, 0);
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
