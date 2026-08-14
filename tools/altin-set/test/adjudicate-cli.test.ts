// `adjudicate-cost.ts`'in DAVRANIŞSAL testleri.
//
// Neden ayrı dosya: kardeşi (`adjudicate-lib.test.ts`) saf kararları tek tek
// sınıyor; burada sınanan şeyler saf DEĞİL — sinyal temizliği, akış ayrıştırma
// ve argv kapısı CLI giriş noktasında yaşıyor ve ancak süreç koşturarak
// ölçülebiliyor. M4.1 üçüncü dalgasının iki bulgusu (bayat süreç grubu kaydı,
// sessiz akış şeması kayması) tam olarak bu sınıftan: ikisi de "fonksiyon ne
// döndürdü" ile değil "süreç ne yaptı" ile görülüyor.
//
// GERÇEK `codex` ÇAĞRILMIYOR. Her test PATH'in başına kendi sahte `codex`
// betiğini koyuyor — kota harcanmıyor ve akış deterministik.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "adjudicate-cost.ts");
// `validateRoot` .git taşıyan bir kök istiyor; deponun kendisi kullanılıyor.
const REPO = join(HERE, "..", "..", "..");

const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];

/** Test başına izole çalışma alanı: sahte codex, not, çıktı dizini. */
function makeSandbox(codexScript: string): { dir: string; bin: string; notes: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "adj-cli-test-"));
  const bin = join(dir, "bin");
  const notes = join(dir, "notes");
  mkdirSync(bin);
  mkdirSync(notes);
  const codex = join(bin, "codex");
  writeFileSync(codex, codexScript);
  chmodSync(codex, 0o755);
  writeFileSync(join(notes, "probe-note.md"), "# probe\n\nsahte akışı tetiklemek için.\n");
  return { dir, bin, notes, out: join(dir, "out.jsonl") };
}

function toolEnv(bin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...extra };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- BULGU: silent-stream-schema-drift ------------------------------------
// Ayrıştırılamayan satır ve tanınmayan olay SESSİZCE düşüyordu. Tavan kararı
// bu ayrıştırıcıya bağlı olduğu için bir şema kayması maliyet ölçümünü sıfıra
// indirip manşet sayıyı yanlış yapardı ve bu hiçbir yerde görünmezdi.

const DRIFT_CODEX = `#!/bin/sh
cat > /dev/null
echo '{"type":"item.started"'                     # { ile başlar, JSON DEĞİL
echo '{"type":"session.configured","model":"x"}'  # tanınmayan olay
echo '{"type":"thread.started","id":"t1"}'        # tanınmayan olay
echo 'düz metin satırı'                           # { ile başlamıyor → sayaç dışı
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"claims\\":[]}"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'
`;

