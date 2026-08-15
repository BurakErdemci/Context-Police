// M4 ÇIKIŞ KAPISI SKORLAYICISI — hakem çıktısını altın sete karşı ölçer.
//
// Kullanım:
//   node --experimental-strip-types tools/altin-set/score.ts \
//     docs/olcumler/altin-set/golden-v1.jsonl <hakem-ciktisi.jsonl> [maliyet.jsonl]
//
// NEDEN KATI EŞLEME DEĞİL: iki taraf iddiaları farklı bölüyor (ölçüldü,
// 13 Ağu: hakem 3 notta 192 iddia çıkarırken altın set 68 çıkardı, bölme
// uyuşması %9,2). Katı bire-bir eşleme bu farkta yakalamayı olduğundan düşük
// gösterir — ölçtüğü şey doğruluk değil bölme uyumu olur.
//
// Bunun yerine ÖRTÜŞME TOLERANSLI ölçü: altın setin bir hedef iddiası, aynı
// notta satırları örtüşen HERHANGİ bir hakem iddiası da "yanlış" diyorsa
// yakalanmış sayılır. Hakem farklı böldüyse ama aynı yeri yanlış işaretlediyse
// işini yapmıştır.
//
// PAYDA: `curuk` + `dogustan-yanlis`. `olculemez` ve `tarihsel` dışarıda —
// hakem kod olduğu sürece o iddialar ulaşılamaz (CLAUDE.md §2.1), paydaya
// konursa tavan yapay olarak düşer ve denetçi ölçülemeyeni kaçırdığı için
// cezalandırılır.
//
// O PAYDANIN AÇTIĞI DELİK ve neden aşağıda bir sayı daha var: `olculemez`
// paydadan DÜŞTÜĞÜ için her şeye "ölçemedim" diyen dejenere bir hakem kusursuz
// bir yanlış-alarm oranı alır — sıfır yanlış alarm, çünkü hiç hüküm vermemiş.
// Kapının üç sayısı bu yüzden TEK BAŞINA okunamaz olmalı: aynı blokta,
// kullanıcıya devredilen (`olculemez` + `user_resolvable`) iddia sayısı da
// basılıyor. Üç sayının hesabı DEĞİŞMEDİ; yanına ne kadarının puntolandığı
// yazılıyor.

import { readFileSync } from "node:fs";

type Claim = {
  note: string; claim_id?: string; line_start: number; line_end: number;
  text: string; verdict: string;
  /** `olculemez` alt sebebi; `user_resolvable` = kullanıcı çözebilir (adjudicate-lib.ts). */
  unmeasurable_reason?: string;
};

const [goldenPath, actualPath, costPath] = process.argv.slice(2);
if (!goldenPath || !actualPath) {
  console.error("kullanım: score.ts <golden.jsonl> <hakem.jsonl> [maliyet.jsonl]");
  process.exit(2);
}

const L = (p: string): Claim[] =>
  readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const G = L(goldenPath);
const H = L(actualPath);
const WRONG = new Set(["curuk", "dogustan-yanlis"]);
const overlaps = (a: Claim, b: Claim) =>
  a.note === b.note &&
  Math.max(0, Math.min(a.line_end, b.line_end) - Math.max(a.line_start, b.line_start) + 1) > 0;

// Yalnız hakemin GERÇEKTEN baktığı notlar puanlanır. Bir not hiç
// denetlenmediyse onu kaçırmak hakemin değil sıralamanın sorunudur; ikisini
// karıştırmak hangi katmanın kusurlu olduğunu gizler.
//
// Coverage comes from the cost log's ATTEMPTED notes, not from the judge's own
// output: "never adjudicated" and "adjudicated and produced nothing" are not the
// same thing. Measured 15 Aug 2026 — an opencode run lost 6 notes to
// `parse_failed`, their 19 targets left the denominator, and recall read
// 12/41 = 29.3% instead of 12/60 = 20.0%. That inflated number reached a report.
const attempted = new Set<string>(
  costPath
    ? readFileSync(costPath, "utf8").split("\n").filter((l) => l.trim())
        .map((l) => JSON.parse(l).note)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0)
    : [],
);
if (!costPath) {
  console.error(
    "UYARI: maliyet günlüğü verilmedi — kapsam yalnız hakem çıktısından türetiliyor.\n" +
    "  Hakemin çuvalladığı notlar paydadan düşer, yani oran olduğundan yüksek çıkar.\n" +
    "  Üçüncü argüman olarak <hakem>-maliyet.jsonl verin.",
  );
}
const covered = new Set([...H.map((h) => h.note), ...attempted]);
const gCovered = G.filter((g) => covered.has(g.note));
const skipped = [...new Set(G.map((g) => g.note))].filter((n) => !covered.has(n));
// Attempted, produced nothing. Stays in the denominator, and is printed
// separately: as this count grows, what needs questioning is the instrument's
// health rather than the judge's verdicts.
const barren = [...attempted].filter((n) => !H.some((h) => h.note === n)).sort();

