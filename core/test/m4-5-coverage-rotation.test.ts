// M4.5 — KAPSAMA ROTASYONU: her notun "en son ne zaman bakıldı" üst sınırı.
//
// Kapatılan kusur (ölçüldü, altın set 28 not): kapsama TETİKLEYİCİYE bağlıydı ve
// tetikleyici çapa hareketiydi — 14 notun hiç dosya çapası yok, 2'si yolunu
// kaybediyor, yani 28'in yalnız 12'si bir hareket sinyali üretebiliyor. Çapasız
// nota ulaşan tek yol çelişki adaylığıydı; kimseyle çelişmeyen ve kımıldamayan
// not bir daha HİÇ incelenmiyordu. Ürünün var oluş sebebi olan arıza, ürünün
// içinde.
//
// Testlerin iddiası "artık bakılıyor" değil, "bakılmaması OLANAKSIZ": her notun
// sıraya girdiği koşum kalıcı, sıra en-eski-önce, ve sınır ölçülmüş bir sayı.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../src/store/db.ts";
import { appendFinding, getFinding, listActive } from "../src/store/findings.ts";
import { readRotationState, readClassifyStamps, writeClassifyStamps } from "../src/store/classify-stamps.ts";
import { auditProject } from "../src/audit.ts";
import {
  selectCandidates, candidateIdentity, CLASSIFY_SURFACE_QUOTA, MAX_CLASSIFY_ITEMS,
  type CandidateStamps,
} from "../src/signals/classify.ts";
import { findCoverageCandidates } from "../src/signals/coverage.ts";
import type { Candidate, NoteView } from "../src/signals/contradiction.ts";
import { tmpDir, tmpStorePath, fakeExecutor } from "./helpers.ts";

const cov = (id: number): Candidate => ({ kind: "coverage", aId: id, bId: null, reason: "r" });
const view = (findingId: number, over: Partial<NoteView> = {}): NoteView =>
  ({ findingId, content: `not ${findingId}`, anchors: [], description: null, hasStatus: false, ...over });

/** Üç çelişki yüzeyi de DOLU bir koşum: rotasyona yalnız kendi rezervi kalır. */
function saturatedContradictions(gen: number, per = 12): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < per; i++) {
    out.push({ kind: "cross", aId: 100_000 + gen * 1000 + i, bId: 900_000 + i, reason: "r" });
    out.push({ kind: "intra", aId: 200_000 + gen * 1000 + i, bId: null, reason: "r" });
    out.push({ kind: "frontmatter", aId: 300_000 + gen * 1000 + i, bId: null, reason: "r" });
  }
  return out;
}

/** Her koşumda seçilenleri damgalayarak rotasyonu sürer. */
function rotate(feed: (run: number) => Candidate[], max: number, runs: number) {
  let stamps: CandidateStamps = {};
  let seen: CandidateStamps = {};
  const firstSeen = new Map<string, number>();
  const lastTaken = new Map<string, number>();
  const takenCount = new Map<string, number>();
  /** İki ölçüm arasındaki EN UZUN bekleyiş; hiç dönmeyen aday için sonsuz. */
  const gaps = new Map<string, number>();
  const perRun: Candidate[][] = [];
  for (let run = 1; run <= runs; run++) {
    const r = selectCandidates(feed(run), max, stamps, seen);
    stamps = r.next; seen = r.nextSeen;
    perRun.push(r.taken);
    for (const c of r.taken) {
      const k = candidateIdentity(c);
      if (!firstSeen.has(k)) firstSeen.set(k, run);
      const prev = lastTaken.get(k);
      if (prev !== undefined) gaps.set(k, Math.max(gaps.get(k) ?? 0, run - prev));
      lastTaken.set(k, run);
      takenCount.set(k, (takenCount.get(k) ?? 0) + 1);
    }
  }
  // Bir kez ölçülüp bir daha dönmeyen aday AÇTIR: aralığı "ölçülmedi" değil
  // sonsuzdur. Bu ayrım olmadan açlık, sıfır aralık gibi okunur.
  for (const k of lastTaken.keys())
    if ((takenCount.get(k) ?? 0) < 2) gaps.set(k, Infinity);
  return { firstSeen, perRun, gaps, takenCount, stamps, seen };
}

