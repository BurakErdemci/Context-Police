// Görev 10: denetim orkestrasyonu. Uçtan uca testler — gerçek geçici git
// reposu + sahte yürütücü. Sinyal modüllerinin kendi testleri ayrı (Görev 5-9);
// burada sınanan şey BAĞLANTI: import → sinyal → skor → status → olay.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { auditProject } from "../src/audit.ts";
import { getFinding, listActive } from "../src/store/findings.ts";
import { countEvents, listEvents } from "../src/store/events.ts";
import { acquireScanLock, releaseScanLock } from "../src/store/lock.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";

let repo: string;
before(() => {
  repo = tmpDir("cp-audit-");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "silinecek.ts"), "export const a = 1;\n");
  git("add", "-A"); git("commit", "-qm", "ilk");
  rmSync(join(repo, "src", "silinecek.ts"));
  git("add", "-A"); git("commit", "-qm", "silindi");
});

const CURUK = "---\nname: curuk\nmodified: 2020-01-01T00:00:00.000Z\n---\n" +
  "DURUM: iş sürüyor. `src/silinecek.ts` üzerinde çalışılıyor, henüz bitmedi.";
const TEMIZ = "---\nname: temiz\n---\nKarar: adapter seam'i gün birden. Gerekçe: sonradan pahalı.";

function setup(memory: Record<string, string>) {
  const memoryDir = tmpDir("cp-mem-");
  for (const [name, content] of Object.entries(memory)) writeFileSync(join(memoryDir, name), content);
  const store = openStore(":memory:");
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    repo, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  return { store, memoryDir, project: { id, path: repo, memoryDir } };
}

test("uçtan uca: DURUM'lu + silinmiş-çapalı not suspect olur, temiz not olmaz, dosyaya yazılmaz (K9)", async () => {
  const { store, project } = setup({ "curuk.md": CURUK, "temiz.md": TEMIZ });
  const sum = await auditProject(store, project, { executor: fakeExecutor([
    { output: '{"verdicts":[]}' },
  ]), fetch: false });

  assert.equal(sum.gitAvailable, true);
  assert.equal(sum.import!.added, 2);
  const all = listActive(store, project.id);
  const curuk = all.find((f) => f.content.includes("DURUM"))!;
  const temiz = all.find((f) => f.content.includes("Karar"))!;
  assert.equal(curuk.status, "suspect");
  assert.ok(curuk.suspicion >= 0.6);
  // Çapasız not unanchored'a düşer ve NÖTRDÜR (M0-D5): suspect olmaz, skor almaz.
  assert.equal(temiz.status, "unanchored");
  assert.equal(temiz.suspicion, 0);
  assert.equal(countEvents(store, "signal_scored"), 1); // yalnız curuk skorlandı; unanchored döngüye girmez
  store.close();
});

// Görev 11'in "%10 uydurma çapa" ölçümü YALNIZ bu sayımdan okunabiliyor:
// never_existed ve unverifiable şüphe skoru üretmediği için `reasons`ta hiç
// görünmüyorlar (anchor-drift WEIGHT tablosu onlara ağırlık vermiyor).
test("çapa durum sayımı özette ve signal_scored olayında taşınıyor (M2 borcunun ölçüsü)", async () => {
  const { store, project } = setup({
    "curuk.md": CURUK,
    "uydurma.md": "Not: `hicVarOlmayanSembol` diye bir şey vardı, ve `src/hic-olmadi.ts` dosyası.",
  });
  const sum = await auditProject(store, project, { executor: fakeExecutor([{ output: '{"verdicts":[]}' }]), fetch: false });

  assert.equal(sum.anchorStates.missing_now, 1, "gerçekten silinmiş dosya");
  assert.equal(sum.anchorStates.never_existed, 1, "hiç var olmamış yol");
  assert.equal(sum.anchorStates.unverifiable, 1, "geçmişte izi olmayan sembol");
  assert.equal(sum.anchorStates.symbol_lost, 0);
  assert.equal(sum.anchorStates.ok, 0);

  const detaylar = listEvents(store, { kind: "signal_scored" }).map((e) => JSON.parse(e.detail!));
  const uydurma = detaylar.find((d) => d.states.never_existed === 1)!;
  assert.deepEqual(uydurma.states, { never_existed: 1, unverifiable: 1 }, "sıfır olan durumlar yazılmaz");
  assert.equal(uydurma.score, 0.3, "never_existed suçlar ama tek başına eşiği aşmaz");
  // Ve o skoru üreten tek çapa reasons'ta; unverifiable orada YOK — sayım
  // olmasaydı bu bulgunun 2 çapasından birinin doğrulanamadığı görünmezdi.
  assert.equal(uydurma.reasons.length, 1);
  store.close();
});

