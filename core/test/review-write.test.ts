import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { appendFinding } from "../src/store/findings.ts";
import { recordVerdict, getVerdict, reviewVerdict } from "../src/store/verdicts.ts";
import { tmpStorePath, tmpDir } from "./helpers.ts";
import { applyReview } from "../src/serve/review-write.ts";

/** One project, one finding, one live pending verdict. Returns the store path. */
function seed(): { path: string; verdictId: number; findingId: number; projectId: number } {
  const path = tmpStorePath();
  const store = openStore(path);
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(store, {
    projectId, source: "imported", content: "not", sourceRef: "n.md", anchors: [],
  });
  const rec = recordVerdict(store, {
    projectId, findingId, verdict: "curuk", subReason: null,
    evidence: "e", method: "m", source: "mechanical", runId: "r1",
  });
  store.close();
  return { path, verdictId: rec.id, findingId, projectId };
}

test("applyReview mutlu yol: karar depoya yazılır ve olay düşer", () => {
  const { path, verdictId } = seed();
  const r = applyReview(path, verdictId, "approved");
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.row.review === "approved");
  assert.ok(r.ok && r.row.reviewedAt !== null);

  const store = openStore(path);
  assert.equal(getVerdict(store, verdictId)!.review, "approved");
  const ev = store.get<{ c: number }>(
    "SELECT COUNT(*) c FROM events WHERE kind = 'verdict_reviewed'",
  )!.c;
  assert.equal(ev, 1);
  store.close();
});

test("applyReview olmayan id için not_found döner", () => {
  const { path } = seed();
  const r = applyReview(path, 9999, "approved");
  assert.deepEqual(r, { ok: false, code: "not_found" });
});

test("applyReview zaten kararlı hükmü already_decided ile reddeder", () => {
  const { path, verdictId } = seed();
  assert.equal(applyReview(path, verdictId, "rejected").ok, true);
  const again = applyReview(path, verdictId, "approved");
  assert.deepEqual(again, { ok: false, code: "already_decided" });
  const store = openStore(path);
  assert.equal(getVerdict(store, verdictId)!.review, "rejected");
  store.close();
});

test("applyReview superseded hükmü superseded ile reddeder", () => {
  const { path, verdictId, findingId, projectId } = seed();
  const store = openStore(path);
  recordVerdict(store, {
    projectId, findingId, verdict: "gecerli", subReason: null,
    evidence: "yeniden ölçüldü", method: "m", source: "mechanical", runId: "r2",
  });
  store.close();
  const r = applyReview(path, verdictId, "approved");
  assert.deepEqual(r, { ok: false, code: "superseded" });
});

test("applyReview depo dosyası yokken store_missing döner ve dosya YARATMAZ", () => {
  const missing = join(tmpDir(), "yok.db");
  const r = applyReview(missing, 1, "approved");
  assert.deepEqual(r, { ok: false, code: "store_missing" });
  // Silent success is the danger the spec names: the write path must not
  // conjure an empty store out of a missing one.
  assert.equal(existsSync(missing), false);
});

test("eşzamanlılık: audit benzeri ikinci yazar bağlıyken review tamamlanır", () => {
  const { path, verdictId } = seed();
  // Second writable connection, kept open with an ACTIVE read transaction —
  // the shape an audit run has while it scans. Under rollback journal this
  // would block the review write; WAL + busy_timeout is what makes it pass.
  const other = openStore(path);
  assert.equal(
    (other.get<{ journal_mode: string }>("PRAGMA journal_mode")!).journal_mode,
    "wal",
  );
  try {
    other.tx(() => {
      other.all("SELECT id FROM verdicts"); // read lock is now held
      const r = applyReview(path, verdictId, "approved");
      assert.equal(r.ok, true);
    });
  } finally {
    other.close();
  }
  // The audit-side connection stays usable afterwards.
  const still = openStore(path);
  assert.equal(getVerdict(still, verdictId)!.review, "approved");
  still.close();
});

test("reviewVerdict çekirdeği doğrudan çağrıldığında da aynı sözleşmeyi tutar", () => {
  const { path, verdictId } = seed();
  const store = openStore(path);
  assert.equal(reviewVerdict(store, verdictId, "rejected"), true);
  store.close();
  assert.deepEqual(applyReview(path, verdictId, "approved"), { ok: false, code: "already_decided" });
});
