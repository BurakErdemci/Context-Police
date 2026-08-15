// M4.2 — `dogustan-yanlis` hüküm sözleşmesi ve sır sınırı.
//
// NEDEN İSTEM METNİNE BAKILIYOR: bu testlerin bir kısmı istemin İÇERİĞİNİ
// sınıyor. Genel kural bunun tersi (testler davranış ölçer, kaynak metin
// taramaz) ve burada bilerek delinmiyor: hakem istemi bir ÜRÜN ARTEFAKTI —
// aracın modele verdiği sözleşmenin ta kendisi. Kaynak dosya okunmuyor,
// `buildPrompt`in DÖNDÜRDÜĞÜ değer okunuyor; yani sınanan şey "dosyada şu satır
// var mı" değil "araç modele bu yükümlülüğü veriyor mu".
//
// GERÇEK `codex` ÇAĞRILMIYOR (kota): uçtan uca testler sahte bir `codex`
// betiğiyle koşuyor, betik kendisine verilen istemi ve şema dosyasını diske
// döküyor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BORN_WRONG, GATE_MARK, adjudicatorSchema, buildPrompt, extractAuthorshipBound,
  extractGatedClaims, gateClaims,
} from "../adjudicate-lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "adjudicate-cost.ts");
const REPO = join(HERE, "..", "..", "..");
const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];

const DATED_BODY = "# not\n\nKarar: 27 Tem 2026. Ölçüm 2026-07-29'da yinelendi.\n";
const UNDATED_BODY = "# not\n\nWorktree her zaman ana depo dışında kurulur.\n";

// --- yazılma zamanı alt sınırı --------------------------------------------

test("yazılma zamanı sınırı gövdedeki EN YENİ tarih", () => {
  // Not, andığı en yeni tarihten önce yazılmış olamaz; sınır o.
  assert.equal(extractAuthorshipBound(DATED_BODY)?.iso, "2026-07-29");
});

test("Türkçe ay adı ISO'dan yeniyse sınırı o belirler", () => {
  assert.equal(extractAuthorshipBound("2026-01-02 ve 12 Ağu 2026")?.iso, "2026-08-12");
  assert.equal(extractAuthorshipBound("2026-01-02 ve 12 Ağustos 2026")?.iso, "2026-08-12");
});

test("tarihsiz not için sınır yok", () => {
  assert.equal(extractAuthorshipBound(UNDATED_BODY), null);
});

test("tarih gibi görünen ama tarih olmayan sayılar sınır üretmez", () => {
  // Sürüm numarası ve makul olmayan yıl: sessizce sınır uydurmak, kapının
  // korumak istediği hükmü yanlışlıkla AÇAR.
  assert.equal(extractAuthorshipBound("v1.2.3 · 1999-01-01 · 13 Ağu 1899"), null);
});

// --- istem: hükmü kazanma ölçütü ------------------------------------------

test("tarihli notta dogustan-yanlis KAZANILABİLİR ve ölçütü istemde", () => {
  const p = buildPrompt("n", DATED_BODY, null);
  assert.match(p, /`2026-07-29` tarihinden ÖNCE yazılmış olamaz/);
  assert.match(p, /git log --until=2026-07-29/);
  // İki koşullu kanıt: o tarihte de yanlış + arada doğru kılan değişiklik yok.
  assert.match(p, /doğru kılıp sonra bozan/);
  assert.doesNotMatch(p, /KAPALI/);
});

test("tarihsiz notta dogustan-yanlis istemde KAPATILIYOR", () => {
  const p = buildPrompt("n", UNDATED_BODY, null);
  assert.match(p, /dogustan-yanlis[^\n]*KAPALI/);
  assert.match(p, /KULLANILAMAZ/);
  assert.match(p, /en fazla\n?\s*`?curuk`?/);
});

test("curuk ile dogustan-yanlis ayrımı mekanik olarak yazılı", () => {
  for (const body of [DATED_BODY, UNDATED_BODY]) {
    const p = buildPrompt("n", body, null);
    assert.match(p, /O ZAMAN doğruydu, ŞİMDİ yanlış/);
    assert.match(p, /O ZAMAN da yanlıştı/);
  }
});

// --- istem: sayım iddiaları -----------------------------------------------

test("sayım iddiası ölçülmek zorunda ve kanıt biçimi sabit", () => {
  const p = buildPrompt("n", DATED_BODY, null);
  assert.match(p, /komut: <koştuğun komut> \| olculen: <sayı> \| notta: <sayı>/);
  // Koşturulabilir bir sayım iddiası için `olculemez` kaçış yolu kapalı.
  assert.match(p, /koşturulabilen bir sayım iddiası `olculemez` DEĞİLDİR/);
});

// --- istem: sır sınırı ----------------------------------------------------

test("sır sınırı istemde: varlık ölçülür, değer asla", () => {
  const p = buildPrompt("n", DATED_BODY, null);
  assert.match(p, /Bir sırrın VARLIĞI ölçülür, DEĞERİ asla/);
  for (const surface of ["security find-generic-password", "Keychain", ".env", "~/.ssh", "credentials"]) {
    assert.ok(p.includes(surface), `sır yüzeyi istemde yok: ${surface}`);
  }
  // Durabilmesi için gereken hüküm açıkça gösteriliyor.
  assert.match(p, /DEĞERİ okunarak karara bağlanabilecek bir iddia\n?`?olculemez`?/);
});

test("sır sınırı tarihsiz notta da var", () => {
  assert.match(buildPrompt("n", UNDATED_BODY, null), /Bir sırrın VARLIĞI ölçülür/);
});

