# M2 — Gözlemci Döngüsü Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Süzülmüş transcript turn'lerinden Codex headless ile kaliteli, çapalı, append-only bulgular çıkarıp depoya yazmak.

**Architecture:** `scanOnce`'ın `onTurns` kancasına bir `Observer` takılır: turn'ler ~8k token'lık partilere bölünür, her parti aktif bulgu **başlık listesi** + parti metniyle `codex exec`'e gider, çıktı JSON şemayla doğrulanıp `appendFinding`/`supersede` ile depoya iner. En-az-bir-kez teslimin mükerrer üretime dönüşmemesi için oturum başına **filigran** (son işlenen turn uuid'i) bulgularla aynı transaksiyonda ilerler.

**Tech Stack:** Node 24 + TypeScript tip-soyma, `node:sqlite`, `node:test`, `node:child_process` — sıfır çalışma-zamanı bağımlılığı korunur (K12). Yürütücü: codex-cli (`codex exec`, makinede 0.146.0 doğrulandı).

## Global Constraints

- **K12:** Sıfır çalışma-zamanı bağımlılığı; yalnız devDependencies (`typescript`, `@types/node`).
- **K2:** Codex sert bağımlılık — yoksa `observe` çalışmaz, kurulum yönlendirmesi gösterir.
- **K7 / spec §2.1:** Canlı oturuma asla yazılmaz; gözlemci çağrıları `--ephemeral` (Codex oturum geçmişi bile kirlenmez).
- **Spec §2.3:** Append-only — gözlemci yalnız ekler veya `supersedes` der; `findings.content` UPDATE edilmez (şema tetikleyicisi zaten engelliyor).
- **Spec §2.2:** Gözlemci bağlamı sınırlı: durum = başlık listesi (~2-3k token), parti ~8k token; özet-üstüne-özet yok.
- **Spec §3.7:** Geçersiz JSON → bir yeniden isteme → parti "işlenemedi" işareti (events'e, görünür). Sessiz atlama yok.
- **Dil:** kod ve identifier İngilizce, yorum/doküman/test adları Türkçe.
- **Git:** commit mesajlarında `Co-Authored-By` / "Generated with" / 🤖 YOK. Commit serbest, push yalnız Burak isteyince.
- **Doğrulama:** her görev sonunda `cd core && npm run typecheck && npm test` yeşil olmadan commit yok.

---

## M2 tasarım kararları

Her karar gerekçesiyle; gerekçesi çökerse karar yeniden tartışılır (sessizce değil).

| # | Karar | Gerekçe |
|---|---|---|
| D-M2-1 | **Partiler tarama sınırında tamamlanır** — her taramada o oturumun tüm yeni turn'leri ≥1 partiye bölünüp işlenir; eşik altı kuyruk partisi de gönderilir | `onTurns` döndükten sonra imleç ilerliyor (M1 sözleşmesi). Eşik altı kalanı bekletmek imleci geçmiş turn'lerin ötesine taşır ve o turn'ler gözlemciye bir daha gelmez. Bedel: damla damla akan oturumda küçük partiler. Kabul edildi; 90 sn'lik periyodik döngü M5'te bu bedeli yeniden değerlendirir |
| D-M2-2 | **Filigran tablosu** `observer_watermarks (project_id, session_id) → last_uuid`; bulgu yazımı + filigran **aynı tx** | Teslim en-az-bir-kez (M1 devri): gözlemci yazıp imleç yazılmadan çökülürse aynı turn'ler yeniden gelir. Filigran aynı tx'te ilerlediği için etki tam-bir-kez: tekrar gelen turn'ler `dropThroughWatermark` ile düşer. Turn içeriği saklanmaz — depoda turn tablosu yok kuralı korunur (transcript zaten diskte) |
| D-M2-3 | **Zehirli parti** (iki yürütücü hatası ya da iki geçersiz JSON) → `observer_batch_unprocessed` olayı + filigran partinin SONUNA ilerler | Filigran ilerlemezse her tarama aynı partiyi yeniden dener → sonsuz döngü + sonsuz maliyet. Kayıp görünürdür (events + dashboard) ve geri kazanılabilir: transcript diskte, olay kaydı uuid aralığını taşır |
| D-M2-4 | **Sel koruması:** imleçsiz (hiç taranmamış) depoda `observe` reddeder → önce `scan` (taban çizgisi); `--session` modunda tahmini çağrı > 20 ise `--yes` şart | Ölçüldü (M1): 35 silo → 15,5 MB süzülmüş ≈ ~4M token ≈ ~500 Codex çağrısı; en büyük tek oturum ~2M token ≈ ~250 çağrı. "Onaysız hiçbir şey" ilkesi maliyet için de geçerli |
| D-M2-5 | `codex exec` çağrı biçimi: prompt **stdin**'den, `--ephemeral -s read-only --skip-git-repo-check --color never --output-schema <dosya> -o <dosya>` | Bayraklar makinede doğrulandı (0.146.0). stdin → ARG_MAX derdi yok; `--output-schema` → JSON'u model tarafında şemaya bağlar; `-o` → son mesaj dosyadan okunur, stdout'un insan-gözü gürültüsünden ayrışır; `--ephemeral` → K7'nin Codex tarafı |
| D-M2-6 | Gözlemci varsayılanı: kullanıcının Codex varsayılan modeli + `model_reasoning_effort="low"`; ikisi de ayarlanabilir | Çıkarım görevi muhakeme değil eleme; düşük effort maliyeti düşürür. Model dayatılmaz — kullanıcının config'i geçerli (ürün başkasının PC'sinde de koşacak). `low` değeri Görev 2'de gerçek bir çağrıyla doğrulanır |
| D-M2-7 | Gözlemci prompt'u Türkçe; bulgu içeriği **oturumun dilinde** | Prototipin tek kullanıcısı ve test oturumları Türkçe. Ürünleşirken prompt İngilizce'ye çevrilir (tek dosyada, `observer/prompt.ts`) |
| D-M2-8 | Gözlemciye `-C` (cwd) verilmez | Gözlemci araçsız bir eleme görevi; disk okuması gerekmiyor ve sandbox read-only. `cwd` alanı seam'de var ama M2'de boş — M4 hakemi (araçlı, proje dizininde) kullanacak |

---

## Dosya yapısı

```
core/src/
  adapters/
    executor.ts        # YENİ — ExecutorAdapter seam'i + registry (transcript.ts aynası)
    codex.ts           # YENİ — Codex tespiti + codex exec sarmalayıcı
    claude-code.ts     # DEĞİŞİR — readCwd export edilir (--session modu için)
  observer/
    batch.ts           # YENİ — saf partileyici: token tahmini, filigran süzme, parti kesme
    prompt.ts          # YENİ — durum başlıkları, prompt metni, çıktı şeması + doğrulama
    observer.ts        # YENİ — döngü: parti → codex → doğrula → tx(bulgu+filigran+olay)
  store/
    schema.sql         # DEĞİŞİR — observer_watermarks tablosu
    watermarks.ts      # YENİ — filigran oku/yaz
    events.ts          # DEĞİŞİR — iki yeni olay türü
  observe-cmd.ts       # YENİ — observe'un karar mantığı (sel koruması, maliyet tahmini)
  cli.ts               # DEĞİŞİR — observe komutu + koruma kapıları
core/test/
  executor.test.ts     # YENİ — seam + sahte codex binary ile uçtan uca
  batch.test.ts        # YENİ
  prompt.test.ts       # YENİ
  observer.test.ts     # YENİ — FakeExecutor ile döngünün tamamı
  helpers.ts           # DEĞİŞİR — fakeExecutor eklenir
docs/olcumler/
  2026-08-XX-m2-gozlemci-olcumu.md  # YENİ — çıkış kapısı ölçümü (Görev 8)
```

---

### Görev 1: ExecutorAdapter seam'i + FakeExecutor

**Files:**
- Create: `core/src/adapters/executor.ts`
- Modify: `core/test/helpers.ts`
- Test: `core/test/executor.test.ts`

**Interfaces:**
- Consumes: yok (yalnız tipler).
- Produces: `ExecutorAdapter { id; detect(): Promise<ExecutorDetection>; run(req: ExecutorRequest): Promise<ExecutorResult> }`, `ExecutorRequest { prompt: string; outputSchema?: object; cwd?: string; timeoutMs?: number }`, `ExecutorResult { ok: boolean; output: string; error?: string; durationMs: number }`, `registerExecutor/getExecutor`, test tarafında `fakeExecutor(script)`.

- [ ] **Adım 1: Kırmızı test**

`core/test/executor.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerExecutor, getExecutor } from "../src/adapters/executor.ts";
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
  assert.match(r2.error!, /patladı: ikinc/);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].prompt, "birinci");
});
```

- [ ] **Adım 2: Kırmızıyı doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/executor.test.ts`
Expected: FAIL — `executor.ts` yok / `fakeExecutor` export edilmemiş.

- [ ] **Adım 3: Implementasyon**

`core/src/adapters/executor.ts`:

```ts
// Yürütücü seam'i (spec K10'un ikinci bacağı). Prototipte tek implementasyon
// (Codex headless) ama arayüz gün birden tanımlı — transcript.ts ile aynı sebep.
//
// Gözlemci (M2) ve hakem (M4) LLM'i yalnız bu arayüzden görür; testler sahte
// yürütücüyle koşar (seam'in ilk kârı, spec §3.8).

export interface ExecutorDetection {
  found: boolean;
  version?: string;
  error?: string;
}

export interface ExecutorRequest {
  prompt: string;
  /** Çıktının uyması gereken JSON Şeması — modele iletilir (codex --output-schema). */
  outputSchema?: object;
  /** Çalışma dizini. Gözlemci vermez (D-M2-8); araçlı hakem (M4) verecek. */
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecutorResult {
  ok: boolean;
  /** Modelin son mesajı; ok=false iken boş dize. */
  output: string;
  error?: string;
  durationMs: number;
}

export interface ExecutorAdapter {
  readonly id: string;
  detect(): Promise<ExecutorDetection>;
  run(req: ExecutorRequest): Promise<ExecutorResult>;
}

const registry = new Map<string, ExecutorAdapter>();

export function registerExecutor(adapter: ExecutorAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getExecutor(id: string): ExecutorAdapter {
  const a = registry.get(id);
  if (!a) throw new Error(`bilinmeyen yürütücü: ${id} (kayıtlı: ${[...registry.keys()].join(", ") || "yok"})`);
  return a;
}
```

`core/test/helpers.ts`'e ek (mevcut export'ların yanına):

```ts
import type { ExecutorAdapter, ExecutorRequest, ExecutorResult } from "../src/adapters/executor.ts";

type FakeStep = Partial<ExecutorResult> | ((req: ExecutorRequest) => Partial<ExecutorResult>);

/**
 * Senaryolu sahte yürütücü. Her run() çağrısı senaryodan bir adım tüketir;
 * senaryo biterse varsayılan "boş bulgu" cevabı döner. Çağrılar `calls`te
 * birikir — testler prompt içeriğini buradan denetler.
 */
export function fakeExecutor(script: FakeStep[]): ExecutorAdapter & { calls: ExecutorRequest[] } {
  const calls: ExecutorRequest[] = [];
  let i = 0;
  return {
    id: "fake",
    calls,
    async detect() {
      return { found: true, version: "fake-1.0.0" };
    },
    async run(req) {
      calls.push(req);
      const step = script[i++];
      const partial = typeof step === "function" ? step(req) : (step ?? {});
      return {
        ok: partial.ok ?? true,
        output: partial.output ?? '{"findings":[]}',
        error: partial.error,
        durationMs: partial.durationMs ?? 1,
      };
    },
  };
}
```

- [ ] **Adım 4: Yeşili doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/executor.test.ts`
Expected: PASS (2 test).

- [ ] **Adım 5: Tam doğrulama + commit**

Run: `cd core && npm run typecheck && npm test`
Expected: hepsi yeşil (73 + 2).

```bash
git add core/src/adapters/executor.ts core/test/helpers.ts core/test/executor.test.ts
git commit -m "M2: ExecutorAdapter seam'i + sahte yürütücü"
```

---

### Görev 2: Codex tespiti + CodexExecutor

**Files:**
- Create: `core/src/adapters/codex.ts`
- Test: `core/test/executor.test.ts` (aynı dosyaya eklenir)

**Interfaces:**
- Consumes: `ExecutorAdapter`, `ExecutorRequest`, `ExecutorResult`, `ExecutorDetection` (Görev 1).
- Produces: `createCodexExecutor(opts?: CodexOptions): ExecutorAdapter`, `CodexOptions { model?: string; reasoningEffort?: "minimal"|"low"|"medium"|"high"; timeoutMs?: number; binary?: string }`, `buildExecArgs(req, opts, schemaPath, outPath): string[]` (saf, test için export).

- [ ] **Adım 1: Kırmızı test**

`core/test/executor.test.ts`'e ek:

```ts
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexExecutor, buildExecArgs } from "../src/adapters/codex.ts";

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
    "--output-schema", "/tmp/sema.json", "-o", "/tmp/son.txt", "-",
  ]);
});

test("buildExecArgs: verilmeyen seçenekler bayrak üretmez", () => {
  const args = buildExecArgs({ prompt: "x" }, {}, null, "/tmp/son.txt");
  assert.deepEqual(args, [
    "exec", "--ephemeral", "--skip-git-repo-check", "--color", "never",
    "-s", "read-only", "-o", "/tmp/son.txt", "-",
  ]);
});

// Sahte codex binary'si: gerçek codex olmadan spawn/stdin/timeout/temizlik
// hattını uçtan uca test eder. Betik -o'nun değerine yazar, --version'a cevap verir.
function fakeCodexBinary(behavior: "ok" | "fail" | "hang"): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-fake-codex-"));
  const bin = join(dir, "codex");
  const body =
    behavior === "ok"
      ? `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > /dev/null   # stdin'deki prompt'u tüket
printf '{"findings":[]}' > "$out"
exit 0`
      : behavior === "fail"
        ? `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
echo "kota doldu" >&2; exit 1`
        : `#!/bin/sh
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

test("CodexExecutor: binary yoksa detect bulunamadı der, run ok=false döner", async () => {
  const exec = createCodexExecutor({ binary: "/yok/boyle/codex" });
  const det = await exec.detect();
  assert.equal(det.found, false);
  const res = await exec.run({ prompt: "x" });
  assert.equal(res.ok, false);
});
```

- [ ] **Adım 2: Kırmızıyı doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/executor.test.ts`
Expected: FAIL — `codex.ts` yok.

- [ ] **Adım 3: Implementasyon**

`core/src/adapters/codex.ts`:

```ts
// Codex headless yürütücüsü (spec K1, K2). Bayraklar 0.146.0'da doğrulandı:
//   --ephemeral            oturum dosyası kalmaz (K7'nin Codex tarafı)
//   -s read-only           sandbox: yazma yok
//   --output-schema <f>    son cevabı JSON şemaya bağlar
//   -o <f>                 son mesaj dosyaya — stdout'un insan-gözü akışından bağımsız
//   prompt stdin'den ("-") — büyük partilerde ARG_MAX derdi yok (D-M2-5)

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorAdapter, ExecutorDetection, ExecutorRequest, ExecutorResult } from "./executor.ts";

export interface CodexOptions {
  /** Verilmezse kullanıcının ~/.codex/config.toml varsayılanı geçerli (D-M2-6). */
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Parti başına üst sınır; varsayılan 180 sn. */
  timeoutMs?: number;
  /** Testlerde sahte binary; üretimde PATH'teki "codex". */
  binary?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const STDERR_TAIL = 500;

/** Saf: komut satırını üretir. Ayrı fonksiyon, çünkü sözleşme testle sabitleniyor. */
export function buildExecArgs(
  req: ExecutorRequest,
  opts: CodexOptions,
  schemaPath: string | null,
  outPath: string,
): string[] {
  const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never", "-s", "read-only"];
  if (req.cwd) args.push("-C", req.cwd);
  if (opts.model) args.push("-m", opts.model);
  if (opts.reasoningEffort) args.push("-c", `model_reasoning_effort="${opts.reasoningEffort}"`);
  if (schemaPath) args.push("--output-schema", schemaPath);
  args.push("-o", outPath, "-");
  return args;
}

export function createCodexExecutor(opts: CodexOptions = {}): ExecutorAdapter {
  const binary = opts.binary ?? "codex";

  return {
    id: "codex",

    async detect(): Promise<ExecutorDetection> {
      return new Promise((resolve) => {
        const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
        child.on("error", (err) => resolve({ found: false, error: err.message }));
        child.on("close", (code) => {
          const m = out.match(/codex-cli (\d+\.\d+\.\d+)/);
          if (code === 0 && m) resolve({ found: true, version: m[1] });
          else resolve({ found: false, error: `çıkış ${code}: ${out.trim().slice(0, 200)}` });
        });
      });
    },

    async run(req: ExecutorRequest): Promise<ExecutorResult> {
      const started = Date.now();
      // Geçici dosyalar çağrı başına izole dizinde; finally'de silinir —
      // temizlik isteğe bağlı değil (çalışma sözleşmesi §3).
      const tmp = await mkdtemp(join(tmpdir(), "cp-codex-"));
      try {
        const outPath = join(tmp, "son-mesaj.txt");
        let schemaPath: string | null = null;
        if (req.outputSchema) {
          schemaPath = join(tmp, "sema.json");
          await writeFile(schemaPath, JSON.stringify(req.outputSchema));
        }
        const args = buildExecArgs(req, opts, schemaPath, outPath);
        const timeoutMs = req.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        const done = await new Promise<{ code: number | null; stderr: string; timedOut: boolean; spawnError?: string }>(
          (resolve) => {
            const child = spawn(binary, args, { stdio: ["pipe", "ignore", "pipe"] });
            let stderr = "";
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, timeoutMs);
            child.stderr.on("data", (d: Buffer) => {
              stderr = (stderr + d.toString("utf8")).slice(-4096);
            });
            child.on("error", (err) => {
              clearTimeout(timer);
              resolve({ code: null, stderr, timedOut, spawnError: err.message });
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              resolve({ code, stderr, timedOut });
            });
            child.stdin.on("error", () => {}); // erken ölen süreçte EPIPE yutulur; sonuç zaten close'ta
            child.stdin.write(req.prompt);
            child.stdin.end();
          },
        );

        const durationMs = Date.now() - started;
        if (done.spawnError) return { ok: false, output: "", error: `codex başlatılamadı: ${done.spawnError}`, durationMs };
        if (done.timedOut) return { ok: false, output: "", error: `zaman aşımı (${timeoutMs} ms)`, durationMs };
        if (done.code !== 0)
          return { ok: false, output: "", error: `çıkış ${done.code}: ${done.stderr.trim().slice(-STDERR_TAIL)}`, durationMs };

        const output = await readFile(outPath, "utf8").catch(() => "");
        if (!output.trim())
          return { ok: false, output: "", error: "codex son mesaj dosyasını boş bıraktı", durationMs };
        return { ok: true, output, durationMs };
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  };
}
```

- [ ] **Adım 4: Yeşili doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/executor.test.ts`
Expected: PASS (7 test).

- [ ] **Adım 5: `model_reasoning_effort` anahtarını GERÇEK codex'le doğrula**

Config anahtarı dokümandan değil ölçümden gelsin (yanlış anahtar sessizce yutulabilir):

Run: `codex exec --ephemeral --skip-git-repo-check --color never -s read-only -c 'model_reasoning_effort="low"' -o /tmp/cp-effort-test.txt - <<< 'Yalnız OK yaz.' && cat /tmp/cp-effort-test.txt && rm /tmp/cp-effort-test.txt`
Expected: hatasız koşar, çıktı "OK" içerir. Anahtar reddedilirse (`unknown config`) codex config dokümanına bakıp doğru anahtarla `buildExecArgs`'ı ve testini güncelle.

- [ ] **Adım 6: Tam doğrulama + commit**

Run: `cd core && npm run typecheck && npm test`
Expected: hepsi yeşil.

```bash
git add core/src/adapters/codex.ts core/test/executor.test.ts
git commit -m "M2: Codex tespiti ve codex exec yürütücüsü"
```

---

### Görev 3: observer_watermarks tablosu + depo API'si

**Files:**
- Modify: `core/src/store/schema.sql`
- Create: `core/src/store/watermarks.ts`
- Test: `core/test/store-api.test.ts` (aynı dosyaya eklenir)

**Interfaces:**
- Consumes: `Store` (`store.run/get`), `nowIso` (`store/db.ts`).
- Produces: `Watermark { projectId: number; sessionId: string; lastUuid: string }`, `getWatermark(store, projectId, sessionId): Watermark | null`, `setWatermark(store, wm: Watermark): void`.

- [ ] **Adım 1: Kırmızı test**

`core/test/store-api.test.ts`'e ek:

```ts
import { getWatermark, setWatermark } from "../src/store/watermarks.ts";

test("filigran oturum başına yazılır, okunur, üstüne yazılır", () => {
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });
  assert.equal(getWatermark(store, pid, "s1"), null);

  setWatermark(store, { projectId: pid, sessionId: "s1", lastUuid: "uuid-5" });
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "uuid-5");

  setWatermark(store, { projectId: pid, sessionId: "s1", lastUuid: "uuid-9" });
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "uuid-9");

  // Oturumlar birbirine karışmaz.
  assert.equal(getWatermark(store, pid, "s2"), null);
  store.close();
});

