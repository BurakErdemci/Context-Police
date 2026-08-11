// M2 2. DOĞRULAMA TURU — Codex red team'in düzeltmelerin ÜSTÜNDE bulduğu
// kusurların kalıcı testleri. Her testin başlığında bulgunun class'ı var;
// her biri bir prob'un iddiasını (probes/*.sh) yeniden koşulabilir hâle getirir.
//
// Prob geçici, test kalıcı: prob bir turda bir kez koşar, test her `npm test`te.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { openStore } from "../src/store/db.ts";
import { getWatermark, setWatermark } from "../src/store/watermarks.ts";
import { parseObserverOutput } from "../src/observer/prompt.ts";
import { dropThroughWatermarkDetailed } from "../src/observer/batch.ts";
import { Observer } from "../src/observer/observer.ts";
import { upsertProject } from "../src/store/projects.ts";
import { countEvents, listEvents } from "../src/store/events.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";
import type { Turn } from "../src/types.ts";

const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");

// --- class: non-atomic-schema-migration ---

/** Eski (last_ts'siz, last_uuid NOT NULL) filigran şemalı bir depo dosyası. */
function legacyStore(rows: number): string {
  const path = join(tmpDir("cp-v2-migration-"), "store.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, adapter_id TEXT NOT NULL,
      transcript_dir TEXT NOT NULL, memory_dir TEXT, last_scanned_at TEXT
    );
    INSERT INTO projects (id, path, adapter_id, transcript_dir) VALUES (1, '/p', 'claude-code', '/t');
    CREATE TABLE observer_watermarks (
      project_id INTEGER NOT NULL REFERENCES projects(id), session_id TEXT NOT NULL,
      last_uuid TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
  `);
  const ins = db.prepare("INSERT INTO observer_watermarks VALUES (1, ?, ?, ?)");
  for (let i = 0; i < rows; i++) ins.run(`s${i}`, `u${i}`, "2026-08-10T00:00:00.000Z");
  db.close();
  return path;
}

/** Depoyu açıp satır sayısını ve uuid'siz checkpoint yazılabilirliğini ölçer. */
function assertUsable(path: string, expectedRows: number, mesaj: string): void {
  const store = openStore(path);
  try {
    assert.equal(
      store.get<{ n: number }>("SELECT COUNT(*) n FROM observer_watermarks")?.n,
      expectedRows,
      `${mesaj}: filigran satırları korunmadı`,
    );
    setWatermark(store, {
      projectId: 1, sessionId: "yalniz-damga", lastUuid: null, lastTs: "2026-08-11T00:00:00.000Z",
    });
    assert.equal(
      getWatermark(store, 1, "yalniz-damga")?.lastTs,
      "2026-08-11T00:00:00.000Z",
      `${mesaj}: göç sonrası tablo yazılabilir değil`,
    );
  } finally {
    store.close();
  }
}

test("[non-atomic-schema-migration] göç tek işlemde: yarım şema DİSKTE kalamaz", () => {
  // Eski hâlde dört DDL ifadesi ayrı ayrı otomatik commit ediliyordu. Prob
  // (interrupted-watermark-migration.sh) göçün ortasında süreci SIGKILL ile
  // öldürüp depoyu `table observer_watermarks_migrated already exists` ile
  // AÇILAMAZ hâle getirdi. Burada aynı iddia süreç öldürmeden ölçülüyor: göç
  // BİTTİKTEN sonra ara tablodan eser kalmamalı ve veri tam olmalı.
  const path = legacyStore(50);
  assertUsable(path, 50, "normal göç");

  const db = new DatabaseSync(path, { readOnly: true });
  const kalan = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_migrated'",
  ).all() as { name: string }[];
  db.close();
  assert.deepEqual(kalan, [], "göç ara tablosu diskte bırakılmış");
});

test("[non-atomic-schema-migration] ESKİ sürümün bıraktığı yarım göç kendiliğinden toparlanıyor", () => {
  // Tek işlem bugünden sonrasını kurtarır; DİSKTE DURAN bozuk depo hâlâ
  // açılabilmeli. Kesintinin üç ayrı anı, üç ayrı kalıntı durumu üretiyor.

  // (a) CREATE'ten sonra kesinti: ara tablo BOŞ, hedef tam.
  {
    const path = legacyStore(20);
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE observer_watermarks_migrated (project_id INTEGER, session_id TEXT, last_uuid TEXT, last_ts TEXT, updated_at TEXT)");
    db.close();
    assertUsable(path, 20, "(a) create sonrası kesinti");
  }

  // (b) INSERT'ten sonra, DROP'tan önce kesinti: iki tablo da dolu.
  {
    const path = legacyStore(20);
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE observer_watermarks_migrated (project_id INTEGER, session_id TEXT, last_uuid TEXT, last_ts TEXT, updated_at TEXT);
      INSERT INTO observer_watermarks_migrated (project_id, session_id, last_uuid, last_ts, updated_at)
      SELECT project_id, session_id, last_uuid, NULL, updated_at FROM observer_watermarks;
    `);
    db.close();
    assertUsable(path, 20, "(b) kopyalama sonrası kesinti");
  }

  // (c) DROP'tan sonra, RENAME'den önce kesinti: veri YALNIZ ara tabloda.
  // En tehlikeli dal — schema.sql hedefi boş yeniden yaratıp veriyi yetim
  // bırakabiliyordu; kurtarma bu yüzden şemadan ÖNCE koşuyor.
  {
    const path = legacyStore(20);
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE observer_watermarks_migrated (
        project_id INTEGER NOT NULL REFERENCES projects(id), session_id TEXT NOT NULL,
        last_uuid TEXT, last_ts TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id),
        CHECK (last_uuid IS NOT NULL OR last_ts IS NOT NULL)
      );
      INSERT INTO observer_watermarks_migrated (project_id, session_id, last_uuid, last_ts, updated_at)
      SELECT project_id, session_id, last_uuid, NULL, updated_at FROM observer_watermarks;
      DROP TABLE observer_watermarks;
    `);
    db.close();
    assertUsable(path, 20, "(c) drop sonrası kesinti");
  }

  // (d) (c)'nin BİR AÇILIŞ SONRASI hâli: hedef, schema.sql tarafından BOŞ
  // yaratılmış ve veri hâlâ yetim tabloda. Satır sayısı ölçütü bunu ayırıyor.
  {
    const path = legacyStore(20);
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE observer_watermarks_migrated (
        project_id INTEGER NOT NULL REFERENCES projects(id), session_id TEXT NOT NULL,
        last_uuid TEXT, last_ts TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id),
        CHECK (last_uuid IS NOT NULL OR last_ts IS NOT NULL)
      );
      INSERT INTO observer_watermarks_migrated (project_id, session_id, last_uuid, last_ts, updated_at)
      SELECT project_id, session_id, last_uuid, NULL, updated_at FROM observer_watermarks;
      DELETE FROM observer_watermarks;
    `);
    db.close();
    assertUsable(path, 20, "(d) boş hedef + dolu yetim tablo");
  }
});

