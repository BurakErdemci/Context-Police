// Codex headless yürütücüsü (spec K1, K2). Bayraklar 0.146.0'da doğrulandı:
//   --ephemeral            oturum dosyası kalmaz (K7'nin Codex tarafı)
//   -s read-only           sandbox: yazma yok
//   --output-schema <f>    son cevabı JSON şemaya bağlar
//   -o <f>                 son mesaj dosyaya — stdout'un insan-gözü akışından bağımsız
//   prompt stdin'den ("-") — büyük partilerde ARG_MAX derdi yok (D-M2-5)

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutorAdapter,
  ExecutorCapExceeded,
  ExecutorDetection,
  ExecutorRequest,
  ExecutorResult,
  ExecutorUsage,
} from "./executor.ts";

export interface CodexOptions {
  /** Verilmezse kullanıcının ~/.codex/config.toml varsayılanı geçerli (D-M2-6). */
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Parti başına üst sınır; varsayılan 180 sn. */
  timeoutMs?: number;
  /**
   * detect() üst sınırı; varsayılan 10 sn. timeoutMs'ten AYRI tutulur —
   * bkz. DEFAULT_DETECT_TIMEOUT_MS. Yalnız testlerin bunu saniyelerce
   * beklemek zorunda kalmaması için dışarı açık.
   */
  detectTimeoutMs?: number;
  /** Testlerde sahte binary; üretimde PATH'teki "codex". */
  binary?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
/**
 * detect() için AYRI ve kısa varsayılan. Parti zaman aşımı (180 sn) burada
 * kullanılamaz: sürüm sorgusu saniyeler sürer, dakikalar değil. Denetim bulgusu
 * (unbounded-executor-detection, iki bağımsız lane): detect()'te hiç timeout
 * yoktu — PATH'teki codex asılırsa `observe` komutu daha ilk kapıda (K2)
 * sonsuza kadar bekliyordu.
 */
const DEFAULT_DETECT_TIMEOUT_MS = 10_000;
const STDERR_TAIL = 500;

/**
 * Hatayı teşhis edilebilir bir dizeye çevirir. `code` (errno) mesajın ÖNÜNE
 * konur: "EACCES" ile "ENOENT" farklı işler gerektiriyor ve yalnız `message`
 * taşınırsa bu ayrım çağırana ulaşmıyor.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Süreç GRUBUNU öldürür, olmazsa tekil PID'ye düşer.
 *
 * Bulgu (orphaned-descendant-on-timeout): timeout yalnız doğrudan çocuğa SIGKILL
 * yolluyordu; codex'in başlattığı torun süreçler (sandbox yardımcıları, model
 * istemcisi) yaşamaya devam edip tekrarlanan zehirli partilerde birikiyordu.
 * Çözüm: süreci `detached: true` ile kendi süreç grubunun LİDERİ yap (POSIX'te
 * pgid == child.pid), sonra negatif PID ile tüm gruba sinyal gönder.
 *
 * POSIX dışı: Windows'ta süreç grubu kavramı yok — `detached` yeni bir konsol
 * açar ve process.kill(-pid) çalışmaz. Orada ilk deneme ESRCH/EINVAL ile
 * döner ve tekil PID'ye düşeriz, yani davranış eski hâline eşit (torunlar
 * hayatta kalır). Prototip hedefi macOS/Linux.
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid == null) return;
  try {
    process.kill(-pid, "SIGKILL"); // negatif PID = tüm süreç grubu
  } catch {
    // ESRCH (grup yok / zaten öldü) ya da POSIX dışı platform → tekil PID.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* süreç zaten ölmüş; yapacak bir şey yok */
    }
  }
}

/*
 * --- Sinyal temizliği ---------------------------------------------------
 *
 * Bulgu (probes/executor-parent-kill-leaks.sh): temizlik yalnız `finally`ye ve
 * zamanlayıcıya bağlıydı. Node varsayılanında SIGINT/SIGTERM süreci doğrudan
 * sonlandırıyor — `finally` KOŞMUYOR — ve geride detached bir çocuk süreç grubu
 * (codex + torunları) ile bir cp-codex-* dizini kalıyordu.
 *
 * ÇÖZÜLEMEYEN kısım: SIGKILL. Orada hiçbir kullanıcı kodu çalışmaz, dolayısıyla
 * ne süreç grubu öldürülebilir ne dizin silinebilir; POSIX'te üst süreç ölünce
 * çocuğu öldüren bir mekanizma da yok (Linux'un PR_SET_PDEATHSIG'i Node'dan
 * erişilebilir değil). SIGKILL sonrası artıklar bilerek kabul ediliyor.
 *
 * Kayıt DEFTERİ modül seviyesinde: aynı süreçte birden çok run()/detect() aynı
 * anda koşabilir ve sinyal geldiğinde hepsinin kaynağı temizlenmeli.
 */
