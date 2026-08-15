// Not ayrıştırma + mekanik çapa çıkarımı. Saf: I/O yok, depo yok, LLM yok.
// Aşırı-üretim bilinçli tolere edilir (D-M3-2): yanlış çıkan çapa skor üretmez,
// çünkü anchor-drift yalnız "geçmişte VAR OLUP kaybolmuş" durumu suçlar.

import type { Anchor } from "../types.ts";
import { DASH_LIKE_PREFIX_RE, anchorValueError, normalizeAnchorValue } from "../anchor-value.ts";

export interface ParsedNote {
  /**
   * Düz string alanlar + `metadata:` başlığı altındaki TEK seviye (2 boşluk)
   * girintili alanlar, tek düzleme haritada. Üst seviyede AYNI ADLA bir anahtar
   * VARSA — değeri boş olsa bile — girintili namesake onu ezemez.
   */
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Girintili alanların düzleme haritaya alındığı TEK ebeveyn.
 *
 * Denetim (frontmatter-scope-confusion): eskiden girintili her `key: value`
 * ebeveynine BAKILMADAN toplanıyordu, yani `presentation:` ya da herhangi bir
 * başka başlık altındaki `modified:` gerçek denetim damgası sanılıyordu. Notu
 * yazan (kullanıcı ya da başka bir AI ajanı) böylece denetim penceresini
 * frontmatter'ın istediği köşesinden sürebiliyordu.
 *
 * Beyaz liste NEDEN tek isim: ölçülen ihtiyaç tek (altın set §5.4 — gerçek
 * Claude Code not biçiminde `modified` alanı `metadata:` altında duruyor).
 * Yeni bir ebeveyn ancak yeni bir ölçümle eklenir.
 */
const NESTED_PARENT = "metadata";

export function parseNote(raw: string): ParsedNote {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const fm: Record<string, string> = {};
  // Girintili alanlar ayrı toplanır ve SONRA düzleştirilir: üst seviye bir alan
  // aynı adı taşıyorsa o kazanmalı, yoksa `metadata.modified` gerçek `modified`
  // alanını ezebilirdi.
  const nested: Record<string, string> = {};
  /**
   * Üst seviyede GÖRÜLEN anahtarlar — `fm`den ayrı tutulur çünkü değeri boş olan
   * anahtar (`modified:` + boş) `fm`e hiç yazılmıyor. Ayrım olmadan, girintili
   * namesake boş bırakılmış bir üst seviye alanı EZİYORDU; yani yukarıdaki
   * "üst seviye kazanır" sözleşmesi tam da saldırganın kolayca kurabileceği
   * durumda çöküyordu (`modified:` boş + `metadata: modified: 2099`).
   */
  const topLevelKeys = new Set<string>();
  /** İçinde bulunulan eşleme başlığı; null = girintili alan beklenmiyor. */
  let parent: string | null = null;
  const unquote = (v: string) => v.replace(/^["']|["']$/g, "");
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv !== null) {
      topLevelKeys.add(kv[1]!);
      if (kv[2] !== "") fm[kv[1]!] = unquote(kv[2]!);
      // Değeri BOŞ olan üst seviye anahtar bir eşleme başlığı adayıdır; değeri
      // dolu olan skalerdir ve altında girintili alan beklenmez.
      parent = kv[2] === "" ? kv[1]! : null;
      continue;
    }
    // Tam YAML ayrıştırıcı hâlâ YOK (K12: bağımlılık yasak) — yalnız tek seviye
    // `key: value`. Ölçüm (altın set §5.4): gerçek Claude Code not biçiminde
    // `modified` alanı `metadata:` altında girintili duruyor ve okunamadığı için
    // 28 notun 28'inde noteTimestamp import anına düştü; churn'ün `--since`
    // penceresi tümden kullanılamaz oldu. İç içe listeler ve daha derin
    // girintiler bilerek kapsam dışı: ihtiyaç modified/created/date ile sınırlı.
    const sub = /^ {2}([A-Za-z_][\w-]*):\s*(.+)$/.exec(line);
    if (sub !== null && parent === NESTED_PARENT && nested[sub[1]!] === undefined)
      nested[sub[1]!] = unquote(sub[2]!);
    // Eşleşmeyen satır (boş satır, liste öğesi, daha derin girinti) başlık
    // bağlamını BOZMAZ: `metadata:` altındaki bir boş satır sonraki alanı
    // kapsam dışına atmamalı.
  }
  for (const [k, v] of Object.entries(nested)) if (!topLevelKeys.has(k)) fm[k] = v;
  return { frontmatter: fm, body: raw.slice(m[0].length) };
}

/**
 * Olaya/hükme yazılırken bir frontmatter değerinden yankılanan azami karakter.
 * Değer güvenilmeyen metin ve tavanı yok (256 KiB'lık tek satırlık bir `modified`
 * meşru bir dosyada bile mümkün); olay günlüğü onu ham taşımamalı.
 */
const VALUE_ECHO_MAX = 200;

/**
 * `NoteTimestamp.iso` değerinin NEREDEN geldiği.
 *
 * `"none"` = NOT HİÇBİR TARİH VERMİYOR; `iso` çağıranın verdiği geri düşüştür.
 * Bu ayrım sonradan eklendi ve sebebi ölçülmüş: fonksiyon her zaman bir `iso`
 * döndürüyor ve dönen değerin hiçbir yerinde "bu notun kendi tarihi değil"
 * yazmıyordu. "Not tarih vermiyor" cevabı API'de YAPISAL OLARAK
 * TEMSİL EDİLEMEZ olduğu için (a) 28 notun 28'i sessizce içe aktarma anına
 * düştü ve bu görünmedi, (b) o cevaba ihtiyaç duyan bir araç kendi tarih
 * çıkarıcısını yazdı — sınır ilkelinin ıraksak kopyası.
 */
export type NoteDateSource = "modified" | "created" | "date" | "body" | "none";

export interface NoteTimestamp {
  /** Kullanılacak ISO damga; churn penceresi (Görev 7) buradan başlar. */
  iso: string;
  /** `iso`nun kaynağı. `"none"` ise not tarih vermiyor, `iso` geri düşüştür. */
  source: NoteDateSource;
  /**
   * Damga içe aktarma anına KELEPÇELENDİ: notun verdiği değer gelecekteydi.
   * Dolu olması sessiz bir düzeltme değil, çağıranın olaya yazması gereken bir
   * olgudur.
   */
  clamped?: { field: string; value: string };
  /** `Date.parse` çözemedi, alan atlandı — hangi alan hangi değerle. */
  unparsable?: { field: string; value: string }[];
}

const echo = (v: string) => (v.length > VALUE_ECHO_MAX ? v.slice(0, VALUE_ECHO_MAX) + "…" : v);

/**
 * Notun tarihini seçer; churn penceresi buradan başlar (Görev 7). Sıra:
 * frontmatter `modified` > `created` > `date` > (istenirse) gövdedeki en yeni
 * tarih > geri düşüş. Seçilen kaynak `source` alanında döner — "notun tarihi
 * yok" cevabı ancak öyle temsil edilebiliyor.
 *
 * `fallbackIso` iki iş yapar: alan yoksa GERİ DÜŞÜŞ, alan varsa TAVAN. Çağıran
 * onu içe aktarma anı olarak verir (`nowIso()`), yani tavan "şimdi"dir.
 *
 * KELEPÇE — denetim: untrusted-audit-window (BLOCKER). Damga notun kendi
 * metninden geliyor, yani kullanıcının ya da başka bir AI ajanının yazdığı
 * güvenilmeyen veriden; ve `createdAt` olarak saklanıp git'in `--since` sınırı
 * oluyor. Ölçüldü (probe: future-modified-suppresses-churn): aynı çapa geri
 * düşüş tarihiyle `churned`/0,2 verirken `modified: 2099-01-01` ile `ok`/0
 * veriyordu — denetlenen not kendi denetim penceresini kapatıyordu.
 *
 * Neden yalnız GELECEK kelepçeleniyor: geçmiş damga meşru (eski not gerçekten
 * eskidir ve geniş pencere denetimi SIKILAŞTIRIR, gevşetmez); gelecek damga ise
 * fiziksel olarak imkânsız ve tek etkisi pencereyi kapatmak.
 */
export function noteTimestamp(
  fm: Record<string, string>,
  fallbackIso: string,
  opts?: { body?: string },
): NoteTimestamp {
  const ceiling = Date.parse(fallbackIso);
  const unparsable: { field: string; value: string }[] = [];
  const extra = () => (unparsable.length > 0 ? { unparsable } : {});
  const settle = (t: number, source: NoteDateSource, field: string, value: string): NoteTimestamp => {
    // `fallbackIso` ayrıştırılamıyorsa tavan yok — bu çağıranın hatası, ama
    // burada uydurma bir tavan üretmek yanlış pencereyi sessizce dayatırdı.
    if (!Number.isNaN(ceiling) && t > ceiling)
      return { iso: new Date(ceiling).toISOString(), source, clamped: { field, value }, ...extra() };
    // ISO'ya normalize: churn penceresi (Görev 7) ve depodaki createdAt
    // karşılaştırmaları tek biçim varsayıyor; "11 Aug 2026" gibi ayrıştırılabilir
    // ama ISO olmayan bir frontmatter değeri oraya ham geçerse pencere kayar.
    return { iso: new Date(t).toISOString(), source, ...extra() };
  };
  for (const key of ["modified", "created", "date"] as const) {
    const v = fm[key];
    if (v === undefined) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) {
      // Eskiden sessizce bir sonraki alana geçiliyordu. Sessizlik burada pahalı:
      // "bozuk damga" ile "damga yok" ayrımı, notun tarihinin neden import anına
      // düştüğünü açıklayan tek şey.
      unparsable.push({ field: key, value: echo(v) });
      continue;
    }
    return settle(t, key, key, echo(v));
  }
  // Gövde taraması İSTEĞE BAĞLI ve frontmatter'dan SONRA gelir: mevcut
  // çağıranların (importer) davranışı `body` verilmediği sürece değişmiyor.
  // Ölçüm (29 altın not, 15 Ağu 2026): frontmatter 24'ünü, gövde taraması
  // 27'sini kapsıyor ve gövdenin kapsayıp frontmatter'ın kaçırdığı 3 not var;
  // TERSİ SIFIR. Yani gövde geri düşüşü olmadan tek mekanizma, iki notu
  // ölçülebilirken ölçülemez sayardı.
  const bodyDate = opts?.body === undefined ? null : newestBodyDate(opts.body);
  if (bodyDate !== null) return settle(Date.parse(bodyDate), "body", "body", bodyDate);
  return { iso: fallbackIso, source: "none", ...extra() };
}

