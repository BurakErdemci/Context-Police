import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerExecutor, getExecutor } from "../src/adapters/executor.ts";
import { createCodexExecutor, buildExecArgs } from "../src/adapters/codex.ts";
import { fakeExecutor } from "./helpers.ts";

test("registry kayıtlı yürütücüyü döndürür, bilinmeyeni adlarıyla reddeder", () => {
  const fake = fakeExecutor([]);
  registerExecutor(fake);
  assert.equal(getExecutor(fake.id), fake);
  assert.throws(() => getExecutor("yok-boyle-motor"), /bilinmeyen yürütücü/);
});

test("fakeExecutor senaryoyu sırayla oynar ve istekleri kaydeder", async () => {
  const fake = fakeExecutor([
    { output: '{"findings":[]}' },
    (req) => ({ ok: false, error: `patladı: ${req.prompt.slice(0, 5)}` }),
  ]);
  const r1 = await fake.run({ prompt: "birinci" });
  assert.equal(r1.ok, true);
  assert.equal(r1.output, '{"findings":[]}');
  const r2 = await fake.run({ prompt: "ikinci" });
  assert.equal(r2.ok, false);
  assert.equal(r2.output, "", "ok=false iken output boş dize (executor.ts sözleşmesi)");
  assert.match(r2.error!, /patladı: ikinc/);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0]!.prompt, "birinci");
});

test("buildExecArgs sözleşmesi: stdin prompt, ephemeral, read-only, şema ve çıktı dosyaları", () => {
  const args = buildExecArgs(
    { prompt: "x", outputSchema: { type: "object" }, cwd: "/proj" },
    { model: "gpt-5-codex", reasoningEffort: "low" },
    "/tmp/sema.json",
    "/tmp/son.txt",
  );
  assert.deepEqual(args, [
    "exec", "--ephemeral", "--skip-git-repo-check", "--color", "never",
    "-s", "read-only", "-C", "/proj", "-m", "gpt-5-codex",
    "-c", 'model_reasoning_effort="low"',
    "--output-schema", "/tmp/sema.json", "-o", "/tmp/son.txt", "-",
  ]);
});

test("buildExecArgs: verilmeyen seçenekler bayrak üretmez", () => {
  const args = buildExecArgs({ prompt: "x" }, {}, null, "/tmp/son.txt");
  assert.deepEqual(args, [
    "exec", "--ephemeral", "--skip-git-repo-check", "--color", "never",
    "-s", "read-only", "-o", "/tmp/son.txt", "-",
  ]);
});

// Sahte codex binary'si: gerçek codex olmadan spawn/stdin/timeout/temizlik
// hattını uçtan uca test eder. Betik -o'nun değerine yazar, --version'a cevap verir.
// Yaratılan her dizin dosya sonunda silinir: temizlik isteğe bağlı bırakılırsa
// yapılmıyor (çalışma sözleşmesi §3) — her koşum tmpdir'e üç dizin bırakırdı.
const fakeBinDirs: string[] = [];
after(() => {
  for (const d of fakeBinDirs) rmSync(d, { recursive: true, force: true });
});

function fakeCodexBinary(behavior: "ok" | "fail" | "hang"): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-fake-codex-"));
  fakeBinDirs.push(dir);
  const bin = join(dir, "codex");
  const body =
    behavior === "ok"
      ? `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > /dev/null   # stdin'deki prompt'u tüket
printf '{"findings":[]}' > "$out"
exit 0`
      : behavior === "fail"
        ? `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
echo "kota doldu" >&2; exit 1`
        : `#!/bin/sh
sleep 60`;
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return bin;
}

test("CodexExecutor: sahte binary ile başarılı koşum son mesajı döndürür", async () => {
  const exec = createCodexExecutor({ binary: fakeCodexBinary("ok") });
  const det = await exec.detect();
  assert.deepEqual(det, { found: true, version: "9.9.9" });
  const res = await exec.run({ prompt: "merhaba", outputSchema: { type: "object" } });
  assert.equal(res.ok, true);
  assert.equal(res.output, '{"findings":[]}');
});

test("CodexExecutor: sıfır-dışı çıkış ok=false ve stderr kuyruğu taşır", async () => {
  const exec = createCodexExecutor({ binary: fakeCodexBinary("fail") });
  const res = await exec.run({ prompt: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error!, /kota doldu/);
});

test("CodexExecutor: zaman aşımı süreci öldürür ve ok=false döner", async () => {
  const exec = createCodexExecutor({ binary: fakeCodexBinary("hang"), timeoutMs: 300 });
  const res = await exec.run({ prompt: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error!, /zaman aşımı/);
});

// class: executor-parent-kill-leaks
// Üst süreç SIGTERM/SIGINT alınca `finally` KOŞMUYOR (Node varsayılanı süreci
// doğrudan sonlandırıyor): detached çocuk süreç grubu ve cp-codex-* geçici
// dizini diskte kalıyordu. SIGKILL onarılamaz — orada hiçbir kod koşmaz — ama
// bu iki sinyal onarılabilir ve ölçülen sızıntı buradan geliyordu.
test("CodexExecutor: SIGTERM'de geçici dizin ve çocuk süreç grubu temizlenir", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cp-signal-"));
  fakeBinDirs.push(dir);
  const marker = join(dir, "cocuk.durum");
  const bin = join(dir, "codex");
  // Sahte binary kendi PID'sini ve -o ile verilen geçici dizini bildirir, sonra
  // asılı kalır: temizliğin gerçekten koştuğunu dışarıdan ölçebilelim diye.
  writeFileSync(
    bin,
    `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
printf '%s\\n%s\\n' "$$" "$(dirname "$out")" > "$FAKE_MARKER"
sleep 60`,
  );
  chmodSync(bin, 0o755);

  const codexUrl = pathToFileURL(join(import.meta.dirname, "../src/adapters/codex.ts")).href;
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const { createCodexExecutor } = await import(${JSON.stringify(codexUrl)});
       await createCodexExecutor({ binary: process.env.FAKE_BINARY, timeoutMs: 60000 }).run({ prompt: "sinyal testi" });`,
    ],
    { env: { ...process.env, FAKE_BINARY: bin, FAKE_MARKER: marker }, stdio: ["ignore", "ignore", "inherit"] },
  );
  t.after(() => child.kill("SIGKILL"));

  const bekle = async (kosul: () => boolean, ms: number, ne: string) => {
    const son = Date.now() + ms;
    while (Date.now() < son) {
      if (kosul()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(ne);
  };
  const okunanMarker = () =>
    existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : [];

  await bekle(() => okunanMarker().length >= 2, 5000, "sahte yürütücü çocuğu hiç başlamadı");
  const [torunPid, gecici] = okunanMarker();
  assert.ok(existsSync(gecici!), "geçici dizin ölçümden önce yok");

  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("üst süreç SIGTERM sonrası kapanmadı")), 5000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const torunOldu = () => {
    try {
      process.kill(Number(torunPid), 0);
      return false;
    } catch {
      return true;
    }
  };
  await bekle(torunOldu, 3000, "çocuk süreç grubu SIGTERM sonrası yaşamaya devam etti");
  assert.equal(existsSync(gecici!), false, "cp-codex-* geçici dizini diskte kaldı");
});

test("CodexExecutor: binary yoksa detect bulunamadı der, run ok=false döner", async () => {
  const exec = createCodexExecutor({ binary: "/yok/boyle/codex" });
  const det = await exec.detect();
  assert.equal(det.found, false);
  const res = await exec.run({ prompt: "x" });
  assert.equal(res.ok, false);
});
