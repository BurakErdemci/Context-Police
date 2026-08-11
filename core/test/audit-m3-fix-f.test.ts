// M3 denetimi — F dalgası: son düzeltme dalgasının kalıcı testleri. Her test
// bir denetim bulgusunun iddiasını sabitler; iddia geri alınırsa test kırılır.
//
// Bulgular (2026-08-11 denetim turu):
//   1 ScanLockBusy yakalanmıyor          → probes/lock-busy-exit-is-usage.sh
//   2 import olayı transaction'ın dışında → probes/import-event-outside-transaction.sh
//   3 openGit fetch varsayılanı tehlikeli + fetch arızası sessiz
//     → probes/fetch-failure-silent.sh ARTIK GEÇERSİZ (rc=2): probe `audit`i
//       bayraksız koşuyor, fetch de artık varsayılanda koşmuyor, yani probe'un
//       ön koşulu düşmüş. İddia bu yüzden kalıcı teste taşındı.
//   4 droppedAnchors hiçbir yere yazılmıyor → E dalgasının devri

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { openStore, type Store } from "../src/store/db.ts";
import { upsertProject } from "../src/store/projects.ts";
import { listActive } from "../src/store/findings.ts";
import { countEvents, listEvents } from "../src/store/events.ts";
import { importMemoryDir } from "../src/importer/import.ts";
import { openGit } from "../src/signals/git.ts";
import { auditProject } from "../src/audit.ts";
import { Observer } from "../src/observer/observer.ts";
import { EXIT_LOCK_BUSY } from "../src/cli-exit.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";
import type { Turn } from "../src/types.ts";

const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");
const node = process.execPath;
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning", "--experimental-strip-types"];

// ---------------------------------------------------------------- 1: kilit

test("kilit meşgulken çıkış kodu kullanım hatasından AYRI ve mesaj yığın izsiz", () => {
  const dir = tmpDir("cp-f-lock-");
  const storePath = join(dir, "store.db");
  const transcripts = join(dir, "transcripts");
  mkdirSync(transcripts);

  // Canlı bir sahip: kendi PID'imiz. Taze damga → devralma yolu kapalı,
  // acquireScanLock ScanLockBusy atmak zorunda.
  const store = openStore(storePath);
  store.run("INSERT INTO scan_lock(id,holder,acquired_at) VALUES(1,?,?)",
    `pid:${process.pid}`, new Date().toISOString());
  store.close();

  const run = (args: string[]) =>
    spawnSync(node, [...NODE_FLAGS, cliPath, ...args], { encoding: "utf8", timeout: 30_000 });

  const busy = run(["scan", "--dir", transcripts, "--store", storePath]);
  const usage = run(["scan", "--unknown-option"]);

  assert.equal(usage.status, 1, "kullanım hatası 1 kalmalı");
  assert.notEqual(busy.status, usage.status,
    "geçici çakışma ile 'argümanın yanlış' aynı çıkış kodunu döndüremez: betikle koşan ikisini ayırt edemez");
  assert.equal(busy.status, EXIT_LOCK_BUSY);
  // Yığın izi = yakalanmamış istisna. Kullanıcıya tek satır anlaşılır mesaj gerek.
  assert.doesNotMatch(busy.stderr, /ScanLockBusy: |\n\s+at /,
    "yakalanmamış istisna yolu: kullanıcı yığın izi görüyor");
  assert.match(busy.stderr, /tarama/i, "mesaj ne olduğunu söylemeli");
  assert.match(busy.stderr, new RegExp(`pid:${process.pid}`), "mesaj sahibi söylemeli");
});

// ------------------------------------------------- 2: import olayı ve tx

/** `INSERT INTO events` yazımını patlatan sarmalayıcı — arada ölmenin ucuz reprosu. */
function storeFailingOnEvents(store: Store): Store & { injected: boolean } {
  const wrapper = {
    ...store,
    injected: false,
    run(sql: string, ...params: unknown[]) {
      if (sql.includes("INSERT INTO events")) {
        wrapper.injected = true;
        throw new Error("enjekte edilmiş olay yazım arızası");
      }
      return store.run(sql, ...(params as never[]));
    },
  } as Store & { injected: boolean };
  return wrapper;
}

