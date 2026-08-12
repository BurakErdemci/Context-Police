import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpDir } from "./helpers.ts";
import { openGit } from "../src/signals/git.ts";
import {
  checkAnchors, scoreDrift, SUSPICION_THRESHOLD,
  NEVER_EXISTED_CAP, BORN_INVALID_MIN_RESOLVED, BORN_INVALID_WEIGHT,
  type AnchorVerdict,
} from "../src/signals/anchor-drift.ts";

const v = (state: AnchorVerdict["state"], extra: Partial<AnchorVerdict> = {}): AnchorVerdict =>
  ({ anchor: { kind: "file_path", value: "x.ts" }, state, ...extra });

test("ağırlıklar D-M3-4: tekil durumlar", () => {
  assert.equal(scoreDrift([v("missing_now")], false).score, 0.5);
  assert.equal(scoreDrift([v("symbol_lost")], false).score, 0.4);
  assert.equal(scoreDrift([v("never_existed")], false).score, 0.3);
  assert.equal(scoreDrift([v("churned", { commits: 3 })], false).score, 0.2);
  assert.equal(scoreDrift([v("churned", { commits: 12 })], false).score, 0.3);
  assert.equal(scoreDrift([v("ok", { commits: 1 })], false).score, 0);
  assert.equal(scoreDrift([v("unverifiable")], false).score, 0); // aşırı-üretim suçlanmaz (D-M3-2)
});

test("DURUM-kalıbı: tek başına eşik ALTINDA, çapa hareketiyle eşiğin ÜSTÜNDE (M0-D1)", () => {
  const alone = scoreDrift([v("ok", { commits: 0 })], true);
  assert.ok(alone.score < SUSPICION_THRESHOLD);
  const withMove = scoreDrift([v("churned", { commits: 3 })], true);
  assert.ok(withMove.score >= 0.7, `beklenen ≥0.7, gelen ${withMove.score}`);
  const withLoss = scoreDrift([v("missing_now")], true);
  assert.ok(withLoss.score >= 0.7);
});

test("skor 1.0'da kapaklanır ve reasons her katkıyı sayar", () => {
  const r = scoreDrift([v("missing_now"), v("missing_now"), v("symbol_lost")], true);
  assert.equal(r.score, 1);
  assert.ok(r.reasons.length >= 3);
});

// --- 2. tur ölçümünün üç aritmetik düzeltmesi -------------------------------
// Kaynak: docs/olcumler/2026-08-12-m3-altin-set-olcumu-r2.md §8.2, §8.3, §6.1.

test("never_existed toplamı 0,5'te kırpılır: tek sınıf tek başına eşiği delemez (r2 §8.2)", () => {
  const iki = scoreDrift([v("never_existed"), v("never_existed")], false);
  assert.equal(iki.score, NEVER_EXISTED_CAP);
  assert.ok(iki.score < SUSPICION_THRESHOLD, `iki never_existed eşiği deldi: ${iki.score}`);
  assert.ok(iki.reasons.some((r) => r.includes("kırpıldı")),
    `kırpma sessiz kaldı: ${JSON.stringify(iki.reasons)}`);

  // Üç çapa da aynı sınıftan: kırpma sürüyor, skor 0,9 değil 0,5.
  const uc = scoreDrift([v("never_existed"), v("never_existed"), v("never_existed")], false);
  assert.equal(uc.score, NEVER_EXISTED_CAP);

  // Tek çapa kırpılmaz ve gerekçe üretmez — tavan yalnız gerçekten değdiğinde konuşur.
  const tek = scoreDrift([v("never_existed")], false);
  assert.equal(tek.score, 0.3);
  assert.ok(!tek.reasons.some((r) => r.includes("kırpıldı")));
});

test("kırpma YALNIZ never_existed'a uygulanır: sınıf karışımı tam toplanır", () => {
  // İki bağımsız sınıfın bileşimi eşiği delmeli — kırpılan yalnız kendi sınıfının payı.
  const karisik = scoreDrift([v("never_existed"), v("never_existed"), v("symbol_lost")], false);
  assert.equal(karisik.score, NEVER_EXISTED_CAP + 0.4);
  assert.ok(karisik.score >= SUSPICION_THRESHOLD);
});

test("never_existed artık 'hareket' sayılır: DURUM ile bileşim eşiği aşar (r2 §8.3)", () => {
  // Ölçüm: `windows-acikleri` iki turdur 0,50'de takılıydı (0,3 + DURUM 0,2).
  const d = scoreDrift([v("never_existed")], true);
  assert.ok(d.score >= 0.7, `beklenen ≥0.7, gelen ${d.score}`);
  assert.ok(d.reasons.some((r) => r.includes("M0-D1")),
    `D1 bileşimi ateşlemedi: ${JSON.stringify(d.reasons)}`);
});