test("eski şemalı depo açılınca filigran tablosu kendiliğinden gelir", () => {
  // schema.sql her açılışta CREATE TABLE IF NOT EXISTS ile koşuyor (M1 kalıbı);
  // yeni tablo için ayrı migrasyon gerekmediğini bu test sabitler.
  const path = tmpStorePath();
  const once = openStore(path);
  once.close();
  const again = openStore(path);
  const pid = upsertProject(again, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });
  setWatermark(again, { projectId: pid, sessionId: "s", lastUuid: "u1" });
  assert.equal(getWatermark(again, pid, "s")!.lastUuid, "u1");
  again.close();
});
```

- [ ] **Adım 2: Kırmızıyı doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/store-api.test.ts`
Expected: FAIL — `watermarks.ts` yok.

- [ ] **Adım 3: Implementasyon**

`core/src/store/schema.sql`'e ek (cursors tablosunun altına):

```sql
-- Gözlemci filigranı: oturum başına son işlenen turn uuid'i (D-M2-2).
-- İmleçten AYRI, çünkü işleri farklı: imleç "nereden okunacak"ı, filigran
-- "nereye kadar gözlemlendi"yi tutar. Teslim en-az-bir-kez olduğu için ikisi
-- ayrışabilir; filigran bulgularla aynı tx'te ilerleyerek mükerrer üretimi keser.
-- Turn içeriği burada YOK — transcript zaten diskte, depoda turn tablosu olmaz.
CREATE TABLE IF NOT EXISTS observer_watermarks (
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  session_id  TEXT NOT NULL,
  last_uuid   TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
```

