// İki bağımsız etiketleme geçişini karşılaştırır.
//
// Neden var: M0 §5 Codex–Claude uyuşmazlık oranını şart koşmuştu, hiç
// ölçülmedi. M4'ün çapraz kontrol varsayılanı (açık/kapalı) bu sayıya bağlı;
// ölçmeden koyarsak keyfî olur.
//
// Kullanım:
//   node --experimental-strip-types tools/altin-set/compare.ts <a.jsonl> <b.jsonl>
//
// İKİ AYRI SAYI raporlanır ve bunlar karıştırılmamalı (protokol §6):
//   1. BÖLME uyuşması — iki geçiş aynı iddiaları mı çıkardı?
//   2. HÜKÜM uyuşması — örtüşen iddialarda aynı hükmü mü verdi?
// Bölmede ayrışan iki geçiş hükümde uyuşuyor görünebilir; tek sayıya indirmek
// bu ayrımı yok eder.

import { readFileSync } from "node:fs";

type Claim = {
  note: string;
  claim_id: string;
  line_start: number;
  line_end: number;
  text: string;
  verdict: string;
};

function load(p: string): Claim[] {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Claim);
}

const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) {
  console.error("kullanım: compare.ts <a.jsonl> <b.jsonl>");
  process.exit(2);
}

const A = load(pathA);
const B = load(pathB);

const lineOverlap = (x: Claim, y: Claim) =>
  Math.max(0, Math.min(x.line_end, y.line_end) - Math.max(x.line_start, y.line_start) + 1);

// Satır örtüşmesi TEK BAŞINA yetmiyor — ölçüldü (13 Ağu 2026): yalnız satır
// aralığıyla eşleştirildiğinde 24 "sert çatışma" çıktı, hakemlik turunda
// 14'ünün (%58) aslında AYNI SATIRDAN ÇIKARILMIŞ FARKLI İDDİALAR olduğu
// görüldü. Yani ölçtüğüm uyuşmazlığın çoğunluğu modellerin değil aletin
// ürünüydü. Yoğun bir not tek satırda 5-6 iddia taşıyabiliyor.
//
// Çare: metin benzerliği kapısı. İki iddia ancak satırları örtüşüyor VE
// sözcük kümeleri yeterince benziyorsa aynı iddia sayılıyor.
const STOP = new Set(["ve", "ile", "bir", "bu", "da", "de", "icin", "için", "the", "a", "is", "in", "of", "to"]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLocaleLowerCase("tr")
      .replace(/[^\p{L}\p{N}_./-]+/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

// Jaccard yerine ÖRTÜŞME katsayısı (|A∩B| / min(|A|,|B|)): bir geçiş aynı
// iddiayı daha uzun yazdığında Jaccard haksız yere düşüyor, oysa kısa metin
// uzununun içinde tamamen geçiyorsa bunlar aynı iddiadır.
function textSim(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

// 0.4: elle kalibre edildi. Hakemliğin "kapsam-farki" dediği 14 çiftin
// ayrılması ile gerçek çiftlerin korunması arasındaki denge burada.
// Eşik bir varsayım, ölçüm değil — değiştirilirse sayılar değişir.
const SIM_THRESHOLD = 0.4;

// Not başına, örtüşme büyüklüğüne göre açgözlü bire-bir eşleme.
// Açgözlü, çünkü optimal atama (Hungarian) burada anlamlı fark üretmiyor:
// eşleşmeler zaten satır aralığıyla güçlü biçimde kısıtlı.
type Pair = { a: Claim; b: Claim; ov: number; sim: number };
const pairs: Pair[] = [];
const matchedA = new Set<string>();
const matchedB = new Set<string>();

const notes = new Set([...A.map((c) => c.note), ...B.map((c) => c.note)]);

for (const note of notes) {
  const as = A.filter((c) => c.note === note);
  const bs = B.filter((c) => c.note === note);
  const cand: Pair[] = [];
  for (const a of as) {
    for (const b of bs) {
      const ov = lineOverlap(a, b);
      if (ov <= 0) continue;
      const sim = textSim(a.text, b.text);
      if (sim < SIM_THRESHOLD) continue;
      cand.push({ a, b, ov, sim });
    }
  }
  // Önce metin benzerliği, sonra satır örtüşmesi: aynı satırda birden çok
  // aday varken doğru olanı seçen şey metindir, konum değil.
  cand.sort((x, y) => y.sim - x.sim || y.ov - x.ov || x.a.claim_id.localeCompare(y.a.claim_id));
  for (const p of cand) {
    if (matchedA.has(p.a.claim_id) || matchedB.has(p.b.claim_id)) continue;
    matchedA.add(p.a.claim_id);
    matchedB.add(p.b.claim_id);
    pairs.push(p);
  }
}

const onlyA = A.filter((c) => !matchedA.has(c.claim_id));
const onlyB = B.filter((c) => !matchedB.has(c.claim_id));

console.log(`A: ${pathA}`);
console.log(`B: ${pathB}`);
console.log(`\nA iddia: ${A.length}   B iddia: ${B.length}   ortak not: ${notes.size}`);

console.log("\n── 1. BÖLME uyuşması ─────────────────────────");
console.log(`  eşleşen çift          ${pairs.length}`);
console.log(`  yalnız A'da           ${onlyA.length}`);
console.log(`  yalnız B'de           ${onlyB.length}`);
const splitDen = pairs.length + onlyA.length + onlyB.length;
console.log(`  bölme uyuşması        %${((pairs.length / splitDen) * 100).toFixed(1)}`);

console.log("\n── 2. HÜKÜM uyuşması (yalnız eşleşen çiftlerde) ─");
let same = 0;
const confusion = new Map<string, number>();
for (const p of pairs) {
  if (p.a.verdict === p.b.verdict) same++;
  const k = `${p.a.verdict} → ${p.b.verdict}`;
  confusion.set(k, (confusion.get(k) ?? 0) + 1);
}
console.log(`  aynı hüküm            ${same}/${pairs.length}  %${((same / pairs.length) * 100).toFixed(1)}`);
console.log(`  UYUŞMAZLIK            ${pairs.length - same}  %${(((pairs.length - same) / pairs.length) * 100).toFixed(1)}`);

console.log("\n  karışıklık tablosu (A → B, en sık 12):");
for (const [k, n] of [...confusion].sort((x, y) => y[1] - x[1]).slice(0, 12)) {
  console.log(`    ${k.padEnd(34)} ${n}`);
}

// Not düzeyi uyuşma: bölme farklarına DAYANIKLI ölçü. İki geçiş iddiaları
// farklı bölse bile "bu not çürük mü" sorusunda uyuşabilir — ve altın setin
// M3 ile karşılaştırılabilir birimi tam olarak budur.
console.log("\n── 3. NOT düzeyinde uyuşma (bölmeye dayanıklı) ──");
const roll = (rows: Claim[], note: string, v: string) =>
  rows.some((c) => c.note === note && c.verdict === v);
let agreeDecay = 0;
const noteDiffs: string[] = [];
for (const note of [...notes].sort()) {
  const da = roll(A, note, "curuk");
  const db = roll(B, note, "curuk");
  if (da === db) agreeDecay++;
  else noteDiffs.push(`    ${note.padEnd(36)} A=${da ? "çürük" : "temiz"}  B=${db ? "çürük" : "temiz"}`);
}
console.log(`  "not çürük mü" uyuşması  ${agreeDecay}/${notes.size}  %${((agreeDecay / notes.size) * 100).toFixed(1)}`);
if (noteDiffs.length) {
  console.log("  ayrışan notlar:");
  for (const d of noteDiffs) console.log(d);
}
