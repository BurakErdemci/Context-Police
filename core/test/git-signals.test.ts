import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpDir } from "./helpers.ts";
import {
  openGit, fileExistsAt, fileEverExisted, commitsTouching, symbolExists, symbolEverExisted, commitExists,
  filesMatchingSuffix,
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

// Yardımcılar `Measured<T>` döndürüyor (denetim 2026-08-11): "hayır" ile
// "ölçemedim" ayrı değerler. deepEqual ikisini birden sınar — `.value`'ya
// bakan bir kısayol, arıza hâlinde undefined görüp sessizce yanlış cevap
// verebilirdi. `{ok:true}` beklentisi aynı zamanda "ölçüm gerçekten yapıldı"
// iddiasıdır.
const yes = { ok: true, value: true };
const no = { ok: true, value: false };

test("dosya sinyalleri: var / silinmiş-ama-geçmişte-var / hiç-var-olmamış üçlüsü ayrışır", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  assert.deepEqual(await fileExistsAt(ctx, "HEAD", "src/a.ts"), yes);
  assert.deepEqual(await fileExistsAt(ctx, "HEAD", "src/b.ts"), no);
  assert.deepEqual(await fileEverExisted(ctx, "src/b.ts"), yes);   // silinmiş → missing_now hammaddesi
  assert.deepEqual(await fileEverExisted(ctx, "src/hayalet.ts"), no); // → never_existed hammaddesi
  assert.deepEqual(await commitsTouching(ctx, "HEAD", "src/a.ts", "1970-01-01T00:00:00Z"), { ok: true, value: 2 });
});

test("sembol sinyalleri: kayıp sembol geçmişte aranır; sha varlığı", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  assert.deepEqual(await symbolExists(ctx, null, "yeniSembol"), yes);   // null ref = çalışma ağacı
  assert.deepEqual(await symbolExists(ctx, null, "eskiSembol"), no);
  assert.deepEqual(await symbolEverExisted(ctx, "eskiSembol"), yes);    // → symbol_lost hammaddesi
  assert.deepEqual(await symbolEverExisted(ctx, "hayaletSembol"), no); // → unverifiable
  assert.deepEqual(await commitExists(ctx, firstSha), yes);
  assert.deepEqual(await commitExists(ctx, "deadbeef"), no);
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
  assert.deepEqual(await commitExists(ctx, ctx.originRef!), yes);
  assert.deepEqual(await fileExistsAt(ctx, ctx.originRef!, "src/a.ts"), yes);
});

test("originRef: ölçüm pin'i her adaydan önce gelir ve pin'li ref sorgulanabilir", async () => {
  // D-M3-8: altın set origin'in BUGÜNKÜ ucuna değil ölçüm günkü ucuna denetlenir.
  const ctx = (await openGit(clone, { fetch: false, originRef: firstSha }))!;
  assert.equal(ctx.originRef, firstSha); // aday listesi hiç denenmedi

  // Pin'li ref üzerinden sorgu — ölçümün yapacağı şeyin aynısı.
  assert.deepEqual(await fileExistsAt(ctx, ctx.originRef!, "src/a.ts"), yes);
  // Pin'in zamanı gerçekten geri sardığının kanıtı: eskiSembol ilk commit'te
  // duruyor, HEAD'de yok. İki cevabın FARKLI olması pin'in sahiden iş gördüğünü
  // gösterir — aynı olsalardı test pin'i ölçmüş olmazdı.
  assert.deepEqual(await symbolExists(ctx, firstSha, "eskiSembol"), yes);
  assert.deepEqual(await symbolExists(ctx, "HEAD", "eskiSembol"), no);
});

// Altın set §5.2: 15 `never_existed` hükmünün 10'u repoda GERÇEKTEN var olan
// dosyaları gösteriyordu — not yolu kısa/göreli yazdığı için (`./build_backend.sh`
// ↔ `Backend/build_backend.sh`). Sonek eşlemesi tam bu sınıfı çözer.
test("filesMatchingSuffix: kısa yol sonekten çözülür, ./ öneki soyulur, glob kaçılır", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  assert.deepEqual(await filesMatchingSuffix(ctx, "a.ts"), { ok: true, value: ["src/a.ts"] });
  assert.deepEqual(await filesMatchingSuffix(ctx, "./a.ts"), { ok: true, value: ["src/a.ts"] });
  // Sonek TAM parça eşleşmesi: yarım ad eşleşmemeli.
  assert.deepEqual(await filesMatchingSuffix(ctx, "hayalet.ts"), { ok: true, value: [] });
  // Kaçış olmasaydı `a*.ts` glob'u `src/a.ts`'i yakalardı ve olmayan bir yolu
  // var gibi gösterirdi — bu, sahte bir "çözüldü" hükmü demek.
  assert.deepEqual(await filesMatchingSuffix(ctx, "a*.ts"), { ok: true, value: [] });
});

