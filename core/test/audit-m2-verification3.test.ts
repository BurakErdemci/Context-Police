// M2 3. DOĞRULAMA TURU — KÖK TASARIM DEĞİŞİKLİĞİ A'nın kalıcı testleri.
//
// Üç doğrulama turu aynı yerde kanadı: gözlemcinin filigranı "bu turn işlendi mi"
// sorusunu turn'ün İÇERİK kimliğinden (uuid + zaman damgası) çıkarmaya
// çalışıyordu ve her tur o tahminin yeni bir kayıp sınıfı ürettiğini ölçtü:
//   1. tur — damga düşürme ölçütüydü: eşit/geri damgalı turn'ler kayboluyordu
//            (ölçüm: gerçek turn'lerin %11,55'i damga paylaşıyor, %0,70'i geri gidiyor)
//   2. tur — mükerrer uuid: 20 turn kalıcı kayıp (209 oturumda 3.426 mükerrer uuid
//            satırı; `--resume` geçmiş bloğunu dosyanın sonuna yeniden append ediyor)
//   3. tur — eşit damga + mükerrer uuid birleşimi, uuid'siz geri damgalı turn,
//            mükerrer terminal uuid'de sabit noktaya varmama
//
// Kök sebep tek: "işlendi mi" KONUMSAL bir olgu ve `scan.ts` onu zaten kesin
// biliyor (hangi bayt aralığını okuduğunu). Bu dosya kararın konumdan verildiğini
// ve içerik kimliğinin karara HİÇ girmediğini sabitler.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync, existsSync, chmodSync } from "node:fs";

import { openStore } from "../src/store/db.ts";
import { Observer } from "../src/observer/observer.ts";
import { scanOnce } from "../src/scan.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { upsertProject } from "../src/store/projects.ts";
import { getWatermark, setWatermark } from "../src/store/watermarks.ts";
import { countEvents } from "../src/store/events.ts";
import { dropThroughWatermarkDetailed, deliveryKey } from "../src/observer/batch.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";
import type { Turn } from "../src/types.ts";

const wt = (text: string, uuid?: string, timestamp?: string): Turn => ({ role: "user", text, uuid, timestamp });
const konum = (byteOffset: number | null, key: string | null = null, turns: number | null = null) =>
  ({ byteOffset, deliveryKey: key, deliveryTurns: turns });

function setup() {
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/proj", adapterId: "claude-code", transcriptDir: "/t" });
  return { store, pid };
}

// ── class: equal-timestamp-watermark-loss ───────────────────────────────────
// Prob: filigranla EŞİT damgalı gerçekten yeni bir turn, teslimatta filigranın
// uuid kopyası da varken düşüyordu. İki belirsizlik birleşince eleme tekrar
// "kesin" sanılıyordu.

test("[equal-timestamp-watermark-loss] eşit damga + mükerrer uuid kararı ETKİLEMEZ", () => {
  const damga = "2026-08-11T10:00:00.000Z";
  const turns = [wt("gerçekten yeni", "yeni-uuid", damga), wt("append edilmiş eski kopya", "wm-uuid", damga)];
  const range = { from: 1000, to: 1500, truncated: false };

  // Aralık filigranın ötesinde: içerik ne söylerse söylesin hiçbir şey elenmez.
  const r = dropThroughWatermarkDetailed(turns, konum(1000), range);
  assert.deepEqual(r.fresh.map((x) => x.text), ["gerçekten yeni", "append edilmiş eski kopya"]);
  assert.equal(r.match, "fresh");

  // Ve tersi de içerikten bağımsız: aralık kapsanıyorsa hepsi elenir.
  assert.deepEqual(dropThroughWatermarkDetailed(turns, konum(1500), range).fresh, []);
});

// ── class: uuidless-backdated-watermark-loss ────────────────────────────────
// Prob: uuid taşımayan ve damgası filigrandan geri olan turn, İLERİ teslimatta
// bile düşüyordu. uuid'siz turn'lerde damga kesimi 2. turdan kalan artıktı.

test("[uuidless-backdated-watermark-loss] uuid'siz geri damgalı turn ileri teslimatta düşmez", () => {
  const turns = [wt("uuid'siz geri damgalı yeni turn", undefined, "2026-08-11T09:00:00.000Z")];
  const r = dropThroughWatermarkDetailed(turns, konum(200), { from: 200, to: 400, truncated: false });
  assert.deepEqual(r.fresh, turns);
  assert.equal(r.match, "fresh");

  // Kimlik alanları hiç olmasa da aynı: karar yalnız konumdan.
  const kimliksiz = dropThroughWatermarkDetailed([wt("ne uuid ne damga")], konum(200), {
    from: 200, to: 400, truncated: false,
  });
  assert.equal(kimliksiz.fresh.length, 1);
});

