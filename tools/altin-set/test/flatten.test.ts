// `flatten.ts` — raw adjudicator output -> the flat per-claim JSONL `score.ts` reads.
//
// The last test in this file is the point of the whole tool: it runs flatten's
// output THROUGH score.ts and asserts the `KULLANICIYA` counter is non-zero.
// Before flatten existed there was no repo path carrying `unmeasurable_reason`
// from `gateClaims()` to the scorer, so that counter silently read 0 and the
// exit gate's leak guard measured nothing. Unit tests on flatten alone would
// not have caught that — the two ends have to be joined by a real run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLATTEN = join(HERE, "..", "flatten.ts");
const SCORE = join(HERE, "..", "score.ts");

type Row = Record<string, unknown>;
const jsonl = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** No frontmatter stamp and no date anywhere in the body → `dogustan-yanlis` gate CLOSED. */
const UNDATED_NOTE = "# not\n\nBu notta hiçbir tarih yok.\n";
/** A frontmatter stamp → gate OPEN, `dogustan-yanlis` survives the parse untouched. */
const DATED_NOTE = "---\nmodified: 2026-01-02\n---\n\n# not\n\ngövde\n";

/**
 * `body: null` = notu diske hiç yazma (kayıtlı dalın gövdeye ihtiyaç
 * bırakmadığını sınamak için). `recorded: undefined` = maliyet satırı
 * `born_wrong_available` ALANSIZ yazılır — alanı tanımayan eski koşumlar.
 */
type NoteOpts = { recorded?: boolean };

type Fixture = {
  dir: string;
  notesDir: string;
  outPath: string;
  flatPath: string;
  /** Writes `<notes>/<note>.md` (unless null), the raw file and a cost row. */
  note: (note: string, body: string | null, raw: string, opts?: NoteOpts) => void;
  /** Same, but the raw lands under `incomplete/`. */
  incompleteNote: (note: string, body: string | null, raw: string, opts?: NoteOpts) => void;
};

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "flatten-"));
  const notesDir = join(dir, "notes");
  const runDir = join(dir, "run");
  mkdirSync(notesDir);
  mkdirSync(join(runDir, "incomplete"), { recursive: true });
  const outPath = join(runDir, "cost.jsonl");
  writeFileSync(outPath, "");
  const costRow = (note: string, opts?: NoteOpts) => {
    const row: Row = { note, lines: 3, rc: 0, claims: 1 };
    if (opts && "recorded" in opts) row.born_wrong_available = opts.recorded;
    appendFileSync(outPath, JSON.stringify(row) + "\n");
  };
  return {
    dir, notesDir, outPath, flatPath: join(dir, "flat.jsonl"),
    note(note, body, raw, opts) {
      if (body !== null) writeFileSync(join(notesDir, `${note}.md`), body);
      writeFileSync(`${outPath}.${note}.raw.jsonl`, raw);
      costRow(note, opts);
    },
    incompleteNote(note, body, raw, opts) {
      if (body !== null) writeFileSync(join(notesDir, `${note}.md`), body);
      writeFileSync(join(runDir, "incomplete", `cost.jsonl.${note}.raw.jsonl`), raw);
      costRow(note, opts);
    },
  };
}

const raw = (claims: Row[]) => JSON.stringify({ claims });

function runFlatten(f: Fixture) {
  return spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", FLATTEN, f.notesDir, f.outPath, f.flatPath],
    { encoding: "utf8" },
  );
}

