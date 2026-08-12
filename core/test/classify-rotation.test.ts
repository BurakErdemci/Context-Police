// Aday rotasyonunun ADALETİ. E dalgası (12 Ağu 2026, doğrulama turu 2):
// D dalgasının not başına tuttuğu rotasyon damgası yanlış granülaritedeydi —
// tavanlanan iş birimi ÇİFT. Probe (classification-shared-note-starvation)
// ana ağaçta rc=1 ölçüldü; buradaki ilk test onun terfi edilmiş hâli.
//
// Testlerin iddiası "artık olmuyor" DEĞİL "olamaz": N aday ve M < N tavanla
// her adayın en geç ⌈N/M⌉ koşumda seçildiği doğrulanıyor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { appendFinding, getFinding, listActive } from "../src/store/findings.ts";
import { readClassifyCursors, writeClassifyCursors } from "../src/store/classify-cursors.ts";
import { auditProject } from "../src/audit.ts";
import { selectCandidates, type ClassifyCursors } from "../src/signals/classify.ts";
import type { Candidate } from "../src/signals/contradiction.ts";
import { tmpDir, tmpStorePath, fakeExecutor } from "./helpers.ts";

const cand = (aId: number, bId: number | null, kind: Candidate["kind"] = "cross"): Candidate =>
  ({ kind, aId, bId, reason: "test" });

/** Adayın kimliği — seçim listesindeki konumundan bağımsız. */
const key = (c: Candidate) => `${c.kind}:${c.aId}-${c.bId}`;

/**
 * Rotasyonu `runs` koşum boyunca sürer (imleci koşumdan koşuma taşıyarak) ve
 * her adayın İLK seçildiği koşumu döndürür. Adalet iddiası bunun üzerinden
 * kuruluyor: `firstSeen` tüm adayları kapsamalı ve en büyük değer sınırı
 * aşmamalı.
 */
function rotate(candidates: Candidate[], max: number, runs: number, start: ClassifyCursors = {}) {
  const firstSeen = new Map<string, number>();
  const perRun: Candidate[][] = [];
  let cursors: ClassifyCursors = start;
  for (let run = 1; run <= runs; run++) {
    const { taken, next } = selectCandidates(candidates, max, cursors);
    cursors = next;
    perRun.push(taken);
    for (const c of taken) if (!firstSeen.has(key(c))) firstSeen.set(key(c), run);
  }
  return { firstSeen, perRun, cursors };
}

/** Kapsanmayan adayları ada dökerek raporlar — "hangisi aç kaldı" görünsün. */
function missing(candidates: Candidate[], firstSeen: Map<string, number>): string[] {
  return candidates.map(key).filter((k) => !firstSeen.has(k));
}

// --- probe terfisi: K7 -----------------------------------------------------

/** Her ikilisi ayrı bir çapa paylaşan 7 not → 21 aday (K7 grafiğinin kenarları). */
function k7(): Candidate[] {
  const out: Candidate[] = [];
  for (let a = 1; a <= 7; a++) for (let b = a + 1; b <= 7; b++) out.push(cand(a, b));
  return out;
}

test("K7 (21 aday, tavan 20): tek aç kalan çift ⌈N/M⌉ koşumda ölçülüyor", () => {
  const candidates = k7();
  const bound = Math.ceil(candidates.length / 20); // = 2
  const { firstSeen } = rotate(candidates, 20, bound);
  assert.deepEqual(missing(candidates, firstSeen), [], "sınırda kapsanmayan aday var");
  // Probe'un kendi şekli: 8 koşum. Not başına damgada 6-7 çifti 8 koşumun
  // hepsinde atlanıyordu; burada sınır zaten 2, 8 fazlasıyla içeriyor.
  const uzun = rotate(candidates, 20, 8);
  assert.equal(uzun.firstSeen.size, candidates.length);
  assert.ok(Math.max(...uzun.firstSeen.values()) <= bound, "bir aday sınırdan geç ölçüldü");
});

// --- sınıf kapanışı: aynı kusurun başka biçimleri ---------------------------

test("varyant (yıldız grafiği): merkez not her koşumda ölçülüyor, uçlar aç kalmıyor", () => {
  // 1 numaralı not TÜM çiftlerde var. Not başına damgada merkez her koşumda
  // tazeleniyor ve `rotationKey` max aldığı için bütün çiftler aynı anahtara
  // düşüyordu — sıralama kararlı, dolayısıyla son uçlar hiç sıra alamıyordu.
  const candidates = Array.from({ length: 24 }, (_, i) => cand(1, i + 2));
  const bound = Math.ceil(candidates.length / 20); // = 2
  const { firstSeen } = rotate(candidates, 20, bound);
  assert.deepEqual(missing(candidates, firstSeen), [], "yıldızın uçları aç kaldı");
});