`core/src/store/watermarks.ts`:

```ts
import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";

export interface Watermark {
  projectId: number;
  sessionId: string;
  lastUuid: string;
}

export function getWatermark(store: Store, projectId: number, sessionId: string): Watermark | null {
  const row = store.get<{ last_uuid: string }>(
    "SELECT last_uuid FROM observer_watermarks WHERE project_id = ? AND session_id = ?",
    projectId,
    sessionId,
  );
  return row ? { projectId, sessionId, lastUuid: row.last_uuid } : null;
}

export function setWatermark(store: Store, wm: Watermark): void {
  store.run(
    `INSERT INTO observer_watermarks (project_id, session_id, last_uuid, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT (project_id, session_id) DO UPDATE SET
       last_uuid = excluded.last_uuid,
       updated_at = excluded.updated_at`,
    wm.projectId,
    wm.sessionId,
    wm.lastUuid,
    nowIso(),
  );
}
```

- [ ] **Adım 4: Yeşili doğrula + commit**

Run: `cd core && npm run typecheck && npm test`
Expected: hepsi yeşil.

```bash
git add core/src/store/schema.sql core/src/store/watermarks.ts core/test/store-api.test.ts
git commit -m "M2: gözlemci filigran tablosu"
```

---

### Görev 4: Partileyici (saf)

**Files:**
- Create: `core/src/observer/batch.ts`
- Test: `core/test/batch.test.ts`

**Interfaces:**
- Consumes: `Turn` (`types.ts`).
- Produces: `estimateTokens(text: string): number`, `dropThroughWatermark(turns: Turn[], lastUuid: string | null): Turn[]`, `cutBatches(turns: Turn[], maxTokens: number): Batch[]`, `Batch { turns: Turn[]; lastUuid: string | null; estTokens: number }`.

- [ ] **Adım 1: Kırmızı test**

`core/test/batch.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, dropThroughWatermark, cutBatches } from "../src/observer/batch.ts";
import type { Turn } from "../src/types.ts";

const t = (text: string, uuid?: string): Turn => ({ role: "user", text, uuid });

test("token tahmini bayt/4'tür ve asla sıfır olmaz", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(""), 0);
  // Çok baytlı karakterler bayt üzerinden sayılır (Türkçe metin gerçeği).
  assert.equal(estimateTokens("şşşş"), 2); // 8 bayt / 4
});

test("filigran süzmesi: uuid bulunursa sonrası kalır, bulunmazsa hepsi kalır", () => {
  const turns = [t("a", "u1"), t("b", "u2"), t("c", "u3")];
  assert.deepEqual(dropThroughWatermark(turns, "u2").map((x) => x.text), ["c"]);
  assert.deepEqual(dropThroughWatermark(turns, null).map((x) => x.text), ["a", "b", "c"]);
  // Normal akış: imleç filigranla hizalı, gelen turn'ler tamamen yeni → uuid yok → hepsi işlenir.
  assert.deepEqual(dropThroughWatermark(turns, "u99").map((x) => x.text), ["a", "b", "c"]);
  // Filigran son turn'se her şey işlenmiş demektir.
  assert.deepEqual(dropThroughWatermark(turns, "u3"), []);
});

test("partiler eşikte kesilir, son parti eşik altı kalabilir (D-M2-1)", () => {
  // Her turn ~100 token: 400 baytlık metin.
  const turns = Array.from({ length: 5 }, (_, i) => t("x".repeat(400), `u${i}`));
  const batches = cutBatches(turns, 250);
  // 100+100+100 ≥ 250 → ilk parti 3 turn; kalan 2 turn ikinci parti.
  assert.equal(batches.length, 2);
  assert.equal(batches[0].turns.length, 3);
  assert.equal(batches[0].lastUuid, "u2");
  assert.equal(batches[1].turns.length, 2);
  assert.equal(batches[1].lastUuid, "u4");
});

test("tek başına eşik üstü turn kendi partisi olur ve metni kısaltılır", () => {
  const huge = t("y".repeat(4000), "dev");
  const batches = cutBatches([t("a", "u0"), huge, t("b", "u1")], 250);
  assert.equal(batches.length, 3, "dev turn kendi partisine ayrılmalı");
  const devParti = batches[1];
  assert.equal(devParti.lastUuid, "dev");
  assert.ok(estimateTokens(devParti.turns[0].text) <= 250, "kısaltılmamış");
  assert.match(devParti.turns[0].text, /\[kısaltıldı: 4000 bayt\]/);
});

test("uuid'siz turn'lerde lastUuid partideki son uuid'li turn'dür", () => {
  const batches = cutBatches([t("a", "u1"), t("b"), t("c")], 9999);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].lastUuid, "u1");
});

test("boş girdi boş parti listesi verir", () => {
  assert.deepEqual(cutBatches([], 250), []);
});
```

- [ ] **Adım 2: Kırmızıyı doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/batch.test.ts`
Expected: FAIL — `batch.ts` yok.

- [ ] **Adım 3: Implementasyon**

`core/src/observer/batch.ts`:

```ts
// Saf partileyici: I/O yok, depo yok. Gözlemci bağlamını sınırlı tutmanın
// mekanik yarısı (spec §2.2) — diğer yarısı prompt.ts'teki başlık listesi.

import type { Turn } from "../types.ts";

export interface Batch {
  turns: Turn[];
  /** Partideki uuid taşıyan SON turn — filigran bu değere ilerler. */
  lastUuid: string | null;
  estTokens: number;
}

/** Kaba ama deterministik: bayt/4. Amaç bütçe, hassasiyet değil. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/**
 * Filigrana kadar olan turn'leri düşürür (D-M2-2). Filigran uuid'i akışta
 * bulunamazsa hiçbir şey düşürülmez: normal durumda imleç zaten filigranla
 * hizalıdır ve gelen her turn yenidir; bulamamak tekrar-teslim DEĞİL demektir.
 */
export function dropThroughWatermark(turns: Turn[], lastUuid: string | null): Turn[] {
  if (lastUuid == null) return turns;
  const i = turns.findIndex((t) => t.uuid === lastUuid);
  return i === -1 ? turns : turns.slice(i + 1);
}

/**
 * Turn'leri sırayı bozmadan ~maxTokens'lık partilere böler. Tek başına eşiği
 * aşan turn kendi partisi olur ve metni kısaltılır — 50k token'lık tek bir
 * yapıştırma gözlemci bağlamını patlatmamalı; kısaltma görünür iz bırakır.
 */
export function cutBatches(turns: Turn[], maxTokens: number): Batch[] {
  const batches: Batch[] = [];
  let current: Turn[] = [];
  let tokens = 0;

  const close = () => {
    if (current.length === 0) return;
    const lastUuid = [...current].reverse().find((t) => t.uuid != null)?.uuid ?? null;
    batches.push({ turns: current, lastUuid, estTokens: tokens });
    current = [];
    tokens = 0;
  };

  for (const turn of turns) {
    let t = turn;
    let cost = estimateTokens(t.text);
    if (cost > maxTokens) {
      const originalBytes = Buffer.byteLength(t.text, "utf8");
      // Bayt sınırında kes; çok baytlı karakter ortadan bölünürse toFixed
      // etmeye değmez — Buffer.toString geçersiz kuyruğu atar.
      const clipped = Buffer.from(t.text, "utf8").subarray(0, maxTokens * 4 - 64).toString("utf8");
      t = { ...t, text: `${clipped}\n[kısaltıldı: ${originalBytes} bayt]` };
      cost = estimateTokens(t.text);
      close();               // dev turn kendi partisine
      current = [t];
      tokens = cost;
      close();
      continue;
    }
    current.push(t);
    tokens += cost;
    if (tokens >= maxTokens) close();
  }
  close(); // eşik altı kuyruk da gönderilir (D-M2-1)
  return batches;
}
```

- [ ] **Adım 4: Yeşili doğrula + commit**

Run: `cd core && npm run typecheck && npm test`
Expected: hepsi yeşil.

```bash
git add core/src/observer/batch.ts core/test/batch.test.ts
git commit -m "M2: saf partileyici ve filigran süzmesi"
```

---

### Görev 5: Gözlemci prompt'u + çıktı doğrulama

**Files:**
- Create: `core/src/observer/prompt.ts`
- Test: `core/test/prompt.test.ts`

**Interfaces:**
- Consumes: `Turn`, `Anchor`, `Finding` (`types.ts`).
- Produces: `titleOf(content: string): string`, `buildStateTitles(findings: Finding[], budgetChars?): { titles: StateTitle[]; omitted: number }`, `StateTitle { id: number; title: string }`, `buildObserverPrompt(args: { projectPath: string; titles: StateTitle[]; omitted: number; turns: Turn[] }): string`, `OBSERVER_OUTPUT_SCHEMA: object`, `ObserverItem { content: string; anchors: Anchor[]; supersedes?: number }`, `parseObserverOutput(raw: string): { ok: true; items: ObserverItem[] } | { ok: false; error: string }`.

- [ ] **Adım 1: Kırmızı test**

`core/test/prompt.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  titleOf, buildStateTitles, buildObserverPrompt, parseObserverOutput,
} from "../src/observer/prompt.ts";
import type { Finding } from "../src/types.ts";

