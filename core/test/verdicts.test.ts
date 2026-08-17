// M5: the verdict table — where an adjudication outcome, its evidence and its
// suggested correction wait for the user's approval (spec §3.2, K9).
//
// Every test here exercises BEHAVIOUR through the store/audit API or through the
// schema's own guards; none of them reads source text.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../src/store/db.ts";
import { auditProject } from "../src/audit.ts";
import { appendFinding, listActive, getFinding, setSuspicion, markSuspect } from "../src/store/findings.ts";
import { listEvents } from "../src/store/events.ts";
import {
  recordVerdict, getVerdict, getLiveVerdict, listPendingVerdicts, listVerdictHistory, reviewVerdict,
} from "../src/store/verdicts.ts";
import { fakeExecutor, tmpDir, tmpStorePath } from "./helpers.ts";

// --- store API ----------------------------------------------------------------

function seed() {
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(store, {
    projectId, source: "imported", content: "DURUM: eski", sourceRef: "n.md",
    anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });
  return { store, projectId, findingId };
}

test("hüküm üç şeyi de taşıyor: hüküm, kanıt ve düzeltme metni", () => {
  const { store, projectId, findingId } = seed();
  const { id, recorded } = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi",
    evidence: "missing_now: src/a.ts", method: "anchor-drift (git)",
    correction: "DURUM: iş bitti, dosya kaldırıldı.",
    source: "adjudicator", runId: "r1",
  });
  assert.equal(recorded, true);

  const live = getLiveVerdict(store, findingId)!;
  assert.equal(live.id, id);
  assert.equal(live.verdict, "curuk");
  assert.equal(live.evidence, "missing_now: src/a.ts");
  assert.equal(live.correction, "DURUM: iş bitti, dosya kaldırıldı.", "düzeltme metni satırın var olma sebebi");
  assert.equal(live.review, "pending");
  assert.equal(live.supersededBy, null);
  store.close();
});

test("olculemez alt-sebebi taşıyabiliyor — kullanıcının çözebileceği hâl temsil edilebilir", () => {
  const { store, projectId, findingId } = seed();
  recordVerdict(store, {
    projectId, findingId, verdict: "olculemez", subReason: "user-resolvable",
    evidence: "iddia bir tercihe atıf yapıyor; depoda ölçülebilir karşılığı yok",
    source: "adjudicator", runId: "r1",
  });
  const live = getLiveVerdict(store, findingId)!;
  assert.equal(live.verdict, "olculemez");
  assert.equal(live.subReason, "user-resolvable");
  store.close();
});

test("yeni hüküm eskisini supersede eder; eski satır kanıtıyla birlikte OKUNABİLİR kalır", () => {
  const { store, projectId, findingId } = seed();
  const first = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi",
    evidence: "missing_now: src/a.ts", correction: "ilk öneri", source: "mechanical", runId: "r1",
  }).id;
  const second = recordVerdict(store, {
    projectId, findingId, verdict: "dogustan-yanlis",
    evidence: "never_existed: src/a.ts", correction: "ikinci öneri", source: "adjudicator", runId: "r2",
  });
  assert.equal(second.recorded, true);
  assert.equal(second.supersededId, first);

  const old = getVerdict(store, first)!;
  assert.equal(old.supersededBy, second.id);
  assert.equal(old.verdict, "curuk", "supersede eski hükmü SİLMEZ");
  assert.equal(old.correction, "ilk öneri");
  assert.equal(getLiveVerdict(store, findingId)!.id, second.id);

  const history = listVerdictHistory(store, findingId);
  assert.deepEqual(history.map((v) => v.id), [first, second.id], "geçmiş eskiden yeniye okunur");
  store.close();
});

test("aynı sonuç ikinci kez kaydedilmez; reddedilmiş hüküm yeniden onaya düşmez", () => {
  const { store, projectId, findingId } = seed();
  const input = {
    projectId, findingId, verdict: "curuk" as const, decayType: "dosya-silindi",
    evidence: "missing_now: src/a.ts", source: "mechanical" as const, runId: "r1",
  };
  const first = recordVerdict(store, input).id;
  assert.equal(reviewVerdict(store, first, "rejected"), true);

  const again = recordVerdict(store, { ...input, runId: "r2", method: "başka bir ölçüm yolu" });
  assert.equal(again.recorded, false, "değişmeyen sonuç satır açmamalı");
  assert.equal(again.id, first);
  assert.equal(listVerdictHistory(store, findingId).length, 1);
  assert.equal(getVerdict(store, first)!.review, "rejected", "reddedilen hüküm yeniden pending olmamalı");
  store.close();
});

test("onay kuyruğu yalnız canlı ve incelenmemiş hükümleri gösterir", () => {
  const { store, projectId, findingId } = seed();
  const other = appendFinding(store, {
    projectId, source: "imported", content: "ikinci not", sourceRef: "m.md",
    anchors: [{ kind: "file_path", value: "src/b.ts" }],
  });
  const supersededSoon = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi", evidence: "e1", source: "mechanical", runId: "r1",
  }).id;
  const live = recordVerdict(store, {
    projectId, findingId, verdict: "olculemez", evidence: "e2", source: "mechanical", runId: "r2",
  }).id;
  const approved = recordVerdict(store, {
    projectId, findingId: other, verdict: "curuk", decayType: "dosya-silindi", evidence: "e3",
    source: "adjudicator", runId: "r2",
  }).id;
  reviewVerdict(store, approved, "approved");

  const pending = listPendingVerdicts(store, projectId).map((v) => v.id);
  assert.deepEqual(pending, [live]);
  assert.ok(!pending.includes(supersededSoon), "supersede edilmiş hüküm onay bekleyemez");
  store.close();
});