// --- 1. hangi not sıraya giriyor -------------------------------------------

test("kapsama: tetikleyicisi olmayan not sıraya girer, adayı olan not ikinci kez girmez", () => {
  const notes = [view(1), view(2), view(3), view(4)];
  // 1–2 bir çelişki adayında; 3 ve 4 hiçbir yerde.
  const contradictions: Candidate[] = [{ kind: "cross", aId: 1, bId: 2, reason: "ortak çapa" }];
  const coverage = findCoverageCandidates(notes, contradictions);
  assert.deepEqual(coverage.map((c) => c.aId), [3, 4], "sıraya yanlış notlar kondu");
  assert.ok(coverage.every((c) => c.kind === "coverage" && c.bId === null));
  // Tek notluk yüzeyler de bir adaydır: intra adayı olan not sıraya girmez.
  assert.deepEqual(
    findCoverageCandidates(notes, [{ kind: "intra", aId: 3, bId: null, reason: "x" }]).map((c) => c.aId),
    [1, 2, 4],
  );
  // Çapası olup kımıldamayan not da kapsamaya girer: ölçüt "çapası yok" değil
  // "hiçbir adayda yok" — hareketsiz çapa da bir sinyal üretmiyor.
  const anchored = [view(9, { anchors: [{ kind: "file_path", value: "src/x.ts", takenAtCommit: null }] })];
  assert.equal(findCoverageCandidates(anchored, []).length, 1);
});

// --- 2. uçtan uca: çapasız not GERÇEKTEN ölçülüyor --------------------------

/** Çapasız, description'sız, DURUM kalıbı taşımayan not: hiçbir sinyal üretmez. */
function silentStore(count: number) {
  const path = tmpStorePath();
  const store = openStore(path);
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    tmpDir("cp-m45-proj-"), "probe", "/t",
  ).lastInsertRowid);
  const ids = Array.from({ length: count }, (_, i) => appendFinding(store, {
    projectId, source: "observed", content: `SESSIZ-${i + 1}: kod hakkinda bir iddia`,
  }));
  return { path, store, projectId, ids };
}

/** Prompt'ta gösterilen adayların blok başlıkları. */
const blocksOf = (prompt: string) => [...prompt.matchAll(/^#(\d+) \[([^,\]]+)/gm)].map((m) => m[2]!);

/** Gösterilen her adaya verilen hüküm. */
const answerAll = (verdict: string) => (req: { prompt: string }) => ({
  output: JSON.stringify({
    verdicts: [...req.prompt.matchAll(/^#(\d+) \[/gm)].map((m) => ({
      index: Number(m[1]), verdict, evidence: "e",
    })),
  }),
});

test("uçtan uca: hiçbir tetikleyicisi olmayan not sınıflamaya GİRİYOR ve hüküm nota işleniyor", async () => {
  const { store, projectId, ids } = silentStore(3);
  const project = { id: projectId, path: tmpDir("cp-m45-repo-"), memoryDir: null };
  for (const f of listActive(store, projectId))
    assert.equal(f.status, "unanchored", "kurulum bozuk: not çapasız olmalıydı");

  const executor = fakeExecutor([answerAll("celiski")]);
  const sum = await auditProject(store, project, { executor, fetch: false });

  assert.equal(sum.coverageCandidates, 3, "sessiz notlar sıraya girmedi");
  assert.equal(sum.candidates, 3);
  assert.equal(executor.calls.length, 1, "kapsama adayı varken sınıflama hiç koşmadı");
  const prompt = executor.calls[0]!.prompt;
  assert.deepEqual(blocksOf(prompt), ["kapsama ölçümü — not ↔ bugünkü depo", "kapsama ölçümü — not ↔ bugünkü depo",
    "kapsama ölçümü — not ↔ bugünkü depo"], "kapsama bloğu prompt'a girmedi");
  for (const id of ids)
    assert.ok(prompt.includes(getFinding(store, id)!.content), `not ${id} hiç gösterilmedi`);
  // Karşı taraf deponun kendisi: ölçüm talimatı (recall değil) prompt'ta.
  assert.ok(prompt.includes("karşı taraf DEPONUN KENDİSİDİR"), "kapsama kuralı prompt'a girmedi");

  // Hüküm nota işleniyor: çapasız not da suspect olabiliyor (findings.markSuspect).
  assert.equal(sum.contradictions, 3);
  for (const id of ids) {
    const f = getFinding(store, id)!;
    assert.equal(f.status, "suspect", "kapsama hükmü nota işlenmedi");
    assert.ok(f.suspicion >= 0.7);
  }
  store.close();
});

test("kapsama kuralı yalnız kapsama adayı VARKEN prompt'a giriyor (çelişki ölçümü değişmedi)", async () => {
  const path = tmpStorePath();
  const store = openStore(path);
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    tmpDir("cp-m45-p2-"), "probe", "/t",
  ).lastInsertRowid);
  // İki not ortak çapada: yalnız cross adayı üretiliyor, kapsama boş.
  for (const i of [1, 2]) appendFinding(store, {
    projectId, source: "observed", content: `not ${i}`,
    anchors: [{ kind: "file_path", value: "src/x.ts" }],
  });
  const executor = fakeExecutor([answerAll("uyumlu")]);
  const sum = await auditProject(store, { id: projectId, path: tmpDir("cp-m45-r2-"), memoryDir: null },
    { executor, fetch: false });
  assert.equal(sum.coverageCandidates, 0, "adayı olan notlar sıraya konmuş");
  assert.ok(!executor.calls[0]!.prompt.includes("kapsama ölçümü"), "kapsama kuralı gereksiz yere eklendi");
  store.close();
});

