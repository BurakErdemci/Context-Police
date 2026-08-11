#!/usr/bin/env node
// Çekirdeğin UI'sız girişi. Tauri kabuğu bunu sidecar olarak başlatacak;
// geliştirme ve ölçüm sırasında doğrudan kullanılır.

import { openStore, defaultStorePath, type Store } from "./store/db.ts";
import { claudeCodeAdapter, readIncremental, readCwd } from "./adapters/claude-code.ts";
import { register } from "./adapters/transcript.ts";
import { scanOnce } from "./scan.ts";
import { listProjects, upsertProject } from "./store/projects.ts";
import { listEvents, countEvents } from "./store/events.ts";
import { Observer } from "./observer/observer.ts";
import { createCodexExecutor } from "./adapters/codex.ts";
import { observeGuard, estimateSessionCalls, validateBatchTokens } from "./observe-cmd.ts";
import { getWatermark } from "./store/watermarks.ts";
import { acquireScanLock, releaseScanLock } from "./store/lock.ts";
import { dropThroughWatermark } from "./observer/batch.ts";
import { basename, dirname } from "node:path";

register(claudeCodeAdapter);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const mb = (n: number) => (n / 1048576).toFixed(1) + " MB";

/**
 * Transcript'ten gelen hiçbir değer terminale ham basılmaz. İki sebep, ikisi de
 * denetimde ölçüldü: (1) satır tipi ve cwd güvenilmeyen kaynaktan geliyor ve
 * ANSI kaçış dizisi taşıyabiliyor — terminal çıktısını yeniden boyayabilir,
 * satır silebilir; (2) uzun bir değer ekranı doldurabiliyor. Kontrol
 * karakterleri görünür hâle getiriliyor ki gizlenmek yerine belli olsunlar.
 */
function safe(value: string, max = 120): string {
  const cleaned = [...value]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      // C0/C1/DEL'e ek olarak bidi ve görünmez biçim karakterleri: U+202A-E
      // (yön değiştirme), U+2066-9 (izolat), U+200B-F, U+FEFF. Doğrulama
      // turunda U+202E ham geçiyordu — terminalde metni tersine çevirebiliyor.
      const bidi =
        (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) ||
        (c >= 0x200b && c <= 0x200f) || c === 0xfeff || c === 0x061c;
      return c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || bidi
        ? `\\u{${c.toString(16)}}`
        : ch;
    })
    .join("");
  return cleaned.length > max ? cleaned.slice(0, max) + "…" : cleaned;
}

async function cmdScan(): Promise<void> {
  const storePath = arg("store") ?? defaultStorePath();
  const store = openStore(storePath);
  try {
    const started = Date.now();
    const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root: arg("dir") });
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`depo: ${storePath}`);
    console.log(`proje: ${sum.projects}  (çözülemeyen: ${sum.unresolvedProjects})`);
    console.log(`dokunulan oturum: ${sum.sessionsTouched}`);
    console.log(`turn: ${sum.turns}`);
    console.log(
      `okunan: ${mb(sum.bytesRead)} → süzülmüş: ${mb(sum.filteredBytes)}` +
        (sum.filteredBytes > 0 ? `  (${(sum.bytesRead / sum.filteredBytes).toFixed(1)}× küçülme)` : ""),
    );
    console.log(`atlanan satır: ${sum.skipped}  bilinmeyen tip: ${sum.unknown}  bozuk: ${sum.malformed}`);
    if (sum.sessionErrors > 0) console.log(`okunamayan oturum: ${sum.sessionErrors}  (ayrıntı: status)`);
    if (sum.truncations > 0) console.log(`kısalma tespiti: ${sum.truncations}`);
    console.log(`süre: ${secs} sn`);

    if (sum.unknown > 0) {
      console.log("\n⚠ bilinmeyen satır tipleri (format değişmiş olabilir):");
      const seen = new Set<string>();
      for (const e of listEvents(store, { kind: "unknown_line_type", limit: 50 })) {
        const t = JSON.parse(e.detail ?? "{}").lineType as string;
        if (t && !seen.has(t)) {
          seen.add(t);
          console.log(`  - ${safe(t)}`);
        }
      }
    }
  } finally {
    store.close();
  }
}