test("supersede edilmiş hüküm İNCELENEMEZ", () => {
  const { store, projectId, findingId } = seed();
  const first = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi", evidence: "e1",
    correction: "geri çekilmiş öneri", source: "mechanical", runId: "r1",
  }).id;
  recordVerdict(store, { projectId, findingId, verdict: "gecerli", evidence: "e2", source: "adjudicator", runId: "r2" });

  assert.equal(reviewVerdict(store, first, "approved"), false,
    "geri çekilmiş bir düzeltme onaylanabilseydi kullanıcı eskimiş metni hafızasına yazardı");
  assert.equal(getVerdict(store, first)!.review, "pending");
  store.close();
});

test("karar geri alınabilir: review SON durumu tutar, tam geçmiş olaylarda kalır", () => {
  const { store, projectId, findingId } = seed();
  const id = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi", evidence: "e1",
    source: "mechanical", runId: "r1",
  }).id;

  assert.equal(reviewVerdict(store, id, "approved"), true);
  assert.equal(reviewVerdict(store, id, "pending"), true, "yanlışlıkla basılan onay geri alınamıyor");
  assert.equal(getVerdict(store, id)!.review, "pending");
  assert.equal(getVerdict(store, id)!.reviewedAt, null, "geri alınan kararın damgası kaldı");
  assert.equal(listPendingVerdicts(store, projectId).map((v) => v.id).includes(id), true,
    "geri alınan hüküm kuyruğa dönmedi");

  assert.equal(reviewVerdict(store, id, "rejected"), true, "geri alındıktan sonra yeniden karar verilemiyor");
  assert.equal(getVerdict(store, id)!.review, "rejected");

  // Append-only: the column holds the latest state, the events hold the path.
  const path = listEvents(store, { kind: "verdict_reviewed" })
    .map((e) => JSON.parse(e.detail!) as { from: string; to: string })
    .map((d) => `${d.from}>${d.to}`)
    .reverse(); // listEvents is newest-first
  assert.deepEqual(path, ["pending>approved", "approved>pending", "pending>rejected"],
    "geçmiş from→to ile yeniden kurulamıyor");
  store.close();
});

test("aynı kararın tekrarı olay üretmez, supersede edilmiş satır geri ALINAMAZ", () => {
  const { store, projectId, findingId } = seed();
  const first = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi", evidence: "e1",
    source: "mechanical", runId: "r1",
  }).id;
  assert.equal(reviewVerdict(store, first, "approved"), true);
  assert.equal(reviewVerdict(store, first, "approved"), true, "aynı karar hata sayıldı");
  assert.equal(listEvents(store, { kind: "verdict_reviewed" }).length, 1,
    "değişmeyen karar sicili şişiriyor");

  recordVerdict(store, { projectId, findingId, verdict: "gecerli", evidence: "e2", source: "adjudicator", runId: "r2" });
  assert.equal(reviewVerdict(store, first, "pending"), false,
    "geçersiz kılınmış satır geri alma yoluyla yeniden dokunulabilir hale geldi");
  assert.equal(getVerdict(store, first)!.review, "approved");
  store.close();
});

test("iddia başına ayrı hüküm: aynı notun iki iddiası aynı anda canlı olabilir", () => {
  const { store, projectId, findingId } = seed();
  const a = recordVerdict(store, {
    projectId, findingId, claimRef: "c1", verdict: "curuk", decayType: "dosya-silindi",
    evidence: "e1", source: "adjudicator", runId: "r1",
  }).id;
  const b = recordVerdict(store, {
    projectId, findingId, claimRef: "c2", verdict: "gecerli", evidence: "e2", source: "adjudicator", runId: "r1",
  }).id;

  assert.equal(getLiveVerdict(store, findingId, "c1")!.id, a);
  assert.equal(getLiveVerdict(store, findingId, "c2")!.id, b);
  assert.equal(getLiveVerdict(store, findingId), undefined, "not düzeyinde hüküm yok");
  assert.equal(listVerdictHistory(store, findingId).length, 2, "notun geçmişi tüm iddialarını kapsar");
  store.close();
});

// --- schema guards ------------------------------------------------------------

test("iddia başına İKİ canlı hüküm şema tarafından imkânsız", () => {
  const { store, projectId, findingId } = seed();
  recordVerdict(store, { projectId, findingId, verdict: "curuk", decayType: "dosya-silindi", evidence: "e1", source: "mechanical", runId: "r1" });
  assert.throws(
    () => store.run(
      "INSERT INTO verdicts (project_id, finding_id, claim_ref, verdict, source, run_id, created_at) " +
        "VALUES (?,?,?,?,?,?,?)",
      projectId, findingId, "", "gecerli", "adjudicator", "r2", "2026-08-15T00:00:00.000Z",
    ),
    /UNIQUE/i,
    "ikinci canlı hüküm, 'şu an ne düşünüyoruz' sorusunu cevapsız bırakırdı",
  );
  store.close();
});