const finding = (id: number, content: string): Finding => ({
  id, projectId: 1, source: "observed", content, sourceRef: null,
  createdAt: "2026-08-11T00:00:00.000Z", status: "active", supersededBy: null, suspicion: 0,
});

test("başlık ilk satırdır ve 80 karakterde kesilir", () => {
  assert.equal(titleOf("Kısa karar.\nAyrıntı..."), "Kısa karar.");
  assert.equal(titleOf("x".repeat(100)).length, 81); // 80 + '…'
});

test("durum listesi bütçeyi aşınca en yeniler kalır, atlanan sayılır", () => {
  const findings = Array.from({ length: 50 }, (_, i) => finding(i + 1, `bulgu ${i + 1}: ${"a".repeat(60)}`));
  const { titles, omitted } = buildStateTitles(findings, 500);
  assert.ok(titles.length < 50 && titles.length > 0);
  assert.equal(titles.length + omitted, 50);
  // En yeni (en büyük id) kesinlikle içeride:
  assert.ok(titles.some((t) => t.id === 50));
});

test("prompt mevcut başlıkları id'leriyle, turn'leri rolleriyle taşır", () => {
  const p = buildObserverPrompt({
    projectPath: "/proj",
    titles: [{ id: 7, title: "Karar: X yapılmaz" }],
    omitted: 3,
    turns: [{ role: "user", text: "şunu ölçtüm" }, { role: "assistant", text: "sonuç 42" }],
  });
  assert.match(p, /#7: Karar: X yapılmaz/);
  assert.match(p, /3 bulgu daha var/);
  assert.match(p, /\[user\] şunu ölçtüm/);
  assert.match(p, /\[assistant\] sonuç 42/);
  assert.match(p, /supersedes/);
});

test("geçerli çıktı ayrıştırılır: çit bloklu JSON da kabul", () => {
  const raw = '```json\n{"findings":[{"content":"Karar: Y","anchors":[{"kind":"file_path","value":"src/a.ts"}]}]}\n```';
  const r = parseObserverOutput(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].anchors[0].kind, "file_path");
    assert.equal(r.items[0].supersedes, undefined);
  }
});

test("boş bulgu listesi geçerlidir", () => {
  const r = parseObserverOutput('{"findings":[]}');
  assert.equal(r.ok, true);
});

test("düşmanca çıktılar tek tek reddedilir, sebep söylenir", () => {
  const bad = [
    "hiç JSON değil",
    '{"findings":"dizi değil"}',
    '{"findings":[{"anchors":[]}]}',                                     // content yok
    '{"findings":[{"content":"","anchors":[]}]}',                        // boş content
    `{"findings":[{"content":"${"a".repeat(5000)}","anchors":[]}]}`,     // şişkin content
    '{"findings":[{"content":"x","anchors":[{"kind":"line_number","value":"12"}]}]}', // geçersiz çapa türü
    '{"findings":[{"content":"x","anchors":[{"kind":"symbol","value":""}]}]}',        // boş çapa değeri
    '{"findings":[{"content":"x","anchors":[],"supersedes":-3}]}',       // negatif id
    '{"findings":[{"content":"x","anchors":[],"supersedes":1.5}]}',      // tam sayı değil
    '[]',                                                                // üst düzey dizi
  ];
  for (const raw of bad) {
    const r = parseObserverOutput(raw);
    assert.equal(r.ok, false, `reddedilmedi: ${raw.slice(0, 60)}`);
    if (!r.ok) assert.ok(r.error.length > 0);
  }
});

