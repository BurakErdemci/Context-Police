import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, openStoreReadonly } from "../src/store/db.ts";
import type { ReadStore } from "../src/store/db.ts";
// Test-only exception to K12 (db.ts is the sole sqlite importer): producing an
// old-schema fixture needs a raw writable handle; production code never does this.
import { DatabaseSync } from "node:sqlite";
import { appendFinding } from "../src/store/findings.ts";
import { recordVerdict, reviewVerdict } from "../src/store/verdicts.ts";
import { logEvent } from "../src/store/events.ts";
import { tmpStorePath } from "./helpers.ts";
import {
  getSummary, listVerdicts, getFindingDetail, listRuns, getVersion, listProjectCards, SchemaOutdated,
  QueueCountMismatch,
} from "../src/serve/api.ts";

// Fixture: 2 finding; f1 has a superseded chain (curuk -> gecerli), f2 olculemez.
function fixture(): { path: string; ro: ReadStore; p: number; f1: number; f2: number } {
  const path = tmpStorePath();
  const store = openStore(path);
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const f1 = appendFinding(store, {
    projectId, source: "imported", content: "not bir: DURUM eski", sourceRef: "a.md",
    anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });
  const f2 = appendFinding(store, {
    projectId, source: "imported", content: "not iki", sourceRef: "b.md", anchors: [],
  });
  store.run("UPDATE findings SET suspicion = 0.7 WHERE id = ?", f1);
  recordVerdict(store, {
    projectId, findingId: f1, verdict: "curuk", subReason: null,
    evidence: "anchor moved", method: "anchor-drift", source: "mechanical", runId: "r1",
  });
  recordVerdict(store, {
    projectId, findingId: f1, verdict: "gecerli", subReason: null,
    evidence: "re-measured clean", method: "anchor-drift", source: "mechanical", runId: "r2",
  });
  recordVerdict(store, {
    projectId, findingId: f2, verdict: "olculemez", subReason: "classify-undecided",
    evidence: "dimension unmeasured", method: "unmeasured-dimension",
    source: "mechanical", runId: "r2",
  });
  logEvent(store, { projectId, kind: "audit_completed", detail: JSON.stringify({ verdictsRecorded: 3 }) });
  store.close();
  return { path, ro: openStoreReadonly(path), p: projectId, f1, f2 };
}

test("summary canlı hükümleri sayar", () => {
  const { ro } = fixture();
  const s = getSummary(ro);
  assert.equal(s.counts["gecerli"], 1);      // curuk superseded, sayılmaz
  assert.equal(s.counts["olculemez"], 1);
  assert.equal(s.findings, 2);
  assert.equal(s.projects.length, 1);
  ro.close();
});

test("listVerdicts skor azalan sıralar ve filtreler", () => {
  const { ro, f1 } = fixture();
  const rows = listVerdicts(ro);
  assert.equal(rows.length, 2);              // yalnız canlı hükümler
  assert.equal(rows[0]!.findingId, f1);      // suspicion 0.7 önce
  assert.ok(rows[0]!.preview.startsWith("not bir"));
  const only = listVerdicts(ro, { verdict: "olculemez" });
  assert.equal(only.length, 1);
  assert.equal(only[0]!.subReason, "classify-undecided");
  ro.close();
});

test("listVerdicts subReason alt dize eşleşir, tam eşleşme değil", () => {
  const { ro, f2 } = fixture();
  const bySubstring = listVerdicts(ro, { subReason: "classify" });
  assert.equal(bySubstring.length, 1);
  assert.equal(bySubstring[0]!.findingId, f2);
  const combined = listVerdicts(ro, { verdict: "olculemez", subReason: "classify" });
  assert.equal(combined.length, 1);
  assert.equal(combined[0]!.findingId, f2);
  ro.close();
});

test("listVerdicts satırları projectId taşır", () => {
  const { ro, p } = fixture();
  const rows = listVerdicts(ro);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.projectId, p);
  ro.close();
});

// The field exists so the explorer can filter the queue by project without a
// per-finding detail fetch; two projects in one store is the case that proves it.
test("listVerdicts projectId satırı kendi projesine bağlar", () => {
  const path = tmpStorePath();
  const store = openStore(path);
  const ids = ["/a-proje", "/z-proje"].map((projectPath) => Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    projectPath, "claude-code", "/t",
  ).lastInsertRowid));
  const [projectA, projectB] = ids as [number, number];
  const fA = appendFinding(store, {
    projectId: projectA, source: "imported", content: "a notu", sourceRef: "a.md", anchors: [],
  });
  const fB = appendFinding(store, {
    projectId: projectB, source: "imported", content: "b notu", sourceRef: "b.md", anchors: [],
  });
  recordVerdict(store, {
    projectId: projectA, findingId: fA, verdict: "curuk", subReason: null,
    evidence: "a", method: "anchor-drift", source: "mechanical", runId: "r1",
  });
  recordVerdict(store, {
    projectId: projectB, findingId: fB, verdict: "curuk", subReason: null,
    evidence: "b", method: "anchor-drift", source: "mechanical", runId: "r1",
  });
  store.close();
  const ro = openStoreReadonly(path);
  const byFinding = new Map(listVerdicts(ro).map((r) => [r.findingId, r.projectId]));
  assert.equal(byFinding.get(fA), projectA);
  assert.equal(byFinding.get(fB), projectB);
  ro.close();
});

