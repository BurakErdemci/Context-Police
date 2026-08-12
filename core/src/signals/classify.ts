// Aday çiftlerin TEK toplu Codex çağrısıyla sınıflanması (D-M3-6). Çerçeve
// ölçümdür, teyit ya da saldırı değil: "bu iki ifade çelişiyor mu" (spec §3.4;
// cyberPolicy ölçümü: "kır" kipi reddediliyor, "ölç" geçiyor).

import type { ExecutorAdapter } from "../adapters/executor.ts";
import type { Candidate, NoteView } from "./contradiction.ts";
import { parseNote } from "../importer/parse.ts";
// Veri-bloğu çiti gözlemci prompt'uyla ORTAK: aynı sınıf iki yerde (transcript →
// supersedes, not metni → çelişki) ve iki ayrı sınır tanımı, birinin diğerinden
// sessizce ayrışması demek. Tanım artık ortak modülde — eskiden observer/prompt.ts'ten
// alınıyordu, yani sinyal katmanı gözlemci katmanına bağımlıydı.
import { DATA_FENCE_RULE, fenceUntrusted, neutralizeFence } from "../prompt-fence.ts";

export const MAX_CLASSIFY_ITEMS = 20; // koşum başına; taşan sayı raporlanır

/**
 * Sınıflama bütçesinin yüzeylere dağılımı (MAX_CLASSIFY_ITEMS ölçeğinde).
 *
 * Ölçüm (altın set §5.3): `findCandidates` 69 aday üretti, kırpma sırasız bir
 * `slice(0,20)` idi ve üretim sırası önce TÜM cross'ları verdiği için ilk 20'nin
 * hepsi cross oldu. Atılan 49 adayın TAMAMI intra + frontmatter — yani M0-D3'ün
 * saha örneği verdiği iki yüzey (not-içi çelişki, description ↔ gövde) sınıflamaya
 * hiç girmedi ve onaylanan çelişki 0 çıktı. Sayılar: cross en çok aday üreten
 * yüzey olduğu için en büyük payı alıyor, ama diğer ikisi artık garantili.
 */
export const CLASSIFY_SURFACE_QUOTA: Record<Candidate["kind"], number> = { cross: 8, intra: 6, frontmatter: 6 };

/** Devir sırası: payını kullanmayan yüzeyin artığı bu sırayla dağıtılır. */
const SURFACE_ORDER: readonly Candidate["kind"][] = ["cross", "intra", "frontmatter"];

/**
 * Yüzey başına rotasyon imleci: "bu yüzeyin kararlı aday sırasında bir sonraki
 * koşum nereden başlayacak". Eksik anahtar = 0 (baştan).
 */
export type ClassifyCursors = Readonly<Partial<Record<Candidate["kind"], number>>>;

/** Seçim + bir sonraki koşumun imleçleri. İmleçler HER yüzey için doludur. */
export interface CandidateSelection {
  taken: Candidate[];
  next: Record<Candidate["kind"], number>;
}

/**
 * Adayın KİMLİĞİ üzerinden kararlı sıra. İmleç bir KONUM, ve konumun anlamı
 * ancak sıra koşumlar arasında aynı kaldığı sürece var. Üretim sırası
 * (`findCandidates`) bunu garanti etmiyor: çapa haritasının yineleme sırası not
 * kümesi değişince kayıyor. (aId, bId) ise çiftin kendisi — aynı çift her
 * koşumda aynı yere düşer.
 */
function byIdentity(a: Candidate, b: Candidate): number {
  if (a.aId !== b.aId) return a.aId - b.aId;
  return (a.bId ?? -1) - (b.bId ?? -1);
}

/** Depodan gelen imleç dış veri: negatif, kesirli ya da liste boyundan büyük olabilir. */
function normalizeCursor(raw: number | undefined, length: number): number {
  if (length === 0) return 0;
  const n = Math.trunc(raw ?? 0);
  if (!Number.isFinite(n)) return 0;
  return ((n % length) + length) % length;
}

/**
 * Bütçeyi yüzeylere bölerek aday seçer. İki tur: önce her yüzey kotası kadar
 * alır, sonra kalan boşluk öncelik sırasıyla artıklardan dolar — kota bütçeyi
 * KÜÇÜLTMEZ, yalnız tek bir yüzeyin hepsini yutmasını engeller.
 * Çıktı, adayların özgün sırasını korur (kararlı prompt, kararlı index eşlemesi).
 *
 * ROTASYON KAYAN BİR PENCERE, damga sıralaması değil. Yüzeyin adayları kimlik
 * sırasına dizilir, seçim imlecin gösterdiği yerden başlar ve listede döner;
 * imleç seçilen sayı kadar ilerler. Adaletin ispatı bu yüzden YAPICI: N aday ve
 * M < N tavanla ardışık pencereler listeyi ⌈N/M⌉ koşumda tarar, yani hiçbir
 * aday süresiz atlanamaz.
 *
 * Bir gün önceki hâli (findings.last_classified_at, not başına ölçüm damgası)
 * bunu YAPAMIYORDU: tavanlanan iş birimi çift, durum ise nottaydı. Yedi notun
 * her ikilisi bir çapa paylaşınca 21 adaydan 20'si seçiliyor, ama o 20 kenar
 * yedi notun hepsine dokunduğu için 21.'si de "ölçülmüş" sayılıyor ve sıralama
 * onu her koşumda yeniden dışarıda bırakıyordu (denetim:
 * `classification-candidate-starvation`, 8 koşum boyunca ölçüldü).
 *
 * Kaybedilen özellik ve kabul gerekçesi: "hiç ölçülmemiş aday önce gelir"
 * önceliği kalktı — yeni bir not, sırasına kadar en çok ⌈N/M⌉ koşum bekler.
 * O öncelik zaten not düzeyinde kurulabiliyordu, yani hatalıydı; ve amaçladığı
 * şeyi (hiçbir şey sonsuza kadar beklemesin) imleç daha sıkı bir sınırla
 * veriyor. Pahalı bir çift tablosu olmadan ikisi birden alınamıyor.
 */
