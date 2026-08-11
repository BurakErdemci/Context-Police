// M2 DOĞRULAMA turu bulgularının kalıcı iddiaları.
//
// Bu turun konusu M2 denetim düzeltmelerinin KENDİSİYDİ: bağımsız bir tur,
// kapatıldı sanılan beş kusurun hâlâ canlı olduğunu ölçtü. Her test bir bulgu
// SINIFINI sabitliyor; probe repoya girmez, iddiası girer.
//
// Ders (iki denetimde iki kez çıktı, bkz. schema-migration-*): bir düzeltmenin
// "yapıldı" olması, kapsadığı YÜZEYLERİN hepsinde yapıldığı anlamına gelmiyor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
// node:sqlite normalde YALNIZ src/store/db.ts'te import edilir (spec K12). Buradaki
// istisnanın sebebi ölçülebilir: eski ŞEMAYI kurmak gerekiyor ve güncel kod artık
// o şemayı üretemiyor — göçü depo API'siyle sınamak imkânsız.
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../src/store/db.ts";
import { getWatermark, setWatermark } from "../src/store/watermarks.ts";
import { upsertProject, getCursor } from "../src/store/projects.ts";
import { Observer } from "../src/observer/observer.ts";
import { scanOnce } from "../src/scan.ts";
import { claudeCodeAdapter, readCwd, MAX_LINE_BYTES } from "../src/adapters/claude-code.ts";
import { parseObserverOutput } from "../src/observer/prompt.ts";
import { dropThroughWatermarkDetailed } from "../src/observer/batch.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";

const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");

// --- class: timestamp-watermark-turn-loss ---

/** Tek oturumluk sahte transcript kökü; satırlar uuid + timestamp taşır. */
function sessionRoot() {
  const root = tmpDir("cp-verify-");
  const dir = join(root, "-tmp-cp-verify-proje");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "s.jsonl");
  return { root, file };
}

const jsonl = (text: string, uuid: string, timestamp: string) =>
  JSON.stringify({
    type: "user", cwd: "/tmp/cp-verify-proje", uuid, timestamp,
    message: { role: "user", content: text },
  }) + "\n";

test("[timestamp-watermark-turn-loss] eşit ya da geri tarihli YENİ turn taramada kaybolmaz", async () => {
  // Ölçüm (19.416 gerçek turn, 66 oturum): turn'lerin %11,55'i aynı oturumda
  // başka bir turn'le AYNI damgayı, %0,70'i bir öncekinden GERİ giden damgayı
  // taşıyor. Eski kod `timestamp > lastTs` diyerek ikisini de eliyordu; imleç
  // yine dosya sonuna ilerlediği için bu mükerrer önleme değil KALICI turn kaybıydı.
  const { root, file } = sessionRoot();
  const store = openStore(":memory:");
  const exec = fakeExecutor([]);
  const observer = new Observer({ store, executor: exec });
  const scan = () => scanOnce(store, {
    adapter: claudeCodeAdapter, root, onTurns: (ctx) => observer.handleTurns(ctx),
  });
  const ts = "2026-08-11T10:00:00.123Z";

  writeFileSync(file, jsonl("ilk", "u1", ts));
  await scan();
  appendFileSync(file, jsonl("esit-damgali-yeni", "u2", ts));
  await scan();
  appendFileSync(file, jsonl("geri-tarihli-yeni", "u3", "2026-08-11T09:59:59.999Z"));
  await scan();

  assert.equal(exec.calls.length, 3, "yeni turn modele hiç gitmedi");
  const prompts = exec.calls.map((c) => c.prompt).join("\n");
  assert.ok(prompts.includes("esit-damgali-yeni"), "eşit damgalı yeni turn düşürüldü");
  assert.ok(prompts.includes("geri-tarihli-yeni"), "geri tarihli yeni turn düşürüldü");
  // İmlecin dosya sonunda olması kaybı KALICI yapan şeydi: turn bir daha okunmaz.
  // (Yol tablodan okunuyor: tarama gerçek yolu çözüyor, /var → /private/var.)
  const kayit = store.all<{ file_path: string }>("SELECT file_path FROM cursors")[0]!;
  assert.equal(getCursor(store, kayit.file_path)?.byteOffset, statSync(file).size);
  store.close();
});

