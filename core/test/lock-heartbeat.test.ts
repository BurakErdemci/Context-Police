// Kilit kimliğinin PID+`ps lstart` tahmininden KALP ATIŞI ölçümüne geçişi.
//
// Dört denetim turunda kilit dört ayrı biçimde kanadı (ölü sahip, PID yeniden
// kullanımı, yaş çalması, TZ kayması + host kimliği yokluğu + asılı `ps`) ve
// hepsinin kökü tekti: "sahip hâlâ çalışıyor mu" sorusu OS'ten okunan bir
// kimlik dizesiyle TAHMİN ediliyordu. Buradaki testler beşinci yamayı değil,
// tahmini ölçüme çeviren sözleşmeyi sabitliyor: sahip hayattaysa satırı tazeler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openStore, nowIso } from "../src/store/db.ts";
import {
  acquireScanLock,
  releaseScanLock,
  renewScanLock,
  withScanLock,
  newLockHolder,
  ScanLockBusy,
  ScanLockStolen,
  HEARTBEAT_STALE_MS,
} from "../src/store/lock.ts";
import { tmpStorePath } from "./helpers.ts";

/** Kilidin kalp atışını geriye tarihler: bayatlık ölçümünün TEK girdisi. */
function backdateHeartbeat(store: ReturnType<typeof openStore>, ms: number): void {
  store.run("UPDATE scan_lock SET heartbeat_at = ? WHERE id = 1", new Date(Date.now() - ms).toISOString());
}

// --- 1) bayatlık ölçütü yalnız kalp atışı ------------------------------------

test("tazelenmeyen kilit devralınır, tazelenen kilit devralınmaz", () => {
  const store = openStore(":memory:");
  const sahip = newLockHolder();
  acquireScanLock(store, sahip);

  // Taze: sahip az önce aldı, atışı yeni.
  assert.throws(() => acquireScanLock(store, newLockHolder()), ScanLockBusy,
    "kalp atışı taze bir kilit devralınamaz");

  // Bayat: sahip 11 dakikadır (≈22 kaçırılmış atış) hiçbir iz bırakmadı.
  backdateHeartbeat(store, HEARTBEAT_STALE_MS + 60_000);
  const devralan = newLockHolder();
  assert.doesNotThrow(() => acquireScanLock(store, devralan),
    "atışı kesilmiş sahip kilidi süresiz tutuyor");
  assert.equal(store.get<{ holder: string }>("SELECT holder FROM scan_lock WHERE id = 1")?.holder, devralan);

  const ev = store.get<{ detail: string }>("SELECT detail FROM events WHERE kind = 'scan_lock_stolen'");
  assert.ok(ev, "devralma sessiz olmamalı");
  const d = JSON.parse(ev.detail);
  assert.equal(d.reason, "heartbeat_stale");
  assert.equal(d.previousHolder, sahip);
  store.close();
});

test("kilidi TUTAN süreç saatlerce koşsa da tazeledikçe kaybetmez", () => {
  // Eski modelde yaş tek başına devralma yetkisiydi ve SAĞLIKLI uzun denetimin
  // kilidi 60 dakikada çalınıyordu. Yeni sözleşmede yaş devralma girdisi DEĞİL.
  const store = openStore(":memory:");
  const sahip = newLockHolder();
  acquireScanLock(store, sahip);
  store.run("UPDATE scan_lock SET acquired_at = ? WHERE id = 1",
    new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString()); // 9 saatlik denetim
  assert.equal(renewScanLock(store, sahip), true);

  assert.throws(() => acquireScanLock(store, newLockHolder()), ScanLockBusy,
    "atışı süren sahip yaşı yüzünden kilidini kaybetti");
  store.close();
});

test("okunamayan tazelik damgası süresiz tutma hakkı vermez", () => {
  const store = openStore(":memory:");
  store.run("INSERT INTO scan_lock (id, holder, acquired_at, heartbeat_at) VALUES (1,?,?,?)",
    "yabanci-yazici", "bozuk", "bozuk");
  assert.doesNotThrow(() => acquireScanLock(store, newLockHolder()));
  store.close();
});

