// M3 denetimi — C dalgası: `audit`in CLI/orkestrasyon tarafı. Her test bir
// denetim bulgusunun iddiasını sabitler; iddia geri alınırsa test kırılır.
//
// Bulgular (2026-08-11 denetim turu, probe'ları .delegate-runs altında):
//   1 audit'in maliyet kapısı yok                  → audit-unbounded-calls.sh, audit-paid-call-gate.sh
//   2 transcript verisi fetch hedefini seçiyor     → transcript-cwd-fetch.sh
//   3 yarım denetim "temiz" görünüyor              → audit-kill-leaves-active.sh
//   4 import okuma hataları insan çıktısında yok   → import-errors-hidden.sh
//   5 ölçüm arızası hiçbir yere yazılmıyor         → A dalgası devri
//   6 geçersiz --origin-ref sessizce yutuluyor     → mimar ölçümü
//   7 olay günlüğü koşumlar arası ayrıştırılamıyor → mimar ölçümü

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync, rmSync, existsSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openStore } from "../src/store/db.ts";
import {
  auditProject, OriginRefUnresolved, MAX_MEASUREMENT_EVENTS_PER_AUDIT,
} from "../src/audit.ts";
import { appendFinding } from "../src/store/findings.ts";
import { countEvents, listEvents } from "../src/store/events.ts";
import {
  DEFAULT_CALL_BUDGET, WORST_CASE_CALLS_PER_AUDIT,
  estimateAuditCalls, auditCostGate, SpendBudget, auditBudgetExhaustedMessage,
} from "../src/observe-cmd.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";

const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");
const node = process.execPath;

const gitIn = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