export function selectCandidates(
  candidates: Candidate[],
  max: number,
  cursors: ClassifyCursors = {},
): CandidateSelection {
  const byKind = new Map<Candidate["kind"], number[]>();
  for (const [i, c] of candidates.entries()) {
    const list = byKind.get(c.kind);
    if (list === undefined) byKind.set(c.kind, [i]);
    else list.push(i);
  }
  const pos = new Map<Candidate["kind"], number>();
  for (const [kind, list] of byKind) {
    list.sort((x, y) => byIdentity(candidates[x]!, candidates[y]!));
    pos.set(kind, normalizeCursor(cursors[kind], list.length));
  }
  // Kota MAX_CLASSIFY_ITEMS ölçeğinde tanımlı; farklı bir tavanla çağrılırsa
  // (audit --max-classify-items) oranı korunur. En az 1: küçük bir tavanda bile
  // hiçbir yüzey tümden kapanmasın.
  const quota = (k: Candidate["kind"]) =>
    Math.max(1, Math.floor((max * CLASSIFY_SURFACE_QUOTA[k]) / MAX_CLASSIFY_ITEMS));
  const chosen = new Set<number>();
  const takenCount = new Map<Candidate["kind"], number>();
  let budget = max;
  const takeFrom = (kind: Candidate["kind"], limit: number) => {
    const list = byKind.get(kind);
    if (list === undefined) return;
    let n = takenCount.get(kind) ?? 0;
    const before = n;
    // `n < list.length`: pencere bir koşumda listeyi en çok bir kez dolaşır,
    // yani aynı aday iki kez seçilemez (ve budget boşa gitmez).
    while (budget > 0 && n - before < limit && n < list.length) {
      const p = pos.get(kind)!;
      chosen.add(list[p]!);
      pos.set(kind, (p + 1) % list.length);
      n++; budget--;
    }
    takenCount.set(kind, n);
  };
  for (const kind of SURFACE_ORDER) takeFrom(kind, quota(kind));
  for (const kind of SURFACE_ORDER) takeFrom(kind, Infinity);

  // Bu koşumda hiç adayı olmayan yüzeyin imleci OLDUĞU GİBİ korunur: yüzey geri
  // geldiğinde kaldığı yerden devam etsin, sıfırlanıp baştaki adayları
  // ayrıcalıklı hâle getirmesin.
  const next = {} as Record<Candidate["kind"], number>;
  for (const kind of SURFACE_ORDER) next[kind] = pos.get(kind) ?? Math.max(0, Math.trunc(cursors[kind] ?? 0));
  return { taken: candidates.filter((_, i) => chosen.has(i)), next };
}
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
  /** Model AÇIKÇA "kararsiz" dedi — bir hüküm, bilgisizlik değil. */
  kararsiz: number;
  /**
   * Prompt'ta gösterildi ama HİÇBİR hüküm dönmedi (ya da hiç gösterilemedi).
   * `kararsiz`ten ayrı: orada model ölçüp karar veremediğini söyledi, burada
   * ölçüm hiç yapılmadı. Denetim (2026-08-12, `incomplete-classification-clean`):
   * şema-geçerli BOŞ bir `verdicts` dizisi bile `ok: true` dönüyordu, yani
   * "sınıflanmadı" ile "sınıflandı, çelişki yok" ayırt edilemiyordu — ve
   * ayırt edilemeyen fark, `audit.ts`te sessiz bir AKLAMAYA dönüşüyordu.
   */
  unclassified: number;
  /**
   * Çelişki boyutu bu adaylar için ÖLÇÜLMEDİ: bütçeye girmeyenler (dropped) +
   * hüküm dönmeyenler. `audit.ts` bunu, ilgili notların önceki hükmünü
   * korumak için kullanır.
   */
  unmeasured: Candidate[];
  /**
   * Çelişki boyutu bu adaylar için GERÇEKTEN ölçüldü (gösterildi ve hüküm
   * döndü). `unmeasured`ın tümleyeni; `audit.ts` bununla rotasyon damgasını
   * yazar — ölçülmemiş adayın damgası ilerlerse rotasyon kendi amacını yıkardı.
   */
  measured: Candidate[];
  /**
   * Bir sonraki koşumun rotasyon imleçleri. Ölçüm BAŞARISIZ olsa da ilerler:
   * imleç "nereye kadar SEÇİLDİ"yi tutuyor, "nereye kadar ölçüldü"yü değil.
   * Sonuca bağlansaydı, hüküm döndürmeyen zehirli bir parti sonsuza kadar aynı
   * yerde durup geri kalan adayların sırasını kilitlerdi.
   */
  nextCursors: Record<Candidate["kind"], number>;
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
  // sınırları prompt-fence.ts'teki DATA_FENCE_RULE yorumunda.
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

