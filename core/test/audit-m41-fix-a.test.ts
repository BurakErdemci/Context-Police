// M4.1 denetimi — Fix A dalgası. Beş bulgunun probe'ları depoya girmiyor,
// İDDİALARI giriyor: her test bir bulgu sınıfının adını taşır ve düzeltmeden
// önce kırmızıydı (probe rc=1 ile ölçüldü, 14 Ağu 2026).
//
// Kaynak probe'lar (AUDIT-M41-5c341d5):
//   codex-cleanup-masks-success.sh   → cleanup-error-masks-success
//   codex-read-error-misdiagnosed.sh → swallowed-io-error-cause
//   signal-cleanup-stale-group.sh    → stale-process-group-registration
//   codex-stream-schema-silent.sh    → silent-stream-schema-drift
//   product-unconfined-read.sh       → unconfined-executor-read-root

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createCodexExecutor } from "../src/adapters/codex.ts";
import { openStore } from "../src/store/db.ts";
import { Observer } from "../src/observer/observer.ts";
import { upsertProject } from "../src/store/projects.ts";
import { auditProject } from "../src/audit.ts";
import { classifyCandidates } from "../src/signals/classify.ts";
import type { Candidate, NoteView } from "../src/signals/contradiction.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";

const require = createRequire(import.meta.url);
// Adaptör builtin'leri ESM olarak import ediyor; testte yamalanan CJS nesnesinin
// o bağlara yansıması için syncBuiltinESMExports() şart (probe'ların kalıbı).
const fs = require("node:fs") as typeof import("node:fs");
const childProcess = require("node:child_process") as typeof import("node:child_process");

const fakeBinDirs: string[] = [];
after(() => {
  for (const d of fakeBinDirs) rmSync(d, { recursive: true, force: true });
});