test("hüküm silinemez, ölçüm alanları yerinde değiştirilemez; inceleme durumu değiştirilebilir", () => {
  const { store, projectId, findingId } = seed();
  const id = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi", evidence: "e1",
    correction: "öneri", source: "mechanical", runId: "r1",
  }).id;

  assert.throws(() => store.run("DELETE FROM verdicts WHERE id = ?", id), /silinemez/);
  assert.throws(() => store.run("UPDATE verdicts SET correction = ? WHERE id = ?", "sessiz düzeltme", id), /append-only/);
  assert.throws(() => store.run("UPDATE verdicts SET verdict = ? WHERE id = ?", "gecerli", id), /append-only/);
  assert.equal(getVerdict(store, id)!.correction, "öneri");

  assert.equal(reviewVerdict(store, id, "approved"), true, "inceleme ekseni yazılabilir kalmalı");
  assert.equal(getVerdict(store, id)!.review, "approved");
  store.close();
});

test("var olan id üzerine INSERT OR REPLACE hükmü yerinde yeniden yazamaz", () => {
  const { store, projectId, findingId } = seed();
  const id = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi", evidence: "e1", source: "mechanical", runId: "r1",
  }).id;
  assert.throws(
    () => store.run(
      "INSERT OR REPLACE INTO verdicts (id, project_id, finding_id, claim_ref, verdict, source, run_id, created_at) " +
        "VALUES (?,?,?,?,?,?,?,?)",
      id, projectId, findingId, "", "gecerli", "adjudicator", "r2", "2026-08-15T00:00:00.000Z",
    ),
    /append-only/,
  );
  assert.equal(getVerdict(store, id)!.verdict, "curuk");
  store.close();
});

test("bilinmeyen hüküm değeri şema tarafından reddedilir", () => {
  const { store, projectId, findingId } = seed();
  assert.throws(
    () => store.run(
      "INSERT INTO verdicts (project_id, finding_id, verdict, source, run_id, created_at) VALUES (?,?,?,?,?,?)",
      projectId, findingId, "belki", "adjudicator", "r1", "2026-08-15T00:00:00.000Z",
    ),
    /CHECK/i,
  );
  store.close();
});

test("dışarıdan düşürülen hüküm tetikleyicisi verifyGuards ile geri geliyor", () => {
  const path = tmpStorePath();
  const store = openStore(path);

  // Depo AÇIKKEN başka bir süreç korumayı düşürüyor. Yeniden açılış bunu zaten
  // onarırdı (schema.sql her açılışta koşuyor); onarılmayan hâl tam olarak bu:
  // uzun yaşayan bir bağlantı, tarama boyunca korumasız devam ederdi.
  const raw = new DatabaseSync(path);
  raw.exec("DROP TRIGGER verdicts_no_delete");
  raw.close();

  store.verifyGuards();
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(store, { projectId, source: "observed", content: "n", anchors: [{ kind: "file_path", value: "a.ts" }] });
  const id = recordVerdict(store, { projectId, findingId, verdict: "gecerli", evidence: "e", source: "adjudicator", runId: "r" }).id;
  assert.throws(() => store.run("DELETE FROM verdicts WHERE id = ?", id), /silinemez/);
  store.close();
});

// --- migration: VAR OLAN depo (CLAUDE.md §7) ----------------------------------

