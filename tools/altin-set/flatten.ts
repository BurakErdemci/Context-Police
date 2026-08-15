// Raw adjudicator output -> the flat per-claim JSONL that `score.ts` eats.
//
// WHY THIS EXISTS: `adjudicate-cost.ts` writes one cost row per note plus the
// model's raw stream to `<out>.<note>.raw.jsonl`. Nothing turned those raws
// into the flat per-claim file the scorer reads — that file was produced by
// hand, once. The measured consequence (15 Aug 2026): `gateClaims()` started
// emitting `unmeasurable_reason`/`user_question`, but no repo path carried
// them to `score.ts`, so its `KULLANICIYA` counter silently read 0 and the
// exit gate's leak guard did not guard anything.
//
// Usage:
//   node --experimental-strip-types tools/altin-set/flatten.ts \
//     <notes-dir> <adjudicate-out.jsonl> <flat-out.jsonl>
//
// The second argument is the SAME path that was handed to `adjudicate-cost.ts`;
// the raw files are discovered from its directory and basename, so the two
// tools cannot drift on where the raws live, and its per-note rows carry the
// `born_wrong_available` branch each note actually ran under.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { authorshipBound, extractGatedClaims } from "./adjudicate-lib.ts";

const RAW_SUFFIX = ".raw.jsonl";

const [notesDirArg, outPathArg, flatPathArg] = process.argv.slice(2);
if (!notesDirArg || !outPathArg || !flatPathArg) {
  console.error("kullanım: flatten.ts <notlar-dizini> <adjudicate-cikti.jsonl> <duz-cikti.jsonl>");
  process.exit(2);
}
const notesDir: string = notesDirArg;
const outPath: string = outPathArg;
const flatPath: string = flatPathArg;

const rawDir = dirname(outPath);
const rawPrefix = `${basename(outPath)}.`;

type FlatClaim = Record<string, unknown> & {
  note: string; claim_id: string; line_start: number; line_end: number;
  text: string; verdict: string;
};

const errors: string[] = [];

/** Derive the note name from `<base>.<note>.raw.jsonl`; null if the name is not ours. */
function noteFromFilename(file: string): string | null {
  if (!file.startsWith(rawPrefix) || !file.endsWith(RAW_SUFFIX)) return null;
  const note = file.slice(rawPrefix.length, file.length - RAW_SUFFIX.length);
  return note === "" ? null : note;
}

function listRaws(dir: string): { file: string; note: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => ({ file, note: noteFromFilename(file) }))
    .filter((r): r is { file: string; note: string } => r.note !== null)
    .sort((a, b) => a.note.localeCompare(b.note));
}

// `incomplete/` IS NOT SCORED — and the exclusion is announced, not silent.
// A truncated run's partial claim set makes the note look "audited" to
// `score.ts` (coverage is inferred from the note appearing in the adjudicator
// file), so every target claim the run never reached counts as MISSED and the
// catch rate drops for a reason that has nothing to do with adjudication
// quality. See the "EKSİK ÇIKTI SÖZLEŞMESİ" block in adjudicate-cost.ts.
// Excluded notes belong in the scorer's "denetlenmeyen" list instead.
const incomplete = listRaws(join(rawDir, "incomplete"));
for (const { note } of incomplete) {
  console.error(`atlandı (eksik koşum, incomplete/): ${note}`);
}

const complete = listRaws(rawDir);
if (complete.length === 0) {
  console.error(`ham çıktı bulunamadı: ${join(rawDir, `${rawPrefix}<not>${RAW_SUFFIX}`)}`);
  process.exit(1);
}

// The branch each note ACTUALLY ran under, as recorded by adjudicate-cost.ts.
// Absent for runs that predate the field — those fall back to the note body.
const recordedBranch = new Map<string, boolean>();
if (!existsSync(outPath)) {
  console.error(`maliyet dosyası yok: ${outPath}`);
  process.exit(1);
}
readFileSync(outPath, "utf8").split("\n").filter((l) => l.trim()).forEach((line, i) => {
  let row: unknown;
  try { row = JSON.parse(line); } catch {
    errors.push(`maliyet dosyası satır ${i + 1}: ayrıştırılamadı`);
    return;
  }
  const rec = row as Record<string, unknown>;
  if (typeof rec.note !== "string" || typeof rec.born_wrong_available !== "boolean") return;
  const prev = recordedBranch.get(rec.note);
  if (prev !== undefined && prev !== rec.born_wrong_available) {
    errors.push(`${rec.note}: maliyet dosyasında ÇELİŞEN iki kayıtlı dal — hangi koşum ölçüldü belirsiz`);
    return;
  }
  recordedBranch.set(rec.note, rec.born_wrong_available);
});

