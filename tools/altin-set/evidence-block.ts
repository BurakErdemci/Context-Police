// Bir notun ÖNDEN ÖLÇÜLMÜŞ kanıtını üretir — hakeme keşif yaptırmak yerine
// vermek için.
//
// Neden: 13 Ağu ölçümü (`2026-08-13-m4-hakem-maliyeti.md`) araçlı hakemin
// maliyetinin not boyutundan değil KEŞİF turlarından geldiğini gösterdi —
// 14 satırlık bir not 295 saniye sürdü. Oysa mekanik katman hangi çapanın
// kaydığını, hangi dosyanın hiç var olmadığını, kaç commit'in dosyaya
// dokunduğunu ZATEN ölçüyor (`anchor-drift.ts`) ve skorladıktan sonra atıyor.
//
// Bu araç o ölçümü metne çevirir. Ürün kodunu yeniden yazmıyor, çağırıyor:
// kanıt hakeme gidenle mekanik skorun gördüğü aynı şey olmalı, yoksa iki
// katman farklı gerçekliklerde yaşar.
//
// Kullanım:
//   node --experimental-strip-types tools/altin-set/evidence-block.ts \
//     <worktree> <notlar-dizini> <origin-ref> <not> [<not> ...]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote, extractAnchors } from "../../core/src/importer/parse.ts";
import { openGit } from "../../core/src/signals/git.ts";
import { checkAnchors } from "../../core/src/signals/anchor-drift.ts";

// Bu dosya hem KÜTÜPHANE (evidenceFor) hem BETİK. Import edildiğinde ana
// döngünün de koşması gerçek bir arızaya yol açtı: adjudicate-cost.ts bunu
// import edince aşağıdaki döngü process.argv'yi kendi sanıp `--evidence`
// bayrağını not adı olarak dosya aradı ve koşum ENOENT ile öldü.
const IS_MAIN = process.argv[1]?.endsWith("evidence-block.ts") ?? false;

const STATE_TR: Record<string, string> = {
  ok: "duruyor",
  missing_now: "ARTIK YOK (bir zamanlar vardı)",
  never_existed: "HİÇ VAR OLMAMIŞ",
  symbol_lost: "SEMBOL KAYBOLMUŞ",
  churned: "duruyor ama çok değişmiş",
  unverifiable: "ölçülemedi",
};

export function evidenceFor(
  verdicts: Awaited<ReturnType<typeof checkAnchors>>,
): string {
  if (verdicts.length === 0) return "(bu notta mekanik çapa bulunamadı)";
  const lines: string[] = [];
  for (const v of verdicts) {
    const bits = [`${v.anchor.kind}: ${v.anchor.value}`, `→ ${STATE_TR[v.state] ?? v.state}`];
    if (v.commits !== undefined) bits.push(`(${v.commits} commit dokunmuş)`);
    if (v.resolvedPath) bits.push(`[gerçek yol: ${v.resolvedPath}]`);
    // Ölçüm arızası GİZLENMİYOR: hakem "ölçülemedi" ile "yok" arasındaki
    // farkı görmezse, ölçemediğimiz şeyi suçlamaya çevirir.
    if (v.measurementFailed) bits.push(`[ölçüm arızası: ${v.measurementFailed.reason}]`);
    if (v.budgetExhausted) bits.push("[bütçe doldu, ölçülmedi]");
    lines.push("  - " + bits.join(" "));
  }
  return lines.join("\n");
}

if (IS_MAIN) {
  const [wt, notesDir, originRef, ...notes] = process.argv.slice(2);
  if (!wt || !notesDir || !originRef || notes.length === 0) {
    console.error("kullanım: evidence-block.ts <worktree> <notlar> <origin-ref> <not>...");
    process.exit(2);
  }
  const ctx = await openGit(wt, { fetch: false, originRef });
  if (!ctx) {
    console.error(`git bağlamı açılamadı: ${wt}`);
    process.exit(1);
  }
  for (const note of notes) {
    const raw = readFileSync(join(notesDir, `${note}.md`), "utf8");
    const { anchors, dropped } = extractAnchors(raw);
    const verdicts = await checkAnchors(ctx, anchors, new Date(0).toISOString());
    console.log(`### ${note}`);
    console.log(evidenceFor(verdicts));
    if (dropped > 0) console.log(`  (kota nedeniyle ${dropped} çapa ölçülmedi)`);
    console.log();
  }
}