test("göç: tabloyu HİÇ tanımayan var olan depo açılır, veri korunur, hüküm yazılabilir", () => {
  const path = tmpStorePath();
  const first = openStore(path);
  const projectId = Number(first.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(first, {
    projectId, source: "imported", content: "eski depodaki not", sourceRef: "n.md",
    anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });
  first.close();

  // Tablonun HİÇ olmadığı kuşağı taklit et: tablo düşünce indeksleri ve
  // tetikleyicileri de gider — yani "eski depo" gerçekten eksik.
  const raw = new DatabaseSync(path);
  raw.exec("DROP TABLE verdicts");
  assert.equal(
    (raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'verdicts'").get() as { n: number }).n, 0);
  raw.close();

  const store = openStore(path);
  assert.equal(store.get<{ n: number }>("SELECT COUNT(*) n FROM findings")?.n, 1, "göç veri kaybetti");
  const id = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi", evidence: "missing_now: src/a.ts",
    correction: "yeni metin", source: "adjudicator", runId: "r1",
  }).id;
  assert.equal(getLiveVerdict(store, findingId)!.id, id);
  // Tetikleyiciler ve canlı-hüküm indeksi de geri gelmiş olmalı; biri eksik
  // olsaydı tablo "var" görünürken sözleşmesi çökmüş olurdu.
  assert.throws(() => store.run("DELETE FROM verdicts WHERE id = ?", id), /silinemez/);
  assert.throws(
    () => store.run(
      "INSERT INTO verdicts (project_id, finding_id, claim_ref, verdict, source, run_id, created_at) VALUES (?,?,?,?,?,?,?)",
      projectId, findingId, "", "gecerli", "adjudicator", "r2", "2026-08-15T00:00:00.000Z",
    ),
    /UNIQUE/i,
  );
  store.close();
});

test("göç: tabloyu ZATEN taşıyan depo yeniden açılınca satırlar ve supersede zinciri korunur", () => {
  const path = tmpStorePath();
  const first = openStore(path);
  const projectId = Number(first.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(first, {
    projectId, source: "imported", content: "not", sourceRef: "n.md",
    anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });
  const older = recordVerdict(first, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi", evidence: "e1", source: "mechanical", runId: "r1",
  }).id;
  const newer = recordVerdict(first, {
    projectId, findingId, verdict: "gecerli", evidence: "e2", correction: "düzeltme", source: "adjudicator", runId: "r2",
  }).id;
  first.close();

  const store = openStore(path);
  assert.deepEqual(listVerdictHistory(store, findingId).map((v) => v.id), [older, newer]);
  assert.equal(getVerdict(store, older)!.supersededBy, newer);
  assert.equal(getLiveVerdict(store, findingId)!.correction, "düzeltme");
  assert.equal(listPendingVerdicts(store, projectId).map((v) => v.id).join(), String(newer));
  store.close();
});

// class: coverage-exclusion-clears-suspect-on-dead-run
// 16 Ağu denetiminin (opencode/glm-5.3) bulgusu, probe ile doğrulandı:
// `classifier-off-clears-suspect` düzeltmesi sınıfın yalnız YARISINI kapatmıştı.
// İçeriğinden çelişki adayı doğan not (description ↔ gövde) korunuyordu, ama
// notların TİPİK hâli — description'sız, iç çelişkisiz — yalnız kapsama adayı
// üretir, o da kapsama kuralıyla atlanınca korumasız kalıp aklanıyordu.
// Ölçülen: aynı `executor: null` koşumunda A `suspect/0,9 → unanchored/0`,
// B `suspect/0,9` — tek koşum, iki not, zıt sonuç.
test("sınıflandırıcı kapalıyken KAPSAMA-ONLY not da korunur (aday türü fark etmez)", async () => {
  const memoryDir = tmpDir("cp-coverage-only-mem-");
  // A: yalnız kapsama adayı. B: frontmatter adayı da var.
  writeFileSync(join(memoryDir, "a.md"), "---\nname: a\n---\nKarar: seam bir tarafta.\n");
  writeFileSync(join(memoryDir, "b.md"),
    "---\nname: b\ndescription: Seam A tarafında duruyor\n---\nKarar: seam B tarafında.\n");
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    repo, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  const project = { id: projectId, path: repo, memoryDir };

  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  const notes = listActive(store, projectId);
  const A = notes.find((f) => f.content.includes("seam bir tarafta"))!;
  const B = notes.find((f) => f.content.includes("seam B tarafında"))!;
  for (const f of [A, B]) { setSuspicion(store, f.id, 0.9); markSuspect(store, f.id); }

  const sum = await auditProject(store, project, { executor: null, fetch: false });

  assert.equal(getFinding(store, A.id)!.status, "suspect", "kapsama-only not aklandı");
  assert.equal(getFinding(store, B.id)!.status, "suspect");
  assert.equal(sum.cleared, 0, "ölçülmemiş boyut aklama üretti");
  assert.equal(sum.heldUnmeasured, 2, "yalnız bir not korundu: aday türü hâlâ ayrım yapıyor");
  // İkisi de kuyrukta: dondurma sessiz kalamaz.
  assert.deepEqual(
    listPendingVerdicts(store, projectId).map((v) => v.subReason).sort(),
    ["classifier-not-run", "classifier-not-run"],
  );
  store.close();
});

test("göç: tekrar sayacı VAR OLAN depoya geliyor, eski satırlar 1'den başlıyor", () => {
  // CLAUDE.md §7: taze depoda çalışması KANIT DEĞİL. Dosya önce yaratılıp hüküm
  // yazılıyor, sonra sütun sökülerek depo sayaç ÖNCESİ şekline geri alınıyor.
  const path = tmpStorePath();
  const ilk = openStore(path);
  const projectId = Number(ilk.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(ilk, {
    projectId, source: "imported", content: "not", sourceRef: "n.md",
    anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });
  const id = recordVerdict(ilk, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi",
    evidence: "e1", source: "mechanical", runId: "r1",
  }).id;
  ilk.close();

  const eski = new DatabaseSync(path);
  eski.exec("ALTER TABLE verdicts DROP COLUMN repeat_count");
  eski.close();

  const yeni = openStore(path); // göç yolu: var olan dosya üzerinde
  const cols = yeni.all<{ name: string }>("SELECT name FROM pragma_table_info('verdicts')").map((c) => c.name);
  assert.ok(cols.includes("repeat_count"), "sütun gelmedi: her tekrar ölçümü 'no such column' ile patlar");
  assert.equal(getVerdict(yeni, id)!.repeatCount, 1, "eski satır hiç ölçülmemiş gibi okunuyor");

  // Ve tekrar yolu VAR OLAN dosyada gerçekten işliyor: aynı sonuç yeni satır
  // yazmaz, yalnız sayacı artırır.
  const again = recordVerdict(yeni, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi",
    evidence: "e1", source: "mechanical", runId: "r2",
  });
  assert.equal(again.recorded, false);
  assert.equal(again.id, id);
  assert.equal(getVerdict(yeni, id)!.repeatCount, 2, "tekrar hiçbir iz bırakmadı");
  assert.equal(listVerdictHistory(yeni, findingId).length, 1, "tekrar için satır yazıldı: tablo şişer");
  yeni.close();
});