const rows: FlatClaim[] = [];

for (const { file, note } of complete) {
  // The gate branch is a RECORDED FACT first, a recomputation only as
  // fallback. Recomputing decides `dogustan-yanlis`'s fate from the note body
  // as it stands TODAY, while the raw output was produced under the body as it
  // stood at adjudication time; if the body gained or lost a date in between,
  // `gateClaims(..., false)` rewrites real `dogustan-yanlis` verdicts into
  // `olculemez` and those targets vanish from the scored file with no error.
  const recorded = recordedBranch.get(note);
  const notePath = join(notesDir, `${note}.md`);
  const computed = existsSync(notePath)
    ? authorshipBound(readFileSync(notePath, "utf8")) !== null
    : null;

  if (recorded !== undefined && computed !== null && recorded !== computed) {
    // The note moved out from under its own measurement. Neither side is
    // preferred: the raw output belongs to the old branch, the note belongs to
    // the new one, and the honest answer is to re-adjudicate.
    errors.push(
      `${note}: kayıtlı dal (born_wrong_available=${recorded}) not gövdesiyle ÇELİŞİYOR ` +
      `(bugün ${computed}) — not ölçümünün ALTINDAN değişmiş, yeniden hakem koşumu gerekiyor`);
    continue;
  }
  const bornWrongAvailable = recorded ?? computed;
  if (bornWrongAvailable === null) {
    // Only reachable on the fallback path: no recorded branch AND no body, so
    // there is nothing to derive the gate from. Guessing would silently rewrite
    // verdicts the scorer counts.
    errors.push(`${note}: kayıtlı dal yok ve not gövdesi de yok (${notePath}) — kapı belirlenemiyor`);
    continue;
  }

  const claims = extractGatedClaims(readFileSync(join(rawDir, file), "utf8"), bornWrongAvailable);
  if (claims === null) {
    // Reported and fatal, never skipped: a short flat file scores as if these
    // notes were clean, which is the exact failure class this repo keeps hitting.
    errors.push(`${note}: ham çıktı ayrıştırılamadı (${file})`);
    continue;
  }

  claims.forEach((c, i) => {
    if (typeof c !== "object" || c === null) {
      errors.push(`${note}: iddia #${i + 1} nesne değil`);
      return;
    }
    const rec = c as Record<string, unknown>;
    // The filename is the authority on the note name: it is what the runner
    // wrote, while `note` inside the payload is model text. A disagreement is
    // reported rather than resolved — silently preferring either side hides a
    // raw file that was renamed, copied, or produced by the wrong prompt.
    if (typeof rec.note === "string" && rec.note !== note) {
      errors.push(`${note}: iddia #${i + 1} kendi not adını "${rec.note}" diyor — dosya adıyla çelişiyor`);
      return;
    }
    const { line_start, line_end, text, verdict } = rec;
    if (!Number.isInteger(line_start) || !Number.isInteger(line_end)
      || typeof text !== "string" || typeof verdict !== "string") {
      errors.push(`${note}: iddia #${i + 1} zorunlu alanları taşımıyor (line_start/line_end/text/verdict)`);
      return;
    }
    // Spread first: unknown fields survive. `unmeasurable_reason` and
    // `user_question` reach the scorer through exactly this line, and the next
    // field the gate grows must not need a code change here to be carried.
    rows.push({
      ...rec,
      note,
      claim_id: typeof rec.claim_id === "string" ? rec.claim_id : `${note}#h${i + 1}`,
      line_start: line_start as number, line_end: line_end as number,
      text, verdict,
    });
  });
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  console.error(`\n${errors.length} hata — düz dosya YAZILMADI.`);
  process.exit(1);
}

rows.sort((a, b) =>
  a.note.localeCompare(b.note) || a.line_start - b.line_start
  || a.line_end - b.line_end || a.claim_id.localeCompare(b.claim_id));

writeFileSync(flatPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.error(
  `${rows.length} iddia · ${complete.length} not → ${flatPath}` +
  (incomplete.length ? `  (dışarıda: ${incomplete.length} eksik koşum)` : ""),
);
