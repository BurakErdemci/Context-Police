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
//     <worktree> <notlar-dizini> <cikti.jsonl> <not> [<not> ...]

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
const positional = argvAll.filter((a) => !a.startsWith("--"));
const [wt, notesDir, outPath, ...notes] = positional;
if (!wt || !notesDir || !outPath || notes.length === 0) {
  console.error("kullanım: adjudicate-cost.ts <worktree> <notlar> <cikti.jsonl> <not>...");
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

function runCodex(prompt: string, schemaPath: string): Promise<{
  rc: number;
  usage: Usage | null;
  ms: number;
  claims: number;
  raw: string;
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
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    child.stdin.end(prompt);
    child.on("close", (rc) => {
      const ms = Date.now() - t0;
      let usage: Usage | null = null;
      let claims = 0;
      let turns = 0;
      for (const line of out.split("\n")) {
        const s = line.trim();
        if (!s.startsWith("{")) continue;
        try {
          const o = JSON.parse(s);
          if (o.type === "turn.completed" && o.usage) usage = o.usage;
          if (o.type === "item.completed") {
            turns++;
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
      }
      (usage as Usage & { _turns?: number } | null) && ((usage as any)._turns = turns);
      resolve({ rc: rc ?? -1, usage, ms, claims, raw: out });
    });
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

for (const note of notes) {
  const body = readFileSync(join(notesDir, `${note}.md`), "utf8");
  const lines = body.split("\n").length;
  let evidence: string | null = null;
  if (WITH_EVIDENCE) {
    const parsed = parseNote(body);
    const { anchors } = extractAnchors(body);
    const verdicts = await checkAnchors(gitCtx!, anchors, new Date(0).toISOString());
    evidence = evidenceFor(verdicts);
  }
  const r = await runCodex(buildPrompt(note, body, evidence), schemaPath);
  // Ham akış saklanıyor: iddia sayacı sessizce 0 döndüğünde çağrının hiç
  // hüküm üretmediği mi yoksa ayrıştırmanın mı kaçırdığı ancak böyle ayrılır.
  writeFileSync(`${outPath}.${note}.raw.jsonl`, r.raw);
  const u = r.usage ?? {};
  const rec = {
    note, lines, rc: r.rc, ms: r.ms, evidence_fed: WITH_EVIDENCE,
    input_tokens: u.input_tokens ?? null,
    cached_input_tokens: u.cached_input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    reasoning_output_tokens: u.reasoning_output_tokens ?? null,
    claims: r.claims,
  };
  appendFileSync(outPath, JSON.stringify(rec) + "\n");
  console.log(
    note.padEnd(36) +
      String(lines).padStart(5) +
      String((r.ms / 1000).toFixed(0)).padStart(9) +
      String(u.input_tokens ?? "-").padStart(8) +
      String(u.cached_input_tokens ?? "-").padStart(10) +
      String(u.output_tokens ?? "-").padStart(7) +
      String(u.reasoning_output_tokens ?? "-").padStart(7) +
      String(r.claims).padStart(7) +
      (r.rc === 0 ? "" : `  rc=${r.rc}`),
  );
}
console.log(`\nham kayıt: ${outPath}`);
