// Dalga C: karar bütünlüğü. Dört bulgunun da ortak kökü aynı — ürünün TEK
// çıktısı bir hüküm ("bu not suspect"), ve aşağıdaki dört yol o hükmü ölçüme
// dayanmadan üretiyor ya da ölçüm yapılamadığı hâlde AKLAMA üretiyordu.
//
// Kaynak probe'lar (denetim koşumu 2026-08-12):
//   classify-failure-clears-suspect.sh   → §1
//   suffix-index-double-count.sh         → §2
//   incomplete-classification-clean.sh   → §3
//   git-process-fanout.sh                → §4

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { auditProject } from "../src/audit.ts";
import { listActive } from "../src/store/findings.ts";
import { listEvents } from "../src/store/events.ts";
import {
  scoreDrift, checkAnchors, createGitBudget, GIT_BUDGET_BASE, GIT_BUDGET_PER_ANCHOR,
  SUSPICION_THRESHOLD, type AnchorVerdict,
} from "../src/signals/anchor-drift.ts";
import { classifyCandidates, parseClassifyOutput } from "../src/signals/classify.ts";
import type { Candidate, NoteView } from "../src/signals/contradiction.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";

const v = (state: AnchorVerdict["state"], extra: Partial<AnchorVerdict> = {}): AnchorVerdict =>
  ({ anchor: { kind: "file_path", value: "x.ts" }, state, ...extra });
const note = (findingId: number, content: string, description: string | null = null): NoteView =>
  ({ findingId, content, anchors: [], description, hasStatus: false });
const cand = (aId: number, bId: number | null, kind: Candidate["kind"] = "cross"): Candidate =>
  ({ kind, aId, bId, reason: "test" });

/** Olay detayı depoda JSON dizesi olarak duruyor. */
const detailOf = (e: { detail: string | null }): Record<string, unknown> =>
  e.detail === null ? {} : (JSON.parse(e.detail) as Record<string, unknown>);

let repo: string;
before(() => {
  repo = tmpDir("cp-decision-");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "live.ts"), "export const live = 1;\n");
  writeFileSync(join(repo, "src", "other.ts"), "export const other = 1;\n");
  git("add", "-A"); git("commit", "-qm", "ilk");
});

function setup(memory: Record<string, string>) {
  const memoryDir = tmpDir("cp-decision-mem-");
  for (const [name, content] of Object.entries(memory)) writeFileSync(join(memoryDir, name), content);
  const store = openStore(":memory:");
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    repo, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  return { store, project: { id, path: repo, memoryDir } };
}

/** Çelişki üreten tek not: description ↔ gövde (frontmatter yüzeyi). */
const CELISKILI = "---\nname: teslim\ndescription: teslim A ile yapılıyor\n---\n" +
  "Teslim B ile yapılıyor. `src/live.ts` duruyor.\n";

// --- §1 measurement-failure-treated-clean ----------------------------------
// Ölçüm arızası suçlamaya dönmez — ama AKLAMAYA da dönmemeli. Sınıflama
// koşamadıysa çelişki boyutu bu koşumda YOK, "temiz çıktı" değil.

test("§1 sınıflama yürütücüsü çökünce çelişkiden gelen suspect KORUNUR", async () => {
  const { store, project } = setup({ "teslim.md": CELISKILI });
  const okExec = fakeExecutor([{ output: '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"A vs B"}]}' }]);
  await auditProject(store, project, { executor: okExec, fetch: false });
  const before = listActive(store, project.id)[0]!;
  assert.equal(before.status, "suspect", "kurulum çelişki suspect'i üretmedi");

  const sum = await auditProject(store, project, {
    executor: fakeExecutor([{ ok: false, error: "offline" }, { ok: false, error: "offline" }]),
    fetch: false,
  });
  const after = listActive(store, project.id)[0]!;
  assert.equal(sum.classified, false);
  assert.equal(after.status, "suspect", "ölçülemeyen sınıflama notu akladı");
  assert.ok(after.suspicion >= before.suspicion, `şüphe düştü: ${before.suspicion} → ${after.suspicion}`);
  assert.equal(sum.heldUnmeasured, 1);
  // Görünürlük: "ölçüm yapılamadığı için duruyor" ile "çelişki var" ayırt edilebilmeli.
  const scored = listEvents(store, { projectId: project.id, kind: "signal_scored" });
  assert.ok(scored.some((e) => detailOf(e).heldUnmeasured === true), "korunan hüküm olayda görünmüyor");
  store.close();
});