test("çelişki onayı iki tarafı da eşik üstüne çıkarır", async () => {
  const { store, project } = setup({
    "a.md": "`ortakBirSembolYok` hakkında: ölçüm X der.",
    "b.md": "`ortakBirSembolYok` hakkında: ölçüm X demez.",
  });
  const sum = await auditProject(store, project, { executor: fakeExecutor([
    { output: '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"zıt ölçüm"}]}' },
  ]), fetch: false });
  assert.equal(sum.contradictions, 1);
  for (const f of listActive(store, project.id)) {
    assert.equal(f.status, "suspect");
    assert.ok(f.suspicion >= 0.6);
  }
  assert.equal(countEvents(store, "contradiction_confirmed"), 1);
  store.close();
});

test("yeniden hesap: skor düşen suspect active'e döner (D-M3-9); koşum idempotent (D-M3-3)", async () => {
  const { store, project } = setup({ "n.md": "sade kalıcı not, çapasız değil: `birSembol` anılıyor." });
  const exec = () => fakeExecutor([{ output: '{"verdicts":[]}' }]);
  await auditProject(store, project, { executor: exec(), fetch: false });
  const [f1] = listActive(store, project.id);
  // elle suspect'e it (sanki önceki koşum şüphelenmişti)
  store.run("UPDATE findings SET status = 'suspect', suspicion = 0.9 WHERE id = ?", f1!.id);
  await auditProject(store, project, { executor: exec(), fetch: false });
  const f2 = getFinding(store, f1!.id)!;
  assert.equal(f2.status, "active");        // sinyal yok → temize döndü
  assert.ok(f2.suspicion < 0.6);            // skor sıfırdan hesaplandı, birikmedi
  assert.equal(countEvents(store, "finding_cleared"), 1);
  store.close();
});

test("git olmayan proje: anchor kapalı, çelişki koşar, olay düşer (D-M3-7)", async () => {
  const memoryDir = tmpDir("cp-mem-");
  writeFileSync(join(memoryDir, "n.md"), "---\ndescription: özet\n---\ngövde");
  const store = openStore(":memory:");
  const nogit = tmpDir("cp-nogit-");
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    nogit, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  const sum = await auditProject(store, { id, path: nogit, memoryDir }, {
    executor: fakeExecutor([{ output: '{"verdicts":[]}' }]), fetch: false,
  });
  assert.equal(sum.gitAvailable, false);
  assert.equal(countEvents(store, "anchor_signal_disabled"), 1);
  assert.equal(sum.candidates, 1); // frontmatter yüzeyi yine de adaydı
  store.close();
});

