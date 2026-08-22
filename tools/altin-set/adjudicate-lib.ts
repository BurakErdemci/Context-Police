// `adjudicate-cost.ts`'in SAF (yan etkisiz ya da yalnız fs-okuyan) mantığı.
//
// Neden ayrı dosya: `adjudicate-cost.ts` bir CLI giriş noktası — import edildiği
// anda argv ayrıştırıyor, `process.exit` çağırıyor ve dosya yazıyor. Bu yüzden
// içindeki kararlar (çıktı tamlığı, kök doğrulaması, usage toplamı) hiçbir
// zaman test edilemedi; M4.1 denetiminin 6 bulgusunun 6'sı da o dosyadaydı.
// Buraya YALNIZ o kararlar taşındı; akış (spawn, sinyal, raporlama) CLI'da kaldı.

import {
  accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
// ÜRÜNÜN sınır ilkeli — KOPYALANMIYOR, import ediliyor. Gerekçe: bu denetimin
// bulduğu kusurun kendisi "araç ile ürünün sınır tanımı ıraksamış" idi; ıraksamış
// bir kopya aynı kusuru yeniden üretir. Modül saf ve yan etkisiz, `tools/tsconfig.json`
// ile tip denetimine giriyor. (Kill/sinyal kalıbındaki bilinçli kopya AYRI bir karar:
// o davranışsal ve araç/ürün ayrımını korumak için var; bu ise bir İLKEL.)
import {
  DATA_FENCE_CLOSE, DATA_FENCE_OPEN, DATA_FENCE_RULE, fenceUntrusted,
} from "../../core/src/prompt-fence.ts";
// Aynı gerekçe: "bu not ne zaman yazıldı" bir SINIR İLKELİ, kopyası ıraksar.
import { type NoteDateSource, noteTimestamp, parseNote } from "../../core/src/importer/parse.ts";

export type Usage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number; // gerçek akışta var (14 Ağu json-probe), ücretlendiriliyor
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

export const USAGE_FIELDS = [
  "input_tokens", "cached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens",
] as const;

/**
 * Turların usage'ını TOPLAR (üzerine yazmaz).
 *
 * Eskiden `usage = o.usage` idi: son tur kazanıyordu. Çok turlu bir koşumda bu
 * hem `--max-tokens` tavanını AZ uyguluyor hem manşet maliyet sayısını düşük
 * raporluyordu. Ürün (core/src/adapters/codex.ts) zaten topluyor; ölçüm aracı
 * ürünün göreceği sayıyı ölçmeli.
 */
export function addUsage(acc: Usage | null, next: Record<string, unknown>): Usage {
  const out: Usage = acc ?? {};
  for (const f of USAGE_FIELDS) {
    const v = next[f];
    if (typeof v === "number") out[f] = (out[f] ?? 0) + v;
  }
  return out;
}

export function totalTokens(u: Usage): number {
  return USAGE_FIELDS.reduce((s, f) => s + (u[f] ?? 0), 0);
}

/**
 * İlk `{`'dan başlayıp DENGELİ parantez sayarak ilk kapanan bloğu döndürür.
 *
 * Neden `lastIndexOf("}")` değil: geçerli JSON'un ARKASINDA süslü parantez
 * içeren düz metin varsa ("… {bkz. şema} …") son `}` yanlış yeri kapatıyor ve
 * kurtarma tutmuyordu. Dize içindeki parantezler sayılmaz — kaçış karakteri
 * takip ediliyor.
 */
export function firstBalancedBlock(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * Şemalı iddia kümesini metinden çıkarır; çıkaramazsa null.
 *
 * TAMLIK ÖLÇÜTÜ YAPISAL: metin ayrıştırılabiliyor ve içinde `claims` DİZİSİ
 * varsa çıktı tamdır — dizinin BOŞ olması da tamdır. Eskiden aday metin seçimi
 * ve tamlık kararı `"verdict"` alt dizesine bakıyordu; şemaya uygun
 * `{"claims":[]}` o anahtarı taşımadığı için `parse_failed` damgası yiyordu
 * (M4.1 denetimi, adjudicate-empty-claims-rejected). Metin sezgisi ölçüt
 * olmaktan çıktı: yalnız katı ayrıştırma karar veriyor.
 *
 * Kurtarma katmanı: katı `JSON.parse` tek başına ölçüt olunca TAVANLA HİÇ
 * İLGİSİ OLMAYAN biçim pürüzleri notu "eksik çıktı" sayıyordu (ölçüldü, fix
 * turu 1: (a) cevap ```json çitiyle sarılmıştı, (b) iddia kümesi iki
 * item.completed'a bölünmüştü). Sıra: çiti soy → doğrudan parse → metindeki
 * ilk dengeli {…} bloğunu parse et.
 */
export function parseClaimsCount(text: string): number | null {
  return parseClaimsArray(text)?.length ?? null;
}

/** `parseClaimsCount`'un ham hâli: aynı kurtarma sırası, sayı yerine dizinin kendisi. */
export function parseClaimsArray(text: string): unknown[] | null {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const tries = [stripped];
  const block = firstBalancedBlock(stripped);
  if (block !== null && block !== stripped) tries.push(block);
  for (const t of tries) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed?.claims)) return parsed.claims;
    } catch { /* sıradaki deneme */ }
  }
  return null;
}

/**
 * Akıştan toplanan aday metinlerden tamlık hükmünü verir.
 *
 * GUARD (değişmedi): kanıt yalnız akışın SON `item.completed`'ından kabul
 * edilir. Ölçülmüş dayanak (14 Ağu json-probe): gerçek `codex exec --json`
 * akışında son item.completed final `agent_message`'ın kendisi; ondan sonra
 * yalnız `turn.completed` geliyor — o bir item DEĞİL. Tek örneklem olduğu için
 * HATA YÖNÜ BİLİNÇLİ SEÇİLDİ: akış ileride mesaj-dışı bir item'la biterse not
 * GÜRÜLTÜLÜ şekilde `olculemez` olur (görülür ve düzeltilir), sessizce sızmaz.
 *
 * Adaylara AKIL YÜRÜTME METNİ GİRMEZ (çağıran süzer): prompt çıktı şemasını
 * tarif ettiği için modelin reasoning'inde biçimi örnekleyen çitli bir blok
 * görülebiliyor; o blok tamlık kanıtı sayılırsa sonradan tavanla kesilen bir
 * koşum "tam" damgası alıp kısmi iddialarını skor hattına sızdırıyor.
 */
export function decideCompleteness(
  candidates: string[],
  lastItemIsMessage: boolean,
  trailerIntact = true,
): { complete: boolean; claims: number } {
  if (!lastItemIsMessage || !trailerIntact || candidates.length === 0) {
    return { complete: false, claims: 0 };
  }
  const last = candidates[candidates.length - 1]!;
  const n = parseClaimsCount(last);
  if (n !== null) return { complete: true, claims: n };
  // Birleşim fallback'i: küme birden çok item'a bölünmüşse tek parça
  // ayrıştırılamaz ama sıralı birleşimi ayrıştırılabilir. KATI ayrıştırma —
  // gerekçesi `parseClaimsJoined`'da.
  if (candidates.length > 1) {
    const joined = parseClaimsJoined(candidates.join("\n"));
    if (joined !== null) return { complete: true, claims: joined.length };
  }
  return { complete: false, claims: 0 };
}

/**
 * Koşucu (adjudicate-cost.ts) ile buranın AYNI kümeyi tanıması için tek kaynak.
 * `usage` taşımayan `turn.completed` de tanınan bir olaydır; adını bilmediğimiz
 * her şey "bilinmeyen olay" sayılıp atlanır — koşucunun davranışı.
 */
export const KNOWN_EVENT_TYPES = new Set(["item.completed", "turn.completed"]);

/** Modelin kendi cevabı olan tamamlanmış item'ın metni; değilse null. */
export function agentMessageText(
  item?: { type?: unknown; text?: unknown; content?: unknown },
): string | null {
  const raw = item?.text ?? item?.content;
  const txt = typeof raw === "string" ? raw : "";
  // YÜKLEM "reasoning DEĞİL" değil, "agent_message"tir. Ölçüldü 22 Ağu 2026
  // (codex-audit): 29 gerçek ham dosyada 688 `command_execution` item'ı var ve
  // bugün yalnızca `text`/`content` alanları string OLMADIĞI için eleniyorlar.
  // Codex o alanı bir gün doldurursa komut çıktısı modelin hükmü sayılırdı.
  // Sıkılaştırmanın o 29 dosyada aday kümesini değiştirmediği ayrıca ölçüldü.
  return txt.length > 0 && item?.type === "agent_message" ? txt : null;
}

/**
 * `codex exec --json` olay akışından mesaj adaylarını çıkarır; metin bir olay
 * akışı DEĞİLSE null döner (çağıran düz-metin yoluna düşer).
 *
 * Koşucuyla ORTAK OLAN, paylaşılan `KNOWN_EVENT_TYPES` ve `agentMessageText`
 * — kopyalanan kural değil, çağrılan tek kaynak. (Yorumun eski hâli "akış yolu
 * artık tek yerde" diyordu; değildi, iki bağımsız uygulama duruyordu. Ölçüldü
 * 22 Ağu 2026, hygiene lensi.) Ayrıştırmanın DÖNGÜSÜ hâlâ iki yerde, çünkü
 * koşucu canlı akışı satır satır, burası bitmiş dosyayı bir kerede okuyor.
 *
 * `trailerIntact`: son ajan mesajından SONRA akışın kesildiğini gösteren bir iz
 * var mı. Kesik koşumun kısmi iddiaları skor hattına sızmasın diye; ölçüldü
 * 22 Ağu 2026 (codex-audit), dört ayrı kuyruk sınıfı "tam" damgası alıyordu.
 */
export function streamMessageCandidates(
  text: string,
): { candidates: string[]; lastItemIsMessage: boolean; trailerIntact: boolean } | null {
  let sawEvent = false;
  const candidates: string[] = [];
  let lastItemIsMessage = false;
  let trailerIntact = true;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (s === "") continue;
    let o: Record<string, unknown> & { item?: { type?: string; text?: unknown; content?: unknown } };
    try {
      o = JSON.parse(s);
    } catch {
      // Yarım/bozuk satır: akış başlamışsa yazan taraf kesilmiş demektir.
      // Akış başlamadan önceki gürültü hükmü etkilemez.
      if (sawEvent) trailerIntact = false;
      continue;
    }
    const type = typeof o?.type === "string" ? o.type : "";
    if (!KNOWN_EVENT_TYPES.has(type)) {
      // Koşucu bu satırı "bilinmeyen olay" sayıp DEVAM ediyor. Eski hâl burada
      // tüm dosya için null dönüyordu, yani tek bir yabancı satır 15 iddiayı
      // sıfırlıyordu (ölçüldü 22 Ağu 2026, parser-divergence: 15 girdi
      // sınıfının 7'si ıraksıyordu). Yalnız `item.*` bir kuyruk izidir.
      if (sawEvent && type.startsWith("item.")) trailerIntact = false;
      continue;
    }
    sawEvent = true;
    if (type !== "item.completed") continue;
    const txt = agentMessageText(o.item);
    lastItemIsMessage = txt !== null;
    if (txt !== null) {
      candidates.push(txt);
      trailerIntact = true; // yeni mesaj, önceki kuyruk izi geçersiz
    } else {
      trailerIntact = false;
    }
  }
  return sawEvent ? { candidates, lastItemIsMessage, trailerIntact } : null;
}

/**
 * Aday metinlerin sıralı birleşimini YALNIZ katı ayrıştırmayla dener.
 *
 * Birleşim fallback'i tek bir kümenin iki item'a BÖLÜNMÜŞ hâlini onarmak için
 * var. `parseClaimsArray`'in dengeli-blok kurtarması birleşime uygulanınca
 * bambaşka bir iş yapıyordu: metindeki İLK tam nesneyi seçiyor, yani yarım
 * kalan son cevabın yerine ÖNCEKİ mesajın iddialarını geçiriyordu (ölçüldü
 * 22 Ağu 2026, codex-audit). Bölünmüş küme birleşince zaten geçerli JSON olur.
 */
function parseClaimsJoined(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text.replace(/```(?:json)?/gi, "").trim());
    return Array.isArray((parsed as { claims?: unknown })?.claims)
      ? (parsed as { claims: unknown[] }).claims
      : null;
  } catch {
    return null;
  }
}

