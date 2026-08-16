import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, extname, sep } from "node:path";
import { openStoreReadonly } from "../store/db.ts";
import type { ReadStore } from "../store/db.ts";
import {
  getSummary, listVerdicts, getFindingDetail, listRuns, listOtherEvents,
  getVersion, SchemaOutdated,
} from "./api.ts";
import type { VerdictFilters } from "./api.ts";

const WEB_ROOT = join(import.meta.dirname, "..", "..", "web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
};

export function startServer(
  opts: { storePath: string; port: number; host?: string },
): Promise<Server> {
  // Lazy handle: the server must come up before the store exists (spec §7) and
  // start serving data the moment the first audit run creates the file.
  let store: ReadStore | null = null;
  const getStore = (): ReadStore | null => {
    if (store !== null) return store;
    if (!existsSync(opts.storePath)) return null;
    store = openStoreReadonly(opts.storePath);
    return store;
  };

  const server = createHttpServer((req, res) => {
    try { route(req, res, getStore, opts.storePath); }
    catch (err) {
      if (err instanceof SchemaOutdated) json(res, 200, { schemaOutdated: true });
      else json(res, 500, { error: "internal" });
    }
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

function route(
  req: IncomingMessage, res: ServerResponse,
  getStore: () => ReadStore | null, storePath: string,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    const store = getStore();
    if (store === null) { json(res, 200, { storeMissing: true, path: storePath }); return; }
    if (path === "/api/summary") { json(res, 200, getSummary(store)); return; }
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
  serveStatic(path === "/" ? "/index.html" : path, res);
}

function serveStatic(path: string, res: ServerResponse): void {
  const target = normalize(join(WEB_ROOT, decodeURIComponent(path)));
  const type = MIME[extname(target)];
  if (!(target === WEB_ROOT || target.startsWith(WEB_ROOT + sep)) || type === undefined || !existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(target));
}
