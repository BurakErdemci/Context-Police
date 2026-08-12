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
 * GERÇEK kapsama sınırı: YÜZEY BAŞINA ⌈N_yüzey / kota_yüzey⌉.
 *
 * E dalgası buraya küresel ⌈N/M⌉ yazmıştı ve test etmişti — yüzey kotası varken
 * o sınır YANLIŞ (doğrulama turu 3'ün low bulgusu): 20/20/20 adayda cross 3
 * koşumda kapanıyor ama kotası 6 olan intra ve frontmatter 4'te. Bu projede
 * yanlış yazılmış bir iddia, yazılmamış olmasından kötüdür.
 */
function coverageBound(candidates: Candidate[], max = MAX_CLASSIFY_ITEMS): number {
  const counts = new Map<Candidate["kind"], number>();
  for (const c of candidates) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  let bound = 0;
  for (const [kind, n] of counts) bound = Math.max(bound, Math.ceil(n / quotaOf(kind, max)));
  return bound;
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
  const bound = coverageBound(candidates); // cross tek yüzey, kota 8 → ⌈21/8⌉ = 3
  assert.equal(bound, 3);
  const { firstSeen } = rotate(candidates, 20, bound);
  assert.deepEqual(missing(candidates, firstSeen), [], "sınırda kapsanmayan aday var");
  // D dalgasının probe'u 8 koşum sürüyordu ve 6-7 çifti sekizinde de atlanmıştı.
  const uzun = rotate(candidates, 20, 8);
  assert.ok(Math.max(...uzun.firstSeen.values()) <= bound, "bir aday sınırdan geç ölçüldü");
});

test("gerçek sınır YÜZEY BAŞINA: 20/20/20 aday küresel ⌈N/M⌉'de kapanmıyor, yüzey sınırında kapanıyor", () => {
  // Doğrulama turu 3'ün low bulgusunun testi. Küresel iddia ⌈60/20⌉ = 3 diyordu.
  const candidates = [
    ...Array.from({ length: 20 }, (_, i) => cand(i + 1, i + 101, "cross")),
    ...Array.from({ length: 20 }, (_, i) => cand(i + 301, null, "intra")),
    ...Array.from({ length: 20 }, (_, i) => cand(i + 601, null, "frontmatter")),
  ];
  assert.equal(coverageBound(candidates), 4, "yüzey sınırı ⌈20/6⌉ = 4 olmalıydı");
  const { firstSeen } = rotate(candidates, 20, 4);
  assert.deepEqual(missing(candidates, firstSeen), [], "yüzey sınırında aç kalan aday var");

  // Ve bütçe hiçbir koşumda BOŞA gitmiyor: kimlik sırası küresel olduğu için,
  // bir yüzeyin ölçülmemiş adayı bitince kalan slotlar hâlâ hiç ölçülmemiş
  // başka bir yüzeye gidiyor — bu yüzden 60 adayın 60'ı tam 3 koşumda kapanır.
  const uc = rotate(candidates, 20, 3);
  assert.deepEqual(missing(candidates, uc.firstSeen), [],
    "bütçe, ölçülmemiş aday beklerken yeniden ölçüme harcandı");
});

test("varyant (yıldız grafiği): merkez not her çiftte, uçlar aç kalmıyor", () => {
  const candidates = Array.from({ length: 24 }, (_, i) => cand(1, i + 2));
  const { firstSeen } = rotate(candidates, 20, coverageBound(candidates));
  assert.deepEqual(missing(candidates, firstSeen), [], "yıldızın uçları aç kaldı");
});

test("varyant (yüzeyler karışık): kota rotasyonu EZMİYOR, ikisi birden geçerli", () => {
  const candidates = [
    ...Array.from({ length: 30 }, (_, i) => cand(i + 1, 200 + i)),
    ...Array.from({ length: 20 }, (_, i) => cand(300 + i, null, "intra")),
    ...Array.from({ length: 20 }, (_, i) => cand(400 + i, null, "frontmatter")),
  ];
  const bound = coverageBound(candidates); // max(⌈30/8⌉, ⌈20/6⌉) = 4
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
  const bound = coverageBound(candidates);
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
