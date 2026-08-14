import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerExecutor, getExecutor } from "../src/adapters/executor.ts";
import { createCodexExecutor, buildExecArgs } from "../src/adapters/codex.ts";
import { fakeExecutor } from "./helpers.ts";

test("registry kayıtlı yürütücüyü döndürür, bilinmeyeni adlarıyla reddeder", () => {
  const fake = fakeExecutor([]);
  registerExecutor(fake);
  assert.equal(getExecutor(fake.id), fake);
  assert.throws(() => getExecutor("yok-boyle-motor"), /bilinmeyen yürütücü/);
});

test("fakeExecutor senaryoyu sırayla oynar ve istekleri kaydeder", async () => {
  const fake = fakeExecutor([
    { output: '{"findings":[]}' },
    (req) => ({ ok: false, error: `patladı: ${req.prompt.slice(0, 5)}` }),
  ]);
  const r1 = await fake.run({ prompt: "birinci" });
  assert.equal(r1.ok, true);
  assert.equal(r1.output, '{"findings":[]}');
  const r2 = await fake.run({ prompt: "ikinci" });
  assert.equal(r2.ok, false);
  assert.equal(r2.output, "", "ok=false iken output boş dize (executor.ts sözleşmesi)");
  assert.match(r2.error!, /patladı: ikinc/);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0]!.prompt, "birinci");
});

test("buildExecArgs sözleşmesi: stdin prompt, ephemeral, read-only, şema ve çıktı dosyaları", () => {
  const args = buildExecArgs(
    { prompt: "x", outputSchema: { type: "object" }, cwd: "/proj" },
    { model: "gpt-5-codex", reasoningEffort: "low" },
    "/tmp/sema.json",
    "/tmp/son.txt",
  );
  assert.deepEqual(args, [
    "exec", "--ephemeral", "--skip-git-repo-check", "--color", "never",
    "-s", "read-only", "-C", "/proj", "-m", "gpt-5-codex",
    "-c", 'model_reasoning_effort="low"',
    "--output-schema", "/tmp/sema.json", "--json", "-o", "/tmp/son.txt", "-",
  ]);
});

test("buildExecArgs: verilmeyen seçenekler bayrak üretmez", () => {
  const args = buildExecArgs({ prompt: "x" }, {}, null, "/tmp/son.txt");
  assert.deepEqual(args, [
    "exec", "--ephemeral", "--skip-git-repo-check", "--color", "never",
    "-s", "read-only", "--json", "-o", "/tmp/son.txt", "-",
  ]);
});

// Sahte codex binary'si: gerçek codex olmadan spawn/stdin/timeout/temizlik
// hattını uçtan uca test eder. Betik -o'nun değerine yazar, --version'a cevap verir.
// Yaratılan her dizin dosya sonunda silinir: temizlik isteğe bağlı bırakılırsa
// yapılmıyor (çalışma sözleşmesi §3) — her koşum tmpdir'e üç dizin bırakırdı.
const fakeBinDirs: string[] = [];
after(() => {
  for (const d of fakeBinDirs) rmSync(d, { recursive: true, force: true });
});

/** `--json` akışının varsayılan taklidi: bir tur + iki item + JSON olmayan gürültü. */
const DEFAULT_STREAM_LINES = [
  "codex-cli 9.9.9 basliyor",  // akışta JSON olmayan satır da olur; atlanmalı
  '{"type":"item.completed"}',
  '{"type":"item.completed"}',
  '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":800,"output_tokens":90,"reasoning_output_tokens":40}}',
];

/**
 * M4.1: tavan denetimi AKIŞ SÜRERKEN kesmek zorunda. "ok"/"fail" varyantları
 * akışı tek seferde basıp hemen çıkıyor — kesmenin gerçekten olup olmadığı
 * orada ölçülemez (süreç zaten ölmüş olurdu). "drip" satırları aralıklı basar
 * ve sonunda ASILIR: tavan çalışmazsa test zaman aşımına düşer, yani yeşil
 * kalmakla kesmeyi ispat etmek aynı şey olur.
 */
const DRIP_TURN_LINES = (turns: number, tokensPerTurn: number): string[] =>
  Array.from({ length: turns }, () => [
    '{"type":"item.completed"}',
    `{"type":"turn.completed","usage":{"input_tokens":${tokensPerTurn}}}`,
  ]).flat();