test("bilinmeyen madde anahtarları yutulur, bilinenler kalır (model gürültüsü toleransı)", () => {
  const r = parseObserverOutput('{"findings":[{"content":"x","anchors":[],"confidence":0.9}]}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(Object.keys(r.items[0]).sort(), ["anchors", "content"]);
});
```

- [ ] **Adım 2: Kırmızıyı doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/prompt.test.ts`
Expected: FAIL — `prompt.ts` yok.

- [ ] **Adım 3: Implementasyon**

`core/src/observer/prompt.ts`:

```ts
// Gözlemci prompt'u ve çıktı sözleşmesi. Prompt Türkçe (D-M2-7): prototipin
// oturumları Türkçe; ürünleşince bu dosya tek başına İngilizce'ye çevrilir.
//
// Durum = başlık listesi, özet DEĞİL (spec §3.3): gözlemci mevcut bulguları
// bilir ama yeniden yazamaz — özet-üstüne-özet kaybı böyle kesilir.

import type { Anchor, AnchorKind, Finding, Turn } from "../types.ts";

export interface StateTitle {
  id: number;
  title: string;
}

export interface ObserverItem {
  content: string;
  anchors: Anchor[];
  supersedes?: number;
}

const TITLE_MAX = 80;
const CONTENT_MAX = 4000;
const ANCHOR_VALUE_MAX = 512;
const ANCHORS_MAX = 16;
const STATE_BUDGET_CHARS = 10_000; // ~2.5k token (spec §3.3: durum ~2-3k)

const ANCHOR_KINDS: readonly AnchorKind[] = ["file_path", "symbol", "commit_sha", "external_path"];

export function titleOf(content: string): string {
  const first = content.split("\n", 1)[0].trim();
  return first.length > TITLE_MAX ? first.slice(0, TITLE_MAX) + "…" : first;
}

/**
 * Aktif bulguların başlık listesi, karakter bütçesiyle. Bütçe aşılırsa EN YENİ
 * bulgular kalır (gözlemcinin mükerrer üretme riski en çok yakın geçmişte) ve
 * atlanan sayısı prompt'ta açıkça söylenir — sessiz eksik liste, gözlemciye
 * "bu bulgu yok" dedirtir.
 */
export function buildStateTitles(
  findings: Finding[],
  budgetChars = STATE_BUDGET_CHARS,
): { titles: StateTitle[]; omitted: number } {
  const newestFirst = [...findings].sort((a, b) => b.id - a.id);
  const titles: StateTitle[] = [];
  let used = 0;
  for (const f of newestFirst) {
    const title = titleOf(f.content);
    const cost = title.length + 8; // "#id: " + satır sonu payı
    if (used + cost > budgetChars) break;
    titles.push({ id: f.id, title });
    used += cost;
  }
  titles.reverse(); // prompt'ta eski→yeni okunur
  return { titles, omitted: findings.length - titles.length };
}

export const OBSERVER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          anchors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...ANCHOR_KINDS] },
                value: { type: "string" },
              },
              required: ["kind", "value"],
              additionalProperties: false,
            },
          },
          supersedes: { type: "number" },
        },
        required: ["content", "anchors"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

export function buildObserverPrompt(args: {
  projectPath: string;
  titles: StateTitle[];
  omitted: number;
  turns: Turn[];
}): string {
  const state =
    args.titles.length === 0
      ? "(henüz bulgu yok)"
      : args.titles.map((t) => `#${t.id}: ${t.title}`).join("\n") +
        (args.omitted > 0 ? `\n(… ve listede gösterilmeyen ${args.omitted} bulgu daha var)` : "");

  const transcript = args.turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");

  return `Sen bir hafıza gözlemcisisin. Aşağıda bir AI kodlama oturumunun parçası var.
Görevin: bu parçadan KALICI bulguları çıkarmak.

KALICI olan (al):
- verilmiş kararlar + gerekçeleri
- ölçüm sonuçları (sayılar, süreler, oranlar, "X denendi Y çıktı")
- "denendi, olmadı" kayıtları
- kısıtlar, sözleşmeler, kalıcı tercihler

ALMA:
- anlık akış durumu (şu an ne yapılıyor, sıradaki adım, todo)
- kod içeriği (kod repoda yaşıyor)
- git geçmişinden türetilebilen her şey (commit listesi, dosya listesi)
- araç çıktısı özetleri

MEVCUT BULGULAR (proje: ${args.projectPath}):
${state}

Kurallar:
- Mevcut bir bulguyla aynı olguyu TEKRAR yazma.
- Bu parça mevcut bir bulguyu geçersiz kılıyorsa yeni bulgunun "supersedes"
  alanına o bulgunun id numarasını yaz.
- Her bulguya mümkünse çapa ekle: dosya yolu (file_path), sembol adı (symbol),
  commit SHA (commit_sha) ya da repo dışı yol (external_path). Çapasız bulgu
  denetlenemez sınıfına düşer; çapa uyduramıyorsan boş bırak, uydurma.
- Bulgu içeriği: oturumun dilinde, 1-4 cümle, tek başına anlaşılır.
- Yeni bulgu yoksa boş liste döndür.

Yalnız şu biçimde JSON döndür:
{"findings":[{"content":"...","anchors":[{"kind":"file_path","value":"..."}],"supersedes":12}]}

OTURUM PARÇASI:
${transcript}`;
}

/**
 * Çıktıyı elle doğrular. --output-schema modele gider ama ona GÜVENİLMEZ:
 * sınır bizim tarafta çizilir (denetim dersi: biçime bakarak güvenli ilan
 * etmek çalışmıyor — sabit sözleşme + üst sınırlar).
 */
export function parseObserverOutput(
  raw: string,
): { ok: true; items: ObserverItem[] } | { ok: false; error: string } {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) text = fence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON ayrıştırılamadı: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, error: "üst düzey nesne değil" };
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return { ok: false, error: "findings dizi değil" };

  const items: ObserverItem[] = [];
  for (const [i, f] of findings.entries()) {
    if (typeof f !== "object" || f === null) return { ok: false, error: `madde ${i}: nesne değil` };
    const { content, anchors, supersedes } = f as Record<string, unknown>;

    if (typeof content !== "string" || content.trim().length === 0)
      return { ok: false, error: `madde ${i}: content boş ya da dize değil` };
    if (content.length > CONTENT_MAX)
      return { ok: false, error: `madde ${i}: content ${content.length} > ${CONTENT_MAX} karakter` };

    if (!Array.isArray(anchors)) return { ok: false, error: `madde ${i}: anchors dizi değil` };
    if (anchors.length > ANCHORS_MAX) return { ok: false, error: `madde ${i}: ${anchors.length} çapa > ${ANCHORS_MAX}` };
    const validAnchors: Anchor[] = [];
    for (const [j, a] of anchors.entries()) {
      if (typeof a !== "object" || a === null) return { ok: false, error: `madde ${i} çapa ${j}: nesne değil` };
      const { kind, value } = a as Record<string, unknown>;
      if (typeof kind !== "string" || !ANCHOR_KINDS.includes(kind as AnchorKind))
        return { ok: false, error: `madde ${i} çapa ${j}: geçersiz tür ${JSON.stringify(kind)}` };
      if (typeof value !== "string" || value.trim().length === 0 || value.length > ANCHOR_VALUE_MAX)
        return { ok: false, error: `madde ${i} çapa ${j}: geçersiz değer` };
      validAnchors.push({ kind: kind as AnchorKind, value });
    }

    let sup: number | undefined;
    if (supersedes !== undefined) {
      if (typeof supersedes !== "number" || !Number.isInteger(supersedes) || supersedes <= 0)
        return { ok: false, error: `madde ${i}: supersedes pozitif tam sayı değil` };
      sup = supersedes;
    }

    // Bilinmeyen madde anahtarları bilinçli yutulur: modeller süs alan ekler,
    // sözleşmeyi bilinen anahtarlar taşır.
    items.push(sup === undefined ? { content, anchors: validAnchors } : { content, anchors: validAnchors, supersedes: sup });
  }
  return { ok: true, items };
}
```

- [ ] **Adım 4: Yeşili doğrula + commit**

Run: `cd core && npm run typecheck && npm test`
Expected: hepsi yeşil.

```bash
git add core/src/observer/prompt.ts core/test/prompt.test.ts
git commit -m "M2: gözlemci prompt'u ve çıktı doğrulama"
```

---

### Görev 6: Gözlemci döngüsü

**Files:**
- Create: `core/src/observer/observer.ts`
- Modify: `core/src/store/events.ts` (EventKind'e iki tür)
- Test: `core/test/observer.test.ts`

**Interfaces:**
- Consumes: `ExecutorAdapter` (Görev 1), `cutBatches/dropThroughWatermark/Batch` (Görev 4), `buildObserverPrompt/buildStateTitles/parseObserverOutput/OBSERVER_OUTPUT_SCHEMA` (Görev 5), `getWatermark/setWatermark` (Görev 3), `appendFinding/supersede/listActive` (`store/findings.ts`), `logEvent` (`store/events.ts`), `Store`.
- Produces: `Observer` sınıfı: `new Observer({ store, executor, batchTokens? })`, `handleTurns(ctx: { projectId: number; sessionId: string; turns: Turn[] }): Promise<void>` (scanOnce `onTurns`'a doğrudan verilir), `stats: ObserverStats { batches, calls, findings, superseded, unprocessed, skippedTurns }`.

- [ ] **Adım 1: Kırmızı test**

`core/test/observer.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store/db.ts";
import { Observer } from "../src/observer/observer.ts";
import { upsertProject } from "../src/store/projects.ts";
import { appendFinding, listActive, getFinding, getAnchors } from "../src/store/findings.ts";
import { getWatermark } from "../src/store/watermarks.ts";
import { countEvents, listEvents } from "../src/store/events.ts";
import { fakeExecutor } from "./helpers.ts";
import type { Turn } from "../src/types.ts";

const t = (text: string, uuid: string): Turn => ({ role: "user", text, uuid });

function setup() {
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/proj", adapterId: "claude-code", transcriptDir: "/t" });
  return { store, pid };
}

test("başarılı parti: bulgular çapalarıyla yazılır, filigran ilerler, olay düşer", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([{
    output: JSON.stringify({ findings: [
      { content: "Karar: X kullanılmayacak çünkü Y ölçüldü.", anchors: [{ kind: "file_path", value: "src/a.ts" }] },
      { content: "Tercih: teraslı çıktı isteniyor.", anchors: [] },
    ]}),
  }]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("konuşma", "u1")] });

  const active = listActive(store, pid);
  assert.equal(active.length, 2);
  const anchored = active.find((f) => f.content.startsWith("Karar"))!;
  assert.equal(anchored.status, "active");
  assert.equal(anchored.source, "observed");
  assert.equal(anchored.sourceRef, "s1#u1");
  assert.deepEqual(getAnchors(store, anchored.id), [{ kind: "file_path", value: "src/a.ts", takenAtCommit: null }]);
  // Çapasız bulgu unanchored sınıfına düşer (M1 kuralı, otomatik).
  assert.equal(active.find((f) => f.content.startsWith("Tercih"))!.status, "unanchored");
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "u1");
  assert.equal(countEvents(store, "observer_batch_ok"), 1);
  assert.equal(obs.stats.findings, 2);
  store.close();
});

