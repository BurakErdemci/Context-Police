import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, openStoreReadonly } from "../src/store/db.ts";
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
  // Verifies that the path boundary check requires a separator.
  // Without the fix (bare startsWith(WEB_ROOT)), a sibling directory
  // like "root-evil" would pass because "root-evil" starts with "root".
  // With the fix (target === WEB_ROOT || target.startsWith(WEB_ROOT + sep)),
  // only subdirectories of WEB_ROOT (with a separator) are allowed.
  const tmp = tmpDir();
  const root = join(tmp, "root");
  const rootEvil = join(tmp, "root-evil");
  mkdirSync(root, { recursive: true });
  mkdirSync(rootEvil, { recursive: true });
  writeFileSync(join(root, "index.html"), "<html>root</html>");
  writeFileSync(join(rootEvil, "x.js"), "console.log('evil');");

  const p = nextPort();
  const server = await startServer({ storePath: seed(), port: p, webRoot: root });
  try {
    const base = `http://127.0.0.1:${p}`;

    // Valid: /index.html exists in root
    const valid = await fetch(`${base}/index.html`);
    assert.equal(valid.status, 200);
    assert.match(valid.headers.get("content-type") ?? "", /text\/html/);

    // Invalid: /x.js does not exist in root
    const missing = await fetch(`${base}/x.js`);
    assert.equal(missing.status, 404);

    // Invalid: traversal to sibling directory
    // /..%2froot-evil%2fx.js decodes to /../root-evil/x.js
    // which normalizes to /root-evil/x.js (sibling of /root)
    // Even though root-evil/x.js exists, it's outside the webRoot boundary.
    const sibling = await fetch(`${base}/..%2froot-evil%2fx.js`);
    assert.equal(sibling.status, 404);
  } finally {
    await new Promise((res) => server.close(res));
  }
});

// --- POST /api/verdicts/:id/review (gerçek onay akışı, tasarım §3) ---

const REVIEW_HEADERS = { "content-type": "application/json", "x-cp-review": "1" };