test("originRef: geçersiz pin aday listesine DÜŞMEZ, null döner", async () => {
  const ctx = (await openGit(clone, { fetch: false, originRef: "deadbeef" }))!;
  assert.ok(ctx);
  // Pin verilmişse tek aday odur. Sessizce origin/HEAD'e düşmek daha beter
  // olurdu: ölçüm pin'li sanılırken aslında bugünkü uca karşı koşardı ve
  // altın set sonucu sessizce yanlış çıkardı. null = "denetlenecek uzak uç yok".
  assert.equal(ctx.originRef, null);
});

// ─── Dalga B: pathspec literal olarak geçer (git-pathspec-injection) ──────────

test("pathspec LİTERAL: glob şekilli çapa var olan dosyayla eşleşmez", async () => {
  // Probe terfisi: model-pathspec-wildcard.sh. Git varsayılan olarak pathspec'te
  // glob uyguluyordu: `src/?.ts` `ls-tree`de bulunamayıp `log --diff-filter=A`da
  // eşleşiyor → `missing_now`, DURUM kalıbıyla 0,7 suspect. Var olmayan bir yol
  // gerçek bir notu şüpheliye çeviriyordu.
  const ctx = (await openGit(repo, { fetch: false }))!;
  const kotu = [
    "src/?.ts",       // orijinal repro sınıfı (tek karakter joker)
    "src/*.ts",       // SINIF KAPANIŞI: yıldız
    "src/[ab].ts",    // SINIF KAPANIŞI: köşeli parantez sınıfı
    ":(glob)**/a.ts", // SINIF KAPANIŞI: pathspec sihri
  ];
  for (const path of kotu) {
    assert.deepEqual(await fileExistsAt(ctx, "HEAD", path), no, `ls-tree glob açtı: ${path}`);
    assert.deepEqual(await fileEverExisted(ctx, path), no, `log glob açtı: ${path}`);
    assert.deepEqual(await commitsTouching(ctx, "HEAD", path, "2000-01-01T00:00:00Z"), { ok: true, value: 0 },
      `rev-list glob açtı: ${path}`);
  }
  // Gerçek yol etkilenmiyor: bayrak yalnız glob'u kapatıyor.
  assert.deepEqual(await fileExistsAt(ctx, "HEAD", "src/a.ts"), yes);
});

test("pathspec LİTERAL: adında glob karakteri OLAN gerçek dosya doğru ölçülür", async () => {
  // Sonek çözümlemesinin ikinci ölçümü `filesMatchingSuffix`in bulduğu GERÇEK
  // yolu yeniden ölçüyor; o yolda `[`/`]` varsa kaçışsız gitmesi kusurdu.
  const r2 = realpathSync(tmpDir("cp-git-glob-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", r2, ...a], { encoding: "utf8" }).trim();
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  mkdirSync(join(r2, "src"));
  writeFileSync(join(r2, "src", "a[1].ts"), "export const x = 1;\n");
  writeFileSync(join(r2, "src", "ab.ts"), "export const y = 2;\n");
  g("add", "-A"); g("commit", "-qm", "ilk");

  const ctx = (await openGit(r2, { fetch: false }))!;
  // Literal: kendi adıyla BULUNUR (glob olsaydı `a[1].ts` yalnız `a1.ts` ile eşleşirdi).
  assert.deepEqual(await fileExistsAt(ctx, "HEAD", "src/a[1].ts"), yes);
  assert.deepEqual(await fileEverExisted(ctx, "src/a[1].ts"), yes);
  assert.deepEqual(await commitsTouching(ctx, "HEAD", "src/a[1].ts", "2000-01-01T00:00:00Z"), { ok: true, value: 1 });
  // Ve KOMŞUSUNU yutmuyor: `src/[ab].ts` glob'u `ab.ts`ye denk gelmemeli.
  assert.deepEqual(await fileExistsAt(ctx, "HEAD", "src/[ab].ts"), no);
});