const readFlat = (f: Fixture): Row[] =>
  readFileSync(f.flatPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

test("gidiş-dönüş: unmeasurable_reason ve user_question düz dosyaya SAĞ ULAŞIYOR", () => {
  const f = fixture();
  try {
    // Kapı kapalı (tarihsiz not) + `dogustan-yanlis` → gateClaims düşürür.
    f.note("n1", UNDATED_NOTE, raw([
      { text: "iddia", line_start: 3, line_end: 3, verdict: "dogustan-yanlis", evidence: "e" },
    ]));
    const r = runFlatten(f);
    assert.equal(r.status, 0, r.stderr);
    const rows = readFlat(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.verdict, "olculemez");
    assert.equal(rows[0]!.unmeasurable_reason, "user_resolvable");
    assert.equal(typeof rows[0]!.user_question, "string");
    assert.match(String(rows[0]!.user_question), /ne zaman yazıldı/);
    // Not adı dosya adından geliyor, model onu hiç yazmamıştı.
    assert.equal(rows[0]!.note, "n1");
    assert.equal(rows[0]!.claim_id, "n1#h1");
    // Kanıt atılmıyor, kapı izi ekleniyor.
    assert.match(String(rows[0]!.evidence), /kapı:/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("kapı AÇIKKEN dogustan-yanlis dokunulmadan geçer", () => {
  const f = fixture();
  try {
    f.note("n1", DATED_NOTE, raw([
      { text: "iddia", line_start: 5, line_end: 5, verdict: "dogustan-yanlis", evidence: "e" },
    ]));
    const r = runFlatten(f);
    assert.equal(r.status, 0, r.stderr);
    const rows = readFlat(f);
    assert.equal(rows[0]!.verdict, "dogustan-yanlis");
    assert.equal(rows[0]!.unmeasurable_reason, undefined);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("not adı çelişkisi YAKALANIYOR — sessizce çözülmüyor", () => {
  const f = fixture();
  try {
    f.note("n1", DATED_NOTE, raw([
      { note: "baska-not", text: "i", line_start: 1, line_end: 1, verdict: "curuk", evidence: "e" },
    ]));
    const r = runFlatten(f);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /baska-not/);
    assert.match(r.stderr, /çelişiyor/);
    assert.match(r.stderr, /YAZILMADI/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("incomplete/ altındaki ham çıktı skorlanmıyor ve stderr'de bildiriliyor", () => {
  const f = fixture();
  try {
    f.note("tam", DATED_NOTE, raw([
      { text: "i", line_start: 1, line_end: 1, verdict: "curuk", evidence: "e" },
    ]));
    f.incompleteNote("yarim", DATED_NOTE, raw([
      { text: "i", line_start: 1, line_end: 1, verdict: "curuk", evidence: "e" },
    ]));
    const r = runFlatten(f);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /atlandı \(eksik koşum, incomplete\/\): yarim/);
    const rows = readFlat(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.note, "tam");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("ayrıştırılamayan ham dosya: sıfırdan farklı çıkış, KISA dosya yazılmıyor", () => {
  const f = fixture();
  try {
    f.note("iyi", DATED_NOTE, raw([
      { text: "i", line_start: 1, line_end: 1, verdict: "curuk", evidence: "e" },
    ]));
    f.note("bozuk", DATED_NOTE, "{ bu JSON değil");
    const r = runFlatten(f);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /bozuk: ham çıktı ayrıştırılamadı/);
    // Sağlam notun iddiaları da yazılmıyor: kısa bir dosya, o notlar temizmiş
    // gibi skorlanır — kaçırılan asıl arıza sınıfı bu.
    assert.throws(() => readFlat(f));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("çıktı sırası belirlenimci: not, sonra line_start", () => {
  const f = fixture();
  try {
    f.note("zeta", DATED_NOTE, raw([
      { text: "b", line_start: 9, line_end: 9, verdict: "gecerli", evidence: "e" },
      { text: "a", line_start: 2, line_end: 2, verdict: "gecerli", evidence: "e" },
    ]));
    f.note("alfa", DATED_NOTE, raw([
      { text: "c", line_start: 4, line_end: 4, verdict: "gecerli", evidence: "e" },
    ]));
    const first = (runFlatten(f), readFileSync(f.flatPath, "utf8"));
    const second = (runFlatten(f), readFileSync(f.flatPath, "utf8"));
    assert.equal(first, second);
    assert.deepEqual(
      readFlat(f).map((r) => [r.note, r.line_start]),
      [["alfa", 4], ["zeta", 2], ["zeta", 9]],
    );
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

// --- KAPI DALI: kayıtlı OLGU, yeniden hesaplanmış TAHMİN değil ---------------
// Ham çıktı kapısız yazılıyor; kapıyı flatten uyguluyor. Dal not gövdesinden
// yeniden hesaplanırsa, gövde hakem koşumundan SONRA bir tarih kazandığında ya
// da kaybettiğinde kapı BAŞKA dalda koşar ve `gateClaims(..., false)` gerçek
// `dogustan-yanlis` hedeflerini `olculemez`e çevirir — hiçbir yerde hata
// olmadan skor dosyasından düşerler. Bu, ürünün tespit etmek için var olduğu
// arızanın kendisi: ölçüm geçerli görünürken altındaki not kaymış.

test("kayıtlı dal not gövdesi OLMADAN da kapıyı belirler", () => {
  const f = fixture();
  try {
    f.note("n1", null, raw([
      { text: "i", line_start: 3, line_end: 3, verdict: "dogustan-yanlis", evidence: "e" },
    ]), { recorded: false });
    const r = runFlatten(f);
    assert.equal(r.status, 0, r.stderr);
    // Kapı kapalı koştu: kaynak yalnızca maliyet satırı olabilirdi.
    assert.equal(readFlat(f)[0]!.verdict, "olculemez");
    assert.equal(readFlat(f)[0]!.unmeasurable_reason, "user_resolvable");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("kayıtlı dal AÇIK kayıtlıysa gövde olmasa da hüküm korunur", () => {
  const f = fixture();
  try {
    f.note("n1", null, raw([
      { text: "i", line_start: 3, line_end: 3, verdict: "dogustan-yanlis", evidence: "e" },
    ]), { recorded: true });
    const r = runFlatten(f);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFlat(f)[0]!.verdict, "dogustan-yanlis");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("kayıtlı dal gövdeyle ÇELİŞİYORSA ölümcül — hiçbir taraf sessizce seçilmez", () => {
  const f = fixture();
  try {
    // Gövde bugün tarihli (dal AÇIK hesaplanır) ama koşum KAPALI dalda yapılmış:
    // not ölçümün altından değişmiş. Sessizce kapalı dalı uygulamak gerçek
    // `dogustan-yanlis` hedefini `olculemez`e çevirip skordan düşürürdü.
    f.note("n1", DATED_NOTE, raw([
      { text: "i", line_start: 3, line_end: 3, verdict: "dogustan-yanlis", evidence: "e" },
    ]), { recorded: false });
    const r = runFlatten(f);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /n1: kayıtlı dal .*ÇELİŞİYOR/);
    assert.match(r.stderr, /ölçümünün ALTINDAN değişmiş/);
    assert.throws(() => readFlat(f));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("alan yoksa gövdeye düşer — eski maliyet dosyaları hâlâ düzleşiyor", () => {
  const f = fixture();
  try {
    // `born_wrong_available` alanını hiç tanımayan koşumlar (alan öncesi).
    f.note("n1", UNDATED_NOTE, raw([
      { text: "i", line_start: 3, line_end: 3, verdict: "dogustan-yanlis", evidence: "e" },
    ]));
    const r = runFlatten(f);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFlat(f)[0]!.unmeasurable_reason, "user_resolvable");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("ne kayıtlı dal ne gövde: hata, dosya yazılmıyor", () => {
  const f = fixture();
  try {
    f.note("n1", null, raw([
      { text: "i", line_start: 1, line_end: 1, verdict: "curuk", evidence: "e" },
    ]));
    const r = runFlatten(f);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /kayıtlı dal yok ve not gövdesi de yok/);
    assert.throws(() => readFlat(f));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("maliyet dosyası yoksa rc≠0", () => {
  const f = fixture();
  try {
    f.note("n1", DATED_NOTE, raw([
      { text: "i", line_start: 1, line_end: 1, verdict: "curuk", evidence: "e" },
    ]), { recorded: true });
    rmSync(f.outPath);
    const r = runFlatten(f);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /maliyet dosyası yok/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("eksik argüman: kullanım stderr'e, rc=2", () => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", FLATTEN], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /kullanım: flatten\.ts/);
});

test("DELİK KAPANDI: flatten çıktısı score.ts'ten geçince KULLANICIYA sıfır DEĞİL", () => {
  const f = fixture();
  try {
    // Tarihsiz not + `dogustan-yanlis`: kapı hükmü `olculemez` +
    // `user_resolvable` yapıyor. Bu alan boru hattının herhangi bir yerinde
    // düşerse aşağıdaki sayaç sessizce 0 okur — ölçülen arıza tam olarak buydu.
    f.note("n1", UNDATED_NOTE, raw([
      { text: "kullanıcıya", line_start: 3, line_end: 3, verdict: "dogustan-yanlis", evidence: "e" },
      { text: "çürük", line_start: 7, line_end: 7, verdict: "curuk", evidence: "e" },
    ]), { recorded: false });
    const rf = runFlatten(f);
    assert.equal(rf.status, 0, rf.stderr);

    const goldenPath = join(f.dir, "golden.jsonl");
    writeFileSync(goldenPath, jsonl([
      { note: "n1", claim_id: "n1#g1", line_start: 3, line_end: 3, text: "g", verdict: "gecerli" },
      { note: "n1", claim_id: "n1#g2", line_start: 7, line_end: 7, text: "g", verdict: "curuk" },
    ]));
    const rs = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", SCORE, goldenPath, f.flatPath],
      { encoding: "utf8" },
    );
    assert.equal(rs.status, 0, rs.stderr);
    assert.match(rs.stdout, /KULLANICIYA {3}1\b/);
    assert.match(rs.stdout, /1 notta/);
    // Öbür üç sayı da gerçekten koştu: bu bir "her şey olculemez" dosyası değil.
    assert.match(rs.stdout, /YAKALAMA {6}1\/1/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