function fakeCodexBinary(
  behavior: "ok" | "fail" | "hang" | "drip" | "noeol",
  streamLines: string[] = DEFAULT_STREAM_LINES,
): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-fake-codex-"));
  fakeBinDirs.push(dir);
  const bin = join(dir, "codex");
  const body =
    behavior === "ok"
      ? `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > /dev/null   # stdin'deki prompt'u tüket
cat <<'CP_STREAM_EOF'
${streamLines.join("\n")}
CP_STREAM_EOF
printf '{"findings":[]}' > "$out"
exit 0`
      : behavior === "fail"
        ? `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
cat <<'CP_STREAM_EOF'
${streamLines.join("\n")}
CP_STREAM_EOF
echo "kota doldu" >&2; exit 1`
        : behavior === "noeol"
          ? // Son satır YENİ SATIRSIZ biter: onu ancak akış kapanırken koşan
            // finish() işler. Kesme yolunun "süreç zaten ölmüş" hâlini ölçmenin
            // tek yolu bu — heredoc her satırın sonuna \n koyduğu için "ok"
            // varyantı bu durumu üretemiyor.
            `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > /dev/null
${streamLines.slice(0, -1).map((l) => `echo '${l}'`).join("\n")}
printf '%s' '${streamLines[streamLines.length - 1] ?? ""}'
printf '{"findings":[]}' > "$out"
exit 0`
          : behavior === "drip"
          ? // Satır tek tırnakla sarılıyor: akış olayları JSON, içlerinde tek
            // tırnak yok — varsa burada sessizce bozulurdu.
            `#!/bin/sh
cat > /dev/null   # stdin'deki prompt'u tüket
${streamLines.map((l) => `echo '${l}'\nsleep 0.05`).join("\n")}
sleep 60`
          : `#!/bin/sh
cat <<'CP_STREAM_EOF'
${streamLines.join("\n")}
CP_STREAM_EOF
sleep 60`;
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return bin;
}

test("CodexExecutor: sahte binary ile başarılı koşum son mesajı döndürür", async () => {
  const exec = createCodexExecutor({ binary: fakeCodexBinary("ok") });
  const det = await exec.detect();
  assert.deepEqual(det, { found: true, version: "9.9.9" });
  const res = await exec.run({ prompt: "merhaba", outputSchema: { type: "object" } });
  assert.equal(res.ok, true);
  assert.equal(res.output, '{"findings":[]}');
  assert.deepEqual(res.usage, {
    inputTokens: 1200,
    cachedInputTokens: 800,
    outputTokens: 90,
    reasoningOutputTokens: 40,
    items: 2,
    turns: 1,
  });
});

// M4.1: tavan denetiminin girdisi maliyettir; "ölçemedim" ile "sıfır harcadım"
// aynı şey değil — akış hiç gelmediyse usage UNDEFINED kalır, 0 uydurulmaz.
test("CodexExecutor: --json akışı hiç gelmezse usage undefined kalır", async () => {
  const exec = createCodexExecutor({ binary: fakeCodexBinary("ok", []) });
  const res = await exec.run({ prompt: "x" });
  assert.equal(res.ok, true);
  assert.equal(res.usage, undefined);
});

// Prototip (tools/altin-set/adjudicate-cost.ts) son turun usage'ını alıyordu;
// araçlı hakem çok turlu koşuyor ve tavan TOPLAM harcamaya bakacak.
test("CodexExecutor: birden çok turn.completed geldiğinde usage toplanır", async () => {
  const bin = fakeCodexBinary("ok", [
    '{"type":"item.completed"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":10,"cache_write_input_tokens":3,"output_tokens":5,"reasoning_output_tokens":1}}',
    '{"type":"item.completed"}',
    '{"type":"item.completed"}',
    '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":20,"cache_write_input_tokens":4,"output_tokens":7,"reasoning_output_tokens":2}}',
  ]);
  const res = await createCodexExecutor({ binary: bin }).run({ prompt: "x" });
  // cache_write_input_tokens gerçek akışta var (14 Ağu json-probe) ve
  // ücretlendiriliyor; taşınmazsa maliyet kalibrasyonunda görünmeyen kalem olur.
  assert.deepEqual(res.usage, {
    inputTokens: 300,
    cachedInputTokens: 30,
    cacheWriteInputTokens: 7,
    outputTokens: 12,
    reasoningOutputTokens: 3,
    items: 3,
    turns: 2,
  });
});