test("born_invalid: iki ve üzeri sonek çözümlemesi zayıf sinyal üretir (r2 §6.1 / M0-D2)", () => {
  const ikiCozulmus = scoreDrift([
    v("ok", { resolvedPath: "a/x.ts" }),
    v("ok", { resolvedPath: "b/y.ts" }),
  ], false);
  assert.equal(ikiCozulmus.score, BORN_INVALID_WEIGHT);
  assert.ok(ikiCozulmus.reasons.some((r) => r.includes("born_invalid")),
    `gerekçe yok: ${JSON.stringify(ikiCozulmus.reasons)}`);

  // Tek çözülme sinyal DEĞİL: elle yazılmış notta kısaltma meşru.
  const tekCozulmus = scoreDrift([v("ok", { resolvedPath: "a/x.ts" })], false);
  assert.equal(tekCozulmus.score, 0);
  assert.ok(!tekCozulmus.reasons.some((r) => r.includes("born_invalid")));
  assert.equal(BORN_INVALID_MIN_RESOLVED, 2);
});

test("born_invalid + never_existed + DURUM eşiği deler (custom-tools-cs-eksik şekli)", () => {
  const d = scoreDrift([
    v("ok", { resolvedPath: "unity-mcp/Server/src/services/tools/execute_custom_tool.py" }),
    v("ok", { resolvedPath: "unity-mcp/MCPForUnity/Editor/Constants/EditorPrefKeys.cs" }),
    v("never_existed"),
  ], true);
  assert.ok(d.score >= SUSPICION_THRESHOLD, `eşik altında kaldı: ${d.score}`);
  assert.ok(d.reasons.some((r) => r.includes("born_invalid")));
});

test("ref uyuşmazlığında kötü hüküm skoru belirler (M0-D7)", () => {
  // Çalışma ağacında ok, origin'de silinmiş: skor missing_now'dan.
  const d = scoreDrift([v("missing_now", { refDisagreement: { head: "ok", origin: "missing_now" } })], false);
  assert.equal(d.score, 0.5);
  assert.ok(d.reasons[0]!.includes("origin"));
});

// --- checkAnchors: gerçek geçici repo ---------------------------------------
// Fixture git-signals.test.ts'ten KOPYALANDI, paylaşılmadı: test dosyaları
// birbirinin kurulumuna bağlanmaz. Tek sapma, üçüncü bir a.ts dokunuşu —
// churn eşiği (>=3) yalnız burada ölçülüyor.

let repo: string;
let clone: string;
let firstSha: string;
const EPOCH = "1970-01-01T00:00:00Z";

before(() => {
  // realpathSync şart: macOS'ta $TMPDIR bir sembolik bağ (/var → /private/var) ve
  // `git rev-parse --show-toplevel` bağı çözerek döner.
  repo = realpathSync(tmpDir("cp-drift-"));
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
  // Üçüncü a.ts dokunuşu: churn sayacı 3'e çıkar (ok → churned sınırı).
  writeFileSync(join(repo, "src", "a.ts"), "export function yeniSembol() {}\nexport const y = 2;\n");
  git("add", "-A"); git("commit", "-qm", "a.ts üçüncü dokunuş");

  // Origin'li fixture: YEREL klon (dosya yolu, ağ yok). refDisagreement dalı
  // yalnız originRef doluyken koşuyor; origin'siz repoda hiç ölçülmemiş olurdu.
  clone = realpathSync(tmpDir("cp-drift-clone-"));
  execFileSync("git", ["clone", "-q", repo, clone], { encoding: "utf8" });
});

test("checkAnchors: silinen dosya missing_now, hayalet yol never_existed, kayıp sembol symbol_lost", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  const verdicts = await checkAnchors(ctx, [
    { kind: "file_path", value: "src/b.ts" },
    { kind: "file_path", value: "src/hayalet.ts" },
    { kind: "symbol", value: "eskiSembol" },
    { kind: "symbol", value: "hayaletSembol" },
    { kind: "external_path", value: "~/.x/y.json" },
  ], EPOCH);
  assert.deepEqual(verdicts.map((x) => x.state),
    ["missing_now", "never_existed", "symbol_lost", "unverifiable", "unverifiable"]);
  // Borcun kapandığı yer: iki "yok" farklı skor üretiyor, uydurma çapa ucuz.
  assert.equal(scoreDrift([verdicts[0]!], false).score, 0.5);
  assert.equal(scoreDrift([verdicts[1]!], false).score, 0.3);
  assert.equal(scoreDrift([verdicts[3]!], false).score, 0); // hiç izi yok → suçlama yok
});

test("checkAnchors: churn sayılır, var olan sha ok, olmayan sha unverifiable", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  const verdicts = await checkAnchors(ctx, [
    { kind: "file_path", value: "src/a.ts" },
    { kind: "commit_sha", value: firstSha },
    { kind: "commit_sha", value: "deadbeef" },
  ], EPOCH);
  assert.deepEqual(verdicts.map((x) => x.state), ["churned", "ok", "unverifiable"]);
  assert.equal(verdicts[0]!.commits, 3);
  // sinceIso gerçekten pencere açıyor: geleceğe kurulan pencerede churn sıfır,
  // dosya duruyor → ok. Sabit EPOCH ile aynı cevap gelseydi test churn'ü ölçmezdi.
  const gelecek = new Date(Date.now() + 86_400_000).toISOString();
  const sonra = await checkAnchors(ctx, [{ kind: "file_path", value: "src/a.ts" }], gelecek);
  assert.equal(sonra[0]!.state, "ok");
  assert.equal(sonra[0]!.commits, 0);
});

