// Hakem kapısının ERİŞİLEBİLİR TAVANINI ölçer.
//
// Neden var: M4'te mekanik skor artık hüküm vermeyecek, hakeme kapı açacak.
// Ama kapının altında kalan bir not hakemi HİÇ görmez — hakem kusursuz olsa
// bile o nottaki hedef iddialar yakalanamaz. Yani hakemin doğruluğunu
// ölçmeden önce, kapının önüne koyduğu tavanı bilmek gerekiyor.
//
// Bu ölçüm inşadan ÖNCE koşulur: tavan düşükse sorun hakemde değil kapıdadır
// ve önce kapı düzeltilmelidir.
//
// Kullanım:
//   node --experimental-strip-types tools/altin-set/gate-ceiling.ts \
//     docs/olcumler/altin-set/golden-v1.jsonl \
//     docs/olcumler/altin-set/r3-note-scores.json

import { readFileSync } from "node:fs";

type Claim = { note: string; verdict: string; claim_id: string };

const [goldenPath, scoresPath] = process.argv.slice(2);
if (!goldenPath || !scoresPath) {
  console.error("kullanım: gate-ceiling.ts <golden.jsonl> <scores.json>");
  process.exit(2);
}

const claims: Claim[] = readFileSync(goldenPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const scores: Record<string, number> = JSON.parse(readFileSync(scoresPath, "utf8")).skorlar;

// Hedef küme: denetçinin yakalamakla YÜKÜMLÜ olduğu iddialar.
// olculemez ve tarihsel dışarıda — hakem kod olduğu sürece ulaşılamazlar,
// paydaya konursa tavan yapay olarak düşer.
const TARGET = new Set(["curuk", "dogustan-yanlis"]);
const targets = claims.filter((c) => TARGET.has(c.verdict));

// Kapsama sağlaması: skoru bilinmeyen bir not sessizce "0" sayılırsa tavan
// olduğundan düşük çıkar ve yanlış bir mimari karara yol açar.
const missing = [...new Set(claims.map((c) => c.note))].filter((n) => !(n in scores));
if (missing.length) {
  console.error(`HATA: skoru bilinmeyen not: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`altın set: ${claims.length} iddia · ${new Set(claims.map((c) => c.note)).size} not`);
console.log(`hedef küme (curuk + dogustan-yanlis): ${targets.length} iddia\n`);

const noteCount = new Set(claims.map((c) => c.note)).size;

console.log("eşik │ hakeme giden not │ ERİŞİLEBİLİR hedef iddia │ tavan");
console.log("─────┼──────────────────┼──────────────────────────┼───────");

const thresholds = [0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0];
for (const t of thresholds) {
  const sent = new Set(Object.entries(scores).filter(([, s]) => s >= t).map(([n]) => n));
  const reachable = targets.filter((c) => sent.has(c.note)).length;
  const pct = ((reachable / targets.length) * 100).toFixed(1);
  console.log(
    `${t.toFixed(1)}  │ ${String(sent.size).padStart(2)}/${noteCount}            │ ` +
      `${String(reachable).padStart(2)}/${targets.length}                    │ %${pct}`,
  );
}

// Kapının altında kalan hedef iddialar, not başına: hangi notu kaçırmak
// kaça mal oluyor. Eşik kararı bu dağılıma bakarak verilmeli, toplam sayıya
// değil — tek bir yoğun not tavanı tek başına taşıyabiliyor.
console.log("\nhedef iddiaların not başına dağılımı (skor sırasına göre):");
const byNote = new Map<string, number>();
for (const c of targets) byNote.set(c.note, (byNote.get(c.note) ?? 0) + 1);
const rows = [...byNote].sort((a, b) => (scores[b[0]] ?? 0) - (scores[a[0]] ?? 0) || b[1] - a[1]);
let cum = 0;
for (const [note, n] of rows) {
  cum += n;
  const s = scores[note] ?? 0;
  const bar = s >= 0.6 ? "M3 kapısı geçiyor" : s >= 0.4 ? "0,4 kapısı geçer" : "düşük";
  console.log(
    `  ${s.toFixed(2)}  ${note.padEnd(36)} ${String(n).padStart(2)} iddia  (kümülatif ${cum})  ${bar}`,
  );
}