// --- 3. bütçe bağlayıcı, hareket önceliğini koruyor -------------------------

test("bütçe GENİŞLEMİYOR: rotasyon rezervasyon turunda 4/20'yi aşamaz, hareket 16'yı elinde tutar", () => {
  const coverage = Array.from({ length: 40 }, (_, i) => cov(i + 1));
  const { perRun } = rotate((run) => [...saturatedContradictions(run), ...coverage], MAX_CLASSIFY_ITEMS, 12);
  for (const [i, taken] of perRun.entries()) {
    assert.equal(taken.length, MAX_CLASSIFY_ITEMS, `koşum ${i + 1}: bütçe aşıldı ya da boşa gitti`);
    const n = taken.filter((c) => c.kind === "coverage").length;
    assert.ok(n <= CLASSIFY_SURFACE_QUOTA.coverage,
      `koşum ${i + 1}: rotasyon tavanını aştı (${n}) — hareket açlığa itilebilir`);
    assert.ok(taken.length - n >= MAX_CLASSIFY_ITEMS - CLASSIFY_SURFACE_QUOTA.coverage,
      `koşum ${i + 1}: çelişki/hareket tarafı 16'nın altına düştü`);
  }
});

test("rotasyon ARTIK slotları kullanır: çelişki adayı azken bütçe boşa gitmiyor", () => {
  // Tek bir cross adayı + 40 kapsama: rezerv 4 ama artan 15 slot da kapsamaya
  // gider, yoksa bütçenin dörtte üçü çöpe giderdi.
  const coverage = Array.from({ length: 40 }, (_, i) => cov(i + 1));
  const { taken } = selectCandidates(
    [{ kind: "cross", aId: 7, bId: 8, reason: "r" }, ...coverage], MAX_CLASSIFY_ITEMS, {}, {},
  );
  assert.equal(taken.length, MAX_CLASSIFY_ITEMS);
  assert.equal(taken.filter((c) => c.kind === "coverage").length, MAX_CLASSIFY_ITEMS - 1);
});

// --- 4. KAPSAMA SINIRI: ölçülen sayı ---------------------------------------