/** Seeds a store and hands back both the path and the live verdict id. */
function seedWithVerdict(): { path: string; verdictId: number; findingId: number; projectId: number } {
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

function postReview(
  base: string, id: number, body: unknown, headers: Record<string, string> = REVIEW_HEADERS,
): Promise<Response> {
  return fetch(`${base}/api/verdicts/${id}/review`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST review mutlu yol: 200 ve güncel satır", async () => {
  const { path, verdictId } = seedWithVerdict();
  await withServer(path, async (base) => {
    const r = await postReview(base, verdictId, { decision: "approved" });
    assert.equal(r.status, 200);
    const body = await r.json() as { ok: boolean; row: { id: number; review: string; reviewedAt: string | null } };
    assert.equal(body.ok, true);
    assert.equal(body.row.id, verdictId);
    assert.equal(body.row.review, "approved");
    assert.notEqual(body.row.reviewedAt, null);
  });
});

test("POST review başlıksız istek 403", async () => {
  const { path, verdictId } = seedWithVerdict();
  await withServer(path, async (base) => {
    const r = await postReview(base, verdictId, { decision: "approved" }, { "content-type": "application/json" });
    assert.equal(r.status, 403);
    // The decision must not have landed.
    const store = openStore(path);
    assert.equal(store.get<{ review: string }>("SELECT review FROM verdicts WHERE id = ?", verdictId)!.review, "pending");
    store.close();
  });
});

test("POST review bozuk gövde ve bozuk karar 400", async () => {
  const { path, verdictId } = seedWithVerdict();
  await withServer(path, async (base) => {
    assert.equal((await postReview(base, verdictId, "{bozuk")).status, 400);
    assert.equal((await postReview(base, verdictId, { decision: "silindi" })).status, 400);
    assert.equal((await postReview(base, verdictId, {})).status, 400);
  });
});

test("POST review olmayan id 404", async () => {
  const { path } = seedWithVerdict();
  await withServer(path, async (base) => {
    const r = await postReview(base, 9999, { decision: "approved" });
    assert.equal(r.status, 404);
  });
});

// Reversibility (design §7b): a misclick must be undoable from the UI, so a
// live row stays re-decidable. 409 is reserved for the one case the store
// genuinely refuses — a superseded row.
test("POST review kararlı hükmü yeniden karara bağlar: red→onay ve geri al 200", async () => {
  const { path, verdictId } = seedWithVerdict();
  await withServer(path, async (base) => {
    assert.equal((await postReview(base, verdictId, { decision: "rejected" })).status, 200);

    const flip = await postReview(base, verdictId, { decision: "approved" });
    assert.equal(flip.status, 200, "yanlış basılan karar arayüzden düzeltilemiyor");
    assert.equal((await flip.json() as { row: { review: string } }).row.review, "approved");

    const undo = await postReview(base, verdictId, { decision: "pending" });
    assert.equal(undo.status, 200);
    const row = (await undo.json() as { row: { review: string; reviewedAt: string | null } }).row;
    assert.equal(row.review, "pending");
    assert.equal(row.reviewedAt, null);

    const store = openStore(path);
    assert.equal(store.get<{ review: string }>("SELECT review FROM verdicts WHERE id = ?", verdictId)!.review, "pending");
    store.close();
  });
});

test("POST review superseded hüküm 409", async () => {
  const { path, verdictId, findingId, projectId } = seedWithVerdict();
  const store = openStore(path);
  recordVerdict(store, {
    projectId, findingId, verdict: "gecerli", subReason: null,
    evidence: "yeniden ölçüldü", method: "m", source: "mechanical", runId: "r2",
  });
  store.close();
  await withServer(path, async (base) => {
    const r = await postReview(base, verdictId, { decision: "approved" });
    assert.equal(r.status, 409);
    assert.equal((await r.json() as { code: string }).code, "superseded");
  });
});

test("POST review depo yokken 409 storeMissing (200 DEĞİL)", async () => {
  const missing = tmpStorePath();
  await withServer(missing, async (base) => {
    const r = await postReview(base, 1, { decision: "approved" });
    assert.equal(r.status, 409);
    assert.equal((await r.json() as { storeMissing: boolean }).storeMissing, true);
  });
});

test("metot ayrımı: GET dışı metotlar 405, review yolunda GET 404", async () => {
  const { path, verdictId } = seedWithVerdict();
  await withServer(path, async (base) => {
    assert.equal((await fetch(`${base}/api/summary`, { method: "POST", headers: REVIEW_HEADERS, body: "{}" })).status, 405);
    assert.equal((await fetch(`${base}/api/summary`, { method: "DELETE" })).status, 405);
    assert.equal((await fetch(`${base}/`, { method: "PUT" })).status, 405);
    // GET on the review route is not a route at all.
    assert.equal((await fetch(`${base}/api/verdicts/${verdictId}/review`)).status, 404);
  });
});

test("OPTIONS'a CORS izni verilmez", async () => {
  const { path, verdictId } = seedWithVerdict();
  await withServer(path, async (base) => {
    const r = await fetch(`${base}/api/verdicts/${verdictId}/review`, { method: "OPTIONS" });
    assert.equal(r.status, 405);
    for (const h of ["access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods"]) {
      assert.equal(r.headers.get(h), null, `${h} verilmemeli`);
    }
  });
});

test("sayım mutabakatı bozuksa 500 döner", async () => {
  const { path } = seedWithVerdict();
  const p = nextPort();
  // Injects a store view whose superseded count is a lie: the reconciliation
  // has no reachable failure in a healthy store (the CHECK constraint on
  // `review` makes the identity a tautology), so the tripwire is exercised
  // through the read seam instead.
  const server = await startServer({
    storePath: path,
    port: p,
    openRead: (sp) => {
      const real = openStoreReadonly(sp);
      return {
        get<T>(sql: string, ...params: never[]): T | undefined {
          if (/superseded_by IS NOT NULL/.test(sql)) return { c: 99 } as T;
          return real.get<T>(sql, ...params);
        },
        all: real.all.bind(real),
        close: real.close.bind(real),
      };
    },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/summary`);
    assert.equal(r.status, 500);
    const body = await r.json() as { error: string; counts?: { total: number } };
    assert.equal(body.error, "queue_count_mismatch");
    assert.equal(typeof body.counts?.total, "number");
  } finally {
    await new Promise((res) => server.close(res));
  }
});