const TR_MONTHS: Record<string, number> = {
  oca: 1, şub: 2, sub: 2, mar: 3, nis: 4, may: 5, haz: 6,
  tem: 7, ağu: 8, agu: 8, eyl: 9, eki: 10, kas: 11, ara: 12,
};

const ISO_DATE_RE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
const TR_DATE_RE = /(?<!\d)(\d{1,2})\s+(Oca|Şub|Sub|Mar|Nis|May|Haz|Tem|Ağu|Agu|Eyl|Eki|Kas|Ara)[a-zçğıöşü]*\s+(\d{4})/giu;

const ymd = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Gövdede geçen EN YENİ tarih — notun yazılma zamanı için bir ALT SINIR.
 *
 * Mantık: bir not, içinde andığı en yeni tarihten ÖNCE yazılmış olamaz. Tam
 * tarihten zayıf ama frontmatter tarih taşımadığında elde kalan tek ucuz kaynak:
 * hafıza notları git'te değil (`~/.context-police/golden/...`), yani `git log`
 * yazarlık geçmişi vermiyor ve dosya mtime kopyalamayla bozulur.
 *
 * ÇIKTI KISITLI: yalnız yeniden kurulmuş `YYYY-MM-DD`. Gövde GÜVENİLMEYEN metin
 * ve bu değer aşağı akışta bir istemin TALİMAT alanına giriyor — ham eşleşme
 * değil, regex'in yakaladığı sayılardan yeniden kurulmuş dizge yazılır.
 *
 * 2000–2100 aralığı sürüm numarası ve anlamsız yılı eler (`v1.2.3`, `13 Ağu 1899`);
 * sessizce sınır uydurmak, sınıra bağlı hükmü yanlışlıkla AÇAR.
 */