test("kapsama sınırı ÖLÇÜLDÜ: doymuş çelişki yükü altında TAM ⌈N/4⌉ koşum", () => {
  // Deliverable'ın sorusu: varsayılan bütçeyle (20) bir kapsama adayına en geç
  // kaç koşumda bakılır? En kötü hâl üç çelişki yüzeyinin de DOLU olduğu koşum:
  // rotasyona yalnız kendi rezervi (4) kalır. Ölçüm, akıl yürütme değil — döngü
  // gerçekten koşturuluyor.
  for (const n of [1, 4, 8, 14, 16, 28, 40]) {
    const coverage = Array.from({ length: n }, (_, i) => cov(i + 1));
    const bound = Math.ceil(n / CLASSIFY_SURFACE_QUOTA.coverage);
    const { firstSeen } = rotate(
      (run) => [...saturatedContradictions(run), ...coverage], MAX_CLASSIFY_ITEMS, bound,
    );
    const missing = coverage.map(candidateIdentity).filter((k) => !firstSeen.has(k));
    assert.deepEqual(missing, [], `N=${n}: ⌈N/4⌉=${bound} koşumda bakılmayan not kaldı`);
    // Ve sınır GEVŞEK değil: bir eksik koşumda kapanmıyor.
    if (bound > 1) {
      const kisa = rotate((run) => [...saturatedContradictions(run), ...coverage], MAX_CLASSIFY_ITEMS, bound - 1);
      assert.ok(coverage.map(candidateIdentity).some((k) => !kisa.firstSeen.has(k)),
        `N=${n}: sınır ölçülenden gevşek yazılmış`);
    }
  }
});

test("altın set ölçüsü: hareket sinyali ÜRETEMEYEN 16 not en geç 4 koşumda inceleniyor", () => {
  // Ölçülen kusurun tam sayısı: 28 notun 16'sı hiç hareket sinyali üretemiyor.
  const coverage = Array.from({ length: 16 }, (_, i) => cov(i + 1));
  const { firstSeen } = rotate((run) => [...saturatedContradictions(run), ...coverage], MAX_CLASSIFY_ITEMS, 4);
  for (const c of coverage)
    assert.ok((firstSeen.get(candidateIdentity(c)) ?? Infinity) <= 4, "16 notluk küme 4 koşumda kapanmadı");
});

// --- 5. imleç KALICI: süreç yeniden başlasa da rotasyon devam ediyor --------

test("kalıcılık: depo kapanıp yeniden açıldığında rotasyon baştan başlamıyor", async () => {
  const { path, store, projectId, ids } = silentStore(9);
  const repo = tmpDir("cp-m45-restart-");
  store.close();

  const seenNotes = new Set<string>();
  for (let run = 0; run < 3; run++) {
    // HER koşum yeni bir Store: imleç bellekte tutulsaydı burada sıfırlanırdı.
    const s = openStore(path);
    const executor = fakeExecutor([answerAll("uyumlu")]);
    const sum = await auditProject(s, { id: projectId, path: repo, memoryDir: null },
      { executor, fetch: false, maxClassifyItems: 3 });
    assert.equal(sum.coverageCandidates, 9);
    assert.equal(sum.classifyDropped, 6, "bütçe 3'e inmedi: ölçüm kurulumu bozuk");
    for (const m of executor.calls[0]!.prompt.matchAll(/SESSIZ-\d+/g)) seenNotes.add(m[0]);
    s.close();
  }
  assert.equal(seenNotes.size, 9,
    `yeniden açılışta rotasyon baştan başladı: 9 nottan ${seenNotes.size} tanesine bakıldı`);

  // Ve durum gerçekten DİSKTE: her adayın bir satırı var.
  const s = openStore(path);
  const state = readRotationState(s, projectId);
  assert.equal(Object.keys(state.selected).length, 9);
  for (const id of ids) assert.ok(state.seen[`coverage:${id}:-1`]! > 0, `not ${id} için ilk-görülme yazılmadı`);
  s.close();
});

// --- 6. BORÇ 1: yüzey İÇİ sel (altıncı açlık biçimi) -----------------------

