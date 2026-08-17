#!/usr/bin/env node
// Çekirdeğin UI'sız girişi. Tauri kabuğu bunu sidecar olarak başlatacak;
// geliştirme ve ölçüm sırasında doğrudan kullanılır.

import { openStore, closeQuietly, defaultStorePath, type Store } from "./store/db.ts";
import { claudeCodeAdapter, readCwd } from "./adapters/claude-code.ts";
import { register } from "./adapters/transcript.ts";
import { scanOnce } from "./scan.ts";
import { auditProject, OriginRefUnresolved, type AuditSummary } from "./audit.ts";
import { listActive } from "./store/findings.ts";
import { listProjects, upsertProject } from "./store/projects.ts";
import { listEvents, countEvents } from "./store/events.ts";
import { Observer } from "./observer/observer.ts";
import { createCodexExecutor } from "./adapters/codex.ts";
import {
  observeGuard, estimateCalls, validateBatchTokens, validateEffort, validateModel,
  callBudget, costGate, budgetExhaustedMessage, budgetGuardedOnTurns,
  readSessionIncremental, recordSessionFreshness,
  auditCostGate, auditBudgetExhaustedMessage, SpendBudget, WORST_CASE_CALLS_PER_AUDIT,
  type Effort,
} from "./observe-cmd.ts";
import { logEvent } from "./store/events.ts";
import type { Turn } from "./types.ts";
import { withScanLock, ScanLockBusy } from "./store/lock.ts";
import {
  EXIT_USAGE, EXIT_NO_CODEX, EXIT_NEEDS_APPROVAL, EXIT_BUDGET, EXIT_LOCK_BUSY,
} from "./cli-exit.ts";
import { dropThroughWatermark, type DeliveryRange } from "./observer/batch.ts";
import { basename, dirname } from "node:path";
import { startServer } from "./serve/serve.ts";

register(claudeCodeAdapter);

/**
 * Düzenli kapanış kancaları. Ölçüldü (denetim 2026-08-11,
 * probes/audit-kill-leaves-active.sh): Node varsayılanında SIGINT/SIGTERM
 * `finally` bloklarını KOŞTURMADAN süreci bitiriyor — yani Ctrl-C tarama
 * kilidini asılı ve denetimi yarım bırakıyordu. Kilidin asılı kalması artık
 * kalıcı bir tıkanma DEĞİL (lock.ts: atışı kesilen sahip devralınıyor), ama yine
 * de bir arıza: hem devralma bir olay yazıp "kilit çalındı mı" sorusunu günlüğe
 * taşır, hem de sonraki koşum bayatlama süresi (10 dk) boyunca beklemek zorunda
 * kalır — düzgün kapanışta ikisi de olmamalı.
 * Kanca listesi LIFO: en son alınan kaynak ilk bırakılır.
 */
const interruptHandlers: ((signal: string) => void)[] = [];

function onInterrupt(fn: (signal: string) => void): () => void {
  interruptHandlers.push(fn);
  return () => {
    const i = interruptHandlers.indexOf(fn);
    if (i !== -1) interruptHandlers.splice(i, 1);
  };
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const fn of [...interruptHandlers].reverse()) {
      // Kapanış yolundaki ikinci hata yutulur: bir kancanın patlaması geri
      // kalan kaynakların (kilit!) bırakılmasını engellememeli.
      try { fn(sig); } catch { /* yut */ }
    }
    // 128 + sinyal numarası: kabuk sözleşmesi. rc=0 dönmek "iş bitti" derdi.
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

/**
 * Kullanım hatası. Ayrı bir tip, çünkü tek çıkış kodu (1) ve MESAJ basılmalı;
 * çıplak throw yığın izi basıp kullanıcıya bir şey anlatmıyor.
 */
class UsageError extends Error {}

interface OptionSpec {
  /** Değer alan seçenekler (`--ad değer` ya da `--ad=değer`). */
  readonly values: readonly string[];
  /** Değer ALMAYAN bayraklar. */
  readonly flags: readonly string[];
}

/**
 * Komut başına TANINAN seçenekler. Liste KAPALI: burada olmayan bir seçenek
 * kullanım hatasıdır, sessizce yutulmaz.
 */
