// D dalgası (12 Ağu 2026 doğrulama turu): ÖNCEKİ düzeltmelerin kendi getirdiği
// kusur. Probe ana ağaca karşı rc=1 ölçüldü; buradaki testler o probe'un terfi
// edilmiş hâli + sınıf kapanışı varyantları.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { appendFinding, getFinding } from "../src/store/findings.ts";
import { auditProject } from "../src/audit.ts";
import { fakeExecutor, tmpDir } from "./helpers.ts";

// --- 1) git bütçesi tükenmesi var olan hükmü AKLAYAMAZ -------------------------

/** victim.ts eklenip SİLİNMİŞ bir repo: tek başına 0,5'lik missing_now sinyali. */
function victimRepo(): string {
  const repo = tmpDir("cp-wave-d-repo-");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(repo, "victim.ts"), "export const victim = 1;\n");
  git("add", "-A"); git("commit", "-qm", "victim eklendi");
  unlinkSync(join(repo, "victim.ts"));
  git("add", "-A"); git("commit", "-qm", "victim silindi");
  return repo;
}

interface BudgetCase {
  status?: "active" | "suspect";
  suspicion?: number;
  maxGitCalls?: number;
  anchors?: { kind: "file_path"; value: string }[];
  /**
   * Varsayılan `null` — bu dosyanın konusu ÇAPA boyutu, sınıflandırıcı sadece
   * iskele. Ama yürütücüsüz koşum artık çelişki boyutunu "hiç kimse için
   * ölçülmedi" sayıp şüpheyi donduruyor (16 Ağu denetim bulgusu), yani
   * TEMİZLEMEYİ sınayan vaka iskele yüzünden ikinci bir boyuta takılıyordu.
   * O vaka gerçek bir yürütücü veriyor; iddiası değişmiyor, yalnız ölçtüğü
   * boyut tek kalıyor.
   */
  executor?: Parameters<typeof auditProject>[2]["executor"];
}

async function budgetRun(repo: string, c: BudgetCase) {
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    repo, "probe", "/t",
  ).lastInsertRowid);
  const anchors = c.anchors ?? [
    ...Array.from({ length: 15 }, (_, i) => ({ kind: "file_path" as const, value: `never-${i}.ts` })),
    { kind: "file_path" as const, value: "victim.ts" },
  ];
  const findingId = appendFinding(store, {
    projectId, source: "observed", content: "bütçe sırası probe'u", anchors,
    status: c.status ?? "suspect", createdAt: "2000-01-01T00:00:00.000Z",
  });
  store.run("UPDATE findings SET suspicion = ? WHERE id = ?", c.suspicion ?? 0.9, findingId);
  const summary = await auditProject(store, { id: projectId, path: repo, memoryDir: null }, {
    executor: c.executor ?? null, fetch: false, originRef: "HEAD",
    ...(c.maxGitCalls === undefined ? {} : { maxGitCalls: c.maxGitCalls }),
  });
  const after = getFinding(store, findingId)!;
  store.close();
  return { summary, after };
}

test("git bütçesi tükendiğinde ölçülmemiş çapa var olan suspect'i AKLAYAMAZ", async () => {
  const repo = victimRepo();
  // Kontrol: bütçe bol → victim.ts ölçülüyor, hüküm gerçekten suspect.
  const bol = await budgetRun(repo, { maxGitCalls: 1000 });
  assert.equal(bol.after.status, "suspect", "kontrol koşumu senaryoyu kurmuyor");
  assert.equal(bol.summary.budgetExhaustedAnchors, 0);

  // Varsayılan bütçe: son çapalar hiç ölçülmüyor. Ölçülmeyen kanıt AKLAMA olamaz.
  const dar = await budgetRun(repo, {});
  assert.ok(dar.summary.budgetExhaustedAnchors > 0, "senaryo kurulmadı: bütçe tükenmedi");
  assert.equal(dar.after.status, "suspect", "ölçülmeyen çapa yolu eski hükmü temizledi");
  assert.equal(dar.summary.heldUnmeasured, 1);
  assert.ok(dar.after.suspicion >= 0.9, "korunan hüküm skoru da korumalı");
});

test("varyant: bütçe tükendi ama not zaten active — koruma yeni suçlama UYDURMUYOR", async () => {
  const repo = victimRepo();
  const r = await budgetRun(repo, { status: "active", suspicion: 0 });
  assert.ok(r.summary.budgetExhaustedAnchors > 0);
  assert.equal(r.after.status, "active", "ölçülemeyen çapa suçlamaya çevrildi");
  assert.equal(r.summary.heldUnmeasured, 0);
});

test("varyant: bütçe tükenmedi — normal temizleme HÂLÂ çalışıyor", async () => {
  const repo = victimRepo();
  // Tek, DURAN bir çapa: skor 0, dolayısıyla eski suspect temizlenmeli.
  writeFileSync(join(repo, "duran.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-qm", "duran"], { stdio: "ignore" });
  const r = await budgetRun(repo, {
    anchors: [{ kind: "file_path", value: "duran.ts" }],
    // Sınıflandırıcı KOŞSUN: yoksa çelişki boyutu ölçülmemiş sayılır ve
    // şüphe donar — bu testin ölçtüğü çapa temizlemesine hiç sıra gelmez.
    executor: fakeExecutor([{ output: '{"verdicts":[]}' }]),
  });
  assert.equal(r.summary.budgetExhaustedAnchors, 0);
  assert.equal(r.after.status, "active", "ölçüm yapıldı ve temiz çıktı: temizleme koşmalı");
  assert.equal(r.summary.cleared, 1);
});
