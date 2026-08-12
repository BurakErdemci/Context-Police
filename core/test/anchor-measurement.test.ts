// Ölçüm arızası ≠ hüküm. Denetim bulgusunun (2026-08-11, error-path turu) kalıcı
// çiti: `git()` her istisnayı tek bir `{ok:false}`'a indiriyordu ve `checkAnchors`
// bunu `missing_now` (0.5) / `symbol_lost` (0.4) diye okuyordu. DURUM kalıplı bir
// notta bu 0.7 skor, yani `suspect` demek — ürünün TEK çıktısı bir hüküm olduğu
// için düpedüz yanlış suçlama.
//
// Buradaki iddialar iki denetim probe'undan terfi etti (probe repoya girmez,
// iddiası girer):
//   .delegate-runs/2026-08-11-audit-errorpath/probes/git-failure-becomes-verdict.sh
//   .delegate-runs/2026-08-11-audit-resource/probes/git-output-limit-false-decay.sh

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, chmodSync, realpathSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpDir, tmpStorePath } from "./helpers.ts";
import { openGit, classifyFailure, fileExistsAt, symbolExists, type GitContext } from "../src/signals/git.ts";
import { checkAnchors, scoreDrift, SUSPICION_THRESHOLD } from "../src/signals/anchor-drift.ts";
import { openStore } from "../src/store/db.ts";
import { logEvent, listEvents } from "../src/store/events.ts";

const EPOCH = "1970-01-01T00:00:00Z";
/** Churn'ü ölçümden ayırmak için: geleceğe bakan --since sıfır commit döner. */
const FUTURE = "2099-01-01T00:00:00Z";

const gitIn = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

function initRepo(prefix: string): string {
  // realpathSync şart: macOS'ta $TMPDIR bir sembolik bağ (/var → /private/var) ve
  // `git rev-parse --show-toplevel` bağı çözerek döner.
  const repo = realpathSync(tmpDir(prefix));
  gitIn(repo, "init", "-q");
  gitIn(repo, "config", "user.email", "t@t");
  gitIn(repo, "config", "user.name", "t");
  return repo;
}

// --- 1. GERÇEK REPRO: blobsuz klon + erişilemez promisor remote ---------------
// Çürütücünün shim'siz ürettiği senaryo. `--filter=blob:none` ile klonlanmış
// repoda blob nesneleri YOK; promisor remote erişilemezse blob'a dokunan her
// komut rc=128 verir. Eski kod `git cat-file -e HEAD:<yol>` kullanıyordu — o
// komut blob'u okumak zorunda, dolayısıyla DURAN bir dosya `missing_now` oluyordu.
// Ölçüldü (2026-08-11, git 2.50.1): aynı repoda `ls-tree` rc=0 döner, çünkü
// yalnız ağaç nesnelerine bakar; `rev-parse --show-toplevel` ve `log --diff-filter=A`
// de başarılıdır — yani `openGit` sorunsuz geçer ve sinyal AÇIK koşar.

let blobless: string | null = null;

before(() => {
  const work = realpathSync(tmpDir("cp-blobless-"));
  const origin = join(work, "origin");
  mkdirSync(origin);
  gitIn(origin, "init", "-q");
  gitIn(origin, "config", "user.email", "t@t");
  gitIn(origin, "config", "user.name", "t");
  gitIn(origin, "config", "uploadpack.allowFilter", "true"); // filtreli klon sunucu iznine bağlı
  writeFileSync(join(origin, "duran.ts"), "export const duran = 1;\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "ilk");

  const clone = join(work, "clone");
  // --no-checkout: checkout blob'ları çeker ve senaryoyu yok ederdi (ölçüldü —
  // ilk deneme bu yüzden sahte yeşil vermişti).
  execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", "--no-local",
    `file://${origin}`, clone], { encoding: "utf8", stdio: "pipe" });
  gitIn(clone, "remote", "set-url", "origin", "file:///cp-test-nonexistent-promisor");
  blobless = realpathSync(clone);
});