test("varyant (tavan + 1, karışık yüzey): 20 cross + 1 intra, tavan 20", () => {
  const candidates = [
    ...Array.from({ length: 20 }, (_, i) => cand(i + 1, 100 + i)),
    cand(500, null, "intra"),
  ];
  const bound = 2; // her koşum 20 alıyor, 21 aday
  const { firstSeen, perRun } = rotate(candidates, 20, bound);
  assert.deepEqual(missing(candidates, firstSeen), [], "tavanın bir üstünde aç kalan aday var");
  for (const taken of perRun) assert.equal(taken.length, 20, "bütçe boşa gitti");
});

test("varyant (yüzeyler karışık): kota rotasyonu EZMİYOR, ikisi birden geçerli", () => {
  // 30 cross + 20 intra + 20 frontmatter, tavan 20 → kota tam doluyor (8/6/6),
  // yani her koşumda üç yüzey de tam payını alıyor. Adalet yüzey BAŞINA sürüyor:
  // her yüzey kendi listesinde ⌈N_yüzey / kota⌉ koşumda kapanmalı.
  const candidates = [
    ...Array.from({ length: 30 }, (_, i) => cand(i + 1, 200 + i)),
    ...Array.from({ length: 20 }, (_, i) => cand(300 + i, null, "intra")),
    ...Array.from({ length: 20 }, (_, i) => cand(400 + i, null, "frontmatter")),
  ];
  const bound = Math.max(Math.ceil(30 / 8), Math.ceil(20 / 6)); // = 4
  const { firstSeen, perRun } = rotate(candidates, 20, bound);
  assert.deepEqual(missing(candidates, firstSeen), [], "karışık yüzeyde aç kalan aday var");
  for (const taken of perRun) {
    assert.equal(taken.filter((c) => c.kind === "cross").length, 8, "cross payı kaydı");
    assert.equal(taken.filter((c) => c.kind === "intra").length, 6, "intra payı kaydı");
    assert.equal(taken.filter((c) => c.kind === "frontmatter").length, 6, "frontmatter payı kaydı");
  }
});

test("varyant: yüzey kotası rotasyonun ÜSTÜNDE kalır (cross seli intra'yı yutamaz)", () => {
  const candidates: Candidate[] = [
    ...Array.from({ length: 20 }, (_, i) => cand(i + 1, 100 + i)),
    cand(90, null, "intra"), cand(91, null, "intra"),
  ];
  const { taken } = selectCandidates(candidates, 20, { cross: 7 });
  assert.equal(taken.filter((c) => c.kind === "intra").length, 2, "kota rotasyona feda edildi");
});

test("varyant: aday sayısı tavanın altında — rotasyon hiçbir şeyi değiştirmiyor", () => {
  const few = [cand(1, 11), cand(2, 12, "intra")];
  const { taken } = selectCandidates(few, 20, { cross: 3, intra: 9 });
  assert.deepEqual(taken, few);
});

test("seçim, prompt için özgün sırayı korur (imleç sırayı DEĞİL başlangıcı kaydırır)", () => {
  const candidates = Array.from({ length: 5 }, (_, i) => cand(i + 1, 100 + i));
  const { taken } = selectCandidates(candidates, 3, { cross: 3 });
  assert.deepEqual(taken.map((c) => c.aId), [1, 4, 5], "çıktı sırası özgün sıradan koptu");
});

test("depodan gelen bozuk imleç seçimi kilitlemiyor (negatif, kesirli, taşkın)", () => {
  // İmleç dış veri: elle düzenlenmiş ya da eski bir sürümün yazdığı depo.
  const candidates = k7();
  for (const bozuk of [-7, 1.9, 10_000, Number.NaN]) {
    const { firstSeen } = rotate(candidates, 20, 2, { cross: bozuk });
    assert.deepEqual(missing(candidates, firstSeen), [], `bozuk imleç (${bozuk}) aday aç bıraktı`);
  }
});

test("bu koşumda adayı olmayan yüzeyin imleci korunuyor (sıfırlanmıyor)", () => {
  const { next } = selectCandidates([cand(1, 2)], 20, { cross: 0, intra: 4, frontmatter: 9 });
  assert.equal(next.intra, 4, "intra imleci sıfırlandı: yüzey döndüğünde baştakiler ayrıcalıklı olurdu");
  assert.equal(next.frontmatter, 9);
});

