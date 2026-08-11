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
import {
  observeGuard, estimateCalls, validateBatchTokens, validateEffort, validateModel,
  callBudget, costGate, budgetExhaustedMessage, budgetGuardedOnTurns,
  type Effort,
} from "./observe-cmd.ts";
import type { Turn } from "./types.ts";
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
  // değil ve süreç başlatmadan önce bilinmesi ucuz. Yürütücü seçenekleri de
  // buraya dahil — geçersiz bir --effort/--model Codex'in her çağrıyı
  // reddetmesine, o da zehirli-parti yolunun turn'leri kalıcı olarak
  // atlamasına yol açıyordu (unvalidated-executor-option-data-loss).
  let batchTokens: number;
  let effort: Effort;
  let model: string | undefined;
  try {
    batchTokens = validateBatchTokens(arg("batch-tokens"));
    effort = validateEffort(arg("effort"));
    model = validateModel(arg("model"));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const executor = createCodexExecutor({ model, reasoningEffort: effort });

  // K2: Codex sert bağımlılık. Yoksa yönlendir, çalışmayı deneme.
  const det = await executor.detect();
  if (!det.found) {
    console.error(`codex bulunamadı: ${det.error ?? "PATH'te yok"}`);
    console.error("kurulum: npm install -g @openai/codex  (ya da https://developers.openai.com/codex)");
    process.exit(2);
  }
  console.log(`codex ${det.version} bulundu`);

  const yes = process.argv.includes("--yes");
  // Sert tavan HER İKİ yolda da: --session yolunda tahmin yanılsa bile gerçek
  // sınır budur, scan yolunda ise tahmin hiç yapılamıyor (kaç turn geleceği
  // taramadan önce bilinmiyor) — tek koruma bu (missing-global-call-budget).
  const maxCalls = callBudget(yes);
  const store = openStore(arg("store") ?? defaultStorePath());
  let exitCode = 0;
  try {
    const observer = new Observer({ store, executor, batchTokens, maxCalls });
    const sessionPath = arg("session");

    if (sessionPath) {
      const halted = await observeSingleSession(store, observer, sessionPath, batchTokens, yes);
      if (halted) exitCode = 3;
    } else {
      const guard = observeGuard(store, yes);
      if (!guard.ok) {
        console.error(guard.reason);
        exitCode = 3;
      } else {
        console.log(
          maxCalls === undefined
            ? "maliyet tavanı: yok (--yes verildi)"
            : `maliyet tavanı: en fazla ${maxCalls} Codex çağrısı (--yes ile kaldırılır)`,
        );
        await scanOnce(store, {
          adapter: claudeCodeAdapter,
          root: arg("dir"),
          only: arg("project") ? [arg("project")!] : undefined,
          onTurns: budgetGuardedOnTurns(
            () => observer.stats.budgetExhausted,
            (ctx: { projectId: number; sessionId: string; turns: Turn[] }) => observer.handleTurns(ctx),
          ),
        });
      }
    }

    if (exitCode === 0) {
      const s = observer.stats;
      console.log(`parti: ${s.batches}  codex çağrısı: ${s.calls}`);
      console.log(`yeni bulgu: ${s.findings}  supersede: ${s.superseded}`);
      if (s.skippedTurns > 0) console.log(`filigranla elenen tekrar turn: ${s.skippedTurns}`);
      if (s.unprocessed > 0) console.log(`⚠ işlenemeyen parti: ${s.unprocessed}  (ayrıntı: status)`);
      if (s.budgetExhausted) {
        // Yarım iş rc=0 dönemez: betikle koşan biri "bitti" sanar. Ayrı çıkış
        // kodu, "onay gerekiyor" (3) ile "onayla başladı ama yarıda kaldı"yı ayırır.
        console.error(`\n${budgetExhaustedMessage(s.calls, maxCalls)}`);
        exitCode = 4;
      }
    }
  } finally {
    // Kapanış finally'de, çıkış SONRA: process.exit() finally'yi çalıştırmıyor
    // ve depo tanıtıcısı açık kalıyordu.
    store.close();
  }
  if (exitCode !== 0) process.exit(exitCode);
}

/** Dönüş: maliyet kapısı işi durdurduysa true. Süreç çıkışı ÇAĞIRANA ait —
 *  process.exit() burada finally'yi atlayıp tarama kilidini asılı bırakıyordu. */
async function observeSingleSession(
  store: Store,
  observer: Observer,
  sessionPath: string,
  batchTokens: number,
  yes: boolean,
): Promise<boolean> {
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
    // Zaman damgası da bir filigran kimliği (batch.ts): uuid tutmayınca eleme
    // yapılmazsa önizleme "hepsi yeni" sanıp şişiyor ve --yes kapısını
    // gereksiz tetikliyordu. Observer'ın kendi elemesiyle aynı ölçüt kullanılmalı.
    const fresh = dropThroughWatermark(res.turns, wm?.lastUuid ?? null, wm?.lastTs ?? null);

    let filteredBytes = 0;
    for (const t of fresh) filteredBytes += Buffer.byteLength(t.text, "utf8");
    const est = estimateCalls(filteredBytes, batchTokens);
    console.log(
      `oturum: ${safe(sessionId)}  yeni turn: ${fresh.length}  ` +
        `parti: ${est.batches}  çağrı: beklenen ~${est.expected}, en kötü ${est.worst}`,
    );
    const gate = costGate(est, yes);
    if (!gate.ok) {
      console.error(gate.reason);
      return true;
    }
    await observer.handleTurns({ projectId, sessionId, turns: fresh });
    return false;
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
                         [--batch-tokens 500..200000] [--model M]
                         [--effort minimal|low|medium|high] [--yes]
  context-police status  [--store <db yolu>]

observe maliyeti:
  --yes VERİLMEDİKÇE bir koşum en fazla 20 Codex çağrısı yapar; sınıra gelince
  iş yarıda bırakılır (filigran ilerlemez, veri kaybolmaz) ve çıkış kodu 4 olur.
  --yes bu tavanı kaldırır: harcamayı onaylamış olursunuz.

çıkış kodları: 1 kullanım hatası · 2 codex yok · 3 onay gerekiyor · 4 bütçe doldu`);
  process.exit(cmd ? 1 : 0);
}
