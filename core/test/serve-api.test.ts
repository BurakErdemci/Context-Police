import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, openStoreReadonly } from "../src/store/db.ts";
import type { ReadStore } from "../src/store/db.ts";
// Test-only exception to K12 (db.ts is the sole sqlite importer): producing an
// old-schema fixture needs a raw writable handle; production code never does this.
import { DatabaseSync } from "node:sqlite";
import { appendFinding } from "../src/store/findings.ts";
import { recordVerdict } from "../src/store/verdicts.ts";
import { logEvent } from "../src/store/events.ts";
import { tmpStorePath } from "./helpers.ts";
import {
  getSummary, listVerdicts, getFindingDetail, listRuns, getVersion, SchemaOutdated,
} from "../src/serve/api.ts";

// Fixture: 2 finding; f1 has a superseded chain (curuk -> gecerli), f2 olculemez.
function fixture(): { path: string; ro: ReadStore; f1: number; f2: number } {
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
  return { path, ro: openStoreReadonly(path), f1, f2 };
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
