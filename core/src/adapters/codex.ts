// Codex headless yürütücüsü (spec K1, K2). Bayraklar 0.146.0'da doğrulandı:
//   --ephemeral            oturum dosyası kalmaz (K7'nin Codex tarafı)
//   -s read-only           sandbox: yazma yok
//   --output-schema <f>    son cevabı JSON şemaya bağlar
//   -o <f>                 son mesaj dosyaya — stdout'un insan-gözü akışından bağımsız
//   prompt stdin'den ("-") — büyük partilerde ARG_MAX derdi yok (D-M2-5)

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorAdapter, ExecutorDetection, ExecutorRequest, ExecutorResult } from "./executor.ts";

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
  args.push("-o", outPath, "-");
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
        let out = "";
        let settled = false;
        const finish = (r: ExecutorDetection) => {
          if (settled) return; // timeout ile close yarışabilir; ilk sonuç kazanır
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        const timer = setTimeout(() => {
          killProcessGroup(child.pid);
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
      // Geçici dosyalar çağrı başına izole dizinde; finally'de silinir —
      // temizlik isteğe bağlı değil (çalışma sözleşmesi §3).
      const tmp = await mkdtemp(join(tmpdir(), "cp-codex-"));
      try {
        const outPath = join(tmp, "son-mesaj.txt");
        let schemaPath: string | null = null;
        if (req.outputSchema) {
          schemaPath = join(tmp, "sema.json");
          await writeFile(schemaPath, JSON.stringify(req.outputSchema));
        }
        const args = buildExecArgs(req, opts, schemaPath, outPath);
        const timeoutMs = req.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        const done = await new Promise<{
          code: number | null;
          stderr: string;
          timedOut: boolean;
          spawnError?: string;
          stdinError: string | null;
          stdinFlushed: boolean;
        }>((resolve) => {
          // detached: çocuk kendi süreç grubunun lideri olur, böylece timeout'ta
          // torunlarıyla birlikte öldürülebilir (killProcessGroup). unref()
          // ÇAĞIRMIYORUZ — çıktı dosyasını beklediğimiz için süreci event
          // loop'ta tutmak zorundayız; unref edilirse Node çocuk bitmeden çıkabilir.
          const child = spawn(binary, args, { stdio: ["pipe", "ignore", "pipe"], detached: true });
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
            killProcessGroup(child.pid);
          }, timeoutMs);
          child.stderr.on("data", (d: Buffer) => {
            stderr = (stderr + d.toString("utf8")).slice(-4096);
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ code: null, stderr, timedOut, spawnError: err.message, stdinError, stdinFlushed });
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stderr, timedOut, stdinError, stdinFlushed });
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
        if (done.spawnError) return { ok: false, output: "", error: `codex başlatılamadı: ${done.spawnError}`, durationMs };
        if (done.timedOut) return { ok: false, output: "", error: `zaman aşımı (${timeoutMs} ms)`, durationMs };
        if (done.code !== 0)
          return { ok: false, output: "", error: `çıkış ${done.code}: ${done.stderr.trim().slice(-STDERR_TAIL)}`, durationMs };
        // Sıfır çıkış + dolu çıktı dosyası YETMEZ: prompt tam gitmediyse cevap
        // eksik bir soruya verilmiştir. Sözleşme gereği ok=false iken output
        // MUTLAKA boş dize (executor.ts), hata mesajı sebebi taşır.
        if (done.stdinError !== null)
          return { ok: false, output: "", error: `prompt stdin'e yazılamadı (${done.stdinError})`, durationMs };
        if (!done.stdinFlushed)
          return { ok: false, output: "", error: "prompt stdin'e tam yazılmadan süreç kapandı", durationMs };

        const output = await readFile(outPath, "utf8").catch(() => "");
        if (!output.trim())
          return { ok: false, output: "", error: "codex son mesaj dosyasını boş bıraktı", durationMs };
        return { ok: true, output, durationMs };
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  };
}