/**
 * Ham dosya içeriğinden iddia dizisi: olay akışıysa adaylar üzerinden,
 * değilse düz metin yolu. Eksik akış (mesajla bitmeyen ya da mesajdan sonra
 * kesilme izi taşıyan) null'dur — kısmi iddiaların skor hattına sızmaması
 * `decideCompleteness`'taki guard'la aynı.
 */
export function parseClaimsFromRaw(text: string): unknown[] | null {
  const stream = streamMessageCandidates(text);
  if (stream === null) return parseClaimsArray(text);
  if (!stream.lastItemIsMessage || !stream.trailerIntact || stream.candidates.length === 0) return null;
  const last = stream.candidates[stream.candidates.length - 1]!;
  const direct = parseClaimsArray(last);
  if (direct !== null) return direct;
  return stream.candidates.length > 1 ? parseClaimsJoined(stream.candidates.join("\n")) : null;
}

/**
 * Alt sürecin stderr kuyruğunu sınırlı tutar.
 *
 * Ürün `core/src/adapters/codex.ts` aynı sınırı (`STDERR_TAIL = 500`) hata
 * mesajının kuyruğu için kullanıyor; buradaki BİLİNÇLİ bir kopya (araç/ürün
 * ayrımı korunuyor, bkz. killProcessGroup notu). Kuyruk tutuluyor çünkü
 * hatanın SEBEBİ sonda yazılıyor.
 */