// Eksik alt-alan 0 DEĞİL undefined: "ölçmedim" ile "sıfır harcadım" ayrımı
// tavanın (Task 2) tam girdisi — sıfır yazmak bütçeyi sessizce yanıltır.
test("CodexExecutor: usage'ın eksik alt-alanları undefined kalır, 0 uydurulmaz", async () => {
  const bin = fakeCodexBinary("ok", [
    '{"type":"item.completed"}',
    '{"type":"turn.completed","usage":{"input_tokens":7}}',
  ]);
  const res = await createCodexExecutor({ binary: bin }).run({ prompt: "x" });
  assert.deepEqual(res.usage, { inputTokens: 7, items: 1, turns: 1 });
});

// Başarısız koşum da token harcar. Bu iki test o yolları SABİTLİYOR: davranış
// zaten doğruydu ama testsizdi — bir refactor usage'ı düşürse suite yeşil kalırdı.
test("CodexExecutor: sıfır-dışı çıkışta harcanan usage kaybolmaz", async () => {
  const res = await createCodexExecutor({ binary: fakeCodexBinary("fail") }).run({ prompt: "x" });
  assert.equal(res.ok, false);
  assert.equal(res.output, "");
  assert.deepEqual(res.usage, {
    inputTokens: 1200, cachedInputTokens: 800, outputTokens: 90, reasoningOutputTokens: 40, items: 2, turns: 1,
  });
});

