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

/**
 * Çağrı başına maliyet tavanı. Aşımda çağrı KODLA kesilir — istemdeki "60 sn
 * içinde bitir" talimatı bağlamıyor (ölçüldü: bir hakem 3 dakikalık döngü
 * koştu). Verilmeyen alan sınırsızdır.
 */
export interface ExecutorCaps {
  /**
   * input+cached+output+reasoning TOPLAMI üstünden. YAPISAL KISIT: usage yalnız
   * `turn.completed` olayında geliyor ve gerçek koşumda o olay bir kez, en sonda
   * geliyor — yani token yaptırımı çoğu koşumda POST-HOC'tur (aşımı bildirir ama
   * harcamayı durdurmaz). Akışı gerçekten kesebilen eksenler maxItems ve süre.
   */
  maxTotalTokens?: number;
  /** `item.completed` sayısı üstünden — akış ortasında ateşleyebilen tek maliyet ekseni. */
  maxItems?: number;
}

export interface ExecutorRequest {
  prompt: string;
  /** Çıktının uyması gereken JSON Şeması — modele iletilir (codex --output-schema). */
  outputSchema?: object;
  /** Çalışma dizini. Gözlemci vermez (D-M2-8); araçlı hakem (M4) verecek. */
  cwd?: string;
  timeoutMs?: number;
  /** Verilmezse tavan denetimi hiç koşmaz; davranış tavan öncesiyle birebir aynı. */
  caps?: ExecutorCaps;
}

/**
 * Tavanı aşan koşumun sebebi. `observed` STRICT aşımdır (> limit): bütçesini
 * tam kullanan meşru bir koşum kesilmez, ancak bir sonraki ölçüm tavanı geçince
 * kesilir.
 */
export interface ExecutorCapExceeded {
  kind: "tokens" | "items";
  limit: number;
  observed: number;
}

/**
 * Bir koşumun token maliyeti. Tüm alanlar isteğe bağlı: yürütücü ölçemediğini
 * UYDURMAZ — "akış gelmedi" `undefined`'dır, `0` değil. Sıfır yazmak maliyet
 * tavanını sessizce yanıltır (harcanmış ama görünmeyen bütçe).
 */
export interface ExecutorUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  /**
   * Önbelleğe YAZILAN girdi token'ı (`cache_write_input_tokens`). Gerçek akışta
   * var (14 Ağu json-probe) ama düşürülüyordu; ücretlendirilen bir kalem olduğu
   * için maliyet kalibrasyonunda eksik bıraktığı sayı görünmüyordu.
   */
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  /**
   * Akışta görülen `item.completed` sayısı (araç çağrısı + mesaj). KESİLEBİLİR
   * eksen budur: gerçek binary ölçüldü — koca bir `codex exec` koşumunda item
   * akış boyunca damlarken `turn.completed` BİR kez, en sonda geliyor.
   */
  items?: number;
  /** Akışta görülen `turn.completed` sayısı. Yalnız RAPOR: bkz. items. */
  turns?: number;
}

export interface ExecutorResult {
  ok: boolean;
  /** Modelin son mesajı; ok=false iken boş dize. */
  output: string;
  error?: string;
  durationMs: number;
  /** Ölçülemediyse undefined (bkz. ExecutorUsage). Başarısız koşumda da dolabilir:
   *  zaman aşımına uğrayan bir hakem de token harcamıştır, tavan onu da görmeli. */
  usage?: ExecutorUsage;
  /**
   * Yalnız tavan aşımıyla kesilen koşumda dolar. SÜRE aşımı (timeoutMs) bunu
   * TAŞIMAZ: üç eksen (süre / token / tur) ayrık kalmalı ki çağıran taraf
   * anchor-drift'in budgetExhausted ↔ measurementFailed ayrımına eşleyebilsin.
   */
  capExceeded?: ExecutorCapExceeded;
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