test("heartbeat_at NULL olan eski kuşak satır acquired_at üzerinden ölçülür", () => {
  // Göç yolundan gelen satırlarda atış yok. Taze `acquired_at` KORUNUR (o an
  // koşan bir eski kuşak süreci olabilir), yaşlısı devralınır.
  const taze = openStore(":memory:");
  taze.run("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)", "eski-kusak", nowIso());
  assert.throws(() => acquireScanLock(taze, newLockHolder()), ScanLockBusy);
  taze.close();

  const yasli = openStore(":memory:");
  yasli.run("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)", "eski-kusak", "2000-01-01T00:00:00.000Z");
  assert.doesNotThrow(() => acquireScanLock(yasli, newLockHolder()));
  yasli.close();
});

// --- 2) tazeleme çalınmış kilidi DİRİLTMEZ -----------------------------------

test("renew çalınmış kilidi diriltmez: sahip eşleşmezse hiçbir satır yazılmaz", () => {
  const store = openStore(":memory:");
  const eski = newLockHolder();
  acquireScanLock(store, eski);
  backdateHeartbeat(store, HEARTBEAT_STALE_MS + 60_000);
  const yeni = newLockHolder();
  acquireScanLock(store, yeni); // devralındı

  assert.equal(renewScanLock(store, eski), false,
    "eski sahibin atışı yeni sahibin satırını tazeledi: iki yazar aynı anda kendini sahip sanır");
  assert.equal(store.get<{ holder: string }>("SELECT holder FROM scan_lock WHERE id = 1")?.holder, yeni);
  assert.equal(renewScanLock(store, yeni), true);
  store.close();
});

test("release yalnız kendi satırını siler", () => {
  const store = openStore(":memory:");
  const sahip = newLockHolder();
  acquireScanLock(store, sahip);
  releaseScanLock(store, "baskasi");
  assert.ok(store.get("SELECT holder FROM scan_lock WHERE id = 1"), "başkasının kilidi silindi");
  releaseScanLock(store, sahip);
  assert.equal(store.get("SELECT holder FROM scan_lock WHERE id = 1"), undefined);
  store.close();
});

// --- 3) withScanLock sarmalayıcısı -------------------------------------------

test("withScanLock: fn fırlatsa da kilit bırakılır ve zamanlayıcı durur", async () => {
  const store = openStore(":memory:");
  await assert.rejects(
    () => withScanLock(store, () => { throw new Error("patladı"); }),
    /patladı/,
  );
  assert.equal(store.get("SELECT holder FROM scan_lock WHERE id = 1"), undefined,
    "hata yolunda kilit asılı kaldı");

  // Zamanlayıcı gerçekten durdu mu? Süreç yaşamaya devam ediyorsa asılı bir
  // interval, sonraki sahibin satırını tazelemeye çalışırdı. Dolaylı ölçüm:
  // yeni bir sahip alsın, bir tur beklensin, atış değişmesin.
  const sahip = newLockHolder();
  acquireScanLock(store, sahip);
  const once = store.get<{ heartbeat_at: string }>("SELECT heartbeat_at FROM scan_lock WHERE id = 1")!.heartbeat_at;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.get<{ heartbeat_at: string }>("SELECT heartbeat_at FROM scan_lock WHERE id = 1")!.heartbeat_at, once);
  store.close();
});

