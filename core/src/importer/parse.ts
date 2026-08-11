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

  // Tavana kimin gireceği M0-D4 önceliğiyle belirlenir: sembol çapası kayma
  // tespitinde en güçlü sinyal, yol seli onu kurban etmemeli. Tür içinde metindeki
  // geçiş sırası korunur (kararlı çıktı). Tavan: sessiz kırpma yok — çağıran
  // dropped'ı olaya yazar (Görev 4).
  const ordered = ANCHOR_PRIORITY.flatMap((kind) => all.filter((a) => a.kind === kind));
  return { anchors: ordered.slice(0, MAX_ANCHORS_PER_NOTE), dropped: Math.max(0, ordered.length - MAX_ANCHORS_PER_NOTE) };
}