test("[timestamp-watermark-turn-loss] damga ELEME ölçütü değil; monoton filigran ve checkpoint görevi durur", () => {
  const ts = (h: string) => `2026-08-11T${h}:00:00.000Z`;
  // (a) uuid taşıyan turn damga yüzünden ASLA düşmez — eşit de, daha eski de.
  const r = dropThroughWatermarkDetailed(
    [{ role: "user", text: "esit", uuid: "a1", timestamp: ts("10") },
     { role: "user", text: "eski", uuid: "a2", timestamp: ts("09") }],
    "bulunmayan-uuid", ts("10"),
  );
  assert.deepEqual(r.fresh.map((x) => x.text), ["esit", "eski"]);

  // (b) uuid'siz turn yalnız KESİN ESKİYSE düşer.
  const u = dropThroughWatermarkDetailed(
    [{ role: "user", text: "eski", timestamp: ts("09") },
     { role: "user", text: "esit", timestamp: ts("10") }],
    null, ts("10"),
  );
  assert.deepEqual(u.fresh.map((x) => x.text), ["esit"]);

  // (c) Damganın KALAN iki işi aynen duruyor: monoton geri sarma engeli...
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });
  setWatermark(store, { projectId: pid, sessionId: "s", lastUuid: "u9", lastTs: ts("10") });
  const w = setWatermark(store, { projectId: pid, sessionId: "s", lastUuid: "u10", lastTs: ts("03") });
  assert.equal(w.rewindBlocked?.storedTs, ts("10"));
  assert.equal(getWatermark(store, pid, "s")!.lastTs, ts("10"), "filigran geri sardı");
  // ...ve uuid'siz parti için checkpoint kimliği.
  setWatermark(store, { projectId: pid, sessionId: "s2", lastUuid: null, lastTs: ts("05") });
  assert.equal(getWatermark(store, pid, "s2")!.lastTs, ts("05"));
  store.close();
});

// --- class: schema-migration-breaks-watermark ---