// --- sonek çözümlemesi (altın set §5.2) -------------------------------------
// Ölçüm: 15 `never_existed` hükmünün 10'u repoda GERÇEKTEN duran dosyalardı;
// not yolu kısa yazılmıştı (`./build_backend.sh` ↔ `Backend/build_backend.sh`).
// İki `never_existed` 0,3+0,3 = 0,60 ile eşiğe tam oturuyor: ölçümün İKİ yanlış
// alarmı da bu mekanizmadan çıktı. Kendi fikstürü var — üstteki repoya dosya
// eklemek oradaki churn sayılarını sessizce kaydırırdı.

let sufRepo: string;

before(() => {
  sufRepo = realpathSync(tmpDir("cp-suffix-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", sufRepo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(sufRepo, "Backend"));
  mkdirSync(join(sufRepo, "A")); mkdirSync(join(sufRepo, "B"));
  writeFileSync(join(sufRepo, "Backend", "build_backend.sh"), "#!/bin/sh\necho 1\n");
  writeFileSync(join(sufRepo, "A", "dup.ts"), "export const a = 1;\n");
  writeFileSync(join(sufRepo, "B", "dup.ts"), "export const b = 1;\n");
  git("add", "-A"); git("commit", "-qm", "ilk");
  // Çözülen yolun churn'ü de gerçekten yeniden ölçülmeli: iki dokunuş daha,
  // toplam 3 → `churned` sınırı.
  for (const n of [2, 3]) {
    writeFileSync(join(sufRepo, "Backend", "build_backend.sh"), `#!/bin/sh\necho ${n}\n`);
    git("add", "-A"); git("commit", "-qm", `dokunuş ${n}`);
  }
});

test("checkAnchors: tek eşleşen kısa yol çözülür ve akış çözülmüş yolla yeniden koşar", async () => {
  const ctx = (await openGit(sufRepo, { fetch: false }))!;
  const [v0] = await checkAnchors(ctx, [{ kind: "file_path", value: "./build_backend.sh" }], EPOCH);
  // Eski davranış: never_existed (0,3). Yeni: gerçek dosya bulundu, churn ölçüldü.
  assert.equal(v0!.state, "churned");
  assert.equal(v0!.resolvedPath, "Backend/build_backend.sh");
  assert.equal(v0!.commits, 3);
  assert.equal(scoreDrift([v0!], false).score, 0.2); // never_existed'ın 0,3'ü değil
});

test("checkAnchors: çok eşleşme unverifiable, sıfır eşleşme gerçek never_existed", async () => {
  const ctx = (await openGit(sufRepo, { fetch: false }))!;
  const verdicts = await checkAnchors(ctx, [
    { kind: "file_path", value: "dup.ts" },       // A/ ve B/ — hangisi kastedildi ölçülemez
    { kind: "file_path", value: "yok/hic.ts" },   // gerçekten hiç yok
  ], EPOCH);
  assert.deepEqual(verdicts.map((x) => x.state), ["unverifiable", "never_existed"]);
  assert.equal(verdicts[0]!.resolvedPath, undefined);
  assert.equal(scoreDrift([verdicts[0]!], false).score, 0); // belirsizlik suçlama değil
  assert.equal(scoreDrift([verdicts[1]!], false).score, 0.3);
});

test("checkAnchors: çözümleme silinmiş dosyayı never_existed'a çevirmez", async () => {
  // missing_now (0,5) sonek yoluna hiç girmez: yalnız never_existed adayı ödüyor.
  const ctx = (await openGit(repo, { fetch: false }))!;
  const [v0] = await checkAnchors(ctx, [{ kind: "file_path", value: "src/b.ts" }], EPOCH);
  assert.equal(v0!.state, "missing_now");
  assert.equal(v0!.resolvedPath, undefined);
});

test("checkAnchors: origin ile çalışma ağacı çelişirse kötü hüküm kazanır (M0-D7 / D-M3-5)", async () => {
  // Klona yerel bir commit: dosya HEAD'de var, origin'de yok.
  const git = (...a: string[]) => execFileSync("git", ["-C", clone, ...a], { encoding: "utf8" }).trim();
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(clone, "src", "yerel.ts"), "export const z = 3;\n");
  git("add", "-A"); git("commit", "-qm", "yalnız yerelde");

  const ctx = (await openGit(clone, { fetch: false }))!;
  assert.notEqual(ctx.originRef, null); // origin dalının gerçekten koştuğunun kanıtı
  const [verdict] = await checkAnchors(ctx, [{ kind: "file_path", value: "src/yerel.ts" }], EPOCH);
  assert.equal(verdict!.state, "missing_now"); // ok(HEAD) vs missing_now(origin) → kötüsü
  assert.deepEqual(verdict!.refDisagreement, { head: "ok", origin: "missing_now" });
  const d = scoreDrift([verdict!], false);
  assert.equal(d.score, 0.5);
  assert.ok(d.reasons[0]!.includes("origin"), d.reasons[0]!);
});