test("CodexExecutor: zaman aşımında harcanan usage kaybolmaz", async () => {
  // 300 ms değil 2000 ms: ölçüldü — dolu suite altında sahte binary akışı
  // basmadan timeout ateşliyor ve test yanıltıcı biçimde kırmızıya dönüyordu
  // (tek başına koşarken yeşil). Süre, çocuğun yazmasına marj bırakmak için.
  const exec = createCodexExecutor({ binary: fakeCodexBinary("hang"), timeoutMs: 2000 });
  const res = await exec.run({ prompt: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error!, /zaman aşımı/);
  assert.equal(res.capExceeded, undefined, "süre aşımı tavan aşımı değildir (M4.1)");
  assert.deepEqual(res.usage, {
    inputTokens: 1200, cachedInputTokens: 800, outputTokens: 90, reasoningOutputTokens: 40, items: 2, turns: 1,
  });
});

// --- M4.1 Task 2: token + tur tavanı -------------------------------------
// Gerekçe ölçüldü: istemdeki "60 sn içinde bitir" talimatı BAĞLAMADI, bir hakem
// 3 dakikalık döngü koştu. Tavan istemde değil kodda duruyor.
//
// timeoutMs bu testlerde bilerek bol (10 sn): kesmenin sebebi SÜRE olursa test
// tavanı değil zaman aşımını ölçmüş olur. Ölçülmüş ders (önceki tur): suite
// yükü altında sahte binary'nin ilk stdout chunk'ı ~419 ms gecikebiliyor.
test("CodexExecutor: item tavanı aşılınca süreç kesilir ve capExceeded döner", async () => {
  const bin = fakeCodexBinary("drip", DRIP_TURN_LINES(10, 1));
  const exec = createCodexExecutor({ binary: bin, timeoutMs: 10_000 });
  const res = await exec.run({ prompt: "x", caps: { maxItems: 3 } });
  assert.equal(res.ok, false);
  assert.equal(res.output, "", "ok=false iken output boş dize");
  assert.equal(res.capExceeded?.kind, "items");
  assert.equal(res.capExceeded?.limit, 3);
  assert.ok(res.capExceeded!.observed >= 3, `observed=${res.capExceeded!.observed}`);
  assert.doesNotMatch(res.error!, /zaman aşımı/, "kesme sebebi süre değil tavan olmalı");
  // Kesilen koşum da harcadığını raporlar: tavanın girdisi o ana kadarki toplam.
  assert.ok(res.usage!.items! >= 3, `usage.items=${res.usage?.items}`);
  // Süreç 10 turu bitirmeden öldü — yoksa akış 20 satır basardı.
  assert.ok(res.usage!.items! < 10, `10 turun tamamı akmış: ${res.usage?.items}`);
});

// Reviewer probe'u: maxItems ADI GEREĞİ item saymalı. Eski kod `turns`ü
// item.completed sayacına bağlamıştı — hiç turn.completed içermeyen bir akışta
// "4 tur > 3" diye YANLIŞ eksen raporluyordu. Burada oran 6 item : 1 turn.
test("CodexExecutor: item ≠ turn — tavan item'ı sayar, usage ikisini ayrı raporlar", async () => {
  const bin = fakeCodexBinary("ok", [
    ...Array.from({ length: 6 }, () => '{"type":"item.completed"}'),
    '{"type":"turn.completed","usage":{"input_tokens":50}}',
  ]);
  const gevsek = await createCodexExecutor({ binary: bin }).run({ prompt: "x", caps: { maxItems: 10 } });
  assert.equal(gevsek.ok, true, "6 item 10'luk tavanın altında");
  assert.deepEqual(gevsek.usage, { inputTokens: 50, items: 6, turns: 1 });

  const siki = await createCodexExecutor({ binary: bin }).run({ prompt: "x", caps: { maxItems: 4 } });
  assert.equal(siki.capExceeded?.kind, "items");
  assert.equal(siki.capExceeded?.observed, 5, "5. item tavanı aşan ilk olay");
  assert.match(siki.error!, /item/);
});

// Yalnız item görülüp turn.completed hiç gelmeyen akış: token ÖLÇÜLMEDİ
// (alanlar yok), item ölçüldü. "Ölçmedim" 0 ile doldurulmaz.
test("CodexExecutor: turn.completed'sız akışta usage yalnız items taşır", async () => {
  const bin = fakeCodexBinary("ok", Array.from({ length: 3 }, () => '{"type":"item.completed"}'));
  const res = await createCodexExecutor({ binary: bin }).run({ prompt: "x" });
  assert.deepEqual(res.usage, { items: 3 });
});

test("CodexExecutor: token tavanı aşılınca kesilir, capExceeded.kind tokens", async () => {
  const bin = fakeCodexBinary("drip", DRIP_TURN_LINES(10, 600));
  const exec = createCodexExecutor({ binary: bin, timeoutMs: 10_000 });
  const res = await exec.run({ prompt: "x", caps: { maxTotalTokens: 1000 } });
  assert.equal(res.ok, false);
  assert.equal(res.output, "");
  assert.equal(res.capExceeded?.kind, "tokens");
  assert.equal(res.capExceeded?.limit, 1000);
  // İkinci turda kesilir: 600 tavanın altında, 1200 üstünde.
  assert.equal(res.capExceeded?.observed, 1200);
  assert.equal(res.usage?.inputTokens, 1200);
});

test("CodexExecutor: caps verilmezse kesme yok, davranış eskisiyle aynı", async () => {
  const bin = fakeCodexBinary("ok", DRIP_TURN_LINES(10, 600));
  const res = await createCodexExecutor({ binary: bin }).run({ prompt: "x" });
  assert.equal(res.ok, true);
  assert.equal(res.output, '{"findings":[]}');
  assert.equal(res.capExceeded, undefined);
  assert.deepEqual(res.usage, { inputTokens: 6000, items: 10, turns: 10 });
});

// Tavanın ALTINDA kalan koşum başarısız sayılmamalı: aşım STRICT (>) ölçülür,
// yoksa bütçesini tam kullanan meşru bir koşum kesilirdi.
test("CodexExecutor: tavana eşit maliyet aşım değildir", async () => {
  const bin = fakeCodexBinary("ok", DRIP_TURN_LINES(2, 500));
  const res = await createCodexExecutor({ binary: bin }).run({
    prompt: "x",
    caps: { maxTotalTokens: 1000, maxItems: 2 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.capExceeded, undefined);
});

// Yıkıcı sınıf: kuyrukta kalan son satır tavanı aşarsa onProgress, close
// handler'ının İÇİNDE — untrack'ten sonra — koşuyordu ve kill(-pid) çağırıyordu.
// PID o an işletim sistemince geri dönüştürülmüş olabilir: ALAKASIZ bir süreç
// grubu ölür. Aşım raporlanmalı, kill çağrılmamalı.
test("CodexExecutor: süreç kapandıktan sonra kesme çağrılmaz (PID geri dönüşümü)", async (t) => {
  const bin = fakeCodexBinary("noeol", [
    '{"type":"item.completed"}',
    '{"type":"turn.completed","usage":{"input_tokens":5000}}', // yeni satırsız: finish()'te işlenir
  ]);
  const kills: unknown[][] = [];
  const gercekKill = process.kill;
  // Kayıt tutar ama İLETMEZ: geri dönüştürülmüş bir PID'ye gerçekten sinyal
  // göndermek testin kendisini tehlikeli yapardı.
  process.kill = ((...a: unknown[]) => {
    kills.push(a);
    return true;
  }) as typeof process.kill;
  t.after(() => {
    process.kill = gercekKill;
  });

  const res = await createCodexExecutor({ binary: bin, timeoutMs: 10_000 }).run({
    prompt: "x",
    caps: { maxTotalTokens: 1000 },
  });
  process.kill = gercekKill;

  assert.equal(res.ok, false);
  assert.equal(res.output, "");
  assert.equal(res.capExceeded?.kind, "tokens");
  assert.equal(res.capExceeded?.observed, 5000, "aşım kuyruktaki son satırdan görülmeli");
  assert.deepEqual(kills, [], `kapanmış sürece sinyal gönderildi: ${JSON.stringify(kills)}`);
});

// Üç eksen ayrık: süre aşımı capExceeded TAŞIMAZ ki çağıran taraf
// budgetExhausted / measurementFailed ayrımını yapabilsin.
test("CodexExecutor: süre aşımı capExceeded taşımaz", async () => {
  const bin = fakeCodexBinary("drip", DRIP_TURN_LINES(10, 1));
  const exec = createCodexExecutor({ binary: bin, timeoutMs: 300 });
  const res = await exec.run({ prompt: "x", caps: { maxItems: 100 } });
  assert.equal(res.ok, false);
  assert.match(res.error!, /zaman aşımı/);
  assert.equal(res.capExceeded, undefined);
});

test("CodexExecutor: sıfır-dışı çıkış ok=false ve stderr kuyruğu taşır", async () => {
  const exec = createCodexExecutor({ binary: fakeCodexBinary("fail") });
  const res = await exec.run({ prompt: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error!, /kota doldu/);
});

test("CodexExecutor: zaman aşımı süreci öldürür ve ok=false döner", async () => {
  const exec = createCodexExecutor({ binary: fakeCodexBinary("hang"), timeoutMs: 300 });
  const res = await exec.run({ prompt: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error!, /zaman aşımı/);
});

// class: executor-parent-kill-leaks
// Üst süreç SIGTERM/SIGINT alınca `finally` KOŞMUYOR (Node varsayılanı süreci
// doğrudan sonlandırıyor): detached çocuk süreç grubu ve cp-codex-* geçici
// dizini diskte kalıyordu. SIGKILL onarılamaz — orada hiçbir kod koşmaz — ama
// bu iki sinyal onarılabilir ve ölçülen sızıntı buradan geliyordu.
test("CodexExecutor: SIGTERM'de geçici dizin ve çocuk süreç grubu temizlenir", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cp-signal-"));
  fakeBinDirs.push(dir);
  const marker = join(dir, "cocuk.durum");
  const bin = join(dir, "codex");
  // Sahte binary kendi PID'sini ve -o ile verilen geçici dizini bildirir, sonra
  // asılı kalır: temizliğin gerçekten koştuğunu dışarıdan ölçebilelim diye.
  writeFileSync(
    bin,
    `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
printf '%s\\n%s\\n' "$$" "$(dirname "$out")" > "$FAKE_MARKER"
sleep 60`,
  );
  chmodSync(bin, 0o755);

  const codexUrl = pathToFileURL(join(import.meta.dirname, "../src/adapters/codex.ts")).href;
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const { createCodexExecutor } = await import(${JSON.stringify(codexUrl)});
       await createCodexExecutor({ binary: process.env.FAKE_BINARY, timeoutMs: 60000 }).run({ prompt: "sinyal testi" });`,
    ],
    { env: { ...process.env, FAKE_BINARY: bin, FAKE_MARKER: marker }, stdio: ["ignore", "ignore", "inherit"] },
  );
  t.after(() => child.kill("SIGKILL"));

  const bekle = async (kosul: () => boolean, ms: number, ne: string) => {
    const son = Date.now() + ms;
    while (Date.now() < son) {
      if (kosul()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(ne);
  };
  const okunanMarker = () =>
    existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : [];

  await bekle(() => okunanMarker().length >= 2, 5000, "sahte yürütücü çocuğu hiç başlamadı");
  const [torunPid, gecici] = okunanMarker();
  assert.ok(existsSync(gecici!), "geçici dizin ölçümden önce yok");

  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("üst süreç SIGTERM sonrası kapanmadı")), 5000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const torunOldu = () => {
    try {
      process.kill(Number(torunPid), 0);
      return false;
    } catch {
      return true;
    }
  };
  await bekle(torunOldu, 3000, "çocuk süreç grubu SIGTERM sonrası yaşamaya devam etti");
  assert.equal(existsSync(gecici!), false, "cp-codex-* geçici dizini diskte kaldı");
});

test("CodexExecutor: binary yoksa detect bulunamadı der, run ok=false döner", async () => {
  const exec = createCodexExecutor({ binary: "/yok/boyle/codex" });
  const det = await exec.detect();
  assert.equal(det.found, false);
  const res = await exec.run({ prompt: "x" });
  assert.equal(res.ok, false);
});
