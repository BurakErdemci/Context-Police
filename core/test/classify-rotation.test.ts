// Aday rotasyonunun ADALETİ — F dalgası (12 Ağu 2026), üçüncü kuşak.
//
// Kök değişikliği: rotasyon durumu artık ADAY KİMLİĞİNE bağlı bir damga.
// Önceki iki kuşak da SABİT bir aday listesi üzerinde adildi ve churn ile
// kırıldı (D: not başına damga → K7'de aç kalan çift; E: konumsal imleç →
// probe candidate-churn-coverage-bound, 6 koşum boyunca sabit çift atlandı).
// Bu yüzden buradaki kabul ölçütü SABİT LİSTE DEĞİL, CHURN ALTINDA adalet.
//
// Testlerin iddiası "artık olmuyor" DEĞİL "olamaz": seçilmeyen aday her zaman
// seçilenden daha eski damga taşır, dolayısıyla sonraki koşumda öne geçer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { appendFinding, getFinding, listActive, supersede } from "../src/store/findings.ts";
import { readClassifyStamps, writeClassifyStamps } from "../src/store/classify-stamps.ts";
import { auditProject } from "../src/audit.ts";
import {
  selectCandidates, candidateIdentity, parseCandidateIdentity,
  CLASSIFY_SURFACE_QUOTA, MAX_CLASSIFY_ITEMS, type CandidateStamps,
} from "../src/signals/classify.ts";
import type { Candidate } from "../src/signals/contradiction.ts";
import { tmpDir, tmpStorePath, fakeExecutor } from "./helpers.ts";

const cand = (aId: number, bId: number | null, kind: Candidate["kind"] = "cross"): Candidate =>
  ({ kind, aId, bId, reason: "test" });

/** Yüzeyin bir koşumda garanti aldığı pay — kapsama sınırının paydası. */
const quotaOf = (k: Candidate["kind"], max = MAX_CLASSIFY_ITEMS) =>
  Math.max(1, Math.floor((max * CLASSIFY_SURFACE_QUOTA[k]) / MAX_CLASSIFY_ITEMS));

/**
 * ⌈N_toplam / max⌉ — koşum başına en çok `max` aday seçildiği için kapsamanın
 * ALT sınırı. G dalgasında bu aynı zamanda TAM sınırdı; H dalgasının rezervasyonu
 * onu geçersiz kıldı (bkz. aşağıdaki grid testi): artık bir üst sınır DEĞİL.
 */
function globalFloor(candidates: Candidate[], max = MAX_CLASSIFY_ITEMS): number {
  return Math.ceil(candidates.length / max);
}

/** Bir yüzeyin koşum başına garantili payı: min(kota, o yüzeyin aday sayısı). */
function reserveOf(candidates: Candidate[], k: Candidate["kind"], max: number): number {
  return Math.min(quotaOf(k, max), candidates.filter((c) => c.kind === k).length);
}

/**
 * Rezervasyon rejiminde ÖLÇÜLEN üst sınır — yalnız Σrezerv ≤ bütçe ön koşulunda
 * geçerli (12 Ağu 2026: 402/402 yapılandırmada tuttu, 105'inde TAM).
 */
function reservationBound(candidates: Candidate[], max = MAX_CLASSIFY_ITEMS): number {
  let per = 0;
  for (const k of ["cross", "intra", "frontmatter"] as const) {
    const n = candidates.filter((c) => c.kind === k).length;
    if (n > 0) per = Math.max(per, Math.ceil(n / reserveOf(candidates, k, max)));
  }
  return Math.max(globalFloor(candidates, max), per);
}

/** Her adayın ölçülmesi GERÇEKTE kaç koşum sürdü — sınırın TAM olduğu iddiası. */
function runsToCover(candidates: Candidate[], max: number, cap = 200): number {
  const seen = new Set<string>();
  let stamps: CandidateStamps = {};
  for (let run = 1; run <= cap; run++) {
    const { taken, next } = selectCandidates(candidates, max, stamps);
    stamps = next;
    for (const c of taken) seen.add(candidateIdentity(c));
    if (seen.size === candidates.length) return run;
  }
  return Infinity;
}

/**
 * Rotasyonu `runs` koşum boyunca sürer (damgaları koşumdan koşuma taşıyarak) ve
 * her adayın İLK seçildiği koşumu döndürür. `feed` verilirse aday listesi her
 * koşumda yeniden üretilir — CHURN testlerinin girdisi budur.
 */
function rotate(
  feed: Candidate[] | ((run: number) => Candidate[]),
  max: number, runs: number, start: CandidateStamps = {},
) {
  const firstSeen = new Map<string, number>();
  const perRun: Candidate[][] = [];
  let stamps: CandidateStamps = start;
  for (let run = 1; run <= runs; run++) {
    const candidates = typeof feed === "function" ? feed(run) : feed;
    const { taken, next } = selectCandidates(candidates, max, stamps);
    stamps = next;
    perRun.push(taken);
    for (const c of taken) if (!firstSeen.has(candidateIdentity(c))) firstSeen.set(candidateIdentity(c), run);
  }
  return { firstSeen, perRun, stamps };
}

/** Kapsanmayan adayları ada dökerek raporlar — "hangisi aç kaldı" görünsün. */
function missing(candidates: Candidate[], firstSeen: Map<string, number>): string[] {
  return candidates.map(candidateIdentity).filter((k) => !firstSeen.has(k));
}

// --- 1. sabit liste: gerçek kapsama sınırı ---------------------------------

/** Her ikilisi ayrı bir çapa paylaşan 7 not → 21 aday (K7 grafiğinin kenarları). */
function k7(): Candidate[] {
  const out: Candidate[] = [];
  for (let a = 1; a <= 7; a++) for (let b = a + 1; b <= 7; b++) out.push(cand(a, b));
  return out;
}