/**
 * @param shown Prompt'ta GERÇEKTEN gösterilen index kümesi. Sınır eskiden
 *   `taken.length` üzerinden kuruluyordu; oysa `renderItems` notu bulunamayan
 *   adayı ATLIYOR, yani aralık içinde ama hiç gösterilmemiş index'ler vardı.
 *   Model öyle bir index döndürdüğünde hüküm, modelin hiç görmediği bir adaya
 *   bağlanıyordu (denetim 2026-08-12, eşleme açığı). Sınır artık kümenin kendisi.
 */
export function parseClassifyOutput(
  raw: string, shown: ReadonlySet<number>,
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
    if (typeof c?.index !== "number" || !shown.has(c.index) || seen.has(c.index)) continue;
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
  opts: { maxItems?: number; cursors?: ClassifyCursors } = {},
): Promise<ClassifyResult> {
  const max = opts.maxItems ?? MAX_CLASSIFY_ITEMS;
  const { taken, next: nextCursors } = selectCandidates(candidates, max, opts.cursors);
  const dropped = candidates.length - taken.length;
  const takenSet = new Set(taken);
  /** Bütçeye hiç girmemiş aday da ölçülmemiş bir adaydır. */
  const droppedCandidates = candidates.filter((c) => !takenSet.has(c));
  if (taken.length === 0)
    return {
      ok: true, confirmed: [], kararsiz: 0, unclassified: 0,
      unmeasured: droppedCandidates, measured: [], nextCursors, calls: 0, dropped,
    };

  // item.index = adayın taken içindeki konumu (renderItems entries() index'i
  // kullanır); nota erişilemeyen aday atlanmış olsa da index'ler taken'a işaret
  // eder — verdict eşlemesi bu yüzden doğrudan taken[v.index]. `shown` tam da
  // atlananları dışarıda bırakır: gösterilmemiş index'e hüküm bağlanamaz.
  const items = renderItems(taken, notes);
  const shown = new Set(items.map((it) => it.index));
  const prompt = buildClassifyPrompt(items);
  let calls = 0;

  const runOnce = async (p: string) => {
    calls++;
    return executor.run({ prompt: p, outputSchema: CLASSIFY_OUTPUT_SCHEMA });
  };

  // Ölçüm HİÇ yapılamadı: adayların TAMAMI (bütçeye girmeyenler dahil) ölçülmemiş.
  const failed = (error: string): ClassifyResult => ({
    ok: false, confirmed: [], kararsiz: 0, unclassified: taken.length,
    unmeasured: candidates, measured: [], nextCursors, calls, dropped, error,
  });

  let res = await runOnce(prompt);
  if (!res.ok) { res = await runOnce(prompt); } // geçici hata tekrarı (spec §3.3)
  if (!res.ok) return failed(`yürütücü: ${res.error}`);

  let parsed = parseClassifyOutput(res.output, shown);
  if (!parsed.ok) {
    const retry = await runOnce(
      `${prompt}\n\nÖNCEKİ ÇIKTIN GEÇERSİZDİ: ${parsed.error}. Yalnız şemaya uyan JSON döndür.`,
    );
    if (!retry.ok) return failed(`yürütücü: ${retry.error}`);
    parsed = parseClassifyOutput(retry.output, shown);
    if (!parsed.ok) return failed(`geçersiz JSON (iki deneme): ${parsed.error}`);
  }

  const confirmed: Candidate[] = [];
  let kararsiz = 0;
  const decided = new Set<number>();
  for (const v of parsed.verdicts) {
    decided.add(v.index);
    if (v.verdict === "celiski") confirmed.push(taken[v.index]!);
    else if (v.verdict === "kararsiz") kararsiz++;
  }
  // Hüküm dönmeyen aday "uyumlu" DEĞİL: prompt'ta gösterilip cevapsız kalan da,
  // notu bulunamadığı için hiç gösterilemeyen de ölçülmemiş sayılır. Sessizce
  // temiz saymak, ürünün "ölçemedim ≠ temiz" sözleşmesinin ihlali.
  const undecided = taken.filter((_, i) => !decided.has(i));
  return {
    ok: true, confirmed, kararsiz,
    unclassified: undecided.length,
    unmeasured: [...droppedCandidates, ...undecided],
    measured: taken.filter((_, i) => decided.has(i)),
    nextCursors, calls, dropped,
  };
}
