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
  BORN_WRONG, GATE_MARK, NOT_MEASURABLE, OLCULEMEZ, UNMEASURABLE_REASON_FIELD,
  USER_QUESTION_AUTHORSHIP_DATE, USER_RESOLVABLE,
  adjudicatorSchema, authorshipBound, buildPrompt, extractGatedClaims, gateClaims,
} from "../adjudicate-lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "adjudicate-cost.ts");
const REPO = join(HERE, "..", "..", "..");
const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];

const DATED_BODY = "# not\n\nKarar: 27 Tem 2026. Ölçüm 2026-07-29'da yinelendi.\n";
const UNDATED_BODY = "# not\n\nWorktree her zaman ana depo dışında kurulur.\n";

const NOW = "2026-08-15T00:00:00.000Z";

// --- yazılma zamanı alt sınırı --------------------------------------------

test("yazılma zamanı sınırı gövdedeki EN YENİ tarih", () => {
  // Not, andığı en yeni tarihten önce yazılmış olamaz; sınır o.
  assert.equal(authorshipBound(DATED_BODY, NOW)?.iso, "2026-07-29");
});

test("Türkçe ay adı ISO'dan yeniyse sınırı o belirler", () => {
  assert.equal(authorshipBound("2026-01-02 ve 12 Ağu 2026", NOW)?.iso, "2026-08-12");
  assert.equal(authorshipBound("2026-01-02 ve 12 Ağustos 2026", NOW)?.iso, "2026-08-12");
});

test("tarihsiz not için sınır yok", () => {
  assert.equal(authorshipBound(UNDATED_BODY, NOW), null);
});

test("tarih gibi görünen ama tarih olmayan sayılar sınır üretmez", () => {
  // Sürüm numarası ve makul olmayan yıl: sessizce sınır uydurmak, kapının
  // korumak istediği hükmü yanlışlıkla AÇAR.
  assert.equal(authorshipBound("v1.2.3 · 1999-01-01 · 13 Ağu 1899", NOW), null);
});

// Tek mekanizma: sınır artık ÜRÜNÜN `noteTimestamp`'inden geliyor, bu yüzden
// frontmatter alan sırası, `metadata:` girintisi ve gelecek-kelepçesi burada da
// geçerli. Ayrı bir gövde tarayıcısı olsaydı bunların hiçbiri araç tarafında
// çalışmıyordu — ıraksamanın ölçülebilir yüzü tam olarak bu.
test("sınır önce frontmatter damgasından okunur, kaynağı da bildirilir", () => {
  const raw = "---\nname: n\nmetadata:\n  modified: 2026-07-31T09:00:00Z\n---\n\nÖlçüm 2026-01-02'de yapıldı.\n";
  const b = authorshipBound(raw, NOW);
  assert.equal(b?.iso, "2026-07-31");
  assert.match(b!.source, /frontmatter `modified`/);
});

test("frontmatter tarih vermiyorsa gövdeye düşülür (kapsamı kaybetmeden)", () => {
  const raw = "---\nname: n\ndescription: d\n---\n\nKarar: 16 Tem 2026.\n";
  const b = authorshipBound(raw, NOW);
  assert.equal(b?.iso, "2026-07-16");
  assert.match(b!.source, /gövde/);
});

test("gelecek tarihli frontmatter damgası sınırı bugünün ötesine itemez", () => {
  // Ürünün kelepçesi (untrusted-audit-window) araç tarafında da geçerli: not
  // kendi ölçüm penceresini kapatamaz.
  const raw = "---\nmodified: 2099-01-01T00:00:00Z\n---\n\ngövde\n";
  assert.equal(authorshipBound(raw, NOW)?.iso, "2026-08-15");
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
});