test("blobsuz klon + kırık promisor: DURAN dosya missing_now olmaz (gerçek repro)", async () => {
  const repo = blobless!;
  // Sahte yeşil çiti: senaryo ancak blob'lar GERÇEKTEN eksikse anlamlı.
  const missing = execFileSync("git", ["-C", repo, "rev-list", "--objects", "--all", "--missing=print"],
    { encoding: "utf8" });
  assert.match(missing, /^\?/m, "fixture geçersiz: blobsuz klon eksik nesne üretmedi");

  const ctx = await openGit(repo, { fetch: false });
  assert.ok(ctx, "openGit null döndü: senaryo artık 'sinyal kapalı' yolundan geçiyor, repro değil");

  const verdicts = await checkAnchors(ctx, [{ kind: "file_path", value: "duran.ts" }], FUTURE);
  assert.equal(verdicts[0]!.state, "ok", "duran dosya missing_now/unverifiable oldu");
  // DURUM kalıbı + missing_now eski kodda 0.7 veriyordu; şimdi eşiğin altında.
  const score = scoreDrift(verdicts, true).score;
  assert.ok(score < SUSPICION_THRESHOLD, `DURUM kalıplı not eşiği aştı: ${score}`);
});

// --- 2. BOZUK REPO: ölçüm arızası unverifiable, asla missing_now -------------
// Ağaç nesnesi silinmiş gerçek bir repo. Ölçüldü: `ls-tree` rc=1 +
// "error: Could not read <sha>" verir — yani rc=0'ın dışındaki HER şey arızadır,
// ve rc=0 + boş çıktı tek meşru "hayır"dır. (`rev-parse --verify --quiet` bu iş
// için kullanılamaz: aynı bozuk repoda sessizce rc=1 döner, yani gerçek arızayı
// "dosya yok" cevabından ayırt edilemez hâle getirir — ölçüldü.)

test("bozuk repo: ölçüm arızası unverifiable + measurementFailed, skor 0", async () => {
  const repo = initRepo("cp-corrupt-");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export function f() {}\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-qm", "ilk");
  const subtree = gitIn(repo, "rev-parse", "HEAD:src");
  const objPath = join(repo, ".git", "objects", subtree.slice(0, 2), subtree.slice(2));
  assert.ok(existsSync(objPath), "fixture geçersiz: alt ağaç loose nesne değil");
  rmSync(objPath, { force: true });

  const ctx = await openGit(repo, { fetch: false });
  assert.ok(ctx, "openGit null döndü: bozukluk sinyali kapattı, ölçüm yolu sınanmıyor");

  const verdicts = await checkAnchors(ctx, [{ kind: "file_path", value: "src/a.ts" }], EPOCH);
  assert.equal(verdicts[0]!.state, "unverifiable");
  assert.ok(verdicts[0]!.measurementFailed, "arıza iz bırakmadı: audit.ts olay yazamaz");
  assert.match(verdicts[0]!.measurementFailed!.command, /ls-tree/);

  // Skor: ölçülemeyen çapa katkı vermez, ama DURUM kalıbı tek başına eşik altında kalır.
  const drift = scoreDrift(verdicts, true);
  assert.ok(drift.score < SUSPICION_THRESHOLD, `arıza eşiği aştırdı: ${drift.score}`);
  assert.ok(drift.reasons.some((r) => r.includes("ölçülemedi")),
    `gerekçeler arızayı ayırt etmiyor: ${JSON.stringify(drift.reasons)}`);

  // git.ts katmanı: temiz "hayır" ile arıza aynı değere inmesin.
  const m = await fileExistsAt(ctx, "HEAD", "src/a.ts");
  assert.equal(m.ok, false);
});

// --- 3. SAHTE git binary'si: arıza sınıflarının tamamı -----------------------

let fakeBin: string | null = null;
let realPath: string | null = null;

/** Sentetik ctx: sahte git bir repo görmüyor, yalnız komutlara cevap veriyor. */
const FAKE_CTX: GitContext = { repoRoot: "/cp-synthetic", head: "abc1234", originRef: null };