function newestBodyDate(body: string): string | null {
  let best: string | null = null;
  const take = (s: string): void => { if (best === null || s > best) best = s; };
  for (const m of body.matchAll(ISO_DATE_RE)) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    take(ymd(y, mo, d));
  }
  for (const m of body.matchAll(TR_DATE_RE)) {
    const d = Number(m[1]), y = Number(m[3]);
    const mo = TR_MONTHS[m[2]!.toLowerCase()];
    if (mo === undefined || y < 2000 || y > 2100 || d < 1 || d > 31) continue;
    take(ymd(y, mo, d));
  }
  return best;
}

/**
 * İçe aktarılan bir notun TARANAN ve SAKLANAN üst sınırı (UTF-16 karakter).
 *
 * Denetim: unbounded-note-size. `importMemoryDir` bir .md dosyasını sınırsız
 * okuyup hem `extractAnchors`'a veriyor hem de olduğu gibi depoya yazıyordu;
 * ölçüldü (probe), 100 MB'lık tek dosya 100 MB'lık tek satır olarak
 * saklanıyordu — ve bu depoda hiçbir şey SİLİNMİYOR (spec §3.2), yani tek
 * patolojik dosya kalıcı.
 *
 * 256 KiB nereden: gerçek hafıza korpusu ölçüldü (`~/.claude/projects/*​/memory/*.md`,
 * 86 dosya, 12 Ağu 2026): p50 2,4 KB, p90 6,7 KB, p99 31 KB, maks 45 KB. Bağımsız
 * çürütücünün 131 dosyalık daha geniş ölçümü: p50 2 KB, p99 75 KB, maks 109 KB.
 * Tavan gerçek maksimumun ~2,4 katı — meşru hiçbir not bugün kırpılmıyor, ama
 * maliyet sınırlı kalıyor.
 *
 * WHY THE BOUND STAYS, now that the regex no longer needs it (M4.6, 15 Aug 2026).
 * It used to be doing two jobs; the second one is gone. `PATH_RE` was quadratic in
 * the length of a single unbroken `[\w.-]` run, so this bound was also the only
 * thing keeping that cost finite (~33 s CPU at the bound, measured). The
 * lookbehind on `PATH_RE` linearised it — 256 KiB run: 32.722 ms -> 0,89 ms, and
 * it now stays linear far past the bound (64 MiB run: 216 ms). So the ceiling is
 * NOT a regex remedy any more.
 *
 * The first job remains and is the reason it is not removed: the audit that
 * created it was about STORAGE, not CPU — an unbounded .md is written to the
 * store verbatim, and nothing in this store is ever deleted (spec §3.2), so one
 * pathological file is permanent. That argument is independent of any regex.
 */
