// M4 ÇIKIŞ KAPISI SKORLAYICISI — hakem çıktısını altın sete karşı ölçer.
//
// Kullanım:
//   node --experimental-strip-types tools/altin-set/score.ts \
//     docs/olcumler/altin-set/golden-v1.jsonl <hakem-ciktisi.jsonl>
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

import { readFileSync } from "node:fs";

type Claim = {
  note: string; claim_id?: string; line_start: number; line_end: number;
  text: string; verdict: string;
};

const [goldenPath, actualPath] = process.argv.slice(2);
if (!goldenPath || !actualPath) {
  console.error("kullanım: score.ts <golden.jsonl> <hakem.jsonl>");
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
const covered = new Set(H.map((h) => h.note));
const gCovered = G.filter((g) => covered.has(g.note));
const skipped = [...new Set(G.map((g) => g.note))].filter((n) => !covered.has(n));

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

const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) : "—");

console.log(`altın set : ${goldenPath}`);
console.log(`hakem     : ${actualPath}`);
console.log(`\nkapsanan not: ${covered.size}/${new Set(G.map((g) => g.note)).size}` +
  (skipped.length ? `  (denetlenmeyen: ${skipped.join(", ")})` : ""));
console.log(`hakem iddiası: ${H.length}   altın iddia (kapsanan notlarda): ${gCovered.length}`);

console.log(`\n── ÇIKIŞ KAPISI ─────────────────────────`);
console.log(`  YAKALAMA      ${caught.length}/${targets.length}   %${pct(caught.length, targets.length)}`);
console.log(`  YANLIŞ ALARM  ${falseAlarms.length}   (geçerli altın iddia: ${gValid.length})`);

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
const falseFlagged = cleanNotes.filter((n) => H.some((h) => h.note === n && WRONG.has(h.verdict)));
console.log(`\n── not düzeyine yuvarlama (M3 ile aynı birim) ──`);
console.log(`  yakalama      ${flagged.length}/${decayedNotes.length}   %${pct(flagged.length, decayedNotes.length)}   (M3: 6/17 = %35,3)`);
console.log(`  yanlış alarm  ${falseFlagged.length}/${cleanNotes.length}                (M3: 0/11)`);