test("import: supersede ile finding_superseded olayı AYNI transaction'da", async () => {
  const store = openStore(":memory:");
  const dir = tmpDir("cp-f-import-");
  const note = join(dir, "note.md");
  const pid = upsertProject(store, { path: "/proj", adapterId: "claude-code", transcriptDir: "/t" });

  writeFileSync(note, "birinci sürüm\n");
  await importMemoryDir(store, pid, dir);
  writeFileSync(note, "ikinci sürüm\n");

  const failing = storeFailingOnEvents(store);
  await assert.rejects(() => importMemoryDir(failing, pid, dir));
  assert.equal(failing.injected, true, "repro geçersiz: olay yazımına hiç ulaşılmadı");

  // Append-only tablo ile denetim günlüğü ÇELİŞEMEZ: olay yazılamadıysa
  // supersede de olmamalı, yoksa kayıt superseded ama sebebini açıklayan olay yok.
  const rows = store.all<{ content: string; status: string }>("SELECT content, status FROM findings ORDER BY id");
  assert.equal(rows.length, 1, "yeni kayıt olay arızasıyla birlikte geri alınmalıydı");
  // "superseded değil" ölçütü: çapasız not `unanchored` doğar (M1 kuralı), yani
  // "active" beklemek yanlış bir sabit olurdu.
  assert.notEqual(rows[0]!.status, "superseded", "olayı olmayan supersede kalıcı olmuş");
  assert.equal(countEvents(store, "finding_superseded"), 0);
  store.close();
});

test("import: silme yolunda da supersede ile olay aynı transaction'da", async () => {
  const store = openStore(":memory:");
  const dir = tmpDir("cp-f-import-del-");
  const note = join(dir, "note.md");
  const pid = upsertProject(store, { path: "/proj", adapterId: "claude-code", transcriptDir: "/t" });

  writeFileSync(note, "silinecek not\n");
  await importMemoryDir(store, pid, dir);
  const id = store.get<{ id: number }>("SELECT id FROM findings ORDER BY id LIMIT 1")!.id;
  // Dosyayı yok et: süpürme yolu bu kaydı superseded etmek isteyecek.
  execFileSync("rm", [note]);

  const failing = storeFailingOnEvents(store);
  await assert.rejects(() => importMemoryDir(failing, pid, dir));
  assert.equal(failing.injected, true, "repro geçersiz: silme yolundaki olay yazımına ulaşılmadı");

  assert.notEqual(store.get<{ status: string }>("SELECT status FROM findings WHERE id = ?", id)!.status,
    "superseded", "olayı olmayan supersede kalıcı olmuş");
  assert.equal(countEvents(store, "import_file_deleted"), 0);
  store.close();
});

// -------------------------------------------------------------- 3: fetch

const gitIn = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

