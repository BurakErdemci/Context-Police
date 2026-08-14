// Hakem çağrısının MALİYETİNİ ölçer — ve bunu yaparken hakemin ilk
// prototipini koşturur.
//
// Neden var: 13 Ağu'da kapı kaldırıldı ("skor sıralar, hepsi hakeme gider").
// O karar ölçülmemiş bir varsayıma dayanıyor: 28 notluk tam tarama
// kaldırılabilir. Bu araç o varsayımı sınar.
//
// NEDEN CODEX, Claude değil: ürünün tek yürütücüsü Codex
// (`cli.ts:264` → `createCodexExecutor`). Claude üzerinden ölçmek, ürünün
// hiçbir zaman koşmayacağı bir şeyi ölçmek olurdu.
//
// NEDEN --json: `codex exec -o` yalnız son mesajı yazıyor; token sayacı
// yalnız `--json` olay akışındaki `turn.completed.usage` alanında. Bugünkü
// adaptör `-o` kullanıyor, yani ürün şu an kendi maliyetini GÖREMİYOR
// (`ExecutorResult` token taşımıyor). Bu, kapı yeniden tasarlanırken
// kapatılması gereken bir boşluk.
//
// Kullanım:
//   node --experimental-strip-types tools/altin-set/adjudicate-cost.ts \
//     [--evidence] [--parallel N] [--timeout-sec 600] [--max-items 100] \
//     [--max-tokens 2000000] <worktree> <notlar-dizini> <cikti.jsonl> <not> [<not> ...]

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNote, extractAnchors } from "../../core/src/importer/parse.ts";
import { openGit } from "../../core/src/signals/git.ts";
import { checkAnchors } from "../../core/src/signals/anchor-drift.ts";
import { evidenceFor } from "./evidence-block.ts";

// --evidence: mekanik katmanın ZATEN ölçtüğü çapa kanıtını isteme koyar.
// 13 Ağu ölçümü maliyetin keşif turlarından geldiğini gösterdi; bu bayrak o
// keşfin ne kadarının gereksiz olduğunu ölçmek için var.
const argvAll = process.argv.slice(2);
const WITH_EVIDENCE = argvAll.includes("--evidence");
// Değer alan bayraklar tek yerde: pozisyonel ayıklayıcı bunların DEĞERİNİ de
// atlamak zorunda, yoksa `--timeout-sec 30` içindeki 30 not adı sanılıyor.
const VALUE_FLAGS = new Set(["--parallel", "--timeout-sec", "--max-items", "--max-tokens"]);
function numFlag(name: string, dflt: number): number {
  const i = argvAll.indexOf(name);
  if (i === -1) return dflt;
  const v = Number(argvAll[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
// Paralellik yalnız DUVAR SAATİ için. Ölçülen token/süre değerleri çağrı
// başına olduğu için paralellik onları bozmuyor; yalnız toplam bekleme kısalıyor.
const PARALLEL = Math.max(1, numFlag("--parallel", 1));
// Kesme eksenleri. Gerçek `codex exec --json` akışında `turn.completed` koşum
// başına BİR kez, en sonda geliyor — yani tur tavanı akış ORTASINDA
// ateşlenemez; token sayacı da yalnız o olayda taşındığı için token tavanı
// fiilen post-hoc bir rapor (aşımı görür, kesmeyi kurtarmaz). Akış sürerken
// gerçekten kesebilen iki eksen kalıyor: item sayısı ve duvar saati.
const TIMEOUT_SEC = numFlag("--timeout-sec", 600);
// 100: KALİBRE EDİLMEMİŞ tahmin. 28 notluk koşumda gözlenen item dağılımına
// göre ayarlanacak.
const MAX_ITEMS = numFlag("--max-items", 100);
const MAX_TOKENS = numFlag("--max-tokens", 2_000_000); // input+cached+output+reasoning toplamı
const positional = argvAll.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argvAll[i - 1] ?? ""));
const [wt, notesDir, outPath, ...notes] = positional;
if (!wt || !notesDir || !outPath || notes.length === 0) {
  console.error("kullanım: adjudicate-cost.ts [--evidence] [--parallel N] [--timeout-sec S] [--max-items N] [--max-tokens N] <worktree> <notlar> <cikti.jsonl> <not>...");
  process.exit(2);
}

// Çıktı şeması: hakem iddia düzeyinde hüküm verir. Altın setin şemasıyla
// aynı hüküm kümesi — yoksa doğruluk ölçülemez.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "line_start", "line_end", "verdict", "evidence"],
        properties: {
          text: { type: "string" },
          line_start: { type: "integer" },
          line_end: { type: "integer" },
          verdict: { enum: ["gecerli", "curuk", "dogustan-yanlis", "olculemez"] },
          evidence: { type: "string" },
        },
      },
    },
  },
};