test("finding detayı supersession zincirini eskiden yeniye verir", () => {
  const { ro, f1 } = fixture();
  const d = getFindingDetail(ro, f1);
  assert.ok(d);
  assert.equal(d!.anchors.length, 1);
  const claim = d!.claims[0]!;
  assert.equal(claim.live?.verdict, "gecerli");
  assert.equal(claim.history.length, 2);
  assert.equal(claim.history[0]!.verdict, "curuk");
  assert.ok(claim.history[0]!.supersededBy !== null);
  ro.close();
});

test("runs audit_completed detail JSON'unu çözer", () => {
  const { ro } = fixture();
  const runs = listRuns(ro);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.detail?.["verdictsRecorded"], 3);
  ro.close();
});

test("version max id'leri döner", () => {
  const { ro } = fixture();
  const v = getVersion(ro);
  assert.equal(v.maxVerdictId, 3);
  assert.ok(v.maxEventId >= 1);
  ro.close();
});

test("listVerdicts satırları teşhis cümlesi taşır", () => {
  const { ro, f1 } = fixture();
  const rows = listVerdicts(ro);
  const row = rows.find((r) => r.findingId === f1);
  assert.ok(row);
  assert.equal(typeof row!.diagnosis.sentence, "string");
  assert.ok(row!.diagnosis.sentence.length > 0);
  ro.close();
});

test("finding detayı teşhis alanı taşır", () => {
  const { ro, f1 } = fixture();
  const d = getFindingDetail(ro, f1);
  assert.ok(d);
  assert.equal(typeof d!.diagnosis.sentence, "string");
  assert.ok(d!.diagnosis.sentence.length > 0);
  ro.close();
});

test("listProjectCards proje başına not/şüpheli/bekleyen/çapasız/temiz sayar", () => {
  const { ro } = fixture();
  const cards = listProjectCards(ro);
  assert.equal(cards.length, 1);
  const card = cards[0]!;
  assert.equal(card.path, "/p");
  assert.equal(card.name, "p");
  assert.equal(card.notes, 2);          // f1 + f2, ikisi de superseded değil
  assert.equal(card.suspects, 0);       // fixture'da hiçbiri 'suspect' işaretlenmedi
  assert.equal(card.pending, 2);        // f1'in canlı hükmü + f2'nin canlı hükmü
  assert.equal(card.anchorless, 1);     // yalnız f2 çapasız
  assert.equal(card.clean, 2);          // notes - suspects
  assert.equal(card.healthPct, 100);    // round(100 * 2/2)
  ro.close();
});

test("listProjectCards runSeries son audit_completed olaylarını eskiden yeniye verir", () => {
  const { ro } = fixture();
  const card = listProjectCards(ro)[0]!;
  assert.deepEqual(card.runSeries, [3]); // fixture'daki tek olayın verdictsRecorded'ı
  assert.ok(card.lastRunAt !== null);
  ro.close();
});

test("listProjectCards: hiç bulgusu olmayan proje %100 sağlıklı sayılır", () => {
  const path = tmpStorePath();
  const store = openStore(path);
  store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/empty", "claude-code", "/t",
  );
  store.close();
  const ro = openStoreReadonly(path);
  const card = listProjectCards(ro)[0]!;
  assert.equal(card.notes, 0);
  assert.equal(card.healthPct, 100); // "kullanılmıyor" çürümüş demek değil
  assert.deepEqual(card.runSeries, []);
  assert.equal(card.lastRunAt, null);
  ro.close();
});

test("listProjectCards: iki proje bağımsız sayılır, yol sırasına göre listelenir", () => {
  const path = tmpStorePath();
  const store = openStore(path);
  const projectB = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/z-proje", "claude-code", "/t",
  ).lastInsertRowid);
  const projectA = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/a-proje", "claude-code", "/t",
  ).lastInsertRowid);
  appendFinding(store, {
    projectId: projectA, source: "imported", content: "a notu", sourceRef: "a.md", anchors: [],
  });
  const bF1 = appendFinding(store, {
    projectId: projectB, source: "imported", content: "b notu bir", sourceRef: "b1.md", anchors: [],
  });
  appendFinding(store, {
    projectId: projectB, source: "imported", content: "b notu iki", sourceRef: "b2.md", anchors: [],
  });
  store.run("UPDATE findings SET status = 'suspect' WHERE id = ?", bF1);
  store.close();
  const ro = openStoreReadonly(path);
  const cards = listProjectCards(ro);
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.path, "/a-proje"); // "/a-proje" < "/z-proje" alfabetik
  assert.equal(cards[0]!.notes, 1);
  assert.equal(cards[0]!.suspects, 0);
  assert.equal(cards[1]!.path, "/z-proje");
  assert.equal(cards[1]!.notes, 2);
  assert.equal(cards[1]!.suspects, 1);
  ro.close();
});