test("K7 (21 aday, tavan 20): aç kalan çift sınır içinde ölçülüyor", () => {
  const candidates = k7();
  const bound = globalFloor(candidates); // ⌈21/20⌉ = 2
  assert.equal(bound, 2);
  // Tek yüzeyli küme: rezervasyon burada bir no-op (artık turu bütçenin kalanını
  // aynı yüzeye geri veriyor), o yüzden kapsama alt sınıra oturuyor. Rezervasyon
  // ifadesi ise burada GEVŞEK: max(2, ⌈21/8⌉) = 3 der, gerçek 2.
  assert.equal(runsToCover(candidates, 20), bound, "tek yüzeyde kapsama alt sınıra oturmadı");
  assert.ok(reservationBound(candidates) >= bound, "üst sınır alt sınırın altına düştü");
  const { firstSeen } = rotate(candidates, 20, bound);
  assert.deepEqual(missing(candidates, firstSeen), [], "sınırda kapsanmayan aday var");
  // D dalgasının probe'u 8 koşum sürüyordu ve 6-7 çifti sekizinde de atlanmıştı.
  const uzun = rotate(candidates, 20, 8);
  assert.ok(Math.max(...uzun.firstSeen.values()) <= bound, "bir aday sınırdan geç ölçüldü");
});

/** 20/20/20 — üç yüzey eşit dolu, sınır iddialarının ayrıştığı yer. */
const mixed6060 = (): Candidate[] => [
  ...Array.from({ length: 20 }, (_, i) => cand(i + 1, i + 101, "cross")),
  ...Array.from({ length: 20 }, (_, i) => cand(i + 301, null, "intra")),
  ...Array.from({ length: 20 }, (_, i) => cand(i + 601, null, "frontmatter")),
];

test("H: rezervasyon kapsama sınırını DEĞİŞTİRDİ — 20/20/20 artık 3 değil 4 koşum", () => {
  // G dalgasının ölçtüğü "⌈N/max⌉ TAM" iddiası rezervasyonla GEÇERSİZLEŞTİ, ve
  // bu bir gerileme değil ÖDENEN BEDEL: koşum başına yüzey tabanı garanti
  // edildiği anda, bir yüzeyin ölçülmemiş adayı biterken rezervi zaten ölçülmüş
  // adayına gidebiliyor. 3. koşumda cross'un yalnız 4 ölçülmemiş adayı kalıyor
  // ama rezervi 8; kalan 4 slot intra/frontmatter'a GEÇMİYOR, çünkü geçseydi
  // taban da geçebilir olurdu — probe'un ölçtüğü açlık tam olarak buydu.
  const candidates = mixed6060();
  assert.equal(globalFloor(candidates), 3, "alt sınır değişmiş, test bayat");
  assert.equal(runsToCover(candidates, 20), 4, "ölçülen kapsama değişti — sınır iddiası bayat");
  assert.equal(reservationBound(candidates), 4, "rezervasyon ifadesi burada TAM olmalıydı");
  const { firstSeen } = rotate(candidates, 20, 4);
  assert.deepEqual(missing(candidates, firstSeen), [], "ölçülen sınırda bile kapsanmayan aday var");
  // Ve alt sınır gerçekten AŞILIYOR: ⌈N/max⌉ artık bir güvence değil.
  assert.ok(runsToCover(candidates, 20) > globalFloor(candidates),
    "⌈N/max⌉ hâlâ tutuyorsa yukarıdaki tüm gerekçe yanlış yazılmış");
});

test("H: kapsama sınırı GRID'i — iddia ölçümle yazıldı, 30 yapılandırma", () => {
  // G dalgasının yöntemi (30 yapılandırma) rezervasyon rejiminde tekrarlandı.
  // İki ölçülmüş iddia çivileniyor:
  //   (1) ⌈N/max⌉ artık ÜST SINIR DEĞİL — en az bir yapılandırmada aşılıyor.
  //   (2) Σrezerv ≤ bütçe ön koşulunda max(⌈N/max⌉, maks ⌈N_yüzey/rezerv⌉) tutuyor.
  // Σrezerv > bütçe rejimi için kapalı formül ÖLÇÜLMEDİ; oradaki tek ölçülmüş
  // gözlem kapsamanın sonlu olduğu (aşağıda `Infinity` olmadığı da sınanıyor).
  const dists: [number, number, number][] = [
    [20, 20, 20], [30, 20, 20], [60, 0, 0], [21, 0, 0], [0, 0, 25], [40, 5, 5],
  ];
  const build = ([nc, ni, nf]: [number, number, number]) => [
    ...Array.from({ length: nc }, (_, i) => cand(i + 1, 1000 + i, "cross")),
    ...Array.from({ length: ni }, (_, i) => cand(3000 + i, null, "intra")),
    ...Array.from({ length: nf }, (_, i) => cand(6000 + i, null, "frontmatter")),
  ];
  let floorExceeded = 0, fitChecked = 0;
  for (const d of dists) for (const max of [1, 2, 3, 5, 20]) {
    const candidates = build(d);
    const actual = runsToCover(candidates, max, 500);
    assert.ok(Number.isFinite(actual), `açlık: ${d.join("/")} @ ${max} kapanmadı`);
    if (actual > globalFloor(candidates, max)) floorExceeded++;
    const sumReserve = (["cross", "intra", "frontmatter"] as const)
      .reduce((s, k) => s + reserveOf(candidates, k, max), 0);
    if (sumReserve <= max) {
      fitChecked++;
      assert.ok(actual <= reservationBound(candidates, max),
        `${d.join("/")} @ ${max}: ölçülen ${actual} > ifade ${reservationBound(candidates, max)}`);
    }
  }
  assert.ok(floorExceeded > 0, "⌈N/max⌉ hiç aşılmadıysa 'üst sınır değil' iddiası yanlış yazılmış");
  assert.ok(fitChecked >= 10, `ön koşulu sağlayan yapılandırma az (${fitChecked}): grid iddiayı taşımıyor`);
});