test("gözlemci mevcut bulgu başlıklarını görür ve supersedes uygulanır", async () => {
  const { store, pid } = setup();
  const oldId = appendFinding(store, {
    projectId: pid, source: "observed", content: "Eski karar: Z geçerli.",
    anchors: [{ kind: "symbol", value: "z" }],
  });
  const exec = fakeExecutor([{
    output: JSON.stringify({ findings: [
      { content: "Z kararı geri alındı, ölçüm tersini gösterdi.", anchors: [{ kind: "symbol", value: "z" }], supersedes: oldId },
    ]}),
  }]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("Z'yi geri aldık", "u1")] });

  assert.match(exec.calls[0].prompt, new RegExp(`#${oldId}: Eski karar`));
  const old = getFinding(store, oldId)!;
  assert.equal(old.status, "superseded");
  assert.ok(old.supersededBy != null);
  assert.equal(getFinding(store, old.supersededBy!)!.content, "Z kararı geri alındı, ölçüm tersini gösterdi.");
  assert.equal(obs.stats.superseded, 1);
  store.close();
});

test("başka projenin bulgusu supersede EDİLEMEZ; içerik yine de yazılır", async () => {
  const { store, pid } = setup();
  const otherPid = upsertProject(store, { path: "/baska", adapterId: "claude-code", transcriptDir: "/t2" });
  const foreignId = appendFinding(store, { projectId: otherPid, source: "observed", content: "başkasının bulgusu" });
  const exec = fakeExecutor([{
    output: JSON.stringify({ findings: [{ content: "sahtekar", anchors: [], supersedes: foreignId }] }),
  }]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("x", "u1")] });

  assert.equal(getFinding(store, foreignId)!.status, "active", "yabancı bulgu supersede edildi!");
  assert.equal(listActive(store, pid).length, 1, "içerik yazılmalıydı");
  store.close();
});

test("tekrar teslim (en-az-bir-kez) filigranla elenir, ikinci codex çağrısı olmaz", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([
    { output: JSON.stringify({ findings: [{ content: "bir", anchors: [] }] }) },
  ]);
  const obs = new Observer({ store, executor: exec });
  const turns = [t("a", "u1"), t("b", "u2")];
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns });
  // İmleç yazılamadan çöküldü senaryosu: aynı turn'ler yeniden gelir.
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns });

  assert.equal(exec.calls.length, 1, "tekrar teslim yeniden Codex'e gitti");
  assert.equal(listActive(store, pid).length, 1);
  assert.equal(obs.stats.skippedTurns, 2);
  store.close();
});

test("geçersiz JSON bir kez düzeltilerek yeniden istenir; düzelirse işlenir", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([
    { output: "bozuk çıktı %%" },
    { output: JSON.stringify({ findings: [{ content: "düzeldi", anchors: [] }] }) },
  ]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("x", "u1")] });

  assert.equal(exec.calls.length, 2);
  assert.match(exec.calls[1].prompt, /GEÇERSİZDİ/);
  assert.equal(listActive(store, pid).length, 1);
  store.close();
});

test("iki kez geçersiz JSON → parti işlenemedi, filigran yine de ilerler (D-M2-3)", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([{ output: "bozuk 1" }, { output: "bozuk 2" }]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("x", "u1")] });

  assert.equal(listActive(store, pid).length, 0);
  assert.equal(countEvents(store, "observer_batch_unprocessed"), 1);
  const ev = JSON.parse(listEvents(store, { kind: "observer_batch_unprocessed" })[0].detail!);
  assert.equal(ev.sessionId, "s1");
  assert.equal(ev.lastUuid, "u1");
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "u1", "zehirli parti sonsuz döngüye girer");
  assert.equal(obs.stats.unprocessed, 1);
  store.close();
});

test("yürütücü hatası bir kez tekrarlanır; ikisi de düşerse parti işlenemedi", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([
    { ok: false, error: "ağ koptu" },
    { ok: false, error: "ağ yine koptu" },
  ]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("x", "u1")] });

  assert.equal(exec.calls.length, 2);
  assert.equal(countEvents(store, "observer_batch_unprocessed"), 1);
  store.close();
});

test("uzun akış birden çok partiye bölünür, her parti kendi çağrısını yapar", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([]); // hepsi varsayılan boş cevap
  const obs = new Observer({ store, executor: exec, batchTokens: 50 });
  // Her turn ~25 token (100 bayt): 6 turn → 150 token → 3 parti.
  const turns = Array.from({ length: 6 }, (_, i) => t("y".repeat(100), `u${i}`));
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns });

  assert.equal(exec.calls.length, 3);
  assert.equal(obs.stats.batches, 3);
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "u5");
  store.close();
});
```

- [ ] **Adım 2: Kırmızıyı doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/observer.test.ts`
Expected: FAIL — `observer.ts` yok.

- [ ] **Adım 3: EventKind güncellemesi**

`core/src/store/events.ts` — union'a iki satır:

```ts
  | "observer_batch_ok"
  | "observer_batch_unprocessed"
```

- [ ] **Adım 4: Implementasyon**

`core/src/observer/observer.ts`:

```ts
// Gözlemci döngüsü: scanOnce'ın onTurns kancasına takılır (M1'deki bilinçli
// ayrım — tarama okur, gözlemci yorumlar).
//
// Teslim en-az-bir-kez (scan.ts sözleşmesi). Mükerrer üretim filigranla kesilir
// (D-M2-2): bulgu yazımı + filigran aynı tx'te, etki tam-bir-kez. Zehirli parti
// görünür kayıpla atlanır (D-M2-3): sonsuz maliyet döngüsü yok, transcript diskte.

import type { Store } from "../store/db.ts";
import type { ExecutorAdapter } from "../adapters/executor.ts";
import type { Turn } from "../types.ts";
import { cutBatches, dropThroughWatermark, type Batch } from "./batch.ts";
import {
  OBSERVER_OUTPUT_SCHEMA, buildObserverPrompt, buildStateTitles, parseObserverOutput, type ObserverItem,
} from "./prompt.ts";
import { appendFinding, listActive, supersede } from "../store/findings.ts";
import { getWatermark, setWatermark } from "../store/watermarks.ts";
import { logEvent } from "../store/events.ts";

export interface ObserverOptions {
  store: Store;
  executor: ExecutorAdapter;
  /** Parti eşiği. Varsayılan 8000 (spec §3.3); en büyük gerçek oturum ~2M token → ~250 çağrı. */
  batchTokens?: number;
}

export interface ObserverStats {
  batches: number;
  calls: number;
  findings: number;
  superseded: number;
  unprocessed: number;
  /** Filigranla elenen tekrar-teslim turn'leri. */
  skippedTurns: number;
}

const DEFAULT_BATCH_TOKENS = 8000;

export class Observer {
  readonly stats: ObserverStats = { batches: 0, calls: 0, findings: 0, superseded: 0, unprocessed: 0, skippedTurns: 0 };
  private readonly store: Store;
  private readonly executor: ExecutorAdapter;
  private readonly batchTokens: number;

  constructor(opts: ObserverOptions) {
    this.store = opts.store;
    this.executor = opts.executor;
    this.batchTokens = opts.batchTokens ?? DEFAULT_BATCH_TOKENS;
  }

  /** scanOnce onTurns'a doğrudan verilir: (ctx) => observer.handleTurns(ctx). */
  async handleTurns(ctx: { projectId: number; sessionId: string; turns: Turn[] }): Promise<void> {
    const wm = getWatermark(this.store, ctx.projectId, ctx.sessionId);
    const fresh = dropThroughWatermark(ctx.turns, wm?.lastUuid ?? null);
    this.stats.skippedTurns += ctx.turns.length - fresh.length;
    if (fresh.length === 0) return;

    for (const batch of cutBatches(fresh, this.batchTokens)) {
      await this.processBatch(ctx.projectId, ctx.sessionId, batch);
    }
  }

  private async processBatch(projectId: number, sessionId: string, batch: Batch): Promise<void> {
    this.stats.batches++;
    const projectPath =
      this.store.get<{ path: string }>("SELECT path FROM projects WHERE id = ?", projectId)?.path ?? "(bilinmiyor)";

    // Durum her partide TAZE okunur: önceki partinin bulguları sonrakinin
    // başlık listesinde görünmeli, yoksa aynı taramada mükerrer üretilir.
    const active = listActive(this.store, projectId);
    const { titles, omitted } = buildStateTitles(active);
    const prompt = buildObserverPrompt({ projectPath, titles, omitted, turns: batch.turns });

    const outcome = await this.callWithRecovery(prompt);
    if (!outcome.ok) {
      // Görünür kayıp: olay uuid aralığını taşır, transcript diskte —
      // ileride elle ya da toplu yeniden işleme mümkün.
      this.stats.unprocessed++;
      this.store.tx(() => {
        logEvent(this.store, {
          projectId,
          kind: "observer_batch_unprocessed",
          detail: {
            sessionId, lastUuid: batch.lastUuid, turnCount: batch.turns.length,
            estTokens: batch.estTokens, error: outcome.error,
          },
        });
        if (batch.lastUuid != null)
          setWatermark(this.store, { projectId, sessionId, lastUuid: batch.lastUuid });
      });
      return;
    }

    const knownIds = new Set(active.map((f) => f.id));
    let written = 0;
    let supersededCount = 0;
    let droppedSupersedes = 0;

    this.store.tx(() => {
      for (const item of outcome.items) {
        const newId = appendFinding(this.store, {
          projectId,
          source: "observed",
          content: item.content,
          sourceRef: `${sessionId}#${batch.lastUuid ?? "?"}`,
          anchors: item.anchors,
        });
        written++;
        if (item.supersedes !== undefined) {
          // Yalnız gözlemciye GÖSTERİLEN id'ler supersede edilebilir: model
          // rastgele/yabancı id söyleyerek başka projenin kaydını kapatamaz.
          if (knownIds.has(item.supersedes)) {
            supersede(this.store, item.supersedes, newId);
            supersededCount++;
          } else {
            droppedSupersedes++;
          }
        }
      }
      if (batch.lastUuid != null)
        setWatermark(this.store, { projectId, sessionId, lastUuid: batch.lastUuid });
      logEvent(this.store, {
        projectId,
        kind: "observer_batch_ok",
        detail: {
          sessionId, lastUuid: batch.lastUuid, turnCount: batch.turns.length,
          estTokens: batch.estTokens, newFindings: written,
          superseded: supersededCount, droppedSupersedes,
        },
      });
    });

    this.stats.findings += written;
    this.stats.superseded += supersededCount;
  }

  /**
   * Kurtarmalı çağrı (spec §3.7): yürütücü hatasında bir tekrar; geçerli çıkış
   * ama bozuk JSON'da bir düzeltmeli yeniden isteme. Sonra pes — parti işlenemedi.
   */
  private async callWithRecovery(
    prompt: string,
  ): Promise<{ ok: true; items: ObserverItem[] } | { ok: false; error: string }> {
    let res = await this.runOnce(prompt);
    if (!res.ok) res = await this.runOnce(prompt); // geçici hata tekrarı (ağ, kota)
    if (!res.ok) return { ok: false, error: `yürütücü: ${res.error}` };

    let parsed = parseObserverOutput(res.output);
    if (parsed.ok) return parsed;

    const corrective =
      `${prompt}\n\nÖNCEKİ ÇIKTIN GEÇERSİZDİ: ${parsed.error}.\n` +
      `Yalnız istenen şemaya uyan JSON döndür, başka hiçbir şey yazma.`;
    const retry = await this.runOnce(corrective);
    if (!retry.ok) return { ok: false, error: `yürütücü (düzeltme turu): ${retry.error}` };
    parsed = parseObserverOutput(retry.output);
    if (parsed.ok) return parsed;
    return { ok: false, error: `geçersiz JSON (iki deneme): ${parsed.error}` };
  }

  private async runOnce(prompt: string) {
    this.stats.calls++;
    return this.executor.run({ prompt, outputSchema: OBSERVER_OUTPUT_SCHEMA });
  }
}
```

- [ ] **Adım 5: Yeşili doğrula + commit**

Run: `cd core && npm run typecheck && npm test`
Expected: hepsi yeşil.

```bash
git add core/src/observer/observer.ts core/src/store/events.ts core/test/observer.test.ts
git commit -m "M2: gözlemci döngüsü — parti, filigran, kurtarma, append-only yazım"
```

---

### Görev 7: CLI `observe` komutu + koruma kapıları

**Files:**
- Modify: `core/src/cli.ts`
- Modify: `core/src/adapters/claude-code.ts` (`readCwd` export edilir)
- Test: `core/test/scan.test.ts` (aynı dosyaya `observe` yardımcılarının testleri eklenir)

**Interfaces:**
- Consumes: `Observer` (Görev 6), `createCodexExecutor` (Görev 2), `scanOnce`, `readIncremental`, `readCwd`, `acquireScanLock/releaseScanLock`, `upsertProject`, `estimateTokens`.
- Produces: CLI komutu `context-police observe`; `cli.ts` içinde export edilmeyen yardımcılar test edilebilirlik için `core/src/observe-cmd.ts`'e konur: `observeGuard(store: Store, allowBackfill: boolean): { ok: boolean; reason?: string }`, `estimateSessionCalls(filteredBytes: number, batchTokens: number): number`.

Komut yüzeyi:

```
context-police observe [--project <yol>] [--dir <kök>] [--store <db>]
                       [--batch-tokens N] [--model M] [--effort E] [--yes]