export const STDERR_TAIL = 500;

export function appendTail(acc: string, chunk: string, limit: number = STDERR_TAIL): string {
  const s = acc + chunk;
  return s.length <= limit ? s : s.slice(-limit);
}

/** Operatörün kopyalayıp yapıştırabileceği temizlik komutu (sızan süreç için). */
export function cleanupCommand(pid: number): string {
  return `kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`;
}

export type RootCheck = { ok: true; root: string } | { ok: false; reason: string };

/**
 * İlk pozisyonel argümanı codex'in `-C` değerine geçirmeden önce doğrular.
 *
 * Bulgu (M4.1, adjudicator-arbitrary-root): argüman hiç doğrulanmadan alt
 * sürecin çalışma köküne geçiyordu — yazım hatası sessizce yanlış bir dizinde
 * ölçüm yaptırıyor, dosya yolu ise anlamsız bir hatayla patlıyordu. Ucuz kapı:
 * var mı, dizin mi, beklenen depo mu. `.git` hem normal depoda (dizin) hem
 * bağlı worktree'de (gitdir: satırı içeren DOSYA) var, ikisi de geçer.
 *
 * Yol ayrıca canonicalize ediliyor: alt sürece sembolik bağ değil gerçek yol
 * gider, böylece `-C` değeri ile ölçümün raporladığı yol aynı şey olur.
 *
 * "beklenen depo mu" ölçümü checkGitMarker'da: varlık kontrolü YETMİYOR.
 */
export function validateRoot(raw: string | undefined): RootCheck {
  if (!raw) return { ok: false, reason: "kök argümanı boş" };
  let real: string;
  try {
    real = realpathSync(resolve(raw));
  } catch {
    return { ok: false, reason: `kök yolu yok: ${raw}` };
  }
  try {
    if (!statSync(real).isDirectory()) return { ok: false, reason: `kök bir dizin değil: ${raw}` };
  } catch {
    return { ok: false, reason: `kök okunamadı: ${raw}` };
  }
  return checkGitMarker(real, raw);
}

/**
 * `.git` işaretçisinin GERÇEKTEN bir depoya işaret ettiğini ölçer.
 *
 * Bulgu (doğrulama turu, 14 Ağu): kapı yalnız `existsSync(<root>/.git)` idi —
 * `mkdir .git` ile kurulmuş BOŞ bir dizin depo sayılıyordu, yani kapı "yanlış
 * dizinde ölçüm yapma" işini yapmıyordu.
 *
 * İki biçim de MEŞRU ve ikisi de kabul ediliyor:
 *   - normal depo: `.git` bir DİZİN → içinde HEAD + objects + refs olmalı;
 *   - bağlı worktree / submodule: `.git` bir DOSYA → `gitdir: <yol>` satırı
 *     taşır ve gösterdiği yönetim dizini var olmalı.
 * İkinci biçim kırılırsa bu projenin kendi ölçüm koşumları durur: onlar
 * worktree'de koşuyor (bkz. audit-lanes).
 */
/** True only when the path exists AND is a directory; a broken symlink is false. */
function isDirSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function checkGitMarker(real: string, raw: string): RootCheck {
  const marker = join(real, ".git");
  let st;
  try {
    st = statSync(marker);
  } catch {
    return { ok: false, reason: `kök bir git deposu değil (.git yok): ${raw}` };
  }
  if (st.isDirectory()) {
    // `objects` and `refs` must be DIRECTORIES, not merely present: existence
    // alone accepted a directory holding regular files with those names
    // (verification round 2). The gate exists to catch a mistyped root before
    // measurements run there, so it has to measure shape, not spelling.
    const missing = ["HEAD", "objects", "refs"].filter((n) => !existsSync(join(marker, n)));
    if (missing.length > 0) {
      return { ok: false, reason: `kök bir git deposu değil (.git içinde eksik: ${missing.join(", ")}): ${raw}` };
    }
    const notDir = ["objects", "refs"].filter((n) => !isDirSafe(join(marker, n)));
    if (notDir.length > 0) {
      return { ok: false, reason: `kök bir git deposu değil (.git içinde dizin olmayan: ${notDir.join(", ")}): ${raw}` };
    }
    return { ok: true, root: real };
  }
  if (st.isFile()) {
    let text: string;
    try {
      text = readFileSync(marker, "utf8");
    } catch {
      return { ok: false, reason: `.git dosyası okunamadı: ${raw}` };
    }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return { ok: false, reason: `.git dosyası 'gitdir:' satırı taşımıyor: ${raw}` };
    // Göreli gitdir gerçek bir hâl (taşınabilir worktree): köke göre çözülür.
    const target = isAbsolute(m[1]!) ? m[1]! : resolve(real, m[1]!);
    if (!existsSync(join(target, "HEAD"))) {
      return { ok: false, reason: `.git dosyasının gösterdiği git dizini yok: ${target}` };
    }
    // A lone HEAD is not enough — any directory can hold one. The two real
    // shapes are distinguished by what sits beside it: a linked worktree's
    // admin dir carries `commondir` (its objects live in the main repo), a
    // submodule's carries `objects/`. Requiring objects/ alone would reject
    // every worktree, which is where this project's own measurement runs.
    if (!existsSync(join(target, "commondir")) && !isDirSafe(join(target, "objects"))) {
      return { ok: false, reason: `.git dosyasının gösterdiği dizin git yönetim dizini değil: ${target}` };
    }
    return { ok: true, root: real };
  }
  return { ok: false, reason: `.git ne dizin ne dosya: ${raw}` };
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Not adını yol bileşeni yapmadan ÖNCE doğrular.
 *
 * Bulgu (M4.1 ikinci dalga, unvalidated-output-path-component): `note` hem girdi
 * yolunun (`<notlar>/<note>.md`) hem HAM ÇIKTI adının parçasıydı ve hiç
 * doğrulanmıyordu. Ölçülen iki arıza:
 *   - `../../../escaped` → ham kayıt ilan edilen `incomplete/` ağacının DIŞINA
 *     yazıldı, yani dosyanın kendi "eksik çıktı sözleşmesi" delindi;
 *   - `nested/child` → araç rc=0 ile bitti ama o notun ham kaydı hiç yazılmadı
 *     (ara dizin yok; istisna yutuldu). SESSİZ kanıt kaybı.
 * O yüzden reddetme gürültülü: kapı argv ayrıştırmasında, çıkış kodu 2.
 *
 * Ölçüt tek bir yol BİLEŞENİ olması: ayraç yok, `.`/`..` değil, mutlak değil.
 * `name.with.dot` gibi noktalı adlar geçerli — altın sette kullanılıyorlar.
 */
export function validateNoteName(raw: string | undefined): NameCheck {
  if (!raw) return { ok: false, reason: "not adı boş" };
  if (isAbsolute(raw)) return { ok: false, reason: `not adı mutlak yol olamaz: ${raw}` };
  // Windows ayracı da reddediliyor: bu araç POSIX'te koşuyor, orada `\` ada
  // gömülü meşru bir karakter sanılır ve başka bir platformda ayraç olur.
  if (/[/\\]/.test(raw)) return { ok: false, reason: `not adı yol ayracı içeremez: ${raw}` };
  if (raw === "." || raw === "..") return { ok: false, reason: `not adı yol bileşeni olamaz: ${raw}` };
  // İKİNCİ ARIZA SINIFI (doğrulama turu, 14 Ağu): ad yalnız bir yol bileşeni
  // değil, PROMPT'taki veri çitinin ETİKETİ. Yeni satır + `VERI>>>` taşıyan bir
  // ad çiti GÖVDEDEN ÖNCE kapatıyor, yani gövde talimat alanına düşüyordu.
  // Kontrol karakterleri ayrıca dosya adı olarak da meşru değil.
  // Zl/Zp are here for the same reason as Cc/Cf: U+2028 and U+2029 break a line
  // wherever the label is rendered, yet they are Separators rather than Control
  // characters, so the earlier class did not reach them (verification round 2).
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw)) {
    return { ok: false, reason: "not adı kontrol/satır-ayracı karakteri (yeni satır dahil) içeremez" };
  }
  if (raw.includes(DATA_FENCE_OPEN) || raw.includes(DATA_FENCE_CLOSE)) {
    return { ok: false, reason: `not adı veri çiti dizgesi içeremez: ${raw}` };
  }
  return { ok: true, name: raw };
}