test("çürütme: yüzey başına ⌈N_yüzey/kota⌉ iddiası bütçe < yüzey sayısı iken İHLAL ediliyor", () => {
  // G dalgasının doğrudan sorusu. Bütçe 1 iken her yüzeyin kotası max(1, …) = 1'e
  // düşüyor, yani kotaların TOPLAMI (3) bütçeyi (1) aşıyor ve yüzey kotası artık
  // koşum başına bir güvence VERMİYOR. Yüzey ifadesi "20" derdi; gerçek 60.
  const candidates = mixed6060();
  const perSurface = Math.max(...(["cross", "intra", "frontmatter"] as const)
    .map((k) => Math.ceil(20 / quotaOf(k, 1))));
  assert.equal(perSurface, 20, "çürütülen ifade değişmiş, test bayat");
  assert.equal(runsToCover(candidates, 1), 60, "bütçe 1'de kapanma ölçülen değerden saptı");
  // Bütçe 1'de alt sınır ile ölçülen değer ÇAKIŞIYOR (koşum başına tam 1 aday, hiç
  // yeniden ölçüm yok). Bu çakışma bütçe 1'e özgü; H dalgası ⌈N/max⌉'in genel bir
  // üst sınır OLMADIĞINI ölçtü — yukarıdaki grid testi.
  assert.equal(globalFloor(candidates, 1), 60, "bütçe 1'de alt sınır ⌈60/1⌉ olmalıydı");
  assert.ok(perSurface < 60, "yüzey ifadesi burada FAZLA KÜÇÜK: ihlal edilebilir bir güvence");
});

test("kota, koşum içi bir taban — ama yalnız kotaların toplamı bütçeye sığarken", () => {
  // Kotanın gerçek sözleşmesi bu: koşum İÇİNDEKİ payı böler, kaç koşum
  // gerektiğini değil. Sözleşme ancak Σkota ≤ bütçe iken uygulanabilir.
  const candidates = mixed6060();
  const kinds = ["cross", "intra", "frontmatter"] as const;
  for (const max of [20, 15]) {
    const sumQuota = kinds.reduce((s, k) => s + quotaOf(k, max), 0);
    assert.ok(sumQuota <= max, `ön koşul tutmuyor (max=${max}, Σkota=${sumQuota})`);
    const { taken } = selectCandidates(candidates, max, {});
    for (const k of kinds)
      assert.ok(taken.filter((c) => c.kind === k).length >= quotaOf(k, max), `${k} payını alamadı`);
  }
  // Ve ön koşul tutmadığında kota bir taban DEĞİL: bütçe tek yüzeye gider.
  assert.equal(kinds.reduce((s, k) => s + quotaOf(k, 1), 0), 3, "Σkota bütçeyi aşmıyor sanıldı");
  assert.equal(selectCandidates(candidates, 1, {}).taken.length, 1);
});

test("varyant (yıldız grafiği): merkez not her çiftte, uçlar aç kalmıyor", () => {
  const candidates = Array.from({ length: 24 }, (_, i) => cand(1, i + 2));
  const { firstSeen } = rotate(candidates, 20, globalFloor(candidates));
  assert.deepEqual(missing(candidates, firstSeen), [], "yıldızın uçları aç kaldı");
});

test("varyant (yüzeyler karışık): kota rotasyonu EZMİYOR, ikisi birden geçerli", () => {
  const candidates = [
    ...Array.from({ length: 30 }, (_, i) => cand(i + 1, 200 + i)),
    ...Array.from({ length: 20 }, (_, i) => cand(300 + i, null, "intra")),
    ...Array.from({ length: 20 }, (_, i) => cand(400 + i, null, "frontmatter")),
  ];
  const bound = globalFloor(candidates); // ⌈70/20⌉ = 4
  assert.equal(bound, 4);
  const { firstSeen, perRun } = rotate(candidates, 20, bound);
  assert.deepEqual(missing(candidates, firstSeen), [], "karışık yüzeyde aç kalan aday var");
  for (const taken of perRun) {
    assert.equal(taken.length, 20, "bütçe boşa gitti");
    for (const kind of ["cross", "intra", "frontmatter"] as const)
      assert.ok(taken.filter((c) => c.kind === kind).length >= quotaOf(kind), `${kind} payını alamadı`);
  }
});

test("varyant: yüzey kotası rotasyonun ÜSTÜNDE kalır (cross seli intra'yı yutamaz)", () => {
  const candidates: Candidate[] = [
    ...Array.from({ length: 20 }, (_, i) => cand(i + 1, 100 + i)),
    cand(90, null, "intra"), cand(91, null, "intra"),
  ];
  // cross'un tamamı bir kez ölçülmüş, intra hiç: kota olmasa bile damga sırası
  // intra'yı öne alır — burada ölçülen, kotanın ayrıca bir taban olduğu.
  const stamps: Record<string, number> = {};
  for (const c of candidates) if (c.kind === "cross") stamps[candidateIdentity(c)] = 1;
  const { taken } = selectCandidates(candidates, 20, stamps);
  assert.equal(taken.filter((c) => c.kind === "intra").length, 2, "kota rotasyona feda edildi");
});

test("varyant: aday sayısı tavanın altında — rotasyon hiçbir şeyi değiştirmiyor", () => {
  const few = [cand(1, 11), cand(2, 12, "intra")];
  const { taken } = selectCandidates(few, 20, { [candidateIdentity(few[0]!)]: 5 });
  assert.deepEqual(taken, few);
});