export const MAX_NOTE_CHARS = 256 * 1024;

/** Notu tavana kırpar. `truncated` > 0 ise çağıran bunu olaya yazar — sessiz kırpma yok. */
export function capNoteContent(raw: string): { content: string; truncated: number } {
  if (raw.length <= MAX_NOTE_CHARS) return { content: raw, truncated: 0 };
  let cut = MAX_NOTE_CHARS;
  // Kesim vekil çiftinin ORTASINA denk gelirse geriye tek başına yüksek vekil
  // kalır; UTF-8'e kodlanamayan bu değer depoya yazıldığında gidiş-dönüş bozulur
  // (aynı sınıf prompt.ts'te \p{Cs} olarak zaten yasaklı).
  const code = raw.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return { content: raw.slice(0, cut), truncated: raw.length - cut };
}

export const MAX_ANCHORS_PER_NOTE = 16;

/**
 * Tavanın tür başına ilk turda ayırdığı pay. Ölçüm (altın set §5.1): tavan
 * TÜRLER ARASI TAM SIRALI uygulandığı için 260 çapanın %81'i sembol oldu ve
 * 28 notun 18'inde SIFIR file_path kaldı — `missing_now` ve `churned` sinyalleri
 * (yalnız file_path yüzeyinde çalışırlar) altın sette hiç ateşlenmedi. Bir notta
 * (`bekleyen-isler`) atılan 138 çapanın içinde, penceresinde GERÇEKTEN değişmiş
 * bir yol vardı. 6 seçildi çünkü 16/4 türden biraz fazlası: az türlü notta tavanı
 * kısıtlamıyor (artık dolduruluyor), çok türlü notta tek türün seli %38'de kalıyor.
 */
