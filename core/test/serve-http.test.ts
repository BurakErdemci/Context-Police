import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { openStore } from "../src/store/db.ts";
import { appendFinding } from "../src/store/findings.ts";
import { recordVerdict } from "../src/store/verdicts.ts";
import { tmpStorePath, tmpDir } from "./helpers.ts";
import { startServer } from "../src/serve/serve.ts";
import type { Summary, VerdictRow, FindingDetail, Version } from "../src/serve/api.ts";

let port = 4871; // test-local ports; one per server to avoid rebind races
function nextPort(): number { return port++; }

async function withServer(storePath: string, fn: (base: string) => Promise<void>): Promise<void> {
  const p = nextPort();
  const server: Server = await startServer({ storePath, port: p });
  try { await fn(`http://127.0.0.1:${p}`); }
  finally { await new Promise((res) => server.close(res)); }
}

function seed(): string {
  const path = tmpStorePath();
  const store = openStore(path);
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const f = appendFinding(store, {
    projectId, source: "imported", content: "not", sourceRef: "n.md", anchors: [],
  });
  recordVerdict(store, {
    projectId, findingId: f, verdict: "curuk", subReason: null,
    evidence: "e", method: "m", source: "mechanical", runId: "r1",
  });
  store.close();
  return path;
}

test("api uçları JSON döner", async () => {
  await withServer(seed(), async (base) => {
    const s = await (await fetch(`${base}/api/summary`)).json() as Summary;
    assert.equal(s.counts["curuk"], 1);
    const rows = await (await fetch(`${base}/api/verdicts?verdict=curuk`)).json() as VerdictRow[];
    assert.equal(rows.length, 1);
    const d = await (await fetch(`${base}/api/findings/${rows[0]!.findingId}`)).json() as FindingDetail;
    assert.equal(d.claims[0]!.live?.verdict, "curuk");
    const v = await (await fetch(`${base}/api/version`)).json() as Version;
    assert.equal(v.maxVerdictId, 1);
  });
});

test("depo yokken sunucu açılır ve storeMissing döner", async () => {
  const missing = tmpStorePath(); // path exists as a name only; file never created
  await withServer(missing, async (base) => {
    const s = await (await fetch(`${base}/api/summary`)).json() as { storeMissing: boolean; path: string };
    assert.equal(s.storeMissing, true);
    assert.equal(typeof s.path, "string");
  });
});

test("statik servis çalışır, yol kaçışı 404", async () => {
  await withServer(seed(), async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    const esc = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.equal(esc.status, 404);
    const unknown = await fetch(`${base}/api/nope`);
    assert.equal(unknown.status, 404);
  });
});

test("olmayan finding 404", async () => {
  await withServer(seed(), async (base) => {
    const r = await fetch(`${base}/api/findings/9999`);
    assert.equal(r.status, 404);
  });
});

test("yol ön eki sınırı: sibling dizin 404", async () => {
  // Verifies that a normalized path starting with WEB_ROOT as string prefix
  // but actually outside WEB_ROOT (e.g. core/web2 when WEB_ROOT is core/web)
  // returns 404. The vulnerability: bare startsWith(WEB_ROOT) would pass.
  // The fix: target === WEB_ROOT || target.startsWith(WEB_ROOT + sep).
  await withServer(seed(), async (base) => {
    // Encoded path that normalizes to a sibling-prefixed path.
    // If WEB_ROOT is core/web, this attempts core/web2/../x (or similar structure).
    // After normalization, it would be outside WEB_ROOT.
    const sibling = await fetch(`${base}/%2e%2e%2fweb2%2fx.js`);
    assert.equal(sibling.status, 404);
  });
});
