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

/**
 * Yüzey kotasının uygulanma sırası — aynı damga sınıfı içinde eşitlik bozucu
 * ikinci ölçüt olarak kimlik sırası kullanıldığı için burada yalnız kotaların
 * TANIMLI olduğu yüzey kümesini adlandırıyor.
 */
const SURFACE_ORDER: readonly Candidate["kind"][] = ["cross", "intra", "frontmatter"];

/**
 * `bId` olmayan (intra/frontmatter) adayın kimlik kodlamasındaki ikinci tarafı.
 * NULL DEĞİL bir sentinel: kimlik hem bir metin anahtarı hem de bir SQL birincil
 * anahtarı olarak kullanılıyor ve SQLite'ta NULL sütunlu birincil anahtarda
 * NULL ≠ NULL — `ON CONFLICT` hiçbir satırla eşleşmez, yani her koşum yeni satır
 * yazar ve damga hiç güncellenmezdi. Bulgu id'leri daima pozitif, çakışma yok.
 */
export const NO_SECOND_SIDE = -1;

/**
 * Adayın KİMLİĞİ: rotasyon durumunun bağlandığı şey. `(kind, aId, bId)` üçlüsü
 * çiftin KENDİSİ — aday listesindeki konumundan, listenin uzunluğundan ve
 * üretim sırasından bağımsız.
 *
 * Kodlama tek yerde, çünkü aynı dize hem bellek içi harita anahtarı hem de
 * depodaki üç sütunun karşılığı; iki ayrı kodlama iki sessizce ayrışan kimlik
 * demek olurdu.
 */
export function candidateIdentity(c: Candidate): string {
  return `${c.kind}:${c.aId}:${c.bId ?? NO_SECOND_SIDE}`;
}

/** `candidateIdentity`nin tersi. Tanınmayan/bozuk anahtar için null (dış veri). */
export function parseCandidateIdentity(
  key: string,
): { kind: Candidate["kind"]; aId: number; bId: number } | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  const [kind, a, b] = parts as [string, string, string];
  if (!SURFACE_ORDER.includes(kind as Candidate["kind"])) return null;
  const aId = Number(a); const bId = Number(b);
  if (!Number.isSafeInteger(aId) || !Number.isSafeInteger(bId)) return null;
  return { kind: kind as Candidate["kind"], aId, bId };
}

/**
 * Aday kimliği → o adayın EN SON SEÇİLDİĞİ koşumun sıra numarası. Anahtarı
 * olmayan aday hiç seçilmemiştir (= en eski, mutlak öncelik).
 *
 * Neden saat değil sayaç: damga koşum başına bir artan tamsayı, yani sıralama
 * deterministik. Saatle aynı milisaniyede biten iki koşum ayırt edilemezdi ve
 * testler saate bağlı olurdu.
 */
export type CandidateStamps = Readonly<Record<string, number>>;

/** Seçim + bir sonraki koşumun damga haritası. */
export interface CandidateSelection {
  taken: Candidate[];
  /** Girdi haritasının, bu koşumda seçilenlerin damgası `stamp` yapılmış hâli. */
  next: Record<string, number>;
  /** Bu koşumda seçilenlere yazılan damga (girdideki en büyük damga + 1). */
  stamp: number;
}

/**
 * Aynı damga sınıfı içinde eşitliği bozan deterministik sıra: ÖNCE monoton artan
 * bulgu id'leri, EN SON yüzey adı.
 *
 * Sıra neden bu (G dalgası, 12 Ağu 2026): yüzey adı başta olduğunda eşitliği
 * bozan ölçüt zamanla ilgisiz bir SÖZLÜK sırasıydı ve "cross" < "frontmatter".
 * Bütçe aktif yüzey sayısından küçükken kota turu bütçenin tamamını sözlükte
 * önde gelen yüzeye harcıyordu; ölçüldü (probe small-budget-cross-surface-
 * starvation, bütçe 1, 20 koşum): her koşumda YENİ doğan bir cross adayı, hiç
 * seçilmemiş sabit bir frontmatter adayının önüne geçti ve sabit aday 20/20
 * koşumda atlandı — açlığın ta kendisi, yalnız damga değil sıra üzerinden.
 *
 * Bulgu id'leri monoton arttığı için id sırası "eski → yeni" demektir: eski aday
 * yeni adayın önüne yapısal olarak geçer ve sonradan gelen hiçbir aday bekleyeni
 * geriye itemez. Yüzey adı yalnız GERÇEK eşitlikte (aynı id çifti, iki farklı
 * yüzey) ayraç olarak kalıyor — orada tek işi determinizm.
 */