test("göç: kanıt parmak izi VAR OLAN depoya geliyor, parmak izsiz red bastırmıyor", () => {
  // CLAUDE.md §7 again: the column is added to a store that ALREADY has the
  // verdicts table and rows in it — `CREATE TABLE IF NOT EXISTS` would not.
  const path = tmpStorePath();
  const ilk = openStore(path);
  const projectId = Number(ilk.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(ilk, {
    projectId, source: "imported", content: "not", sourceRef: "n.md",
    anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });
  const id = recordVerdict(ilk, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi",
    evidence: "e1", source: "mechanical", runId: "r1",
  }).id;
  reviewVerdict(ilk, id, "rejected");
  // Withdraw it, so the rejected row is no longer live: that is the state in
  // which suppression is the only thing standing between the user and a
  // re-queued complaint they already dismissed.
  recordVerdict(ilk, {
    projectId, findingId, verdict: "olculemez", subReason: "anchor-evidence-cleared",
    evidence: "kanıt yok", source: "mechanical", runId: "r2",
  });
  ilk.close();

  const eski = new DatabaseSync(path);
  eski.exec("ALTER TABLE verdicts DROP COLUMN evidence_fingerprint");
  eski.close();

  const yeni = openStore(path); // göç yolu: var olan dosya üzerinde
  const cols = yeni.all<{ name: string }>("SELECT name FROM pragma_table_info('verdicts')").map((c) => c.name);
  assert.ok(cols.includes("evidence_fingerprint"), "sütun gelmedi: her hüküm yazımı 'no such column' ile patlar");
  assert.equal(getVerdict(yeni, id)!.evidenceFingerprint, null, "eski satıra parmak izi uyduruldu");

  // Fingerprint-less rejection MUST NOT suppress: the store cannot know whether
  // the evidence is the same one the user dismissed, and silently dropping a
  // decay report is the one failure mode this tool cannot have.
  const again = recordVerdict(yeni, {
    projectId, findingId, verdict: "curuk", decayType: "dosya-silindi",
    evidence: "e1", source: "mechanical", runId: "r3",
  });
  assert.equal(again.recorded, true, "parmak izsiz eski red, yeni hükmü sessizce yuttu");
  assert.equal(again.suppressed, false);
  assert.notEqual(getVerdict(yeni, again.id)!.evidenceFingerprint, null, "göç sonrası yazımda parmak izi yok");
  yeni.close();
});

test("göç: GERÇEK deponun kopyası açılır, hüküm tablosu belirir, var olan satırlar durur", (t) => {
  const real = join(homedir(), ".context-police", "store.db");
  if (!existsSync(real)) return t.skip("gerçek depo yok — bu makinede ölçülemez");

  const copy = join(tmpDir("cp-realstore-"), "store.db");
  copyFileSync(real, copy); // ASLA orijinal açılmaz: kopya açılır.

  const before = new DatabaseSync(copy);
  const findingCount = (before.prepare("SELECT COUNT(*) n FROM findings").get() as { n: number }).n;
  // The live store crossed this migration on 16 Aug 2026 (first real audit), so
  // "a real store without the table" no longer exists on this machine. Rebuild
  // that pre-migration state on the COPY: dropping the table (triggers and
  // indexes go with it) leaves every other real table untouched, and the
  // measurement below is still "migrate() on a real store file".
  before.exec("DROP TABLE IF EXISTS verdicts");
  before.close();

  const store = openStore(copy);
  assert.equal(store.get<{ n: number }>("SELECT COUNT(*) n FROM findings")?.n, findingCount, "gerçek depo göçte veri kaybetti");
  assert.equal(store.get<{ n: number }>("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'verdicts'")?.n, 1);

  // Tablonun VAR OLMASI yetmez: gerçek depo üzerinde yazılabilir de olmalı.
  // Bu makinedeki depo boş olabilir (ölçüldü, 15 Ağu 2026: 0 satır), o yüzden
  // gereken satırlar kopyanın üstüne açılıyor — kopya, orijinal değil.
  const projectId = store.get<{ id: number }>("SELECT id FROM projects ORDER BY id LIMIT 1")?.id
    ?? Number(store.run(
      "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
    ).lastInsertRowid);
  const findingId = store.get<{ id: number }>("SELECT id FROM findings ORDER BY id LIMIT 1")?.id
    ?? appendFinding(store, {
      projectId, source: "observed", content: "kopya üzerinde açılan not",
      anchors: [{ kind: "file_path", value: "src/a.ts" }],
    });
  const id = recordVerdict(store, {
    projectId, findingId, verdict: "olculemez", subReason: "user-resolvable",
    evidence: "kopya üzerinde ölçüm", correction: "önerilen metin", source: "adjudicator", runId: "r-real",
  }).id;
  assert.equal(getLiveVerdict(store, findingId)!.id, id);
  assert.throws(() => store.run("DELETE FROM verdicts WHERE id = ?", id), /silinemez/);
  store.close();
});