const targets = gCovered.filter((g) => WRONG.has(g.verdict));
const caught = targets.filter((g) => H.some((h) => overlaps(g, h) && WRONG.has(h.verdict)));

// Yanlış alarm: hakem "yanlış" demiş, ama üstüne binen altın iddiaların
// HİÇBİRİ yanlış değil. "Örtüşen hiç altın iddia yok" durumu yanlış alarm
// SAYILMAZ — altın set eksik kapsamlı olabilir (Codex geçişinin eşleşmeyen
// 394 iddiası dışarıda kaldı), o boşluğu hakemin sırtına yıkmak haksız olur.
const gValid = gCovered.filter((g) => g.verdict === "gecerli");
const falseAlarms = H.filter(
  (h) => WRONG.has(h.verdict) &&
    gValid.some((g) => overlaps(g, h)) &&
    !gCovered.some((g) => overlaps(g, h) && WRONG.has(g.verdict)),
);

// Kullanıcıya devredilen iddialar: skorun paydasına GİRMİYORLAR, o yüzden
// sayıları raporun birinci sınıf parçası. Alanın YOKLUĞU sıradan `olculemez`
// demek (eski çıktılar ve `not_measurable` böyle okunur).
const userResolvable = H.filter((h) => h.verdict === "olculemez" && h.unmeasurable_reason === "user_resolvable");
const userResolvableNotes = new Set(userResolvable.map((h) => h.note));

const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) : "—");

console.log(`altın set : ${goldenPath}`);
console.log(`hakem     : ${actualPath}`);
console.log(`\nkapsanan not: ${covered.size}/${new Set(G.map((g) => g.note)).size}` +
  (skipped.length ? `  (denetlenmeyen: ${skipped.join(", ")})` : ""));
if (barren.length) {
  console.log(`  bunların ${barren.length}'i DENENDİ ama tek iddia üretemedi (payda İÇİNDE): ` +
    barren.join(", "));
}
console.log(`hakem iddiası: ${H.length}   altın iddia (kapsanan notlarda): ${gCovered.length}`);

console.log(`\n── ÇIKIŞ KAPISI ─────────────────────────`);
console.log(`  YAKALAMA      ${caught.length}/${targets.length}   %${pct(caught.length, targets.length)}`);
console.log(`  YANLIŞ ALARM  ${falseAlarms.length}   (geçerli altın iddia: ${gValid.length})`);
console.log(`  KULLANICIYA   ${userResolvable.length}   (olculemez · kullanıcı çözebilir, ${userResolvableNotes.size} notta` +
  ` — PAYDA DIŞI: yukarıdaki üç sayı bunları hiç görmez)`);

const missed = targets.filter((g) => !caught.includes(g));
if (missed.length) {
  console.log(`\nkaçan hedef iddialar (${missed.length}):`);
  const byNote = new Map<string, Claim[]>();
  for (const m of missed) byNote.set(m.note, [...(byNote.get(m.note) ?? []), m]);
  for (const [note, ms] of [...byNote].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${note}  (${ms.length})`);
    for (const m of ms.slice(0, 4)) console.log(`      :${m.line_start}  ${m.text.slice(0, 72)}`);
  }
}

if (falseAlarms.length) {
  console.log(`\nyanlış alarmlar (${falseAlarms.length}):`);
  for (const f of falseAlarms.slice(0, 10)) {
    console.log(`  ${f.note}:${f.line_start}  [${f.verdict}]  ${f.text.slice(0, 66)}`);
  }
}

// Not düzeyine yuvarlama: M3'ün 6/17'siyle AYNI BİRİMDE tek sayı. İddia
// düzeyi ölçüt daha iyi, ama karşılaştırma zemini olmadan "ilerledik mi"
// sorusu cevapsız kalır.
const gNotes = [...new Set(gCovered.map((g) => g.note))];
const decayedNotes = gNotes.filter((n) => gCovered.some((g) => g.note === n && WRONG.has(g.verdict)));
const flagged = decayedNotes.filter((n) => H.some((h) => h.note === n && WRONG.has(h.verdict)));
const cleanNotes = gNotes.filter((n) => !decayedNotes.includes(n));
// Derived from the claim-level set, never recomputed. The earlier rule here
// skipped the overlap test, so a flag with no golden claim under it counted as
// a false alarm — the exemption the claim-level rule grants deliberately. The
// two numbers printed under the same name measured different things and were
// neither subset nor superset of each other.
const falseFlagged = cleanNotes.filter((n) => falseAlarms.some((f) => f.note === n));
console.log(`\n── not düzeyine yuvarlama (M3 ile aynı birim) ──`);
console.log(`  yakalama      ${flagged.length}/${decayedNotes.length}   %${pct(flagged.length, decayedNotes.length)}   (M3: 6/17 = %35,3)`);
console.log(`  yanlış alarm  ${falseFlagged.length}/${cleanNotes.length}                (M3: 0/11)`);
console.log(`  kullanıcıya   ${gNotes.filter((n) => userResolvableNotes.has(n)).length}/${gNotes.length}                (payda dışı)`);