const liveTempDirs = new Set<string>();
const liveGroups = new Set<number>();

/**
 * Kaydı düşmüş ama HÂLÂ yaşayan bir süreç mi? `kill(pid, 0)` sinyal göndermez,
 * yalnız varlığı sınar (ESRCH → yok).
 *
 * Neden gerekli: kayıt `liveGroups`'tan ancak `close`/`error` işleyicisinde
 * düşüyor, oysa çocuk ondan ÖNCE ölüyor. Lane ölçtü (14 Ağu,
 * probes/signal-cleanup-stale-group.sh): `exit`→`close` arası ~1,1–1,4 ms ve o
 * anda `kill(pid, 0)` zaten ESRCH veriyor — yani çocuk çıkmışken gelen bir
 * SIGINT, işletim sisteminin GERİ DÖNÜŞTÜRDÜĞÜ bir PID'nin grubuna SIGKILL
 * atabilirdi. Akış yolunda aynı koruma `closed` bayrağıyla zaten vardı; bu,
 * onun sinyal yolundaki karşılığı.
 *
 * Kaydı `exit`te düşürmek yerine burada sınamanın sebebi: `exit` ile `close`
 * arasında çocuğun TORUNLARI hâlâ yaşıyor olabilir ve grup öldürme onlar için
 * var (killProcessGroup). Kaydı erken düşürmek o yeteneği kaybettirirdi;
 * canlılık sınaması yalnız çocuğun ispatlı biçimde gittiği durumda susturuyor.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sinyal işleyicisi senkron olmak zorunda: süreç kapanmadan önce bitmeli. */
function cleanupNow(): void {
  // Second surface of the same class as the temp-dir loop below: ownership was
  // released for every pid regardless of whether the kill landed.
  // killProcessGroup swallows its errors and cannot report success, so liveness
  // after the attempt is the only honest signal. Erring towards RETAINING is
  // deliberate — SIGKILL is asynchronous, so a still-alive reading may just be
  // a race, and holding a pid we no longer own costs nothing while forgetting a
  // live one orphans a process group.
  for (const pid of [...liveGroups]) {
    if (isProcessAlive(pid)) killProcessGroup(pid);
    if (!isProcessAlive(pid)) liveGroups.delete(pid);
  }
  // Ownership is released per directory and only on success. The blanket
  // `clear()` that stood here dropped the entry even when rmSync threw, so a
  // transient EBUSY at shutdown orphaned the directory with nothing left
  // holding its path (verification round 2, 15 Aug). Still no retry loop: the
  // handler must stay synchronous, and delaying exit is not worth a temp dir.
  for (const dir of [...liveTempDirs]) {
    try {
      rmSync(dir, { recursive: true, force: true });
      liveTempDirs.delete(dir);
    } catch {
      /* keep the entry: a later signal, or the process-exit hook, can retry */
    }
  }
}

const FATAL_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function onFatalSignal(sig: NodeJS.Signals): void {
  cleanupNow();
  // Stay installed while anything is still registered — cleanupNow only drops
  // what it actually removed, so a leftover entry means a removal failed and is
  // worth retrying. Uninstalling unconditionally made that retry impossible:
  // ownership was kept but nothing could ever act on it (verification round 2).
  // Same condition untrack() already uses; this is that idiom on the signal path.
  const pending = liveTempDirs.size > 0 || liveGroups.size > 0;
  if (!pending) uninstallSignalHandlers();

  // Bir dinleyici EKLEMEK Node'un varsayılan sonlandırmasını iptal ediyor.
  // cli.ts kendi işleyicisini eklerse kapanış kararı onundur (Node çoklu
  // dinleyiciye izin veriyor, çakışma yok); kimse kalmadıysa varsayılanı geri
  // getiriyoruz, yoksa Ctrl-C süreci asardı.
  // Our own handler must not count towards "someone else will decide": if it
  // did, keeping it installed above would be exactly the hang this guards.
  const ours = signalHandlers.size > 0 ? 1 : 0;
  if (process.listenerCount(sig) - ours === 0) {
    uninstallSignalHandlers();
    process.kill(process.pid, sig);
  }
}

const signalHandlers = new Map<NodeJS.Signals, () => void>();

function installSignalHandlers(): void {
  if (signalHandlers.size > 0) return;
  for (const sig of FATAL_SIGNALS) {
    const h = () => onFatalSignal(sig);
    signalHandlers.set(sig, h);
    // prepend: başka bir sahip (cli.ts) kendi işleyicisinde process.exit()
    // çağırırsa sıradaki dinleyiciler HİÇ koşmaz. Bizimki senkron ve
    // milisaniyelik; önde koşarsa kimsenin kapanış kararına engel olmaz.
    process.prependListener(sig, h);
  }
}