// --- depo: imleç kalıcılığı ve VAR OLAN dosya üzerinde şema -------------------

test("şema: classify_cursors VAR OLAN depoya geliyor, veri duruyor, imleç yazılabiliyor", () => {
  // CLAUDE.md §7: taze depoda çalışması KANIT DEĞİL. Dosya önce yaratılıp içine
  // veri konuyor, sonra tablo ELLE düşürülerek eski kuşak birebir üretiliyor.
  const path = tmpStorePath();
  const ilk = openStore(path);
  const projectId = Number(ilk.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(ilk, { projectId, source: "observed", content: "eski kuşak notu" });
  ilk.close();

  const eski = new DatabaseSync(path);
  eski.exec("DROP TABLE classify_cursors");
  // Kaldırılan `last_classified_at` sütunu var olan depolarda DURUYOR: bu kuşak
  // birebir o dosya. Sütunu adıyla anan sorgu kalmadığı iddiası burada ölçülüyor.
  assert.ok(
    (eski.prepare("PRAGMA table_info(findings)").all() as { name: string }[])
      .some((c) => c.name === "last_classified_at") === false,
    "test kurulumu: sütun zaten yok — aşağıda elle ekleniyor",
  );
  eski.exec("ALTER TABLE findings ADD COLUMN last_classified_at TEXT");
  eski.close();

  const yeni = openStore(path); // göç yolu: var olan dosya üzerinde
  assert.ok(
    yeni.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .some((t) => t.name === "classify_cursors"),
    "eksik tablo geri gelmedi: her denetim imleç yazarken patlar",
  );
  assert.equal(getFinding(yeni, findingId)!.content, "eski kuşak notu", "göç veri kaybetti");
  // Ölü sütunlu depoda YAZMA yolu da ayakta mı (INSERT sütunu anmıyor).
  const yeniId = appendFinding(yeni, { projectId, source: "observed", content: "yeni kuşak notu" });
  assert.equal(listActive(yeni, projectId).length, 2);
  assert.equal(getFinding(yeni, yeniId)!.content, "yeni kuşak notu");

  assert.deepEqual(readClassifyCursors(yeni, projectId), {}, "boş depo imleci uydurmuş");
  writeClassifyCursors(yeni, projectId, { cross: 5, intra: 0, frontmatter: 2 });
  writeClassifyCursors(yeni, projectId, { cross: 9, intra: 1, frontmatter: 2 }); // ON CONFLICT yolu
  assert.deepEqual(readClassifyCursors(yeni, projectId), { cross: 9, intra: 1, frontmatter: 2 });
  yeni.close();
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

test("uçtan uca (K7): 21 çiftin HEPSİ iki denetim koşumunda ölçülüyor", async () => {
  const repo = tmpDir("cp-wave-e-k7-");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
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
  for (let run = 0; run < 2; run++) {
    const executor = fakeExecutor([answer, answer, answer]);
    const sum = await auditProject(store, { id: projectId, path: repo, memoryDir: null }, {
      executor, fetch: false, maxClassifyItems: 20,
    });
    total = sum.candidates;
    for (const call of executor.calls) for (const p of pairsInPrompt(call.prompt)) seen.add(p);
  }
  assert.equal(total, 21, "K7 şekli kurulamadı: aday sayısı beklenenden farklı");
  assert.equal(seen.size, 21, `iki koşumda ölçülmeyen çift kaldı (ölçülen: ${seen.size})`);
  store.close();
});

test("uçtan uca: hüküm dönmeyen ZEHİRLİ parti sonraki adayların sırasını kilitlemiyor", async () => {
  // İmleç ölçümün SONUCUNA değil SEÇİMİNE bağlı. Sonuca bağlansaydı, sürekli
  // geçersiz çıktı veren bir parti aynı yerde durup geri kalan adayları
  // sonsuza kadar dışarıda bırakırdı — düzeltilen donmanın aynısı.
  const repo = tmpDir("cp-wave-e-poison-");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
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

  const positions = new Set<number>();
  for (let run = 0; run < 3; run++) {
    await auditProject(store, { id: projectId, path: repo, memoryDir: null }, {
      // Her iki denemede de geçersiz çıktı: hiçbir aday ölçülmüş sayılmıyor.
      executor: fakeExecutor([{ output: "cevap yok" }, { output: "yine yok" }]),
      fetch: false, maxClassifyItems: 1,
    });
    positions.add(readClassifyCursors(store, projectId).cross ?? -1);
  }
  assert.equal(positions.size, 3, `imleç ölçüm başarısızlığında dondu: ${[...positions].join(",")}`);
  store.close();
});