// --- şema kapısı ----------------------------------------------------------

type SchemaShape = { properties: { claims: { items: { properties: { verdict: { enum: string[] } } } } } };
const verdictEnum = (s: unknown): string[] =>
  (s as SchemaShape).properties.claims.items.properties.verdict.enum;

test("şema dogustan-yanlis'i yalnız sınır beslendiğinde kabul eder", () => {
  assert.ok(verdictEnum(adjudicatorSchema({ bornWrongAvailable: true })).includes(BORN_WRONG));
  assert.ok(!verdictEnum(adjudicatorSchema({ bornWrongAvailable: false })).includes(BORN_WRONG));
  // Öbür hükümler her iki hâlde de duruyor.
  for (const v of ["gecerli", "curuk", "olculemez"]) {
    assert.ok(verdictEnum(adjudicatorSchema({ bornWrongAvailable: false })).includes(v));
  }
});

// --- ayrıştırıcı kapısı ---------------------------------------------------

const RAW = '{"claims":[' +
  '{"text":"a","line_start":1,"line_end":1,"verdict":"dogustan-yanlis","evidence":"sha 123"},' +
  '{"text":"b","line_start":2,"line_end":2,"verdict":"curuk","evidence":"x"},' +
  '{"text":"c","line_start":3,"line_end":3,"verdict":"gecerli","evidence":"y"}]}';

test("sınır yokken modelden gelen dogustan-yanlis curuk'a düşürülür", () => {
  const out = extractGatedClaims(RAW, false) as Record<string, unknown>[];
  assert.equal(out[0]!.verdict, "curuk");
  // İddia SİLİNMİYOR, düşürüldüğü kanıtta iz bırakıyor (§3.2).
  assert.equal(out[0]!.evidence, `sha 123 ${GATE_MARK}`);
  assert.equal(out.length, 3);
});

test("sınır varken dogustan-yanlis olduğu gibi geçer", () => {
  const out = extractGatedClaims(RAW, true) as Record<string, unknown>[];
  assert.equal(out[0]!.verdict, BORN_WRONG);
  assert.equal(out[0]!.evidence, "sha 123");
});

test("kapı öbür hükümlere dokunmaz", () => {
  const out = gateClaims(JSON.parse(RAW).claims, false) as Record<string, unknown>[];
  assert.deepEqual(out[1], { text: "b", line_start: 2, line_end: 2, verdict: "curuk", evidence: "x" });
  assert.deepEqual(out[2], { text: "c", line_start: 3, line_end: 3, verdict: "gecerli", evidence: "y" });
});

test("kapı kurtarma katmanından geçen çıktıda da işler", () => {
  // Kod çitiyle sarılmış cevap: şema doğrulamasından geçmemiş olabilir, o
  // yüzden kapının ayrıştırıcı tarafı burada tek savunma.
  const out = extractGatedClaims("```json\n" + RAW + "\n```", false) as Record<string, unknown>[];
  assert.equal(out[0]!.verdict, "curuk");
});

test("ayrıştırılamayan metin null döner (kapı sessizce boş küme uydurmaz)", () => {
  assert.equal(extractGatedClaims("çıktı yok", false), null);
});

// --- uçtan uca: alt sürece giden şema ve istem ----------------------------
//
// Yukarıdaki testler `buildPrompt`/`adjudicatorSchema` çıktısını ölçüyor; bu
// ikisi ARACIN GERÇEKTEN NE GÖNDERDİĞİNİ ölçüyor — seçim mantığı CLI'da ve
// kütüphane doğruyken CLI yanlış şemayı seçebilir.

const DUMPING_CODEX = `#!/bin/sh
cat > "$PROMPT_DUMP"
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-schema" ]; then cp "$a" "$SCHEMA_DUMP"; fi
  prev="$a"
done
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"claims\\":[]}"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`;

function runTool(body: string): { prompt: string; schema: string } {
  const dir = mkdtempSync(join(tmpdir(), "m42-"));
  try {
    const bin = join(dir, "bin");
    const notes = join(dir, "notes");
    mkdirSync(bin);
    mkdirSync(notes);
    const codex = join(bin, "codex");
    writeFileSync(codex, DUMPING_CODEX);
    chmodSync(codex, 0o755);
    writeFileSync(join(notes, "probe-note.md"), body);
    const promptDump = join(dir, "prompt.txt");
    const schemaDump = join(dir, "schema.json");
    const r = spawnSync(
      process.execPath,
      [...NODE_ARGS, TOOL, "--timeout-sec", "60", REPO, notes, join(dir, "out.jsonl"), "probe-note"],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PROMPT_DUMP: promptDump,
          SCHEMA_DUMP: schemaDump,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);
    return { prompt: readFileSync(promptDump, "utf8"), schema: readFileSync(schemaDump, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("uçtan uca: tarihsiz not için alt sürece giden şema dogustan-yanlis taşımaz", () => {
  const { prompt, schema } = runTool(UNDATED_BODY);
  assert.ok(!verdictEnum(JSON.parse(schema)).includes(BORN_WRONG));
  assert.match(prompt, /KULLANILAMAZ/);
  assert.match(prompt, /Bir sırrın VARLIĞI ölçülür/);
});

test("uçtan uca: tarihli not için şema hükmü açar ve istem ölçütü taşır", () => {
  const { prompt, schema } = runTool(DATED_BODY);
  assert.ok(verdictEnum(JSON.parse(schema)).includes(BORN_WRONG));
  assert.match(prompt, /git log --until=2026-07-29/);
});