test("§1 varyant A: sınıflama BAŞARILI ama boş hüküm döndü — yine aklamaz", async () => {
  const { store, project } = setup({ "teslim.md": CELISKILI });
  await auditProject(store, project, {
    executor: fakeExecutor([{ output: '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"A vs B"}]}' }]),
    fetch: false,
  });
  assert.equal(listActive(store, project.id)[0]!.status, "suspect");

  // ok=true, şema geçerli, ama HİÇBİR aday için hüküm yok: "sınıflandı, temiz
  // çıktı" DEĞİL "karar verilmedi". Probe'un kullanmadığı biçim.
  const sum = await auditProject(store, project, {
    executor: fakeExecutor([{ output: '{"verdicts":[]}' }]), fetch: false,
  });
  assert.equal(sum.classified, true);
  assert.ok(sum.classifyUnclassified > 0, "kararsız kalan aday sayılmadı");
  assert.equal(listActive(store, project.id)[0]!.status, "suspect", "boş hüküm notu akladı");
  store.close();
});

test("§1 varyant B: çelişkiye HİÇ girmemiş not, sınıflama çökse de normal temizlenir", async () => {
  // Not çapasız + description'sız → hiçbir aday üretmiyor. Şüphesi yalnız elle
  // konmuş; sınıflama arızası bu notu dondurmamalı (aşırı-koruma da bir kusur).
  const { store, project } = setup({
    "temiz.md": "---\nname: temiz\n---\nKarar: seam gün bir. `src/other.ts` duruyor.\n",
    "aday.md": CELISKILI,
  });
  await auditProject(store, project, { executor: fakeExecutor([{ output: '{"verdicts":[]}' }]), fetch: false });
  const temiz = listActive(store, project.id).find((f) => f.content.includes("seam gün bir"))!;
  store.run("UPDATE findings SET status='suspect', suspicion=0.9 WHERE id=?", temiz.id);

  const sum = await auditProject(store, project, {
    executor: fakeExecutor([{ ok: false, error: "offline" }, { ok: false, error: "offline" }]), fetch: false,
  });
  const after = listActive(store, project.id).find((f) => f.id === temiz.id)!;
  assert.equal(after.status, "active", "aday olmayan not gereksiz yere donduruldu");
  assert.equal(sum.cleared, 1);
  store.close();
});

// --- §2 correlated-signal-double-count -------------------------------------
// Tek olgu iki "bağımsız" sinyal sınıfı üretemez (4fa874d'nin tavan gerekçesi).

test("§2 çözümleme sonrası hâlâ never_existed olan çapa born_invalid saymaz", () => {
  const r = scoreDrift([
    v("never_existed", { resolvedPath: "pkg/one.ts" }),
    v("never_existed", { resolvedPath: "pkg/two.ts" }),
  ], false);
  // 0,3+0,3 → 0,5 tavanı. born_invalid EKLENMEZ, yoksa 0,7 ile tek sınıf mahkûm ederdi.
  assert.equal(r.score, 0.5);
  assert.ok(r.score < SUSPICION_THRESHOLD, `çift sayım eşiği deldi: ${r.score}`);
  // Çözümleme yine de GÖRÜNÜR: hangi yolun ölçüldüğü sessiz varsayım olamaz.
  assert.ok(r.reasons.some((x) => x.includes("sonek çözümlendi")));
});

test("§2 varyant A: gerçekten çözülmüş iki çapa born_invalid'i hâlâ ateşler", () => {
  const r = scoreDrift([
    v("ok", { resolvedPath: "pkg/one.ts" }),
    v("ok", { resolvedPath: "pkg/two.ts" }),
  ], false);
  assert.equal(r.score, 0.2, "born_invalid zayıf sinyali kayboldu (r3 §6.1 geriye gitti)");
});

test("§2 varyant B: karışık — biri çözüldü biri çözülemedi, eşik 2 dolmaz", () => {
  const r = scoreDrift([
    v("ok", { resolvedPath: "pkg/one.ts" }),
    v("never_existed", { resolvedPath: "pkg/two.ts" }),
  ], false);
  // Gerçek çözüm sayısı 1 → born_invalid yok. Kalan tek katkı never_existed 0,3.
  assert.equal(r.score, 0.3);
});

// --- §3 incomplete-decision-accepted ---------------------------------------

test("§3 hüküm dönmeyen aday 'temiz' sayılmaz, unclassified olarak görünür", async () => {
  const notes = new Map([[1, note(1, "A")], [2, note(2, "A değil")], [3, note(3, "B")], [4, note(4, "B değil")]]);
  const r = await classifyCandidates(
    fakeExecutor([{ output: '{"verdicts":[{"index":0,"verdict":"uyumlu","evidence":"yalnız ilki"}]}' }]),
    [cand(1, 2), cand(3, 4)], notes,
  );
  assert.equal(r.ok, true);
  assert.equal(r.unclassified, 1, "eksik hüküm sessizce yutuldu");
  assert.deepEqual(r.unmeasured.map((c) => c.aId), [3]);
});