// ── class: duplicate-terminal-uuid-loop ─────────────────────────────────────
// Prob: teslimatın SON turn'ü mükerrer bir uuid taşıyorsa aynı teslimat her
// koşumda yeniden ücretlendiriliyordu — sabit noktaya hiç varmıyordu. Aralık
// taşımayan doğrudan çağrılarda kimlik teslimatın içerik ÖZETİNDEN kuruluyor
// (tek tek turn kimliğinden değil), o yüzden bu şekil de sabit noktaya varır.

test("[duplicate-terminal-uuid-loop] aynı teslimat aralıksız çağrıda da sabit noktaya varır", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([]);
  const obs = new Observer({ store, executor: exec, batchTokens: 100000 });
  const turns = [
    wt("eski kopya A", "terminal-mukerrer", "2026-08-11T01:00:00.000Z"),
    wt("aradaki yeni", "orta", "2026-08-11T02:00:00.000Z"),
    wt("eski kopya B", "terminal-mukerrer", "2026-08-11T01:00:00.000Z"),
  ];

  await obs.handleTurns({ projectId: pid, sessionId: "s", turns });
  const birinci = exec.calls.length;
  await obs.handleTurns({ projectId: pid, sessionId: "s", turns });
  await obs.handleTurns({ projectId: pid, sessionId: "s", turns });

  assert.equal(birinci, 1);
  assert.equal(exec.calls.length, 1, "aynı teslimat her koşumda yeniden ücretlendirildi");
  assert.equal(obs.stats.skippedTurns, 6, "iki tekrar teslimin altı turn'ü de elenmeliydi");
  store.close();
});

// ── teslimat kararının dört hâli ────────────────────────────────────────────

test("tam tekrar teslim elenir: aynı aralık ikinci kez iş üretmez", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([]);
  const obs = new Observer({ store, executor: exec });
  const turns = [wt("a", "u1", "2026-08-11T01:00:00.000Z")];
  const range = { from: 0, to: 120, truncated: false };

  await obs.handleTurns({ projectId: pid, sessionId: "s", turns, range });
  assert.equal(getWatermark(store, pid, "s")!.byteOffset, 120, "teslimat sonu ofseti yazılmadı");
  await obs.handleTurns({ projectId: pid, sessionId: "s", turns, range });

  assert.equal(exec.calls.length, 1);
  assert.equal(obs.stats.skippedTurns, 1);
  store.close();
});

test("ileri teslimat elenmez: ofsetin ötesindeki her turn işlenir", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([]);
  const obs = new Observer({ store, executor: exec });

  await obs.handleTurns({
    projectId: pid, sessionId: "s",
    turns: [wt("ilk", "u1", "2026-08-11T05:00:00.000Z")],
    range: { from: 0, to: 100, truncated: false },
  });
  // İkinci teslimat: damgası GERİ, uuid'i mükerrer, ama aralığı ileri.
  await obs.handleTurns({
    projectId: pid, sessionId: "s",
    turns: [wt("sonraki", "u1", "2026-08-11T01:00:00.000Z")],
    range: { from: 100, to: 220, truncated: false },
  });

  assert.equal(exec.calls.length, 2, "ileri teslimat elendi: kalıcı turn kaybı");
  assert.ok(exec.calls[1]!.prompt.includes("sonraki"));
  assert.equal(obs.stats.skippedTurns, 0);
  assert.equal(getWatermark(store, pid, "s")!.byteOffset, 220);
  store.close();
});

test("kısmi örtüşmede KAYIP YOK: aralık kayarsa hepsi yeniden işlenir", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([]);
  const obs = new Observer({ store, executor: exec });

  await obs.handleTurns({
    projectId: pid, sessionId: "s",
    turns: [wt("a", "u1"), wt("b", "u2")],
    range: { from: 0, to: 200, truncated: false },
  });
  // Aralık geriye kayıp örtüşüyor: turn'lerin tek tek ofsetleri elimizde
  // olmadığı için kesim TAHMİN olurdu. Tahmin yerine tekrar seçiliyor —
  // mükerrer bulgu supersede/restore ile geri alınır, kayıp turn alınmaz.
  await obs.handleTurns({
    projectId: pid, sessionId: "s",
    turns: [wt("b", "u2"), wt("c", "u3")],
    range: { from: 100, to: 300, truncated: false },
  });

  assert.equal(exec.calls.length, 2);
  assert.ok(exec.calls[1]!.prompt.includes("[user] b"), "örtüşen turn atlandı: kayıp riski");
  assert.ok(exec.calls[1]!.prompt.includes("[user] c"), "yeni turn kayboldu");
  store.close();
});