export type OutPathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Çıktı yolunu, ondan TÜRETİLEN yollar kurulmadan ÖNCE doğrular.
 *
 * Bulgu (M4.1 üçüncü dalga, unvalidated-output-path-component): önceki dalga
 * `note` adını kapıya aldı (validateNoteName) ama `outPath` doğrulanmadan
 * kalmıştı — oysa aynı sınıfın öbür yarısı o. `outPath` üç yol üretiyor:
 *   - sonuç JSONL'i (`writeFileSync(outPath, "")`),
 *   - tam hamlar (`<outPath>.<note>.raw.jsonl`),
 *   - eksik hamlar (`<dirname(outPath)>/incomplete/<basename(outPath)>.<note>...`).
 * Doğrulanmadığında ölçülen arıza sınıfı `note`'unkiyle aynı: var olmayan bir
 * dizin verilirse araç ilk yazmada patlar (koşum kaybı), `basename` boş kalan
 * bir yol (`out/`, `.`, `..`) verilirse ham kayıt adları anlamsız kurulur ve
 * `incomplete/` sözleşmesi sessizce bozulur.
 *
 * Ölçütler ucuz ve hepsi YAZMADAN ÖNCE sınanabilir: dizin var mı, dizin mi,
 * YAZILABİLİR mi, ve dosya adı tek anlamlı bir bileşen mi. Dizin canonicalize
 * ediliyor (validateRoot ile aynı gerekçe: raporlanan yol ile yazılan yol aynı
 * şey olsun). Reddetme sessiz DEĞİL — çağıran gerekçeyi basıp çıkış kodu 2 ile
 * ölüyor; sessiz reddetme bu sınıfın ilk arızasının ta kendisiydi.
 */
export function validateOutPath(raw: string | undefined): OutPathCheck {
  if (!raw) return { ok: false, reason: "çıktı yolu boş" };
  // HAM DEĞERE ÖNCE BAKILIYOR. Bulgu (doğrulama turu, 14 Ağu): kural
  // `resolve(raw)` SONRASI basename'e bakıyordu, oysa `resolve` sondaki ayracı
  // KIRPIYOR — yani "sonda yol ayracı varsa reddet" kuralı hiç çalışmadı ve
  // var olmayan `.../eksik-dizin/` kabul edilip oraya normal bir DOSYA yazıldı.
  // Kullanıcının yazdığı şey bir DİZİN adıydı; niyet ham değerde duruyor.
  const rawTail = raw.split(/[/\\]/).pop() ?? "";
  if (rawTail === "") return { ok: false, reason: `çıktı yolu yol ayracıyla bitemez: ${raw}` };
  if (rawTail === "." || rawTail === "..") {
    return { ok: false, reason: `çıktı yolu bir dosya adıyla bitmeli: ${raw}` };
  }
  const abs = resolve(raw);
  const name = basename(abs);
  // `resolve` sonrası da sınanıyor (kök yolu gibi uç hâller): basename dosya adı
  // olmazsa ham kayıt adları sessizce bozulur.
  if (name === "" || name === "." || name === "..") {
    return { ok: false, reason: `çıktı yolu bir dosya adıyla bitmeli: ${raw}` };
  }
  const dir = dirname(abs);
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return { ok: false, reason: `çıktı dizini yok: ${dir}` };
  }
  try {
    if (!statSync(realDir).isDirectory()) {
      return { ok: false, reason: `çıktı dizini bir dizin değil: ${dir}` };
    }
  } catch {
    return { ok: false, reason: `çıktı dizini okunamadı: ${dir}` };
  }
  try {
    accessSync(realDir, constants.W_OK);
  } catch {
    return { ok: false, reason: `çıktı dizini yazılabilir değil: ${dir}` };
  }
  // Hedefin KENDİSİ bir dizinse (`out/sonuclar`) yazma EISDIR ile patlardı.
  try {
    if (statSync(join(realDir, name)).isDirectory()) {
      return { ok: false, reason: `çıktı yolu bir dizin: ${raw}` };
    }
  } catch { /* yok — normal hâl, birazdan yaratılacak */ }
  return { ok: true, path: join(realDir, name) };
}