// ÇERÇEVE (CLAUDE.md §2.1): ölçüm görevi, hatırlama görevi değil. Modele
// "bu not doğru mu" diye sorulmuyor; "diske karşı ÖLÇ" deniyor. Emir kipiyle
// "kır / saldır" da yok — o dil sağlayıcı reddine yol açıyor
// (codex-cyberpolicy-reddi, 11 Ağu ölçümü).
function buildPrompt(note: string, body: string, evidence: string | null): string {
  const ev = evidence
    ? `\n--- ÖNCEDEN ÖLÇÜLMÜŞ KANIT (mekanik katman, aynı commit) ---\n${evidence}\n--- KANIT SONU ---\n\nBu kanıt zaten ölçüldü; yeniden ölçme. Yalnız kanıtın YETMEDİĞİ yerlerde depoya bak.\n`
    : "";
  return `Bir yazılım deposunun kök dizinindesin. Depo \`b4065f1\` commit'ine sabitlenmiş.

Aşağıda o depoya ait bir hafıza notu var. Görevin bu notu OKUMAK değil, ÖLÇMEK:
notun her doğrulanabilir iddiasının bu commit'te geçerli olup olmadığını
depodan tespit et.

Yöntem: dosyaları oku, \`git log\`/\`git show\`/\`git ls-files\` çalıştır.
Hükmü koddan çıkar, notun kendi anlatısından değil. Not bir şeyin var
olduğunu söylüyorsa bak; olmadığını söylüyorsa yine bak.

Her iddia için hüküm:
- gecerli          : bu commit'te doğru
- curuk            : yazıldığında doğruydu, bu commit'te yanlış
- dogustan-yanlis  : yazıldığı an da yanlıştı (kod hiç öyle olmamış)
- olculemez        : depoya karşı doğrulanamaz (dış servis, ağ, kullanıcı
                     beyanı, tarihsel anlatı). Bu ONURLU bir cevap —
                     ölçemediğin şeye hüküm verme.

SAYIM İDDİALARINI ATLAMA. Not bir sayı veriyorsa ("X.py 1682 satır",
"45 kayıtlı araç var", "3 test geçiyor", "8 sağlayıcı yolu") o sayıyı KOŞTUR
ve karşılaştır: \`wc -l\`, \`git grep -c\`, \`git ls-files | wc -l\`. Ölçülen
kaçtı, notta kaç yazıyor, ikisini de evidence'a yaz. (Ölçüldü: hakemin
kaçırdığı iddiaların hepsi bu sınıftandı.)

Notun HER doğrulanabilir ifadesini kapsa — yalnız dikkat çekenleri değil.

\`evidence\` alanına ölçtüğün somut şeyi yaz: SHA, dosya yolu, sembol adı,
sayı. Özet yargı değil.

\`line_start\`/\`line_end\`, iddianın notun kaçıncı satırlarından geldiği
(1'den başlayarak, aşağıdaki gövdeye göre).

Ölçüm bütçesi: hiçbir komut 60 saniyeyi geçmesin, arka planda süreç bırakma.

${ev}
--- NOT: ${note}.md ---
${body}
--- NOT SONU ---`;
}

type Usage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