test("eski şemalı depo SchemaOutdated fırlatır", () => {
  const path = tmpStorePath();
  const store = openStore(path);
  store.close();
  // Simulate a pre-verdicts store: the guard must classify the sqlite error,
  // not crash the endpoint. Dropping the table needs a raw writable handle.
  const raw = new DatabaseSync(path);
  raw.exec("DROP TRIGGER verdicts_no_delete; DROP TABLE verdicts");
  raw.close();
  const ro = openStoreReadonly(path);
  assert.throws(() => getSummary(ro), SchemaOutdated);
  ro.close();
});

// --- Kuyruk semantiği (tasarım §4) ---

test("bekleyen sayımı DIŞLAMAYLA yapılır, pozitif status filtresiyle değil", () => {
  const { path, ro, f2 } = fixture();
  // A row whose `review` is neither approved nor rejected must count as pending
  // even if its value is not the literal 'pending' — the exclusion form is what
  // keeps an unknown/absent value from being silently dropped from the queue.
  assert.equal(getSummary(ro).pending, 2);
  ro.close();

  const store = openStore(path);
  const id = store.get<{ id: number }>(
    "SELECT id FROM verdicts WHERE finding_id = ? AND superseded_by IS NULL", f2,
  )!.id;
  reviewVerdict(store, id, "approved");
  store.close();

  const ro2 = openStoreReadonly(path);
  const s = getSummary(ro2);
  assert.equal(s.pending, 1);
  assert.equal(s.queue.decided, 1);
  assert.equal(s.queue.superseded, 1);
  assert.equal(s.queue.total, s.queue.pending + s.queue.decided + s.queue.superseded);
  // The decided verdict stays visible in the default listing (spec §4:
  // it does not vanish from the screen the moment it is decided).
  assert.equal(listVerdicts(ro2).length, 2);
  assert.equal(listVerdicts(ro2, { review: "pending" }).length, 1);
  ro2.close();
});

test("proje kartı bekleyeni de dışlamayla sayar", () => {
  const { path, ro, f2 } = fixture();
  assert.equal(listProjectCards(ro)[0]!.pending, 2);
  ro.close();
  const store = openStore(path);
  const id = store.get<{ id: number }>(
    "SELECT id FROM verdicts WHERE finding_id = ? AND superseded_by IS NULL", f2,
  )!.id;
  reviewVerdict(store, id, "rejected");
  store.close();
  const ro2 = openStoreReadonly(path);
  assert.equal(listProjectCards(ro2)[0]!.pending, 1);
  ro2.close();
});

test("sayım mutabakatı tutmazsa QueueCountMismatch fırlar", () => {
  const { path, ro } = fixture();
  ro.close();
  const real = openStoreReadonly(path);
  const lying: ReadStore = {
    get<T>(sql: string, ...params: never[]): T | undefined {
      if (/superseded_by IS NOT NULL/.test(sql)) return { c: 99 } as T;
      return real.get<T>(sql, ...params);
    },
    all: real.all.bind(real),
    close: real.close.bind(real),
  };
  assert.throws(() => getSummary(lying), QueueCountMismatch);
  real.close();
});

test("review'ı olmayan satır kuyruktan DÜŞMEZ (pozitif filtre düşürürdü)", () => {
  // The exclusion form only differs from `review = 'pending'` on a store whose
  // `review` column can hold NULL — a foreign or pre-CHECK store. Without this
  // fixture the change is untestable: the CHECK constraint makes the two forms
  // equivalent, so a plain fixture leaves the design claim unfalsified.
  // Fixture only: writable_schema strips NOT NULL/CHECK from `review`.
  const path = tmpStorePath();
  const store = openStore(path);
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(store, {
    projectId, source: "imported", content: "not", sourceRef: "n.md", anchors: [],
  });
  store.close();

  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA writable_schema = ON");
  const ddl = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'verdicts'")
    .get() as { sql: string };
  const relaxed = ddl.sql.replace(
    /review\s+TEXT NOT NULL DEFAULT 'pending' CHECK \(review IN \('pending','approved','rejected'\)\)/,
    "review TEXT",
  );
  assert.notEqual(relaxed, ddl.sql, "fixture: review kolonu gevşetilemedi");
  raw.prepare("UPDATE sqlite_master SET sql = ? WHERE name = ?").run(relaxed, "verdicts");
  raw.exec("PRAGMA writable_schema = OFF");
  raw.close();

  const raw2 = new DatabaseSync(path);
  raw2.prepare(
    "INSERT INTO verdicts (id, project_id, finding_id, claim_ref, verdict, source, run_id, created_at, review) " +
      "VALUES (1,?,?,'','curuk','mechanical','r1','2026-01-01', NULL)",
  ).run(projectId, findingId);
  raw2.close();

  const ro = openStoreReadonly(path);
  const s = getSummary(ro);
  assert.equal(s.pending, 1);
  assert.equal(s.queue.total, 1);
  assert.equal(listVerdicts(ro, { review: "pending" }).length, 1);
  assert.equal(listProjectCards(ro)[0]!.pending, 1);
  ro.close();
});
