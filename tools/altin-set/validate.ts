// Altın set iddia dosyası doğrulayıcı.
//
// Neden var: M3'ün altın set ölçümü ELLE yapılıyordu — sonuç JSON'u ile M0'ın
// Markdown tablosu gözle eşleştiriliyordu. Elle eşleştirme her yeniden ölçümde
// (r1..r5) tekrar edilen bir maliyet ve sessiz bir hata yüzeyi. İddia düzeyine
// geçince kayıt sayısı 28'den ~400'e çıkıyor; gözle eşleştirme artık mümkün değil.
//
// Kullanım: node --experimental-strip-types tools/altin-set/validate.ts <dosya.jsonl> [--expect-notes N]
// Çıkış: 0 geçerli, 1 şema/bütünlük hatası, 2 kullanım hatası.
//
// --expect-notes: kapsanması beklenen not sayısı. Varsayılan 28 (tam altın set).
// Lane başına parça doğrulanırken o lane'in not sayısı verilir — eksik teslimi
// yeşil göstermemek için. Kapsam kontrolü olmayan bir doğrulayıcı, 7 nottan
// 3'ünü etiketleyip kalanını atlayan bir koşumu "temiz" diye onaylar.

import { readFileSync } from "node:fs";

// Dört hüküm. `dogustan-yanlis` bilerek `curuk`tan ayrı (karar: Burak,
// 13 Ağu 2026): çürük sayılsaydı "kod değiştiği için bozuldu" ile "hiç doğru
// değildi" aynı kovaya düşer ve CLAUDE.md §2.4'ün değişim-tetikli tasarımının
// ölçümü bulanıklaşırdı. Ölçüldü: karar not düzeyi skaleri 15/28 → 12/28
// kaydırıyor, yani ayrım kozmetik değil.
// `tarihsel` (karar: Burak, 13 Ağu 2026): notun geçmiş bir arızayı anlatan,
// kendini "aşağısı arızanın kaydı" diye etiketleyen blokları. Ne yakalama ne
// yanlış alarm sayar — paydadan düşer. Gerekçe: denetçinin ölçtüğü şey "bu not
// BUGÜN yanıltıyor mu"; tarihsel bir kayıt yanıltmıyor, arşivliyor.
// BİLİNEN AÇIK: "tarihsel" etiketi notun kendi beyanı, yani bir not yazarı
// etiketleyerek denetimden kaçabilir. Ölçülmedi, kabul edildi.
const VERDICTS = new Set(["gecerli", "curuk", "dogustan-yanlis", "olculemez", "tarihsel"]);

// M0'ın çürüme sözlüğü. Yeni tip icat edilmiyor — tip enflasyonu dağılımı
// karşılaştırılamaz hale getirir.
const DECAY_TYPES = new Set([
  "durum-bayatladi",
  "karar-tersine-dondu",
  "dosya-silindi",
  "sembol-kayboldu",
  "olcum-gecersizlesti",
]);

// Hafıza anlık görüntüsündeki denetlenen not sayısı (MEMORY.md indeks, hariç).
const DEFAULT_EXPECTED_NOTES = 28;

type Claim = {
  note: string;
  claim_id: string;
  line_start: number;
  line_end: number;
  text: string;
  verdict: string;
  decay_type?: string;
  evidence?: string;
  method?: string;
};

const argv = process.argv.slice(2);
const path = argv.find((a) => !a.startsWith("--"));
if (!path) {
  console.error("kullanım: validate.ts <dosya.jsonl> [--expect-notes N]");
  process.exit(2);
}