/*
 * --- `dogustan-yanlis` sözleşmesi (M4.2) ---------------------------------
 *
 * ÖLÇÜM (14 Ağu, full28 koşumu + golden-v1): 39 yanlış alarmın 27'si
 * `dogustan-yanlis`, ve hakemin verdiği 65 `dogustan-yanlis` hükmünün %41,5'i
 * altın setin `gecerli` dediği bir iddianın üstüne düşüyor. Sebep şemanın değil
 * istemin: "yazıldığı an da yanlıştı" iddiası notun NE ZAMAN yazıldığını
 * gerektiriyor, istem ise bu bilgiyi hiç vermiyordu. Kanıt yükümlülüğü olmayan
 * bir hüküm, belirsiz kalan her şeyin düştüğü kova oluyor.
 *
 * İKİ YOL VARDI, ÖLÇÜM SEÇTİ. (a) Hükmü tamamen KAPATMAK: 27 yanlış alarmın
 * hepsi `curuk`a dönerdi — etiket dürüstleşir ama yanlış alarm SAYISI düşmez
 * (ikisi de "yanlış" kümesinde, bkz. score.ts WRONG). (b) Yazılma zamanını
 * BESLEMEK: altın setin 28 notunun 26'sı gövdesinde tarih taşıyor ve 27
 * `dogustan-yanlis` yanlış alarmının 26'sı o notlarda. Yani (b) vakaların
 * %96'sına dokunuyor, (a) yalnız 1'ine.
 *
 * Seçim ikisi birden: tarih ÇIKARILABİLİYORSA besle (hüküm kazanılabilir hâle
 * gelsin), çıkarılamıyorsa hükmü KAPAT — hem istemde hem şemada hem
 * ayrıştırıcıda. Ölçülemeyen bir hüküm, ulaşılamaz olmalı.
 *
 * KAPININ VARDIĞI YER DÜZELTİLDİ (15 Ağu 2026): kapalı hâlde hüküm `curuk`a
 * DEĞİL `olculemez` + `user_resolvable`a düşüyor. Gerekçe gateClaims'te.
 */

export type AuthorshipBound = { iso: string; source: string };

const BOUND_SOURCE_LABEL: Record<Exclude<NoteDateSource, "none">, string> = {
  modified: "frontmatter `modified` alanı",
  created: "frontmatter `created` alanı",
  date: "frontmatter `date` alanı",
  body: "notun gövdesindeki en yeni tarih",
};

/**
 * Notun YAZILMA ZAMANI için bir ALT SINIR: notun kendi verdiği tarih.
 *
 * Mantık: bir not, ne frontmatter damgasından ne de andığı en yeni tarihten
 * ÖNCE yazılmış olabilir. Gerçek yazım anı [bound, bugün] aralığında. Tam
 * tarihten zayıf ama `dogustan-yanlis` için YETERLİ bir kanıt zemini: iddia
 * `bound`'da da yanlışsa ve o tarihten bu yana onu doğru kılan bir commit yoksa,
 * gerçek yazım anı aralığın neresinde olursa olsun iddia yazıldığında yanlıştı.
 *
 * MEKANİZMA ÜRÜNÜN — kopya değil (aynı gerekçe: prompt-fence import'u). Burada
 * eskiden AYRI bir gövde tarayıcısı vardı; "bu not ne zaman yazıldı" sorusuna
 * ürünün `noteTimestamp`'iyle ıraksak iki cevap veriyordu. Iraksamanın sebebi
 * dikkatsizlik değil API'ydi: `noteTimestamp` her zaman bir `iso` döndürüyor ve
 * "not tarih vermiyor" cevabı temsil edilemiyordu. O cevap artık `source:"none"`.
 *
 * Ölçüm (29 altın not, 15 Ağu 2026): frontmatter 24, gövde 27, birleşik 27 —
 * yani gövde geri düşüşü GEREKLİ (yalnız frontmatter 3 notu kaybederdi), tersi
 * sıfır. İki mekanizma değil, tek mekanizmanın iki kaynağı.
 */
export function authorshipBound(raw: string, nowIso?: string): AuthorshipBound | null {
  const { frontmatter, body } = parseNote(raw);
  const stamp = noteTimestamp(frontmatter, nowIso ?? new Date().toISOString(), { body });
  if (stamp.source === "none") return null;
  // Gün çözünürlüğü: sınır `git log --until=` argümanı oluyor ve saat/dilim
  // kısmı orada bir şey kazandırmıyor, yanlış dilim yorumuyla kaybettirebilir.
  return { iso: stamp.iso.slice(0, 10), source: BOUND_SOURCE_LABEL[stamp.source] };
}

export const BORN_WRONG = "dogustan-yanlis";
export const OLCULEMEZ = "olculemez";

/*
 * --- `olculemez` ALT SEBEBİ (M4.2, 15 Ağu 2026 mimari hükmü) --------------
 *
 * `olculemez` iki AYRI şeyi anlatıyordu ve ikisi kullanıcı için taban tabana
 * zıt: "hiçbir ölçüm bunu çözemez" (depo dışı yol, ağ, kullanıcı beyanı) ile
 * "ben ölçemem ama SEN çözebilirsin" (notun yazılma tarihi eksik). İkincisi bir
 * SORU KUYRUĞU; birincisi kapanmış bir dosya. Tek etiketle ikisi ayırt
 * edilemediği için kullanıcıya sorulabilecek her şey sessizce kayboluyordu.
 */
/**
 * Not-başına ham artefaktların son ekleri. Hakem koşucularının ikisi de
 * `<cikti>.<not>.raw.jsonl` yazıyor; `.pass1.txt` yalnız iki geçişli
 * koşucuda (`adjudicate-opencode.ts`) doğuyor. Liste ORTAK tutuluyor: bir
 * koşucu yeni bir artefakt tipi eklerse öbürünün temizliği sessizce eksik
 * kalmasın — bu dosyanın var olma sebebiyle aynı sebep.
 */
const RUN_ARTIFACT_SUFFIXES = [".raw.jsonl", ".pass1.txt"];