async function cmdObserve(): Promise<void> {
  // Girdi doğrulaması EN ÖNDE: kullanım hatası için Codex kurulu olmak zorunda
  // değil ve süreç başlatmadan önce bilinmesi ucuz.
  let batchTokens: number;
  try {
    batchTokens = validateBatchTokens(arg("batch-tokens"));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const effortArg = arg("effort");
  const executor = createCodexExecutor({
    model: arg("model"),
    reasoningEffort: (effortArg as "minimal" | "low" | "medium" | "high" | undefined) ?? "low",
  });

  // K2: Codex sert bağımlılık. Yoksa yönlendir, çalışmayı deneme.
  const det = await executor.detect();
  if (!det.found) {
    console.error(`codex bulunamadı: ${det.error ?? "PATH'te yok"}`);
    console.error("kurulum: npm install -g @openai/codex  (ya da https://developers.openai.com/codex)");
    process.exit(2);
  }
  console.log(`codex ${det.version} bulundu`);

  const yes = process.argv.includes("--yes");
  const store = openStore(arg("store") ?? defaultStorePath());
  try {
    const observer = new Observer({ store, executor, batchTokens });
    const sessionPath = arg("session");

    if (sessionPath) {
      await observeSingleSession(store, observer, sessionPath, batchTokens, yes);
    } else {
      const guard = observeGuard(store, yes);
      if (!guard.ok) {
        console.error(guard.reason);
        process.exit(3);
      }
      await scanOnce(store, {
        adapter: claudeCodeAdapter,
        root: arg("dir"),
        only: arg("project") ? [arg("project")!] : undefined,
        onTurns: (ctx) => observer.handleTurns(ctx),
      });
    }

    const s = observer.stats;
    console.log(`parti: ${s.batches}  codex çağrısı: ${s.calls}`);
    console.log(`yeni bulgu: ${s.findings}  supersede: ${s.superseded}`);
    if (s.skippedTurns > 0) console.log(`filigranla elenen tekrar turn: ${s.skippedTurns}`);
    if (s.unprocessed > 0) console.log(`⚠ işlenemeyen parti: ${s.unprocessed}  (ayrıntı: status)`);
  } finally {
    store.close();
  }
}

async function observeSingleSession(
  store: Store,
  observer: Observer,
  sessionPath: string,
  batchTokens: number,
  yes: boolean,
): Promise<void> {
  const projPath = await readCwd(sessionPath);
  if (!projPath) throw new Error(`oturum dosyasından proje yolu çözülemedi: ${safe(sessionPath)}`);
  const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");

  // Kilit: aynı anda koşan bir scan/observe ile filigran yarışını engeller.
  const holder = `pid:${process.pid}`;
  acquireScanLock(store, holder);
  try {
    const projectId = upsertProject(store, {
      path: projPath,
      adapterId: claudeCodeAdapter.id,
      transcriptDir: dirname(sessionPath), // dizin, dosya değil — projects sözleşmesi
    });
    // İmleçlere DOKUNULMAZ: imleç taramanın, filigran gözlemcinin (D-M2-2).
    const res = await readIncremental(sessionPath, 0, null, null);
    const wm = getWatermark(store, projectId, sessionId);
    const fresh = dropThroughWatermark(res.turns, wm?.lastUuid ?? null);

    let filteredBytes = 0;
    for (const t of fresh) filteredBytes += Buffer.byteLength(t.text, "utf8");
    const calls = estimateSessionCalls(filteredBytes, batchTokens);
    console.log(`oturum: ${safe(sessionId)}  yeni turn: ${fresh.length}  tahmini çağrı: ~${calls}`);
    if (calls > 20 && !yes) {
      console.error(`tahmini ${calls} Codex çağrısı > 20: maliyet onayı için --yes ekleyin (D-M2-4).`);
      process.exit(3);
    }
    await observer.handleTurns({ projectId, sessionId, turns: fresh });
  } finally {
    releaseScanLock(store, holder);
  }
}

function cmdStatus(): void {
  const store = openStore(arg("store") ?? defaultStorePath());
  try {
    const projects = listProjects(store);
    console.log(`proje: ${projects.length}`);
    for (const p of projects) console.log(`  ${safe(p.path)}${p.memory_dir ? "  [memory ✓]" : ""}`);
    console.log(`\nolaylar: tarama ${countEvents(store, "scan_completed")}, ` +
      `bilinmeyen tip ${countEvents(store, "unknown_line_type")}, ` +
      `bozuk satır ${countEvents(store, "malformed_line")}, ` +
      `kısalma ${countEvents(store, "truncation_detected")}, ` +
      `okunamayan oturum ${countEvents(store, "session_read_failed")}`);
    const findingCount = store.get<{ n: number }>("SELECT COUNT(*) n FROM findings")?.n ?? 0;
    console.log(`bulgu: ${findingCount}  gözlemci partisi: ${countEvents(store, "observer_batch_ok")}, ` +
      `işlenemeyen: ${countEvents(store, "observer_batch_unprocessed")}`);
  } finally {
    store.close();
  }
}

const cmd = process.argv[2];
if (cmd === "scan") await cmdScan();
else if (cmd === "observe") await cmdObserve();
else if (cmd === "status") cmdStatus();
else {
  console.log(`context-police — AI ajan hafızası denetçisi (çekirdek)

kullanım:
  context-police scan    [--dir <transcript kökü>] [--store <db yolu>]
  context-police observe [--project <yol>] [--session <jsonl>] [--dir <kök>] [--store <db>]
                         [--batch-tokens N] [--model M] [--effort E] [--yes]
  context-police status  [--store <db yolu>]`);
  process.exit(cmd ? 1 : 0);
}
