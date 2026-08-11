// Yürütücü seam'i (spec K10'un ikinci bacağı). Prototipte tek implementasyon
// (Codex headless) ama arayüz gün birden tanımlı — transcript.ts ile aynı sebep.
//
// Gözlemci (M2) ve hakem (M4) LLM'i yalnız bu arayüzden görür; testler sahte
// yürütücüyle koşar (seam'in ilk kârı, spec §3.8).

export interface ExecutorDetection {
  found: boolean;
  version?: string;
  error?: string;
}

export interface ExecutorRequest {
  prompt: string;
  /** Çıktının uyması gereken JSON Şeması — modele iletilir (codex --output-schema). */
  outputSchema?: object;
  /** Çalışma dizini. Gözlemci vermez (D-M2-8); araçlı hakem (M4) verecek. */
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecutorResult {
  ok: boolean;
  /** Modelin son mesajı; ok=false iken boş dize. */
  output: string;
  error?: string;
  durationMs: number;
}

export interface ExecutorAdapter {
  readonly id: string;
  detect(): Promise<ExecutorDetection>;
  run(req: ExecutorRequest): Promise<ExecutorResult>;
}

const registry = new Map<string, ExecutorAdapter>();

export function registerExecutor(adapter: ExecutorAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getExecutor(id: string): ExecutorAdapter {
  const a = registry.get(id);
  if (!a) throw new Error(`bilinmeyen yürütücü: ${id} (kayıtlı: ${[...registry.keys()].join(", ") || "yok"})`);
  return a;
}
