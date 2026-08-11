// Salt-okunur git yardımcısı. Tek yan etkisi best-effort fetch (D-M3-5) — o da
// çalışma ağacına değil .git'e dokunur ve --no-fetch ile kapatılabilir.
// Her çağrı zaman aşımlı: asılı bir git süreci arka plan denetçisini asamaz.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;

export interface GitContext {
  repoRoot: string;
  head: string;
  /** origin/<default> çözümü; null = origin yok, yalnız çalışma ağacı denetlenir. */
  originRef: string | null;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, out: stdout.trim() };
  } catch {
    // ok=false "hata" değil çoğu zaman "hayır" (cat-file -e, grep). Ayrım
    // çağıranın sorusunda: varlık soruları için ikisi aynı cevap.
    return { ok: false, out: "" };
  }
}

export async function openGit(
  dir: string, opts: { fetch?: boolean; originRef?: string } = {},
): Promise<GitContext | null> {
  const root = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return null;
  const head = await git(root.out, ["rev-parse", "HEAD"]);
  if (!head.ok) return null; // commit'siz repo: denetlenecek geçmiş yok

  if (opts.fetch !== false) await git(root.out, ["fetch", "--quiet", "origin"]); // best-effort

  let originRef: string | null = null;
  // Ölçüm pin'i (D-M3-8) her adaydan önce gelir: altın set origin'in BUGÜNKÜ
  // ucuna değil ölçüm günkü ucuna (19c623f) karşı denetlenir.
  const candidates = opts.originRef !== undefined
    ? [opts.originRef]
    : ["origin/HEAD", "origin/main", "origin/master"];
  for (const cand of candidates) {
    if ((await git(root.out, ["rev-parse", "--verify", "--quiet", `${cand}^{commit}`])).ok) {
      originRef = cand;
      break;
    }
  }
  return { repoRoot: root.out, head: head.out, originRef };
}

/** ref:path var mı. */
export async function fileExistsAt(ctx: GitContext, ref: string, path: string): Promise<boolean> {
  return (await git(ctx.repoRoot, ["cat-file", "-e", `${ref}:${path}`])).ok;
}

/** Yol geçmişin HERHANGİ bir noktasında eklendi mi — never_existed'ı missing_now'dan ayıran soru. */
export async function fileEverExisted(ctx: GitContext, path: string): Promise<boolean> {
  const r = await git(ctx.repoRoot, ["log", "--all", "--diff-filter=A", "-1", "--format=%H", "--", path]);
  return r.ok && r.out !== "";
}

/** sinceIso'dan beri yola dokunan commit sayısı (churn — D-M3-4). */
export async function commitsTouching(ctx: GitContext, ref: string, path: string, sinceIso: string): Promise<number> {
  const r = await git(ctx.repoRoot, ["rev-list", "--count", `--since=${sinceIso}`, ref, "--", path]);
  const n = Number(r.out);
  return r.ok && Number.isFinite(n) ? n : 0;
}

/** ref null → çalışma ağacında ara (izlenen dosyalar). */
export async function symbolExists(ctx: GitContext, ref: string | null, symbol: string): Promise<boolean> {
  const args = ["grep", "-F", "-l", "-e", symbol];
  if (ref !== null) args.push(ref);
  const r = await git(ctx.repoRoot, args);
  return r.ok && r.out !== "";
}

/** Sembol geçmişte hiç geçti mi (-S: ekleyen/silen commit arar). Aşırı-üretilmiş
 *  çapayı gerçek kayıptan ayıran soru: hiç izi yoksa suçlama yok (D-M3-2). */
export async function symbolEverExisted(ctx: GitContext, symbol: string): Promise<boolean> {
  const r = await git(ctx.repoRoot, ["log", "--all", "-1", "--format=%H", `-S${symbol}`]);
  return r.ok && r.out !== "";
}

export async function commitExists(ctx: GitContext, sha: string): Promise<boolean> {
  return (await git(ctx.repoRoot, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`])).ok;
}