test("borç 1: yüzey içi sel — ölçülmüş aday, taze aday seli altında süresiz beklemiyor", () => {
  // Kayıtlı biçim (classify.ts, kapanmamış not): damga 0 mutlak öncelikliydi,
  // yani bir yüzeye rezervinden çok TAZE aday girdiğinde o yüzeyin daha önce
  // ölçülmüş adayları hiç sıraya gelmiyordu. Kurulum tam olarak bu: intra
  // rezervi 6, her koşum 20 taze intra doğuyor, ve 6 kalıcı intra ölçülmüş.
  const persistent = Array.from({ length: 6 }, (_, i) => ({
    kind: "intra" as const, aId: i + 1, bId: null, reason: "r",
  }));
  const feed = (run: number) => [
    ...persistent,
    ...Array.from({ length: 20 }, (_, i) => ({
      kind: "intra" as const, aId: 50_000 + run * 100 + i, bId: null, reason: "r",
    })),
    ...saturatedContradictions(run, 8).filter((c) => c.kind !== "intra"),
  ];
  const RUNS = 24;

  const fixed = rotate(feed, MAX_CLASSIFY_ITEMS, RUNS);
  for (const c of persistent) {
    const k = candidateIdentity(c);
    assert.ok(fixed.firstSeen.has(k), `kalıcı aday ${RUNS} koşumda hiç ölçülmedi (açlık)`);
    // Ölçüt TEK ölçüm değil YENİDEN ölçüm: bir kez bakılıp bir daha dönmemek
    // açlığın ta kendisi ve "aralık yok" diye okunabiliyordu (bu testin ilk
    // hâli tam bu yüzden kusuru yakalamıyordu — mutasyonla ölçüldü).
    assert.ok((fixed.takenCount.get(k) ?? 0) >= 2, `kalıcı aday ${RUNS} koşumda bir kez ölçülüp bırakıldı`);
    assert.ok(fixed.gaps.get(k)! <= 8,
      `kalıcı aday iki ölçüm arasında ${fixed.gaps.get(k)} koşum bekledi — sınır yok demektir`);
  }

  // ÇÜRÜTME: aynı akış, ilk-görülme İZLENMEDEN (damga 0 mutlak öncelikli) —
  // düzeltmeden önceki davranışın ta kendisi. Ölçüt ÜYELİK değil ARALIK: kalıcı
  // adaylar ilk koşumda (henüz damgasızken) ölçülüyor, sonra bir daha ASLA.
  let stamps: CandidateStamps = {};
  const lastLegacy = new Map<string, number>();
  for (let run = 1; run <= RUNS; run++) {
    const r = selectCandidates(feed(run), MAX_CLASSIFY_ITEMS, stamps);
    stamps = r.next;
    for (const c of r.taken) lastLegacy.set(candidateIdentity(c), run);
  }
  const yenidenOlculen = persistent.filter((c) => (lastLegacy.get(candidateIdentity(c)) ?? 0) > 1);
  assert.equal(yenidenOlculen.length, 0,
    `eski kural açlık üretmiyorsa bu test kusuru yeniden üretmiyor — ${yenidenOlculen.length} aday yeniden ölçüldü`);
});

test("borç 1 ters yön: ilk-görülme, HİÇ ölçülmemiş adayı da açlığa itmiyor", () => {
  // Sabit bir yaşla ("taze aday N koşumdur bekliyor say") yaşlandırmak açlığı
  // yalnız yön değiştirirdi: aday sayısı bütçenin katlarına çıktığında ölçülmüş
  // adayların yaşı o sabiti kalıcı olarak geçer ve taze aday hiç ölçülmezdi.
  // İlk-görülmede iki yön de sınırlı — burada ölçülen o.
  const persistent = Array.from({ length: 60 }, (_, i) => ({
    kind: "intra" as const, aId: i + 1, bId: null, reason: "r",
  }));
  const newcomer = { kind: "intra" as const, aId: 90_000, bId: null, reason: "r" };
  // Kalıcılar önce tek başına dönüyor (hepsi damgalanıyor), sonra yeni aday giriyor.
  let stamps: CandidateStamps = {};
  let seen: CandidateStamps = {};
  for (let run = 1; run <= 6; run++) {
    const r = selectCandidates(persistent, MAX_CLASSIFY_ITEMS, stamps, seen);
    stamps = r.next; seen = r.nextSeen;
  }
  let picked = 0;
  for (let run = 1; run <= 20 && picked === 0; run++) {
    const r = selectCandidates([...persistent, newcomer], MAX_CLASSIFY_ITEMS, stamps, seen);
    stamps = r.next; seen = r.nextSeen;
    if (r.taken.some((c) => candidateIdentity(c) === candidateIdentity(newcomer))) picked = run;
  }
  assert.ok(picked > 0 && picked <= 4,
    `sonradan giren aday ${picked === 0 ? "hiç" : picked + ". koşumda"} ölçüldü — ters yönde açlık`);
});

// --- 7. BORÇ 2: damga taşması ----------------------------------------------

