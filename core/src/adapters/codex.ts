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
  /** Testlerde sahte binary; üretimde PATH'teki "codex". */
  binary?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const STDERR_TAIL = 500;

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
      return new Promise((resolve) => {
        const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
        child.on("error", (err) => resolve({ found: false, error: err.message }));
        child.on("close", (code) => {
          const m = out.match(/codex-cli (\d+\.\d+\.\d+)/);
          if (code === 0 && m) resolve({ found: true, version: m[1] });
          else resolve({ found: false, error: `çıkış ${code}: ${out.trim().slice(0, 200)}` });
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

        const done = await new Promise<{ code: number | null; stderr: string; timedOut: boolean; spawnError?: string }>(
          (resolve) => {
            const child = spawn(binary, args, { stdio: ["pipe", "ignore", "pipe"] });
            let stderr = "";
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, timeoutMs);
            child.stderr.on("data", (d: Buffer) => {
              stderr = (stderr + d.toString("utf8")).slice(-4096);
            });
            child.on("error", (err) => {
              clearTimeout(timer);
              resolve({ code: null, stderr, timedOut, spawnError: err.message });
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              resolve({ code, stderr, timedOut });
            });
            child.stdin.on("error", () => {}); // erken ölen süreçte EPIPE yutulur; sonuç zaten close'ta
            child.stdin.write(req.prompt);
            child.stdin.end();
          },
        );

        const durationMs = Date.now() - started;
        if (done.spawnError) return { ok: false, output: "", error: `codex başlatılamadı: ${done.spawnError}`, durationMs };
        if (done.timedOut) return { ok: false, output: "", error: `zaman aşımı (${timeoutMs} ms)`, durationMs };
        if (done.code !== 0)
          return { ok: false, output: "", error: `çıkış ${done.code}: ${done.stderr.trim().slice(-STDERR_TAIL)}`, durationMs };

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