// --- audit wiring -------------------------------------------------------------

const NOTE = "---\nname: curuk\nmodified: 2020-01-01T00:00:00.000Z\n---\n" +
  "DURUM: iş sürüyor. `src/silinecek.ts` üzerinde çalışılıyor, henüz bitmedi.";

let repo: string;
before(() => {
  repo = tmpDir("cp-verdict-repo-");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "silinecek.ts"), "export const a = 1;\n");
  git("add", "-A"); git("commit", "-qm", "ilk");
  rmSync(join(repo, "src", "silinecek.ts"));
  git("add", "-A"); git("commit", "-qm", "silindi");
});

function auditSetup() {
  const memoryDir = tmpDir("cp-verdict-mem-");
  writeFileSync(join(memoryDir, "curuk.md"), NOTE);
  const store = openStore(":memory:");
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    repo, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  return { store, project: { id, path: repo, memoryDir } };
}

const noContradictions = () => fakeExecutor([{ output: '{"verdicts":[]}' }]);

test("denetim silinmiş çapayı hükme çevirir: kanıtlı, onay bekleyen, dosyaya yazılmamış (K9)", async () => {
  const { store, project } = auditSetup();
  const sum = await auditProject(store, project, { executor: noContradictions(), fetch: false });

  assert.equal(sum.verdictsRecorded, 1);
  const finding = listActive(store, project.id)[0]!;
  const live = getLiveVerdict(store, finding.id)!;
  assert.equal(live.verdict, "curuk");
  assert.equal(live.decayType, "dosya-silindi");
  assert.match(live.evidence!, /missing_now: src\/silinecek\.ts/, "kullanıcı aracı denetleyebilmeli");
  assert.equal(live.source, "mechanical");
  assert.equal(live.correction, null, "git bir notun yanlış olduğunu kanıtlar, doğrusunu bilmez");
  assert.deepEqual(listPendingVerdicts(store, project.id).map((v) => v.id), [live.id]);
  assert.equal(listEvents(store, { kind: "verdict_recorded" }).length, 1);
  store.close();
});

test("eşik altı kalan kesin kanıt hüküm ÜRETMEZ: aracın kendi yüzeyinde şüpheli olmayan not onaya düşmez", async () => {
  const { store, project } = auditSetup();
  // Hiç var olmamış tek çapa 0,3 üretir (anchor-drift WEIGHT) — denetim bu notu
  // şüpheli bile saymıyor, dolayısıyla kullanıcıdan onay istemek tutarsız olurdu.
  writeFileSync(join(project.memoryDir, "uydurma.md"), "Not: `src/hic-olmadi.ts` dosyası vardı.");
  const sum = await auditProject(store, project, { executor: noContradictions(), fetch: false });

  const uydurma = listActive(store, project.id).find((f) => f.content.includes("hic-olmadi"))!;
  assert.ok(uydurma.suspicion < 0.6);
  assert.equal(getLiveVerdict(store, uydurma.id), undefined);
  assert.equal(sum.verdictsRecorded, 1, "yalnız eşiği aşan not hüküm aldı");
  store.close();
});

test("aynı denetim ikinci kez koşunca yeni hüküm satırı açılmaz", async () => {
  const { store, project } = auditSetup();
  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  const sum2 = await auditProject(store, project, { executor: noContradictions(), fetch: false });

  assert.equal(sum2.verdictsRecorded, 0, "değişmeyen dünya, büyüyen ekle-only tablo demek olamaz");
  const finding = listActive(store, project.id)[0]!;
  assert.equal(listVerdictHistory(store, finding.id).length, 1);
  store.close();
});

test("çapa kanıtı geri geldiğinde hüküm SİLİNMEZ, olculemez ile geri çekilir", async () => {
  const { store, project } = auditSetup();
  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  const finding = listActive(store, project.id)[0]!;
  const first = getLiveVerdict(store, finding.id)!;
  assert.equal(first.verdict, "curuk");

  // Dosya geri kondu: kesin kanıt artık yok.
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src", "silinecek.ts"), "export const a = 2;\n");
  git("add", "-A"); git("commit", "-qm", "geri kondu");
  try {
    const sum = await auditProject(store, project, { executor: noContradictions(), fetch: false });
    assert.equal(sum.verdictsRecorded, 1);
    const live = getLiveVerdict(store, finding.id)!;
    assert.equal(live.verdict, "olculemez");
    assert.equal(live.subReason, "anchor-evidence-cleared");
    assert.equal(getVerdict(store, first.id)!.supersededBy, live.id);
    assert.equal(getVerdict(store, first.id)!.verdict, "curuk", "geri çekme eski kaydı yok etmez");
    assert.deepEqual(listVerdictHistory(store, finding.id).map((v) => v.verdict), ["curuk", "olculemez"]);
  } finally {
    rmSync(join(repo, "src", "silinecek.ts"));
    git("add", "-A"); git("commit", "-qm", "yeniden silindi");
  }
  store.close();
});