/**
 * Önceki koşumun not-başına artefaktlarını siler ve KAÇ TANE sildiğini döner.
 *
 * NEDEN GEREKLİ (ölçüldü 15 Ağu 2026, `stale-raw` probe'u): yalnız
 * `writeFileSync(outPath, "")` yapılınca önceki koşumun ham dosyaları yerinde
 * kalıyor. `flatten.ts` onları AYNI ÖNEKLE topluyor (`flatten.ts:47`,
 * `startsWith(rawPrefix)`) — yani çakışan şey "dizindeki her ham dosya" değil,
 * AYNI çıktı adıyla koşulan iki farklı koşum. Sonuç: 2 notluk bir koşumun
 * ardından 1 notla yapılan yeniden koşum düz dosyada yine 2 not puanlıyor.
 * Daha kötü varyantı: bugün EKSİK çıkan bir not `incomplete/`e giderken dünkü
 * TAM ham dosyası üst dizinde kalıyor ve ESKİ hükümler puanlanıyor — yani iki
 * koşum tek ölçüm gibi okunuyor.
 *
 * BİLİNEN SINIR (16 Ağu denetimi, düzeltilmedi — gerekçesi ölçüm): önek eşleşmesi
 * düz `startsWith`, o yüzden İÇ İÇE geçen çıktı adları birbirinin ad alanına
 * giriyor: `--output x.jsonl` koşumu `x.jsonl.v2.note1.raw.jsonl` dosyasını da
 * siler. Bu bir tutarsızlık DEĞİL — `flatten.ts` aynı dosyayı zaten bu koşumun
 * `v2.note1` notu sayıyor, yani silme tüketicinin gördüğü ad alanıyla birebir
 * aynı. Keskin kenarı EŞZAMANLI koşum: iç içe adlı iki koşucu aynı dizinde
 * çalışırsa kısa adlı olan uzun adlının kanıtını uçurur. Bugünkü canlı etki
 * SIFIR (kullanılan çıktı adlarının hiçbiri diğerinin öneki değil:
 * `hakem-full28-ciktisi` / `hakem-opencode-28`), ve doğru çözüm iç içe ad alanını
 * `validateOutPath`ta reddetmek — ölçülmüş bir ihtiyaç doğmadan yapılmadı.
 *
 * Kabuk glob'u KULLANILMIYOR: zsh'de eşleşmeyen bir glob komutun tamamını iptal
 * ediyor (hafıza: kabuk-tuzaklari-macos), yani ilk temiz koşumda temizlik hiç
 * çalışmazdı. Liste `readdirSync` + filtreden çıkıyor.
 *
 * Çağrısı çıktı dosyasının sıfırlanmasıyla AYNI adımda durmalı: ayrı bırakılan
 * temizlik yapılmıyor (CLAUDE.md §3).
 */
export function purgeStaleArtifacts(dirs: string[], prefix: string): number {
  let removed = 0;
  for (const dir of dirs) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.startsWith(prefix)) continue;
      if (!RUN_ARTIFACT_SUFFIXES.some((s) => f.endsWith(s))) continue;
      rmSync(join(dir, f), { force: true });
      removed++;
    }
  }
  return removed;
}

/** UI dalı: `verdict === OLCULEMEZ && unmeasurable_reason === USER_RESOLVABLE` → soru kuyruğu. */
export const USER_RESOLVABLE = "user_resolvable";
/** Ölçümle kapanmış hâl; alanın YOKLUĞU da bunu demektir (eski çıktılarla uyum). */
export const NOT_MEASURABLE = "not_measurable";
export const UNMEASURABLE_REASON_FIELD = "unmeasurable_reason";

/**
 * Kullanıcının GÖRECEĞİ metin. Ölçüt: "ölçemedim" demek yetmez, SENDEN NE
 * GEREKTİĞİNİ söylemeli — bu kayıt bir bildirim değil, cevaplanabilir bir soru.
 */
export const USER_QUESTION_AUTHORSHIP_DATE =
  "Bu not ne zaman yazıldı? Not hiçbir tarih taşımıyor: frontmatter'ında " +
  "`modified`/`created`/`date` alanı yok, gövdesinde de tarih geçmiyor. " +
  "Hakem bu iddianın yazıldığı an da yanlış olduğunu söyledi; bunu ölçmek için " +
  "notun yazılma tarihi gerekiyor. Tarihi girin ya da nota bir `modified:` alanı " +
  "ekleyin — hüküm o zaman ölçülebilir hâle gelir.";
export const VERDICTS_WITH_HISTORY = ["gecerli", "curuk", BORN_WRONG, "olculemez"] as const;
export const VERDICTS_WITHOUT_HISTORY = ["gecerli", "curuk", "olculemez"] as const;

/**
 * Hakemin çıktı şeması. `dogustan-yanlis` yalnız yazılma zamanı BESLENDİYSE
 * enum'da: şema kapısı istemle aynı şeyi söylemeli, yoksa model istemi
 * yorumlar, şemayı yorumlamaz.
 */
export function adjudicatorSchema(opts: { bornWrongAvailable: boolean }): unknown {
  const properties: Record<string, unknown> = {
    text: { type: "string" },
    line_start: { type: "integer" },
    line_end: { type: "integer" },
    verdict: {
      enum: [...(opts.bornWrongAvailable ? VERDICTS_WITH_HISTORY : VERDICTS_WITHOUT_HISTORY)],
    },
    evidence: { type: "string" },
  };
  // Alt sebep YALNIZ kapı kapalıyken şemada. Sebep triadın kendisi: istem bu
  // ayrımı yalnız o dalda anlatıyor, şema da yalnız o dalda kabul etmeli.
  // Kapı açıkken (sınır beslenmiş) `user_resolvable` diyecek bir şey YOK —
  // notun tarihi ölçülmüş durumda — ve alanı yine de sunmak modele
  // kullanmayacağı bir kaçış yolu göstermek olurdu.
  const required = ["text", "line_start", "line_end", "verdict", "evidence"];
  if (!opts.bornWrongAvailable) {
    // Provider strict mode (measured 20 Aug 2026, invalid_json_schema 400):
    // `required` must list every key in properties, so optionality is carried
    // by null in the enum, not by omission from `required`.
    properties[UNMEASURABLE_REASON_FIELD] = {
      type: ["string", "null"],
      enum: [USER_RESOLVABLE, NOT_MEASURABLE, null],
    };
    required.push(UNMEASURABLE_REASON_FIELD);
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["claims"],
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required,
          properties,
        },
      },
    },
  };
}

export const GATE_MARK =
  "[kapı: dogustan-yanlis -> olculemez (kullanıcı çözebilir), notun yazılma tarihi ölçülemedi]";