const COMMANDS: Record<string, OptionSpec> = {
  scan: { values: ["dir", "store"], flags: [] },
  observe: {
    values: ["project", "session", "dir", "store", "batch-tokens", "model", "effort"],
    flags: ["yes"],
  },
  audit: {
    values: ["project", "path", "memory-dir", "store", "origin-ref"],
    // `--fetch` AÇIK istek: varsayılan artık kapalı (aşağıdaki gerekçe).
    // `--no-fetch` tanınmaya devam ediyor ama artık bir şeyi değiştirmiyor;
    // sessizce "bilinmeyen seçenek" hatası vermek, onu betiklerine yazmış olan
    // kullanıcının koşumunu kırardı — ve kaldırmanın hiçbir güvenlik kazancı yok.
    flags: ["no-fetch", "fetch", "json", "yes"],
  },
  status: { values: ["store"], flags: [] },
  serve: { values: ["store", "port"], flags: [] },
};

let parsedOptions = new Map<string, string | true>();
let parsedSpec: OptionSpec = { values: [], flags: [] };

/**
 * argv'yi komutun seçenek listesine karşı BİR KEZ, komut gövdesi çalışmadan
 * önce ayrıştırır. Eskiden ayrıştırma yoktu: `arg()` argv'de `--ad` token'ını
 * ARIYORDU ve bulamazsa "verilmemiş" sayıyordu.
 *
 * Ölçüldü (probes/cli-option-spelling-leaks.sh): `--model=`, `--effort=`,
 * `-model x`, `--model good --model` ve `--effort low --effort` biçimlerinin
 * BEŞİ DE kullanım hatası vermek yerine varsayılanla ilerleyip Codex tespitine
 * kadar gidiyordu. Aramak yerine AYRIŞTIRMAK bu sınıfı topluca kapatır:
 * bilinmeyen yazım "hiç verilmemiş" olamaz, çünkü her token bir kurala çarpar.
 *
 * Kurallar ve gerekçeleri:
 * - `--` ile başlamayan token: `-model` gibi tek tireli yazımlar burada durur.
 *   Konumsal operandımız yok, dolayısıyla belirsizlik de yok.
 * - Bilinmeyen ad: yazım hatasının sessiz varsayılana dönüşmesini engeller.
 * - Aynı seçenek iki kez: hangisinin geçerli olduğu tanımsız. Eski kod İLKİNİ
 *   alıp ikinciyi hiç görmüyordu — kullanıcı ikincisinin geçtiğini sanıyordu.
 * - Boş değer (`--model=` ya da `--model ""`): "değer verilmedi" ile aynı şey.
 *
 * Değerin `--` ile başlaması eksik operandın en yaygın hâli. Tek tireli DEĞER
 * reddedilmiyor: negatif sayı gibi meşru kullanımı var, ve `--model -x` zaten
 * validateModel'in kapısında duruyor.
 */
function parseArgs(cmd: string, spec: OptionSpec): void {
  const out = new Map<string, string | true>();
  const argv = process.argv.slice(3);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--") || token === "--")
      throw new UsageError(`beklenmeyen argüman: ${safe(token)} (seçenekler --ad biçiminde yazılır)`);

    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const takesValue = spec.values.includes(name);
    if (!takesValue && !spec.flags.includes(name))
      throw new UsageError(`bilinmeyen seçenek: --${safe(name)} (${cmd} için geçerli değil)`);
    if (out.has(name)) throw new UsageError(`--${name} iki kez verildi`);

    if (!takesValue) {
      if (eq !== -1) throw new UsageError(`--${name} değer almaz`);
      out.set(name, true);
      continue;
    }

    let value: string | undefined;
    if (eq !== -1) value = token.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) value = argv[++i];
    if (value === undefined || value === "") throw new UsageError(`--${name} bir değer bekliyor`);
    out.set(name, value);
  }

  parsedOptions = out;
  parsedSpec = spec;
}