test("[non-atomic-schema-migration] imleç göçü de aynı kalıptan geçiyor", () => {
  // Kalıp tek yerde olmazsa dördüncü kez delinir: M1'de imleç, M2'de filigran,
  // 2. turda atomiklik. Bu test kalıbın İKİ çağıranı da kapsadığını sabitler.
  const path = join(tmpDir("cp-v2-cursor-"), "store.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, adapter_id TEXT NOT NULL,
      transcript_dir TEXT NOT NULL, memory_dir TEXT, last_scanned_at TEXT
    );
    INSERT INTO projects (id, path, adapter_id, transcript_dir) VALUES (1, '/p', 'claude-code', '/t');
    CREATE TABLE cursors (
      project_id INTEGER NOT NULL REFERENCES projects(id), session_id TEXT NOT NULL,
      file_path TEXT NOT NULL, byte_offset INTEGER NOT NULL DEFAULT 0,
      inode TEXT, last_seen_at TEXT, PRIMARY KEY (project_id, session_id)
    );
    INSERT INTO cursors (project_id, session_id, file_path, byte_offset) VALUES (1, 's', '/t/s.jsonl', 42);
    -- Eski sürümün yarıda bıraktığı ara tablo:
    CREATE TABLE cursors_migrated (file_path TEXT PRIMARY KEY, project_id INTEGER, session_id TEXT, byte_offset INTEGER);
  `);
  db.close();

  const store = openStore(path);
  try {
    assert.equal(
      store.get<{ n: number }>("SELECT byte_offset n FROM cursors WHERE file_path='/t/s.jsonl'")?.n,
      42,
      "imleç göçü yetim ara tablo yüzünden veri kaybetti",
    );
  } finally {
    store.close();
  }
});

// --- class: invisible-anchor-bypass ---

const cpChar = (cp: number) => String.fromCodePoint(cp);
const cpName = (cp: number) => "U+" + cp.toString(16).toUpperCase();

/** Tek çapalı, başka her açıdan geçerli bir model çıktısı. */
const anchorOutput = (value: string) =>
  JSON.stringify({ findings: [{ content: "x", anchors: [{ kind: "file_path", value }], supersedes: null }] });

test("[invisible-anchor-bypass] bidi ve kontrol karakterleri çapadan geçemiyor", () => {
  // Bu bulgu 11 Ağu 2026'da KISMEN DEMOTE EDİLDİ ve iddiası daraltıldı.
  //
  // Prob'un (probes/invisible-anchor-bypass.sh) ölçtüğü dört kaçış — U+034F,
  // U+115F, U+180B, U+3164 — artık kasten KABUL EDİLİYOR. Sebep: prob'un
  // sözleşmesi "görünmez olan reddedilir"di ve o sözleşme üç turda hem delindi
  // (her yeni tanım bir kaçak bıraktı) hem meşru dosya adlarını yuttu
  // ("docs/❤️.md"). Kök karar: çapa VERİdir, doğrulaması M3'ün sinyal
  // motorunun işi; görünmezlik ise M5'in kaçışlama işi. Tam gerekçe
  // src/observer/prompt.ts'de, kabul yönü audit-m2-anchor.test.ts'de sabit.
  //
  // Kalan iddia dar ve hâlâ geçerli: metni YENİDEN YÖNLENDİREN karakter
  // (bidi) ve kontrol karakteri çapa olamaz — görünenle saklanan ayrışır.
  const yonlendirenler = [0x202e, 0x2066, 0x2028, 0x061c, 0x200e];
  for (const cp of yonlendirenler) {
    const r = parseObserverOutput(anchorOutput(`src/a${cpChar(cp)}b.ts`));
    assert.equal(r.ok, false, `${cpName(cp)} çapa olarak kabul edildi`);
  }
  // Yalnız kalan vekil: görünürlük değil iyi-biçimlilik meselesi (UTF-8'e
  // kodlanamıyor), o yüzden daraltmadan muaf.
  assert.equal(parseObserverOutput(anchorOutput("src/a\ud800b.ts")).ok, false, "yalnız vekil kabul edildi");
});

// --- class: legitimate-anchor-rejection ---

test("[legitimate-anchor-rejection] meşru emoji çapaları reddedilmiyor", () => {
  // Aynı filtrenin TERS hatası (probes/emoji-anchor-rejected.sh): ❤️ = U+2764 +
  // U+FE0F olduğu için gerçek bir dosya adı reddediliyordu. Bedeli veri kaybı —
  // tek çapa yüzünden partinin tamamı "işlenemedi" olarak checkpoint'leniyor.
  const mesru = [
    "docs/❤️.md",                 // U+2764 U+FE0F
    "docs/☕️-notları.md",         // U+2615 U+FE0F + Türkçe
    "symbols/🏳️‍🌈-durumu.md",      // VS16 + ZWJ içeren emoji dizisi
    "docs/🚀.md",                 // seçicisiz düz emoji
    "docs/👩🏽‍💻-notu.md",           // ten tonu modifiye edici + ZWJ
    "docs/1️⃣-adim.md",            // keycap dizisi: rakam + VS16 + U+20E3
    "src/çekirdek/görüntü.ts",    // Türkçe
    "日本語/パス.ts",               // CJK
    "İĞÜŞÖÇığüşöç",
    "naïve café",
    "a/b\\c",                     // her iki yol ayıracı
    "../repo-disi/not.md",        // yol gezinmesi M3'ün işi, burada reddedilmez
  ];
  for (const value of mesru) {
    const r = parseObserverOutput(anchorOutput(value));
    assert.equal(r.ok, true, `meşru çapa reddedildi: ${value} (${r.ok ? "" : r.error})`);
  }
});

// --- class: missing-cli-option-value ---

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cliPath, ...args], {
    encoding: "utf8", timeout: 30_000,
  });
}

test("[missing-cli-option-value] bozuk seçenek YAZIMLARI kullanım hatası: rc=1", () => {
  // Ölçüm (probes/cli-option-spelling-leaks.sh): beş yazım da kullanım hatası
  // vermek yerine varsayılanla ilerleyip Codex tespitine kadar gidiyordu (rc=2).
  // Sebep: arg() argv'de token ARIYORDU, argv'yi AYRIŞTIRMIYORDU.
  const store = join(tmpDir("cp-v2-cli-"), "s.db");
  const bozuk: [string[], RegExp][] = [
    [["--model="], /--model bir değer bekliyor/],
    [["--effort="], /--effort bir değer bekliyor/],
    [["--model", ""], /--model bir değer bekliyor/],
    [["-model", "x"], /beklenmeyen argüman/],
    [["--model", "good", "--model"], /--model iki kez verildi/],
    [["--effort", "low", "--effort"], /--effort iki kez verildi/],
    [["--effort", "low", "--effort", "high"], /--effort iki kez verildi/],
    [["--bilinmeyen", "x"], /bilinmeyen seçenek/],
    [["--yes=1"], /--yes değer almaz/],
    [["--"], /beklenmeyen argüman/],
  ];
  for (const [args, beklenen] of bozuk) {
    const r = runCli(["observe", "--store", store, ...args]);
    assert.equal(r.status, 1, `${args.join(" ")}: beklenen rc=1, gelen ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, beklenen, args.join(" "));
  }
});