context-police observe --session <jsonl-yolu> [aynı seçenekler]
```

Davranış sözleşmesi:
1. Önce Codex tespiti (K2). Bulunamazsa: sürüm/kurulum yönlendirmesi yaz, çıkış kodu 2.
2. `--session` YOKSA: sel koruması — depoda hiç imleç yoksa reddet (D-M2-4);
   `--yes` bilinçli geçersiz kılar. Sonra `scanOnce(…, onTurns: observer.handleTurns)`.
3. `--session` VARSA: dosya filigrandan (yoksa 0'dan) `readIncremental` ile okunur,
   `readCwd` ile proje çözülür, tarama kilidi alınır, **imleçlere dokunulmaz**
   (imleç taramanın, filigran gözlemcinin). Tahmini çağrı > 20 ise `--yes` şart;
   tahmin ekrana yazılır.
4. Sonda `observer.stats` raporu; `status` komutuna gözlemci sayaçları eklenir.

- [ ] **Adım 1: Kırmızı test**

`core/test/scan.test.ts`'e ek:

```ts
import { observeGuard, estimateSessionCalls } from "../src/observe-cmd.ts";

test("sel koruması: imleçsiz depo observe'u reddeder, --yes geçer (D-M2-4)", () => {
  const store = openStore(":memory:");
  const g1 = observeGuard(store, false);
  assert.equal(g1.ok, false);
  assert.match(g1.reason!, /scan/);
  assert.equal(observeGuard(store, true).ok, true);

  // Bir imleç varsa taban çizgisi var demektir: serbest.
  const pid = upsertProject(store, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });
  store.run(
    "INSERT INTO cursors (file_path, project_id, session_id, byte_offset) VALUES (?,?,?,?)",
    "/t/s.jsonl", pid, "s", 10,
  );
  assert.equal(observeGuard(store, false).ok, true);
  store.close();
});

test("çağrı tahmini: süzülmüş bayt → parti sayısı", () => {
  // 8000 token'lık parti ≈ 32000 bayt.
  assert.equal(estimateSessionCalls(0, 8000), 0);
  assert.equal(estimateSessionCalls(31_999, 8000), 1);
  assert.equal(estimateSessionCalls(64_001, 8000), 3);
});
```

- [ ] **Adım 2: Kırmızıyı doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/scan.test.ts`
Expected: FAIL — `observe-cmd.ts` yok.

- [ ] **Adım 3: Implementasyon**

`core/src/adapters/claude-code.ts` — `readCwd`'nin önündeki `async function` `export async function` yapılır (davranış değişmez; `--session` modu tek dosyadan proje çözmek için kullanır).

Yeni dosya `core/src/observe-cmd.ts`:

```ts
// observe komutunun karar mantığı — cli.ts'ten ayrı, çünkü koruma kapıları
// (sel, maliyet) testle sabitlenmek zorunda; süreç çıkışı test edilemez.

import type { Store } from "./store/db.ts";
import { estimateTokens } from "./observer/batch.ts";

/**
 * Sel koruması (D-M2-4): hiç taranmamış depoda observe TÜM geçmişi Codex'e
 * akıtır (ölçüldü: ~500 çağrı). Bilinçli olmayan ilk koşum reddedilir.
 */
export function observeGuard(store: Store, allowBackfill: boolean): { ok: boolean; reason?: string } {
  if (allowBackfill) return { ok: true };
  const n = store.get<{ n: number }>("SELECT COUNT(*) n FROM cursors")?.n ?? 0;
  if (n === 0)
    return {
      ok: false,
      reason:
        "depoda hiç imleç yok: ilk koşum TÜM transcript geçmişini gözlemciye akıtır.\n" +
        "önce taban çizgisi için `context-police scan` koşun (gözlemcisiz, imleçleri ilerletir),\n" +
        "ya da bunun bilinçli bir geçmiş taraması olduğunu --yes ile söyleyin.",
    };
  return { ok: true };
}

/** Süzülmüş bayt sayısından tahmini Codex çağrısı: parti = batchTokens*4 bayt. */
export function estimateSessionCalls(filteredBytes: number, batchTokens: number): number {
  return Math.ceil(filteredBytes / (batchTokens * 4));
}
```

`core/src/cli.ts`'e `observe` komutu (mevcut `cmdScan`/`cmdStatus` yanına; `arg()` ve `safe()` aynen kullanılır):