test("silent-stream-schema-drift: bozuk satır ve tanınmayan olay sonuç satırında sayılır", async () => {
  const sb = makeSandbox(DRIFT_CODEX);
  try {
    const r = spawnSync(
      process.execPath,
      [...NODE_ARGS, TOOL, "--timeout-sec", "60", REPO, sb.notes, sb.out, "probe-note"],
      { env: toolEnv(sb.bin), encoding: "utf8" },
    );
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);
    const row = JSON.parse(readFileSync(sb.out, "utf8").trim());
    // Ölçülen akış: 1 bozuk satır, 2 tanınmayan olay.
    assert.equal(row.unparsed_lines, 1);
    assert.equal(row.unknown_events, 2);
    // Tanınan olaylar kaymadan ETKİLENMİYOR: ölçüm düşmüyor, yalnız görünür oluyor.
    assert.equal(row.items, 1);
    assert.equal(row.turns, 1);
    assert.equal(row.input_tokens, 10);
    assert.equal(row.claims_complete, true);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

const CLEAN_CODEX = `#!/bin/sh
cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"claims\\":[]}"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'
`;

test("silent-stream-schema-drift: temiz akışta sayaçlar 0 — 'ölçemedim' ile karışmasın", async () => {
  const sb = makeSandbox(CLEAN_CODEX);
  try {
    const r = spawnSync(
      process.execPath,
      [...NODE_ARGS, TOOL, "--timeout-sec", "60", REPO, sb.notes, sb.out, "probe-note"],
      { env: toolEnv(sb.bin), encoding: "utf8" },
    );
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);
    const row = JSON.parse(readFileSync(sb.out, "utf8").trim());
    // 0 burada UYDURMA değil ölçüm: ayrıştırıcı koştu, kayma görmedi.
    // `null` yalnız ayrıştırıcının HİÇ koşmadığı işçi-istisnası satırında.
    assert.equal(row.unparsed_lines, 0);
    assert.equal(row.unknown_events, 0);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- BULGU: stale-process-group-registration -------------------------------
// `cleanupNow` defterdeki her PID'ye KOŞULSUZ SIGKILL atıyordu. Defterden düşüş
// `close`'da olduğu için çocuk ÖLDÜKTEN sonra da kayıt canlı kalıyor; o
// pencerede gelen bir sinyal, işletim sisteminin geri dönüştürdüğü bir PID'nin
// GRUBUNU vurabilir.
//
// Ölçüm düzeneği: sahte codex stdout'u miras alan uzun ömürlü bir torun
// (`sleep`) doğuruyor ve kendisi hemen çıkıyor. Torun boruyu tuttuğu için
// Node'un `close` olayı gelmiyor → kayıt saniyelerce BAYAT kalıyor, yani
// normalde ~0,67 ms olan yarış penceresi deterministik biçimde açılıyor.
// Kanıt: SIGINT'ten sonra torun yaşıyorsa gruba kill ATILMAMIŞTIR.

const STALE_GROUP_CODEX = `#!/bin/sh
cat > /dev/null
sleep 45 &
echo "$!" > "$PROBE_SLEEPER_FILE"
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"claims\\":[]}"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'
`;

test("stale-process-group-registration: çıkmış sürecin grubuna sinyal yolunda kill atılmaz", async () => {
  const sb = makeSandbox(STALE_GROUP_CODEX);
  const sleeperFile = join(sb.dir, "sleeper.pid");
  let child: ChildProcess | null = null;
  let sleeper = 0;
  try {
    child = spawn(
      process.execPath,
      [...NODE_ARGS, TOOL, "--timeout-sec", "120", REPO, sb.notes, sb.out, "probe-note"],
      { env: toolEnv(sb.bin, { PROBE_SLEEPER_FILE: sleeperFile }), stdio: "ignore" },
    );
    // Torunun doğmasını bekle (macOS'ta `timeout` YOK — elle yoklama).
    for (let i = 0; i < 100 && sleeper === 0; i++) {
      try {
        sleeper = Number(readFileSync(sleeperFile, "utf8").trim());
      } catch { /* henüz yazılmadı */ }
      if (sleeper === 0) await sleep(100);
    }
    assert.ok(sleeper > 0, "torun doğmadı — düzenek geçersiz");
    await sleep(600); // sahte codex'in çıkması için; `close` torun yüzünden GELMİYOR

    // Ön koşullar: kayıt gerçekten BAYAT olmalı, yoksa test bir şey ölçmez.
    assert.ok(isAlive(sleeper), "ön koşul: torun canlı olmalı");
    assert.ok(child.pid != null && isAlive(child.pid), "ön koşul: araç hâlâ koşuyor olmalı");

    child.kill("SIGINT");
    await sleep(800);

    assert.ok(
      isAlive(sleeper),
      "bayat kayıttaki gruba SIGKILL atıldı — canlılık sınaması (isAlive) kaybolmuş",
    );
  } finally {
    if (sleeper > 0) { try { process.kill(sleeper, "SIGKILL"); } catch { /* zaten ölü */ } }
    if (child?.pid != null) { try { process.kill(child.pid, "SIGKILL"); } catch { /* zaten ölü */ } }
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- BULGU: unvalidated-output-path-component (CLI kapısı) -----------------
// Birim testleri kardeş dosyada (validateOutPath); burada sınanan tek şey
// reddetmenin SESSİZ olmaması — bu sınıfın ilk arızası tam olarak sessizlikti.

test("unvalidated-output-path-component: geçersiz çıktı yolu gürültüyle reddedilir", () => {
  const sb = makeSandbox(CLEAN_CODEX);
  try {
    const bad = join(sb.dir, "boyle-bir-dizin-yok", "out.jsonl");
    const r = spawnSync(
      process.execPath,
      [...NODE_ARGS, TOOL, REPO, sb.notes, bad, "probe-note"],
      { env: toolEnv(sb.bin), encoding: "utf8" },
    );
    assert.equal(r.status, 2, "çıkış kodu 2 olmalı (argv kapısı)");
    assert.match(r.stderr, /çıktı yolu reddedildi/);
    assert.match(r.stderr, /çıktı dizini yok/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});
