import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, extname, sep } from "node:path";
import { openStoreReadonly } from "../store/db.ts";
import type { ReadStore } from "../store/db.ts";
import {
  getSummary, listVerdicts, getFindingDetail, listRuns, listOtherEvents,
  getVersion, listProjectCards, SchemaOutdated, QueueCountMismatch,
} from "./api.ts";
import type { VerdictFilters } from "./api.ts";
import { applyReview } from "./review-write.ts";
import type { ReviewFailure } from "./review-write.ts";

const WEB_ROOT = join(import.meta.dirname, "..", "..", "web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2",
};

export function startServer(
  opts: {
    storePath: string; port: number; host?: string; webRoot?: string;
    /**
     * Read-side seam. Production always uses `openStoreReadonly`; it exists so
     * the queue-count tripwire — which a healthy store cannot trip, the `review`
     * CHECK constraint makes the identity a tautology — is still reachable in a
     * test. Same role as `webRoot`.
     */
    openRead?: (path: string) => ReadStore;
  },
): Promise<Server> {
  // Lazy handle: the server must come up before the store exists (spec §7) and
  // start serving data the moment the first audit run creates the file.
  const openRead = opts.openRead ?? openStoreReadonly;
  let store: ReadStore | null = null;
  const getStore = (): ReadStore | null => {
    if (store !== null) return store;
    if (!existsSync(opts.storePath)) return null;
    store = openRead(opts.storePath);
    return store;
  };

  const webRoot = opts.webRoot ?? WEB_ROOT;
  const server = createHttpServer((req, res) => {
    try { route(req, res, getStore, opts.storePath, webRoot); }
    catch (err) { fail(res, err); }
  });
  const origClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    store?.close(); store = null;
    return origClose(cb);
  }) as Server["close"];
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(server));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof SchemaOutdated) { json(res, 200, { schemaOutdated: true }); return; }
  if (err instanceof QueueCountMismatch) {
    json(res, 500, {
      error: "queue_count_mismatch",
      counts: err.counts,
      message: "Kuyruk sayıları tutmuyor; liste eksik satır gösteriyor olabilir.",
    });
    return;
  }
  json(res, 500, { error: "internal" });
}

const REVIEW_ROUTE = /^\/api\/verdicts\/(\d+)\/review$/;

function route(
  req: IncomingMessage, res: ServerResponse,
  getStore: () => ReadStore | null, storePath: string, webRoot: string,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  const review = REVIEW_ROUTE.exec(path);
  if (review !== null && method === "POST") {
    handleReview(req, res, storePath, Number(review[1]));
    return;
  }
  // Everything else is a read. OPTIONS lands here too and gets a plain 405 with
  // no CORS headers — a preflight is never granted, which is what makes the
  // mandatory X-CP-Review header an actual CSRF gate (design §3).
  if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return; }

  if (path.startsWith("/api/")) {
    const store = getStore();
    if (store === null) { json(res, 200, { storeMissing: true, path: storePath }); return; }
    if (path === "/api/summary") { json(res, 200, getSummary(store)); return; }
    if (path === "/api/projects") { json(res, 200, listProjectCards(store)); return; }
    if (path === "/api/verdicts") {
      const filters: VerdictFilters = {};
      for (const key of ["verdict", "subReason", "source", "review"] as const) {
        const v = url.searchParams.get(key);
        if (v !== null && v !== "") filters[key] = v;
      }
      const limit = url.searchParams.get("limit");
      if (limit !== null) filters.limit = Number(limit) || undefined;
      json(res, 200, listVerdicts(store, filters)); return;
    }
    const m = /^\/api\/findings\/(\d+)$/.exec(path);
    if (m !== null) {
      const d = getFindingDetail(store, Number(m[1]));
      if (d === undefined) json(res, 404, { error: "not found" });
      else json(res, 200, d);
      return;
    }
    if (path === "/api/runs") {
      json(res, 200, { runs: listRuns(store), events: listOtherEvents(store) }); return;
    }
    if (path === "/api/version") { json(res, 200, getVersion(store)); return; }
    json(res, 404, { error: "not found" }); return;
  }
  serveStatic(path === "/" ? "/index.html" : path, res, webRoot);
}

const MAX_REVIEW_BODY = 8 * 1024;

const REVIEW_STATUS: Record<ReviewFailure, number> = {
  not_found: 404,
  superseded: 409,
  store_missing: 409,
};

const REVIEW_MESSAGE: Record<ReviewFailure, string> = {
  not_found: "Bu hüküm bulunamadı.",
  superseded: "Bu hüküm daha yeni bir ölçümle geçersiz kılınmış.",
  store_missing: "Depo dosyası bulunamadı; henüz hiç denetim koşmamış olabilir.",
};

/**
 * The HTTP end is a thin adapter: the decision logic lives in `applyReview`,
 * which knows nothing about requests. Tauri calls that core directly.
 */
function handleReview(
  req: IncomingMessage, res: ServerResponse, storePath: string, verdictId: number,
): void {
  // CSRF gate: a cross-origin page cannot set a custom header without a
  // preflight, and no preflight is ever answered.
  if (req.headers["x-cp-review"] !== "1") {
    json(res, 403, { error: "forbidden", message: "İnceleme başlığı eksik." });
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let answered = false;
  const answer = (status: number, body: unknown): void => {
    if (answered) return;
    answered = true;
    json(res, status, body);
  };

  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_REVIEW_BODY) {
      answer(400, { error: "bad_request", message: "İstek gövdesi çok büyük." });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("error", () => answer(400, { error: "bad_request", message: "İstek okunamadı." }));
  req.on("end", () => {
    if (answered) return;
    let decision: unknown;
    try {
      decision = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { decision?: unknown })?.decision;
    } catch {
      answer(400, { error: "bad_request", message: "Gövde geçerli JSON değil." });
      return;
    }
    // `pending` is the undo (design §7b), so it is a legal decision here.
    if (decision !== "approved" && decision !== "rejected" && decision !== "pending") {
      answer(400, { error: "bad_request", message: "Karar 'approved', 'rejected' ya da 'pending' olmalı." });
      return;
    }
    try {
      const result = applyReview(storePath, verdictId, decision);
      if (result.ok) { answer(200, { ok: true, row: result.row }); return; }
      answer(REVIEW_STATUS[result.code], {
        ok: false,
        code: result.code,
        message: REVIEW_MESSAGE[result.code],
        ...(result.code === "store_missing" ? { storeMissing: true, path: storePath } : {}),
      });
    } catch (err) {
      fail(res, err);
    }
  });
}

function serveStatic(path: string, res: ServerResponse, webRoot: string): void {
  const target = normalize(join(webRoot, decodeURIComponent(path)));
  const type = MIME[extname(target)];
  if (!(target === webRoot || target.startsWith(webRoot + sep)) || type === undefined || !existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(target));
}