/** Temizlenecek kaynak kalmadıysa dinleyiciyi bırak: kütüphane, sürecin sinyal
 *  davranışına gereğinden uzun süre karışmamalı (ve testler dinleyici sızdırmaz). */
function uninstallSignalHandlers(): void {
  for (const [sig, h] of signalHandlers) process.removeListener(sig, h);
  signalHandlers.clear();
}

function trackTempDir(dir: string): void {
  liveTempDirs.add(dir);
  installSignalHandlers();
}

function trackGroup(pid: number | undefined): void {
  if (pid == null) return;
  liveGroups.add(pid);
  installSignalHandlers();
}

function untrack(kind: "dir" | "group", value: string | number | undefined): void {
  if (kind === "dir") liveTempDirs.delete(value as string);
  else if (value != null) liveGroups.delete(value as number);
  if (liveTempDirs.size === 0 && liveGroups.size === 0) uninstallSignalHandlers();
}

/** codex `--json` akışındaki usage alanları; ExecutorUsage'ın camelCase karşılıkları. */
const USAGE_FIELDS = [
  ["input_tokens", "inputTokens"],
  ["cached_input_tokens", "cachedInputTokens"],
  // Ücretlendirilen bir kalem → tavan toplamına da girer (bkz. ExecutorUsage).
  ["cache_write_input_tokens", "cacheWriteInputTokens"],
  ["output_tokens", "outputTokens"],
  ["reasoning_output_tokens", "reasoningOutputTokens"],
] as const;

/**
 * Yeni-satır beklemeden tamponun büyüyebileceği üst sınır. Akıştaki olaylar tek
 * satır JSON; bu sınıra dayanan bir şey satır DEĞİLDİR (ikili çıktı, ilerleme
 * çubuğu) ve atılır.
 */
const MAX_STREAM_LINE = 1_000_000;

/**
 * Tavanın TEK tanımı. Soru "biriken tampon büyüdü mü" değil, "bu satır büyük mü":
 * aynı sınıf üç turda üç kez çıktı (atılan tampon hiç sayılmıyordu; tavan UTF-16
 * kod birimi sayıyordu; tavan hiç bakılmadan tamamlanmış satır geçiyordu) — üçü
 * de tavanın satırın ÜRETİLDİĞİ yerde değil, tamponda ölçülmesinden.
 *
 * Bellek sınırlandığı için ölçü BAYT. `* 3` ön kontrolü yaygın yolu bedava
 * bırakıyor: UTF-8 kod birimi başına 3 bayttan fazlasını asla harcamaz, yani o
 * sınırın altında tavan erişilemez ve byteLength tamponu dolaşmak zorunda kalmaz.
 */
function exceedsLineCeiling(s: string): boolean {
  return s.length * 3 > MAX_STREAM_LINE && Buffer.byteLength(s, "utf8") > MAX_STREAM_LINE;
}

/** Ayrıştırıcının BEKLEDİĞİ olay adları; dışındaki her ad şema kayması sayılır. */
const KNOWN_EVENT_TYPES = new Set(["item.completed", "turn.completed"]);

/**
 * `--json` akışından maliyet toplar. Ham akış RAM'de BİRİKTİRİLMEZ: gerçek bir
 * hakem koşumu ~1,9M token girdi raporluyor, akışın kendisi de o ölçekte —
 * yalnız yarım kalan satır ve toplanan sayılar tutulur.
 *
 * Prototipten (tools/altin-set/adjudicate-cost.ts) ayrılan yer: orada son turun
 * usage'ı alınıyordu, burada TÜM turların TOPLAMI — tavan denetiminin girdisi
 * koşumun tamamının maliyeti.
 */