test("withScanLock: normal dönüşte kilit bırakılır ve değer geçer", async () => {
  const store = openStore(":memory:");
  const out = await withScanLock(store, async () => {
    assert.ok(store.get("SELECT holder FROM scan_lock WHERE id = 1"), "gövde koşarken kilit tutulmalı");
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(store.get("SELECT holder FROM scan_lock WHERE id = 1"), undefined);
  store.close();
});

test("withScanLock: kilit elden gitmişse iş SESSİZCE başarılı sayılmaz", async () => {
  const store = openStore(":memory:");
  await assert.rejects(
    () =>
      withScanLock(
        store,
        async () => {
          // Sahip değişimini gövde koşarken taklit et: gerçekte bunu devralan
          // bir süreç yapar. Sonucu aynı — bizim yazımlarımız artık korumasız.
          store.run("UPDATE scan_lock SET holder = ? WHERE id = 1", "davetsiz");
          await new Promise((r) => setTimeout(r, 80)); // en az bir atış turu
          return "bitti";
        },
        { intervalMs: 20 },
      ),
    (err: unknown) => err instanceof ScanLockStolen,
    "kilidini kaybetmiş bir koşum başarıyla dönerse mükerrer teslimat sessizce geri gelir",
  );
  store.close();
});

test("withScanLock: sahip satırı gerçekten tazeleniyor", async () => {
  const store = openStore(":memory:");
  await withScanLock(
    store,
    async (lock) => {
      backdateHeartbeat(store, 5 * 60_000);
      const eski = store.get<{ heartbeat_at: string }>("SELECT heartbeat_at FROM scan_lock WHERE id = 1")!.heartbeat_at;
      await new Promise((r) => setTimeout(r, 40)); // aralık testte 20 ms
      const yeni = store.get<{ heartbeat_at: string }>("SELECT heartbeat_at FROM scan_lock WHERE id = 1")!.heartbeat_at;
      assert.notEqual(yeni, eski, "zamanlayıcı hiç ateşlenmedi: sahip canlıyken kilidi bayatlar");
      void lock;
    },
    { intervalMs: 20 },
  );
  store.close();
});

// --- 3b) bitişte SATIR okunur, bayrak yetmez ---------------------------------

test("atış hiç ateşlemeden devralınan koşum başarı dönemez", async () => {
  // Bağımsız çürütücü ölçtü (probe: completion-misses-takeover): 300 ms'lik
  // senkron iş sırasında SIFIR atış koşuyor, ve `await fn()` sonrası devam bir
  // mikro-görevken bekleyen atış makro-görev — yani bayrak kontrolü bekleyen
  // atıştan ÖNCE koşar. Bayrağa bakmak, her koşumun sonunda bir tam aralık
  // genişliğinde kör pencere bırakır. Satırı okumak bu pencereyi kapatır.
  const store = openStore(":memory:");
  await assert.rejects(
    () =>
      withScanLock(
        store,
        () => {
          store.run("UPDATE scan_lock SET heartbeat_at = ? WHERE id = 1", "2000-01-01T00:00:00.000Z");
          acquireScanLock(store, "davetsiz");
          return "bitti";
        },
        // Aralık bilerek işin süresinden UZUN: bayrak yolu hiç çalışmaz.
        { holder: "asil", intervalMs: 60_000 },
      ),
    (err: unknown) => err instanceof ScanLockStolen,
    "kilidi çalınmış koşum başarı döndü: mükerrer teslimat sessizce geri gelir",
  );
  store.close();
});

test("her tazeleme fırlatsa bile bitişteki satır okuması devralmayı yakalar", async () => {
  // Aynı kör pencerenin ikinci biçimi (probe: renew-error-hides-takeover):
  // atış koşuyor ama HER SEFERİNDE fırlıyor, dolayısıyla `stolen` bayrağı hiç
  // kurulmuyor. Bitişteki okuma bayraktan bağımsız olduğu için bu biçimi de
  // kapatır — yamayı iki kez yazmaya gerek kalmıyor.
  const base = openStore(":memory:");
  const atisiBozuk = {
    ...base,
    run(sql: string, ...params: Parameters<typeof base.run>[1][]) {
      if (sql.startsWith("UPDATE scan_lock SET heartbeat_at")) throw new Error("atış yazılamadı");
      return base.run(sql, ...params);
    },
  };
  await assert.rejects(
    () =>
      withScanLock(
        atisiBozuk,
        async () => {
          await new Promise((r) => setTimeout(r, 30));
          base.run("UPDATE scan_lock SET heartbeat_at = ? WHERE id = 1", "2000-01-01T00:00:00.000Z");
          acquireScanLock(base, "davetsiz");
          await new Promise((r) => setTimeout(r, 30));
          return "bitti";
        },
        { holder: "asil", intervalMs: 10 },
      ),
    (err: unknown) => err instanceof ScanLockStolen,
  );
  base.close();
});

test("sahiplik OKUNAMIYORSA koşum başarılı sayılmaz", () => {
  // "Doğrulayamadım" ile "sahibim" aynı şey değil. Kilidin var olma sebebi
  // korumasız yazım yapmamak; kanıtı olmayan bir sahiplik iddiası koruma değil.
  const base = openStore(":memory:");
  let bozuk = false; // alım okuması geçsin; bozulma İŞ BİTTİKTEN sonra
  const okumasiBozuk = {
    ...base,
    get<T>(sql: string, ...params: Parameters<typeof base.get>[1][]) {
      if (bozuk) throw new Error("satır okunamadı");
      return base.get<T>(sql, ...params);
    },
  };
  return assert.rejects(
    () => withScanLock(okumasiBozuk, () => { bozuk = true; return "bitti"; }, { holder: "asil" }),
    (err: unknown) => err instanceof ScanLockStolen && err.reason === "unverifiable",
  ).finally(() => { bozuk = false; base.close(); });
});

test("yutulan tazeleme hataları olay olarak görünür kalır", async () => {
  // Zamanlayıcı geri çağırımında fırlatmak süreci öldürür, o yüzden hata
  // yutuluyor (gerekçe lock.ts'te). Ama sessizlik ayrı bir kalem: atışı hiç
  // yazılamamış bir koşum, bir dahaki sefere neden devralındığını açıklayabilir
  // bir iz bırakmadan bitiyordu.
  const base = openStore(":memory:");
  const atisiBozuk = {
    ...base,
    run(sql: string, ...params: Parameters<typeof base.run>[1][]) {
      if (sql.startsWith("UPDATE scan_lock SET heartbeat_at")) throw new Error("atış yazılamadı");
      return base.run(sql, ...params);
    },
  };
  await withScanLock(atisiBozuk, async () => { await new Promise((r) => setTimeout(r, 40)); }, { intervalMs: 10 });
  const ev = base.get<{ detail: string }>(
    "SELECT detail FROM events WHERE kind = 'scan_lock_renew_failed' ORDER BY id DESC LIMIT 1",
  );
  assert.ok(ev, "tazeleme hataları hiçbir iz bırakmadı");
  assert.ok(JSON.parse(ev.detail).failures >= 1);
  base.close();
});

test("kilidi kendi eliyle bırakıp devam eden iş de başarı sayılmaz", async () => {
  // Bitişteki satır okumasının bilinçli yan etkisi. Bırakma anından sonraki
  // yazımlar korumasız olduğu için reddetmek DOĞRU; sürpriz olmaması için
  // sabitleniyor. Gerekirse çözüm bu kontrolü gevşetmek değil, kilidi işin
  // gerçek sonunda bırakmak.
  const store = openStore(":memory:");
  await assert.rejects(
    () => withScanLock(store, (lock) => { lock.release(); return "bitti"; }),
    (err: unknown) => err instanceof ScanLockStolen && err.reason === "holder_changed",
  );
  store.close();
});

// --- 3c) temizlik hatası özgün hatayı EZMEZ ----------------------------------

test("bırakma hatası işin özgün hatasını ezmez", async () => {
  const base = openStore(":memory:");
  const birakmasiBozuk = {
    ...base,
    run(sql: string, ...params: Parameters<typeof base.run>[1][]) {
      if (sql.startsWith("DELETE FROM scan_lock")) throw new Error("bırakma patladı");
      return base.run(sql, ...params);
    },
  };
  const err = await withScanLock(birakmasiBozuk, () => { throw new Error("özgün iş hatası"); })
    .then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /özgün iş hatası/, "temizlik hatası teşhisi olan hatayı yuttu");
  assert.match(String((err as { releaseError?: Error }).releaseError?.message), /bırakma patladı/,
    "bırakma hatası tümden kayboldu: kilit satırı diskte kalmışken kimse bilmiyor");
  base.close();
});

test("iş başarılıyken bırakma hatası GÖRÜNÜR olur", async () => {
  // Ters karar da savunulabilirdi (yut, iş bitti). Yutulmuyor: kilit satırı
  // diskte kalmış demektir ve sonraki koşum bayatlama süresi (10 dk) boyunca
  // bekler. Maskeleyecek bir özgün hata da yok — bu hata TEK bilgi.
  const base = openStore(":memory:");
  const birakmasiBozuk = {
    ...base,
    run(sql: string, ...params: Parameters<typeof base.run>[1][]) {
      if (sql.startsWith("DELETE FROM scan_lock")) throw new Error("bırakma patladı");
      return base.run(sql, ...params);
    },
  };
  await assert.rejects(() => withScanLock(birakmasiBozuk, () => "bitti"), /bırakma patladı/);
  base.close();
});

// --- 3d) saat tutarsızlığı ---------------------------------------------------

test("GELECEKTEKİ atış damgası saat uyuşmazlığı olarak yazılır, kilit çalınmaz", () => {
  const store = openStore(":memory:");
  acquireScanLock(store, "uzak-sahip");
  // Sahibin saati bizimkinden ileri: yazdığı damga bizim şimdimizin ötesinde.
  store.run("UPDATE scan_lock SET heartbeat_at = ? WHERE id = 1", new Date(Date.now() + 3 * 60_000).toISOString());

  assert.throws(() => acquireScanLock(store, newLockHolder()), ScanLockBusy);
  const ev = store.all<{ detail: string }>("SELECT detail FROM events WHERE kind = 'scan_lock_clock_skew'");
  assert.equal(ev.length, 1, "gelecekteki damga sessiz kaldı: bayatlık ölçümü artık güvenilmez ve kimse bilmiyor");
  assert.ok(JSON.parse(ev[0]!.detail).skewMs > 60_000);

  // Gürültü engeli: aynı kilit satırına tekrar çarpmak olayı çoğaltmaz.
  assert.throws(() => acquireScanLock(store, newLockHolder()), ScanLockBusy);
  assert.equal(store.all("SELECT 1 FROM events WHERE kind = 'scan_lock_clock_skew'").length, 1);
  store.close();
});

// --- 4) göç: eski şemalı VAR OLAN depo ---------------------------------------

test("heartbeat_at'sız eski şemalı depo açılınca kolon gelir ve kilit alınabilir", () => {
  // CLAUDE.md §7: taze depoda çalışması kanıt değil. Dosya önce yaratılıp sonra
  // ELLE eski şemaya indiriliyor, göç var olan veri üstünde ölçülüyor.
  const path = tmpStorePath();
  const ilk = openStore(path);
  ilk.run("INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t");
  ilk.close();

  const eski = new DatabaseSync(path);
  eski.exec("DROP TABLE scan_lock");
  eski.exec(`CREATE TABLE scan_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holder TEXT NOT NULL,
    acquired_at TEXT NOT NULL
  )`);
  eski.exec("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,'pid:4242@started:eski','2000-01-01T00:00:00.000Z')");
  assert.equal(
    (eski.prepare("PRAGMA table_info(scan_lock)").all() as { name: string }[]).some((c) => c.name === "heartbeat_at"),
    false,
    "test kurulumu eski şemayı kuramadı",
  );
  eski.close();

  const yeni = openStore(path); // göç yolu: var olan dosya üzerinde
  assert.ok(
    yeni.all<{ name: string }>("PRAGMA table_info(scan_lock)").some((c) => c.name === "heartbeat_at"),
    "göç kolonu eklemedi: her kilit alımı 'no such column' ile patlar",
  );
  // Eski kuşak satırı bayat (atış yok, acquired_at 2000) → devralınabilir olmalı.
  const holder = newLockHolder();
  assert.doesNotThrow(() => acquireScanLock(yeni, holder));
  assert.ok(yeni.get<{ heartbeat_at: string | null }>("SELECT heartbeat_at FROM scan_lock WHERE id = 1")?.heartbeat_at);
  assert.equal(yeni.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")?.n, 1, "göç veri kaybetti");
  yeni.close();
});

// --- 5) eşzamanlı devralma: ham SQLite hatası sızmaz -------------------------

test("SQLITE_BUSY yarışı ScanLockBusy'ye çevrilir, ham depo hatası sızmaz", () => {
  const path = tmpStorePath();
  const kur = openStore(path);
  kur.run("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)", "bayat", "2000-01-01T00:00:00.000Z");
  kur.close();

  // İki devralıcı aynı anda: A okur, B okur+yazar+commit eder, A yazmaya
  // kalkınca SQLITE_BUSY_SNAPSHOT (errcode 517) alır. Kaybeden taraf "başkası
  // tarıyor" mesajı almalı — yığın izi değil.
  const a = openStore(path);
  const b = openStore(path);

  // Yarış deterministik kuruluyor: A'nın DEFERRED işlemi bir okuma anlık
  // görüntüsü alır, ARADA B devralıp commit eder, sonra A yazmaya kalkar.
  // Gerçek yarışta bu sıra %50 civarı üretiyordu (probe ölçümü); burada elle
  // dizilerek her koşumda üretilir.
  let hata: unknown;
  try {
    a.tx(() => {
      a.get("SELECT holder FROM scan_lock WHERE id = 1"); // anlık görüntü sabitlenir
      acquireScanLock(b, newLockHolder()); // B araya girer, devralır, commit eder
      acquireScanLock(a, newLockHolder()); // A yazmaya kalkar → SQLITE_BUSY
    });
  } catch (err) {
    hata = err;
  }
  assert.ok(hata instanceof ScanLockBusy,
    `kaybeden ham depo hatası aldı: ${hata instanceof Error ? `${hata.name}: ${hata.message}` : String(hata)}`);
  a.close();
  b.close();
});
