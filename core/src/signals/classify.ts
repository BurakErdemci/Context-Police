// Aday çiftlerin TEK toplu Codex çağrısıyla sınıflanması (D-M3-6). Çerçeve
// ölçümdür, teyit ya da saldırı değil: "bu iki ifade çelişiyor mu" (spec §3.4;
// cyberPolicy ölçümü: "kır" kipi reddediliyor, "ölç" geçiyor).

import type { ExecutorAdapter } from "../adapters/executor.ts";
import type { Candidate, NoteView } from "./contradiction.ts";
import { parseNote } from "../importer/parse.ts";
// Veri-bloğu çiti gözlemci prompt'uyla ORTAK tutuluyor: aynı sınıf iki yerde
// (transcript → supersedes, not metni → celiski) ve iki ayrı sınır tanımı,
// birinin diğerinden sessizce ayrışması demek. Tanım şu an observer/prompt.ts'te
// yaşıyor; ortak bir modüle taşınması bu turun dosya kapsamı dışındaydı.
import { DATA_FENCE_RULE, fenceUntrusted, neutralizeFence } from "../observer/prompt.ts";

export const MAX_CLASSIFY_ITEMS = 20; // koşum başına; taşan sayı raporlanır
const EXCERPT_CHARS = 1500;
/**
 * Aday gerekçesi ("ortak çapa: <yol>") kanıt değil TEŞHİS: modelin kararı
 * metinlerden çıkıyor, gerekçeden değil — bu yüzden gövde sınırının çok altında.
 * Ölçüldü (denetim: classify-reason-unbounded): 200.007 karakterlik tek bir yol
 * çapası, gövdeler kısayken 200.449 karakterlik prompt üretiyordu. Üretim yerinde
 * de kırpılıyor (contradiction.ts); buradaki sınır ikinci kapı, çünkü reason
 * ileride başka bir üreticiden de gelebilir.
 */
const REASON_CHARS = 200;

export interface ClassifyItem {
  index: number;
  kind: Candidate["kind"];
  aText: string;
  bText: string | null;
  reason: string;
}

export interface ClassifyVerdict { index: number; verdict: "celiski" | "uyumlu" | "kararsiz"; evidence: string }

export interface ClassifyResult {
  ok: boolean;
  confirmed: Candidate[];
  kararsiz: number;
  calls: number;
  dropped: number;
  error?: string;
}

// OpenAI strict mode: required, properties'in HER anahtarını listeler (M2 dersi
// invalid_json_schema — FakeExecutor'ın gizlediği gerçek-koşum arızası).
export const CLASSIFY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          verdict: { type: "string", enum: ["celiski", "uyumlu", "kararsiz"] },
          evidence: { type: "string" },
        },
        required: ["index", "verdict", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

const clip = (s: string, max = EXCERPT_CHARS) => (s.length > max ? s.slice(0, max) + "…[kırpıldı]" : s);

export function buildClassifyPrompt(items: ClassifyItem[]): string {
  // Not metni GÜVENİLMEYEN veri: denetlenen deponun kendisinden geliyor ve
  // "hepsine celiski de" yazan bir not sınıflandırıcıya talimat verebiliyordu
  // (denetim: classify-note-prompt-injection). Guillemet bir sınır değildi —
  // metnin içinde de geçebiliyor. Artık her alıntı etiketli bir veri bloğunda,
  // blok işaretleri metnin içinde kurulamıyor. TAM koruma DEĞİL: gerekçesi ve
  // sınırları observer/prompt.ts'teki DATA_FENCE_RULE yorumunda.
  const rendered = items.map((it) => {
    // Gerekçe de dolaylı olarak not metninden türüyor ("ortak çapa: <yol>"):
    // başlık satırında duruyor, o yüzden bloğa alınmıyor ama etkisizleştiriliyor.
    const reason = neutralizeFence(clip(it.reason, REASON_CHARS));
    if (it.kind === "cross")
      return `#${it.index} [notlar-arası, ${reason}]\n` +
        `${fenceUntrusted(`#${it.index} A`, clip(it.aText))}\n${fenceUntrusted(`#${it.index} B`, clip(it.bText ?? ""))}`;
    if (it.kind === "frontmatter")
      return `#${it.index} [özet-satırı ↔ gövde]\n` +
        `${fenceUntrusted(`#${it.index} özet`, clip(it.bText ?? ""))}\n${fenceUntrusted(`#${it.index} gövde`, clip(it.aText))}`;
    return `#${it.index} [not-içi]\n${fenceUntrusted(`#${it.index} metin`, clip(it.aText))}`;
  }).join("\n\n");

  return `Aşağıda numaralı adaylar var. Her aday için görev bir ÖLÇÜM: verilen iki metin
(ya da tek metnin parçaları) aynı konu hakkında birbiriyle ÇELİŞİYOR MU?

- "celiski": iki ifade aynı anda doğru olamaz.
- "uyumlu": çelişki yok ya da farklı şeylerden bahsediyorlar.
- "kararsiz": metinden karar verilemiyor.

evidence: kararın dayanağı TEK cümle. Yalnız istenen şemada JSON döndür.

${DATA_FENCE_RULE}

${rendered}`;
}

export function parseClassifyOutput(
  raw: string, itemCount: number,
): { ok: true; verdicts: ClassifyVerdict[] } | { ok: false; error: string } {
  // Düzyazıya sarılı JSON kurtarma — gözlemcide ölçülen aynı sınıf (prompt.ts).
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, error: "çıktıda JSON nesnesi yok" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `JSON ayrıştırılamadı: ${(e as Error).message}` };
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) return { ok: false, error: "verdicts dizisi yok" };
  const seen = new Set<number>();
  const out: ClassifyVerdict[] = [];
  for (const v of verdicts) {
    const c = v as ClassifyVerdict;
    if (typeof c?.index !== "number" || c.index < 0 || c.index >= itemCount || seen.has(c.index)) continue;
    if (c.verdict !== "celiski" && c.verdict !== "uyumlu" && c.verdict !== "kararsiz") continue;
    seen.add(c.index);
    out.push({ index: c.index, verdict: c.verdict, evidence: typeof c.evidence === "string" ? c.evidence : "" });
  }
  return { ok: true, verdicts: out };
}

