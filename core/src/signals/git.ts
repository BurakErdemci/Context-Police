// Salt-okunur git yardımcısı. Tek yan etkisi best-effort fetch (D-M3-5) — o da
// çalışma ağacına değil .git'e dokunur ve --no-fetch ile kapatılabilir.
// Her çağrı zaman aşımlı: asılı bir git süreci arka plan denetçisini asamaz.
//
// TEMEL SÖZLEŞME (denetim 2026-08-11, error-path turu): bu modül "hayır" ile
// "ölçemedim"i ASLA aynı değere indirmez. Eskiden her istisna `{ok:false, out:""}`
// oluyordu ve `anchor-drift.ts` bunu `missing_now`/`symbol_lost` diye okuyordu —
// yani bir git arızası doğrudan bir SUÇLAMAYA dönüşüyordu. Ürünün tek çıktısı
// bir hüküm olduğu için bu, kusurun en pahalı sınıfı.
// Repro (çürütücü, shim'siz): `--filter=blob:none` ile klonlanmış bir repoda
// promisor remote erişilemezse blob'a dokunan komutlar rc=128 verir, ama
// `rev-parse --show-toplevel/HEAD` başarılıdır — `openGit` geçer, sinyal AÇIK
// koşar ve DURAN bir dosya `missing_now` olur.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export interface GitContext {
  repoRoot: string;
  head: string;
  /** origin/<default> çözümü; null = origin yok, yalnız çalışma ağacı denetlenir. */
  originRef: string | null;
}

/**
 * Ölçüm sonucu. `ok:false` "hayır" DEĞİL "ölçemedim" demektir — meşru hayır
 * `{ ok: true, value: false }` (ya da boş liste) olarak döner. Çağıranın bu
 * ikisini ayırt etmesi zorunlu: ayrım kaybolursa arıza hükme dönüşür.
 */
export type Measured<T> =
  | { ok: true; value: T }
  | { ok: false; command: string; reason: string };

/** `git()`'in üç durumu. `no` = komut cevap verdi ve cevabı "hayır". */
type GitOutcome =
  | { kind: "ok"; out: string }
  | { kind: "no" }
  | { kind: "failed"; reason: string };

/**
 * `promisify(execFile)` hatasını sınıflandırır. Alanlar tahmin değil ÖLÇÜM
 * (node 24.10 / macOS, 2026-08-11):
 *   spawn hatası → `code` bir STRING ("ENOENT"), `errno` negatif sayı
 *   maxBuffer    → RangeError, `code` = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
 *   zaman aşımı  → `code` null, `killed` true, `signal` "SIGTERM"
 *   çıkış kodu   → `code` bir SAYI, `stderr` dolu
 * Sıra önemli: zaman aşımında `code` null olduğu için sayı kontrolü en sonda.
 * Testten erişilebilsin diye dışa açık — zaman aşımını uçtan uca sınamak
 * GIT_TIMEOUT_MS kadar beklemek demekti.
 */
export function classifyFailure(err: unknown): string {
  const e = err as { code?: unknown; killed?: boolean; signal?: string; stderr?: unknown; message?: string };
  const firstLine = typeof e.stderr === "string" && e.stderr.trim() !== ""
    ? ` ${e.stderr.trim().split("\n")[0]!.slice(0, 200)}`
    : "";
  if (typeof e.code === "string") {
    return e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? `maxbuffer:${GIT_MAX_BUFFER}`
      : `spawn:${e.code}`;
  }
  if (e.killed === true) return `timeout:${GIT_TIMEOUT_MS}ms`;
  if (typeof e.code === "number") return `exit:${e.code}${firstLine}`;
  return `unknown:${String(e.message ?? err).slice(0, 200)}`;
}

/**
 * @param noExit Bu çıkış kodu komutun MEŞRU "hayır" cevabıdır (örn. `git grep`
 *   eşleşme bulamayınca rc=1). Verilmezse rc≠0'ın tamamı arızadır.
 */
async function git(cwd: string, args: string[], opts: { noExit?: number } = {}): Promise<GitOutcome> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
    });
    return { kind: "ok", out: stdout.trim() };
  } catch (err) {
    if (opts.noExit !== undefined && (err as { code?: unknown }).code === opts.noExit) return { kind: "no" };
    return { kind: "failed", reason: classifyFailure(err) };
  }
}

/** GitOutcome → Measured. `no` ve boş çıktı çağıranın "hayır"ıdır. */
function measure<T>(cmd: string, r: GitOutcome, map: (out: string | null) => T): Measured<T> {
  if (r.kind === "failed") return { ok: false, command: cmd, reason: r.reason };
  return { ok: true, value: map(r.kind === "ok" ? r.out : null) };
}

export async function openGit(
  dir: string, opts: { fetch?: boolean; originRef?: string } = {},
): Promise<GitContext | null> {
  // Burada arıza ile "repo değil"i ayırmaya gerek YOK: her iki hâlde de sinyal
  // tümden kapanır ve audit.ts `anchor_signal_disabled` olayını yazar — yani
  // sessizlik değil, kayıtlı bir "bakılamadı". Suçlama üretmeyen tek yol bu.
  const root = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (root.kind !== "ok") return null;
  const head = await git(root.out, ["rev-parse", "HEAD"]);
  if (head.kind !== "ok") return null; // commit'siz repo: denetlenecek geçmiş yok

  if (opts.fetch !== false) await git(root.out, ["fetch", "--quiet", "origin"]); // best-effort

  let originRef: string | null = null;
  // Ölçüm pin'i (D-M3-8) her adaydan önce gelir: altın set origin'in BUGÜNKÜ
  // ucuna değil ölçüm günkü ucuna (19c623f) karşı denetlenir.
  const candidates = opts.originRef !== undefined
    ? [opts.originRef]
    : ["origin/HEAD", "origin/main", "origin/master"];
  for (const cand of candidates) {
    const r = await git(root.out, ["rev-parse", "--verify", "--quiet", `${cand}^{commit}`], { noExit: 1 });
    if (r.kind === "ok") { originRef = cand; break; }
  }
  return { repoRoot: root.out, head: head.out, originRef };
}