type Cap = { kind: "time" | "items" | "tokens"; limit: number; observed: number };

function totalTokens(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0) +
    (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
}

/**
 * Süreç GRUBUNU öldürür, olmazsa tekil PID'ye düşer.
 *
 * Bu, ürünün `core/src/adapters/codex.ts:killProcessGroup` kalıbının BİLİNÇLİ
 * bir kopyası. Import edilmiyor: bu bir ölçüm aracı ve araç/ürün ayrımı
 * korunuyor — araç ürünün iç API'sine bağlanırsa ürün ölçüm aracının
 * ihtiyaçlarına göre şekillenmeye başlıyor. Kopyanın bedeli: kalıp
 * değişirse iki yerde değişir.
 *
 * Negatif PID tüm gruba sinyal gönderir (spawn `detached:true` sayesinde
 * pgid == child.pid); codex'in torunları böylece geride kalmıyor. POSIX dışı
 * platformda ilk deneme hata verir ve tekil PID'ye düşülür.
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid == null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* zaten ölmüş */ }
  }
}

function runCodex(prompt: string, schemaPath: string): Promise<{
  rc: number;
  usage: Usage | null;
  ms: number;
  claims: number;
  raw: string;
  cap: Cap | null;
}> {
  return new Promise((resolve) => {
    const args = [
      "exec", "--ephemeral", "--skip-git-repo-check", "--color", "never",
      "-s", "read-only",          // K9: hakem diske YAZMAZ; okumaya ve komut koşturmaya izin var
      "-C", wt,                   // araçlı hakem: çalışma kökü depo (executor.ts:20 bunu öngörmüştü)
      "--output-schema", schemaPath,
      "--json", "-",
    ];
    const t0 = Date.now();
    // detached: çocuk kendi süreç grubunun lideri olur; kesme torunları da
    // kapsasın diye (bkz. killProcessGroup). unref YOK — çıktıyı bekliyoruz.
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    let pending = "";       // satır tamponu: bir olay iki chunk'a bölünebilir
    let usage: Usage | null = null;
    let claims = 0;
    let items = 0;
    let cap: Cap | null = null;
    // Süreç kapandıktan SONRA kill YASAK: PID'yi işletim sistemi geri
    // dönüştürmüş olabilir ve kill(-pid) alakasız bir grubu vurur. Gerçek yol:
    // close handler'ının içinde tampondaki son (yeni-satırsız) satır işleniyor
    // ve o satır tavanı aşabiliyor. Aşım yine raporlanır, yalnız kill atlanır.
    let closed = false;

    function checkCaps(): void {
      if (cap) return; // ilk aşım kazanır
      if (usage && totalTokens(usage) > MAX_TOKENS) {
        cap = { kind: "tokens", limit: MAX_TOKENS, observed: totalTokens(usage) };
      } else if (items > MAX_ITEMS) {
        cap = { kind: "items", limit: MAX_ITEMS, observed: items };
      } else return;
      if (!closed) killProcessGroup(child.pid);
    }

    function handleLine(line: string): void {
      const s = line.trim();
      if (!s.startsWith("{")) return;
      try {
        const o = JSON.parse(s);
        if (o.type === "turn.completed" && o.usage) usage = o.usage;
        if (o.type === "item.completed") {
          items++;
          // Son mesaj metin olarak geliyor; şemalı çıktı o metnin İÇİNDE
          // JSON. Olayın kendisini JSON.stringify edip "verdict" saymak
          // kaçırıyordu (kaçış karakterleri) — metni ayrıca ayrıştır.
          const txt = o.item?.text ?? o.item?.content ?? "";
          if (typeof txt === "string" && txt.includes("verdict")) {
            try {
              const parsed = JSON.parse(txt);
              if (Array.isArray(parsed?.claims)) claims = Math.max(claims, parsed.claims.length);
            } catch {
              const m = txt.match(/"verdict"/g);
              if (m) claims = Math.max(claims, m.length);
            }
          }
        }
      } catch { /* akışta JSON olmayan satırlar olabilir */ }
      checkCaps();
    }

    const timer = setTimeout(() => {
      if (!cap) cap = { kind: "time", limit: TIMEOUT_SEC, observed: Math.round((Date.now() - t0) / 1000) };
      if (!closed) killProcessGroup(child.pid);
    }, TIMEOUT_SEC * 1000);

    child.stdout.setEncoding("utf8"); // çok baytlı karakter chunk sınırında bölünmesin
    child.stdout.on("data", (d: string) => {
      out += d;
      pending += d;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const l of parts) handleLine(l);
    });
    child.stderr.on("data", () => {});
    // Süreç tavanla öldürüldüğünde prompt yazımı EPIPE ile patlıyor; ölçüm
    // aracının o notu kaybetmesine değil, cap'li satır yazmasına ihtiyaç var.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    function finish(rc: number): void {
      closed = true;
      clearTimeout(timer);
      if (pending) handleLine(pending);
      (usage as Usage & { _items?: number } | null) && ((usage as any)._items = items);
      resolve({ rc, usage, ms: Date.now() - t0, claims, raw: out, cap });
    }
    child.on("error", () => finish(-1));
    child.on("close", (rc) => finish(rc ?? -1));
  });
}