export const PER_KIND_QUOTA = 6;

/** Tavan kırpmasının sırası (M0-D4); satır no çapası hiç üretilmediği için listede yok. */
const ANCHOR_PRIORITY: readonly Anchor["kind"][] = ["symbol", "file_path", "commit_sha", "external_path"];

// Satır numarası deseni BİLEREK yok (M0-D4): kırılgan ve içerik göstergesi değil.
// Tire komşulu hex bir commit sha'sı değil: uuid segmentleri tireyle ayrılır ve
// `\b` tirede eşleştiği için yetersizdi — gerçek hafıza notlarında ölçüldü (Görev 4),
// frontmatter'daki originSessionId 6 notun 6'sında iki sahte sha üretiyordu. Zararı
// aşırı-üretimden büyük: gerçekte çapasız bir not sahte çapayla `unanchored`
// olmaktan çıkıyor ve M0-D5'in "çapasız not nötrdür" koruması siliniyordu.
const SHA_RE = /(?<![0-9a-f-])[0-9a-f]{7,40}(?![0-9a-f-])/g;

/**
 * The leading lookbehind is a PERFORMANCE fix, not a semantic one.
 *
 * Without it the engine retries the whole match at every offset inside a long
 * unbroken `[\w.-]` run, so cost is quadratic in the run length (measured
 * 12 Aug 2026: 4 KiB 15,7 ms · 8 KiB 59,3 ms · 16 KiB 242 ms · 32 KiB 1.016 ms,
 * exactly 4x per doubling). The lookbehind kills every restart that begins
 * mid-token, which linearises it — measured on the pathological input,
 * node 24.10 / macOS: 18.180 ms -> 0,63 ms.
 *
 * It DOES change output for one input class: a path glued directly to the
 * preceding token with no separator (`see~/x/a.ts`, `foo//a/b.ts`). Previously
 * the engine walked into the token and emitted the tail as an anchor — and
 * could even flip its kind, since restarting one character later turns
 * `/a/b.ts` (external_path) into `a/b.ts` (file_path). Now such a path is not
 * emitted at all. Re-measured 15 Aug 2026 over 122 real note files
 * (`~/.claude/projects/*​/memory/*.md` + the golden set): ZERO occurrences,
 * 209 path matches identical on both regexes. The class is pinned by test
 * rather than by corpus, because the corpus does not currently contain it.
 */
const PATH_RE = /(?<![\w.\-/~])(?:~\/|\/)?[\w.-]+(?:\/[\w.-]+)+\.\w{1,8}\b/g;

const SYMBOL_RE = /`([A-Za-z_$][A-Za-z0-9_$]{3,})(?:\(\))?`/g;

