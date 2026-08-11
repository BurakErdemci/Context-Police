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
let clone: string;
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

  // Origin'li fixture: YEREL klon (dosya yolu, ağ yok). Görev 11'in altın set
  // ölçümü tamamen originRef yoluna dayanıyor; origin'siz repoda o yol yalnız
  // null dalıyla koşar, yani hiç ölçülmemiş olur.
  clone = realpathSync(tmpDir("cp-git-clone-"));
  execFileSync("git", ["clone", "-q", repo, clone], { encoding: "utf8" });
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

test("originRef: origin'li klonda aday listesinden ilk geçerli olan seçilir", async () => {
  const ctx = (await openGit(clone, { fetch: false }))!;
  assert.ok(ctx);
  assert.notEqual(ctx.originRef, null); // origin'siz repodaki null dalının karşıtı
  // Aday sırası origin/HEAD > origin/main > origin/master. Yerel klon
  // refs/remotes/origin/HEAD'i kurar (ölçüldü: -> refs/remotes/origin/main),
  // dolayısıyla ilk aday kazanır. Sıra bozulursa bu satır kırmızı verir.
  assert.equal(ctx.originRef, "origin/HEAD");
  // İsim çözülmüş olması yetmez; ref'in gerçekten commit'e bağlandığını göster.
  assert.equal(await commitExists(ctx, ctx.originRef!), true);
  assert.equal(await fileExistsAt(ctx, ctx.originRef!, "src/a.ts"), true);
});

test("originRef: ölçüm pin'i her adaydan önce gelir ve pin'li ref sorgulanabilir", async () => {
  // D-M3-8: altın set origin'in BUGÜNKÜ ucuna değil ölçüm günkü ucuna denetlenir.
  const ctx = (await openGit(clone, { fetch: false, originRef: firstSha }))!;
  assert.equal(ctx.originRef, firstSha); // aday listesi hiç denenmedi

  // Pin'li ref üzerinden sorgu — ölçümün yapacağı şeyin aynısı.
  assert.equal(await fileExistsAt(ctx, ctx.originRef!, "src/a.ts"), true);
  // Pin'in zamanı gerçekten geri sardığının kanıtı: eskiSembol ilk commit'te
  // duruyor, HEAD'de yok. İki cevabın FARKLI olması pin'in sahiden iş gördüğünü
  // gösterir — aynı olsalardı test pin'i ölçmüş olmazdı.
  assert.equal(await symbolExists(ctx, firstSha, "eskiSembol"), true);
  assert.equal(await symbolExists(ctx, "HEAD", "eskiSembol"), false);
});

test("originRef: geçersiz pin aday listesine DÜŞMEZ, null döner", async () => {
  const ctx = (await openGit(clone, { fetch: false, originRef: "deadbeef" }))!;
  assert.ok(ctx);
  // Pin verilmişse tek aday odur. Sessizce origin/HEAD'e düşmek daha beter
  // olurdu: ölçüm pin'li sanılırken aslında bugünkü uca karşı koşardı ve
  // altın set sonucu sessizce yanlış çıkardı. null = "denetlenecek uzak uç yok".
  assert.equal(ctx.originRef, null);
});