test("seçim, prompt için özgün sırayı korur (damga sırayı DEĞİL seçimi belirler)", () => {
  const candidates = Array.from({ length: 5 }, (_, i) => cand(i + 1, 100 + i));
  // 1,2,3 ölçülmüş; 4 ve 5 hiç. Tavan 3 → 4, 5 ve en eski olan 1 gelir.
  const stamps = { [candidateIdentity(candidates[0]!)]: 1, [candidateIdentity(candidates[1]!)]: 2,
    [candidateIdentity(candidates[2]!)]: 2 };
  const { taken } = selectCandidates(candidates, 3, stamps);
  assert.deepEqual(taken.map((c) => c.aId), [1, 4, 5], "çıktı sırası özgün sıradan koptu");
});

test("depodan gelen bozuk damga seçimi kilitlemiyor (negatif, kesirli, NaN, taşkın)", () => {
  const candidates = k7();
  const bound = globalFloor(candidates);
  for (const bozuk of [-7, 1.9, 1e18, Number.NaN, Number.POSITIVE_INFINITY]) {
    const stamps: Record<string, number> = {};
    for (const c of candidates) stamps[candidateIdentity(c)] = bozuk;
    const { firstSeen } = rotate(candidates, 20, bound, stamps);
    assert.deepEqual(missing(candidates, firstSeen), [], `bozuk damga (${bozuk}) aday aç bıraktı`);
  }
});

// --- 2. ASIL TEST: adalet CHURN ALTINDA ------------------------------------

test("churn: sabit çift, konumu her koşumda kayarken en geç 2 koşumda seçiliyor", () => {
  // probes/candidate-churn-coverage-bound.sh deseninin terfisi. Konumsal
  // imleçte (E dalgası) sabit çift 6 koşum / 2 tam periyot boyunca HİÇ
  // seçilmiyordu: pencere ilerlerken çift de kayıyor ve hep pencerenin
  // arkasına düşüyordu. Kimlik tabanında konum ilgisiz.
  const stable = cand(50, 60);
  const cycle = [
    [cand(10, 20), cand(30, 40), stable],
    [cand(30, 40), stable, cand(70, 80)],
    [stable, cand(70, 80), cand(90, 100)],
  ];
  const { firstSeen, perRun } = rotate((run) => cycle[(run - 1) % 3]!, 2, 6);
  for (const taken of perRun) assert.equal(taken.length, 2, "üç adayın ikisi seçilmedi");
  assert.ok(
    (firstSeen.get(candidateIdentity(stable)) ?? Infinity) <= 2,
    `sabit çift geç seçildi: ${firstSeen.get(candidateIdentity(stable))}`,
  );
});

test("churn: aday kümesi 20 koşum boyunca rastgele değişirken kalıcı aday atlanmıyor", () => {
  // Sözde-rastgele DETERMİNİSTİK: Math.random bir testi tekrarlanamaz yapar,
  // ve tekrarlanamayan bir adalet iddiası iddia değildir. Sabit tohumlu LCG
  // (Numerical Recipes katsayıları).
  let seed = 20260812;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x1_0000_0000; };

  // Kalıcı adaylar HER koşumda listede; geçiciler her koşum yeniden çekiliyor.
  const persistent = [cand(1, 2), cand(3, 4), cand(5, null, "intra"), cand(7, null, "frontmatter")];
  const feed = () => {
    const out = [...persistent];
    for (let i = 0; i < 30; i++) {
      const a = 100 + Math.floor(rnd() * 400);
      const kinds = ["cross", "intra", "frontmatter"] as const;
      const kind = kinds[Math.floor(rnd() * 3)]!;
      out.push(cand(a, kind === "cross" ? a + 1 : null, kind));
    }
    // Sıra da churn ediyor: üretim sırası hiçbir garanti taşımıyor.
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const { firstSeen } = rotate(feed, 20, 20);
  assert.deepEqual(missing(persistent, firstSeen), [], "churn altında kalıcı aday aç kaldı");
});

test("churn: hiç seçilmemiş aday, sonradan gelen adaylar tarafından geriye itilemiyor", () => {
  // Adaletin ispatının ikinci yarısı: eşitlik (damga 0) kimlik sırasıyla
  // bozuluyor, ve bulgu id'leri monoton arttığı için sonradan gelen aday DAHA
  // BÜYÜK kimlikli — yani bekleyeni öne değil arkaya koyar.
  const waiting = cand(1, 2);
  let nextId = 1000;
  const feed = () => [waiting, ...Array.from({ length: 10 }, () => { nextId += 2; return cand(nextId, nextId + 1); })];
  const { firstSeen } = rotate(feed, 1, 3);
  assert.equal(firstSeen.get(candidateIdentity(waiting)), 1, "bekleyen aday ilk koşumda seçilmeliydi");
});

// --- 2b. G dalgası: küçük bütçede YÜZEY sırası kaynaklı açlık --------------

test("küçük bütçe + churn: sabit frontmatter adayı, her koşum yeni doğan cross'a yenilmiyor", () => {
  // probes/small-budget-cross-surface-starvation.sh terfisi (rc=1 → rc=0).
  // Eski sırada eşitliği önce YÜZEY ADI bozuyordu ve "cross" < "frontmatter":
  // bütçe 1 iken kota turu bütçenin tamamını sözlükte önde gelen yüzeye
  // harcıyor, sabit aday 20/20 koşumda atlanıyordu. Sıra artık id ile başlıyor.
  const waiting = cand(1, null, "frontmatter");
  const feed = (run: number) => [waiting, cand(1000 + run * 2, 1001 + run * 2, "cross")];
  const { firstSeen } = rotate(feed, 1, 20);
  assert.equal(firstSeen.get(candidateIdentity(waiting)), 1,
    "sabit aday, sonradan doğan cross adayına yenildi");
});