/** realpathSync şart: macOS'ta $TMPDIR sembolik bağ, git kökü çözerek döner. */
function initRepo(prefix: string): string {
  const repo = realpathSync(tmpDir(prefix));
  gitIn(repo, "init", "-q");
  gitIn(repo, "config", "user.email", "t@t");
  gitIn(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-qm", "ilk");
  return repo;
}

function memoryDirWith(files: Record<string, string>): string {
  const dir = tmpDir("cp-m3-mem-");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/**
 * Sahte codex + sahte git tek dizinde. codex: `--version`e sürüm, exec'e şemaya
 * uyan boş verdict listesi, ve HER exec çağrısını `callLog`a yazar — "onaysız
 * kaç ücretli çağrı yapıldı" ancak böyle ölçülebiliyor. git: `-C <dir>` biçimini
 * anlar, `rev-parse` cevaplar, geri kalanı reddeder; her çağrı `gitLog`a düşer.
 */
function fakeBinDir(opts: { callLog?: string; gitLog?: string; codexSleep?: number; codexMarker?: string } = {}): string {
  const dir = tmpDir("cp-m3-bin-");
  const codex = join(dir, "codex");
  writeFileSync(codex, [
    "#!/bin/sh",
    '[ "$1" = "--version" ] && { echo "codex-cli 0.146.0"; exit 0; }',
    opts.callLog ? `printf 'call\\n' >> ${JSON.stringify(opts.callLog)}` : "",
    opts.codexMarker ? `printf 'exec\\n' > ${JSON.stringify(opts.codexMarker)}` : "",
    opts.codexSleep ? `sleep ${opts.codexSleep}` : "",
    "out=",
    'while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; out=$1; fi; shift; done',
    "cat >/dev/null",
    `printf '{"verdicts":[]}' > "$out"`,
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(codex, 0o755);

  if (opts.gitLog !== undefined) {
    const git = join(dir, "git");
    writeFileSync(git, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(opts.gitLog)}`,
      // `git -C <dir> <alt komut> …` → $3 alt komut.
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then printf \'%s\\n\' "$2"; exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then printf \'%040d\\n\' 1; exit 0; fi',
      'if [ "$3" = "fetch" ]; then exit 0; fi',
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(git, 0o755);
  }
  return dir;
}

const DURUM_NOTE = "DURUM: iş sürüyor, `src/live.ts` üzerinde çalışılıyor.";

// ── 1. Maliyet kapısı — saf yüzey ───────────────────────────────────────────
// Ölçüldü: bu makinede 11 hafıza dizininin 11'i de çelişki adayı üretiyor
// (123 aday), yani "kaç proje" tahmini boş bir korku değil.

test("audit maliyet tahmini: proje başına EN KÖTÜ 3 yürütücü koşumu sayılır", () => {
  assert.equal(WORST_CASE_CALLS_PER_AUDIT, 3, "classify.ts kurtarma yolu: ilk + tekrar + JSON düzeltme");
  const est = estimateAuditCalls(11);
  assert.equal(est.expected, 11);
  assert.equal(est.worst, 33, "11 proje onaysız 33 ücretli çağrıya kadar gidebiliyordu");
});

test("audit maliyet kapısı: onaysız tavanı aşan proje sayısı REDDEDİLİR, --yes geçirir", () => {
  const az = auditCostGate(6, false);
  assert.equal(az.ok, true, "6 proje → en kötü 18 çağrı, tavanın altında");

  const cok = auditCostGate(7, false);
  assert.equal(cok.ok, false, "7 proje → en kötü 21 çağrı, onaysız geçmemeli");
  assert.match(cok.reason!, /--yes/, "kullanıcıya nasıl onaylayacağı söylenmeli");
  assert.match(cok.reason!, new RegExp(String(DEFAULT_CALL_BUDGET)));
  assert.match(cok.reason!, /7 proje/, "tahmin ekranda: kapı keyfî görünmesin");

  assert.equal(auditCostGate(100, true).ok, true, "--yes harcamayı onaylar");
});

test("audit sert tavanı: en kötü durum sığmıyorsa yeni proje BAŞLAMAZ", () => {
  const b = new SpendBudget(DEFAULT_CALL_BUDGET);
  let started = 0;
  // Tahmin yanılabilir, tavan yanılmaz: her proje 3 çağrı harcasa bile toplam
  // hiçbir zaman tavanı aşmamalı.
  while (b.canAfford(WORST_CASE_CALLS_PER_AUDIT)) {
    started++;
    b.spend(WORST_CASE_CALLS_PER_AUDIT);
  }
  assert.equal(started, 6, "20 tavanında en kötü 3'lük 6 proje sığar");
  assert.ok(b.spent <= DEFAULT_CALL_BUDGET, `tavan aşıldı: ${b.spent}`);

  const sinirsiz = new SpendBudget(undefined);
  sinirsiz.spend(1000);
  assert.equal(sinirsiz.canAfford(3), true, "--yes yolunda tavan yok");

  const msg = auditBudgetExhaustedMessage(18, 6, 11, DEFAULT_CALL_BUDGET);
  assert.match(msg, /YARIDA/i, "yarım iş rc=0 ile sessizce bitmez");
  assert.match(msg, /--yes/);
  assert.match(msg, /6\/11|6 \/ 11/, "kaç projenin denetlendiği yazılı olmalı");
});

// ── 2. Denetim olayları: koşum kimliği + yaşam döngüsü ──────────────────────
// Ölçüldü: import bir transaction'da, skorlar çok sonra başkasında commit
// ediliyor; arada süreç ölürse not `active`/skor 0 kalıyor ve bu "ölçüldü,
// temiz çıktı"dan AYIRT EDİLEMİYOR. Node varsayılanı SIGINT/SIGTERM'de finally
// bloklarını koşturmuyor (rc=130/143), yani Ctrl-C tam bu durumu üretiyor.

function setupProject(memory: Record<string, string>, repo: string) {
  const memoryDir = memoryDirWith(memory);
  const store = openStore(":memory:");
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    repo, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  return { store, project: { id, path: repo, memoryDir } };
}

test("audit_started ÖLÇÜMDEN ÖNCE yazılır, audit_completed sonunda", async () => {
  const repo = initRepo("cp-m3-repo-");
  const { store, project } = setupProject({ "n.md": DURUM_NOTE }, repo);
  const sum = await auditProject(store, project, {
    executor: fakeExecutor([{ output: '{"verdicts":[]}' }]), fetch: false, runId: "R1",
  });

  const kinds = listEvents(store, { limit: 200 }).reverse().map((e) => e.kind);
  assert.ok(kinds.includes("audit_started"), "yarım denetim ancak başlangıç kaydıyla ayırt edilebilir");
  assert.ok(kinds.includes("audit_completed"));
  assert.ok(
    kinds.indexOf("audit_started") < kinds.indexOf("signal_scored"),
    "başlangıç kaydı ölçümden SONRA yazılırsa yarım koşumda hiç yazılmaz",
  );
  assert.ok(
    kinds.indexOf("audit_completed") > kinds.indexOf("signal_scored"),
    "tamamlandı kaydı yazımdan sonra gelmeli",
  );
  assert.equal(sum.runId, "R1");
  store.close();
});

test("koşum kimliği: ardışık koşumların olayları ayrıştırılabiliyor (mükerrer sayım ölçümü bozuyordu)", async () => {
  const repo = initRepo("cp-m3-repo2-");
  const { store, project } = setupProject({
    "a.md": "`ortakSembolYok` hakkında: ölçüm X der.",
    "b.md": "`ortakSembolYok` hakkında: ölçüm X demez.",
  }, repo);
  const celiski = () => fakeExecutor([
    { output: '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"zıt ölçüm"}]}' },
  ]);

  await auditProject(store, project, { executor: celiski(), fetch: false, runId: "kosum-1" });
  await auditProject(store, project, { executor: celiski(), fetch: false, runId: "kosum-2" });

  // Ölçüldü: üç ardışık BAŞARILI koşum contradiction_confirmed'i 1→2→3 yazıyor.
  // Toplam sayı hâlâ birikiyor (yeniden faturalandırma ayrı bir tasarım kararı);
  // düzeltilen şey "BU koşumda kaç çelişki onaylandı"nın sayılabilir olması.
  assert.equal(countEvents(store, "contradiction_confirmed"), 2, "günlük hâlâ append-only");
  const perRun = (runId: string) =>
    listEvents(store, { kind: "contradiction_confirmed", limit: 100 })
      .filter((e) => JSON.parse(e.detail!).runId === runId).length;
  assert.equal(perRun("kosum-1"), 1);
  assert.equal(perRun("kosum-2"), 1);

  for (const kind of ["audit_started", "audit_completed", "signal_scored"]) {
    const detay = listEvents(store, { kind, limit: 100 }).map((e) => JSON.parse(e.detail!).runId);
    assert.ok(detay.every((r) => r === "kosum-1" || r === "kosum-2"), `${kind} koşum kimliği taşımıyor`);
  }
  store.close();
});

test("--origin-ref çözülemezse GÜRÜLTÜLÜ hata: sessizce yalnız HEAD'e karşı koşmaz", async () => {
  const repo = initRepo("cp-m3-origin-");
  const { store, project } = setupProject({ "n.md": DURUM_NOTE }, repo);
  await assert.rejects(
    () => auditProject(store, project, {
      executor: null, fetch: false, originRef: "--upload-pack=touch /tmp/x", runId: "R",
    }),
    OriginRefUnresolved,
    "altın set ölçümü tam da bu pine dayanıyor: sessiz düşüş ölçümü geçersiz kılar",
  );
  assert.equal(countEvents(store, "audit_failed"), 1, "başarısız denetim depodan okunabilmeli");
  store.close();
});

test("ölçüm arızası olaya yazılır ve TAVANLA sınırlanır (bozuk repoda not×çapa patlaması)", async () => {
  // Bozuk repo: alt ağaç nesnesi silinmiş → `ls-tree` rc≠0, yani her dosya
  // çapası ölçülemez. A dalgası bunu `unverifiable` yaptı; C dalgası görünür.
  const repo = realpathSync(tmpDir("cp-m3-corrupt-"));
  gitIn(repo, "init", "-q");
  gitIn(repo, "config", "user.email", "t@t");
  gitIn(repo, "config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-qm", "ilk");
  const subtree = gitIn(repo, "rev-parse", "HEAD:src");
  const objPath = join(repo, ".git", "objects", subtree.slice(0, 2), subtree.slice(2));
  assert.ok(existsSync(objPath), "fixture geçersiz: alt ağaç loose nesne değil");
  rmSync(objPath, { force: true });

  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    repo, "claude-code", "/t",
  ).lastInsertRowid);
  const toplam = MAX_MEASUREMENT_EVENTS_PER_AUDIT + 4;
  for (let i = 0; i < toplam; i++)
    appendFinding(store, {
      projectId, source: "imported", content: `not ${i}`,
      anchors: [{ kind: "file_path", value: `src/a.ts` }],
    });

  const sum = await auditProject(store, { id: projectId, path: repo, memoryDir: null }, {
    executor: null, fetch: false, runId: "R",
  });
  assert.equal(sum.measurementFailures, toplam, "özet arızayı saymalı — CLI oradan basıyor");
  assert.equal(countEvents(store, "anchor_measurement_failed"), MAX_MEASUREMENT_EVENTS_PER_AUDIT,
    "tavan yoksa bozuk repo events tablosunu şişirir (silinemez tablo)");
  assert.equal(countEvents(store, "anchor_measurement_overflow"), 1, "taşan sayı tek özet satırıyla sayılmalı");
  const overflow = JSON.parse(listEvents(store, { kind: "anchor_measurement_overflow" })[0]!.detail!);
  assert.equal(overflow.suppressed, 4);
  const ilk = JSON.parse(listEvents(store, { kind: "anchor_measurement_failed" })[0]!.detail!);
  assert.match(ilk.command, /ls-tree/, "hangi komutun ölçemediği yazılı olmalı");
  assert.ok(typeof ilk.reason === "string" && ilk.reason.length > 0);
  store.close();
});

// ── 3. CLI ──────────────────────────────────────────────────────────────────

function runCli(args: string[], binDir: string) {
  return spawnSync(node, ["--disable-warning=ExperimentalWarning", cliPath, ...args], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${binDir}:${process.env["PATH"]}` },
  });
}

test("[cli] onaysız çok projeli audit TEK ücretli çağrı yapmadan durur", () => {
  const dir = tmpDir("cp-m3-gate-");
  const callLog = join(dir, "codex.calls");
  writeFileSync(callLog, "");
  const storePath = join(dir, "store.db");
  const store = openStore(storePath);
  // 25 proje, her birinde DURUM kalıplı tek not: ölçüldü, bu kalıp tek başına
  // aday doğuruyor — yani 25 proje 25 ücretli sınıflama koşumu demek.
  for (let i = 0; i < 25; i++) {
    const id = Number(store.run(
      "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
      `/yok/proje-${i}`, "claude-code", "/t",
    ).lastInsertRowid);
    appendFinding(store, { projectId: id, source: "imported", content: DURUM_NOTE, anchors: [] });
  }
  store.close();

  const r = runCli(["audit", "--store", storePath], fakeBinDir({ callLog }));
  assert.equal(r.status, 3, `onay gerektiren koşum rc=3 dönmeli\n${r.stdout}\n${r.stderr}`);
  assert.equal(execFileSync("wc", ["-l", callLog], { encoding: "utf8" }).trim().split(/\s+/)[0], "0",
    "kapı kapalıyken hiçbir ücretli çağrı yapılmamalı");
  assert.match(r.stderr + r.stdout, /maliyet/i);
  assert.match(r.stdout, /25/, "koşum öncesi tahmin ekranda olmalı");
});

test("[cli] fetch varsayılan KAPALI; --fetch açıkça verilince hedef repo BASILIR", () => {
  const dir = tmpDir("cp-m3-fetch-");
  const gitLog = join(dir, "git.log");
  writeFileSync(gitLog, "");
  const bin = fakeBinDir({ gitLog });
  const memoryDir = memoryDirWith({ "n.md": DURUM_NOTE });
  const hedef = join(dir, "transcript-secti");
  mkdirSync(hedef);

  // Ölçüldü: hedef repo transcript'teki `cwd` alanından geliyor ve o reponun
  // .git/config'i fetch sırasında keyfî yerel komut çalıştırabiliyor. Yani
  // varsayılan fetch, güvenilmeyen veriyle seçilmiş bir repoda kod koşturuyor.
  const kapali = runCli(["audit", "--path", hedef, "--memory-dir", memoryDir, "--store", join(dir, "s1.db")], bin);
  assert.equal(kapali.status, 0, `${kapali.stdout}\n${kapali.stderr}`);
  const log1 = execFileSync("cat", [gitLog], { encoding: "utf8" });
  assert.ok(!/ fetch /.test(` ${log1.replace(/\n/g, " ")} `), `varsayılanda fetch koşmamalı:\n${log1}`);

  writeFileSync(gitLog, "");
  const acik = runCli(["audit", "--path", hedef, "--memory-dir", memoryDir, "--fetch", "--store", join(dir, "s2.db")], bin);
  assert.equal(acik.status, 0, `${acik.stdout}\n${acik.stderr}`);
  assert.match(execFileSync("cat", [gitLog], { encoding: "utf8" }), /fetch/, "--fetch verildiyse koşmalı");
  assert.ok(acik.stdout.includes(hedef), "fetch AÇIKKEN hangi repoda koşulacağı kullanıcıya basılmalı");
  assert.match(acik.stdout, /fetch/i);
});

test("[cli] import okuma arızası insan çıktısında görünür; status onu sayar", () => {
  const dir = tmpDir("cp-m3-imperr-");
  const storePath = join(dir, "store.db");
  const bin = fakeBinDir({});
  const hedef = join(dir, "proje");
  mkdirSync(hedef);

  // Ölçüldü: okunamayan dizin ile boş-ama-okunabilir dizin BAYT BAYT aynı
  // çıktıyı veriyordu (`import: +0 ~0 -0 (değişmeyen 0)`, rc=0).
  const r = runCli(["audit", "--path", hedef, "--memory-dir", join(dir, "yok"), "--store", storePath], bin);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /okunama\w*[^0-9]*1/i, "okuma arızası insan kipinde görünmeli");

  const bos = tmpDir("cp-m3-bos-");
  const r2 = runCli(["audit", "--path", hedef, "--memory-dir", bos, "--store", join(dir, "s2.db")], bin);
  assert.notEqual(r.stdout, r2.stdout, "arızalı dizin ile boş dizin aynı çıktıyı vermemeli");

  const st = runCli(["status", "--store", storePath], bin);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /import/i, "status import olaylarını hiç saymıyordu");
  assert.match(st.stdout, /okunama\w*[^0-9]*1/i);
});