test("kısalmada ofset SIFIRLANIR: yeni dosyanın başı işlenmiş sayılmaz", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([]);
  const obs = new Observer({ store, executor: exec });

  await obs.handleTurns({
    projectId: pid, sessionId: "s",
    turns: [wt("eski dosya", "u1")],
    range: { from: 0, to: 5000, truncated: false },
  });
  assert.equal(getWatermark(store, pid, "s")!.byteOffset, 5000);

  // Dosya yerine yenisi kondu: ofset uzayı sıfırlandı. Saklanan 5000 korunursa
  // yeni dosyanın ilk 5000 baytı sessizce "işlenmiş" sayılırdı.
  await obs.handleTurns({
    projectId: pid, sessionId: "s",
    turns: [wt("yeni dosyanın ilk turn'ü", "v1")],
    range: { from: 0, to: 300, truncated: true },
  });

  assert.equal(exec.calls.length, 2, "kısalma sonrası yeni içerik elendi");
  assert.ok(exec.calls[1]!.prompt.includes("yeni dosyanın ilk turn'ü"));
  assert.equal(countEvents(store, "watermark_offset_reset"), 1, "sıfırlama sessiz kaldı");
  assert.equal(getWatermark(store, pid, "s")!.byteOffset, 300, "ofset yeni uzaya göre yazılmalı");
  store.close();
});

// ── yarım kalan iş: ilerleme kaybolmamalı ───────────────────────────────────

test("yarım kalan teslimat kaldığı yerden sürer (bütçe sınırı)", async () => {
  const { store, pid } = setup();
  const turns = Array.from({ length: 6 }, (_, i) => wt("y".repeat(100), `u${i}`));
  const range = { from: 0, to: 900, truncated: false };

  // Her turn ~25 token → 3 parti; bütçe 2 çağrı.
  const exec = fakeExecutor([]);
  const obs = new Observer({ store, executor: exec, batchTokens: 50, maxCalls: 2 });
  await obs.handleTurns({ projectId: pid, sessionId: "s", turns, range });
  assert.equal(exec.calls.length, 2);
  assert.equal(obs.stats.budgetExhausted, true);

  const yarim = getWatermark(store, pid, "s")!;
  assert.equal(yarim.byteOffset, null, "yarım teslimatta ofset ilerledi: işlenmemiş turn'ler kaybolur");
  assert.equal(yarim.deliveryTurns, 4, "işlenmiş ön ek kaydedilmedi: iş baştan koşar");
  assert.equal(yarim.deliveryKey, deliveryKey(turns, range));

  // Sonraki koşum: yalnız KALAN parti. Ne baştan başlar ne de eksik bırakır.
  const exec2 = fakeExecutor([]);
  const obs2 = new Observer({ store, executor: exec2, batchTokens: 50 });
  await obs2.handleTurns({ projectId: pid, sessionId: "s", turns, range });
  assert.equal(exec2.calls.length, 1, "kalan parti sayısı değişti");
  assert.equal(obs2.stats.skippedTurns, 4);
  assert.equal(getWatermark(store, pid, "s")!.byteOffset, 900, "teslimat bitince ofset kapanmalı");
  store.close();
});

test("göç etmiş (konumsuz) filigran ilk teslimatta konumunu kurar", () => {
  // Eski depolardan gelen satırlarda ofset YOK. Uydurulamaz: bilinmeyen ofset
  // null kalır, ilk teslimat elenmez (kayıp yerine tekrar), sonrası konumsal.
  const { store, pid } = setup();
  setWatermark(store, { projectId: pid, sessionId: "s", lastUuid: "eski-u1", lastTs: "2026-08-10T00:00:00.000Z" });
  const wm = getWatermark(store, pid, "s")!;
  assert.equal(wm.byteOffset, null);

  const turns = [wt("a", "eski-u1", "2026-08-10T00:00:00.000Z")];
  const r = dropThroughWatermarkDetailed(turns, wm, { from: 0, to: 100, truncated: false });
  assert.deepEqual(r.fresh, turns, "teşhis alanı eleme yaptı");
  store.close();
});

// ── gerçek tarama akışı ─────────────────────────────────────────────────────

const jsonl = (text: string, uuid: string, timestamp: string) =>
  JSON.stringify({
    type: "user", cwd: "/tmp/cp-v3-proje", uuid, timestamp,
    message: { role: "user", content: text },
  }) + "\n";

