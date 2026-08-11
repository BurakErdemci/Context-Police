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
import { tmpDir } from "./helpers.ts";

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

test("[invisible-anchor-bypass] default-ignorable kod noktaları çapadan geçemiyor", () => {
  // Ölçüm (probes/invisible-anchor-bypass.sh): Cc/Cf/Cs kümesi U+034F, U+115F,
  // U+180B ve U+3164'ü KAÇIRIYORDU — dördü de görünmez, dördü de "src/ab.ts"
  // görünen ama ondan farklı bir çapa değeri üretiyor. Ölçüt artık Unicode'un
  // Default_Ignorable_Code_Point özelliği; liste bizim değil.
  const kacanlar = [0x034f, 0x115f, 0x180b, 0x3164]; // prob'un ölçtüğü dört kaçış
  const eskiden_kapali = [0x00ad, 0x180e, 0x2060, 0x206a, 0x200b, 0x202e, 0xfeff, 0x2028, 0xe0001];
  const surrogate = "src/a\ud800b.ts"; // yalnız kalan vekil

  for (const cp of [...kacanlar, ...eskiden_kapali]) {
    const r = parseObserverOutput(anchorOutput(`src/a${cpChar(cp)}b.ts`));
    assert.equal(r.ok, false, `${cpName(cp)} görünmez olduğu hâlde çapa olarak kabul edildi`);
  }
  assert.equal(parseObserverOutput(anchorOutput(surrogate)).ok, false, "yalnız vekil kabul edildi");

  // Sıfır genişlikli birleştirici de METİN arasında görünmezdir: emoji dizisi
  // dışındaki ZWJ meşru değil, homograf üretir.
  assert.equal(parseObserverOutput(anchorOutput(`src/a${cpChar(0x200d)}b.ts`)).ok, false, "harfler arası ZWJ kabul edildi");
  // Varyasyon seçicisinin emoji olmayan komşusu da öyle.
  assert.equal(parseObserverOutput(anchorOutput(`src/a${cpChar(0xfe0f)}b.ts`)).ok, false, "harften sonra VS16 kabul edildi");
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