// M0-D5'in nötrlüğü ÇAPA SİNYALİNE özgü: "çapasız not kod hareketiyle çürüyemez".
// Çelişki çapadan bağımsız, içsel bir sinyal (spec §3.4: iki taraftan en az biri
// yanlış) — yani denetlenemez sayılan notu denetlenebilir kılıyor. Mimar kararı,
// Görev 10 düzeltme turu.
test("çelişki çapasız notu DA yükseltir; çözülünce active'e değil unanchored'a döner", async () => {
  const { store, project } = setup({
    // Çapa üretmeyen not: backtick'li sembol, uzantılı yol ve hex dizi yok.
    "celiskili.md": "---\ndescription: teslim yolu A üzerinden gidiyor\n---\n" +
      "Ölçüldü: teslim yolu A üzerinden GİTMİYOR, B üzerinden gidiyor.",
  });

  const onceki = listActive(store, project.id);
  assert.equal(onceki.length, 0, "önkoşul: depo boş");

  const sum = await auditProject(store, project, {
    executor: fakeExecutor([{ output: '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"özet gövdeyi yalanlıyor"}]}' }]),
    fetch: false,
  });
  assert.equal(sum.candidates, 1, "frontmatter ↔ gövde yüzeyi");
  assert.equal(sum.contradictions, 1);
  assert.equal(sum.checked, 0, "çapa sinyali çapasız nota hiç dokunmadı — nötrlük duruyor");

  const [f1] = listActive(store, project.id);
  assert.equal(f1!.status, "suspect", "çapasız not çelişkiyle şüpheliye geçmeli");
  assert.ok(f1!.suspicion >= 0.6);

  // İkinci koşum: çelişki onayı gelmiyor → skor sıfırdan hesaplanıyor ve not
  // ÇAPASIZ olduğu için `active`e değil `unanchored`a dönüyor. `active` olsaydı
  // M0-D5 sınıflaması kalıcı kaybolurdu: hiçbir çapa sinyalinin denetleyemediği
  // bir not "denetleniyor" görünürdü.
  const sum2 = await auditProject(store, project, {
    executor: fakeExecutor([{ output: '{"verdicts":[{"index":0,"verdict":"uyumlu","evidence":"aynı şeyi söylüyorlar"}]}' }]),
    fetch: false,
  });
  assert.equal(sum2.contradictions, 0);
  assert.equal(sum2.cleared, 1);
  const f2 = getFinding(store, f1!.id)!;
  assert.equal(f2.status, "unanchored", "çapasız not active'te sıkışmamalı");
  assert.equal(f2.suspicion, 0);
  assert.equal(countEvents(store, "finding_suspect"), 1);
  assert.equal(countEvents(store, "finding_cleared"), 1);
  store.close();
});

test("çapası olan not temize dönerken active'e döner (unanchored'a değil)", async () => {
  const { store, project } = setup({ "n.md": "sade kalıcı not, çapasız değil: `birSembol` anılıyor." });
  await auditProject(store, project, { executor: fakeExecutor([{ output: '{"verdicts":[]}' }]), fetch: false });
  const [f1] = listActive(store, project.id);
  store.run("UPDATE findings SET status = 'suspect', suspicion = 0.9 WHERE id = ?", f1!.id);
  await auditProject(store, project, { executor: fakeExecutor([{ output: '{"verdicts":[]}' }]), fetch: false });
  assert.equal(getFinding(store, f1!.id)!.status, "active", "çapa varlığı hedef durumu belirliyor");
  store.close();
});

test("hiç çelişkiye girmemiş çapasız nota HİÇ dokunulmaz: skor da olay da yazılmaz", async () => {
  const { store, project } = setup({ "temiz.md": TEMIZ });
  await auditProject(store, project, { executor: fakeExecutor([{ output: '{"verdicts":[]}' }]), fetch: false });
  const [f] = listActive(store, project.id);
  assert.equal(f!.status, "unanchored");
  assert.equal(f!.suspicion, 0);
  assert.equal(countEvents(store, "signal_scored"), 0, "skor kaydı olmayan not olay da üretmez");
  store.close();
});