test("gerçek akış: `--resume` fork bloğu yeniden append edilse bile turn kaybolmaz", async () => {
  // 2. turda ölçülen kalıcı kayıp buydu: fork geçmiş bloğu dosyanın SONUNA
  // yeniden append ediliyor, teslimatta bulunan uuid eşleşmesi o KOPYA oluyor ve
  // ondan önceki gerçekten yeni turn'ler sessizce atılıyordu (157 turn'ün 20'si).
  const root = tmpDir("cp-v3-");
  const dir = join(root, "-tmp-cp-v3-proje");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "s.jsonl");

  const store = openStore(":memory:");
  const exec = fakeExecutor([]);
  const observer = new Observer({ store, executor: exec });
  const scan = () => scanOnce(store, {
    adapter: claudeCodeAdapter, root, onTurns: (ctx) => observer.handleTurns(ctx),
  });

  writeFileSync(file, jsonl("ilk", "u1", "2026-08-11T10:00:00.000Z"));
  await scan();
  // Yeni turn'ler + fork'un yeniden yazdığı ESKİ satır (aynı uuid, aynı damga).
  appendFileSync(file, jsonl("yeni-1", "u2", "2026-08-11T10:00:00.000Z"));
  appendFileSync(file, jsonl("yeni-2", "u3", "2026-08-11T09:59:59.000Z"));
  appendFileSync(file, jsonl("ilk", "u1", "2026-08-11T10:00:00.000Z"));
  await scan();

  const prompts = exec.calls.map((c) => c.prompt).join("\n");
  assert.ok(prompts.includes("yeni-1"), "eşit damgalı yeni turn kayboldu");
  assert.ok(prompts.includes("yeni-2"), "geri damgalı yeni turn kayboldu");

  // Üçüncü tarama: dosya değişmedi → hiç iş yok (imleç ve filigran hizalı).
  const öncesi = exec.calls.length;
  await scan();
  assert.equal(exec.calls.length, öncesi, "değişmeyen dosya yeniden ücretlendirildi");

  // Ve filigran dosyanın sonunda: bir sonraki turn ilerideki baytlardan gelecek.
  const wmOfset = store.get<{ byte_offset: number }>(
    "SELECT byte_offset FROM observer_watermarks LIMIT 1",
  )?.byte_offset;
  assert.equal(wmOfset, statSync(file).size);
  store.close();
});

// ── cli --session: her koşumda her şeyi yeniden göndermek ───────────────────

/**
 * PATH'e konan sahte `codex`. Gerçek CLI yolunu (süreç, kapılar, yürütücü
 * sözleşmesi) olduğu gibi koşturur, yalnız modeli ikame eder — `--session`
 * kusuru CLI'ın KENDİ yolunda ölçülmezse yakalanmıyor: kütüphane çağrısı
 * dosyayı hiç okumuyor.
 */
function fakeCodexDir(logPath: string): string {
  const dir = tmpDir("cp-v3-bin-");
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("codex-cli 0.146.0"); process.exit(0); }
const out = a[a.indexOf("-o") + 1];
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, "call\\n");
  fs.writeFileSync(out, JSON.stringify({ findings: [] }));
  process.exit(0);
});
`);
  chmodSync(bin, 0o755);
  return dir;
}

test("[cli --session] değişmemiş oturum ikinci koşumda YENİDEN gönderilmez", () => {
  // Eski hâl dosyayı her koşumda 0'dan okuyup elemeyi içerik kimliğine
  // bırakıyordu; aynı oturum her `observe --session` çağrısında baştan sona
  // Codex'e gidiyordu — doğrudan para. Filigran bir bayt ofseti olduğu için
  // okuma artık ondan başlıyor.
  const dir = tmpDir("cp-v3-cli-");
  const projDir = join(dir, "-tmp-cp-v3-proje");
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, "0195c0de-0000-4000-8000-000000000001.jsonl");
  writeFileSync(file, jsonl("ilk soru", "u1", "2026-08-11T10:00:00.000Z"));
  const storePath = join(dir, "s.db");
  const log = join(dir, "cagrilar.log");

  const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");
  const run = () => spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", cliPath, "observe", "--session", file, "--store", storePath],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${fakeCodexDir(log)}:${process.env.PATH}` } },
  );
  const cagri = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);

  const ilk = run();
  assert.equal(ilk.status, 0, `${ilk.stdout}\n${ilk.stderr}`);
  assert.match(ilk.stdout, /yeni turn: 1/);
  assert.equal(cagri(), 1, "ilk koşum modele hiç gitmedi (önkoşul)");

  const ikinci = run();
  assert.equal(ikinci.status, 0, `${ikinci.stdout}\n${ikinci.stderr}`);
  assert.match(ikinci.stdout, /yeni turn: 0/, "değişmemiş oturum yeniden 'yeni' sayıldı");
  assert.equal(cagri(), 1, "aynı oturum ikinci kez ücretlendirildi");

  // Ve yeni satır eklenince YALNIZ o gidiyor: eleme çalışıyor, iş durmuyor.
  appendFileSync(file, jsonl("ikinci soru", "u2", "2026-08-11T09:00:00.000Z"));
  const ucuncu = run();
  assert.equal(ucuncu.status, 0, `${ucuncu.stdout}\n${ucuncu.stderr}`);
  assert.match(ucuncu.stdout, /yeni turn: 1/, "eklenen turn görülmedi");
  assert.equal(cagri(), 2);
});