/**
 * Şema kapısının AYRIŞTIRICI tarafı.
 *
 * Neden şema yetmiyor: `--output-schema` bir SÖZLEŞME, garanti değil — kurtarma
 * katmanı (çit soyma, dengeli blok) şemadan geçmemiş metni de ayrıştırabiliyor
 * ve akış kesildiğinde kısmi çıktı geliyor.
 *
 * NEREYE DÜŞÜRÜLÜYOR — ve neden artık `curuk` DEĞİL (mimari hüküm, 15 Ağu 2026).
 * `dogustan-yanlis` tümüyle GEÇMİŞ hakkında bir iddia. Yazılma tarihi
 * ölçülemediği hâlde verilmişse hakem çoğunlukla iki yarının HİÇBİRİNİ
 * ölçmemiştir — bu hüküm belirsizliğin döküldüğü kova olarak ÖLÇÜLDÜ (14 Ağu:
 * 65 `dogustan-yanlis`in %41,5'i altın setin `gecerli` dediği iddianın üstünde).
 * `curuk` ise "O ZAMAN DOĞRUYDU, şimdi yanlış" diye bir ölçüm İDDİA EDER.
 * Kimsenin yapmadığı o ölçümü kapının kendisi uydurursa araç, kullanıcının
 * bilerek yazdığı ve hâlâ geçerli bir notu "çürümüş" diye attırabilir —
 * ölçülemeyeni ölçülmüş saymak bu ürünün var oluş sebebi olan arızanın ta
 * kendisi. O yüzden hüküm `olculemez` + `user_resolvable`: kullanıcıya
 * SORULABİLİR bir eksik olarak kaydediliyor.
 *
 * İddia SİLİNMİYOR: metin, satır aralığı ve hakemin kanıtı olduğu gibi duruyor,
 * üstüne düşürme izi ekleniyor (§3.2 — bir kararın geri alınabilmesi için
 * görünür olması gerekir).
 */
export function gateClaims(claims: unknown[], bornWrongAvailable: boolean): unknown[] {
  if (bornWrongAvailable) return claims;
  return claims.map((c) => {
    if (typeof c !== "object" || c === null) return c;
    const rec = c as Record<string, unknown>;
    if (rec.verdict === BORN_WRONG) {
      const ev = typeof rec.evidence === "string" ? rec.evidence : "";
      return {
        ...rec,
        verdict: OLCULEMEZ,
        [UNMEASURABLE_REASON_FIELD]: USER_RESOLVABLE,
        user_question: USER_QUESTION_AUTHORSHIP_DATE,
        evidence: ev ? `${ev} ${GATE_MARK}` : GATE_MARK,
      };
    }
    // Model alt sebebi KENDİ verdiyse (şema o dalda kabul ediyor) soru metni
    // yine buradan gelir: kullanıcıya gösterilecek cümle modelin serbest
    // metnine bırakılmıyor.
    if (rec.verdict === OLCULEMEZ && rec[UNMEASURABLE_REASON_FIELD] === USER_RESOLVABLE
      && typeof rec.user_question !== "string") {
      return { ...rec, user_question: USER_QUESTION_AUTHORSHIP_DATE };
    }
    return c;
  });
}

/** Ayrıştırma + kapı tek adımda; çağıran ikisini ayrı ayrı hatırlamak zorunda kalmasın. */
export function extractGatedClaims(text: string, bornWrongAvailable: boolean): unknown[] | null {
  const claims = parseClaimsFromRaw(text);
  return claims === null ? null : gateClaims(claims, bornWrongAvailable);
}

/**
 * İstemin `dogustan-yanlis` bölümü: sınır beslendiyse KAZANMA ölçütü, yoksa
 * KAPATMA. Aynı iki hâl şemada da var (adjudicatorSchema) ve ayrıştırıcıda da
 * (gateClaims) — üçü ıraksarsa model istemi değil şemayı, ayrıştırıcı ikisini
 * birden yorumlar.
 */
function bornWrongSection(bound: AuthorshipBound | null): { listSuffix: string; rule: string } {
  if (!bound) {
    return {
      listSuffix: "  — BU NOT İÇİN KAPALI, aşağıya bak",
      rule: `
Bu notun yazılma tarihi ÖLÇÜLEMEDİ: ne frontmatter'ında \`modified\`/\`created\`/
\`date\` alanı var ne de gövdesinde tarih geçiyor. O yüzden "o zaman" ne olduğu
KANITLANAMAZ ve \`dogustan-yanlis\` bu koşumda KULLANILAMAZ — çıktı şeması da
onu kabul etmiyor. Çağdaş kanıt olmadan o hükme uzanmak yasak.

ONUN YERİNE \`curuk\` YAZMA. \`curuk\` "o zaman DOĞRUYDU" diye bir ölçüm İDDİA
eder; o ölçümü yapmadıysan bu uydurmadır — ve bedeli somut: kullanıcının bilerek
yazdığı, hâlâ geçerli bir notu çöpe attırır. Ayrım şu:

  - İddia bugün yanlış VE bir zamanlar doğru olduğunun somut kanıtı elinde
    (\`git log\`/\`git show\` ile o hâli GÖRDÜN) → \`curuk\`.
  - İddia bugün yanlış ama bir zamanlar doğru olduğunu gösteremiyorsun ve
    eksiğin yalnız notun YAZILMA TARİHİ → dürüst çıkış:
        verdict = \`olculemez\`,  ${UNMEASURABLE_REASON_FIELD} = \`${USER_RESOLVABLE}\`
    Bu "çözümsüz" demek değil: "bu ölçümü kullanıcı açabilir" demek. Tarih
    kullanıcıdan gelince hüküm yeniden ölçülür. Bugün yaptığın ölçümü
    \`evidence\` alanına YİNE YAZ — kanıt atılmıyor.
  - Depoya karşı hiçbir biçimde doğrulanamayan iddia (dış servis, ağ, kullanıcı
    beyanı) → \`olculemez\`, ${UNMEASURABLE_REASON_FIELD} = \`${NOT_MEASURABLE}\`.`,
    };
  }
  return {
    listSuffix: "",
    rule: `
Bu not \`${bound.iso}\` tarihinden ÖNCE yazılmış olamaz (${bound.source}).
Gerçek yazım anını bilmiyorsun; bildiğin şu: \`${bound.iso}\` ile bugün arasında.
\`dogustan-yanlis\` demek için gereken kanıt bu yüzden ŞUDUR ve başkası değil:

  1. İddianın \`${bound.iso}\` tarihindeki kodda da YANLIŞ olduğunu göster
     (\`git log --until=${bound.iso}\` ile o tarihteki commit'i bul, ardından
     \`git show <sha>:<yol>\` / \`git log -S\` ile o hâli oku), VE
  2. \`${bound.iso}\` ile bu commit arasında iddiayı doğru kılıp sonra bozan
     bir değişiklik OLMADIĞINI göster.

İkisi birlikte sağlanınca gerçek yazım anı aralığın neresinde olursa olsun
iddia yazıldığında yanlıştı — hüküm kazanılmıştır. Kanıt \`evidence\` alanına
sha ve komutla yazılır.
İddia \`${bound.iso}\` tarihinde DOĞRUYSA hüküm \`curuk\`tır.
O tarihteki hâli ölçemiyorsan hüküm \`dogustan-yanlis\` DEĞİLDİR; bugün yanlışsa
\`curuk\`, hiç ölçemiyorsan \`olculemez\`.`,
  };
}