/**
 * A symbol anchor exists to answer ONE question: "has this note's subject moved?"
 * A token that appears in most of the history cannot answer it. `SYMBOL_RE` alone
 * matches any backticked word, so ordinary prose keywords became anchors.
 *
 * Rule: keep a symbol only if it carries a naming-convention marker — a `_`/`$`,
 * or an uppercase letter past the first position together with a lowercase one
 * (camelCase / PascalCase compounds). Single-word all-lower (`return`, `list`,
 * `write`) and single-word all-upper (`HEAD`, `PATH`) are rejected.
 *
 * Measured (15 Aug 2026, 305 distinct symbols from the 28 golden GaMachine notes,
 * scored by commits touched via `git log --all -S<sym>` over a 263-commit repo):
 *
 *              n    median  mean   >20 commits
 *   kept      212      3     5,3      11
 *   rejected   93     23    38,2      51
 *
 * Worst rejected: `return` 193 commits (73% of history), `list` 142, `type` 131,
 * `None` 127, `write` 115. Worst kept: `workspace_path` 35.
 *
 * A `()` call-suffix escape hatch was measured and REJECTED: across the golden
 * set only 16 symbols are written as `` `name()` `` and it would rescue exactly
 * 3 rejected ones (`decide`, `Sync`, `poll`) — all still low-selectivity words.
 * A language-keyword stoplist was likewise unnecessary: every keyword this rule
 * must catch is already a single-case single word, and a stoplist would have
 * missed the larger share of the noise (`list`, `value`, `tool`, `memory`).
 *
 * Cost of a false rejection is bounded: a note left with no anchors falls into
 * the `unanchored` class, which is neutral by M0-D5 — it does not score.
 */
function isSelectiveSymbol(s: string): boolean {
  if (/[_$]/.test(s)) return true;
  return /[A-Z]/.test(s.slice(1)) && /[a-z]/.test(s);
}

