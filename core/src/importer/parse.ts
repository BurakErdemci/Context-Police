// Not ayrıştırma + mekanik çapa çıkarımı. Saf: I/O yok, depo yok, LLM yok.
// Aşırı-üretim bilinçli tolere edilir (D-M3-2): yanlış çıkan çapa skor üretmez,
// çünkü anchor-drift yalnız "geçmişte VAR OLUP kaybolmuş" durumu suçlar.

import type { Anchor } from "../types.ts";

export interface ParsedNote {
  /** Yalnız düz (girintisiz) string alanlar — description bunların içinde. */
  frontmatter: Record<string, string>;
  body: string;
}

export function parseNote(raw: string): ParsedNote {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    // Girintili satırlar (iç içe yaml) atlanır: tam yaml ayrıştırıcı bağımlılık
    // demek (K12) ve tek ihtiyacımız düz description/modified alanları.
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2] !== "") fm[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { frontmatter: fm, body: raw.slice(m[0].length) };
}

/** Frontmatter'daki not tarihini seçer; churn penceresi buradan başlar (Görev 7). */
export function noteTimestamp(fm: Record<string, string>, fallbackIso: string): string {
  for (const key of ["modified", "created", "date"]) {
    const v = fm[key];
    if (v === undefined) continue;
    const t = Date.parse(v);
    // ISO'ya normalize: churn penceresi (Görev 7) ve depodaki createdAt
    // karşılaştırmaları tek biçim varsayıyor; "11 Aug 2026" gibi ayrıştırılabilir
    // ama ISO olmayan bir frontmatter değeri oraya ham geçerse pencere kayar.
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return fallbackIso;
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
const PATH_RE = /(?:~\/|\/)?[\w.-]+(?:\/[\w.-]+)+\.\w{1,8}\b/g;
const SYMBOL_RE = /`([A-Za-z_$][A-Za-z0-9_$]{3,})(?:\(\))?`/g;

export function extractAnchors(text: string): { anchors: Anchor[]; dropped: number } {
  const seen = new Set<string>();
  const all: Anchor[] = [];
  const push = (kind: Anchor["kind"], value: string) => {
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
    if (value.startsWith("-")) return;

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
    push(v.startsWith("~/") || v.startsWith("/") ? "external_path" : "file_path", v);
  }
  const pathText = text.replace(PATH_RE, " "); // yolun içindeki hex parçası sha sanılmasın
  for (const m of pathText.matchAll(SHA_RE)) push("commit_sha", m[0]);
  for (const m of text.matchAll(SYMBOL_RE)) {
    const v = m[1]!;
    if (/^[0-9a-f]{7,40}$/.test(v)) continue; // backtick'li sha zaten commit_sha
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