/**
 * Hakem istemini kurar.
 *
 * SINIR (bulgu: untrusted-prompt-boundary-divergence): not gövdesi ve mekanik
 * kanıt GÜVENİLMEYEN metin — ürün istemleriyle (observer/prompt.ts,
 * signals/classify.ts) AYNI veri çitinden geçiyorlar. Eskiden gövde ham konuyor
 * ve bölüm sonu `--- NOT SONU ---` ile işaretleniyordu: gövdenin İÇİNDE aynı
 * dizge geçtiğinde hakemin gördüğü "not burada bitti" sınırı tek anlamlı
 * değildi. Çit hem sınırı etiketliyor hem metindeki sahte kapanışı
 * etkisizleştiriyor.
 *
 * ÇERÇEVE (CLAUDE.md §2.1): ölçüm görevi, hatırlama görevi değil. Modele "bu not
 * doğru mu" diye sorulmuyor; "diske karşı ÖLÇ" deniyor. Emir kipiyle "kır /
 * saldır" da yok — o dil sağlayıcı reddine yol açıyor (codex-cyberpolicy-reddi,
 * 11 Ağu ölçümü).
 */
export function buildPrompt(note: string, body: string, evidence: string | null): string {
  const ev = evidence
    ? `\n${fenceUntrusted("ÖNCEDEN ÖLÇÜLMÜŞ KANIT (mekanik katman, aynı commit)", evidence)}\n\nBu kanıt zaten ölçüldü; yeniden ölçme. Yalnız kanıtın YETMEDİĞİ yerlerde depoya bak.\n`
    : "";
  const bornWrong = bornWrongSection(authorshipBound(body));
  return `Bir yazılım deposunun kök dizinindesin. Depo \`b4065f1\` commit'ine sabitlenmiş.

Aşağıda o depoya ait bir hafıza notu var. Görevin bu notu OKUMAK değil, ÖLÇMEK:
notun her doğrulanabilir iddiasının bu commit'te geçerli olup olmadığını
depodan tespit et.

${DATA_FENCE_RULE}

Yöntem: dosyaları oku, \`git log\`/\`git show\`/\`git ls-files\` çalıştır.
Hükmü koddan çıkar, notun kendi anlatısından değil. Not bir şeyin var
olduğunu söylüyorsa bak; olmadığını söylüyorsa yine bak.

Her iddia için hüküm:
- gecerli          : bu commit'te doğru
- curuk            : O ZAMAN doğruydu, ŞİMDİ yanlış
- dogustan-yanlis  : O ZAMAN da yanlıştı${bornWrong.listSuffix}
- olculemez        : depoya karşı doğrulanamaz (dış servis, ağ, kullanıcı
                     beyanı, tarihsel anlatı). Bu ONURLU bir cevap —
                     ölçemediğin şeye hüküm verme.

\`curuk\` ile \`dogustan-yanlis\` arasındaki fark TEK BİR ŞEY: "o zaman"ın ne
olduğu. İkisi de bugün yanlış; ayrım notun yazıldığı ANDAKİ kodda.
${bornWrong.rule}

SAYIM İDDİALARINI ATLAMA. Not bir sayı veriyorsa ("X.py 1682 satır",
"45 kayıtlı araç var", "3 test geçiyor", "8 sağlayıcı yolu") o sayıyı KOŞTUR
ve karşılaştır: \`wc -l\`, \`git grep -c\`, \`git ls-files | wc -l\`.
Sayım iddiasının kanıtı ZORUNLU olarak şu üçünü taşır — komut, ölçülen sayı,
nottaki sayı — ve şu biçimde yazılır:
  \`komut: <koştuğun komut> | olculen: <sayı> | notta: <sayı>\`
Depoda koşturulabilen bir sayım iddiası \`olculemez\` DEĞİLDİR; koştur.
(Ölçüldü: ilk doğruluk ölçümünde hakemin kaçırdığı hedef iddiaların HEPSİ bu
sınıftandı — sayı hiç ölçülmemiş, iddia gözden geçirilip geçilmişti.)

SIR SINIRI. Bir sırrın VARLIĞI ölçülür, DEĞERİ asla.
Erişme, okuma, yazdırma, kopyalama ya da üstünde akıl yürütme: işletim sistemi
anahtar zinciri (\`security find-generic-password\` ve \`security\` ailesinin
tümü, Keychain, \`secret-tool\`, \`wincred\` ve muadilleri), \`.env\` ve
\`.env.*\` dosyalarının İÇERİĞİ, \`~/.ssh\` altındaki anahtarlar, jeton ve
kimlik bilgisi dosyaları (\`*.pem\`, \`*.key\`, \`id_*\`, \`credentials\`,
\`.netrc\`, \`.npmrc\`, \`*token*\`). Onay diyaloğu açtıracak bir sır erişimi
isteme; bu görevin parçası değil.
Ölçebileceğin: sırrın VAR olduğu ve NEREDE durduğu — dosya var mı (\`ls\`),
anahtar adı ya da yol kodda geçiyor mu (\`git grep\`), kod hangi kaynaktan
okuyor. Varlık ve konum kanıt olarak yeter.
Ancak bir sırrın DEĞERİ okunarak karara bağlanabilecek bir iddia
\`olculemez\`'dir. Öyle yaz ve geç — bu, dürüstçe durabilmen için var.
(Gerçek vaka, 13 Ağu: kimlik bilgisi saklamayla ilgili bir notu ölçen hakem
anahtar zinciri erişimi istedi ve operatör "her zaman izin ver" dedi.)

Notun HER doğrulanabilir ifadesini kapsa — yalnız dikkat çekenleri değil.

\`evidence\` alanına ölçtüğün somut şeyi yaz: SHA, dosya yolu, sembol adı,
sayı. Özet yargı değil.

\`line_start\`/\`line_end\`, iddianın notun kaçıncı satırlarından geldiği
(1'den başlayarak, aşağıdaki blok içindeki gövdeye göre).

Ölçüm bütçesi: hiçbir komut 60 saniyeyi geçmesin, arka planda süreç bırakma.

${ev}
${fenceUntrusted(`NOT: ${note}.md`, body)}`;
}
