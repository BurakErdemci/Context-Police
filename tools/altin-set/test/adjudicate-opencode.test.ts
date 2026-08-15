// `adjudicate-opencode.ts`'in DAVRANIŞSAL testleri.
//
// GERÇEK `opencode` ÇAĞRILMIYOR. Her test kendi sahte ikilisini geçici bir
// dizine yazıp araca `--binary` ile gösteriyor — kota harcanmıyor, ağ yok, akış
// deterministik. İkilinin yol olarak ENJEKTE EDİLEBİLİR olması tam bu yüzden
// aracın arayüzünde: PATH'e sahte bir `opencode` koymak da işe yarardı ama o
// zaman testin neyi değiştirdiği çağrıda görünmezdi.
//
// SINANAN AKIŞ İKİ GEÇİŞLİ (gerekçe adjudicate-opencode.ts başlığında, 15 Ağu
// ölçümü): pass 1 ölçüyor ama sözleşmeye UYMUYOR (markdown tablosu), pass 2 AYNI
// oturumda kendi cevabını `{"claims":[…]}` nesnesine çeviriyor. Testler bu iki
// geçişin bağını (oturum kimliği), toplamını (jeton) ve kopma noktalarını
// (pass 1 patlarsa pass 2 hiç denenmez) ölçüyor.
//
// Sınanan şeylerin hiçbiri kaynak metnine bakmıyor: hepsi gerçek bir alt süreç
// akışı üretip aracı koşturuyor ve DİSKTE bıraktığı ize bakıyor (satır dosyası,
// ham dosya, `pass1.txt`, `incomplete/` dizini). Metin tarayan test, korunan kod
// kaldırılınca da yeşil kalıyor — bu depoda ölçüldü.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "adjudicate-opencode.ts");
// `validateRoot` .git taşıyan bir kök istiyor; deponun kendisi kullanılıyor.
const REPO = join(HERE, "..", "..", "..");
const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];

/** Frontmatter'ında tarih olan not → `authorshipBound` ölçebiliyor → kapı AÇIK. */
const NOTE_WITH_DATE = "---\nmodified: 2026-08-01\n---\n\n# tarihli\n\nGövde.\n";
/**
 * Hiçbir tarih taşımayan not → kapı KAPALI. Gövdede ISO ya da "12 Ağu 2026"
 * biçimli hiçbir dizge YOK; olsaydı gövde taraması sınırı bulur ve test
 * ölçmek istediği dalın tersini ölçerdi.
 */
const NOTE_NO_DATE = "# tarihsiz\n\nBu notta hiçbir tarih geçmiyor.\n";

type Sandbox = { dir: string; bin: string; notes: string; out: string; argvLog: string };

/** Test başına izole çalışma alanı: sahte ikili, notlar, çıktı dizini. */
function makeSandbox(script: string, notes: Record<string, string>): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "adj-oc-test-"));
  const notesDir = join(dir, "notes");
  mkdirSync(notesDir);
  for (const [name, body] of Object.entries(notes)) {
    writeFileSync(join(notesDir, `${name}.md`), body);
  }
  const bin = join(dir, "fake-opencode");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { dir, bin, notes: notesDir, out: join(dir, "out.jsonl"), argvLog: join(dir, "argv.json") };
}

function runTool(sb: Sandbox, notes: string[], flags: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [...NODE_ARGS, TOOL, "--binary", sb.bin, ...flags, REPO, sb.notes, sb.out, ...notes],
    { env: { ...process.env, PROBE_ARGV_LOG: sb.argvLog }, encoding: "utf8" },
  );
}

