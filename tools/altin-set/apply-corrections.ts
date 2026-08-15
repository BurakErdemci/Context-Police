// ALTIN SET DÜZELTME UYGULAYICISI — v1 + öneri dosyası -> v2.
//
// Kullanım:
//   node --experimental-strip-types tools/altin-set/apply-corrections.ts \
//     docs/olcumler/altin-set/golden-v1.jsonl \
//     docs/olcumler/altin-set/golden-v1-duzeltme-onerisi.jsonl \
//     docs/olcumler/altin-set/golden-v2.jsonl
//
// NEDEN HEPSİ YA DA HİÇBİRİ: kısmen uygulanmış bir altın set aşağıdaki her
// ölçümü sessizce yanlış puanlar — dosya tam görünür, sayılar yanlış çıkar.
// Bu depo bu sınıftan (kısa/yarım dosya) dört kez yandı. O yüzden tek bir
// başarısız savdan sonra bile ÇIKTI DOSYASI HİÇ YAZILMAZ; bulunan tüm
// sorunlar birlikte raporlanır ki tur sayısı bire insin.

import { readFileSync, writeFileSync } from "node:fs";

type Claim = {
  note: string; claim_id: string; line_start: number; line_end: number;
  text: string; verdict: string; decay_type?: string;
  evidence?: string; method?: string;
  [k: string]: unknown;
};

type Op = Record<string, any> & { islem?: string; _yorum?: string };

const [goldenPath, proposalPath, outPath] = process.argv.slice(2);
if (!goldenPath || !proposalPath || !outPath) {
  console.error("kullanım: apply-corrections.ts <golden.jsonl> <oneri.jsonl> <cikti.jsonl>");
  process.exit(2);
}

const readJsonl = <T>(p: string): T[] =>
  readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l) as T; } catch (e) {
      console.error(`${p}:${i + 1} JSON çözülemedi: ${(e as Error).message}`);
      process.exit(2);
    }
  });

const golden = readJsonl<Claim>(goldenPath);
const proposal = readJsonl<Op>(proposalPath);

const errors: string[] = [];
const byId = new Map<string, Claim>();
for (const c of golden) {
  if (c.claim_id) byId.set(c.claim_id, c);
}

/** Aynı notta aynı yeri aynı metinle iki kez etiketlememek için kimlik. */
const identity = (note: string, ls: unknown, le: unknown, text: unknown) =>
  `${note}\0${ls}\0${le}\0${text}`;
const seen = new Set(golden.map((c) => identity(c.note, c.line_start, c.line_end, c.text)));

// Not başına kullanılmış en büyük sayısal sonek. `#18a`/`#18b` gibi elle
// bölünmüş kimlikler var (unity-architect-mimari, `policy: bolundu`), o yüzden
// sonek katı `\d+$` ile değil BAŞTAKİ rakamlarla okunuyor — yoksa 18a görülmez
// ve sentezlenen kimlik #18'e çakışabilir.
const maxSuffix = new Map<string, number>();
for (const c of golden) {
  const m = /#(\d+)/.exec(c.claim_id ?? "");
  if (!m) continue;
  const n = Number(m[1]);
  maxSuffix.set(c.note, Math.max(maxSuffix.get(c.note) ?? 0, n));
}

/** `decay_type`'ı `verdict`'in hemen ardına koyar; alan sırası v1 ile aynı kalsın diye. */
function setDecayType(c: Claim, decayType: string): Claim {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === "decay_type") continue;
    out[k] = v;
    if (k === "verdict") out.decay_type = decayType;
  }
  return out as Claim;
}

const additions = new Map<string, Claim[]>();
const counts = { "anchor-duzelt": 0, "etiket-degistir": 0, ekle: 0, _yorum: 0 };