test("§3 varyant A: prompt'ta GÖSTERİLMEMİŞ index reddedilir", async () => {
  // aday 0'ın B notu haritada YOK → renderItems onu atlar, prompt'ta yalnız
  // aday 1 görünür. Model 0 döndürürse gösterilmemiş bir adaya hüküm bağlanır.
  const notes = new Map([[1, note(1, "A")], [3, note(3, "B")], [4, note(4, "B değil")]]);
  const r = await classifyCandidates(
    fakeExecutor([{ output: '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"görülmedi"}]}' }]),
    [cand(1, 2), cand(3, 4)], notes,
  );
  assert.equal(r.ok, true);
  assert.equal(r.confirmed.length, 0, "gösterilmemiş aday çelişki ilan edildi");
  assert.equal(r.unclassified, 2, "atlanan + hükümsüz aday sayılmadı");
});

test("§3 varyant B: parseClassifyOutput sınırı GÖSTERİLEN index kümesidir", () => {
  const raw = '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"e"},{"index":1,"verdict":"celiski","evidence":"e"}]}';
  const r = parseClassifyOutput(raw, new Set([1]));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.verdicts.map((x) => x.index), [1]);
});

// --- §4 unbounded-subprocess-fanout ----------------------------------------

test("§4 bütçe dolunca kalan çapalar ölçülmez ve SUÇLANMAZ", async () => {
  const { store, project } = setup({});
  const id = Number(store.run(
    "INSERT INTO findings (project_id, source, content, created_at, status) VALUES (?,?,?,?,?)",
    project.id, "observed", "on altı kısa yol", new Date().toISOString(), "active",
  ).lastInsertRowid);
  for (let i = 0; i < 16; i++)
    store.run("INSERT INTO anchors (finding_id, kind, value) VALUES (?,?,?)", id, "file_path", `yok${i}.ts`);

  const sum = await auditProject(store, project, { executor: null, fetch: false, maxGitCalls: 6 });
  assert.ok(sum.budgetExhaustedAnchors > 0, "bütçe hiç ısırmadı");
  // Bütçe bir HÜKÜM değil bilgisizlik: ölçülmemiş çapa unverifiable, ağırlık 0.
  assert.equal(listActive(store, project.id)[0]!.status, "active");
  assert.ok(sum.anchorStates.unverifiable >= sum.budgetExhaustedAnchors);
  assert.equal(sum.measurementFailures, 0, "bütçe tükenişi ARIZA gibi raporlandı");
  const ev = listEvents(store, { projectId: project.id, kind: "anchor_signal_disabled" });
  assert.ok(ev.some((e) => detailOf(e).reason === "git_budget_exhausted"),
    "bütçe tükenişi görünür bir olay yazmadı");
  store.close();
});

test("§4 varyant A: gerçekçi bütçe ısırmaz — ölçülen 548 çağrı/260 çapa payı", () => {
  // ÖLÇÜM (2026-08-12, gerçek 28 notluk altın-set silosu): 548 git süreci /
  // 260 çapa = 2,11. Bütçe formülü çapa başına 3 veriyor, yani ~%42 pay.
  const b = createGitBudget(260);
  assert.equal(b.limit, GIT_BUDGET_BASE + 260 * GIT_BUDGET_PER_ANCHOR);
  assert.ok(b.limit > 548, `ölçülen gerçek koşum bütçeyi aşıyor: ${b.limit} < 548`);
  // Tek patolojik not (16 çapa × en kötü 9 = 144 süreç) koşumu yutamaz.
  assert.ok(createGitBudget(16).limit < 100, "tek notluk patolojik koşum hâlâ sınırsız");
});

test("§4 varyant B: bütçe verilmezse davranış aynen korunur (null = sınırsız)", async () => {
  const ctx = { repoRoot: repo, head: "HEAD", originRef: null };
  const anchors = [{ kind: "file_path" as const, value: "src/live.ts" }];
  const free = await checkAnchors(ctx, anchors, "1970-01-01T00:00:00.000Z");
  const budgeted = await checkAnchors(ctx, anchors, "1970-01-01T00:00:00.000Z", createGitBudget(1));
  assert.equal(free[0]!.state, "ok");
  assert.equal(budgeted[0]!.state, "ok");
});
