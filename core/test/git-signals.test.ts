import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpDir } from "./helpers.ts";
import {
  openGit, fileExistsAt, fileEverExisted, commitsTouching, symbolExists, symbolEverExisted, commitExists,
} from "../src/signals/git.ts";

let repo: string;
let firstSha: string;

before(() => {
  // realpathSync şart: macOS'ta $TMPDIR bir sembolik bağ (/var → /private/var) ve
  // `git rev-parse --show-toplevel` bağı çözerek döner. Çözmeden karşılaştırma
  // gerçek repoda kırmızı veren sahte bir yeşil olurdu.
  repo = realpathSync(tmpDir("cp-git-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export function eskiSembol() {}\n");
  git("add", "-A"); git("commit", "-qm", "ilk"); firstSha = git("rev-parse", "HEAD");
  // İkinci commit: sembol yeniden adlandı, dosya silinip yenisi geldi.
  writeFileSync(join(repo, "src", "a.ts"), "export function yeniSembol() {}\n");
  writeFileSync(join(repo, "src", "b.ts"), "export const x = 1;\n");
  git("add", "-A"); git("commit", "-qm", "ikinci");
  rmSync(join(repo, "src", "b.ts"));
  git("add", "-A"); git("commit", "-qm", "b silindi");
});

test("openGit: repo tanınır, git olmayan dizinde null", async () => {
  const ctx = await openGit(repo, { fetch: false });
  assert.ok(ctx);
  assert.equal(ctx!.repoRoot, repo);
  assert.equal(ctx!.originRef, null); // origin'siz repo: yalnız çalışma ağacı
  assert.equal(await openGit(tmpDir("cp-nogit-"), { fetch: false }), null);
});

test("dosya sinyalleri: var / silinmiş-ama-geçmişte-var / hiç-var-olmamış üçlüsü ayrışır", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  assert.equal(await fileExistsAt(ctx, "HEAD", "src/a.ts"), true);
  assert.equal(await fileExistsAt(ctx, "HEAD", "src/b.ts"), false);
  assert.equal(await fileEverExisted(ctx, "src/b.ts"), true);   // silinmiş → missing_now hammaddesi
  assert.equal(await fileEverExisted(ctx, "src/hayalet.ts"), false); // → never_existed hammaddesi
  assert.equal(await commitsTouching(ctx, "HEAD", "src/a.ts", "1970-01-01T00:00:00Z"), 2);
});

test("sembol sinyalleri: kayıp sembol geçmişte aranır; sha varlığı", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  assert.equal(await symbolExists(ctx, null, "yeniSembol"), true);   // null ref = çalışma ağacı
  assert.equal(await symbolExists(ctx, null, "eskiSembol"), false);
  assert.equal(await symbolEverExisted(ctx, "eskiSembol"), true);    // → symbol_lost hammaddesi
  assert.equal(await symbolEverExisted(ctx, "hayaletSembol"), false); // → unverifiable
  assert.equal(await commitExists(ctx, firstSha), true);
  assert.equal(await commitExists(ctx, "deadbeef"), false);
});