proposal.forEach((op, i) => {
  const where = `${proposalPath}:${i + 1}`;
  if ("_yorum" in op) { counts._yorum++; return; }

  const locate = (): Claim | null => {
    const c = op.claim_id ? byId.get(op.claim_id) : undefined;
    if (!c) { errors.push(`${where} ${op.islem}: claim_id '${op.claim_id}' altın sette yok`); return null; }
    return c;
  };

  // EŞLEME ÖLÇÜTÜNÜN KENDİSİ DOĞRULANIR. `claim_id` iki dosyayı birbirine
  // bağlayan tek anahtar; kayarsa hüküm SESSİZCE yanlış iddiaya uygulanır ve
  // aşağıdaki hiçbir katman bunu göremez. Ölçüldü (14 Ağu): iki kaynağı
  // karşılaştıran bir ölçümde eşleme ölçütü doğrulanmayınca aletin kendi
  // hatası %58, gerçek sinyal %12,5 çıktı. O yüzden öneri, hedef hakkında ne
  // söylüyorsa hepsi bulunan kayda karşı sınanır.
  //
  // KARŞILAŞTIRMA TAM: `text` normalleştirilmeden, birebir. Tutması için
  // gevşetilmiş bir karşılaştırma hiçbir şey ölçmez.
  const assertField = (c: Claim, field: string, expected: unknown): boolean => {
    if (c[field] === expected) return true;
    errors.push(`${where} ${op.islem} ${op.claim_id}: '${field}' uyuşmuyor — altın sette ${JSON.stringify(c[field])}, öneri ${JSON.stringify(expected)} bekliyor`);
    return false;
  };
  // A missing `verdict` is not merely wrong, it is INVISIBLE: `undefined` is
  // assigned, `JSON.stringify` drops the key, and `score.ts` stops counting the
  // claim at all (`WRONG.has(undefined)` is false) — the target evaporates from
  // the golden set and the denominator of every later measurement shifts.
  const isVerdict = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  /** Alanların HEPSİ sınanır (ilkinde durulmaz): tek koşumda tam tablo çıksın. */
  const assertAll = (c: Claim, pairs: [string, unknown][]): boolean =>
    pairs.filter(([f, v]) => !assertField(c, f, v)).length === 0;

  switch (op.islem) {
    case "anchor-duzelt": {
      const c = locate();
      if (!c) return;
      // `text` is required here, exactly as in `etiket-degistir`. Measured
      // (15 Aug 2026): without it a proposal whose `claim_id` had slipped to a
      // NEIGHBOURING claim sharing note+lines+verdict was applied to the wrong
      // record, silently, exit 0. And the presence check is separate on
      // purpose — if `text` were simply passed through when absent, the
      // comparison would only ever be `undefined === undefined` and measure
      // nothing.
      if (typeof op.text !== "string" || !op.text) {
        errors.push(`${where} anchor-duzelt ${op.claim_id}: 'text' zorunlu ve boş olmayan string olmalı — hedefi komşusundan ayıran tek alan o`);
        return;
      }
      if (!assertAll(c, [
        ["note", op.note],
        ["line_start", op.old_line_start],
        ["line_end", op.old_line_end],
        ["text", op.text],
        ["verdict", op.verdict],
      ])) return;
      if (typeof op.new_line_start !== "number" || typeof op.new_line_end !== "number") {
        errors.push(`${where} anchor-duzelt ${op.claim_id}: 'new_line_start'/'new_line_end' number olmalı, ${JSON.stringify(op.new_line_start)}/${JSON.stringify(op.new_line_end)} geldi`);
        return;
      }
      c.line_start = op.new_line_start;
      c.line_end = op.new_line_end;
      counts["anchor-duzelt"]++;
      return;
    }

    case "etiket-degistir": {
      const c = locate();
      if (!c) return;
      if (!assertAll(c, [
        ["note", op.note],
        ["line_start", op.line_start],
        ["line_end", op.line_end],
        ["text", op.text],
        ["verdict", op.old_verdict],
      ])) return;
      if (!isVerdict(op.new_verdict)) {
        errors.push(`${where} etiket-degistir ${op.claim_id}: 'new_verdict' boş olmayan string olmalı, ${JSON.stringify(op.new_verdict)} geldi`);
        return;
      }
      c.verdict = op.new_verdict;
      if (op.decay_type) byId.set(op.claim_id, replaceInPlace(c, setDecayType(c, op.decay_type)));
      counts["etiket-degistir"]++;
      return;
    }

    case "ekle": {
      // Burada sınanacak bir HEDEF KAYIT yok — `ekle` yeni bir iddia üretir.
      // Önerinin `note` alanı da altın sete karşı sınanamaz: notun v1'de hiç
      // iddiası olmaması meşru bir durum (o zaman kayıt sona eklenir). Geriye
      // doğrulanabilir iki şey kalıyor: `old_verdict` gerçekten null mı, ve
      // aynı yer+metin zaten etiketli mi.
      // No target record exists to compare against, so the op's OWN shape is
      // the only thing that can be checked. It has to be: these four fields go
      // straight into a synthesised claim, and any `undefined` among them is
      // dropped by `JSON.stringify` instead of failing loudly.
      // `note` is checked first because every message below interpolates it,
      // and because it was the one of the four left unchecked: the verification
      // round produced a claim with `claim_id:"undefined#1"` and no `note` key
      // at all, which nothing downstream can attach to a note.
      if (typeof op.note !== "string" || !op.note) {
        errors.push(`${where} ekle: 'note' boş olmayan string olmalı, ${JSON.stringify(op.note)} geldi`);
        return;
      }
      if (op.old_verdict !== null) {
        errors.push(`${where} ekle ${op.note}:${op.line_start}: old_verdict null olmalı, '${op.old_verdict}' geldi`);
        return;
      }
      if (typeof op.line_start !== "number" || typeof op.line_end !== "number") {
        errors.push(`${where} ekle ${op.note}: 'line_start'/'line_end' number olmalı, ${JSON.stringify(op.line_start)}/${JSON.stringify(op.line_end)} geldi`);
        return;
      }
      if (typeof op.text !== "string" || !op.text) {
        errors.push(`${where} ekle ${op.note}:${op.line_start}: 'text' boş olmayan string olmalı, ${JSON.stringify(op.text)} geldi`);
        return;
      }
      if (!isVerdict(op.new_verdict)) {
        errors.push(`${where} ekle ${op.note}:${op.line_start}: 'new_verdict' boş olmayan string olmalı, ${JSON.stringify(op.new_verdict)} geldi`);
        return;
      }
      const id = identity(op.note, op.line_start, op.line_end, op.text);
      if (seen.has(id)) {
        errors.push(`${where} ekle ${op.note}:${op.line_start}-${op.line_end}: aynı yer ve aynı metin zaten etiketli — sessiz atlama değil hata`);
        return;
      }
      seen.add(id);
      const n = (maxSuffix.get(op.note) ?? 0) + 1;
      maxSuffix.set(op.note, n);
      const rec: Claim = {
        note: op.note,
        claim_id: `${op.note}#${n}`,
        line_start: op.line_start,
        line_end: op.line_end,
        text: op.text,
        verdict: op.new_verdict,
        // `reason` BİLEREK taşınmıyor: o, raporun gerekçesi; iddianın parçası değil.
        ...(op.decay_type ? { decay_type: op.decay_type } : {}),
        ...(op.evidence !== undefined ? { evidence: op.evidence } : {}),
        ...(op.method !== undefined ? { method: op.method } : {}),
      };
      additions.set(op.note, [...(additions.get(op.note) ?? []), rec]);
      counts.ekle++;
      return;
    }

    default:
      errors.push(`${where}: bilinmeyen islem '${op.islem}'`);
  }
});