export function extractAnchors(text: string): { anchors: Anchor[]; dropped: number } {
  const seen = new Set<string>();
  const all: Anchor[] = [];
  const push = (kind: Anchor["kind"], raw: string) => {
    // Normalize ÖNCE, hüküm SONRA (anchor-value.ts sözleşmesi). Bu yüzeyde
    // kırpma yapısı gereği NO-OP: değerler regex'ten geliyor ve desenlerin
    // hiçbiri boşluk üretemiyor. Yine de ortak fonksiyondan geçiyor — iki
    // yüzeyin aynı değeri üretmesi ancak tek bir giriş kapısıyla garanti.
    const value = normalizeAnchorValue(raw);

    // Tire ile BAŞLAYAN çapa üretilmez (denetim: imported-flag-anchor).
    // `--output/tmp/audit.txt` yol şeklinde olduğu için çapa olarak saklanıyordu.
    // Bugün sömürülebilir DEĞİL — çapayı tüketen üç git çağrısının hepsi ya `--`
    // ayracı kullanıyor ya değeri `<ref>:` ile birleştiriyor — ama koruma değerde
    // değil ÇAĞRI YERİNDE olduğu için `--`'sız yeni bir tüketici eklendiği an
    // bayrak olur. Bu satır o riski üretim yerinde kesen ikinci kapı.
    //
    // Normalize DEĞİL, RED: baştaki tireleri kırpmak (`--output/tmp/a.ts` →
    // `output/tmp/a.ts`) var olmayan bir yolu uydurur ve şansa gerçek bir dosyaya
    // denk gelirse sahte bir kayma sinyali üretir. Reddin bedeli ise yalnız bir
    // çapa eksikliği: not en kötü ihtimalle `unanchored` sınıfına düşer (M0-D5,
    // nötr). Yasak yalnız BAŞ karakterde — `src/my-mod/a-b.ts` ve `/tmp/-x/a.txt`
    // argv'de bayrak konumuna düşemez, dokunulmaz.
    //
    // Hüküm artık ortak (anchor-value.ts): ASCII tirenin yanında görsel tire
    // varyantlarını da kapsıyor ve gözlemci yüzeyiyle AYNI kümeyi kullanıyor.
    if (anchorValueError(value) !== null) return;

    // Mükerrer anahtarının ayracı NUL: hiçbir çapa değerinde geçemeyeceği için
    // iki ayrı (kind, value) çiftinin aynı anahtara düşmesi mümkün olmuyor.
    // Kaynağa ham bayt değil kaçış dizisi yazılır — ham kontrol baytı git'i
    // dosyayı binary saymaya itip diff'i körleştiriyordu (fdfd4fe, bu depoda).
    const key = `${kind}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push({ kind, value });
  };

  for (const m of text.matchAll(PATH_RE)) {
    const v = m[0];
    // Bayrak hükmü metindeki TOKEN'a bakar, eşleşmeye değil. Sebep: PATH_RE'nin
    // karakter sınıfı (`[\w.-]`) ASCII tireyi İÇERİYOR ama unicode tire
    // varyantlarını içermiyor — "-src/a.ts" tireyle başlayan bir eşleşme verip
    // aşağıdaki hükümde düşerken, "—src/a.ts" `src/a.ts` olarak eşleşip hükmü
    // ATLIYORDU. Yani ASCII vakasının yakalanması bir tasarım değil, karakter
    // sınıfının rastlantısıydı. Öncesindeki tek karaktere bakmak o rastlantıyı
    // hükme çeviriyor.
    //
    // Altın set etkisi ÖLÇÜLDÜ (14 Ağu 2026, ~/.claude/projects/*/memory
    // altındaki 92 not, 129 yol eşleşmesi): bu sınıftan SIFIR eşleşme var —
    // yani hüküm mevcut çıkarım zeminini değiştirmiyor, yalnız gözlemci
    // yüzeyiyle hizalıyor. Metinde tireden sonra boşluk gelen yaygın biçim
    // ("— src/a.ts") etkilenmiyor.
    const prev = m.index > 0 ? text[m.index - 1]! : "";
    if (DASH_LIKE_PREFIX_RE.test(prev)) continue;
    push(v.startsWith("~/") || v.startsWith("/") ? "external_path" : "file_path", v);
  }
  const pathText = text.replace(PATH_RE, " "); // yolun içindeki hex parçası sha sanılmasın
  for (const m of pathText.matchAll(SHA_RE)) push("commit_sha", m[0]);
  for (const m of text.matchAll(SYMBOL_RE)) {
    const v = m[1]!;
    if (/^[0-9a-f]{7,40}$/.test(v)) continue; // backtick'li sha zaten commit_sha
    if (!isSelectiveSymbol(v)) continue;
    push("symbol", v);
  }

  // Tavan iki turlu: önce her tür kotası kadar pay alır (bir türün seli diğerini
  // boğamasın), sonra kalan boşluk M0-D4 önceliğiyle artıklardan doldurulur (az
  // türlü notta tavan kısıtlanmasın). Tür içinde metindeki geçiş sırası korunur
  // (kararlı çıktı), çıktı sırası tür önceliğine göre. Sessiz kırpma yok —
  // çağıran dropped'ı olaya yazar (Görev 4).
  const byKind = new Map<Anchor["kind"], Anchor[]>(ANCHOR_PRIORITY.map((k) => [k, all.filter((a) => a.kind === k)]));
  const kept = new Map<Anchor["kind"], Anchor[]>(ANCHOR_PRIORITY.map((k) => [k, []]));
  let budget = MAX_ANCHORS_PER_NOTE;
  for (const kind of ANCHOR_PRIORITY) {
    if (budget === 0) break;
    const take = Math.min(PER_KIND_QUOTA, byKind.get(kind)!.length, budget);
    kept.get(kind)!.push(...byKind.get(kind)!.slice(0, take));
    budget -= take;
  }
  for (const kind of ANCHOR_PRIORITY) {
    if (budget === 0) break;
    const rest = byKind.get(kind)!.slice(kept.get(kind)!.length);
    const take = Math.min(rest.length, budget);
    kept.get(kind)!.push(...rest.slice(0, take));
    budget -= take;
  }
  const anchors = ANCHOR_PRIORITY.flatMap((kind) => kept.get(kind)!);
  return { anchors, dropped: all.length - anchors.length };
}
