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
 *
 * `coverage` (kapsama rotasyonu, signals/coverage.ts) TAVANI 4: bütçenin en çok
 * beşte biri. Toplam artık 24 > 20, yani bütçeye SIĞMIYOR — bilerek. Üç çelişki
 * yüzeyinin ölçülmüş payları (8/6/6) olduğu gibi duruyor; rotasyon onların
 * tabanını KÜÇÜLTMÜYOR, yalnız kendi tavanına kadar yaşlılık sırasında
 * yarışıyor. "Hareket önceliği korur" bunun karşılığı: üç çelişki yüzeyi de
 * doluyken rotasyon REZERVASYON turunda 4'ten fazlasını alamaz, yani bütçenin
 * 16'sı her koşum çelişki tarafında kalır. Rotasyonun 4'ü aşabildiği tek yol
 * ARTIK turu — çelişki adaylarının istemediği, aksi hâlde boşa gidecek slotlar.
 * Ölçüldü: üç yüzey de doymuşken kapsama kapsaması TAM ⌈N/4⌉ koşum
 * (test/m4-5-coverage-rotation.test.ts, 1–100 aday).
 */
export const CLASSIFY_SURFACE_QUOTA: Record<Candidate["kind"], number> =
  { cross: 8, intra: 6, frontmatter: 6, coverage: 4 };

/**
 * Kotası TANIMLI yüzeylerin kümesi. Sıra bir öncelik DEĞİL (öncelik damga +
 * kimlik); yalnız rezervasyon turunun yüzeyleri deterministik bir düzende
 * gezmesini ve `parseCandidateIdentity`nin geçerli yüzeyi tanımasını sağlıyor.
 */