test("tarihsiz notta istem `curuk`a kaçmayı YASAKLAR, dürüst çıkışı gösterir", () => {
  // Mimari hüküm: ölçülmemiş bir "o zaman doğruydu" iddiasını kapının ya da
  // modelin uydurması, bu ürünün önlemek için var olduğu arızanın kendisi.
  const p = buildPrompt("n", UNDATED_BODY, null);
  assert.match(p, /ONUN YERİNE `curuk` YAZMA/);
  assert.match(p, /"o zaman DOĞRUYDU" diye bir ölçüm İDDİA/);
  assert.ok(p.includes(`${UNMEASURABLE_REASON_FIELD} = \`${USER_RESOLVABLE}\``), "dürüst çıkış istemde yok");
  assert.ok(p.includes(`${UNMEASURABLE_REASON_FIELD} = \`${NOT_MEASURABLE}\``), "sıradan olculemez ayrımı istemde yok");
  // Kullanıcıya devrin ne demek olduğu yazılı: çözümsüz değil, cevaplanabilir.
  assert.match(p, /bu ölçümü kullanıcı açabilir/);
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

type SchemaShape = {
  properties: {
    claims: {
      items: {
        required: string[];
        properties: { verdict: { enum: string[] }; unmeasurable_reason?: { enum: (string | null)[] } };
      };
    };
  };
};
const claimItem = (s: unknown) => (s as SchemaShape).properties.claims.items;
const verdictEnum = (s: unknown): string[] => claimItem(s).properties.verdict.enum;

test("şema dogustan-yanlis'i yalnız sınır beslendiğinde kabul eder", () => {
  assert.ok(verdictEnum(adjudicatorSchema({ bornWrongAvailable: true })).includes(BORN_WRONG));
  assert.ok(!verdictEnum(adjudicatorSchema({ bornWrongAvailable: false })).includes(BORN_WRONG));
  // Öbür hükümler her iki hâlde de duruyor.
  for (const v of ["gecerli", "curuk", "olculemez"]) {
    assert.ok(verdictEnum(adjudicatorSchema({ bornWrongAvailable: false })).includes(v));
  }
});

test("kapı kapalıyken şema alt sebebi kabul eder, açıkken sunmaz", () => {
  const gated = claimItem(adjudicatorSchema({ bornWrongAvailable: false }));
  assert.deepEqual(gated.properties.unmeasurable_reason?.enum, [USER_RESOLVABLE, NOT_MEASURABLE, null]);
  // Provider strict mode (measured 20 Aug 2026, invalid_json_schema 400):
  // `required` must list EVERY key in properties; optionality is expressed
  // with null in the enum, never by omission from `required`.
  assert.ok(gated.required.includes(UNMEASURABLE_REASON_FIELD));
  // Kapı açıkken tarih ölçülmüş demektir; kullanıcıya devredilecek bir şey yok.
  assert.equal(claimItem(adjudicatorSchema({ bornWrongAvailable: true })).properties.unmeasurable_reason, undefined);
});

// --- ayrıştırıcı kapısı ---------------------------------------------------

const RAW = '{"claims":[' +
  '{"text":"a","line_start":1,"line_end":1,"verdict":"dogustan-yanlis","evidence":"sha 123"},' +
  '{"text":"b","line_start":2,"line_end":2,"verdict":"curuk","evidence":"x"},' +
  '{"text":"c","line_start":3,"line_end":3,"verdict":"gecerli","evidence":"y"}]}';

test("sınır yokken modelden gelen dogustan-yanlis olculemez/kullanıcı-çözebilir olur", () => {
  const out = extractGatedClaims(RAW, false) as Record<string, unknown>[];
  // `curuk` DEĞİL: o hüküm "o zaman doğruydu" ölçümünü iddia eder ve kimse
  // yapmadı. Ölçülemeyeni ölçülmüş saymak yasak.
  assert.equal(out[0]!.verdict, OLCULEMEZ);
  assert.notEqual(out[0]!.verdict, "curuk");
  assert.equal(out[0]![UNMEASURABLE_REASON_FIELD], USER_RESOLVABLE);
  // Kullanıcıya gösterilecek metin SENDEN NE GEREKTİĞİNİ söylüyor.
  assert.equal(out[0]!.user_question, USER_QUESTION_AUTHORSHIP_DATE);
  assert.match(String(out[0]!.user_question), /Bu not ne zaman yazıldı/);
  assert.match(String(out[0]!.user_question), /Tarihi girin/);
  // İddia SİLİNMİYOR: metin, satır aralığı ve hakemin kanıtı duruyor (§3.2).
  assert.equal(out[0]!.evidence, `sha 123 ${GATE_MARK}`);
  assert.equal(out[0]!.text, "a");
  assert.equal(out[0]!.line_start, 1);
  assert.equal(out.length, 3);
});

test("modelin kendi verdiği user_resolvable'a soru metni doldurulur", () => {
  const raw = '{"claims":[{"text":"a","line_start":1,"line_end":1,"verdict":"olculemez",' +
    `"${UNMEASURABLE_REASON_FIELD}":"${USER_RESOLVABLE}","evidence":"bugün yanlış"}]}`;
  const out = extractGatedClaims(raw, false) as Record<string, unknown>[];
  assert.equal(out[0]!.user_question, USER_QUESTION_AUTHORSHIP_DATE);
  assert.equal(out[0]!.evidence, "bugün yanlış"); // kanıt olduğu gibi
});

test("sıradan olculemez kullanıcı kuyruğuna girmez", () => {
  const raw = '{"claims":[{"text":"a","line_start":1,"line_end":1,"verdict":"olculemez","evidence":"dış servis"}]}';
  const out = extractGatedClaims(raw, false) as Record<string, unknown>[];
  assert.equal(out[0]![UNMEASURABLE_REASON_FIELD], undefined);
  assert.equal(out[0]!.user_question, undefined);
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
  assert.equal(out[0]!.verdict, OLCULEMEZ);
  assert.equal(out[0]![UNMEASURABLE_REASON_FIELD], USER_RESOLVABLE);
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
  // Dürüst çıkış alt sürece GERÇEKTEN gidiyor: şemada alan, istemde kural.
  assert.deepEqual(claimItem(JSON.parse(schema)).properties.unmeasurable_reason?.enum,
    [USER_RESOLVABLE, NOT_MEASURABLE, null]);
  assert.match(prompt, /ONUN YERİNE `curuk` YAZMA/);
  assert.match(prompt, /KULLANILAMAZ/);
  assert.match(prompt, /Bir sırrın VARLIĞI ölçülür/);
});

test("uçtan uca: tarihli not için şema hükmü açar ve istem ölçütü taşır", () => {
  const { prompt, schema } = runTool(DATED_BODY);
  assert.ok(verdictEnum(JSON.parse(schema)).includes(BORN_WRONG));
  assert.match(prompt, /git log --until=2026-07-29/);
});