/** origin'i erişilemez bir yola bağlı repo: `git fetch origin` kesin arızalanır. */
function repoWithBrokenOrigin(): string {
  const repo = realpathSync(tmpDir("cp-f-git-"));
  gitIn(repo, "init", "-q");
  gitIn(repo, "config", "user.email", "t@t");
  gitIn(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-qm", "ilk");
  gitIn(repo, "remote", "add", "origin", join(repo, "yok-boyle-bir-repo"));
  return repo;
}

/** Gerçekten çekilebilir bir origin: başarılı fetch `.git/FETCH_HEAD` bırakır. */
function repoWithWorkingOrigin(): string {
  const upstream = realpathSync(tmpDir("cp-f-up-"));
  gitIn(upstream, "init", "-q", "--bare");
  const repo = realpathSync(tmpDir("cp-f-git-ok-"));
  gitIn(repo, "init", "-q");
  gitIn(repo, "config", "user.email", "t@t");
  gitIn(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-qm", "ilk");
  gitIn(repo, "remote", "add", "origin", upstream);
  gitIn(repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  return repo;
}

test("openGit: fetch varsayılanı GÜVENLİ — alan unutulursa ağ/komut çalışmaz", async () => {
  // İZDEN doğrulama: başarılı fetch `.git/FETCH_HEAD` yazar. Dönüş değerine
  // bakmak yetmezdi — fetch koşup sessizce başarılı olsa da dönüş aynı görünür.
  const repo = repoWithWorkingOrigin();
  const fetchHead = join(repo, ".git", "FETCH_HEAD");

  // `fetch` alanı HİÇ verilmedi (yeni bir çağıran): tehlikeli tarafa düşmemeli.
  // Gerekçe ölçüldü: fetch, hedef reponun .git/config'indeki
  // `remote.origin.uploadpack` üzerinden keyfî YEREL komut çalıştırabiliyor.
  assert.ok(await openGit(repo, {}));
  assert.equal(existsSync(fetchHead), false, "fetch istenmeden koştu: varsayılan tehlikeli tarafta");
  assert.ok(await openGit(repo, { fetch: false }));
  assert.equal(existsSync(fetchHead), false);

  // Açık istek: koşmalı.
  assert.ok(await openGit(repo, { fetch: true }));
  assert.equal(existsSync(fetchHead), true, "--fetch açıkken fetch koşmadı");
});

test("openGit: fetch İSTENDİ ve arızalandıysa sessiz kalmaz, sonuç çağırana döner", async () => {
  const repo = repoWithBrokenOrigin();
  const ctx = await openGit(repo, { fetch: true });
  assert.ok(ctx);
  assert.ok(ctx.fetchFailed, "fetch arızası çağırana hiç bildirilmedi");
  assert.equal(typeof ctx.fetchFailed.reason, "string");
  assert.ok(ctx.fetchFailed.reason.length > 0);
});

test("audit: fetch arızası olay günlüğüne düşer ve özette taşınır", async () => {
  const repo = repoWithBrokenOrigin();
  const store = openStore(":memory:");
  const id = upsertProject(store, { path: repo, adapterId: "claude-code", transcriptDir: repo });

  const sum = await auditProject(store, { id, path: repo, memoryDir: null }, { executor: null, fetch: true });
  // Bayat bir origin ref'e karşı ölçüm yapıp bunu taze sanmak, ölçümü SESSİZCE
  // yanlış yapar — arıza görünür olmak zorunda.
  assert.equal(sum.fetchFailed, true);
  assert.equal(countEvents(store, "git_fetch_failed"), 1);
  const detail = JSON.parse(listEvents(store, { kind: "git_fetch_failed" })[0]!.detail!);
  assert.equal(typeof detail.reason, "string");

  const temiz = await auditProject(store, { id, path: repo, memoryDir: null }, { executor: null });
  assert.equal(temiz.fetchFailed, false, "fetch istenmedi: arıza da olamaz");
  store.close();
});

test("audit: fetch arızası insan kipi çıktıda uyarı olarak görünür", () => {
  const repo = repoWithBrokenOrigin();
  const dir = tmpDir("cp-f-fetch-cli-");
  const storePath = join(dir, "store.db");

  // Sahte codex: K2 kapısı audit'te de var, gerçek bir Codex kurulumuna
  // bağlanmamak için PATH'e sahte bir ikili konuyor.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const codex = join(bin, "codex");
  writeFileSync(codex,
    "#!/bin/sh\n" +
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi\n' +
    'echo \'{"verdicts":[]}\'\n', { mode: 0o755 });

  const res = spawnSync(node, [...NODE_FLAGS, cliPath, "audit", "--path", repo, "--store", storePath, "--fetch", "--yes"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout + res.stderr, /fetch.*(başarısız|arıza)|(başarısız|arıza).*fetch/i,
    "fetch arızası kullanıcıya hiç söylenmiyor: bayat origin taze sanılır");
});

// ------------------------------------------------------ 4: droppedAnchors

test("gözlemci: biçim doğrulamasından düşen çapa sayısı observer_batch_ok'a yazılır", async () => {
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/proj", adapterId: "claude-code", transcriptDir: "/t" });
  const exec = fakeExecutor([{
    output: JSON.stringify({ findings: [{
      content: "Karar: X.",
      anchors: [
        { kind: "commit_sha", value: "HEAD" },        // hex değil → düşer
        { kind: "file_path", value: "--output/a.txt" }, // bayrak şekilli → düşer
        { kind: "file_path", value: "src/a.ts" },       // meşru
      ],
    }] }),
  }]);
  const turn: Turn = { role: "user", text: "konuşma", uuid: "u1" };
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [turn] });

  assert.equal(listActive(store, pid).length, 1);
  const detail = JSON.parse(listEvents(store, { kind: "observer_batch_ok" })[0]!.detail!);
  // Sessiz düşüş yok: çapası düşmüş bir bulgu denetim yüzeyini kaybediyor.
  assert.equal(detail.droppedAnchors, 2);
  store.close();
});