test("kapanış (i): bütçe 2 (yüzey sayısından hâlâ küçük) — bekleyenler yine öne geçiyor", () => {
  // Aynı sınıfın başka biçimi: bütçe > 1 ama aktif yüzey sayısından küçük, yani
  // kotaların toplamı bütçeyi hâlâ aşıyor. Sıra id ile başladığı için ölçüt
  // yüzeyden bağımsız: iki eski aday, üç taze adayın önünde.
  const eskiler = [cand(1, null, "frontmatter"), cand(2, null, "intra")];
  const feed = (run: number) => [
    ...eskiler,
    cand(500 + run * 3, 501 + run * 3, "cross"),
    cand(700 + run, null, "intra"),
    cand(900 + run, null, "frontmatter"),
  ];
  const { firstSeen } = rotate(feed, 2, 10);
  assert.deepEqual(missing(eskiler, firstSeen), [], "küçük bütçede eski aday aç kaldı");
  for (const c of eskiler)
    assert.equal(firstSeen.get(candidateIdentity(c)), 1, "eski adaylar ilk koşumda alınmalıydı");
});

test("kapanış (ii): tüm adaylar AYNI yüzeyde, bütçe 1 — sıra hâlâ eski → yeni", () => {
  // Yüzey ayracı devreden çıktığında da sıra doğru: tek ayırt edici ölçüt id.
  const waiting = cand(1, 2, "cross");
  // Taze aday listede ÖNDE: üretim sırası hiçbir garanti taşımıyor.
  const feed = (run: number) => [cand(5000 + run * 2, 5001 + run * 2, "cross"), waiting];
  const { firstSeen } = rotate(feed, 1, 5);
  assert.equal(firstSeen.get(candidateIdentity(waiting)), 1, "tek yüzeyde bile bekleyen atlandı");

  // Ve sabit bir tek-yüzey kümesinde sıra kesinlikle artan id: 5 aday, bütçe 1.
  const sabit = [cand(9, 10), cand(3, 4), cand(7, 8), cand(1, 2), cand(5, 6)];
  const { perRun } = rotate(sabit, 1, 5);
  assert.deepEqual(perRun.map((t) => t[0]!.aId), [1, 3, 5, 7, 9], "eşitlik id sırasında bozulmadı");
});

test("kapanış (iii): aynı id çiftinin iki yüzeyi (GERÇEK eşitlik) deterministik", () => {
  // Burada id'ler ayırt etmiyor; ayraç olarak geriye yalnız yüzey adı kalıyor.
  // İddia doğruluk değil DETERMİNİZM: girdi sırası ne olursa olsun aynı seçim.
  const ic = cand(9, null, "intra"), fm = cand(9, null, "frontmatter");
  const ileri = selectCandidates([ic, fm], 1, {}).taken;
  const geri = selectCandidates([fm, ic], 1, {}).taken;
  assert.deepEqual(ileri.map((c) => c.kind), geri.map((c) => c.kind),
    "gerçek eşitlikte seçim girdi sırasına bağlı — deterministik değil");
  assert.deepEqual(ileri.map((c) => c.kind), ["frontmatter"], "ayraç sözlük sırası olmalıydı");
  // Ve ikisi ayrı kimlik olduğu için ikinci koşumda diğeri geliyor: açlık yok.
  const { firstSeen } = rotate([ic, fm], 1, 2);
  assert.deepEqual(missing([ic, fm], firstSeen), [], "gerçek eşitlikte bir taraf aç kaldı");
});

// --- 2c. H dalgası: kota SIRALAMANIN İÇİNDE değil, REZERVASYON --------------
//
// Açlık sınıfının beşinci biçimi: kota bütçeyi damga sırasına göre harcayan tek
// bir listenin İÇİNDE uygulanıyordu, yani "hiç ölçülmemiş" damga sınıfı bütçeyi
// kota devreye girmeden tüketebiliyordu. Ölçüldü (probe churned-surface-
// starvation, 12 koşum): 10 kalıcı intra + 10 kalıcı frontmatter damgalıyken her
// koşuma 20 taze cross eklendiğinde 12/12 koşumda cross=20, intra=0, frontmatter=0.
//
// Yapısal düzeltme: önce SLOT REZERVE et, sonra doldur. Rezerv yalnız kendi
// yüzeyinin öncelik kuyruğundan dolar; artan slotlar küresel sırayla dağılır.

/** Bir koşumun yüzey dağılımı — taban iddialarının tek okuma noktası. */
const spread = (taken: Candidate[]) => ({
  cross: taken.filter((c) => c.kind === "cross").length,
  intra: taken.filter((c) => c.kind === "intra").length,
  frontmatter: taken.filter((c) => c.kind === "frontmatter").length,
});

test("H taban: taze cross seli altında kalıcı intra/frontmatter kotasını HER koşum alıyor", () => {
  // probes/churned-surface-starvation.sh terfisi (rc=1 → rc=0).
  const persistent = [
    ...Array.from({ length: 10 }, (_, i) => cand(i + 1, null, "intra")),
    ...Array.from({ length: 10 }, (_, i) => cand(i + 11, null, "frontmatter")),
  ];
  // Kalıcılar bir kez ölçülüp damgalanıyor: bundan sonra her taze cross onlardan
  // "daha eski" (damga 0) sayılır — kusurun tetikleyicisi tam olarak bu.
  let stamps: CandidateStamps = selectCandidates(persistent, 20, {}).next;
  for (let run = 1; run <= 12; run++) {
    const fresh = Array.from({ length: 20 }, (_, i) =>
      cand(1000 + run * 100 + i, 100_000 + run * 100 + i, "cross"));
    const r = selectCandidates([...persistent, ...fresh], 20, stamps);
    stamps = r.next;
    const s = spread(r.taken);
    assert.equal(r.taken.length, 20, `koşum ${run}: bütçe boşa gitti`);
    for (const k of ["cross", "intra", "frontmatter"] as const)
      assert.ok(s[k] >= quotaOf(k), `koşum ${run}: ${k} tabanı tutmadı (${JSON.stringify(s)})`);
  }
});

