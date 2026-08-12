import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, SCHEMA_GENERATION, StoreGenerationTooNew } from "../src/store/db.ts";
import { DatabaseSync } from "node:sqlite";
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

// --- şema kuşağı damgası (PRAGMA user_version) -------------------------------

test("damgasız VAR OLAN depo açılınca kuşak damgası yazılır, veri korunur", () => {
  // CLAUDE.md §7: göç TAZE depoda çalışıyor diye kanıtlanmış olmuyor. Dosya
  // önce yaratılıp veriyle dolduruluyor, damga elle sıfırlanıyor (bu kuşaktan
  // önceki her depo böyle: user_version varsayılanı 0), sonra açılıyor.
  const path = tmpStorePath();
  const ilk = openStore(path);
  ilk.run("INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t");
  ilk.close();

  const ham = new DatabaseSync(path);
  ham.exec("PRAGMA user_version = 0");
  ham.close();

  const yeni = openStore(path);
  assert.equal(yeni.get<{ user_version: number }>("PRAGMA user_version")?.user_version, SCHEMA_GENERATION,
    "var olan depo damgalanmadı: eski kod bu depoyu kendisininmiş gibi kullanmaya devam eder");
  assert.equal(yeni.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")?.n, 1, "damgalama veri kaybetti");
  yeni.close();
});

test("BENDEN YENİ kuşakla damgalanmış depo açılmayı reddeder", () => {
  // Ters yön (eski kod, yeni depo) BU KODDAN kapatılamaz: damgayı okumayan bir
  // sürüme okuma öğretilemez. Kapatılabilen yön bu — ve sessizce devam etmek,
  // bilmediğimiz bir şemaya göçümüzü koşturmak demek olurdu.
  const path = tmpStorePath();
  openStore(path).close();
  const ham = new DatabaseSync(path);
  ham.exec(`PRAGMA user_version = ${SCHEMA_GENERATION + 1}`);
  ham.close();

  assert.throws(() => openStore(path), StoreGenerationTooNew);

  // Reddetmek YETMEZ, dokunmamak da şart: reddedilen depo damgasını korumalı.
  const kontrol = new DatabaseSync(path, { readOnly: true });
  assert.equal((kontrol.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    SCHEMA_GENERATION + 1, "reddedilen depo yine de damgalandı");
  kontrol.close();
});