before(() => {
  const dir = tmpDir("cp-fakegit-");
  const bin = join(dir, "git");
  // Alt komut KONUMDAN değil AYRIŞTIRILARAK bulunur. Eskiden `sub=$3` idi ve
  // `git -C <cwd> <subcmd>` dizilimini varsayıyordu; `--literal-pathspecs`
  // eklenince (git-pathspec-injection çaresi) $3 birden cwd oldu ve iki test
  // "beklenmeyen alt komut" ile arızaya düştü — ürün doğru çalışırken harness
  // kırmızı verdi. Konum varsayımı yerine komut-öncesi seçenekler atlanıyor.
  writeFileSync(bin, [
    "#!/bin/sh",
    'sub=""',
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    "    -C) shift 2 ;;",
    "    -*) shift ;;",
    "    *) sub=$1; break ;;",
    "  esac",
    "done",
    'case "${CP_FAKE_MODE:-}:$sub" in',
    // ls-tree arızası: promisor remote'a ulaşılamadı (gerçek stderr'in kısası).
    '  lstree:ls-tree) echo "fatal: could not fetch from promisor remote" >&2; exit 128 ;;',
    '  lstree:log) echo 0123456789abcdef; exit 0 ;;',
    // churn arızası: dosya DURUYOR ama rev-list ölçülemedi (ters yön: kaçırılan çürüme).
    '  churn:ls-tree) echo src/a.ts; exit 0 ;;',
    '  churn:rev-list) echo "fatal: bad revision" >&2; exit 128 ;;',
    // sembol: git grep rc=128 (arıza) — rc=1 olsaydı temiz "eşleşme yok" olurdu.
    '  grepfail:grep) echo "fatal: could not fetch from promisor remote" >&2; exit 128 ;;',
    '  grepfail:log) echo 0123456789abcdef; exit 0 ;;',
    // maxBuffer: komut BAŞARILI ama çıktı 4 MiB tavanını aşıyor.
    "  grephuge:grep) dd if=/dev/zero bs=1048576 count=5 2>/dev/null | tr '\\000' x; exit 0 ;;",
    '  grephuge:log) echo 0123456789abcdef; exit 0 ;;',
    // commit_sha arızası.
    '  shafail:rev-parse) echo "fatal: bad object" >&2; exit 128 ;;',
    // temiz "hayır" çiti: rc=0 + boş çıktı = dosya yok, rc=1 = grep eşleşmedi.
    '  cleanno:ls-tree) exit 0 ;;',
    '  cleanno:log) echo 0123456789abcdef; exit 0 ;;',
    '  cleanno:grep) exit 1 ;;',
    '  *) echo "fatal: beklenmeyen alt komut $sub" >&2; exit 128 ;;',
    "esac",
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  fakeBin = dir;
  realPath = process.env["PATH"] ?? "";
});

after(() => {
  if (realPath !== null) process.env["PATH"] = realPath;
  delete process.env["CP_FAKE_MODE"];
});

async function withFake<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  process.env["PATH"] = `${fakeBin}:${realPath}`;
  process.env["CP_FAKE_MODE"] = mode;
  try {
    return await fn();
  } finally {
    process.env["PATH"] = realPath!;
    delete process.env["CP_FAKE_MODE"];
  }
}

test("sahte git: ls-tree arızası → unverifiable, missing_now DEĞİL", async () => {
  const verdicts = await withFake("lstree", () =>
    checkAnchors(FAKE_CTX, [{ kind: "file_path", value: "src/live.ts" }], EPOCH));
  assert.equal(verdicts[0]!.state, "unverifiable");
  assert.ok(verdicts[0]!.measurementFailed);
  assert.ok(scoreDrift(verdicts, true).score < SUSPICION_THRESHOLD);
});

test("sahte git: grep arızası (rc=128) → unverifiable, symbol_lost DEĞİL", async () => {
  const verdicts = await withFake("grepfail", () =>
    checkAnchors(FAKE_CTX, [{ kind: "symbol", value: "canliSembol" }], EPOCH));
  assert.equal(verdicts[0]!.state, "unverifiable");
  assert.ok(verdicts[0]!.measurementFailed);
  assert.match(verdicts[0]!.measurementFailed!.command, /grep/);
  assert.equal(scoreDrift(verdicts, false).score, 0);
});

test("sahte git: maxBuffer taşması arıza sayılır, symbol_lost DEĞİL", async () => {
  // audit-resource probe'unun iddiası: başarılı ama çok büyük çıktı, eski kodda
  // ok=false'a inip iki sembolü birden symbol_lost yapıyordu (skor 0.8).
  const verdicts = await withFake("grephuge", () =>
    checkAnchors(FAKE_CTX, [
      { kind: "symbol", value: "sembolBir" },
      { kind: "symbol", value: "sembolIki" },
    ], EPOCH));
  assert.deepEqual(verdicts.map((v) => v.state), ["unverifiable", "unverifiable"]);
  assert.equal(scoreDrift(verdicts, false).score, 0);
  assert.match(verdicts[0]!.measurementFailed!.reason, /maxbuffer/i);
});

test("sahte git: commit_sha ölçümü arızalıysa iz bırakır", async () => {
  const verdicts = await withFake("shafail", () =>
    checkAnchors(FAKE_CTX, [{ kind: "commit_sha", value: "deadbeef" }], EPOCH));
  assert.equal(verdicts[0]!.state, "unverifiable");
  assert.ok(verdicts[0]!.measurementFailed, "sha arızası 'yok' cevabından ayrılmıyor");
});

test("sahte git: churn ölçülemezse skor sessizce 0 sayılmaz, iz kalır (ters yön)", async () => {
  // Kaçırılan çürüme: dosya duruyor, ama rev-list ölçülemedi. Skora katkı YOK
  // (yanlış suçlama üretmemek için) — ama arıza görünür olmalı, yoksa "churn 0"
  // ile "churn bilinmiyor" karışır.
  const verdicts = await withFake("churn", () =>
    checkAnchors(FAKE_CTX, [{ kind: "file_path", value: "src/a.ts" }], EPOCH));
  assert.equal(verdicts[0]!.state, "ok");
  assert.ok(verdicts[0]!.measurementFailed, "churn arızası iz bırakmadı");
  assert.match(verdicts[0]!.measurementFailed!.command, /rev-list/);
  assert.equal(verdicts[0]!.commits, undefined, "ölçülemeyen churn 0 gibi raporlandı");
  assert.equal(scoreDrift(verdicts, false).score, 0);
});

test("sahte git: TEMİZ hayır hâlâ hüküm üretir (fix sinyali köreltmedi)", async () => {
  const file = await withFake("cleanno", () =>
    checkAnchors(FAKE_CTX, [{ kind: "file_path", value: "src/gitti.ts" }], EPOCH));
  assert.equal(file[0]!.state, "missing_now"); // ls-tree rc=0+boş, log sha döndü
  assert.equal(file[0]!.measurementFailed, undefined);
  assert.equal(scoreDrift(file, false).score, 0.5);

  const sym = await withFake("cleanno", () =>
    checkAnchors(FAKE_CTX, [{ kind: "symbol", value: "kayipSembol" }], EPOCH));
  assert.equal(sym[0]!.state, "symbol_lost"); // grep rc=1 = eşleşme yok, log sha döndü
  assert.equal(sym[0]!.measurementFailed, undefined);
});

test("git binary'si yok: spawn hatası da arıza, hüküm değil", async () => {
  const empty = tmpDir("cp-nogit-path-");
  process.env["PATH"] = empty;
  try {
    const verdicts = await checkAnchors(FAKE_CTX, [
      { kind: "file_path", value: "src/a.ts" },
      { kind: "symbol", value: "s" },
    ], EPOCH);
    assert.deepEqual(verdicts.map((v) => v.state), ["unverifiable", "unverifiable"]);
    assert.match(verdicts[0]!.measurementFailed!.reason, /spawn|ENOENT/i);
    assert.equal(scoreDrift(verdicts, true).score < SUSPICION_THRESHOLD, true);
  } finally {
    process.env["PATH"] = realPath!;
  }
});

// --- 4. Arıza sınıflandırması: ÖLÇÜLMÜŞ hata biçimleri -----------------------
// Aşağıdaki nesneler uydurma değil: node 24 / macOS'ta promisify(execFile)'ın
// gerçekten fırlattığı hataların ölçülmüş alanları (2026-08-11).
// Zaman aşımı burada birim olarak sınanıyor, çünkü uçtan uca sınamak
// GIT_TIMEOUT_MS kadar (15 sn) beklemek demekti.

test("classifyFailure: dört arıza sınıfı ayrı ayrı adlandırılır", () => {
  assert.match(classifyFailure(Object.assign(new Error("spawn git ENOENT"),
    { code: "ENOENT", errno: -2, syscall: "spawn git" })), /ENOENT/);
  assert.match(classifyFailure(Object.assign(new RangeError("stdout maxBuffer length exceeded"),
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })), /maxbuffer/i);
  assert.match(classifyFailure(Object.assign(new Error("Command failed: git ..."),
    { code: null, signal: "SIGTERM", killed: true })), /timeout/i);
  const exitErr = classifyFailure(Object.assign(new Error("Command failed: git ls-tree"),
    { code: 128, stderr: "fatal: could not fetch from promisor remote\n" }));
  assert.match(exitErr, /128/);
  assert.match(exitErr, /promisor/);
});

// --- 5. Olay türü: arıza günlüğe yazılabilir olmalı --------------------------

test("anchor_measurement_failed olay türü kaydedilebilir ve sorgulanabilir", () => {
  const store = openStore(tmpStorePath());
  logEvent(store, {
    kind: "anchor_measurement_failed",
    detail: { anchor: "src/a.ts", command: "ls-tree", reason: "exit:128 fatal: ..." },
  });
  const rows = listEvents(store, { kind: "anchor_measurement_failed" });
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.detail!, /ls-tree/);
  store.close();
});