test("H kapanış (a): İKİ yüzey taze selle gelirken üçüncüsü (kalıcı) tabanını koruyor", () => {
  const persistent = Array.from({ length: 10 }, (_, i) => cand(i + 1, null, "frontmatter"));
  let stamps: CandidateStamps = selectCandidates(persistent, 20, {}).next;
  for (let run = 1; run <= 12; run++) {
    const fresh = [
      ...Array.from({ length: 20 }, (_, i) => cand(2000 + run * 100 + i, 200_000 + run * 100 + i, "cross")),
      ...Array.from({ length: 20 }, (_, i) => cand(5000 + run * 100 + i, null, "intra")),
    ];
    const r = selectCandidates([...persistent, ...fresh], 20, stamps);
    stamps = r.next;
    const s = spread(r.taken);
    assert.equal(r.taken.length, 20, `koşum ${run}: bütçe boşa gitti`);
    assert.ok(s.frontmatter >= quotaOf("frontmatter"),
      `koşum ${run}: iki selin arasında kalan yüzey aç kaldı (${JSON.stringify(s)})`);
  }
});

test("H kapanış (b): TÜM adaylar tek yüzeyde — kota anlamsız, davranış hâlâ doğru", () => {
  // Rezervasyon burada bir no-op olmalı: rezerv 6 slot verse de artık turu kalan
  // 14'ü aynı yüzeye geri veriyor, yani seçim küresel damga sırasının aynısı.
  const only = Array.from({ length: 25 }, (_, i) => cand(i + 1, null, "intra"));
  const { taken } = selectCandidates(only, 20, {});
  assert.equal(taken.length, 20, "tek yüzeyde rezervasyon bütçeyi kilitledi");
  assert.deepEqual(taken.map((c) => c.aId), Array.from({ length: 20 }, (_, i) => i + 1),
    "tek yüzeyde sıra küresel damga/kimlik sırasından koptu");
  assert.equal(runsToCover(only, 20), 2, "tek yüzeyde kapsama ⌈25/20⌉ olmalıydı");
});

test("H kapanış (c): aday sayısı bütçenin çok altında — hepsi seçiliyor, rezerv kilitlemiyor", () => {
  const few = [cand(1, 2, "cross"), cand(3, null, "intra"), cand(4, null, "frontmatter")];
  const { taken } = selectCandidates(few, 20, {});
  assert.deepEqual(taken, few, "az adayda rezervasyon bir şeyi dışarıda bıraktı");
});

test("H: bir yüzeyin adayı yokken rezervi ARTIK havuzuna dönüyor (bütçe boşa gitmiyor)", () => {
  // intra hiç yok, frontmatter kotasının altında (3 < 6): ikisinin de kullanılmayan
  // rezervi cross'a gitmeli, yoksa 20 bütçenin 11'i harcanıp 9'u çöpe giderdi.
  const candidates = [
    ...Array.from({ length: 20 }, (_, i) => cand(i + 1, 100 + i, "cross")),
    ...Array.from({ length: 3 }, (_, i) => cand(500 + i, null, "frontmatter")),
  ];
  const { taken } = selectCandidates(candidates, 20, {});
  assert.equal(taken.length, 20, "artan rezerv havuza dönmedi");
  const s = spread(taken);
  assert.equal(s.frontmatter, 3, "adayı olan yüzey tamamını alamadı");
  assert.equal(s.cross, 17, "artan slotlar cross'a geçmedi");
});

// --- 3. sınıf kapanışı: aynı kusurun başka biçimleri -----------------------

test("kapanış (a): aynı çiftin iki yönü ve kind değişimi AYRI kimlik", () => {
  const ileri = cand(1, 2), geri = cand(2, 1);
  assert.notEqual(candidateIdentity(ileri), candidateIdentity(geri));
  // Bir yönün damgası diğerini "ölçülmüş" göstermiyor (D dalgasının kusuru:
  // bir kenarın ölçümü komşu kenarları da ölçülmüş sayıyordu).
  const { taken } = selectCandidates([ileri, geri], 1, { [candidateIdentity(ileri)]: 5 });
  assert.deepEqual(taken, [geri]);

  // Aynı notun iki farklı yüzeydeki adayı da ayrı: kind kimliğin parçası.
  const ic = cand(9, null, "intra"), fm = cand(9, null, "frontmatter");
  assert.notEqual(candidateIdentity(ic), candidateIdentity(fm));
  const r = selectCandidates([ic, fm], 1, { [candidateIdentity(ic)]: 5 });
  assert.deepEqual(r.taken, [fm]);
});

test("kapanış (b): taraf süpersede olup YENİ bulgu olarak dönerse damga sıfırdan", () => {
  // Yeni bulgu = yeni id = yeni kimlik → hiç seçilmemiş → en yüksek öncelik.
  // Eski kimliğin damgası ise budanıyor (aşağıdaki depo testinde ölçülüyor).
  const eski = cand(1, 2);
  const yeni = cand(1, 3); // 2 süpersede oldu, yerine 3 geldi
  const stamps = { [candidateIdentity(eski)]: 9 };
  const { taken } = selectCandidates([eski, yeni], 1, stamps);
  assert.deepEqual(taken, [yeni], "geri dönen taraf eski damgayı miras aldı");
});