test("reddedilen hüküm kanıtı değişmeden geri gelmez — bastırma denetim yolunda da işliyor", async () => {
  // The store-level tests stage this by hand; this one stages it the way it
  // actually happens: audit → user rejects → evidence goes away → evidence comes
  // back. Without suppression the fourth step re-queues a complaint the user
  // already dismissed, and no store-level test can prove the audit path reaches
  // the choke point.
  const { store, project } = auditSetup();
  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  const finding = listActive(store, project.id)[0]!;
  const first = getLiveVerdict(store, finding.id)!;
  assert.equal(first.verdict, "curuk");
  assert.equal(reviewVerdict(store, first.id, "rejected"), true);

  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src", "silinecek.ts"), "export const a = 3;\n");
  git("add", "-A"); git("commit", "-qm", "geri kondu");
  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  assert.equal(getLiveVerdict(store, finding.id)!.verdict, "olculemez", "red hükmü hâlâ canlı: kurulum tutmadı");

  rmSync(join(repo, "src", "silinecek.ts"));
  git("add", "-A"); git("commit", "-qm", "yeniden silindi");
  const sum = await auditProject(store, project, { executor: noContradictions(), fetch: false });

  assert.equal(sum.verdictsSuppressed, 1, "reddedilen şikâyet aynı kanıtla kuyruğa geri döndü");
  assert.equal(sum.verdictsRecorded, 0);
  assert.deepEqual(listVerdictHistory(store, finding.id).map((v) => v.verdict), ["curuk", "olculemez"]);
  assert.equal(
    listEvents(store, { kind: "verdict_suppressed" }).length, 1,
    "bastırma hiçbir iz bırakmadı: denetim raporundan az iş yapmış olur",
  );
  store.close();
});