const gitCtx = WITH_EVIDENCE ? await openGit(wt, { fetch: false, originRef: "19c623f" }) : null;
if (WITH_EVIDENCE && !gitCtx) { console.error("git bağlamı açılamadı"); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), "adj-"));
const schemaPath = join(tmp, "schema.json");
writeFileSync(schemaPath, JSON.stringify(SCHEMA));

writeFileSync(outPath, "");
console.log("not".padEnd(36) + "satır  süre(sn)  girdi   önbellek  çıktı  akıl   iddia");
console.log("─".repeat(88));

async function one(note: string): Promise<void> {
  const body = readFileSync(join(notesDir, `${note}.md`), "utf8");
  const lines = body.split("\n").length;
  let evidence: string | null = null;
  if (WITH_EVIDENCE) {
    const { anchors } = extractAnchors(body);
    const verdicts = await checkAnchors(gitCtx!, anchors, new Date(0).toISOString());
    evidence = evidenceFor(verdicts);
  }
  const r = await runCodex(buildPrompt(note, body, evidence), schemaPath);
  writeFileSync(`${outPath}.${note}.raw.jsonl`, r.raw);
  const u = r.usage ?? {};
  appendFileSync(outPath, JSON.stringify({
    note, lines, rc: r.rc, ms: r.ms, evidence_fed: WITH_EVIDENCE,
    // Tavanla kesilen notun ölçümü YARIM: iddia listesi eksik olabilir, o
    // yüzden not doğruluk hesabında `olculemez` sayılır (yanlış sayılmaz).
    cap: r.cap,
    olculemez: r.cap !== null,
    input_tokens: u.input_tokens ?? null,
    cached_input_tokens: u.cached_input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    reasoning_output_tokens: u.reasoning_output_tokens ?? null,
    claims: r.claims,
  }) + "\n");
  console.log(
    note.padEnd(36) + String(lines).padStart(5) + String((r.ms / 1000).toFixed(0)).padStart(9) +
    String(u.input_tokens ?? "-").padStart(8) + String(u.cached_input_tokens ?? "-").padStart(10) +
    String(u.output_tokens ?? "-").padStart(7) + String(u.reasoning_output_tokens ?? "-").padStart(7) +
    String(r.claims).padStart(7) + (r.rc === 0 ? "" : `  rc=${r.rc}`) +
    (r.cap ? `  CAP ${r.cap.kind} ${r.cap.observed}/${r.cap.limit} → olculemez` : ""),
  );
}

const queue = [...notes];
await Promise.all(
  Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    for (;;) {
      const n = queue.shift();
      if (!n) return;
      try { await one(n); } catch (e) { console.log(`${n.padEnd(36)}  HATA: ${(e as Error).message}`); }
    }
  }),
);
console.log(`\nham kayıt: ${outPath}`);