function byIdentity(a: Candidate, b: Candidate): number {
  if (a.aId !== b.aId) return a.aId - b.aId;
  const bDiff = (a.bId ?? NO_SECOND_SIDE) - (b.bId ?? NO_SECOND_SIDE);
  if (bDiff !== 0) return bDiff;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

/**
 * Depodan gelen damga dış veri: negatif, kesirli, NaN ya da devasa olabilir.
 * 0 ve altı = "hiç seçilmemiş".
 *
 * GÜVENLİ TAMSAYI SINIRI ZORUNLU (bu testte ölçüldü, `1e18` durumu): yeni damga
 * `en büyük + 1` olarak hesaplanıyor ve float64'te 1e18 + 1 === 1e18. Elle
 * düzenlenmiş ya da bozulmuş tek bir devasa satır, damganın ARTMASINI durdurup
 * rotasyonu tümden dondururdu — düzeltilen açlığın aynısı, bu kez veri yoluyla.
 * Güvenli aralık dışındaki değer "hiç seçilmemiş" sayılıyor: hata yönü açlığa
 * DEĞİL önceliğe doğru, yani en kötü hâlde bir kez fazladan ölçüm.
 */
function normalizeStamp(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const n = Math.trunc(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * Bütçeyi adaylara dağıtır. Kural tek cümle: **bütçe kesinlikle DAMGA SIRASINA
 * göre harcanır; yüzey kotası yalnız aynı damga sınıfı içindeki yarışı böler.**
 *
 * Çıktı, adayların özgün sırasını korur (kararlı prompt, kararlı index eşlemesi).
 *
 * ### Neden kimlik, neden konum DEĞİL (üçüncü deneme, 12 Ağu 2026)
 * Aynı sınıf üç turdur kanadı ve kök sebep her seferinde aynıydı: **türetilmiş
 * ve DEĞİŞEN bir küme üzerinde KONUM tutmak.**
 *  - D dalgası durumu NOT başına tuttu; oysa tavanlanan iş birimi ÇİFT. K7'de
 *    (7 not, 21 çift) seçilen 20 kenar yedi notun HEPSİNE dokunduğu için 21.
 *    çift de "ölçülmüş" damgasını alıyor ve her koşumda yeniden atlanıyordu.
 *  - E dalgası çift bazına geçti ama durumu bir İMLEÇ (yüzeyin aday listesindeki
 *    konum) olarak tuttu. Sabit listede adildi; aday listesi sabit DEĞİL.
 *    Ölçüldü (probe `candidate-churn-coverage-bound.sh`, 6 koşum / 2 periyot):
 *    diğer adaylar her koşumda değişince sabit bir çift pencerenin sürekli
 *    arkasına düşüp sonsuza kadar aç kaldı.
 *
 * Doğru soyutlama konum değil KİMLİK: damga adayın kendisine yazılıyor,
 * listede nerede durduğuna değil.
 *
 * ### Adaletin ispatı
 * Seçilenler `max(mevcut damgalar)+1` alır; seçilmeyen her aday damgasını
 * OLDUĞU GİBİ korur. Dolayısıyla bu koşumda seçilmeyen bir aday, seçilenlerin
 * hepsinden **kesinlikle daha eski** bir damga taşır ve sonraki koşumda onların
 * tamamının önüne geçer. Bu, aday listesinin uzunluğundan ve churn'den
 * bağımsızdır — damga kimliğe bağlı, konuma değil.
 *
 * Hiç seçilmemişler (damga 0) arasında eşitliği kimlik sırası bozuyor; bu da
 * açlık üretmez, çünkü bir adayın önüne yalnız ONDAN KÜÇÜK kimlikli ve HİÇ
 * SEÇİLMEMİŞ adaylar geçebilir, ve her biri bunu en çok bir kez yapar (seçilince
 * damgası büyür). Böyle adayların sayısı sonlu. Kimlik sırasının bulgu id'siyle
 * BAŞLAMASI bu ispatın taşıyıcısı (bkz. `byIdentity`): id monoton arttığı için
 * sonradan gelen aday daima daha büyük kimliklidir, yani bekleyeni geriye
 * itemez. Yüzey adı sırada önce gelseydi ölçüt zamanla ilgisiz bir sözlük
 * sırasına düşerdi ve ispat çökerdi — G dalgasında ölçülen açlık tam buydu.
 *
 * ### Zehirli parti
 * Damga SEÇİM anında yazılıyor, hükmün dönüp dönmediğine bakılmadan. Sonuca
 * bağlansaydı hiç hüküm döndürmeyen bir parti sonsuza kadar en eski kalıp
 * seçimi kilitlerdi (E dalgasının kimlik yolunu reddetme gerekçesi — itiraz
 * damgayı SONUÇTA yazan tasarım için geçerliydi, seçimde yazan için değil).
 *
 * ### Kapsama sınırı
 * Sabit bir aday kümesinde her aday en geç **⌈N_toplam / max⌉** koşumda seçilir,
 * ve bu sınır GEVŞEK DEĞİL TAM: son adayın ölçüldüğü koşum tam olarak bu sayı.
 * İspatı yukarıdaki adalet argümanının doğrudan sonucu — her koşum bütçeyi
 * kesinlikle en eski damgalılara harcıyor ve hiç boşa harcamıyor (kota turundan
 * artan bütçe aynı damga sınıfı içinde dağıtılıyor), yani her koşum kalan
 * ölçülmemiş kümeyi `max` kadar küçültüyor.
 *
 * Yüzey kotası bu sınıra GİRMEZ; kota bir koşum İÇİNDEKİ payı belirler, kaç
 * koşum gerektiğini değil.
 *
 * İki kuşak boyunca buraya yanlış sınır yazıldı, ikisi de düzeltildi:
 *  - E dalgası küresel ⌈N/M⌉ yazdı, F dalgası bunu "yanlış" ilan edip yüzey
 *    başına **⌈N_yüzey / kota_yüzey⌉** ile değiştirdi.
 *  - Ölçüldü (G dalgası, 12 Ağu 2026, 30 yapılandırma — bütçe 1/2/3/5/20 ×
 *    çeşitli yüzey dağılımları): gerçek kapsama HER yapılandırmada ⌈N/max⌉'e
 *    eşit çıktı. Yüzey ifadesi ise iki yönde birden hatalı: bütçe < aktif yüzey
 *    sayısı iken FAZLA KÜÇÜK (max=1, 20/20/20 adayda "20" diyor, gerçek 60 —
 *    yani ihlal edilebilir bir güvence), tek yüzeyli kümede ise gereksiz büyük
 *    (max=20, 21 cross'ta "3" diyor, gerçek 2).
 *
 * Ders: doğru sınır kotanın değil BÜTÇENİN fonksiyonu. Bu projede yanlış
 * yazılmış bir iddia yazılmamış olmasından kötüdür — sınır artık ölçülmüş sınır.
 */
export function selectCandidates(
  candidates: Candidate[],
  max: number,
  stamps: CandidateStamps = {},
): CandidateSelection {
  // Kota MAX_CLASSIFY_ITEMS ölçeğinde tanımlı; farklı bir tavanla çağrılırsa
  // (audit --max-classify-items) oranı korunur. En az 1: küçük bir tavanda bile
  // hiçbir yüzey tümden kapanmasın.
  const quota = (k: Candidate["kind"]) =>
    Math.max(1, Math.floor((max * CLASSIFY_SURFACE_QUOTA[k]) / MAX_CLASSIFY_ITEMS));

  const stampOf = new Map<number, number>();
  for (const [i, c] of candidates.entries()) stampOf.set(i, normalizeStamp(stamps[candidateIdentity(c)]));

  // KÜRESEL sıra: önce damga (eski → yeni), sonra kimlik.
  const order = candidates.map((_, i) => i).sort((x, y) => {
    const d = stampOf.get(x)! - stampOf.get(y)!;
    return d !== 0 ? d : byIdentity(candidates[x]!, candidates[y]!);
  });

  const chosen = new Set<number>();
  const takenCount = new Map<Candidate["kind"], number>();
  let budget = max;
  const take = (p: number) => {
    const k = candidates[p]!.kind;
    chosen.add(p);
    takenCount.set(k, (takenCount.get(k) ?? 0) + 1);
    budget--;
  };

  // Damga sınıfı sınıfı işleniyor: bir sonraki (daha TAZE) sınıfa geçmeden önce
  // bu sınıfın artıkları da dağıtılıyor. Sıralama böyle olmasaydı kota, bütçeyi
  // daha eski bir adayı bekletirken daha taze bir adayı YENİDEN ölçmeye
  // harcayabilirdi — ölçüldü: 20/20/20 adayda cross'un kotası 8 ama 3. koşumda
  // yalnız 4 ölçülmemiş cross kalıyor; kalan 4 slot eskiden taze cross'a
  // gidiyordu, şimdi hâlâ hiç ölçülmemiş intra/frontmatter'a gidiyor.
  let i = 0;
  while (i < order.length && budget > 0) {
    const s = stampOf.get(order[i]!)!;
    let j = i;
    while (j < order.length && stampOf.get(order[j]!)! === s) j++;
    const cls = order.slice(i, j);
    // (1) kota turu: her yüzey payını alır (sayaç koşum boyunca kümülatif).
    for (const p of cls) {
      if (budget === 0) break;
      if ((takenCount.get(candidates[p]!.kind) ?? 0) >= quota(candidates[p]!.kind)) continue;
      take(p);
    }
    // (2) artık turu: kalan bütçe AYNI sınıf içinde kimlik sırasıyla dağılır.
    for (const p of cls) {
      if (budget === 0) break;
      if (!chosen.has(p)) take(p);
    }
    i = j;
  }

  // Yeni damga: girdideki en büyük + 1. Depoda hiç damga yoksa 1'den başlar
  // (0 "hiç seçilmemiş" anlamına ayrılmış).
  let highest = 0;
  for (const v of Object.values(stamps)) {
    const n = normalizeStamp(v);
    if (n > highest) highest = n;
  }
  const stamp = highest + 1;
  // Bu koşumun adaylarında OLMAYAN kimliklerin damgası korunuyor: aday kümesi
  // churn ile daralıp genişliyor ve geri dönen bir aday sırasını kaybetmemeli.
  // Sınırsız büyümenin cevabı budama; store/classify-stamps.ts'te, gerekçesiyle.
  const next: Record<string, number> = { ...stamps };
  for (const p of chosen) next[candidateIdentity(candidates[p]!)] = stamp;

  return { taken: candidates.filter((_, i2) => chosen.has(i2)), next, stamp };
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
   * Bir sonraki koşumun aday damgaları. Ölçüm BAŞARISIZ olsa da ilerler: damga
   * "en son ne zaman SEÇİLDİ"yi tutuyor, "ne zaman ölçüldü"yü değil. Sonuca
   * bağlansaydı, hüküm döndürmeyen zehirli bir parti sonsuza kadar en eski
   * kalıp geri kalan adayların sırasını kilitlerdi.
   */
  nextStamps: Record<string, number>;
  /** Bu koşumda seçilenlere yazılan damga; depoya yalnız bu değerli satırlar gider. */
  rotationStamp: number;
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
  opts: { maxItems?: number; stamps?: CandidateStamps } = {},
): Promise<ClassifyResult> {
  const max = opts.maxItems ?? MAX_CLASSIFY_ITEMS;
  const { taken, next: nextStamps, stamp: rotationStamp } = selectCandidates(candidates, max, opts.stamps);
  const dropped = candidates.length - taken.length;
  const takenSet = new Set(taken);
  /** Bütçeye hiç girmemiş aday da ölçülmemiş bir adaydır. */
  const droppedCandidates = candidates.filter((c) => !takenSet.has(c));
  if (taken.length === 0)
    return {
      ok: true, confirmed: [], kararsiz: 0, unclassified: 0,
      unmeasured: droppedCandidates, measured: [], nextStamps, rotationStamp, calls: 0, dropped,
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
    unmeasured: candidates, measured: [], nextStamps, rotationStamp, calls, dropped, error,
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
    nextStamps, rotationStamp, calls, dropped,
  };
}