```ts
import { Observer } from "./observer/observer.ts";
import { createCodexExecutor } from "./adapters/codex.ts";
import { observeGuard, estimateSessionCalls } from "./observe-cmd.ts";
import { readIncremental, readCwd } from "./adapters/claude-code.ts";
import { upsertProject } from "./store/projects.ts";
import { getWatermark } from "./store/watermarks.ts";
import { acquireScanLock, releaseScanLock } from "./store/lock.ts";
import { dropThroughWatermark } from "./observer/batch.ts";
import { basename, dirname } from "node:path";
// openStore/defaultStorePath importuna `type Store` da eklenir (observeSingleSession imzası için).

async function cmdObserve(): Promise<void> {
  const effortArg = arg("effort");
  const executor = createCodexExecutor({
    model: arg("model"),
    reasoningEffort: (effortArg as "minimal" | "low" | "medium" | "high" | undefined) ?? "low",
  });

  // K2: Codex sert bağımlılık. Yoksa yönlendir, çalışmayı deneme.
  const det = await executor.detect();
  if (!det.found) {
    console.error(`codex bulunamadı: ${det.error ?? "PATH'te yok"}`);
    console.error("kurulum: npm install -g @openai/codex  (ya da https://developers.openai.com/codex)");
    process.exit(2);
  }
  console.log(`codex ${det.version} bulundu`);

  const batchTokens = Number(arg("batch-tokens") ?? 8000);
  const yes = process.argv.includes("--yes");
  const store = openStore(arg("store") ?? defaultStorePath());
  try {
    const observer = new Observer({ store, executor, batchTokens });
    const sessionPath = arg("session");

    if (sessionPath) {
      await observeSingleSession(store, observer, sessionPath, batchTokens, yes);
    } else {
      const guard = observeGuard(store, yes);
      if (!guard.ok) {
        console.error(guard.reason);
        process.exit(3);
      }
      await scanOnce(store, {
        adapter: claudeCodeAdapter,
        root: arg("dir"),
        only: arg("project") ? [arg("project")!] : undefined,
        onTurns: (ctx) => observer.handleTurns(ctx),
      });
    }

    const s = observer.stats;
    console.log(`parti: ${s.batches}  codex çağrısı: ${s.calls}`);
    console.log(`yeni bulgu: ${s.findings}  supersede: ${s.superseded}`);
    if (s.skippedTurns > 0) console.log(`filigranla elenen tekrar turn: ${s.skippedTurns}`);
    if (s.unprocessed > 0) console.log(`⚠ işlenemeyen parti: ${s.unprocessed}  (ayrıntı: status)`);
  } finally {
    store.close();
  }
}

async function observeSingleSession(
  store: Store,
  observer: Observer,
  sessionPath: string,
  batchTokens: number,
  yes: boolean,
): Promise<void> {
  const projPath = await readCwd(sessionPath);
  if (!projPath) throw new Error(`oturum dosyasından proje yolu çözülemedi: ${sessionPath}`);
  const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");

  // Kilit: aynı anda koşan bir scan/observe ile filigran yarışını engeller.
  const holder = `pid:${process.pid}`;
  acquireScanLock(store, holder);
  try {
    const projectId = upsertProject(store, {
      path: projPath,
      adapterId: claudeCodeAdapter.id,
      transcriptDir: dirname(sessionPath), // dizin, dosya değil — projects sözleşmesi
    });
    // İmleçlere DOKUNULMAZ: imleç taramanın, filigran gözlemcinin (D-M2-2).
    const res = await readIncremental(sessionPath, 0, null, null);
    const wm = getWatermark(store, projectId, sessionId);
    const fresh = dropThroughWatermark(res.turns, wm?.lastUuid ?? null);

    let filteredBytes = 0;
    for (const t of fresh) filteredBytes += Buffer.byteLength(t.text, "utf8");
    const calls = estimateSessionCalls(filteredBytes, batchTokens);
    console.log(`oturum: ${safe(sessionId)}  yeni turn: ${fresh.length}  tahmini çağrı: ~${calls}`);
    if (calls > 20 && !yes) {
      console.error(`tahmini ${calls} Codex çağrısı > 20: maliyet onayı için --yes ekleyin (D-M2-4).`);
      process.exit(3);
    }
    await observer.handleTurns({ projectId, sessionId, turns: fresh });
  } finally {
    releaseScanLock(store, holder);
  }
}
```

Komut kaydı ve yardım metni:

```ts
if (cmd === "scan") await cmdScan();
else if (cmd === "observe") await cmdObserve();
else if (cmd === "status") cmdStatus();
else {
  console.log(`context-police — AI ajan hafızası denetçisi (çekirdek)

kullanım:
  context-police scan    [--dir <transcript kökü>] [--store <db yolu>]
  context-police observe [--project <yol>] [--session <jsonl>] [--dir <kök>] [--store <db>]
                         [--batch-tokens N] [--model M] [--effort E] [--yes]
  context-police status  [--store <db yolu>]`);
  process.exit(cmd ? 1 : 0);
}
```

`cmdStatus`'a gözlemci satırı (mevcut `olaylar:` satırının altına):

```ts
    const findingCount = store.get<{ n: number }>("SELECT COUNT(*) n FROM findings")?.n ?? 0;
    console.log(`bulgu: ${findingCount}  gözlemci partisi: ${countEvents(store, "observer_batch_ok")}, ` +
      `işlenemeyen: ${countEvents(store, "observer_batch_unprocessed")}`);
```

- [ ] **Adım 4: Yeşili doğrula**

Run: `cd core && npm run typecheck && npm test`
Expected: hepsi yeşil.

- [ ] **Adım 5: Elle duman testi (Codex'siz yol)**

Run: `cd core && node --disable-warning=ExperimentalWarning src/cli.ts observe --store /tmp/cp-m2-duman.db 2>&1; echo "çıkış: $?"; rm -f /tmp/cp-m2-duman.db*`
Expected: codex bulunur (0.146.0 kurulu), imleçsiz depo sel korumasına takılır → "önce scan koşun" mesajı, çıkış 3. (Codex'i olmayan makine yolu Görev 2'nin sahte-binary testiyle zaten sabit.)

- [ ] **Adım 6: Commit**

```bash
git add core/src/cli.ts core/src/observe-cmd.ts core/src/adapters/claude-code.ts core/test/scan.test.ts
git commit -m "M2: observe komutu — Codex kapısı, sel koruması, maliyet onayı"
```

---

### Görev 8: Gerçek oturum ölçümü — çıkış kapısı

**Files:**
- Create: `docs/olcumler/2026-08-XX-m2-gozlemci-olcumu.md` (koşum günü tarihlenir)

Çıkış kapısı (roadmap M2): *gerçek bir oturumdan depoya anlamlı bulgular düşüyor; mükerrer üretim ve çapasız bulgu oranı göz kontrolünden geçiyor.* Göz kontrolü Burak'la birlikte yapılır — bu görev tek başına "bitti" ilan edilemez.

- [ ] **Adım 1: Test oturumu seç**

Bu projenin kendi transcript'i ideal zemin: içeriği biliyoruz, bulguların doğruluğu elle denetlenebilir. Aday: M1 oturumu (`~/.claude/projects/-Users-burakemreerdemci-Documents-Context-Police/dfbcaaaf-*.jsonl`). Boyuta bak, tahmini çağrıyı GÖR, sonra koş:

Run: `ls -lh ~/.claude/projects/-Users-burakemreerdemci-Documents-Context-Police/*.jsonl`

- [ ] **Adım 2: Taze ölçüm deposuyla koş**

Üretim deposuna değil izole depoya (ölçüm tekrarlanabilir kalsın):

Run: `cd core && node --disable-warning=ExperimentalWarning src/cli.ts observe --session <seçilen.jsonl> --store /tmp/cp-m2-olcum.db`
Expected: tahmini çağrı yazılır; >20 ise maliyet Burak'a sorulur (`--yes` kararı onun). Koşum sonunda parti/bulgu/işlenemedi sayıları ekranda.

- [ ] **Adım 3: Bulguları dök ve göz kontrolüne hazırla**

Run: `sqlite3 /tmp/cp-m2-olcum.db "SELECT f.id, f.status, f.content, group_concat(a.kind || ':' || a.value, ' | ') FROM findings f LEFT JOIN anchors a ON a.finding_id = f.id GROUP BY f.id ORDER BY f.id"`

Sayılacak dört oran (ölçüm raporuna girer):
1. **Anlamlılık:** bulgu / toplam parti — boş partiler normal, sıfır bulgu şüpheli.
2. **Mükerrer oranı:** aynı olguyu tekrar eden bulgu / toplam bulgu.
3. **Çapasız oranı:** `unanchored` / toplam — yüksekse prompt'un çapa bölümü zayıf demektir.
4. **Kalıcılık isabeti:** akış-durumu sızıntısı (alınmaması gereken "şu an X yapılıyor" tipi bulgu) sayısı — M3'ün DURUM-dedektörünün girdisi olacağı için kritik.

- [ ] **Adım 4: Ölçüm raporunu yaz**

`docs/olcumler/2026-08-XX-m2-gozlemci-olcumu.md` — M0 raporunun biçiminde: koşum parametreleri (model, effort, parti eşiği, çağrı sayısı, süre, hangi oturum), dört oran, örnek iyi/kötü bulgular, prompt'a geri besleme listesi. Rapor "prompt v1 böyle performans verdi"nin kalıcı kaydıdır — prompt değişince kıyas zemini bu.

- [ ] **Adım 5: Göz kontrolü (Burak) + commit**

Bulgular ve oranlar Burak'la gözden geçirilir; kapı ancak onun onayıyla kapanır. Prompt düzeltmesi gerekiyorsa Görev 5'e dönülür (rapor "neden dönüldü"yü kaydeder).

```bash
git add docs/olcumler/2026-08-*-m2-gozlemci-olcumu.md
git commit -m "M2 ölçümü: gözlemci çıkış kapısı raporu"
```

---

## Kapsam dışı (bilinçli, M2'de yok)

- **90 sn periyodik döngü / `serve`** — M5'in işi; M2 tek atımlık `observe` komutu verir.
- **`memory/*.md` import** — M3 (sinyal motoruyla birlikte anlamlı).
- **Eşik altı kuyruğu taramalar arası bekletme** — D-M2-1'in bedeli kabul edildi; M5'te periyodik döngü kurulurken yeniden değerlendirilecek.
- **İşlenemeyen partileri otomatik yeniden işleme** — olay kaydı uuid aralığını taşıyor, transcript diskte; ihtiyaç doğarsa ayrı komut olur.
- **Codex dışı ikinci yürütücü** — seam var, implementasyon YAGNI (K10).

## Görev sırası ve bağımlılıklar

1 (seam) → 2 (codex) ve 3 (filigran) ve 4 (parti) ve 5 (prompt) birbirinden bağımsız → 6 (döngü, hepsini tüketir) → 7 (CLI) → 8 (ölçüm). 2-5 arası sıra serbest; plan sırası okunabilirlik için.