/** Diziden bir kaydı yenisiyle değiştirir (alan sırası korunan kopya için). */
function replaceInPlace(oldRec: Claim, newRec: Claim): Claim {
  golden[golden.indexOf(oldRec)] = newRec;
  return newRec;
}

if (errors.length) {
  console.error(`\n${errors.length} sorun — HİÇBİR ŞEY YAZILMADI (${outPath} oluşturulmadı):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

// Sıralama: v1 kayıtları özgün sırasında, düzeltmeler yerinde. Her `ekle`,
// aynı notun v1'deki SON iddiasının hemen ardına, öneri dosyasındaki sırayla
// blok halinde giriyor — diff v1'e karşı okunabilir kalsın diye.
const lastIndexOfNote = new Map<string, number>();
golden.forEach((c, i) => lastIndexOfNote.set(c.note, i));

const out: Claim[] = [];
golden.forEach((c, i) => {
  out.push(c);
  if (lastIndexOfNote.get(c.note) === i) {
    const add = additions.get(c.note);
    if (add) { out.push(...add); additions.delete(c.note); }
  }
});
// v1'de hiç iddiası olmayan notlar sona eklenir.
for (const add of additions.values()) out.push(...add);

writeFileSync(outPath, out.map((c) => JSON.stringify(c)).join("\n") + "\n");

console.error(`altın set : ${goldenPath}  (${golden.length} iddia)`);
console.error(`öneri     : ${proposalPath}  (${proposal.length} kayıt, ${counts._yorum} yorum)`);
console.error(`\n  anchor-duzelt    ${counts["anchor-duzelt"]}`);
console.error(`  etiket-degistir  ${counts["etiket-degistir"]}`);
console.error(`  ekle             ${counts.ekle}`);
console.error(`\nyazıldı: ${outPath}  (${out.length} iddia)`);