/**
 * ref:path var mı.
 *
 * Komut seçimi ÖLÇÜMLE yapıldı (git 2.50.1, 2026-08-11) — üçü de denendi:
 *   `cat-file -e <ref>:<yol>` : yokluk da arıza da rc=128 veriyor
 *     ("fatal: path ... does not exist in" vs promisor hatası), yani çıkış kodu
 *     ayırt etmiyor; üstelik BLOB'u okumak zorunda olduğu için blobsuz klonda
 *     duran dosyada patlıyor. Blocker'ın kaynağı tam olarak buydu.
 *   `rev-parse --verify --quiet <ref>:<yol>` : ağaç nesnesi bozuksa SESSİZCE
 *     rc=1 dönüyor — gerçek arızayı "dosya yok" cevabından ayırmak imkânsız.
 *   `ls-tree -r --name-only <ref> -- <yol>` : rc=0 + boş çıktı = kesin "yok",
 *     rc≠0 = kesin arıza (bozuk ağaçta rc=1+stderr, geçersiz ref'te rc=128).
 *     Yalnız AĞAÇ nesnelerine baktığı için blobsuz klonda doğru cevabı veriyor.
 * `-r` hem dosya hem dizin çapasını karşılar (dizin altındaki yolları listeler).
 */
export async function fileExistsAt(ctx: GitContext, ref: string, path: string): Promise<Measured<boolean>> {
  const args = ["ls-tree", "-r", "--name-only", ref, "--", path];
  return measure(`git ls-tree ${ref} -- ${path}`, await git(ctx.repoRoot, args), (out) => out !== null && out !== "");
}

/** Yol geçmişin HERHANGİ bir noktasında eklendi mi — never_existed'ı missing_now'dan ayıran soru. */
export async function fileEverExisted(ctx: GitContext, path: string): Promise<Measured<boolean>> {
  const args = ["log", "--all", "--diff-filter=A", "-1", "--format=%H", "--", path];
  return measure(`git log --diff-filter=A -- ${path}`, await git(ctx.repoRoot, args), (out) => out !== null && out !== "");
}

/** sinceIso'dan beri yola dokunan commit sayısı (churn — D-M3-4). */
export async function commitsTouching(
  ctx: GitContext, ref: string, path: string, sinceIso: string,
): Promise<Measured<number>> {
  const args = ["rev-list", "--count", `--since=${sinceIso}`, ref, "--", path];
  const r = await git(ctx.repoRoot, args);
  const cmd = `git rev-list --count ${ref} -- ${path}`;
  if (r.kind === "failed") return { ok: false, command: cmd, reason: r.reason };
  const n = Number(r.kind === "ok" ? r.out : "");
  // rc=0 ama çıktı sayı değil: bu da bir arıza. Sessizce 0 saymak "churn yok"
  // demektir ve KAÇIRILAN çürüme üretir (ters yön, ama yine sessiz).
  if (!Number.isFinite(n)) return { ok: false, command: cmd, reason: "unparsable-count" };
  return { ok: true, value: n };
}

/** ref null → çalışma ağacında ara (izlenen dosyalar). */
export async function symbolExists(
  ctx: GitContext, ref: string | null, symbol: string,
): Promise<Measured<boolean>> {
  const args = ["grep", "-F", "-l", "-e", symbol];
  if (ref !== null) args.push(ref);
  // Ölçüldü: `git grep` eşleşme bulamayınca rc=1 (temiz "hayır"), gerçek arızada
  // rc=128 (blobsuz klonda promisor hatası). rc=1 tek meşru hayır kodu.
  const r = await git(ctx.repoRoot, args, { noExit: 1 });
  return measure(`git grep -F -l ${symbol}`, r, (out) => out !== null && out !== "");
}

/** Sembol geçmişte hiç geçti mi (-S: ekleyen/silen commit arar). Aşırı-üretilmiş
 *  çapayı gerçek kayıptan ayıran soru: hiç izi yoksa suçlama yok (D-M3-2). */
export async function symbolEverExisted(ctx: GitContext, symbol: string): Promise<Measured<boolean>> {
  const args = ["log", "--all", "-1", "--format=%H", `-S${symbol}`];
  return measure(`git log -S${symbol}`, await git(ctx.repoRoot, args), (out) => out !== null && out !== "");
}

export async function commitExists(ctx: GitContext, sha: string): Promise<Measured<boolean>> {
  // `--quiet` gerçek arızaları da rc=1'e indirebiliyor (ölçüldü: bozuk repoda
  // sessiz rc=1). Burada zararsız: sha çapası "yok" dediğinde de sonuç
  // `unverifiable` (ağırlık 0), yani iki yol da suçlama üretmiyor.
  const r = await git(ctx.repoRoot, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { noExit: 1 });
  return measure(`git rev-parse --verify ${sha}`, r, (out) => out !== null && out !== "");
}