function createUsageCollector(onProgress?: (p: { totalTokens: number; items: number }) => void) {
  let rest = "";
  let items = 0;
  let turns = 0;
  // Şema kayması sayaçları (bkz. ExecutorUsage.unparsedLines/unknownEvents).
  // Davranış DEĞİŞMİYOR — bu satırlar eskiden de atlanıyordu; değişen tek şey
  // atlamanın sonuçta görünür olması.
  let unparsedLines = 0;
  let unknownEvents = 0;
  let oversizeDrops = 0;
  // Sınırı aşıp atılan bir satırın KUYRUĞUNU yutmak için: kesme noktasından
  // sonraki parça bağımsız bir satır değil.
  let dropping = false;
  // Tavan denetimi için AYRICA tutuluyor: totals'ı her olayda toplamak akış
  // uzadıkça boşuna iş; burada artımlı büyüyor.
  let totalTokens = 0;
  const totals = new Map<string, number>();

  const handleLine = (line: string): void => {
    const s = line.trim();
    if (!s.startsWith("{")) return; // akışta JSON olmayan satırlar da geliyor
    let event: { type?: string; usage?: Record<string, unknown> };
    try {
      event = JSON.parse(s);
    } catch {
      unparsedLines++;
      return; // yarım/bozuk satır ölçümü düşürmez, yalnız atlanır
    }
    const type = typeof event?.type === "string" ? event.type : "";
    if (type === "item.completed") items++;
    else if (type === "turn.completed" && event.usage) {
      turns++;
      for (const [snake, camel] of USAGE_FIELDS) {
        const v = event.usage[snake];
        if (typeof v === "number") {
          totals.set(camel, (totals.get(camel) ?? 0) + v);
          totalTokens += v;
        }
      }
    } else {
      // usage'sız `turn.completed` TANINAN bir olaydır (ölçüm taşımıyor sadece);
      // sayaca yalnız adı hiç bilmediğimiz olay girer, yoksa sayaç normal
      // akışta da dolar ve sinyal olmaktan çıkardı.
      if (!KNOWN_EVENT_TYPES.has(type)) unknownEvents++;
      return; // ölçümü değiştirmeyen satır tavanı da değiştiremez
    }
    // Tavan, akış SÜRERKEN denetlenir: sonuca bakmak "harcandıktan sonra"
    // öğrenmek olurdu, kesmenin bütün amacı ise harcamayı durdurmak.
    onProgress?.({ totalTokens, items });
  };

  return {
    push(chunk: string): void {
      rest += chunk;
      let nl: number;
      while ((nl = rest.indexOf("\n")) !== -1) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        // Atılan satırın KUYRUĞU yeni bir satır değil: `dropping` olmadan bu
        // parça handleLine'a giriyor ve kesme noktası şansa `{`'a denk gelirse
        // "bozuk satır" diye ikinci kez sayılıyordu.
        if (dropping) {
          dropping = false;
          continue;
        }
        // Tamamlanmış satır da tavana tabi. Sonlandırıcı yeni-satırı aynı
        // chunk'ta gelen bir satır eskiden HİÇ ölçülmeden handleLine'a giriyordu
        // (ölçüldü, doğrulama turu 3: 1.000.089 baytlık satır ayrıştırıldı).
        // `dropping` KURULMAZ: kuyruğu değil satırın tamamı zaten tüketildi.
        if (exceedsLineCeiling(line)) {
          oversizeDrops++;
          unparsedLines++;
          continue;
        }
        handleLine(line);
      }
      // Sınırı aşan tampon atılıyor ama SAYILIYOR: atılan şey bozuk bir ikili
      // çıktı da olabilir, sınırın üstünde GEÇERLİ bir olay da (ölçüldü, doğrulama
      // turu 14 Ağu: 1,1 MiB'lık geçerli bir olay hiçbir sayacı artırmadan
      // siliniyordu — "akış gelmedi" ile "akış anlaşılmadı" ayrımı bu yolda hâlâ
      // kapalıydı). Satır başına TEK sayım: sınır tekrar tekrar aşılsa da atılan
      // şey hâlâ aynı satır. Yeni-satırı hiç gelmeyen satır da sınırlanmalı;
      // ölçüt tamamlanmış satırla AYNI (exceedsLineCeiling).
      if (!dropping && exceedsLineCeiling(rest)) {
        rest = "";
        dropping = true;
        oversizeDrops++;
        // Aynı olay `unparsedLines`'a da yazılıyor: o alan "satır geldi, ölçüme
        // dönüşmedi" sorusunun cevabı ve atılan tampon o kümenin içinde.
        // `oversizeDrops` ise SEBEBİ ayırıyor (uzunluk mu, bozuk JSON mu).
        unparsedLines++;
      } else if (dropping) {
        rest = ""; // hâlâ aynı atılmış satırın içindeyiz; biriktirmenin anlamı yok
      }
    },
    /** Akış kapandığında son (yeni-satırsız) satırı da işler. */
    finish(): ExecutorUsage | undefined {
      // `dropping` iken elde kalan şey atılmış bir satırın kuyruğu — işlenmez.
      if (rest && !dropping) {
        handleLine(rest);
      }
      rest = "";
      // Hiçbir olay görülmediyse ölçüm YOK: undefined döner, 0 uydurulmaz.
      // Yalnız item görüldüyse ölçüm VAR (item sayısı) ama token bilinmiyor —
      // o durumda token alanları yokluğuyla, items değeriyle raporlanır.
      // Anlaşılmayan satır/olay da bir ölçümdür: hiçbir olay tanınmasa bile
      // usage BASILIR (yalnız kayma sayaçlarıyla), yoksa "akış gelmedi" ile
      // "akış geldi ama anlaşılmadı" aynı `undefined`'a düşerdi.
      if (turns === 0 && items === 0 && unparsedLines === 0 && unknownEvents === 0 && oversizeDrops === 0)
        return undefined;
      const usage: ExecutorUsage = {};
      for (const [, camel] of USAGE_FIELDS) {
        const v = totals.get(camel);
        if (v !== undefined) usage[camel] = v;
      }
      // items/turns yalnız TANINAN olay görüldüyse yazılır: hiç tanınmamışken
      // `items: 0` yazmak "0 item ölçtüm" derdi, oysa doğrusu "ölçemedim".
      if (turns > 0 || items > 0) {
        usage.items = items;
        if (turns > 0) usage.turns = turns;
      }
      if (unparsedLines > 0) usage.unparsedLines = unparsedLines;
      if (unknownEvents > 0) usage.unknownEvents = unknownEvents;
      // "yokken yazma, 0 uydurma": alan yalnız gerçekten atılan tampon varken var.
      if (oversizeDrops > 0) usage.oversizeDrops = oversizeDrops;
      return usage;
    },
  };
}