const SURFACE_ORDER: readonly Candidate["kind"][] = ["cross", "intra", "frontmatter", "coverage"];

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
 * olmayan aday hiç seçilmemiştir; önceliğini artık İLK GÖRÜLDÜĞÜ koşum belirler
 * (mutlak öncelik M4.5'te kaldırıldı — `CandidateSelection.nextSeen`).
 * Aynı tip ilk-görülme haritası için de kullanılıyor: iki harita da
 * "kimlik → koşum numarası".
 *
 * Neden saat değil sayaç: damga koşum başına bir artan tamsayı, yani sıralama
 * deterministik. Saatle aynı milisaniyede biten iki koşum ayırt edilemezdi ve
 * testler saate bağlı olurdu.
 */
export type CandidateStamps = Readonly<Record<string, number>>;

/** Seçim + bir sonraki koşumun damga haritaları. */
export interface CandidateSelection {
  taken: Candidate[];
  /** Girdi haritasının, bu koşumda seçilenlerin damgası `stamp` yapılmış hâli. */
  next: Record<string, number>;
  /**
   * "Bu adayı İLK KEZ hangi koşumda gördük" haritası. Bu koşumda ilk kez görülen
   * her aday `stamp` alır; var olan giriş asla değişmez.
   *
   * Neden ayrı bir harita (yüzey İÇİ sel, altıncı açlık biçimi): damga 0 "hiç
   * seçilmemiş" demekti ve MUTLAK öncelik taşıyordu, yani bir yüzeye her koşum
   * rezervinden çok TAZE aday girdiğinde o yüzeyin daha önce ölçülmüş adayları
   * süresiz bekliyordu. İlk-görülme, taze adaya da bir YAŞ verir: sıraya
   * girdiği anın numarası. Böylece öncelik "hiç ölçülmemiş mi" sorusundan
   * "ne zamandır bekliyor" sorusuna geçiyor ve iki yön de sınırlı kalıyor —
   * yalnız damgayı yaşlandırmak (taze adaya sabit bir yaş vermek) ters yönde
   * açlık üretiyordu: aday sayısı bütçenin katlarına çıktığında ölçülmüş
   * adayların yaşı o sabiti kalıcı olarak geçiyor ve taze aday hiç ölçülmüyordu.
   */
  nextSeen: Record<string, number>;
  /** Bu koşumda seçilenlere yazılan damga (girdideki en büyük damga + 1). */
  stamp: number;
  /**
   * Damgalar güvenli tamsayı tavanına dayandığı için YENİDEN NUMARALANDI:
   * `next`/`nextSeen`in TAMAMI yazılmalı, yalnız `stamp` değerli satırlar değil.
   */
  renumbered: boolean;
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
 * Damga sayacı güvenli tamsayı tavanına dayandığında haritayı SIRAYI KORUYARAK
 * 1..k aralığına sıkıştırır.
 *
 * Kusur (M4.5 borcu): sayaç `en büyük + 1` idi. En büyük değer tam olarak
 * `MAX_SAFE_INTEGER` olduğunda yeni damga güvenli olmayan bir tamsayıya çıkıyor,
 * depo yazımı onu reddediyor (classify-stamps.ts giriş kapısı) ve HİÇBİR damga
 * ilerlemiyor — aynı adaylar sonsuza kadar seçiliyor. Kırpmak (tavanda sabitlemek)
 * çözüm değil: eşitlenen damgalar sıralamayı çökertirdi. Sıkıştırma sıralamayı
 * birebir koruduğu için seçim bu koşumda da aynı kalır, yalnız sayılar küçülür.
 */
function compressStamps(
  maps: Record<string, number>[],
): { maps: Record<string, number>[]; stamp: number } {
  const values = [...new Set(maps.flatMap((m) => Object.values(m)).map(normalizeStamp).filter((v) => v > 0))]
    .sort((a, b) => a - b);
  const rank = new Map(values.map((v, i) => [v, i + 1]));
  return {
    maps: maps.map((m) => Object.fromEntries(
      Object.entries(m).map(([k, v]) => [k, rank.get(normalizeStamp(v)) ?? 0]),
    )),
    stamp: values.length + 1,
  };
}

/**
 * Bütçeyi adaylara dağıtır. Kural tek cümle: **önce her yüzeye slot REZERVE
 * edilir, sonra rezervler kendi yüzeylerinin öncelik kuyruğundan doldurulur;
 * artan slotlar küresel öncelikle dağıtılır.**
 *
 * Çıktı, adayların özgün sırasını korur (kararlı prompt, kararlı index eşlemesi).
 *
 * ### Neden rezervasyon, neden "sırala sonra kes" DEĞİL (H dalgası, 12 Ağu 2026)
 * Açlık sınıfı bu tarihe kadar BEŞ kez kanadı ve son ikisinin kökü aynıydı:
 * kota SIRALAMANIN İÇİNDE uygulanıyordu — her şey tek bir listeye diziliyor,
 * sonra kesiliyordu. Öyle bir yapıda tek bir yüzey listeyi domine edebiliyor:
 *  - G dalgası (küçük bütçe): eşitliği bozan ölçüt yüzey ADI olduğu için bütçe
 *    sözlükte önde gelen yüzeye gidiyordu. Kimlik sırasıyla kapandı.
 *  - H dalgası (normal bütçe): "hiç ölçülmemiş" damga sınıfı bütçeyi kota
 *    devreye girmeden tüketiyordu. Ölçüldü (probe `churned-surface-starvation`,
 *    12 koşum): 10 kalıcı intra + 10 kalıcı frontmatter damgalıyken her koşuma
 *    20 TAZE cross eklendiğinde 12/12 koşumda `cross=20, intra=0, frontmatter=0`.
 *    Kalıcı adaylar hiç yeniden ölçülmedi.
 *
 * Kural olarak "hiç ölçülmemiş önce gelir" YANLIŞ değil; yanlış olan, o kuralın
 * kotayı EZMESİ. Kota keyfi bir sayı değil: altın setin 1. turunda 20 slotun
 * tamamı cross'a gitti ve onaylanan çelişki 0 çıktı — M0'ın saha örneği verdiği
 * iki yüzey (intra, frontmatter) sınıflamaya hiç girmemişti. Kota tam bu tekeli
 * kırmak için var; taze bir cross selinin aynı tekeli geri getirmesi kotanın
 * varlık sebebini delmek olurdu.
 *
 * Doğru yapı, kotayı sıralamadan ÇIKARMAK: bütçe önce yüzeylere bölünür
 * (rezervasyon), her rezerv yalnız kendi yüzeyinin kuyruğundan dolar, kimsenin
 * kullanmadığı rezerv havuza döner. Böylece bir yüzeyin aday sayısı ne kadar
 * şişerse şişsin diğerlerinin tabanına dokunamaz.
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
 * ### Kapsama sınırı — REZERVASYONLA DEĞİŞTİ, yeniden ölçüldü
 * Bu satırlara üç kuşak boyunca üç ayrı sınır yazıldı (E: küresel ⌈N/max⌉,
 * F: yüzey başına ⌈N_yüzey/kota⌉, G: ölçümle yine küresel ⌈N/max⌉ ve "TAM").
 * H dalgası kotayı sıralamadan çıkarıp rezervasyona çevirince G'nin ölçtüğü
 * sınır GEÇERSİZLEŞTİ; aşağıdakiler yeniden ölçülmüş değerlerdir
 * (12 Ağu 2026, 450 + 51 yapılandırma; bütçe 1–25 × rastgele yüzey dağılımları).
 *
 * 1. **⌈N/max⌉ artık bir ÜST SINIR DEĞİL, yalnız alt sınır.** Koşum başına en
 *    çok `max` aday seçildiği için altta kalır, ama ölçümde 450 yapılandırmanın
 *    **346'sında aşıldı**. Somut: 20/20/20 aday, max=20 → G'nin sınırı 3 diyor,
 *    gerçek **4**. Sebep yapısal ve kabul edilmiş bir bedel: koşum başına yüzey
 *    tabanı garanti edilince, bir yüzeyin ölçülmemiş adayı biterken rezervi
 *    zaten ölçülmüş adayına gidebiliyor. Taban ile "ölçülmemiş bekliyorken
 *    yeniden ölçüm yapma" kuralı GENEL OLARAK BAĞDAŞMAZ; kotanın ölçülmüş
 *    varlık sebebi (yukarıdaki 20/20 cross, 0 çelişki) tabanı seçtiriyor.
 * 2. **Σrezerv ≤ bütçe iken** (normal çalışma: 8+6+6 = 20 = MAX_CLASSIFY_ITEMS)
 *    ölçülen üst sınır `max(⌈N/max⌉, maks_yüzey ⌈N_yüzey / rezerv_yüzey⌉)` —
 *    402 yapılandırmanın **402'sinde tuttu**, 105'inde TAM, kalanında gevşek
 *    (artık turu yardım ettiği için; ör. 21 cross / max 20 → ifade 3, gerçek 2).
 * 3. **Σrezerv > bütçe iken** (bütçe aktif yüzey sayısının altında) kapalı bir
 *    formül ÖLÇÜLMEDİ. Bu rejimde 51 yapılandırmada kapsama sonlu çıktı ve
 *    hepsinde `N`'i aşmadı, ama bu ölçülmüş bir gözlem, ispatlanmış bir sınır
 *    değil.
 * 4. **Açlık yok:** ölçülen 501 yapılandırmanın hiçbirinde kapsama sonsuz
 *    değil — her aday sonlu koşumda ölçülüyor.
 *
 * Bu projede yanlış yazılmış bir iddia yazılmamış olmasından kötüdür: yukarıda
 * ölçülmeyen tek şey (3) ve orada "ölçülmedi" yazıyor.
 *
 * ### Yüzey İÇİ sel — KAPANDI (M4.5)
 * Rezervasyon yüzeyler ARASI tekeli kapatıyordu, yüzey İÇİNDEKİNİ değil: bir
 * yüzeye her koşum rezervinden fazla TAZE aday girdiğinde, damga 0'ın mutlak
 * önceliği yüzünden o yüzeyin ölçülmüş adayları süresiz bekliyordu (altıncı
 * biçim). Kapanış, mutlak önceliği İLK-GÖRÜLME damgasıyla değiştirmek:
 * "hiç ölçülmemiş" artık sonsuz yaş değil, sıraya girdiği koşumun yaşı. Öncelik
 * anahtarı bu yüzden `seçildiyse seçim damgası, seçilmediyse ilk-görülme
 * damgası`; eşitlikte hiç seçilmemiş olan önde (ölçüm borcu daha büyük).
 *
 * Sabit bir "taze yaşı" ile yaşlandırmak REDDEDİLDİ, çünkü açlığı yalnız yön
 * değiştiriyordu: aday sayısı bütçenin (yaş+1) katını aştığında ölçülmüş
 * adayların yaşı o sabiti kalıcı olarak geçiyor ve bu kez hiç ölçülmemiş aday
 * sonsuza kadar bekliyordu. İlk-görülmede iki yön de sınırlı — anahtar yalnız
 * seçimle büyüyor, ve yeni giren aday daima BEKLEYENİN ARKASINA yazılıyor.
 *
 * Bedeli: satır artık yalnız SEÇİLEN için değil GÖRÜLEN her aday için yazılıyor.
 * Sınır aynı budamayla korunuyor (store/classify-stamps.ts) ve büyüklük
 * mertebesi zaten her koşum bellekte kurulan aday listesinin kendisi.
 */
export function selectCandidates(
  candidates: Candidate[],
  max: number,
  stamps: CandidateStamps = {},
  /**
   * Aday kimliği → ilk görüldüğü koşumun damgası. VERİLMEZSE ilk-görülme hiç
   * izlenmiyor demektir ve girişi olmayan aday eski davranışa düşer: yaş 0,
   * yani mutlak öncelik. Verilirse (boş nesne dahil) girişi olmayan aday BU
   * koşumda sıraya girmiş sayılır, yani kuyruğun SONUNA yazılır — kapatılan
   * açlığın taşıyıcısı tam olarak bu ayrım.
   */
  seen?: CandidateStamps,
): CandidateSelection {
  const tracking = seen !== undefined;
  // Kota MAX_CLASSIFY_ITEMS ölçeğinde tanımlı; farklı bir tavanla çağrılırsa
  // (audit --max-classify-items) oranı korunur. En az 1: küçük bir tavanda bile
  // hiçbir yüzey tümden kapanmasın (G dalgasının kapattığı küçük-bütçe tekeli).
  const quota = (k: Candidate["kind"]) =>
    Math.max(1, Math.floor((max * CLASSIFY_SURFACE_QUOTA[k]) / MAX_CLASSIFY_ITEMS));

  // Sayaç taşma eşiğindeyse haritalar sırayı koruyarak sıkıştırılır; seçim
  // etkilenmez (sıralama birebir aynı), yalnız sayılar küçülür.
  let highest = 0;
  for (const m of [stamps, seen ?? {}]) for (const v of Object.values(m)) {
    const n = normalizeStamp(v);
    if (n > highest) highest = n;
  }
  const renumbered = !Number.isSafeInteger(highest + 1);
  let base: Record<string, number> = { ...stamps };
  let seenBase: Record<string, number> = { ...seen };
  /** İlk kez görülen adayın yaşı: izleniyorsa "şimdi", izlenmiyorsa "en eski". */
  let stamp = highest + 1;
  if (renumbered) {
    const c = compressStamps([base, seenBase]);
    [base, seenBase] = c.maps as [Record<string, number>, Record<string, number>];
    stamp = c.stamp;
  }

  const stampOf = new Map<number, number>();
  const seenOf = new Map<number, number>();
  for (const [i, c] of candidates.entries()) {
    const key = candidateIdentity(c);
    stampOf.set(i, normalizeStamp(base[key]));
    seenOf.set(i, normalizeStamp(seenBase[key]));
  }
  /** Bekleme yaşı: seçilmişse seçim damgası, seçilmemişse sıraya giriş damgası. */
  const ageKey = (i: number) => {
    const s = stampOf.get(i)!;
    if (s > 0) return s;
    const seenAt = seenOf.get(i)!;
    return seenAt > 0 ? seenAt : (tracking ? stamp : 0);
  };

  /** KÜRESEL öncelik: önce yaş (eski → yeni), sonra ölçüm borcu, sonra kimlik. */
  const byPriority = (x: number, y: number) => {
    const d = ageKey(x) - ageKey(y);
    if (d !== 0) return d;
    // Aynı koşumdan gelen iki aday: hiç seçilmemiş olan önce. Aksi hâlde aynı
    // koşumda ilk kez görülen bir aday, o koşumda ÖLÇÜLMÜŞ bir adayla eşit
    // sayılırdı ve kimlik sırası ölçüm borcunun önüne geçerdi.
    const n = (stampOf.get(x)! > 0 ? 1 : 0) - (stampOf.get(y)! > 0 ? 1 : 0);
    return n !== 0 ? n : byIdentity(candidates[x]!, candidates[y]!);
  };

  // Her yüzeyin KENDİ öncelik kuyruğu: rezerv başka hiçbir yüzeyin adayından
  // dolamaz — kotanın sıralamadan çıkarılması pratikte bu ayrı kuyruk demek.
  const queue = new Map<Candidate["kind"], number[]>(SURFACE_ORDER.map((k) => [k, []]));
  for (const [i, c] of candidates.entries()) queue.get(c.kind)?.push(i);
  for (const q of queue.values()) q.sort(byPriority);

  const chosen = new Set<number>();
  let budget = max;

  // (1) REZERVASYON TURU. Rezerv = min(kota, o yüzeyin aday sayısı); adayı
  // kotasından az olan yüzeyin fazlası kullanılmadan kalır ve (2)'de havuza
  // döner, yani taban asla bütçe İSRAFINA dönüşmez.
  //
  // Rezervler arasındaki DOLDURMA sırası küresel öncelik: her adımda, rezervi
  // kalan yüzeyler içinde kuyruk başı en eski olan alınır. İki sonucu var:
  //  - Σrezerv ≤ bütçe iken sıra sonucu değiştirmez, herkes tabanını alır.
  //  - Σrezerv > bütçe iken (küçük bütçe: max < aktif yüzey sayısı) seçim tam
  //    olarak küresel damga sırasına düşer — G dalgasının düzeltmesi aynen
  //    korunuyor, çünkü kuyrukların önceliğe göre birleştirilmesi küresel
  //    sıranın ta kendisi.
  const head = new Map<Candidate["kind"], number>(SURFACE_ORDER.map((k) => [k, 0]));
  const reserve = new Map<Candidate["kind"], number>(
    SURFACE_ORDER.map((k) => [k, Math.min(quota(k), queue.get(k)!.length)]),
  );
  while (budget > 0) {
    let best: Candidate["kind"] | null = null;
    for (const k of SURFACE_ORDER) {
      if (reserve.get(k)! <= 0 || head.get(k)! >= queue.get(k)!.length) continue;
      if (best === null || byPriority(queue.get(k)![head.get(k)!]!, queue.get(best)![head.get(best)!]!) < 0)
        best = k;
    }
    if (best === null) break;
    const h = head.get(best)!;
    chosen.add(queue.get(best)![h]!);
    head.set(best, h + 1);
    reserve.set(best, reserve.get(best)! - 1);
    budget--;
  }

  // (2) ARTIK TURU: kullanılmayan rezervler + kotaların üstündeki bütçe, kalan
  // TÜM adaylar arasında küresel öncelikle dağılır. Yüzeyler burada yarışabilir,
  // çünkü taban (1)'de zaten garanti edildi.
  if (budget > 0) {
    for (const p of candidates.map((_, i) => i).filter((i) => !chosen.has(i)).sort(byPriority)) {
      if (budget === 0) break;
      chosen.add(p);
      budget--;
    }
  }

  // Bu koşumun adaylarında OLMAYAN kimliklerin damgası korunuyor: aday kümesi
  // churn ile daralıp genişliyor ve geri dönen bir aday sırasını kaybetmemeli.
  // Sınırsız büyümenin cevabı budama; store/classify-stamps.ts'te, gerekçesiyle.
  const next: Record<string, number> = base;
  for (const p of chosen) next[candidateIdentity(candidates[p]!)] = stamp;
  // İlk-görülme YALNIZ yoksa yazılır: var olan giriş adayın sıradaki yerini
  // taşıyor ve tazelenmesi onu kuyruğun sonuna atardı — kapatılan açlığın
  // kendisi.
  const nextSeen: Record<string, number> = seenBase;
  for (const c of candidates) {
    const key = candidateIdentity(c);
    if (normalizeStamp(nextSeen[key]) === 0) nextSeen[key] = stamp;
  }

  return { taken: candidates.filter((_, i2) => chosen.has(i2)), next, nextSeen, stamp, renumbered };
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

/**
 * Kaç TAM rotasyon turu beklemiş bir aday "aç" sayılır. Bir tam tur
 * `ceil(aday / bütçe)` koşum sürüyor, yani eşik depo büyüklüğüyle birlikte
 * ölçekleniyor — sabit bir koşum sayısı 30 adaylı bir depoda hiç ateşlenmez,
 * 3.000 adaylıda her koşum ateşlenirdi. 3 tur: bir turluk gecikme rotasyonun
 * normal işleyişi, üç tur ise sıranın o adaya uğramadığı anlamına geliyor.
 */
const STARVATION_ROTATIONS = 3;

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
   * Prompt'a GİRDİ, hüküm dönmedi (ya da ölçüm hiç yapılamadı). Gerçek bir ölçüm
   * arızası: `audit.ts` bununla notun önceki hükmünü KORUR ve kullanıcıya bir
   * `olculemez` kaydı açar.
   *
   * Eskiden bu alan `unmeasured` adıyla `starved` ile BİRLEŞİKTİ, ve birleşiklik
   * bir buga mal oldu: kapsama yüzeyinde her not her koşum aday olduğu için
   * "sırası gelmedi" korumaya girseydi tek bir sınıflama arızası projedeki tüm
   * suspect kayıtlarını dondururdu. Kaçınmak için kapsama adayları topluca
   * korumadan çıkarılmıştı — bu sefer de gerçekten cevapsız kalan kapsama
   * adayları sessizce aklanıyordu (ölçüldü: probe `coverage-clear-1.sh`,
   * `run1: suspect/0.7` → `run2: active/0`). Ayrım ikisini de çözüyor.
   */
  undecided: Candidate[];
  /**
   * Bütçeye hiç girmedi: rotasyonda sırası gelmedi. Bir ölçüm arızası DEĞİL —
   * rotasyon bir sinyal değil bir SIRA, ve sırası gelmemiş olmak notların normal
   * hâli. Hükmü korumaz, kuyruğa girmez. Yalnız AÇLIK ölçümünün girdisi.
   */
  starved: Candidate[];
  /**
   * `starved`in, beklemesi bir tam rotasyon turunun katlarını aşmış alt kümesi —
   * yani rotasyonun kendisinin adil olmadığı adaylar. Eşik aday sayısına göre
   * türetiliyor (bkz. STARVATION_ROTATIONS), sabit bir sayı değil: sabit eşik
   * küçük bir depoda hiç ateşlenmez, büyüğünde sürekli ateşlenirdi.
   */
  starvedLong: Candidate[];
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
  /** Aday kimliği → ilk görüldüğü koşum (bkz. CandidateSelection.nextSeen). */
  nextSeen: Record<string, number>;
  /** Damgalar sıkıştırıldı: depoya `stamp` değerli satırlar değil TAMAMI gider. */
  renumbered: boolean;
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
    if (it.kind === "coverage")
      return `#${it.index} [kapsama ölçümü — not ↔ bugünkü depo, ${reason}]\n` +
        `${fenceUntrusted(`#${it.index} not`, clip(it.aText))}`;
    return `#${it.index} [not-içi]\n${fenceUntrusted(`#${it.index} metin`, clip(it.aText))}`;
  }).join("\n\n");

  // Kapsama kuralı YALNIZ o yüzey varken ekleniyor: çelişki-only bir koşumun
  // prompt'u böylece bayt bayt eskisiyle aynı kalıyor, yani rotasyon ölçümün
  // kendisini değiştirmiyor.
  const coverageRule = items.some((it) => it.kind === "coverage")
    ? `
"kapsama ölçümü" blokları tek not içerir ve karşı taraf DEPONUN KENDİSİDİR:
notu bugünkü dosyalarla ve \`git log\` ile karşılaştır, kendi belleğinle değil.
- "celiski": notun somut bir iddiası bugünkü depoda TUTMUYOR.
- "uyumlu": iddialar bugün de doğru.
- "kararsiz": iddia ölçülebilir değil ya da ölçmek için gereken şey yok.
`
    : "";

  return `Aşağıda numaralı adaylar var. Her aday için görev bir ÖLÇÜM: verilen iki metin
(ya da tek metnin parçaları) aynı konu hakkında birbiriyle ÇELİŞİYOR MU?

- "celiski": iki ifade aynı anda doğru olamaz.
- "uyumlu": çelişki yok ya da farklı şeylerden bahsediyorlar.
- "kararsiz": metinden karar verilemiyor.
${coverageRule}
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
  /**
   * `cwd`: alt sürecin çalışma kökü. Verilmezse ajan, CLI'nin başlatıldığı
   * yerin cwd'sini miras alır — denetlenen proje ile ajanın durduğu dizin
   * ayrışır. SINIR: bu bir okuma hapsi DEĞİL; codex 0.146.0'ın `exec --help`
   * çıktısında depo dışını okumayı kesen bayrak yok (lane ölçtü, 14 Ağu),
   * `-C` yalnız kökü seçer.
   */
  opts: { maxItems?: number; stamps?: CandidateStamps; seen?: CandidateStamps; cwd?: string } = {},
): Promise<ClassifyResult> {
  const max = opts.maxItems ?? MAX_CLASSIFY_ITEMS;
  const {
    taken, next: nextStamps, nextSeen, stamp: rotationStamp, renumbered,
  } = selectCandidates(candidates, max, opts.stamps, opts.seen);
  const dropped = candidates.length - taken.length;
  const takenSet = new Set(taken);
  /** Bütçeye hiç girmemiş aday: ölçülmedi, ama ölçülmesi de SIRADA değildi. */
  const starved = candidates.filter((c) => !takenSet.has(c));

  // Beklemesi bir tam turun STARVATION_ROTATIONS katını aşanlar. Damgalar
  // sıkıştırıldıysa (`renumbered`) ölçüm ATLANIYOR: eldeki `opts.stamps`
  // sıkıştırma ÖNCESİ ölçekte, `rotationStamp` sonrasında, ve iki ölçeği
  // çıkarmak anlamsız bir sayı üretir. Sıkıştırma sayaç taşmasında olur, yani
  // pratikte hiç; bir koşumluk kör nokta, yanlış bir açlık alarmından ucuz.
  const stampsIn = opts.stamps ?? {};
  const seenIn = opts.seen ?? {};
  const threshold = Math.max(1, Math.ceil(candidates.length / max)) * STARVATION_ROTATIONS;
  const starvedLong = renumbered ? [] : starved.filter((c) => {
    const key = candidateIdentity(c);
    // Hiç seçilmemişse sıraya giriş damgası, o da yoksa bu koşumda girdi (0 bekleme).
    const last = normalizeStamp(stampsIn[key]) || normalizeStamp(seenIn[key]) || rotationStamp;
    return rotationStamp - last >= threshold;
  });

  if (taken.length === 0)
    return {
      ok: true, confirmed: [], kararsiz: 0, unclassified: 0,
      undecided: [], starved, starvedLong,
      measured: [], nextStamps, nextSeen, renumbered, rotationStamp, calls: 0, dropped,
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
    return executor.run({ prompt: p, outputSchema: CLASSIFY_OUTPUT_SCHEMA, cwd: opts.cwd });
  };

  // Ölçüm HİÇ yapılamadı. Gösterilenlerin tamamı cevapsız (`undecided`);
  // bütçeye girmeyenler yine yalnız `starved` — arıza onların sırasını
  // değiştirmedi, ve onları da korumaya almak tek bir yürütücü çökmesinde
  // projedeki tüm suspect kayıtlarını dondurmak demekti.
  const failed = (error: string): ClassifyResult => ({
    ok: false, confirmed: [], kararsiz: 0, unclassified: taken.length,
    undecided: taken, starved, starvedLong,
    measured: [], nextStamps, nextSeen, renumbered, rotationStamp, calls, dropped, error,
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
    undecided, starved, starvedLong,
    measured: taken.filter((_, i) => decided.has(i)),
    nextStamps, nextSeen, renumbered, rotationStamp, calls, dropped,
  };
}