test("borç 2: damga sayacı GÜVENLİ TAMSAYI tavanına dayanınca rotasyon donmuyor", () => {
  // Kusur: yeni damga `en büyük + 1`. En büyük tam olarak MAX_SAFE_INTEGER ise
  // yeni damga güvenli olmayan bir tamsayıya çıkıyor, depo yazımı onu reddediyor
  // ve HİÇBİR damga ilerlemiyor — aynı aday sonsuza kadar seçiliyor. Sayaç
  // aritmetiği değil, DEPONUN durumu sürülüyor: satır tavan değeriyle yazılıyor.
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "probe", "/t",
  ).lastInsertRowid);
  const ids = [1, 2, 3].map((i) => appendFinding(store, {
    projectId, source: "observed", content: `not ${i}`,
    anchors: [{ kind: "file_path", value: "src/x.ts" }],
  }));
  const candidates = ids.map((id) => cov(id));

  // Tavan: ilk aday MAX_SAFE_INTEGER damgalı (elle düzenlenmiş ya da uzun ömürlü
  // depo). İkinci aday hiç seçilmemiş ama ÇOK ESKİ bir ilk-görülme taşıyor:
  // sıkıştırmanın iki haritayı da yazması gerektiğini görünür kılan satır.
  const row = (id: number, selected: number, seen: number) => store.run(
    "INSERT INTO classify_stamps (project_id, kind, a_id, b_id, selected_seq, first_seen_seq) VALUES (?,?,?,?,?,?)",
    projectId, "coverage", id, -1, selected, seen,
  );
  row(ids[0]!, Number.MAX_SAFE_INTEGER, 1);
  row(ids[1]!, 0, Number.MAX_SAFE_INTEGER - 10);

  const picked: number[][] = [];
  for (let run = 0; run < 3; run++) {
    const state = readRotationState(store, projectId);
    const r = selectCandidates(candidates, 1, state.selected, state.seen);
    store.tx(() => writeClassifyStamps(store, projectId, r.next, r.stamp,
      { seen: r.nextSeen, rewriteAll: r.renumbered }));
    picked.push(r.taken.map((c) => c.aId));
  }
  assert.deepEqual(picked, [[ids[1]], [ids[0]], [ids[2]]],
    "tavanda rotasyon dondu: aynı aday tekrar tekrar seçiliyor");

  // Depodaki damgalar küçüldü ama SIRA korundu: tavandaki satır hâlâ en yenisi
  // değil — sıkıştırma sıralamayı birebir taşıyor.
  const after = readRotationState(store, projectId);
  for (const v of [...Object.values(after.selected), ...Object.values(after.seen)])
    assert.ok(Number.isSafeInteger(v) && v > 0 && v < 1000, `damga küçülmedi: ${v}`);
  // Sıkıştırma İKİ haritayı birden yazmalı: yalnız seçim damgaları küçülseydi,
  // ilk-görülme tavanda kalır ve sıra kalıcı olarak ters okunurdu.
  assert.equal(Object.keys(after.seen).length, 3, "sıkıştırma ilk-görülme satırlarını yazmadı");
  assert.deepEqual(readClassifyStamps(store, projectId), after.selected);
  store.close();
});

test("borç 2: sıkıştırma SIRAYI koruyor (aynı seçim, yalnız sayılar küçük)", () => {
  const candidates = [cov(1), cov(2), cov(3), cov(4)];
  const key = (i: number) => candidateIdentity(candidates[i]!);
  const big = Number.MAX_SAFE_INTEGER;
  const stamps = { [key(0)]: big - 30, [key(1)]: big, [key(2)]: big - 5 };
  const seen = { [key(0)]: 1, [key(1)]: 2, [key(2)]: 3, [key(3)]: big - 40 };

  const r = selectCandidates(candidates, 2, stamps, seen);
  assert.equal(r.renumbered, true, "tavanda sıkıştırma tetiklenmedi");
  // Sıra: 4 (hiç seçilmemiş, en eski görülme) → 1 → 3 → 2.
  assert.deepEqual(r.taken.map((c) => c.aId), [1, 4], "sıkıştırma seçimi değiştirdi");
  assert.ok(Number.isSafeInteger(r.stamp) && r.stamp <= 8, `sayaç küçülmedi: ${r.stamp}`);
  // Göreli sıra birebir taşınmalı. Seçilmeyen iki damga karşılaştırılıyor:
  // seçilenin değeri zaten bu koşumun damgasına yükseldi.
  assert.ok(r.next[key(1)]! > r.next[key(2)]!, "sıkıştırma göreli sırayı bozdu");
  assert.ok(r.next[key(2)]! < r.stamp, "sıkıştırılmış damga bu koşumun damgasını geçti");
});

