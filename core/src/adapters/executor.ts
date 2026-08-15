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
  /**
   * `{` ile başlayıp JSON olarak ayrıştırılamayan satır sayısı. Yalnız ÖLÇÜM
   * GÖRÜNÜRLÜĞÜ için: ayrıştırıcı bu satırları eskiden de atlıyordu, ama sessizce.
   * "usage hiç gelmedi" (alan yok) ile "usage geldi, anlaşılmadı" (bu alan dolu)
   * ayrımı olmadan, yükseltilen bir codex sürümü akış şemasını değiştirdiğinde
   * maliyet ölçümü sıfıra düşer ve bu hiçbir yerde görünmez.
   */
  unparsedLines?: number;
  /**
   * Ayrıştırılan ama tanınmayan `type` değerine sahip olay sayısı (usage'sız
   * `turn.completed` DEĞİL — o bilinen bir olay). Ölçüldü 14 Ağu: kurulu codex
   * 0.146.0 tam da beklenen adları basıyor, yani bugün canlı zarar yok; alan
   * gelecekteki bir ad değişikliğini sessiz kalmaktan çıkarmak için var.
   */
  unknownEvents?: number;
  /**
   * Yeni-satır beklenirken üst sınırı (MAX_STREAM_LINE) aşıp ATILAN tampon
   * sayısı. Ayrı bir alan, çünkü ayrı bir arıza: `unparsedLines` "satırı gördüm,
   * anlamadım" der; bu ise "satırı hiç görmedim, tamamlanmadan attım".
   *
   * Doğrulama turu ölçtü (14 Ağu): 1,1 MiB'lık GEÇERLİ tek bir olay hiçbir
   * sayacı artırmadan siliniyordu — yani sayaçların kapatmak için eklendiği
   * ayrım ("akış hiç gelmedi" ile "akış anlaşılmadı") bu yolda hâlâ açıktı.
   *
   * Aynı olay `unparsedLines`'ı da artırır (o alan "satır geldi, ölçüme
   * dönüşmedi" kümesinin tamamı); bu alan yalnız SEBEBİ ayırır.
   */
  oversizeDrops?: number;
  /**
   * usage fields that arrived under a known name but were not a finite number
   * (a string, null, NaN). Its own counter because it is its own failure: the
   * event parsed, the name was recognised, and every other counter therefore
   * stayed silent while the tokens went uncounted — the batch reads as 0 tokens
   * and the cost ceiling never fires. Measured 15 Aug 2026 with a 1290-token
   * `turn.completed` carrying `"input_tokens":"1234"`: usage came back as
   * `{items:1,turns:1}` with no token field and no counter raised.
   */
  malformedUsageFields?: number;
}

export interface ExecutorResult {
  ok: boolean;
  /**
   * Modelin son mesajı. `ok=false` iken boş dize — TEK istisnası POST-HOC tavan
   * aşımı: usage akışın sonunda tek `turn.completed` ile düştüğü için aşım ancak
   * cevap TAMAMEN geldikten sonra görülebiliyor (bkz. ExecutorCaps). Orada
   * kesilen bir iş yok; cevabı atmak harcanmış bütçeyi ikinci kez ödetirdi.
   * Yani `output` doluyken `ok` yanlış olabilir; ayrımı `capExceeded` verir.
   */
  output: string;
  error?: string;
  durationMs: number;
  /** Ölçülemediyse undefined (bkz. ExecutorUsage). Başarısız koşumda da dolabilir:
   *  zaman aşımına uğrayan bir hakem de token harcamıştır, tavan onu da görmeli. */
  usage?: ExecutorUsage;
  /**
   * Yalnız tavan aşan koşumda dolar — kesilen (akış ortası) ve kesilmeyen
   * (post-hoc) aşımın ikisinde de. SÜRE aşımı (timeoutMs) bunu
   * TAŞIMAZ: üç eksen (süre / token / tur) ayrık kalmalı ki çağıran taraf
   * anchor-drift'in budgetExhausted ↔ measurementFailed ayrımına eşleyebilsin.
   */
  capExceeded?: ExecutorCapExceeded;
  /**
   * Koşum bittikten SONRA geçici kaynakların silinmesinde çıkan hata. AYRI bir
   * alan, çünkü temizlik hatası koşumun sonucunu geçersiz kılmaz: `ok` ve
   * `output` olduğu gibi kalır (lock.ts'teki `releaseError` ile aynı sözleşme —
   * ikincil hata özgün sonucu EZMEZ ama yutulmaz da).
   */
  cleanupError?: string;
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