test("kapanış (c): damgalar proje başına izole", () => {
  const path = tmpStorePath();
  const store = openStore(path);
  const mk = (p: string) => Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", p, "claude-code", "/t",
  ).lastInsertRowid);
  const a = mk("/a"), b = mk("/b");
  for (const pid of [a, b]) for (const i of [1, 2]) appendFinding(store, {
    projectId: pid, source: "observed", content: `not ${i}`,
    anchors: [{ kind: "file_path", value: "src/x.ts" }],
  });
  const idsA = listActive(store, a).map((f) => f.id);
  const idsB = listActive(store, b).map((f) => f.id);
  const keyA = `cross:${idsA[0]}:${idsA[1]}`;
  const keyB = `cross:${idsB[0]}:${idsB[1]}`;

  writeClassifyStamps(store, a, { [keyA]: 3 }, 3);
  assert.deepEqual(readClassifyStamps(store, a), { [keyA]: 3 });
  assert.deepEqual(readClassifyStamps(store, b), {}, "bir projenin damgası diğerine sızdı");
  writeClassifyStamps(store, b, { [keyB]: 7 }, 7);
  assert.deepEqual(readClassifyStamps(store, a), { [keyA]: 3 }, "ikinci proje ilkinin damgasını ezdi");
  store.close();
});

test("kimlik kodlaması tersine çevrilebilir; bozuk anahtar reddediliyor", () => {
  for (const c of [cand(1, 2), cand(9, null, "intra"), cand(4, null, "frontmatter")])
    assert.deepEqual(parseCandidateIdentity(candidateIdentity(c)), { kind: c.kind, aId: c.aId, bId: c.bId ?? -1 });
  for (const bozuk of ["", "cross:1", "cross:1:2:3", "bilinmeyen:1:2", "cross:x:2", "cross:1:1e400"])
    assert.equal(parseCandidateIdentity(bozuk), null, `bozuk anahtar kabul edildi: ${bozuk}`);
});

// --- depo: kalıcılık, budama ve VAR OLAN dosya üzerinde şema ---------------

test("şema: classify_stamps VAR OLAN depoya geliyor, veri duruyor, damga yazılabiliyor", () => {
  // CLAUDE.md §7: taze depoda çalışması KANIT DEĞİL. Dosya önce yaratılıp içine
  // veri konuyor, sonra tablo ELLE düşürülerek eski kuşak birebir üretiliyor.
  const path = tmpStorePath();
  const ilk = openStore(path);
  const projectId = Number(ilk.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(ilk, {
    projectId, source: "observed", content: "eski kuşak notu",
    anchors: [{ kind: "file_path", value: "src/x.ts" }],
  });
  ilk.close();

  const eski = new DatabaseSync(path);
  eski.exec("DROP TABLE classify_stamps");
  // Önceki İKİ kuşağın ölü durumu var olan depolarda DURUYOR ve bu kuşak birebir
  // o dosya: hiçbir sorgu ikisini de anmıyor iddiası burada ölçülüyor.
  eski.exec("ALTER TABLE findings ADD COLUMN last_classified_at TEXT");
  eski.exec("CREATE TABLE IF NOT EXISTS classify_cursors (project_id INTEGER, kind TEXT, next_index INTEGER)");
  eski.exec("INSERT INTO classify_cursors VALUES (1,'cross',7)");
  eski.close();

  const yeni = openStore(path); // göç yolu: var olan dosya üzerinde
  const tables = yeni.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
  assert.ok(tables.includes("classify_stamps"), "eksik tablo geri gelmedi: her denetim damga yazarken patlar");
  assert.ok(tables.includes("classify_cursors"), "ölü tablo düşürüldü: karar onu BIRAKMAKTI (schema.sql)");
  assert.equal(getFinding(yeni, findingId)!.content, "eski kuşak notu", "göç veri kaybetti");
  const yeniId = appendFinding(yeni, {
    projectId, source: "observed", content: "yeni kuşak notu",
    anchors: [{ kind: "file_path", value: "src/x.ts" }],
  });
  assert.equal(listActive(yeni, projectId).length, 2);

  const key = `cross:${findingId}:${yeniId}`;
  assert.deepEqual(readClassifyStamps(yeni, projectId), {}, "boş depo damga uydurmuş");
  writeClassifyStamps(yeni, projectId, { [key]: 1 }, 1);
  writeClassifyStamps(yeni, projectId, { [key]: 2 }, 2); // ON CONFLICT yolu
  assert.deepEqual(readClassifyStamps(yeni, projectId), { [key]: 2 }, "ON CONFLICT eşleşmedi: satır ikilendi");

  // Tek notluk yüzeyin -1 sentinel'i de ON CONFLICT'e giriyor (NULL girmezdi).
  const intra = `intra:${findingId}:-1`;
  writeClassifyStamps(yeni, projectId, { [intra]: 3 }, 3);
  writeClassifyStamps(yeni, projectId, { [intra]: 4 }, 4);
  assert.equal(yeni.all("SELECT 1 FROM classify_stamps WHERE kind='intra'").length, 1, "NULL/-1 sentinel ikilendi");
  yeni.close();
});

test("budama: tarafı süpersede olan damga satırı siliniyor, canlı olan duruyor", () => {
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const ids = [1, 2, 3].map((i) => appendFinding(store, {
    projectId, source: "observed", content: `not ${i}`,
    anchors: [{ kind: "file_path", value: "src/x.ts" }],
  }));
  const [a, b, c] = ids as [number, number, number];
  const canli = `cross:${a}:${b}`;
  const olecek = `cross:${a}:${c}`;
  const intra = `intra:${c}:-1`;
  writeClassifyStamps(store, projectId, { [canli]: 1, [olecek]: 1, [intra]: 1 }, 1);
  assert.equal(Object.keys(readClassifyStamps(store, projectId)).length, 3);

  // c süpersede: onu içeren HER kimlik bir daha asla üretilemez (findCandidates
  // girdisini listActive'ten alıyor), dolayısıyla damgası ölü durumdur.
  const yerine = appendFinding(store, {
    projectId, source: "observed", content: "yerine gecen not",
    anchors: [{ kind: "file_path", value: "src/x.ts" }],
  });
  supersede(store, c, yerine);
  writeClassifyStamps(store, projectId, { [canli]: 2 }, 2);
  assert.deepEqual(readClassifyStamps(store, projectId), { [canli]: 2 },
    "budama ya ölü satırı bıraktı ya canlı satırı sildi");

  // `suspect` CANLI: şüpheli bir not hâlâ aday üretiyor, damgası silinemez.
  store.run("UPDATE findings SET status = 'suspect' WHERE id = ?", b);
  writeClassifyStamps(store, projectId, {}, 3);
  assert.deepEqual(readClassifyStamps(store, projectId), { [canli]: 2 }, "suspect taraf ölü sayıldı");
  store.close();
});

// --- uçtan uca: gerçek denetim akışı ---------------------------------------

const NOTES = ["ALFA", "BETA", "GAMA", "DELTA", "EPSILON", "ZETA", "ETA"];

/** Prompt'taki her aday bloğundan hangi iki notun karşılaştırıldığını okur. */
function pairsInPrompt(prompt: string): string[] {
  return prompt
    .split(/\n(?=#\d+ \[)/)
    .filter((block) => block.startsWith("#"))
    .map((block) => {
      const found = [...new Set(block.match(/\b[A-Z]{3,8}\b/g) ?? [])].filter((n) => NOTES.includes(n));
      return found.sort().join("-");
    })
    .filter((p) => p.includes("-"));
}

function gitRepo(prefix: string): string {
  const repo = tmpDir(prefix);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  return repo;
}

test("uçtan uca (K7): 21 çiftin HEPSİ sınır içinde ölçülüyor", async () => {
  const repo = gitRepo("cp-wave-f-k7-");
  mkdirSync(join(repo, "src"));
  // Her ikili KENDİ dosyasını paylaşıyor: 21 ayırt edici çapa, 21 aday.
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      writeFileSync(join(repo, "src", `p-${a}-${b}.ts`), "export const x = 1;\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-qm", "ilk"], { stdio: "ignore" });

  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", repo, "probe", "/t",
  ).lastInsertRowid);
  for (let a = 0; a < 7; a++) {
    const anchors = [];
    for (let b = 0; b < 7; b++) {
      if (b === a) continue;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      anchors.push({ kind: "file_path" as const, value: `src/p-${lo}-${hi}.ts` });
    }
    appendFinding(store, {
      projectId, source: "observed",
      content: `${NOTES[a]} notu: bu dosyalar hakkinda bir iddia`,
      anchors,
    });
  }

  // Gösterilen her adaya "uyumlu" döner: ölçüm gerçekten yapılmış sayılsın.
  const answer = (req: { prompt: string }) => ({
    output: JSON.stringify({
      verdicts: [...req.prompt.matchAll(/^#(\d+) \[/gm)].map((m) => ({
        index: Number(m[1]), verdict: "uyumlu", evidence: "e",
      })),
    }),
  });

  const seen = new Set<string>();
  let total = 0;
  for (let run = 0; run < 3; run++) { // cross kotası 8 → ⌈21/8⌉ = 3
    const executor = fakeExecutor([answer, answer, answer]);
    const sum = await auditProject(store, { id: projectId, path: repo, memoryDir: null }, {
      executor, fetch: false, maxClassifyItems: 20,
    });
    total = sum.candidates;
    for (const call of executor.calls) for (const p of pairsInPrompt(call.prompt)) seen.add(p);
  }
  assert.equal(total, 21, "K7 şekli kurulamadı: aday sayısı beklenenden farklı");
  assert.equal(seen.size, 21, `sınır içinde ölçülmeyen çift kaldı (ölçülen: ${seen.size})`);
  // Damgalar depoda ve seçim damgası her koşum ilerlemiş olmalı.
  assert.equal(Object.keys(readClassifyStamps(store, projectId)).length, 21);
  store.close();
});