// --- 8. GÖÇ: var olan depo dosyası üzerinde --------------------------------

test("göç: ilk-görülme sütunu VAR OLAN depoya geliyor, satırlar duruyor, rotasyon yazabiliyor", () => {
  // CLAUDE.md §7: taze depoda çalışması KANIT DEĞİL. Dosya önce yaratılıp veri
  // konuyor, sonra classify_stamps M4.5 ÖNCESİ şekline birebir geri alınıyor.
  const path = tmpStorePath();
  const ilk = openStore(path);
  const projectId = Number(ilk.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "probe", "/t",
  ).lastInsertRowid);
  const ids = [1, 2].map((i) => appendFinding(ilk, {
    projectId, source: "observed", content: `eski kuşak notu ${i}`,
    anchors: [{ kind: "file_path", value: "src/x.ts" }],
  }));
  ilk.close();

  const eski = new DatabaseSync(path);
  eski.exec("DROP TABLE classify_stamps");
  eski.exec(`CREATE TABLE classify_stamps (
    project_id INTEGER NOT NULL, kind TEXT NOT NULL, a_id INTEGER NOT NULL,
    b_id INTEGER NOT NULL, selected_seq INTEGER NOT NULL,
    PRIMARY KEY (project_id, kind, a_id, b_id))`);
  eski.exec(`INSERT INTO classify_stamps VALUES (${projectId},'cross',${ids[0]},${ids[1]},7)`);
  eski.close();

  const yeni = openStore(path); // göç yolu: var olan dosya üzerinde
  const cols = yeni.all<{ name: string }>("SELECT name FROM pragma_table_info('classify_stamps')").map((c) => c.name);
  assert.ok(cols.includes("first_seen_seq"), "sütun gelmedi: rotasyon her okumada patlar");
  const state = readRotationState(yeni, projectId);
  assert.deepEqual(state.selected, { [`cross:${ids[0]}:${ids[1]}`]: 7 }, "göç satır kaybetti");
  assert.deepEqual(state.seen, {}, "göç uydurma bir ilk-görülme yazdı");
  assert.equal(getFinding(yeni, ids[0]!)!.content, "eski kuşak notu 1", "göç veri kaybetti");

  // Ve yazım yolu var olan dosyada gerçekten çalışıyor (ON CONFLICT dahil).
  const key = `coverage:${ids[0]}:-1`;
  yeni.tx(() => writeClassifyStamps(yeni, projectId, { [key]: 8 }, 8, { seen: { [key]: 8 } }));
  assert.deepEqual(readRotationState(yeni, projectId).seen, { [key]: 8 });
  yeni.tx(() => writeClassifyStamps(yeni, projectId, { [key]: 9 }, 9, { seen: { [key]: 8 } }));
  const after = readRotationState(yeni, projectId);
  assert.equal(after.selected[key], 9, "ON CONFLICT eşleşmedi");
  assert.equal(after.seen[key], 8, "ilk-görülme tazelendi: aday kuyruğun sonuna atılırdı");
  yeni.close();
});

test("göç: eski satırın ilk-görülmesi UYDURULMUYOR, önceliği seçim damgasından geliyor", () => {
  // Göçten gelen satırda first_seen_seq = 0. Bu satır "hiç görülmemiş" sayılıp
  // mutlak önceliğe düşerse, tek bir göç projedeki sırayı tümden karıştırırdı.
  const eskiSatir = cov(1), yeniAday = cov(2);
  const r = selectCandidates([eskiSatir, yeniAday], 1,
    { [candidateIdentity(eskiSatir)]: 5 }, { [candidateIdentity(yeniAday)]: 6 });
  assert.deepEqual(r.taken.map((c) => c.aId), [1], "göç satırı sırasını kaybetti");
});