let expectedNotes = DEFAULT_EXPECTED_NOTES;
const en = argv.indexOf("--expect-notes");
if (en !== -1) {
  const raw = argv[en + 1];
  const n = Number(raw);
  // Sessizce varsayılana düşmek yasak: yanlış yazılmış bir bayrak, kapsam
  // kontrolünü fark edilmeden 28'e çevirir ve lane kabulü anlamsızlaşır.
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--expect-notes tamsayı olmalı, alınan: ${raw}`);
    process.exit(2);
  }
  expectedNotes = n;
}

const errors: string[] = [];
const claims: Claim[] = [];
const seenIds = new Set<string>();

const lines = readFileSync(path, "utf8").split("\n");
for (const [i, raw] of lines.entries()) {
  const lineNo = i + 1;
  if (raw.trim() === "") continue;

  let c: Claim;
  try {
    c = JSON.parse(raw);
  } catch (e) {
    errors.push(`satır ${lineNo}: geçersiz JSON — ${(e as Error).message}`);
    continue;
  }

  const need = ["note", "claim_id", "line_start", "line_end", "text", "verdict"] as const;
  for (const f of need) {
    if (c[f] === undefined || c[f] === null || c[f] === "") {
      errors.push(`satır ${lineNo}: zorunlu alan eksik — ${f}`);
    }
  }

  if (!VERDICTS.has(c.verdict)) {
    errors.push(`satır ${lineNo}: bilinmeyen hüküm — ${c.verdict}`);
  }

  if (seenIds.has(c.claim_id)) {
    errors.push(`satır ${lineNo}: mükerrer claim_id — ${c.claim_id}`);
  }
  seenIds.add(c.claim_id);

  // decay_type YALNIZ çürükte. Geçerli bir iddiada çürüme tipi bulunması,
  // etiketleyicinin hükmü ile gerekçesinin ayrıştığını gösterir.
  if (c.verdict === "curuk") {
    if (!c.decay_type) errors.push(`satır ${lineNo}: curuk ama decay_type yok`);
    else if (!DECAY_TYPES.has(c.decay_type)) {
      errors.push(`satır ${lineNo}: sözlük dışı decay_type — ${c.decay_type}`);
    }
  } else if (c.decay_type) {
    errors.push(`satır ${lineNo}: ${c.verdict} hükmünde decay_type var`);
  }

  // Kanıt zorunluluğu (protokol §4): olculemez dışında hüküm koşturulmuş bir
  // komuta dayanır. Kanıtsız hüküm, tam olarak §2.1'in yasakladığı şey.
  if (c.verdict !== "olculemez") {
    if (!c.evidence) errors.push(`satır ${lineNo}: ${c.verdict} ama evidence yok`);
    if (!c.method) errors.push(`satır ${lineNo}: ${c.verdict} ama method yok`);
  }

  if (!Number.isInteger(c.line_start) || !Number.isInteger(c.line_end)) {
    errors.push(`satır ${lineNo}: satır aralığı tamsayı değil`);
  } else if (c.line_end < c.line_start) {
    errors.push(`satır ${lineNo}: line_end < line_start`);
  }

  claims.push(c);
}

// --- dağılım ---

const byVerdict = new Map<string, number>();
const byDecay = new Map<string, number>();
type NoteTally = { gecerli: number; curuk: number; "dogustan-yanlis": number; olculemez: number; tarihsel: number };
const byNote = new Map<string, NoteTally>();

for (const c of claims) {
  byVerdict.set(c.verdict, (byVerdict.get(c.verdict) ?? 0) + 1);
  if (c.decay_type) byDecay.set(c.decay_type, (byDecay.get(c.decay_type) ?? 0) + 1);
  const n = byNote.get(c.note) ?? { gecerli: 0, curuk: 0, "dogustan-yanlis": 0, olculemez: 0, tarihsel: 0 };
  n[c.verdict as keyof NoteTally] += 1;
  byNote.set(c.note, n);
}

console.log(`dosya: ${path}`);
console.log(`iddia: ${claims.length}`);
console.log(`not:   ${byNote.size} (beklenen ${expectedNotes})`);
if (byNote.size !== expectedNotes) {
  errors.push(`not kapsamı eksik/fazla: ${byNote.size} ≠ ${expectedNotes}`);
}

console.log("\nhüküm dağılımı:");
for (const v of ["gecerli", "curuk", "dogustan-yanlis", "olculemez", "tarihsel"]) {
  const n = byVerdict.get(v) ?? 0;
  const pct = claims.length ? ((n / claims.length) * 100).toFixed(1) : "0.0";
  console.log(`  ${v.padEnd(10)} ${String(n).padStart(4)}  %${pct}`);
}

console.log("\nçürüme tipi:");
for (const [t, n] of [...byDecay].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(22)} ${n}`);
}

console.log("\nnot başına (iddia / çürük / doğuştan-yanlış):");
for (const [note, n] of [...byNote].sort((a, b) => a[0].localeCompare(b[0]))) {
  const total = n.gecerli + n.curuk + n["dogustan-yanlis"] + n.olculemez + n.tarihsel;
  console.log(
    `  ${note.padEnd(36)} ${String(total).padStart(3)} / ${n.curuk} / ${n["dogustan-yanlis"]}`,
  );
}

// Not düzeyi yuvarlama: bir notta en az bir çürük iddia varsa o not "çürük".
// M0'ın ikili etiketiyle karşılaştırma zemini bu — iddia sayısı değişse de
// bu izdüşüm r1..r5 skalerleriyle aynı birimde kalıyor.
//
// İki sayı ayrı basılıyor çünkü ikisi farklı soruyu cevaplıyor: "kaç not
// ÇÜRÜDÜ" (§2.4'ün değişim-tetikli tasarımının ölçümü) ile "kaç not YANLIŞ"
// (denetçinin işaretlemekte haklı olduğu küme). Tek sayıya indirmek 12 ile 15
// arasındaki farkı görünmez yapıyordu.
const decayedNotes = [...byNote.values()].filter((n) => n.curuk > 0).length;
const wrongNotes = [...byNote.values()].filter((n) => n.curuk > 0 || n["dogustan-yanlis"] > 0).length;
console.log(`\nnot düzeyine yuvarlama:`);
console.log(`  çürük (curuk ≥ 1)                    ${decayedNotes}/${byNote.size}`);
console.log(`  yanlış (curuk veya dogustan ≥ 1)     ${wrongNotes}/${byNote.size}`);

if (errors.length) {
  console.error(`\nHATA (${errors.length}):`);
  for (const e of errors.slice(0, 40)) console.error(`  ${e}`);
  if (errors.length > 40) console.error(`  ... +${errors.length - 40} tane daha`);
  process.exit(1);
}

console.log("\ndoğrulama temiz.");