/** `--ad` değeri. Listede olmayan ad sorulması KOD hatasıdır, kullanım hatası değil. */
function arg(name: string): string | undefined {
  if (!parsedSpec.values.includes(name))
    throw new Error(`iç hata: --${name} bu komutun değer alan seçenekleri arasında yok`);
  const v = parsedOptions.get(name);
  return typeof v === "string" ? v : undefined;
}

/** Değer almayan bayrak verildi mi. */
function flag(name: string): boolean {
  if (!parsedSpec.flags.includes(name))
    throw new Error(`iç hata: --${name} bu komutun bayrakları arasında yok`);
  return parsedOptions.get(name) === true;
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
    // Sinyal kancası `audit` ve `observe --session` ile AYNI: ölçüldü
    // (probe: scan-sigterm-leaves-lock) yalnız bu yol eksikti ve SIGTERM kilidi
    // asılı bırakıyordu. Sıra da aynı: önce kilit, sonra depo — kapanmış bir
    // bağlantıya yazmaya çalışan bir atış zamanlayıcısı kalmasın.
    const sum = await scanOnce(store, {
      adapter: claudeCodeAdapter,
      root: arg("dir"),
      onLock: (lock) => onInterrupt(() => { lock.release(); closeQuietly(store); }),
    });
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
    // Reported separately and worded as recovery: these sessions WERE delivered.
    if (sum.identityRecovered > 0) {
      console.log(`kimlik ölçümü kurtarıldı: ${sum.identityRecovered}  (oturum teslim edildi, ayrıntı: status)`);
    }
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
    // `close()` DEĞİL `closeQuietly()`: `finally` içinden fırlayan bir kapanış
    // hatası `try` bloğunun sonucunu/hatasını EZER — kapanmış bir DatabaseSync
    // üzerinde `close()` fırlıyor (mekanizma kanıtlandı). Gerekçe db.ts'te;
    // aynı değişiklik bu dosyadaki dört `finally`nin hepsinde.
    closeQuietly(store);
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
    process.exit(EXIT_USAGE);
  }

  const executor = createCodexExecutor({ model, reasoningEffort: effort });

  // K2: Codex sert bağımlılık. Yoksa yönlendir, çalışmayı deneme.
  const det = await executor.detect();
  if (!det.found) {
    console.error(`codex bulunamadı: ${det.error ?? "PATH'te yok"}`);
    console.error("kurulum: npm install -g @openai/codex  (ya da https://developers.openai.com/codex)");
    process.exit(EXIT_NO_CODEX);
  }
  console.log(`codex ${det.version} bulundu`);

  const yes = flag("yes");
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
      if (halted) exitCode = EXIT_NEEDS_APPROVAL;
    } else {
      const guard = observeGuard(store, yes);
      if (!guard.ok) {
        console.error(guard.reason);
        exitCode = EXIT_NEEDS_APPROVAL;
      } else {
        console.log(
          maxCalls === undefined
            ? "maliyet tavanı: yok (--yes verildi)"
            : `maliyet tavanı: en fazla ${maxCalls} Codex çağrısı (--yes ile kaldırılır)`,
        );
        await scanOnce(store, {
          adapter: claudeCodeAdapter,
          root: arg("dir"),
          // AYNI EKSİKLİK BURADAYDI: `observe --session` kancayı kuruyordu ama
          // `observe`un tam-tarama dalı kilidi scanOnce'ın içinde alıyor,
          // dolayısıyla o da sinyalde kilidi asılı bırakıyordu.
          onLock: (lock) => onInterrupt(() => { lock.release(); closeQuietly(store); }),
          only: arg("project") ? [arg("project")!] : undefined,
          onTurns: budgetGuardedOnTurns(
            () => observer.stats.budgetExhausted,
            (ctx: { projectId: number; sessionId: string; turns: Turn[]; range: DeliveryRange }) =>
              observer.handleTurns(ctx),
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
        exitCode = EXIT_BUDGET;
      }
    }
  } finally {
    // Kapanış finally'de, çıkış SONRA: process.exit() finally'yi çalıştırmıyor
    // ve depo tanıtıcısı açık kalıyordu.
    closeQuietly(store);
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
  return await withScanLock(store, async (lock) => {
    // Ctrl-C burada da kilidi asılı bırakıyordu (aynı ölçüm: Node sinyalde
    // finally'leri koşturmuyor) — audit'in kancasıyla aynı mekanizma.
    // `lock.release()` kalp atışı zamanlayıcısını da durduruyor: yalnız satırı
    // silmek, kapanan bir depoya yazmaya çalışan bir zamanlayıcı bırakırdı.
    const off = onInterrupt(() => {
      lock.release();
      closeQuietly(store);
    });
    try {
      return await observeBody(store, observer, sessionPath, projPath, sessionId, batchTokens, yes);
    } finally {
      off();
    }
  });
}

/** observeSingleSession'ın kilit ALTINDA koşan gövdesi; ayrılması yalnız yuvalanmayı azaltıyor. */
async function observeBody(
  store: Store,
  observer: Observer,
  sessionPath: string,
  projPath: string,
  sessionId: string,
  batchTokens: number,
  yes: boolean,
): Promise<boolean> {
  const projectId = upsertProject(store, {
    path: projPath,
    adapterId: claudeCodeAdapter.id,
    transcriptDir: dirname(sessionPath), // dizin, dosya değil — projects sözleşmesi
  });
  // İmleçlere DOKUNULMAZ: imleç taramanın, filigran gözlemcinin (D-M2-2).
  // Okuma FİLİGRANIN ofsetinden başlıyor — filigran artık bir bayt ofseti
  // olduğu için gözlemcinin kendi ilerlemesi burada da kullanılabiliyor.
  // Eskiden dosya her koşumda 0'dan okunuyordu ve eleme içerik kimliğine
  // kaldığı için `--session` aynı oturumu tekrar tekrar Codex'e gönderiyordu.
  const { wm, res, range } = await readSessionIncremental(store, projectId, sessionId, sessionPath);
  // Önizleme gözlemcinin KENDİ kararıyla aynı fonksiyondan çıkıyor: iki ayrı
  // ölçüt, maliyet kapısının yanlış sayıya bakması demek olurdu.
  const fresh = dropThroughWatermark(res.turns, wm, range);

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
  // Turn'ler SÜZÜLMEDEN veriliyor: eleme kararı gözlemcinin, ve aynı aralığın
  // kimliği ancak listenin tamamıyla hesaplanırsa tarama yolununkiyle örtüşür.
  await observer.handleTurns({ projectId, sessionId, turns: res.turns, range });
  // Tazelik SONRA yazılıyor: handleTurns atarsa filigran okuduğumuz dosyanın
  // kimliğini üstlenmemeli, yoksa işlenmemiş bir okuma "görüldü" sayılırdı.
  recordSessionFreshness(store, projectId, sessionId, res);
  return false;
}

async function cmdAudit(): Promise<void> {
  // K2: Codex sert bağımlılık — audit'in tek LLM kullanımı sınıflama olsa da
  // kapı aynı. Depo AÇILMADAN önce: yoksa yapacak bir iş yok.
  const executor = createCodexExecutor({});
  const det = await executor.detect();
  if (!det.found) {
    console.error(`codex bulunamadı: ${det.error ?? "PATH'te yok"}`);
    console.error("kurulum: npm install -g @openai/codex  (ya da https://developers.openai.com/codex)");
    process.exit(EXIT_NO_CODEX);
  }

  // Fetch VARSAYILAN KAPALI (denetim: transcript-cwd-fetch). Ölçüldü: denetlenecek
  // repo transcript'teki `cwd` alanından geliyor, yani güvenilmeyen veriyle
  // seçiliyor; ve hedef reponun .git/config'indeki `remote.origin.uploadpack`
  // fetch sırasında keyfî YEREL komut çalıştırıyor (rc=0, marker oluştu).
  // Zincir gerçekçi: içinde `.git/` olan bir arşiv açılır, orada bir kez ajan
  // oturumu açılır, sonra tek bir argümansız `audit` o dizinde fetch koşar.
  // Ağ + kod çalıştırma artık AÇIK istekle gelir.
  if (flag("fetch") && flag("no-fetch"))
    throw new UsageError("--fetch ile --no-fetch birlikte verilemez (fetch zaten varsayılan olarak kapalı)");
  const doFetch = flag("fetch");
  const yes = flag("yes");

  const store = openStore(arg("store") ?? defaultStorePath());
  // Tarama kilidi observe'daki gerekçenin aynısıyla burada da ZORUNLU: import
  // "en son canlı temsil"i okuyup yenisini yazıyor, bu okuma-yazma atomik değil.
  // Aynı anda koşan iki denetim (ya da bir denetim + bir tarama) aynı dosya için
  // iki canlı kayıt bırakabilir — Görev 4 ölçümü.
  // `runId` hâlâ PID taşıyor: o bir KOŞUM ETİKETİ, kilit sahipliği kanıtı değil.
  // Günlükte "hangi süreç" sorusunu cevaplaması faydalı ve yanlış olma riski yok
  // — kimse ona bakıp bir kilidi devralmıyor.
  const runId = `${new Date().toISOString()}-${process.pid}`;
  let current: { id: number; path: string } | null = null;
  let exitCode = 0;
  try {
    await withScanLock(store, async (lock) => {
      // Kilit ALINDIKTAN sonra kaydediliyor: kanca ancak bırakacak bir şey varken
      // anlamlı, ve kilidi almadan bırakmaya çalışmak başkasının kilidini silmez
      // (releaseScanLock sahip eşleşmesi arıyor) ama gereksiz.
      const off = onInterrupt((signal) => {
        // Kesinti DEPODA yazılı kalır: yarım denetim "ölçüldü, temiz çıktı" ile
        // karışmasın. Olay ÖNCE, kilit sonra — kilit bırakıldıktan sonra yazmak
        // başka bir koşumun araya girdiği bir pencere açardı.
        try {
          logEvent(store, {
            projectId: current?.id ?? null, kind: "audit_failed",
            detail: { runId, reason: `signal:${signal}`, path: current?.path ?? null },
          });
        } catch { /* yut: kilidi bırakmak daha önemli */ }
        // `lock.release()` zamanlayıcıyı da durduruyor — depo hemen kapanıyor ve
        // ayakta kalan bir atış kapalı bağlantıya yazmaya çalışırdı.
        lock.release();
        closeQuietly(store);
      });
      try {
        // İki mod: depodaki projeler (--project süzer) ya da elle kayıt
        // (--path [+ --memory-dir]); altın set ölçümü pin'li worktree'yi böyle
        // denetliyor (D-M3-8).
        let targets: { id: number; path: string; memoryDir: string | null }[];
        const manualPath = arg("path");
        if (manualPath !== undefined) {
          const memoryDir = arg("memory-dir") ?? null;
          const id = upsertProject(store, {
            path: manualPath, adapterId: claudeCodeAdapter.id,
            transcriptDir: manualPath, memoryDir,
          });
          // --memory-dir verilmediyse depodaki kayıt kullanılır: upsertProject
          // null'ı COALESCE ile yutuyor, yani proje bilinen bir hafıza dizinine
          // sahipken burada null geçmek o dizini SESSİZCE denetim dışı bırakırdı.
          const stored = listProjects(store).find((p) => p.id === id);
          targets = [{ id, path: manualPath, memoryDir: memoryDir ?? stored?.memory_dir ?? null }];
        } else {
          targets = listProjects(store)
            .filter((p) => arg("project") === undefined || p.path === arg("project"))
            .map((p) => ({ id: p.id, path: p.path, memoryDir: p.memory_dir }));
          if (targets.length === 0) throw new UsageError("denetlenecek proje yok: önce `scan` koşun ya da --path verin");
        }

        // Maliyet kapısı: observe'un kalıbı. Ölçüldü (2026-08-11): audit'te hiç
        // kapı yoktu ve bu makinede 11 hafıza dizininin 11'i de çelişki adayı
        // üretiyor (123 aday) — tek bir argümansız `audit` onaysız 11-33 ücretli
        // Codex çağrısı yapıyordu, her biri ~15k token'a kadar.
        const maxCalls = callBudget(yes);
        const budget = new SpendBudget(maxCalls);
        const gate = auditCostGate(targets.length, yes);
        console.log(
          `denetlenecek proje: ${targets.length}  çelişki sınıflaması: ` +
            `beklenen ~${gate.est.expected}, en kötü ${gate.est.worst} Codex çağrısı`,
        );
        console.log(
          maxCalls === undefined
            ? "maliyet tavanı: yok (--yes verildi)"
            : `maliyet tavanı: en fazla ${maxCalls} Codex çağrısı (--yes ile kaldırılır)`,
        );

        if (!gate.ok) {
          // Onay gerekiyor: TEK ücretli çağrı yapılmadan durulur (observe ile aynı
          // çıkış kodu — 3 "onay gerekiyor", 4 "onayla başladı ama yarıda kaldı").
          console.error(gate.reason);
          exitCode = EXIT_NEEDS_APPROVAL;
        } else {
          const results: { path: string; id: number; summary: AuditSummary }[] = [];
          let halted = false;
          for (const t of targets) {
            // Tavan kontrolü proje BAŞLAMADAN: yarım denetlenmiş bir proje, çelişki
            // sinyali eksik olduğu için notları haksız yere temize çıkarabilirdi
            // (skor sıfırdan hesaplanıyor — D-M3-3). Ya tamamı ya hiçbiri.
            if (!budget.canAfford(WORST_CASE_CALLS_PER_AUDIT)) { halted = true; break; }
            current = { id: t.id, path: t.path };
            // Fetch açıkken HANGİ repoda koşulacağı basılır: hedefi seçen veri
            // (transcript `cwd`) güvenilmez, kullanıcı en azından görmüş olmalı.
            if (doFetch) console.log(`git fetch (--fetch) hedefi: ${safe(t.path)}`);
            const summary = await auditProject(store, t, {
              executor, fetch: doFetch, originRef: arg("origin-ref"), runId,
            });
            budget.spend(summary.classifyCalls);
            results.push({ path: t.path, id: t.id, summary });
          }
          current = null;

          if (flag("json")) console.log(JSON.stringify(results, null, 2));
          else printAuditResults(store, results);

          if (halted) {
            console.error(`\n${auditBudgetExhaustedMessage(budget.spent, results.length, targets.length, maxCalls)}`);
            exitCode = EXIT_BUDGET;
          }
        }
      } finally {
        off();
      }
    });
  } finally {
    closeQuietly(store);
  }
  if (exitCode !== 0) process.exit(exitCode);
}

/**
 * İnsan kipi çıktı. Ayrı fonksiyon, çünkü cmdAudit'in akışı (kapı → bütçe →
 * çıkış kodu) ile raporlama iki ayrı iş.
 */
function printAuditResults(
  store: Store,
  results: { path: string; id: number; summary: AuditSummary }[],
): void {
  for (const { path, id, summary: s } of results) {
    console.log(`\n${safe(path)}`);
    if (s.import) {
      console.log(`  import: +${s.import.added} ~${s.import.replaced} -${s.import.deleted} (değişmeyen ${s.import.unchanged})`);
      // Ölçüldü (denetim: import-errors-hidden): okunamayan dizin ile boş ama
      // okunabilir dizin BAYT BAYT aynı çıktıyı veriyordu (`+0 ~0 -0`, rc=0).
      // Sayılar `--json`da vardı, insan kipinde yoktu — yani hiç hafıza
      // okunmamış bir denetim "temiz denetim" gibi görünüyordu.
      if (s.import.errors > 0)
        console.log(`  ⚠ import okunamayan: ${s.import.errors}  (o notlar HİÇ denetlenmedi — ayrıntı: status)`);
      if (s.import.rejected > 0)
        console.log(`  ⚠ import reddedilen girdi: ${s.import.rejected}  (hafıza ağacının dışını gösteriyordu)`);
    }
    if (!s.gitAvailable) console.log("  ⚠ git yok: çapa sinyali KAPALI, yalnız çelişki koşuyor");
    // Fetch arızası sinyali kapatmadığı için hiçbir sayaçta iz bırakmıyor:
    // burada söylenmezse hiç söylenmez, ve kullanıcı bayat bir origin'e karşı
    // yapılmış ölçümü taze sanır.
    if (s.fetchFailed)
      console.log("  ⚠ git fetch başarısız: origin ref'i BAYAT olabilir, ölçüm eski uca karşı koştu (ayrıntı: status)");
    console.log(`  denetlenen: ${s.checked}  şüpheli: ${s.suspects}  temize dönen: ${s.cleared}`);
    // "codex çağrısı" GERÇEK koşum sayısıdır, aday sayısı değil: tek toplu
    // sınıflama yürütücü tekrarı ya da düzeltme turuyla birden çok koşum
    // olabiliyor (Görev 9). Bu yüzden hiçbir yerde "tek çağrı" denmiyor.
    console.log(`  çelişki adayı: ${s.candidates}  onaylanan: ${s.contradictions}  codex çağrısı: ${s.classifyCalls}`);
    if (s.classifyDropped > 0) console.log(`  ⚠ tavan üstü sınıflanmayan aday: ${s.classifyDropped}`);
    const st = s.anchorStates;
    console.log(`  çapa: ok ${st.ok}  kayıp ${st.missing_now}  ` +
      `çalkantılı ${st.churned}  hiç-yok ${st.never_existed}  doğrulanamayan ${st.unverifiable}`);
    // "git söyleyemedi" ile "dosya duruyor" ayrı şeyler: ölçüm arızası skora
    // katkı vermiyor (A dalgası), dolayısıyla burada görünmezse HİÇ görünmez.
    if (s.measurementFailures > 0)
      console.log(`  ⚠ ölçüm arızası: ${s.measurementFailures} çapa doğrulanamadı (git cevap veremedi — ayrıntı: status)`);
    for (const f of listActive(store, id).filter((f) => f.status === "suspect"))
      console.log(`  🔶 #${f.id} (${f.suspicion.toFixed(2)}) ${safe(f.content.slice(0, 80))}`);
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
    // Import olayları hiç sayılmıyordu: `audit`in özet satırı "+0 ~0 -0" derken
    // bunun sebebi "hafıza boş" da olabiliyor "dizin okunamadı" da (ölçüldü:
    // ikisi bayt bayt aynı çıktıydı). Sayılar burada ayrışıyor.
    console.log(`import: okunamayan ${countEvents(store, "import_read_failed")}, ` +
      `reddedilen girdi ${countEvents(store, "import_entry_rejected")}, ` +
      `diskten silinen not ${countEvents(store, "import_file_deleted")}, ` +
      `çapa taşması ${countEvents(store, "import_anchor_overflow")}`);
    // başlayan > biten: yarım kalmış denetim var. Bu fark olmadan yarım denetim
    // "ölçüldü, temiz çıktı"dan ayırt edilemiyordu.
    console.log(`denetim: başlayan ${countEvents(store, "audit_started")}, ` +
      `biten ${countEvents(store, "audit_completed")}, ` +
      `kesilen ${countEvents(store, "audit_failed")}, ` +
      `ölçüm arızası ${countEvents(store, "anchor_measurement_failed")}, ` +
      `fetch arızası ${countEvents(store, "git_fetch_failed")}`);
  } finally {
    closeQuietly(store);
  }
}

async function cmdServe(): Promise<void> {
  const storePath = arg("store") ?? defaultStorePath();
  const rawPort = arg("port");
  const port = rawPort === undefined ? 4870 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`gecersiz port: ${safe(rawPort ?? "")}`);
  }
  let server;
  try {
    server = await startServer({ storePath, port });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
      console.error(`port ${port} dolu; --port <n> ile baska port verin`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  console.log(`kesif gezgini: http://127.0.0.1:${port} (depo: ${safe(storePath, 200)})`);
  onInterrupt(() => { server.close(); });
  // Keep the process alive until a signal arrives; the interrupt hook exits.
  await new Promise(() => {});
}

const cmd = process.argv[2];
try {
  const spec = cmd === undefined ? undefined : COMMANDS[cmd];
  if (spec === undefined) usage();
  else {
    // Ayrıştırma komut gövdesinden ÖNCE: kullanım hatası için ne Codex ne depo
    // gerekiyor, ve yazım hatasının maliyeti bir mesaj olmalı, bir süreç değil.
    parseArgs(cmd!, spec);
    if (cmd === "scan") await cmdScan();
    else if (cmd === "observe") await cmdObserve();
    else if (cmd === "audit") await cmdAudit();
    else if (cmd === "serve") await cmdServe();
    else cmdStatus();
  }
} catch (err) {
  // Kilit çakışması ÖNCE ve AYRI kodla: ölçüldü (probes/lock-busy-exit-is-usage.sh)
  // ScanLockBusy hiç yakalanmıyordu — kullanıcı yığın izi görüyor ve rc=1
  // dönüyordu, yani "argümanın yanlış" ile bayt bayt aynı. Oysa tepki taban
  // tabana zıt: burada argüman doğru, tek doğru davranış BEKLEYİP TEKRAR DENEMEK.
  if (err instanceof ScanLockBusy) {
    console.error(`${err.message} — bitmesini bekleyip tekrar deneyin (kilit bayatlarsa kendiliğinden devralınır)`);
    process.exit(EXIT_LOCK_BUSY);
  }
  // Kullanım hatası her komutta aynı: mesaj + rc=1. Diğer hatalar olduğu gibi
  // yukarı çıkar — yığın izi teşhis için gerekli.
  //
  // OriginRefUnresolved de buraya dahil: kaynağı kullanıcının verdiği bir bayrak
  // değeri, dolayısıyla yığın izi değil MESAJ gerekiyor — ama sessizce devam
  // etmek yasak (ölçüldü: geçersiz --origin-ref denetimi sessizce yalnız HEAD'e
  // karşı koşturuyordu ve altın set ölçümü tam o pine dayanıyor).
  if (!(err instanceof UsageError) && !(err instanceof OriginRefUnresolved)) throw err;
  console.error(err.message);
  process.exit(EXIT_USAGE);
}

function usage(): void {
  console.log(`context-police — AI ajan hafızası denetçisi (çekirdek)

kullanım:
  context-police scan    [--dir <transcript kökü>] [--store <db yolu>]
  context-police observe [--project <yol>] [--session <jsonl>] [--dir <kök>] [--store <db>]
                         [--batch-tokens 500..200000] [--model M]
                         [--effort minimal|low|medium|high] [--yes]
  context-police audit   [--project <yol>] [--path <repo> [--memory-dir <dizin>]]
                         [--origin-ref <ref>] [--fetch] [--json] [--yes] [--store <db>]
  context-police status  [--store <db yolu>]
  context-police serve   [--store <db yolu>] [--port <n>]

audit: hafıza notlarını içeri alır, çapa kayması ve çelişki sinyallerini koşar,
  şüphelileri DEPODA işaretler. Hiçbir memory dosyasına yazmaz (K9).
  --fetch VERİLMEDİKÇE hiç ağ işlemi yapılmaz. Varsayılan kapalı, çünkü
  denetlenecek repo transcript verisinden seçiliyor ve fetch o reponun kendi
  yapılandırmasındaki komutu çalıştırabiliyor. (--no-fetch hâlâ kabul ediliyor
  ama artık etkisiz: kapalı zaten varsayılan.)

maliyet (observe ve audit):
  --yes VERİLMEDİKÇE bir koşum en fazla 20 Codex çağrısı yapar.
  observe: sınıra gelince iş yarıda bırakılır (filigran ilerlemez, veri
  kaybolmaz) ve çıkış kodu 4 olur.
  audit: koşum ÖNCESİ tahmin basılır (proje başına en kötü 3 çağrı); tahmin
  tavanı aşıyorsa TEK ücretli çağrı yapılmadan durulur ve çıkış kodu 3 olur.
  --yes bu tavanı kaldırır: harcamayı onaylamış olursunuz.

çıkış kodları: 1 kullanım hatası · 2 codex yok · 3 onay gerekiyor · 4 bütçe doldu
                5 tarama kilidi başkasında (geçici: bekleyip tekrar deneyin)
                130/143 SIGINT/SIGTERM ile kesildi (kilit bırakıldı, kesinti depoda yazılı)`);
  process.exit(cmd ? EXIT_USAGE : 0);
}