function rows(sb: Sandbox): Record<string, unknown>[] {
  return readFileSync(sb.out, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function rowFor(sb: Sandbox, note: string): Record<string, unknown> {
  const r = rows(sb).find((x) => x.note === note);
  assert.ok(r, `${note} için satır yok`);
  return r;
}

/** Sahte ikilinin gördüğü her çağrının argv'si, sırayla. */
function calls(sb: Sandbox): string[][] {
  if (!existsSync(sb.argvLog)) return [];
  return readFileSync(sb.argvLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Sahte ikilinin ortak öneki.
 *
 * Kendi çağrısını kayda geçiriyor, hangi nota ait olduğunu istemden çıkarıyor
 * (istem SON pozisyonel argüman; içinde `NOT: <ad>.md` veri çiti etiketi geçer)
 * ve HANGİ GEÇİŞTE olduğunu `--session` bayrağının varlığından anlıyor — aracın
 * pass 2'yi nasıl kurduğuna dair varsayım değil, gözlem.
 */
const PRELUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.PROBE_ARGV_LOG) fs.appendFileSync(process.env.PROBE_ARGV_LOG, JSON.stringify(argv) + "\\n");
const prompt = argv[argv.length - 1];
const sessionIdx = argv.indexOf("--session");
const incomingSession = sessionIdx === -1 ? null : argv[sessionIdx + 1];
const isPass2 = incomingSession !== null;
const noteMatch = /NOT: (.+)\\.md/.exec(prompt);
// Pass 2'nin isteminde not adı GEÇMEZ (yalnız çevirme talimatı); notu oturum
// kimliğinden geri okuyoruz — böylece sahte ikili de aracın taşıdığı bağa bağlı.
const note = noteMatch ? noteMatch[1] : String(incomingSession || "").replace(/^ses-/, "");
const session = "ses-" + note;
const emit = (o) => process.stdout.write(JSON.stringify(Object.assign({ sessionID: session }, o)) + "\\n");
const text = (s) => emit({ type: "text", timestamp: 1, part: { text: s } });
const stepFinish = (tokens, cost) =>
  emit({ type: "step_finish", timestamp: 1, part: { reason: "stop", tokens, cost } });
const tok = (i, o, r, cr, cw) => ({ total: i + o, input: i, output: o, reasoning: r, cache: { read: cr, write: cw } });
`;

// Pass 1 GERÇEK ÖLÇÜMÜN taklidi: araç çağrıları + markdown tablosu, yani
// sözleşmeye UYMAYAN bir cevap (15 Ağu'da gerçek koşumda ölçülen davranış).
// Pass 2 aynı oturumda sözleşmeyi üretiyor.
const PASS1_NARRATIVE = `
  emit({ type: "step_start", timestamp: 1, part: {} });
  emit({ type: "tool_use", timestamp: 1, part: { tool: "bash", callID: "c1", state: { status: "completed", input: { command: "git log -1" }, output: "b4065f1" } } });
  text("| iddia | hüküm |\\n| --- | --- |\\n| a | gecerli |\\n");
  stepFinish(tok(1000, 200, 50, 10, 5), 0);
`;

const TWO_PASS = `${PRELUDE}
if (!isPass2) {
${PASS1_NARRATIVE}
} else {
  text('{"claims": [');
  text('{"text":"a","line_start":1,"line_end":1,"verdict":"gecerli","evidence":"e1"},');
  text('{"text":"b","line_start":2,"line_end":2,"verdict":"curuk","evidence":"e2"}');
  text(']}');
  stepFinish(tok(100, 40, 5, 90, 1), 0);
}
`;

test("iki geçiş: pass 1 ölçer, pass 2 AYNI oturumda sözleşmeye çevirir", () => {
  const sb = makeSandbox(TWO_PASS, { "tarihli-not": NOTE_WITH_DATE });
  try {
    const r = runTool(sb, ["tarihli-not"]);
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);

    const c = calls(sb);
    assert.equal(c.length, 2, "not başına iki çağrı");
    assert.equal(c[0]!.includes("--session"), false, "pass 1 oturumsuz başlar");
    // Oturum kimliği pass 1 AKIŞINDAN alınıp pass 2'ye taşınıyor. Taşınmazsa
    // pass 2 YENİ bir oturum açar ve model hiç yapmadığı ölçümü "çevirir" —
    // uydurma bir iddia kümesi üretmenin en kısa yolu.
    assert.equal(c[1]![c[1]!.indexOf("--session") + 1], "ses-tarihli-not");
    assert.equal(rowFor(sb, "tarihli-not").session_id, "ses-tarihli-not");

    // Sözleşmeye uyan metin PASS 2'ninki ve skor hattının okuduğu dosya o.
    const raw = readFileSync(`${sb.out}.tarihli-not.raw.jsonl`, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.claims.map((x: { text: string }) => x.text), ["a", "b"]);
    // Ham metin KAPISIZ yazılıyor: kapıyı `flatten.ts` uyguluyor, iki kez
    // uygulanan kapı `evidence` alanına iki kez iz düşürürdü.
    assert.equal(raw.includes("kapı:"), false, "ham çıktı kapıdan geçmemeli");

    // Pass 1'in anlatısı ATILMIYOR: yanlış bir hüküm ancak onunla teşhis edilir.
    const p1 = readFileSync(`${sb.out}.tarihli-not.pass1.txt`, "utf8");
    assert.match(p1, /iddia \| hüküm/, "ölçüm anlatısı korunmalı");

    const row = rowFor(sb, "tarihli-not");
    assert.equal(row.claims_complete, true);
    assert.equal(row.claims, 2);
    assert.equal(row.olculemez, false);
    assert.equal(row.pass2_attempted, true);
    assert.equal(row.pass1_rc, 0);
    assert.equal(row.pass2_rc, 0);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("`pass1.txt` skor hattına giremez: `flatten.ts` yalnız `.raw.jsonl` topluyor", () => {
  const sb = makeSandbox(TWO_PASS, { "tarihli-not": NOTE_WITH_DATE });
  try {
    runTool(sb, ["tarihli-not"]);
    const flat = join(sb.dir, "flat.jsonl");
    const r = spawnSync(
      process.execPath,
      [...NODE_ARGS, join(HERE, "..", "flatten.ts"), sb.notes, sb.out, flat],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, `flatten hata verdi: ${r.stderr}`);
    const out = readFileSync(flat, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(out.length, 2, "yalnız pass 2'nin iddiaları");
    assert.deepEqual(out.map((x) => x.verdict), ["gecerli", "curuk"]);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("çağrı şekli: --pure, --format json, --dir ve istem POZİSYONEL argüman", () => {
  const sb = makeSandbox(TWO_PASS, { "tarihli-not": NOTE_WITH_DATE });
  try {
    runTool(sb, ["tarihli-not"]);
    const argv = calls(sb)[0]!;
    assert.equal(argv[0], "run");
    // `--pure` olmadan kullanıcının global skill/MCP yapılandırması yükleniyor
    // ve sabit istem yükü ~4.200 yerine ~11.600 jetona çıkıyor (15 Ağu ölçümü).
    assert.ok(argv.includes("--pure"), "--pure zorunlu");
    assert.equal(argv[argv.indexOf("--format") + 1], "json");
    assert.ok(argv.includes("--dir"), "çalışma kökü verilmeli");
    // İstem argv'de: ölçülen en büyük istem 49.930 bayt, macOS ARG_MAX 1 MB.
    assert.ok(argv.at(-1)!.includes("NOT: tarihli-not.md"), "istem son argüman");
    // Pass 2'nin istemi ÇEVİRME, yeniden ölçüm değil.
    assert.match(calls(sb)[1]!.at(-1)!, /YENİDEN ÖLÇME/);
    // Ölçülmüş tuzak: `parseClaimsArray` üst düzeyde NESNE istiyor; çıplak dizi
    // isteyen bir çevirme istemi kusursuz JSON üretip yine NULL döndürüyordu.
    assert.match(calls(sb)[1]!.at(-1)!, /Çıplak/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- Jeton TOPLAMI ---------------------------------------------------------
// Not başına maliyet sorusunun cevabı İKİ GEÇİŞİN toplamı; ayrıca `step_finish`
// ADIM BAŞINA geliyor, yani geçiş içinde de toplanmalı. Ya geçişler arası ya da
// geçiş içinde "sonuncusu kazanır" olsaydı manşet sayı olduğundan düşük çıkardı.

const MULTI_STEP = `${PRELUDE}
if (!isPass2) {
  stepFinish(tok(60, 30, 10, 5, 2), 0);
  text("markdown tablosu");
  stepFinish(tok(20, 15, 5, 3, 1), 0);
} else {
  text('{"claims": []}');
  stepFinish(tok(7, 4, 1, 2, 1), 0);
}
`;

test("jetonlar HEM adımlar HEM iki geçiş boyunca toplanıyor", () => {
  const sb = makeSandbox(MULTI_STEP, { "tarihli-not": NOTE_WITH_DATE });
  try {
    const r = runTool(sb, ["tarihli-not"]);
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);
    const row = rowFor(sb, "tarihli-not");
    assert.equal(row.input_tokens, 87, "60 + 20 + 7");
    assert.equal(row.output_tokens, 49, "30 + 15 + 4");
    assert.equal(row.reasoning_output_tokens, 16, "10 + 5 + 1");
    assert.equal(row.cached_input_tokens, 10, "cache.read: 5 + 3 + 2");
    assert.equal(row.cache_write_input_tokens, 4, "cache.write: 2 + 1 + 1");
    assert.equal(row.turns, 3, "iki geçişin adımları");
    // Ücretsiz modelin "0" iddiası satırda ÖLÇÜLEBİLİR duruyor; `null` (hiç
    // bildirilmedi) ile `0` (bildirildi) ayrımı korunuyor.
    assert.equal(row.cost_usd, 0);
    // Boş iddia kümesi TAM bir cevaptır (kardeş araçta ölçülmüş bulgu:
    // adjudicate-empty-claims-rejected).
    assert.equal(row.claims_complete, true);
    assert.equal(row.claims, 0);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- Dayanıklılık: bir not 28'i kaybettirmez -------------------------------

const ONE_FAILS = `${PRELUDE}
if (note === "kirik-not") {
  process.stderr.write("sahte opencode arizasi\\n");
  process.exit(3);
}
if (!isPass2) {
${PASS1_NARRATIVE}
} else {
  text('{"claims": []}');
  stepFinish(tok(5, 4, 1, 0, 0), 0);
}
`;

test("pass 1 sıfırdan farklı çıkarsa PASS 2 HİÇ DENENMEZ ve toplu koşum kesilmez", () => {
  const sb = makeSandbox(ONE_FAILS, {
    "kirik-not": NOTE_WITH_DATE,
    "saglam-not": NOTE_WITH_DATE,
  });
  try {
    const r = runTool(sb, ["kirik-not", "saglam-not"]);
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);
    assert.equal(rows(sb).length, 2, "iki notun da satırı olmalı");

    const bad = rowFor(sb, "kirik-not");
    assert.equal(bad.pass1_rc, 3);
    // Çevrilecek bir cevap YOK. Oturumsuz bir ikinci çağrı yeni oturum açar ve
    // model hiç yapmadığı ölçümü "çevirir" — uydurma iddia üretir.
    assert.equal(bad.pass2_attempted, false);
    assert.equal(bad.pass2_rc, null);
    assert.equal(bad.claims_complete, false);
    assert.equal(bad.olculemez, true);
    // stderr ATILMIYOR: yoksa "neden 3 döndü" sorusu cevapsız kalır.
    assert.match(String(bad.stderr_tail), /sahte opencode arizasi/);
    // Arızalı notun hamı skor hattına ULAŞAMAYACAK yere gitti.
    assert.equal(existsSync(`${sb.out}.kirik-not.raw.jsonl`), false);
    assert.ok(existsSync(join(sb.dir, "incomplete", "out.jsonl.kirik-not.raw.jsonl")));

    // Kırık not için TEK çağrı, sağlam not için İKİ.
    const bySession = calls(sb).filter((a) => a.at(-1)!.includes("kirik-not") || a.includes("ses-kirik-not"));
    assert.equal(bySession.length, 1, "pass 2 hiç denenmemeli");

    // Ve sağlam not ondan SONRA gerçekten koştu.
    const good = rowFor(sb, "saglam-not");
    assert.equal(good.rc, 0);
    assert.equal(good.pass2_attempted, true);
    assert.equal(good.claims_complete, true);
    assert.ok(existsSync(`${sb.out}.saglam-not.raw.jsonl`));
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- Süre tavanı -----------------------------------------------------------
// macOS'ta `timeout` ikilisi YOK (hafıza: kabuk-tuzaklari-macos); kesme süreç
// içinde. Sahte ikili yarım bir cevap yazıp asılıyor: tavan ateşlenmezse test
// takılır, ateşlenirse `cap` satıra düşer.

const HANGS = `${PRELUDE}
text("yarım kalmış ölçüm");
setTimeout(() => {}, 60000);
`;

test("süre tavanı geçiş içinde ateşleniyor, `cap` hangi geçişte kesildiğini söylüyor", () => {
  const sb = makeSandbox(HANGS, { "tarihli-not": NOTE_WITH_DATE });
  try {
    const r = runTool(sb, ["tarihli-not"], ["--timeout-sec", "2"]);
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);
    const row = rowFor(sb, "tarihli-not");
    const cap = row.cap as { kind: string; limit: number; pass: number } | null;
    assert.ok(cap, "tavan ateşlenmedi — araç asılı kalırdı");
    assert.equal(cap.kind, "time");
    assert.equal(cap.limit, 2);
    assert.equal(cap.pass, 1);
    // Kesilen bir ölçümün çevrilecek cevabı yok.
    assert.equal(row.pass2_attempted, false);
    assert.equal(row.claims_complete, false);
    assert.equal(row.olculemez, true);
    // Kesme BİÇİM ARIZASI değil: ayrım satırda korunuyor, yoksa tavan
    // kalibrasyonu ile kurtarma katmanı aynı sayıya bakardı.
    assert.equal(row.parse_failed, false);
    assert.ok(existsSync(join(sb.dir, "incomplete", "out.jsonl.tarihli-not.raw.jsonl")));
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- Pass 2 çeviremezse ----------------------------------------------------

const PASS2_GARBAGE = `${PRELUDE}
if (!isPass2) {
${PASS1_NARRATIVE}
} else {
  text("Elbette! İşte hükümler:\\n\\n| iddia | hüküm |\\n| a | gecerli |");
  process.stdout.write('{"type":"text" bozuk\\n');
  emit({ type: "yepyeni_olay", timestamp: 1, part: {} });
  stepFinish(tok(9, 8, 1, 0, 0), 0);
}
`;

test("pass 2 de sözleşmeyi üretemezse not `incomplete/`e gidiyor", () => {
  const sb = makeSandbox(PASS2_GARBAGE, { "tarihli-not": NOTE_WITH_DATE });
  try {
    const r = runTool(sb, ["tarihli-not"]);
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);
    const row = rowFor(sb, "tarihli-not");
    assert.equal(row.pass2_attempted, true, "ön koşul: ikinci geçiş gerçekten koştu");
    assert.equal(row.claims_complete, false);
    // Koşum kesilmedi (cap yok, iki rc de 0) ama çıktı okunamadı → BİÇİM ARIZASI.
    assert.equal(row.cap, null);
    assert.equal(row.rc, 0);
    assert.equal(row.parse_failed, true);
    // Kanıt ATILMIYOR, yalnız skor hattının erişemeyeceği yere konuyor:
    // `flatten.ts` üst dizini tarıyor, `incomplete/`i duyurup dışarıda bırakıyor.
    assert.equal(existsSync(`${sb.out}.tarihli-not.raw.jsonl`), false);
    const raw = readFileSync(join(sb.dir, "incomplete", "out.jsonl.tarihli-not.raw.jsonl"), "utf8");
    assert.match(raw, /Elbette/, "pass 2'nin kanıtı korunmalı");
    // Pass 1'in anlatısı da duruyor — iki geçişin ikisi de teşhis edilebilir.
    assert.match(readFileSync(`${sb.out}.tarihli-not.pass1.txt`, "utf8"), /iddia \| hüküm/);
    // Kayma SESSİZ kalmıyor: ayrıştırıcı koştu ve gördüğünü saydı.
    assert.equal(row.unparsed_lines, 1, "`{` ile başlayan bozuk satır");
    assert.equal(row.unknown_events, 1, "`yepyeni_olay`");
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- `born_wrong_available` ------------------------------------------------
// `flatten.ts` bu alanı OKUYOR; yoksa kapıyı not gövdesinden YENİDEN hesaplıyor
// ve gövde bu arada tarih kazandıysa/kaybettiyse gerçek `dogustan-yanlis`
// hükümleri sessizce `olculemez`e çevriliyor. Alan hem VAR olmalı hem DOĞRU.

test("`born_wrong_available` satırda ve her iki dalda da doğru", () => {
  const sb = makeSandbox(TWO_PASS, {
    "tarihli-not": NOTE_WITH_DATE,
    "tarihsiz-not": NOTE_NO_DATE,
  });
  try {
    const r = runTool(sb, ["tarihli-not", "tarihsiz-not"]);
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);
    assert.equal(rowFor(sb, "tarihli-not").born_wrong_available, true);
    assert.equal(rowFor(sb, "tarihsiz-not").born_wrong_available, false);

    // Kapı yalnız satırda değil PASS 2'NİN ŞEMASINDA da kapanmalı: sözleşmeyi
    // dayatan tek yer orası, ve şema ile satır ıraksarsa `flatten.ts` kapıyı
    // modelin hiç görmediği bir dala göre uygular.
    const p2 = calls(sb).filter((a) => a.includes("--session"));
    const gated = p2.find((a) => a[a.indexOf("--session") + 1] === "ses-tarihsiz-not")!.at(-1)!;
    const open = p2.find((a) => a[a.indexOf("--session") + 1] === "ses-tarihli-not")!.at(-1)!;
    assert.match(gated, /user_resolvable/, "kapalı dalda alt sebep şemada olmalı");
    assert.equal(/"dogustan-yanlis"/.test(gated), false, "kapalı dalda şema hükmü kabul etmemeli");
    assert.match(open, /"dogustan-yanlis"/, "açık dalda hüküm şemada olmalı");
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- Argv kapıları ---------------------------------------------------------
// Kardeş araçla AYNI doğrulayıcılar kullanılıyor; burada sınanan tek şey
// reddetmenin SESSİZ olmaması — bu sınıfın ilk arızası tam olarak sessizlikti.

test("geçersiz not adı gürültüyle reddediliyor", () => {
  const sb = makeSandbox(TWO_PASS, { "tarihli-not": NOTE_WITH_DATE });
  try {
    const r = spawnSync(
      process.execPath,
      [...NODE_ARGS, TOOL, "--binary", sb.bin, REPO, sb.notes, sb.out, "../kacak"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2, "çıkış kodu 2 olmalı (argv kapısı)");
    assert.match(r.stderr, /not adı reddedildi/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- Bayat artefaktlar -----------------------------------------------------
// Koşum başında YALNIZ maliyet dosyasını sıfırlamak İKİ KOŞUMU TEK ÖLÇÜME
// KARIŞTIRIYOR: `flatten.ts` çıktı dizinindeki TÜM `.raw.jsonl` dosyalarını
// topluyor, dolayısıyla önceki koşumdan kalan bir ham dosya bugünkü skora
// giriyor — üstelik maliyet dosyasında satırı olmadığı için kapı dalı BUGÜNKÜ
// not gövdesinden yeniden hesaplanıyor. Ölçüldü 15 Ağu 2026 (stale-raw probe'u):
// 2 notla koş, 1 notla yeniden koş, düz dosyada 2 not.

function flatten(sb: Sandbox): Set<string> {
  const flat = join(sb.dir, "flat.jsonl");
  const r = spawnSync(
    process.execPath,
    [...NODE_ARGS, join(HERE, "..", "flatten.ts"), sb.notes, sb.out, flat],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `flatten hata verdi: ${r.stderr}`);
  return new Set(readFileSync(flat, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).note));
}

test("yeniden koşum önceki koşumun artefaktlarını siler: iki koşum tek ölçüme karışmaz", () => {
  const sb = makeSandbox(TWO_PASS, { "eski-not": NOTE_WITH_DATE, "yeni-not": NOTE_WITH_DATE });
  try {
    assert.equal(runTool(sb, ["eski-not", "yeni-not"]).status, 0);
    assert.ok(existsSync(`${sb.out}.eski-not.raw.jsonl`), "ön koşul: 1. koşum iki ham dosya üretmeli");
    assert.ok(existsSync(`${sb.out}.eski-not.pass1.txt`));

    // AYNI çıktı yoluna, bu sefer tek notla.
    const r2 = runTool(sb, ["yeni-not"]);
    assert.equal(r2.status, 0, `araç hata verdi: ${r2.stderr}`);
    // Silme SESSİZ değil — 2 not × (raw + pass1).
    assert.match(String(r2.stderr), /bayat artefakt silindi: 4/);
    assert.equal(existsSync(`${sb.out}.eski-not.raw.jsonl`), false, "bayat ham dosya kalmamalı");
    assert.equal(existsSync(`${sb.out}.eski-not.pass1.txt`), false);

    // ASIL ÖLÇÜT diskteki dosya değil PUANLANAN KÜME: kusur tam da burada
    // görünüyordu, çünkü maliyet dosyası zaten tek notluk doğru cevabı veriyordu.
    assert.deepEqual([...flatten(sb)], ["yeni-not"]);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("dünkü TAM ham dosya bugünkü EKSİK koşumu gölgeleyemez", () => {
  const sb = makeSandbox(TWO_PASS, { "tarihli-not": NOTE_WITH_DATE });
  try {
    assert.equal(runTool(sb, ["tarihli-not"]).status, 0);
    assert.ok(existsSync(`${sb.out}.tarihli-not.raw.jsonl`), "ön koşul: 1. koşum TAM");

    // AYNI not, bu sefer sözleşmeyi üretemiyor → yeni ham dosya `incomplete/`e
    // gidiyor. Bayat TAM dosya silinmezse üst dizinde kalır ve `flatten.ts`
    // DÜNKÜ hükümleri puanlar; not "denetlendi" görünür, kanıtı ise bugünkü
    // koşumun hiç ulaşamadığı bir cevaptır.
    writeFileSync(sb.bin, PASS2_GARBAGE);
    chmodSync(sb.bin, 0o755);
    const r = runTool(sb, ["tarihli-not"]);
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);

    assert.equal(rowFor(sb, "tarihli-not").claims_complete, false);
    assert.equal(existsSync(`${sb.out}.tarihli-not.raw.jsonl`), false, "dünkü TAM ham dosya silinmeli");
    assert.ok(existsSync(join(sb.dir, "incomplete", "out.jsonl.tarihli-not.raw.jsonl")));
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

// --- Kaçan süreç -----------------------------------------------------------
// `kill_failed` / `leaked_pid` / `cleanup_command` SABİT yazılıyordu. Kardeş
// koşucuda (`adjudicate-cost.ts`) aynı üç alan gerçek ölçüm ve iki aracın
// satırları AYNI okuyucudan geçiyor — sabit bırakmak "hiçbir şey kaçmadı"yı
// bakmadan iddia etmek demekti.
//
// Sahte ikili `setsid()` çağıran bir torun bırakıyor: torun KENDİ oturumuna
// geçtiği için `kill(-pgid)` ona ULAŞMIYOR, çocuk 3 ms'de ölüp `close` yayıyor
// ve satır zamanında yazılıyordu. Ölçülen davranış (15 Ağu, fake-killstat
// probe'u): koşum bittikten sonra torun hâlâ hayattaydı, satır `kill_failed:
// false` diyordu.
//
// NE SINANMIYOR (yanlışlama ile ölçüldü): kesme ERİŞİMİ geri alınırsa test
// kırmızıya dönüyor (torun sağ kalıyor, satır "kaçmadı" diyor), AMA yalnız üç
// alan sabite çevrilip erişim yerinde bırakılırsa test yeşil kalıyor — hiçbir
// şey kaçmadığı için sabit tesadüfen doğru oluyor. Öldürülemeyen bir süreci
// deterministik üretmenin yolu yok (SIGKILL kullanıcı alanında engellenemez),
// o yüzden raporlama dalı bu testte DEĞİL, canlı probe'da ölçüldü.

/** `kill(pid, 0)` sinyal göndermez, yalnız varlığı sınar. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Torun kendi oturumuna geçip PID'sini dosyaya yazıyor, sonra `sleep 300`
 * oluyor. `pkill -f <işaret>` ile İZLENEMEZ: `exec` sonrası komut satırında
 * işaret kalmıyor (probe'da ölçüldü), o yüzden PID DOSYASI.
 * stdout/stderr `/dev/null`: bu test kill defterini ölçüyor, boru asılmasını değil.
 */
const LEAKS_GRANDCHILD = (pidFile: string) => `#!/bin/sh
trap '' TERM
printf '{"sessionID":"ses-1","type":"step_start","timestamp":1,"part":{}}\\n'
perl -e 'use POSIX; POSIX::setsid(); open(F,">","${pidFile}"); print F $$; close F; exec("sleep","300")' >/dev/null 2>&1 &
sleep 300
`;

test("gruptan kaçan torun ya öldürülüyor ya da satırda RAPORLANIYOR", () => {
  const leakDir = mkdtempSync(join(tmpdir(), "adj-oc-leak-"));
  const pidFile = join(leakDir, "leaked.pid");
  const sb = makeSandbox(LEAKS_GRANDCHILD(pidFile), { "asili-not": NOTE_WITH_DATE });
  let leaked = 0;
  try {
    const r = runTool(sb, ["asili-not"], ["--timeout-sec", "2"]);
    assert.equal(r.status, 0, `araç hata verdi: ${r.stderr}`);
    const row = rowFor(sb, "asili-not");
    assert.ok(row.cap, "ön koşul: tavan ateşlenmeli, yoksa kesme yolu hiç ölçülmez");
    assert.ok(existsSync(pidFile), "ön koşul: sahte ikili kaçak süreci kurmalı");
    leaked = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(leaked) && leaked > 0, `okunamayan kaçak pid: ${leaked}`);

    if (alive(leaked)) {
      // Öldürülemedi → satır BUNU SÖYLEMEK ZORUNDA. Sabit alanlarda bu dal
      // erişilemezdi: satır her hâlükârda "kaçmadı" diyordu.
      assert.equal(row.kill_failed, true, "kaçan süreç satırda raporlanmalı");
      assert.equal(row.leaked_pid, leaked);
      assert.match(String(row.cleanup_command), new RegExp(String(leaked)));
    } else {
      // Öldürüldü: grup kill'i ona ulaşamadığına göre kesme anındaki alt ağaç
      // çekimi işini yaptı. O zaman satırın "kaçmadı" demesi bir ÖLÇÜM.
      assert.equal(row.kill_failed, false);
      assert.equal(row.leaked_pid, null);
      assert.equal(row.cleanup_command, null);
    }
  } finally {
    // Test kendi yarattığı kaçağın temizliğinden sorumlu (CLAUDE.md §3):
    // torun her oturumun dışında, kimse ona ulaşamaz.
    if (leaked > 0) { try { process.kill(leaked, "SIGKILL"); } catch { /* zaten ölü */ } }
    rmSync(leakDir, { recursive: true, force: true });
    rmSync(sb.dir, { recursive: true, force: true });
  }
});