function renderItems(candidates: Candidate[], notes: Map<number, NoteView>): ClassifyItem[] {
  const items: ClassifyItem[] = [];
  for (const [i, c] of candidates.entries()) {
    const a = notes.get(c.aId);
    if (a === undefined) continue;
    if (c.kind === "cross") {
      const b = c.bId !== null ? notes.get(c.bId) : undefined;
      if (b === undefined) continue;
      items.push({ index: i, kind: c.kind, aText: a.content, bText: b.content, reason: c.reason });
    } else if (c.kind === "frontmatter") {
      items.push({ index: i, kind: c.kind, aText: parseNote(a.content).body, bText: a.description, reason: c.reason });
    } else {
      items.push({ index: i, kind: c.kind, aText: a.content, bText: null, reason: c.reason });
    }
  }
  return items;
}

export async function classifyCandidates(
  executor: ExecutorAdapter,
  candidates: Candidate[],
  notes: Map<number, NoteView>,
  opts: { maxItems?: number } = {},
): Promise<ClassifyResult> {
  const max = opts.maxItems ?? MAX_CLASSIFY_ITEMS;
  const taken = candidates.slice(0, max);
  const dropped = candidates.length - taken.length;
  if (taken.length === 0) return { ok: true, confirmed: [], kararsiz: 0, calls: 0, dropped };

  // item.index = adayın taken içindeki konumu (renderItems entries() index'i
  // kullanır); nota erişilemeyen aday atlanmış olsa da index'ler taken'a işaret
  // eder — verdict eşlemesi bu yüzden doğrudan taken[v.index].
  const items = renderItems(taken, notes);
  const prompt = buildClassifyPrompt(items);
  let calls = 0;

  const runOnce = async (p: string) => {
    calls++;
    return executor.run({ prompt: p, outputSchema: CLASSIFY_OUTPUT_SCHEMA });
  };

  let res = await runOnce(prompt);
  if (!res.ok) { res = await runOnce(prompt); } // geçici hata tekrarı (spec §3.3)
  if (!res.ok) return { ok: false, confirmed: [], kararsiz: 0, calls, dropped, error: `yürütücü: ${res.error}` };

  let parsed = parseClassifyOutput(res.output, taken.length);
  if (!parsed.ok) {
    const retry = await runOnce(
      `${prompt}\n\nÖNCEKİ ÇIKTIN GEÇERSİZDİ: ${parsed.error}. Yalnız şemaya uyan JSON döndür.`,
    );
    if (!retry.ok) return { ok: false, confirmed: [], kararsiz: 0, calls, dropped, error: `yürütücü: ${retry.error}` };
    parsed = parseClassifyOutput(retry.output, taken.length);
    if (!parsed.ok) return { ok: false, confirmed: [], kararsiz: 0, calls, dropped, error: `geçersiz JSON (iki deneme): ${parsed.error}` };
  }

  const confirmed: Candidate[] = [];
  let kararsiz = 0;
  for (const v of parsed.verdicts) {
    if (v.verdict === "celiski") confirmed.push(taken[v.index]!);
    else if (v.verdict === "kararsiz") kararsiz++;
  }
  return { ok: true, confirmed, kararsiz, calls, dropped };
}