// class: truncated-evidence-line-as-identity
// The evidence line caps at MAX_EVIDENCE_ANCHORS and collapses the rest to
// "(+N)". Deriving the suppression fingerprint from that line makes two
// DIFFERENT anchor sets of the same size byte-identical: one file comes back,
// another dies, and the complaint the user never saw is suppressed by a
// rejection that was about other files.
test("kırpılmış kanıt satırı kimlik olamaz: çapa kümesi değiştiyse bastırma tutmaz", async () => {
  const aliasRepo = tmpDir("cp-alias-repo-");
  const git = (...a: string[]) => execFileSync("git", ["-C", aliasRepo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(aliasRepo, "src"));
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  const write = (n: string, v: number) =>
    writeFileSync(join(aliasRepo, "src", `${n}.ts`), `export const ${n} = ${v};\n`);
  const drop = (n: string) => rmSync(join(aliasRepo, "src", `${n}.ts`));
  for (const n of names) write(n, 1);
  git("add", "-A"); git("commit", "-qm", "hepsi");

  // 1. tur: a..f silik, g duruyor → kanıt satırı "a, b, c, d, e (+1)".
  for (const n of ["a", "b", "c", "d", "e", "f"]) drop(n);
  git("add", "-A"); git("commit", "-qm", "altisi silindi");

  const memoryDir = tmpDir("cp-alias-mem-");
  writeFileSync(
    join(memoryDir, "cok-capa.md"),
    "---\nname: cok-capa\nmodified: 2020-01-01T00:00:00.000Z\n---\n" +
      `DURUM: ${names.map((n) => `\`src/${n}.ts\``).join(", ")} üzerinde çalışılıyor.`,
  );
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    aliasRepo, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  const project = { id: projectId, path: aliasRepo, memoryDir };

  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  const finding = listActive(store, project.id)[0]!;
  const first = getLiveVerdict(store, finding.id)!;
  assert.equal(first.verdict, "curuk", "kurulum tutmadı: silinen çapalar hükme dönmedi");
  assert.equal(reviewVerdict(store, first.id, "rejected"), true);

  // 2. tur: hepsi geri → hüküm olculemez ile geri çekilir, red satırı canlı olmaktan çıkar.
  for (const n of ["a", "b", "c", "d", "e", "f"]) write(n, 2);
  git("add", "-A"); git("commit", "-qm", "hepsi geri");
  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  assert.equal(getLiveVerdict(store, finding.id)!.verdict, "olculemez", "red hükmü hâlâ canlı: kurulum tutmadı");

  // 3. tur: f duruyor ama g gitti — küme BAŞKA, sayı aynı, kanıt satırı aynı.
  for (const n of ["a", "b", "c", "d", "e", "g"]) drop(n);
  git("add", "-A"); git("commit", "-qm", "f geri g gitti");
  const sum = await auditProject(store, project, { executor: noContradictions(), fetch: false });

  assert.equal(sum.verdictsSuppressed, 0, "başka dosyalar hakkındaki red, hiç görülmemiş bir şikâyeti bastırdı");
  assert.equal(sum.verdictsRecorded, 1);
  const live = getLiveVerdict(store, finding.id)!;
  assert.equal(live.verdict, "curuk");
  assert.equal(live.review, "pending");
  assert.equal(live.evidence, first.evidence, "kurulum tutmadı: kanıt satırları zaten farklı, takma ad sınanmıyor");
  store.close();
});

test("git yokken hüküm ne verilir ne geri çekilir: ölçmemek hüküm değildir", async () => {
  const { store, project } = auditSetup();
  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  const finding = listActive(store, project.id)[0]!;
  const first = getLiveVerdict(store, finding.id)!;

  // Aynı hafıza, git'siz bir çalışma kökü: çapa boyutu HİÇ ölçülmedi.
  // Sınıflama bilerek kapalı: açık olsaydı not "çelişki boyutu ölçülemedi"
  // dalında zaten donardı ve bu test çapa korumasını HİÇ sınamamış olurdu
  // (ölçüldü: o yolda `heldUnmeasured` 1, hüküm yolu çalışmıyor).
  const noGit = tmpDir("cp-verdict-nogit-");
  const sum = await auditProject(store, { ...project, path: noGit }, { executor: null, fetch: false });

  assert.equal(sum.gitAvailable, false);
  assert.equal(sum.verdictsRecorded, 0);
  assert.equal(getLiveVerdict(store, finding.id)!.id, first.id, "ölçüm yapılamayan koşum hükmü geri çekemez");
  store.close();
});

// class: gitless-run-acquits-existing-suspect
// The guard above covered the VERDICT path only. The suspicion path derived its
// "unmeasured" set from the anchor verdicts, and without git that list is empty,
// so `missing` came out empty and clearSuspect ran. Measured 15 Aug 2026: one
// gitless run took a finding from suspect/0.9 to active/0 while its live verdict
// still read `curuk` — the two tables gave different answers and the run logged
// `cleared=1`, presenting an acquittal as a measurement.
test("git yokken var olan suspect TEMİZLENMEZ: iki tablo çelişmez", async () => {
  const { store, project } = auditSetup();
  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  const finding = listActive(store, project.id)[0]!;
  setSuspicion(store, finding.id, 0.9);
  markSuspect(store, finding.id);

  const noGit = tmpDir("cp-suspect-nogit-");
  const sum = await auditProject(store, { ...project, path: noGit }, { executor: null, fetch: false });

  assert.equal(sum.gitAvailable, false);
  assert.equal(sum.cleared, 0, "ölçüm yapılamayan koşum aklama üretemez");
  assert.equal(getFinding(store, finding.id)!.status, "suspect");
  // Ve hükmü EZİLMEDİ: canlı `curuk` yerinde. "Ölçemedim" kaydı yalnız hükümsüz
  // notlar için açılıyor — zaten hükmü olan not kuyrukta görünüyor demektir.
  assert.equal(getLiveVerdict(store, finding.id)!.verdict, "curuk");
  store.close();
});

// class: unmeasured-never-reaches-the-user
// Dondurmak tek başına bir karar değil, KULLANICI ADINA verilmiş bir karardır.
// Ölçüldü (15 Ağu denetimi): donan not `continue` ile `persistVerdict`ı atlıyordu,
// onay kuyruğu `verdicts` tablosundan okunduğu için kullanıcı donmuş nottan hiç
// haberdar olmuyordu — ne aklama ne dondurma görünüyordu.
test("çelişki boyutu ölçülemeyen donmuş not ONAY KUYRUĞUNA girer", async () => {
  const memoryDir = tmpDir("cp-unmeasured-mem-");
  // Çapasız ama description'lı: çapa yolu hiç hüküm üretmiyor (yani ortada
  // ezilecek bir `curuk` yok), buna karşılık özet ↔ gövde yüzeyi gerçek bir
  // çelişki adayı üretiyor — kapsama yüzeyinin aksine bu, notun KENDİ içeriğinden.
  writeFileSync(join(memoryDir, "n.md"),
    "---\nname: n\ndescription: Seam A tarafında duruyor\n---\nKarar: seam B tarafında.\n");
  const store = openStore(":memory:");
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    repo, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  const project = { id, path: repo, memoryDir };

  await auditProject(store, project, { executor: noContradictions(), fetch: false });
  const finding = listActive(store, project.id)[0]!;
  assert.equal(getLiveVerdict(store, finding.id), undefined, "önkoşul: ortada hüküm yok");
  setSuspicion(store, finding.id, 0.9);
  markSuspect(store, finding.id);

  // Sınıflandırıcı KAPALI: çelişki boyutu hiç kimse için ölçülmedi.
  const sum = await auditProject(store, project, { executor: null, fetch: false });

  assert.equal(sum.heldUnmeasured, 1, "şüphe korunmadı");
  assert.equal(getFinding(store, finding.id)!.status, "suspect");
  const pending = listPendingVerdicts(store, project.id);
  assert.equal(pending.length, 1, "donmuş not kullanıcıya hiç ulaşmadı");
  assert.equal(pending[0]!.verdict, "olculemez");
  assert.equal(pending[0]!.subReason, "classifier-not-run");
  assert.match(pending[0]!.evidence!, /çelişki/, "hangi boyutun ölçülemediği kanıtta yok");

  // Tekrarlayan koşum İKİNCİ satır yazmaz (`sameConclusion`): kuyruk seli yok.
  const sum2 = await auditProject(store, project, { executor: null, fetch: false });
  assert.equal(sum2.verdictsRecorded, 0);
  assert.equal(listPendingVerdicts(store, project.id).length, 1);
  store.close();
});