test("uçtan uca: hüküm dönmeyen ZEHİRLİ parti sonraki adayların sırasını kilitlemiyor", async () => {
  // Damga ölçümün SONUCUNA değil SEÇİMİNE bağlı. Sonuca bağlansaydı, sürekli
  // geçersiz çıktı veren bir parti en eski kalıp geri kalan adayları sonsuza
  // kadar dışarıda bırakırdı — E dalgasının kimlik yolunu reddetme gerekçesi
  // tam da buydu, ve seçimde damgalayan tasarım için geçerli değil.
  const repo = gitRepo("cp-wave-f-poison-");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-qm", "ilk"], { stdio: "ignore" });

  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", repo, "probe", "/t",
  ).lastInsertRowid);
  for (const i of [0, 1, 2]) appendFinding(store, {
    projectId, source: "observed", content: `not ${i}: src/a.ts hakkinda bir iddia`,
    anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });

  // Üç not, tek ortak çapa → 3 çift. Tavan 1 → koşum başına tam bir aday.
  for (let run = 0; run < 3; run++) {
    await auditProject(store, { id: projectId, path: repo, memoryDir: null }, {
      // Her iki denemede de geçersiz çıktı: hiçbir aday ölçülmüş sayılmıyor.
      executor: fakeExecutor([{ output: "cevap yok" }, { output: "yine yok" }]),
      fetch: false, maxClassifyItems: 1,
    });
  }
  const stamps = readClassifyStamps(store, projectId);
  assert.equal(Object.keys(stamps).length, 3,
    `zehirli parti rotasyonu kilitledi: yalnız ${Object.keys(stamps).length} aday seçilebildi`);
  assert.deepEqual([...Object.values(stamps)].sort((x, y) => x - y), [1, 2, 3],
    "damga ölçüm başarısızlığında ilerlemedi");
  store.close();
});