test("[cli] SIGINT: kilit bırakılır ve yarım denetim depoda audit_failed olarak durur", async () => {
  const dir = tmpDir("cp-m3-sigint-");
  const storePath = join(dir, "store.db");
  const marker = join(dir, "codex-basladi");
  const bin = fakeBinDir({ codexSleep: 20, codexMarker: marker });
  const memoryDir = memoryDirWith({ "n.md": DURUM_NOTE });
  const hedef = join(dir, "proje");
  mkdirSync(hedef);

  const child = spawn(node, ["--disable-warning=ExperimentalWarning", cliPath, "audit",
    "--path", hedef, "--memory-dir", memoryDir, "--store", storePath], {
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` }, stdio: "ignore",
  });
  const bitti = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));

  // Sınıflama gerçekten başlayana kadar bekle: erken SIGINT hiçbir şey kanıtlamaz.
  for (let i = 0; i < 200 && !existsSync(marker); i++) await sleep(50);
  assert.ok(existsSync(marker), "sahte codex hiç çağrılmadı: senaryo kurulmadı");

  child.kill("SIGINT");
  const code = await bitti;
  assert.equal(code, 130, "SIGINT kabuk sözleşmesiyle 128+2 dönmeli");

  const store = openStore(storePath);
  assert.equal(store.get<{ n: number }>("SELECT COUNT(*) n FROM scan_lock")!.n, 0,
    // İddia aynı, gerekçesi güncel: ölü sahip artık HEMEN devralınıyor (lock.ts),
    // yani asılı kilit kalıcı bir tıkanma değil. Yine de temiz kapanış şart —
    // devralma bir `scan_lock_stolen` olayı yazar ve düzgün kapanmış bir
    // denetimin ardından o soru günlüğe hiç düşmemeli.
    "düzgün kapanışta kilit bırakılmalı: aksi hâlde sonraki koşum devralmak zorunda kalır");
  assert.equal(countEvents(store, "audit_started"), 1);
  assert.equal(countEvents(store, "audit_completed"), 0, "denetim bitmedi");
  assert.equal(countEvents(store, "audit_failed"), 1, "yarım denetim 'ölçüldü, temiz' ile karışmamalı");
  assert.match(JSON.parse(listEvents(store, { kind: "audit_failed" })[0]!.detail!).reason, /SIGINT/);
  store.close();
});