/** Saf: komut satırını üretir. Ayrı fonksiyon, çünkü sözleşme testle sabitleniyor. */
export function buildExecArgs(
  req: ExecutorRequest,
  opts: CodexOptions,
  schemaPath: string | null,
  outPath: string,
): string[] {
  const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never", "-s", "read-only"];
  if (req.cwd) args.push("-C", req.cwd);
  if (opts.model) args.push("-m", opts.model);
  if (opts.reasoningEffort) args.push("-c", `model_reasoning_effort="${opts.reasoningEffort}"`);
  if (schemaPath) args.push("--output-schema", schemaPath);
  // --json: stdout'a olay akışı (usage buradan gelir). -o DURUYOR — son mesajın
  // kaynağı hâlâ dosya, "boş dosya = arıza" sözleşmesi değişmedi.
  args.push("--json", "-o", outPath, "-");
  return args;
}

export function createCodexExecutor(opts: CodexOptions = {}): ExecutorAdapter {
  const binary = opts.binary ?? "codex";

  return {
    id: "codex",

    async detect(): Promise<ExecutorDetection> {
      const detectTimeoutMs = opts.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
      return new Promise((resolve) => {
        // detached: timeout'ta torunlarla birlikte öldürebilmek için (bkz.
        // killProcessGroup). unref() YOK — çıktıyı bekliyoruz.
        const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
        trackGroup(child.pid);
        let out = "";
        let settled = false;
        const finish = (r: ExecutorDetection) => {
          if (settled) return; // timeout ile close yarışabilir; ilk sonuç kazanır
          settled = true;
          clearTimeout(timer);
          untrack("group", child.pid);
          resolve(r);
        };
        const timer = setTimeout(() => {
          // Canlılık sınaması `cleanupNow` ile AYNI sebeple (bkz. isProcessAlive):
          // çocuk `close`tan ~1,1–1,4 ms önce ölüyor ve o aralıkta PID işletim
          // sistemi tarafından GERİ DÖNÜŞTÜRÜLMÜŞ olabilir — sinyal yabancı bir
          // gruba giderdi. "Çocuk close'a kadar zombi kalır" gerekçesi bu depoda
          // ÖLÇÜMLE çürütüldü (probes/signal-cleanup-stale-group.sh, 14 Ağu):
          // o aralıkta `kill(pid, 0)` zaten ESRCH veriyor. Aynı korumanın akış
          // yolundaki karşılığı `closed` bayrağı; bu, timeout yolundaki karşılığı.
          if (child.pid !== undefined && isProcessAlive(child.pid)) killProcessGroup(child.pid);
          finish({ found: false, error: `codex --version zaman aşımı (${detectTimeoutMs} ms)` });
        }, detectTimeoutMs);
        child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
        child.on("error", (err) => finish({ found: false, error: err.message }));
        child.on("close", (code) => {
          const m = out.match(/codex-cli (\d+\.\d+\.\d+)/);
          if (code === 0 && m) finish({ found: true, version: m[1] });
          else finish({ found: false, error: `çıkış ${code}: ${out.trim().slice(0, 200)}` });
        });
      });
    },

    async run(req: ExecutorRequest): Promise<ExecutorResult> {
      const started = Date.now();
      // Geçici dosyalar çağrı başına izole dizinde; koşum bitince silinir —
      // temizlik isteğe bağlı değil (çalışma sözleşmesi §3).
      const tmp = await mkdtemp(join(tmpdir(), "cp-codex-"));
      trackTempDir(tmp); // sinyalle kapanışta da silinsin (bkz. sinyal temizliği)
      const execute = async (): Promise<ExecutorResult> => {
        const outPath = join(tmp, "son-mesaj.txt");
        let schemaPath: string | null = null;
        if (req.outputSchema) {
          schemaPath = join(tmp, "sema.json");
          await writeFile(schemaPath, JSON.stringify(req.outputSchema));
        }
        const args = buildExecArgs(req, opts, schemaPath, outPath);
        const timeoutMs = req.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const caps = req.caps;

        const done = await new Promise<{
          code: number | null;
          stderr: string;
          timedOut: boolean;
          spawnError?: string;
          stdinError: string | null;
          stdinFlushed: boolean;
          usage?: ExecutorUsage;
          capExceeded?: ExecutorCapExceeded;
          capPostHoc: boolean;
        }>((resolve) => {
          // detached: çocuk kendi süreç grubunun lideri olur, böylece timeout'ta
          // torunlarıyla birlikte öldürülebilir (killProcessGroup). unref()
          // ÇAĞIRMIYORUZ — çıktı dosyasını beklediğimiz için süreci event
          // loop'ta tutmak zorundayız; unref edilirse Node çocuk bitmeden çıkabilir.
          // stdout artık "ignore" değil: --json olay akışı oradan geliyor. Akış
          // okunmazsa boru dolar ve codex yazarken bloke olur — yani pipe olmak
          // seçenek değil, tüketmek zorunlu.
          const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
          trackGroup(child.pid);
          // Kesme sebebi timeout'tan AYRI bir bayrakta: close handler'ında
          // ikisi karışırsa çağıran taraf "süre bitti" ile "bütçe bitti"yi
          // ayırt edemez, oysa ikisi farklı kararlar doğuruyor.
          let capExceeded: ExecutorCapExceeded | undefined;
          // POST-HOC = aşım ancak akış kapandıktan sonra görüldü, yani kesilen
          // bir iş yok: cevap eksiksiz geldi, yalnız pahalıydı. Ayrım ölçümün
          // yapısından geliyor (executor.ts ExecutorCaps): usage tek bir
          // `turn.completed` ile en sonda düşüyor. Ayrımı "kind === tokens" ile
          // yapmak yanlış olurdu — token tavanı akış ORTASINDA da ateşleyebilir
          // (çok turlu akış) ve orada süreç gerçekten öldürülür.
          let capPostHoc = false;
          // Süreç kapandıktan SONRA öldürme yasak: PID'yi işletim sistemi geri
          // dönüştürmüş olabilir ve `kill(-pid)` ALAKASIZ bir süreç grubunu
          // vurur. Bu gerçek bir yol: usageCollector.finish() kuyrukta kalan
          // son (yeni-satırsız) satırı close handler'ının İÇİNDE işliyor ve o
          // satır tavanı aşabiliyor. Aşım yine raporlanır, yalnız kill atlanır.
          let closed = false;
          const usageCollector = createUsageCollector((p) => {
            if (capExceeded || !caps) return; // ilk aşım kazanır; ikinci kez öldürmeye gerek yok
            const hit =
              caps.maxTotalTokens != null && p.totalTokens > caps.maxTotalTokens
                ? { kind: "tokens" as const, limit: caps.maxTotalTokens, observed: p.totalTokens }
                : caps.maxItems != null && p.items > caps.maxItems
                  ? { kind: "items" as const, limit: caps.maxItems, observed: p.items }
                  : undefined;
            if (!hit) return;
            capExceeded = hit;
            // `closed` TEK BAŞINA yetmiyor: bayrak `close` olayında doluyor,
            // oysa çocuk ondan ~1,1–1,4 ms önce çıkıyor ve PID o aralıkta geri
            // dönüştürülebiliyor (ölçüm: probes/signal-cleanup-stale-group.sh).
            // Canlılık sınaması `cleanupNow` ile aynı; artık üç öldürme yolu da
            // (timeout, detect timeout, kap aşımı) aynı korumadan geçiyor.
            const killable = !closed && child.pid !== undefined && isProcessAlive(child.pid);
            // Post-hoc ölçütü ÖLDÜRME ile aynı koşuldan türüyor: kesilen iş
            // ancak öldürdüğümüz iştir. (`kind === "tokens"` ölçüt olamaz —
            // çok turlu bir akışta token tavanı akış ORTASINDA da ateşler.)
            capPostHoc = !killable;
            if (killable) killProcessGroup(child.pid!);
          });
          // setEncoding: çok baytlı karakter iki chunk'a bölünürse Node birleştirir.
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (d: string) => usageCollector.push(d));
          let stderr = "";
          let timedOut = false;
          // Prompt teslimi izleniyor. Bulgu (undetected-stdin-delivery-failure):
          // EPIPE sessizce yutuluyordu ve alt süreç stdin'i erken kapatıp 0 ile
          // çıkar, üstelik boş olmayan bir çıktı dosyası bırakırsa, prompt YARIM
          // teslim edilmiş olduğu hâlde ok:true dönüyordu. Gözlemci o yanıta
          // dayanıp filigranı ilerletiyor → görülmemiş turn'ler "işlenmiş" sayılıyor.
          // Bu yüzden hata yutulur ama UNUTULMAZ.
          let stdinError: string | null = null;
          let stdinFlushed = false;
          const timer = setTimeout(() => {
            timedOut = true;
            // `closed` bayrağı YETMİYOR: o yalnız `close` olayında doluyor, oysa
            // çocuk ondan ~1,1–1,4 ms ÖNCE çıkıyor ve PID o aralıkta geri
            // dönüştürülebiliyor (ölçüm: probes/signal-cleanup-stale-group.sh,
            // 14 Ağu — aralıkta `kill(pid, 0)` zaten ESRCH). Timers fazı
            // close-callbacks fazından önce koştuğu için aralık gerçek.
            // Burada `cleanupNow` ve capExceeded yolu ile aynı korumayı kuruyoruz.
            if (closed) return;
            if (child.pid !== undefined && isProcessAlive(child.pid)) killProcessGroup(child.pid);
          }, timeoutMs);
          child.stderr.on("data", (d: Buffer) => {
            stderr = (stderr + d.toString("utf8")).slice(-4096);
          });
          child.on("error", (err) => {
            closed = true;
            clearTimeout(timer);
            untrack("group", child.pid);
            // finish() kuyruktaki son satırı işlerken `capExceeded`i
            // doldurabiliyor. Eskiden bu, resolve literal'indeki alan SIRASINA
            // bırakılmıştı (soldan sağa değerlendirme) — sessizce kırılabilecek
            // bir bağımlılık. Artık yapıyla çözülü: finish() resolve'dan ÖNCE
            // koşar, capExceeded o çağrıdan SONRA okunur.
            const usage = usageCollector.finish();
            resolve({ code: null, stderr, timedOut, spawnError: err.message, stdinError, stdinFlushed, usage, capExceeded, capPostHoc });
          });
          child.on("close", (code) => {
            closed = true;
            clearTimeout(timer);
            untrack("group", child.pid);
            // finish() resolve'dan ÖNCE (bkz. error handler'daki not).
            const usage = usageCollector.finish();
            resolve({ code, stderr, timedOut, stdinError, stdinFlushed, usage, capExceeded, capPostHoc });
          });
          child.stdin.on("error", (err: NodeJS.ErrnoException) => {
            if (stdinError === null) stdinError = err.code ? `${err.code}: ${err.message}` : err.message;
          });
          // "finish" = end() sonrası tamponun tamamı işletim sistemine verildi.
          // Çocuğun 'close'u tüm stdio boruları kapandıktan sonra geldiği için
          // bu bayrak resolve anında kesinleşmiş oluyor (yarış yok).
          child.stdin.on("finish", () => {
            stdinFlushed = true;
          });
          child.stdin.write(req.prompt);
          child.stdin.end();
        });

        const durationMs = Date.now() - started;
        const usage = done.usage;
        // Başarısız koşum da token harcamıştır; usage her yolda taşınır ki
        // maliyet tavanı yalnız başarılı koşumları saymasın.
        // Post-hoc aşımda koşum KESİLMEDİ, yalnız pahalı çıktı — aşağıdaki her
        // hata yolu kendi sebebini raporlar ama bütçe ihlalini de taşımalı,
        // yoksa "tavan aşıldı mı" sorusunun cevabı ikinci bir arıza yüzünden
        // kayboluyor. Kesilen (mid-stream) aşımda bu alan zaten erken dönüşte.
        const postHocCap = done.capExceeded && done.capPostHoc ? { capExceeded: done.capExceeded } : {};
        const capError = (c: ExecutorCapExceeded) =>
          `maliyet tavanı aşıldı: ${c.observed} ${c.kind === "tokens" ? "token" : "item"} > ${c.limit}`;

        if (done.spawnError)
          return { ok: false, output: "", error: `codex başlatılamadı: ${done.spawnError}`, durationMs, usage, ...postHocCap };
        // Tavan, süreden ÖNCE bakılır: kesme sırasında zamanlayıcı da ateşlemiş
        // olabilir, ama koşumu bitiren karar tavandır ve sebep o olmalı.
        // Yalnız AKIŞ ORTASINDA yakalanan aşım burada biter: orada süreç
        // öldürüldü, elde kalan çıktı yarımdır ve tutulması yanıltıcı olur.
        if (done.capExceeded && !done.capPostHoc) {
          return {
            ok: false,
            output: "",
            error: capError(done.capExceeded),
            durationMs,
            usage,
            capExceeded: done.capExceeded,
          };
        }
        if (done.timedOut) return { ok: false, output: "", error: `zaman aşımı (${timeoutMs} ms)`, durationMs, usage, ...postHocCap };
        if (done.code !== 0)
          return { ok: false, output: "", error: `çıkış ${done.code}: ${done.stderr.trim().slice(-STDERR_TAIL)}`, durationMs, usage, ...postHocCap };
        // Sıfır çıkış + dolu çıktı dosyası YETMEZ: prompt tam gitmediyse cevap
        // eksik bir soruya verilmiştir. Bu yolların hepsinde output boş dize —
        // cevabın kendisi güvenilmez. (Tek istisna post-hoc tavan aşımı; bkz.
        // executor.ts ExecutorResult.output.)
        if (done.stdinError !== null)
          return { ok: false, output: "", error: `prompt stdin'e yazılamadı (${done.stdinError})`, durationMs, usage, ...postHocCap };
        if (!done.stdinFlushed)
          return { ok: false, output: "", error: "prompt stdin'e tam yazılmadan süreç kapandı", durationMs, usage, ...postHocCap };

        // Okuma hatası ile BOŞ DOSYA ayrı raporlanır. Eskiden `.catch(() => "")`
        // ikisini aynı değere indiriyordu ve çağıran, izinsiz/eksik bir dosya
        // için "codex son mesajı boş bıraktı" teşhisini alıyordu — yanlış yerde
        // arattıran bir hata mesajı. errno hata metnine taşınıyor.
        let output: string;
        try {
          output = await readFile(outPath, "utf8");
        } catch (err) {
          return {
            ok: false,
            output: "",
            error: `codex son mesaj dosyası okunamadı (${describeError(err)})`,
            durationMs,
            usage,
            ...postHocCap,
          };
        }
        if (!output.trim())
          return { ok: false, output: "", error: "codex son mesaj dosyasını boş bıraktı", durationMs, usage, ...postHocCap };
        // Post-hoc aşımda ÇIKTI KORUNUR. Koşum ok:false — bütçe ihlali sessizce
        // geçmemeli — ama cevap eksiksiz geldi ve atılması harcanan bütçeyi ikinci
        // kez ödetirdi. `ok:false ⇒ output:""` sözleşmesinin TEK istisnası budur
        // ve executor.ts'te yazılı.
        if (done.capExceeded)
          return { ok: false, output, error: capError(done.capExceeded), durationMs, usage, capExceeded: done.capExceeded };
        return { ok: true, output, durationMs, usage };
      };

      // TEMİZLİK HATASI SONUCU EZMEZ (lock.ts:458 ile aynı sözleşme). Eskiden
      // silme `finally` içindeydi: `rm` fırlarsa BAŞARILI bir ExecutorResult
      // yerinden ediliyor ve run() reject oluyordu — koşum yapılmış, para
      // harcanmış, sonuç kaybolmuştu. Yeni hâlde sonuç döner, hata da yutulmaz:
      // başarı yolunda `cleanupError` alanında, hata yolunda özgün hatanın
      // `cleanupError` özelliğinde taşınır.
      let result: ExecutorResult | undefined;
      let failure: unknown;
      let failed = false;
      try {
        result = await execute();
      } catch (err) {
        failure = err;
        failed = true;
      }
      // SAHİPLİK SİLME BİTENE KADAR BIZDE. Doğrulama turu ölçtü (14 Ağu): kayıt
      // `await rm` ÖNCESİNDE düşürülünce, o pencerede gelen bir SIGINT dizini
      // artık defterde GÖRMÜYOR — ve `rm` de sinyalle kesildiği için dizin
      // sızıyordu. Çift silme zararsız (`force: true`), erken bırakma değil.
      let cleanupError: string | undefined;
      try {
        await rm(tmp, { recursive: true, force: true });
      } catch (err) {
        cleanupError = describeError(err);
      } finally {
        // `finally`: silme patlasa da kayıt düşer. Aksi hâlde defterde ölü bir
        // giriş kalır ve sinyal işleyicisi her seferinde onu silmeye kalkar
        // (ayrıca dinleyici hiç kaldırılmaz — bkz. untrack/uninstall).
        untrack("dir", tmp);
      }
      if (failed) {
        // İlkel bir değer fırlatılmışsa alan yazılamaz; kayıp bilinçli (lock.ts).
        if (cleanupError !== undefined && failure !== null && typeof failure === "object")
          (failure as { cleanupError?: string }).cleanupError = cleanupError;
        throw failure;
      }
      if (cleanupError !== undefined) result!.cleanupError = cleanupError;
      return result!;
    },
  };
}