/** Sahte codex: -o'nun gösterdiği dosyaya yazar, stdout'a verilen akışı basar. */
function fakeCodex(streamLines: string[], outBody = '{"findings":[]}'): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-m41-fake-"));
  fakeBinDirs.push(dir);
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > /dev/null
${streamLines.map((l) => `printf '%s\\n' '${l}'`).join("\n")}
printf '%s' '${outBody}' > "$out"
exit 0`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

// --- cleanup-error-masks-success -------------------------------------------
// Eski hâl: silme `finally` içindeydi ve fırlarsa BAŞARILI ExecutorResult'ı
// yerinden ediyordu — koşum yapılmış, token harcanmış, sonuç kaybolmuştu.

test("cleanup-error-masks-success: temizlik hatası başarılı sonucu ezmez, alanda görünür", async () => {
  const leaked: string[] = [];
  const originalRm = fs.promises.rm;
  fs.promises.rm = (async (path: string) => {
    leaked.push(path); // yamalı silme çalışmadığı için dizini test kendisi toplar
    const err = new Error("TEST_RM_DENIED") as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  }) as typeof fs.promises.rm;
  syncBuiltinESMExports();
  try {
    const res = await createCodexExecutor({ binary: fakeCodex([]) }).run({ prompt: "x" });
    assert.equal(res.ok, true, "temizlik hatası koşumu geçersiz kılmamalı");
    assert.equal(res.output, '{"findings":[]}');
    assert.match(res.cleanupError!, /EACCES: TEST_RM_DENIED/, "hata yutulmamalı, teşhis errno taşımalı");
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    for (const d of leaked) rmSync(d, { recursive: true, force: true });
  }
});

test("cleanup-error-masks-success: temizlik hatası ÖZGÜN hatayı da ezmez", async () => {
  const leaked: string[] = [];
  const originalRm = fs.promises.rm;
  const originalWriteFile = fs.promises.writeFile;
  fs.promises.rm = (async (path: string) => {
    leaked.push(path);
    throw new Error("TEST_RM_DENIED");
  }) as typeof fs.promises.rm;
  // Koşumu `execute()` içinde patlatan en erken yol: şema dosyasının yazımı.
  fs.promises.writeFile = (async () => {
    throw new Error("TEST_ORIGINAL_FAILURE");
  }) as typeof fs.promises.writeFile;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => createCodexExecutor({ binary: fakeCodex([]) }).run({ prompt: "x", outputSchema: { type: "object" } }),
      (err: Error & { cleanupError?: string }) => {
        assert.equal(err.message, "TEST_ORIGINAL_FAILURE", "özgün hata temizlik hatasıyla değiştirilmemeli");
        assert.match(err.cleanupError!, /TEST_RM_DENIED/, "ikincil hata ayrı alanda taşınmalı");
        return true;
      },
    );
  } finally {
    fs.promises.rm = originalRm;
    fs.promises.writeFile = originalWriteFile;
    syncBuiltinESMExports();
    for (const d of leaked) rmSync(d, { recursive: true, force: true });
  }
});

// --- swallowed-io-error-cause ----------------------------------------------
// Eski hâl: `readFile(outPath).catch(() => "")` her okuma hatasını boş dosyayla
// aynı değere indiriyordu; çağıran "codex son mesajı boş bıraktı" teşhisiyle
// yanlış yerde arama yapıyordu.

test("swallowed-io-error-cause: son mesaj okunamazsa errno hata metnine sağ çıkar", async () => {
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = (async (path: string, ...rest: unknown[]) => {
    if (typeof path === "string" && path.endsWith("son-mesaj.txt")) {
      const err = new Error("TEST_READ_DENIED") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    return (originalReadFile as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.promises.readFile;
  syncBuiltinESMExports();
  let res;
  try {
    res = await createCodexExecutor({ binary: fakeCodex([]) }).run({ prompt: "x" });
  } finally {
    fs.promises.readFile = originalReadFile;
    syncBuiltinESMExports();
  }
  assert.equal(res.ok, false);
  assert.equal(res.output, "");
  assert.match(res.error!, /okunamadı/);
  assert.match(res.error!, /EACCES: TEST_READ_DENIED/);
  assert.doesNotMatch(res.error!, /boş bıraktı/, "okunamayan dosya boş dosya DEĞİLDİR");
});

test("swallowed-io-error-cause: gerçekten boş dosya ayrı teşhis verir", async () => {
  const res = await createCodexExecutor({ binary: fakeCodex([], "") }).run({ prompt: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error!, /boş bıraktı/);
  assert.doesNotMatch(res.error!, /okunamadı/);
});

// --- stale-process-group-registration --------------------------------------
// Lane ölçtü: `exit`→`close` arası ~1,1–1,4 ms ve o anda kill(pid,0) zaten ESRCH
// veriyor. Kayıt `close`ta düştüğü için, çocuk çıkmışken gelen SIGINT geri
// dönüştürülmüş bir PID'nin GRUBUNA SIGKILL atabiliyordu.

test("stale-process-group-registration: çıkmış çocuk için sinyal temizliği kill atmaz", async () => {
  const realSpawn = childProcess.spawn;
  const realKill = process.kill.bind(process);
  const attempted: number[] = [];
  let childPid: number | undefined;
  let sawExit = false;
  const noopSigint = (): void => {}; // Node'un varsayılan sonlandırmasını iptal et

  childProcess.spawn = function (this: unknown, ...args: Parameters<typeof realSpawn>) {
    const child = realSpawn(...args);
    childPid = child.pid;
    // prepend: adaptörün close işleyicisinden ÖNCE, yani kaydın hâlâ durduğu an.
    child.prependOnceListener("exit", () => {
      sawExit = true;
      process.emit("SIGINT", "SIGINT");
    });
    return child;
  } as typeof realSpawn;
  syncBuiltinESMExports();
  process.on("SIGINT", noopSigint);
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal === "SIGKILL") {
      attempted.push(pid);
      return true;
    }
    return realKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;

  try {
    const det = await createCodexExecutor({ binary: fakeCodex([]), detectTimeoutMs: 5000 }).detect();
    assert.equal(det.found, true);
  } finally {
    childProcess.spawn = realSpawn;
    syncBuiltinESMExports();
    process.kill = realKill as typeof process.kill;
    process.removeListener("SIGINT", noopSigint);
  }

  assert.equal(sawExit, true, "ölçüm kurulmadı: çocuğun exit'i gözlenmedi");
  assert.deepEqual(attempted, [], `çıkmış çocuğun grubuna SIGKILL atıldı (pid ${childPid})`);
});

// --- silent-stream-schema-drift --------------------------------------------
// Bugün canlı zarar YOK (codex 0.146.0 tam da beklenen adları basıyor, çürütme
// turu ölçtü). Risk: sürüm yükseltmesinde ölçümün SESSİZCE sıfıra düşmesi.
// İstenen davranış değişikliği değil GÖRÜNÜRLÜK.

test("silent-stream-schema-drift: anlaşılmayan akış usage=undefined'a düşmez", async () => {
  const bin = fakeCodex(['{bozuk-json', '{"type":"turn.done","usage":{"input_tokens":50000}}']);
  const res = await createCodexExecutor({ binary: bin }).run({ prompt: "x" });
  assert.equal(res.ok, true);
  // "akış hiç gelmedi" (undefined) ile "geldi ama anlaşılmadı" ayırt edilebilmeli.
  assert.deepEqual(res.usage, { unparsedLines: 1, unknownEvents: 1 });
});

test("silent-stream-schema-drift: tanınan akışta sayaçlar YOK (0 uydurulmaz)", async () => {
  const bin = fakeCodex([
    "codex-cli 9.9.9 basliyor", // JSON olmayan satır kayma değildir
    '{"type":"item.completed"}',
    '{"type":"turn.completed","usage":{"input_tokens":7}}',
  ]);
  const res = await createCodexExecutor({ binary: bin }).run({ prompt: "x" });
  assert.deepEqual(res.usage, { inputTokens: 7, items: 1, turns: 1 });
});

test("silent-stream-schema-drift: akış hiç gelmezse usage yine undefined", async () => {
  const res = await createCodexExecutor({ binary: fakeCodex([]) }).run({ prompt: "x" });
  assert.equal(res.usage, undefined);
});

// --- unconfined-executor-read-root -----------------------------------------
// Ürün çağrıları `cwd` vermiyordu → alt süreç CLI'nin başlatıldığı yerin
// cwd'sini miras alıyordu. SINIR: `-C` bir okuma hapsi değil (codex 0.146.0'ın
// `exec --help`inde depo-hapsi bayrağı yok); ölçülen şey ÇALIŞMA KÖKÜNÜN
// açıkça verilmesi.

test("unconfined-executor-read-root: gözlemci projenin kökünü cwd olarak geçer", async () => {
  const store = openStore(":memory:");
  const root = tmpDir("cp-m41-proj-");
  const pid = upsertProject(store, { path: root, adapterId: "claude-code", transcriptDir: "/t" });
  const exec = fakeExecutor([{ output: '{"findings":[]}' }]);
  await new Observer({ store, executor: exec }).handleTurns({
    projectId: pid, sessionId: "s1", turns: [{ role: "user", text: "konuşma", uuid: "u1" }],
  });
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0]!.cwd, root);
  store.close();
});

test("unconfined-executor-read-root: sınıflama çağrısı verilen kökü aktarır", async () => {
  const notes = new Map<number, NoteView>([
    [1, { findingId: 1, content: "A doğru", anchors: [], description: null, hasStatus: false }],
    [2, { findingId: 2, content: "A yanlış", anchors: [], description: null, hasStatus: false }],
  ]);
  const cands: Candidate[] = [{ kind: "cross", aId: 1, bId: 2, reason: "test" }];
  const exec = fakeExecutor([{ output: '{"verdicts":[]}' }]);
  await classifyCandidates(exec, cands, notes, { cwd: "/kok" });
  assert.equal(exec.calls[0]!.cwd, "/kok");
});

test("unconfined-executor-read-root: denetim sınıflamaya projenin kökünü verir", async () => {
  const repo = tmpDir("cp-m41-audit-");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "live.ts"), "export const live = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "ilk");

  const memoryDir = tmpDir("cp-m41-mem-");
  // Frontmatter yüzeyi: description ↔ gövde çelişkisi tek notla aday üretir.
  writeFileSync(
    join(memoryDir, "teslim.md"),
    "---\nname: teslim\ndescription: teslim A ile yapılıyor\n---\nTeslim B ile yapılıyor. `live.ts` duruyor.\n",
  );
  const store = openStore(":memory:");
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    repo, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  const exec = fakeExecutor([{ output: '{"verdicts":[]}' }]);
  await auditProject(store, { id, path: repo, memoryDir }, { executor: exec, fetch: false });
  assert.ok(exec.calls.length > 0, "ölçüm kurulmadı: sınıflama hiç çağrılmadı");
  assert.equal(exec.calls[0]!.cwd, repo);
  store.close();
});