test("sınıflama başarısızlığı yutulmaz: olay düşer, çapa sinyali koşmaya devam eder", async () => {
  const { store, project } = setup({ "curuk.md": CURUK });
  const sum = await auditProject(store, project, {
    executor: fakeExecutor([{ ok: false, error: "kaynak yok" }, { ok: false, error: "kaynak yok" }]),
    fetch: false,
  });
  assert.equal(sum.classified, false, "'çelişki yok' ile 'bakılamadı' ayrı");
  assert.equal(sum.contradictions, 0);
  assert.equal(sum.classifyCalls, 2, "yürütücü tekrarı da aynı sayaçta (Görev 9 şerhi)");
  assert.equal(countEvents(store, "classify_failed"), 1);
  // Çapa sinyali sınıflamadan bağımsız: not yine de şüpheli.
  assert.equal(listActive(store, project.id)[0]!.status, "suspect");
  store.close();
});

// ── CLI ────────────────────────────────────────────────────────────────────

/** Sahte codex: --version'a sürüm, exec'e şemaya uyan boş verdict listesi. */
function fakeCodexDir(): string {
  const dir = tmpDir("cp-audit-bin-");
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("codex-cli 0.146.0"); process.exit(0); }
const out = a[a.indexOf("-o") + 1];
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  fs.writeFileSync(out, JSON.stringify({ verdicts: [] }));
  process.exit(0);
});
`);
  chmodSync(bin, 0o755);
  return dir;
}

// Kilit ZORUNLU (mimar kararı, Görev 4 ölçümü): import "en son canlı temsil"i
// okuyup yenisini yazıyor ve bu ikisi atomik değil — aynı anda koşan iki denetim
// aynı dosya için iki canlı kayıt bırakabilir.
test("[cli] audit tarama kilidini alır, bırakır; kilit doluyken başlamaz", () => {
  const dir = tmpDir("cp-audit-cli-");
  const memoryDir = join(dir, "memory");
  mkdirSync(memoryDir);
  writeFileSync(join(memoryDir, "curuk.md"), CURUK);
  writeFileSync(join(memoryDir, "temiz.md"), TEMIZ);
  const storePath = join(dir, "store.db");
  const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");

  const run = () => spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", cliPath, "audit",
      "--path", repo, "--memory-dir", memoryDir, "--no-fetch", "--store", storePath],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${fakeCodexDir()}:${process.env.PATH}` } },
  );

  const ilk = run();
  assert.equal(ilk.status, 0, `${ilk.stdout}\n${ilk.stderr}`);
  assert.match(ilk.stdout, /import: \+2/);
  assert.match(ilk.stdout, /denetlenen: 1 {2}şüpheli: 1/);
  assert.match(ilk.stdout, /codex çağrısı: 1/);
  assert.match(ilk.stdout, /çapa: ok 0 {2}kayıp 1/);
  assert.match(ilk.stdout, /🔶 #\d+ \(0\.70\)/);
  // "tek çağrı" iddiası hiçbir mesajda geçmez: sınıflama tekrar turlarıyla
  // birden çok gerçek koşum olabiliyor (Görev 9 şerhi).
  assert.ok(!/tek çağrı/i.test(ilk.stdout));

  // İkinci koşum ancak birincisi kilidi BIRAKTIYSA başlayabilir: sahibi ölmüş
  // bir kilit bile bir saat boyunca bayat sayılmıyor (lock.ts STALE_MS).
  const ikinci = run();
  assert.equal(ikinci.status, 0, `${ikinci.stdout}\n${ikinci.stderr}`);
  assert.match(ikinci.stdout, /import: \+0 ~0 -0 \(değişmeyen 2\)/, "değişmemiş not yeniden eklenmemeli");

  // Kilit CANLI bir sahipte (bu test süreci): denetim hiç başlamamalı.
  const store = openStore(storePath);
  acquireScanLock(store, `pid:${process.pid}`);
  store.close();
  const ucuncu = run();
  assert.notEqual(ucuncu.status, 0, "kilit doluyken denetim başlamamalı");
  assert.match(ucuncu.stderr, /başka bir tarama sürüyor/);

  const temizle = openStore(storePath);
  releaseScanLock(temizle, `pid:${process.pid}`);
  temizle.close();
  assert.ok(existsSync(storePath));
});