test("[schema-migration-breaks-watermark] eski depo açılır, verisi korunur ve yeni checkpoint yazılabilir", () => {
  // M1'de aynı sınıf imleç tablosunda çıkmıştı (schema-migration-breaks-cursor).
  // Kusurun gözden kaçma biçimi ikisinde de aynı: YENİ depoda çalışıyor, ESKİDE ölü.
  const path = join(tmpDir("cp-verify-eski-"), "store.db");
  const eski = new DatabaseSync(path);
  eski.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, adapter_id TEXT NOT NULL,
      transcript_dir TEXT NOT NULL, memory_dir TEXT, last_scanned_at TEXT
    );
    CREATE TABLE observer_watermarks (
      project_id INTEGER NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL,
      last_uuid TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    INSERT INTO projects (id, path, adapter_id, transcript_dir) VALUES (1, '/p', 'claude-code', '/t');
    INSERT INTO observer_watermarks (project_id, session_id, last_uuid, updated_at)
      VALUES (1, 'eski-oturum', 'eski-u1', '2026-08-10T00:00:00.000Z');
  `);
  eski.close();

  const store = openStore(path);
  // (a) Eski satır kaybolmadı: göç veri taşımalı, tabloyu sıfırlamamalı.
  assert.equal(getWatermark(store, 1, "eski-oturum")?.lastUuid, "eski-u1");
  assert.equal(getWatermark(store, 1, "eski-oturum")?.lastTs, null);
  // (b) Yalnız sütun eklemek YETMEZ: eski `last_uuid NOT NULL` kısıtı uuid'siz
  //     checkpoint'i engelliyordu, o da uuid'siz partide sonsuz yeniden deneme demek.
  setWatermark(store, { projectId: 1, sessionId: "damga-yalniz", lastUuid: null, lastTs: "2026-08-11T00:00:00.000Z" });
  const yeni = getWatermark(store, 1, "damga-yalniz");
  assert.equal(yeni?.lastUuid, null);
  assert.equal(yeni?.lastTs, "2026-08-11T00:00:00.000Z");
  store.close();

  // (c) Göç yeniden açmada da kararlı (idempotent).
  const tekrar = openStore(path);
  assert.equal(getWatermark(tekrar, 1, "eski-oturum")?.lastUuid, "eski-u1");
  tekrar.close();
});

// --- class: unsanitized-anchor-value (kalıntı) ---

const anchorOk = (value: string) =>
  parseObserverOutput(JSON.stringify({ findings: [{ content: "b", anchors: [{ kind: "file_path", value }] }] })).ok;

test("[unsanitized-anchor-value] görünmez Unicode biçim karakterleri çapa değerine geçemez", () => {
  // İlk düzeltme elle sayılmış aralıklar kullanıyordu; doğrulama turu bu dördünün
  // listeden kaçtığını ölçtü. Küme artık kategori tabanlı (prompt.ts).
  for (const cp of [0x00ad, 0x180e, 0x2060, 0x206a]) {
    const value = `src/a${String.fromCodePoint(cp)}b.ts`;
    assert.equal(anchorOk(value), false, `U+${cp.toString(16).toUpperCase()} kabul edildi`);
  }
  // Önceki turun kapattıkları da kapalı kalmalı (gerileme koruması).
  for (const cp of [0x0000, 0x001f, 0x007f, 0x009f, 0x061c, 0x200b, 0x200e, 0x2028, 0x2029, 0x202e, 0x2066, 0xfeff]) {
    assert.equal(anchorOk(`src/a${String.fromCodePoint(cp)}b.ts`), false, `U+${cp.toString(16)} kabul edildi`);
  }
  // Yalnız kalan vekil: JSON'dan gelebiliyor ve kodlama gidiş-dönüşünü bozuyor.
  assert.equal(anchorOk("src/a\uD800b.ts"), false);
});

test("[unsanitized-anchor-value] meşru metin REDDEDİLMEZ: aşırı düzeltme veri kaybettirir", () => {
  // Bu testin işi düzeltmenin üst sınırını tutmak. Görünmez karakteri kovalarken
  // normal içeriği eleyen bir küme, sessizce gerçek bulgu yutar — aynı sınıf,
  // ters yön.
  for (const value of [
    "src/çekirdek/görüntü.ts",
    "İĞÜŞÖÇığüşöç/dosya.md",
    "日本語/パス.ts",
    "naïve café/über.ts",
    "../repo-disi/yol.md",
    "/mutlak/yol/dosya.ts",
    "sym::Ölçüm<T>",
    "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  ]) {
    assert.equal(anchorOk(value), true, `meşru değer reddedildi: ${value}`);
  }
});

// --- class: unbounded-line-buffering (ikinci yüzey: readCwd) ---

/** Aynı biçimde dosya: `mib` MiB'lik tek satır, ardından cwd taşıyan satır. */
function preCwdFile(dir: string, name: string, mib: number): string {
  const file = join(dir, name);
  writeFileSync(file, "x".repeat(mib * 1024 * 1024) + '\n{"cwd":"/probe"}\n');
  return file;
}

test("[unbounded-line-buffering] readCwd uzun satırı DOĞRUSAL biriktirir", async () => {
  // Ölçüm (doğrulama turu, düzeltme öncesi): 8 MiB → 32 MiB'de süre ~55 ms'den
  // ~940 ms'ye çıkıyordu — 4 kat girdi, ~17 kat maliyet, tam karesel. Sebep
  // `pending += chunk` ve her parçada `pending.split("\n")`.
  //
  // ÖLÇÜT NEDEN İKİ BOYUTUN ORANI DEĞİL: ilk hâli 2 MiB ile 6 MiB'i
  // karşılaştırıyordu ve KIRILGAN çıktı — mutlak süreler ~1 ms olduğu için
  // gürültü oranı 9×'e kadar sallıyordu (düzeltme yerindeyken bile). Bunun
  // yerine AYNI dosya üzerinde doğrusal bir referans ölçülüyor: `readFile` o
  // dosyayı bir kez okuyup bir kez kopyalar, yani tanımı gereği O(n).
  //
  // Ölçüldü (bu makine, 8 MiB): readFile ~0,8 ms, readCwd ~3,5 ms → oran 4,0-5,4
  // (altı koşum). Düzeltme öncesi readCwd aynı dosyada ~55 ms sürüyordu, yani
  // oran ~68 olurdu. Eşik 20: iki yöne de yaklaşık 4× pay bırakıyor ve makine
  // hızından bağımsız (pay ve payda aynı makinede, aynı önbellek durumunda).
  const dir = tmpDir("cp-verify-readcwd-");
  const file = preCwdFile(dir, "8m.jsonl", 8);
  const olc = async (fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
  };
  const medyan = async (fn: () => Promise<unknown>) => {
    await olc(fn); // ön ısıtma (dosya önbelleği + JIT)
    const xs: number[] = [];
    for (let i = 0; i < 5; i++) xs.push(await olc(fn));
    return xs.sort((a, b) => a - b)[2]!;
  };
  const referans = await medyan(() => readFile(file));
  const olculen = await medyan(async () => assert.equal(await readCwd(file), "/probe"));
  const oran = olculen / referans;
  assert.ok(oran < 20, `readCwd doğrusal referansın ${oran.toFixed(1)} katı sürdü (karesel biriktirme)`);
});

test("[unbounded-line-buffering] readCwd'de bayt tavanı var ve keşif durmuyor", async () => {
  // `maxLines` satır SAYISINI sınırlar, BOYUNU değil: tavan olmadan tek bir dev
  // satır bütünüyle belleğe alınırdı. Tavanı aşan satır atlanır, keşif sürer.
  const dir = tmpDir("cp-verify-cap-");
  const file = join(dir, "cap.jsonl");
  writeFileSync(file, "x".repeat(MAX_LINE_BYTES + 1024) + '\n{"cwd":"/tavan-sonrasi"}\n');
  assert.equal(await readCwd(file), "/tavan-sonrasi");
});

test("[unbounded-line-buffering] 64 KiB parça sınırına denk gelen UTF-8 karakteri bozulmaz", async () => {
  // Eski hâl her parçayı ayrı ayrı `toString("utf8")` yapıyordu: chunk sınırında
  // bölünen çok baytlı karakter U+FFFD'ye dönüyor ve proje yolu sessizce
  // yanlış çözülüyordu. Satır artık TAM Buffer olarak decode ediliyor.
  const dir = tmpDir("cp-verify-utf8-");
  const file = join(dir, "utf8.jsonl");
  const cwd = "/tmp/ölçüm-dizini-şğüİ";
  // Dolgu satırını 64 KiB sınırının 1 bayt öncesinde bitir ki cwd satırındaki
  // çok baytlı karakterler sınırı kessin.
  const dolgu = "y".repeat(64 * 1024 - 1);
  writeFileSync(file, dolgu + "\n" + JSON.stringify({ cwd }) + "\n");
  assert.equal(await readCwd(file), cwd);
});

// --- class: missing-cli-option-value ---

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cliPath, ...args], {
    encoding: "utf8", timeout: 30_000,
  });
}

test("[missing-cli-option-value] değersiz seçenek KULLANIM HATASI: rc=1, Codex'e hiç gidilmez", () => {
  // Eski arg() "bayrak yok" ile "bayrak var, değeri yok"u aynı undefined'a
  // indiriyordu: komut varsayılanla devam edip Codex tespitini başlatıyor ve
  // çok sonraki ilgisiz bir kapıda (rc=3) duruyordu.
  const store = join(tmpDir("cp-verify-cli-"), "s.db");
  for (const bayrak of ["--model", "--effort", "--batch-tokens", "--store"]) {
    const r = runCli(["observe", ...(bayrak === "--store" ? [] : ["--store", store]), bayrak]);
    assert.equal(r.status, 1, `${bayrak}: beklenen rc=1, gelen ${r.status}`);
    assert.match(r.stderr, new RegExp(`${bayrak} bir değer bekliyor`));
  }
  // Değer yerine BAŞKA BİR BAYRAK gelmesi de eksik operand.
  const r = runCli(["observe", "--store", store, "--model", "--yes"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--model bir değer bekliyor/);
});

test("[missing-cli-option-value] geçerli değer çalışmaya devam eder (aşırı düzeltme yok)", () => {
  const store = join(tmpDir("cp-verify-cli2-"), "s.db");
  const r = runCli(["status", "--store", store]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /proje: 0/);
  // Bayraksız çağrı kullanım metnini basar; arg() burada hiç tetiklenmez.
  assert.equal(runCli([]).status, 0);
});