test("[missing-cli-option-value] seçenek listesi KOMUTA ait: scan --model'i tanımaz", () => {
  // Kapalı liste olmasa `scan --model x` sessizce yutulurdu; kullanıcı bir şey
  // yaptığını sanır, hiçbir şey olmaz.
  const store = join(tmpDir("cp-v2-cli2-"), "s.db");
  const r = runCli(["scan", "--store", store, "--model", "x"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /bilinmeyen seçenek: --model/);
});

test("[missing-cli-option-value] meşru yazımlar bozulmadı (aşırı düzeltme yok)", () => {
  const dir = tmpDir("cp-v2-cli3-");
  const store = join(dir, "s.db");
  // Ayrı operand.
  assert.equal(runCli(["status", "--store", store]).status, 0);
  // `--ad=değer` biçimi de kabul: yaygın yazım, ve artık AYRIŞTIRILIYOR.
  const eq = runCli(["status", `--store=${join(dir, "s2.db")}`]);
  assert.equal(eq.status, 0, eq.stderr);
  assert.match(eq.stdout, /proje: 0/);
  // Bayrak + değerli seçenek bir arada; scan Codex istemiyor, gerçekten koşar.
  const scan = runCli(["scan", "--dir", dir, "--store", store]);
  assert.equal(scan.status, 0, scan.stderr);
  // Komutsuz çağrı hâlâ kullanım metni basıp rc=0 döner.
  assert.equal(runCli([]).status, 0);
});

// --- class: watermark-duplicate-uuid-loss ---
//
// Gerçek akışta ölçülmüş KALICI turn kaybı. Repro (yalnız append, hiçbir satır
// yeniden sıralanmadan): canlı bir oturum 678. satıra kadar taranır → filigran
// yazılır → kalan satırlar append edilir → ikinci tarama. Düzeltmeden önce
// aradaki 157 turn'ün 20'si HİÇBİR gözlemci çağrısında görünmüyordu ve
// `match: "uuid"` olduğu için uyarı olayı bile yazılmıyordu.
//
// Sebep: `--resume`/fork geçmiş bloğu dosyanın SONUNA yeniden append ediyor, o
// yüzden teslimatta bulunan uuid eşleşmesi YENİ append edilmiş KOPYA olabiliyor;
// ondan önceki gerçekten yeni turn'ler `slice(i+1)` ile atılıyordu.
// Ölçüm: 209 oturum / 49.693 uuid'li satırda 3.426 mükerrer uuid satırı.

const wt = (text: string, uuid?: string, timestamp?: string): Turn =>
  ({ role: "user", text, uuid, timestamp });

test("[watermark-duplicate-uuid-loss] belirsiz uuid eşleşmesinde eleme YOK", () => {
  const ts = (h: number) => `2026-08-11T${String(h).padStart(2, "0")}:00:00.000Z`;

  // ŞEKİL 1 — repro'nun ta kendisi: teslimatta filigran uuid'i TEK kez geçiyor
  // ama o satır fork'un yeniden yazdığı ESKİ kopya (damgası eski), önündeki
  // turn'ler ondan YENİ. Eski kod bunları "işlenmiş" sayıp atıyordu.
  const forkKopyasi = dropThroughWatermarkDetailed(
    [wt("gerçekten yeni 1", "n1", ts(10)), wt("gerçekten yeni 2", "n2", ts(11)),
     wt("fork'un yeniden yazdığı eski satır", "wm", ts(3))],
    "wm", ts(3),
  );
  assert.deepEqual(
    forkKopyasi.fresh.map((x) => x.text),
    ["gerçekten yeni 1", "gerçekten yeni 2", "fork'un yeniden yazdığı eski satır"],
    "eşleşmenin önündeki YENİ turn'ler kalıcı olarak düştü",
  );
  assert.equal(forkKopyasi.match, "uuid-ambiguous");
  assert.equal(forkKopyasi.ambiguity?.reason, "newer-turn-before-match");
  assert.equal(forkKopyasi.ambiguity?.uuidMatches, 1);

  // ŞEKİL 2 — aynı uuid teslimatta İKİ kez: hangisi "buraya kadarı işlendi"
  // belli değil. İlkini seçmek aradaki turn'leri, ikincisini seçmek daha da
  // fazlasını atardı; ölçülen 3.426 mükerrer satır bu şeklin gerçek olduğunu
  // söylüyor. Tercih: hiçbirini eleme.
  const mukerrer = dropThroughWatermarkDetailed(
    [wt("wm kopya A", "wm", ts(1)), wt("arada kalan", "n1", ts(2)), wt("wm kopya B", "wm", ts(1))],
    "wm", ts(2),
  );
  assert.deepEqual(mukerrer.fresh.length, 3, "mükerrer uuid'de eleme yapıldı");
  assert.equal(mukerrer.match, "uuid-ambiguous");
  assert.equal(mukerrer.ambiguity?.reason, "duplicate-uuid");
  assert.equal(mukerrer.ambiguity?.uuidMatches, 2);
});

test("[watermark-duplicate-uuid-loss] normal tekrar-teslimde eleme HÂLÂ çalışır", () => {
  // Aşırı düzeltme kapısı: her eşleşmeyi belirsiz saymak mükerrer bulgu
  // regresyonu (order-sensitive-watermark) olurdu. Tek eşleşme + önü tutarlı
  // damgalı ise konumsal kesim aynen sürüyor.
  const ts = (h: number) => `2026-08-11T0${h}:00:00.000Z`;
  const r = dropThroughWatermarkDetailed(
    [wt("işlenmiş 1", "u1", ts(1)), wt("işlenmiş 2", "u2", ts(2)), wt("yeni", "u3", ts(3))],
    "u2", ts(2),
  );
  assert.deepEqual(r.fresh.map((x) => x.text), ["yeni"], "tekrar-teslim elenmedi: mükerrer bulgu üretilir");
  assert.equal(r.match, "uuid");
  assert.equal(r.ambiguity, undefined);

  // Damgası EŞİT olan önceki turn'ler belirsizlik saymaz — gerçek veride
  // turn'lerin %11,55'i damgasını bir başkasıyla paylaşıyor, "yeni" ölçütü
  // KESİN büyüklük.
  const esitDamga = dropThroughWatermarkDetailed(
    [wt("a", "u1", ts(2)), wt("b", "u2", ts(2)), wt("yeni", "u3", ts(3))],
    "u2", ts(2),
  );
  assert.deepEqual(esitDamga.fresh.map((x) => x.text), ["yeni"]);
  assert.equal(esitDamga.match, "uuid");

  // Filigran partinin SONUNDAysa hepsi elenir (en yaygın tekrar-teslim hâli).
  const hepsi = dropThroughWatermarkDetailed(
    [wt("a", "u1", ts(1)), wt("b", "u2", ts(2))], "u2", ts(2),
  );
  assert.deepEqual(hepsi.fresh, []);
  assert.equal(hepsi.match, "uuid");
});

test("[watermark-duplicate-uuid-loss] belirsiz eşleşme görünür olay bırakır", async () => {
  // Sessiz eleme bulgunun kendisiydi; sessiz ELEMEME de aynı hatanın aynası
  // olurdu — mükerrer bulgunun sebebi sonradan bulunamazdı.
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });
  const ts = (h: number) => `2026-08-11T${String(h).padStart(2, "0")}:00:00.000Z`;
  setWatermark(store, { projectId: pid, sessionId: "s1", lastUuid: "wm", lastTs: ts(3) });

  const exec = fakeExecutor([]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [
    wt("gerçekten yeni", "n1", ts(10)), wt("fork kopyası", "wm", ts(3)),
  ]});

  assert.equal(countEvents(store, "watermark_ambiguous_match"), 1, "belirsiz eşleşme sessizce geçti");
  const detail = JSON.parse(listEvents(store, { kind: "watermark_ambiguous_match" })[0]!.detail!);
  assert.equal(detail.reason, "newer-turn-before-match");
  assert.equal(detail.uuidMatches, 1);
  assert.equal(detail.storedUuid, "wm");
  assert.equal(detail.turnCount, 2);
  // Ve asıl mesele: kaybolan turn YOK, modele gitti.
  assert.equal(exec.calls.length, 1);
  assert.ok(exec.calls[0]!.prompt.includes("gerçekten yeni"), "yeni turn yine kayboldu");
  // Yanlış olay tipi yazılmadı: bu "hiç eşleşmedi" değil, "güvenilmedi".
  assert.equal(countEvents(store, "watermark_match_failed"), 0);
  store.close();
});
