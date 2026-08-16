# Keşif Gezgini (M5 v1) Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Depodaki hükümleri, kanıtları ve koşum davranışını gösteren salt-okunur yerel web gezgini (`context-police serve`).

**Architecture:** `node:http` sunucusu `core/src/serve/` altında JSON API + `core/web/` statik dosyalarını servis eder; depo bağlantısı `db.ts`'e eklenen readonly açılıştan gelir ve yazım fiziken imkânsızdır. Sayfa vanilla ES modules, build yok, dış istek yok.

**Tech Stack:** Node 24 (`node:http`, `node:sqlite`, `node:test`), native TS type-stripping, vanilla HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-08-16-kesif-gezgini-design.md`

## Global Constraints

- **Sıfır runtime bağımlılık** — `package.json dependencies` boş kalır; hiçbir npm paketi eklenmez.
- **K12: yalnız `core/src/store/db.ts` `node:sqlite` import eder** — readonly açılış da oraya eklenir.
- **Salt-okunur:** serve yolunda `openStore` HİÇ çağrılmaz (şema/migrate koşmaz); yalnız `openStoreReadonly`.
- Sunucu yalnız `127.0.0.1`'e bağlanır; varsayılan port **4870**; poll aralığı **3000 ms**.
- **Sayfadan dış istek yok** — web fontu, CDN, hiçbir şey; sayfa çevrimdışı çalışır.
- Kod, identifier ve kod içi yorumlar İngilizce; commit mesajları İngilizce; `Co-Authored-By`/"Generated with" YOK.
- **Subagent git yazma komutu ÇALIŞTIRMAZ** (add/commit/checkout/stash) — commit'i ana döngü atar; plandaki "Commit" adımları ana döngünün işidir.
- Yorum kalibrasyonu: kodun söyleyemediğini taşıyan yorum kalır, kodu tekrar eden yazılmaz.
- Test komutları `core/` içinden: `npm test`, `npm run typecheck`. Tek dosya: `node --test --disable-warning=ExperimentalWarning test/<dosya>.test.ts`.
- DOM'a veri yerleştirirken **daima `textContent`/`createElement`** — `innerHTML`'e veri interpolasyonu yasak (not içerikleri güvenilmez metindir).
- `tsconfig.json` `include` beyaz-listesi `src/**` + `test/**`; `core/web/` altına `.ts` konmaz, typecheck'e girmez.

---

### Task 1: Readonly store opening (`db.ts`)

**Files:**
- Modify: `core/src/store/db.ts` (dosya sonuna ekle)
- Test: `core/test/read-store.test.ts` (yeni)

**Interfaces:**
- Consumes: `db.ts`'teki mevcut `Row`, `SqlValue` tipleri ve `DatabaseSync` importu.
- Produces: `export interface ReadStore { get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined; all<T = Row>(sql: string, ...params: SqlValue[]): T[]; close(): void; }` ve `export function openStoreReadonly(path: string): ReadStore`. Sonraki tüm görevler depoyu bu tiple okur.

- [ ] **Step 1: Write the failing test**

`core/test/read-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, openStoreReadonly } from "../src/store/db.ts";
import { appendFinding } from "../src/store/findings.ts";
import { tmpStorePath } from "./helpers.ts";

function seedFile(): string {
  const path = tmpStorePath();
  const store = openStore(path);
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)",
    "/p", "claude-code", "/t",
  ).lastInsertRowid);
  appendFinding(store, {
    projectId, source: "imported", content: "DURUM: eski",
    sourceRef: "n.md", anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });
  store.close();
  return path;
}

test("readonly açılış var olan depoyu okur", () => {
  const path = seedFile();
  const ro = openStoreReadonly(path);
  const row = ro.get<{ content: string }>("SELECT content FROM findings WHERE id = 1");
  assert.equal(row?.content, "DURUM: eski");
  assert.equal(ro.all("SELECT id FROM projects").length, 1);
  ro.close();
});

test("readonly bağlantıdan yazmak fiziken imkânsız", () => {
  const path = seedFile();
  const ro = openStoreReadonly(path);
  assert.throws(
    () => ro.all("INSERT INTO events (at, kind) VALUES ('x','manual_test')"),
    /readonly|READONLY/,
  );
  ro.close();
});

test("olmayan dosya için açılış fırlatır (dosya YARATMAZ)", () => {
  const path = tmpStorePath();
  assert.throws(() => openStoreReadonly(path));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/read-store.test.ts`
Expected: FAIL — `openStoreReadonly` export edilmiyor.

- [ ] **Step 3: Write minimal implementation**

`core/src/store/db.ts` sonuna:

```ts
/**
 * Read-only view for the explorer (spec §4). Deliberately NOT openStore:
 * no schema apply, no migrate, no WAL switch, no chmod — the explorer reads
 * the store exactly as it is, and a write is physically impossible because
 * the connection itself is read-only. Lives here because of K12: this file
 * is the only importer of node:sqlite.
 */
export interface ReadStore {
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  close(): void;
}

export function openStoreReadonly(path: string): ReadStore {
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
      return db.prepare(sql).all(...params) as T[];
    },
    close(): void { db.close(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/read-store.test.ts`
Expected: PASS (3/3). Ardından `npm run typecheck` → rc=0.

- [ ] **Step 5: Commit** *(ana döngü)*

```bash
git add core/src/store/db.ts core/test/read-store.test.ts
git commit -m "Add read-only store opening for the explorer"
```

---

### Task 2: API sorgu katmanı (`api.ts`)

**Files:**
- Create: `core/src/serve/api.ts`
- Test: `core/test/serve-api.test.ts`

**Interfaces:**
- Consumes: `ReadStore`, `openStoreReadonly` (Task 1); `VerdictValue` tipi `../store/verdicts.ts`'ten (`import type`).
- Produces (Task 3'ün kullandığı adlar, hepsi `api.ts`'ten export):

```ts
export class SchemaOutdated extends Error {}   // eski şemalı depo sinyali

export type Summary = {
  counts: Partial<Record<VerdictValue, number>>;  // canlı hükümler
  pending: number;                                // review='pending' canlı
  findings: number;
  projects: { id: number; path: string }[];
};
export type VerdictRow = {
  id: number; findingId: number; claimRef: string; verdict: VerdictValue;
  subReason: string | null; source: string; review: string;
  repeatCount: number; createdAt: string; suspicion: number;
  findingStatus: string; preview: string;   // findings.content ilk 160 karakter
};
export type VerdictFilters = {
  verdict?: string; subReason?: string; source?: string; review?: string; limit?: number;
};
export type ClaimView = {
  claimRef: string;
  live: VerdictDetail | null;
  history: VerdictDetail[];   // superseded dahil, eskiden yeniye
};
export type VerdictDetail = {
  id: number; verdict: VerdictValue; subReason: string | null;
  decayType: string | null; evidence: string | null; method: string | null;
  correction: string | null; source: string; runId: string; createdAt: string;
  review: string; reviewedAt: string | null; supersededBy: number | null;
  repeatCount: number;
};
export type FindingDetail = {
  id: number; projectId: number; content: string; sourceRef: string | null;
  createdAt: string; status: string; suspicion: number; supersededBy: number | null;
  anchors: { kind: string; value: string; takenAtCommit: string | null }[];
  claims: ClaimView[];
};
export type RunView = {
  eventId: number; at: string; projectId: number | null;
  detail: Record<string, unknown> | null;   // audit_completed detail JSON'u
};
export type Version = { maxVerdictId: number; maxEventId: number };

export function getSummary(store: ReadStore): Summary;
export function listVerdicts(store: ReadStore, filters?: VerdictFilters): VerdictRow[];
export function getFindingDetail(store: ReadStore, id: number): FindingDetail | undefined;
export function listRuns(store: ReadStore, limit?: number): RunView[];
export function listOtherEvents(store: ReadStore, limit?: number): { id: number; at: string; kind: string; projectId: number | null }[];
export function getVersion(store: ReadStore): Version;
```

Kurallar: her fonksiyon SQLite'ın `no such table` / `no such column` hatasını yakalayıp `SchemaOutdated` fırlatır (spec §7 — eski şemalı depo). Varsayılan sıralama `listVerdicts`'te `suspicion DESC, id DESC`, `limit` varsayılan 200. Filtre değerleri parametre olarak bağlanır (string birleştirme YOK).

- [ ] **Step 1: Write the failing test**

`core/test/serve-api.test.ts` (fixture: gerçek yazıcıyla kur, readonly aç):

```ts
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
```

NOT (test yazarına): dosya başındaki `node:sqlite` importu K12'nin ("yalnız db.ts") bilinçli tek istisnasıdır ve yalnız TESTTE, eski-şema fixture'ı üretmek içindir; üretim koduna sqlite importu girmez.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/serve-api.test.ts`
Expected: FAIL — `../src/serve/api.ts` yok.

- [ ] **Step 3: Write minimal implementation**

`core/src/serve/api.ts` — Interfaces bloğundaki tipler + şu gövdeler:

```ts
import type { ReadStore } from "../store/db.ts";
import type { VerdictValue } from "../store/verdicts.ts";

export class SchemaOutdated extends Error {
  constructor() { super("store schema is older than this explorer"); }
}

// Wraps every query: an old store must surface as a structured warning
// (spec §7), not as a 500 with a raw sqlite message.
function guard<T>(fn: () => T): T {
  try { return fn(); } catch (err) {
    if (err instanceof Error && /no such (table|column)/i.test(err.message)) {
      throw new SchemaOutdated();
    }
    throw err;
  }
}

const VERDICT_COLS = `v.id, v.finding_id, v.claim_ref, v.verdict, v.sub_reason,
  v.decay_type, v.evidence, v.method, v.correction, v.source, v.run_id,
  v.created_at, v.review, v.reviewed_at, v.superseded_by, v.repeat_count`;

function toDetail(r: Record<string, unknown>): VerdictDetail {
  return {
    id: r["id"] as number, verdict: r["verdict"] as VerdictValue,
    subReason: r["sub_reason"] as string | null, decayType: r["decay_type"] as string | null,
    evidence: r["evidence"] as string | null, method: r["method"] as string | null,
    correction: r["correction"] as string | null, source: r["source"] as string,
    runId: r["run_id"] as string, createdAt: r["created_at"] as string,
    review: r["review"] as string, reviewedAt: r["reviewed_at"] as string | null,
    supersededBy: r["superseded_by"] as number | null,
    repeatCount: r["repeat_count"] as number,
  };
}

export function getSummary(store: ReadStore): Summary {
  return guard(() => {
    const counts: Partial<Record<VerdictValue, number>> = {};
    for (const row of store.all<{ verdict: VerdictValue; c: number }>(
      "SELECT verdict, COUNT(*) c FROM verdicts WHERE superseded_by IS NULL GROUP BY verdict",
    )) counts[row.verdict] = row.c;
    const pending = store.get<{ c: number }>(
      "SELECT COUNT(*) c FROM verdicts WHERE superseded_by IS NULL AND review = 'pending'",
    )?.c ?? 0;
    const findings = store.get<{ c: number }>("SELECT COUNT(*) c FROM findings")?.c ?? 0;
    const projects = store.all<{ id: number; path: string }>(
      "SELECT id, path FROM projects ORDER BY path",
    );
    return { counts, pending, findings, projects };
  });
}

export function listVerdicts(store: ReadStore, filters: VerdictFilters = {}): VerdictRow[] {
  return guard(() => {
    const where = ["v.superseded_by IS NULL"];
    const params: (string | number)[] = [];
    for (const [key, col] of [
      ["verdict", "v.verdict"], ["subReason", "v.sub_reason"],
      ["source", "v.source"], ["review", "v.review"],
    ] as const) {
      const val = filters[key];
      if (val !== undefined) { where.push(`${col} = ?`); params.push(val); }
    }
    params.push(filters.limit ?? 200);
    return store.all<Record<string, unknown>>(
      `SELECT v.id, v.finding_id, v.claim_ref, v.verdict, v.sub_reason, v.source,
              v.review, v.repeat_count, v.created_at,
              f.suspicion, f.status AS finding_status, substr(f.content, 1, 160) AS preview
       FROM verdicts v JOIN findings f ON f.id = v.finding_id
       WHERE ${where.join(" AND ")}
       ORDER BY f.suspicion DESC, v.id DESC LIMIT ?`, ...params,
    ).map((r) => ({
      id: r["id"] as number, findingId: r["finding_id"] as number,
      claimRef: r["claim_ref"] as string, verdict: r["verdict"] as VerdictValue,
      subReason: r["sub_reason"] as string | null, source: r["source"] as string,
      review: r["review"] as string, repeatCount: r["repeat_count"] as number,
      createdAt: r["created_at"] as string, suspicion: r["suspicion"] as number,
      findingStatus: r["finding_status"] as string, preview: r["preview"] as string,
    }));
  });
}

export function getFindingDetail(store: ReadStore, id: number): FindingDetail | undefined {
  return guard(() => {
    const f = store.get<Record<string, unknown>>("SELECT * FROM findings WHERE id = ?", id);
    if (f === undefined) return undefined;
    const anchors = store.all<Record<string, unknown>>(
      "SELECT kind, value, taken_at_commit FROM anchors WHERE finding_id = ?", id,
    ).map((a) => ({
      kind: a["kind"] as string, value: a["value"] as string,
      takenAtCommit: a["taken_at_commit"] as string | null,
    }));
    const all = store.all<Record<string, unknown>>(
      `SELECT ${VERDICT_COLS} FROM verdicts v WHERE v.finding_id = ? ORDER BY v.id`, id,
    ).map(toDetail);
    const byClaim = new Map<string, VerdictDetail[]>();
    for (const v of all) {
      const key = (store.get<{ claim_ref: string }>(
        "SELECT claim_ref FROM verdicts WHERE id = ?", v.id,
      ))!.claim_ref;
      const list = byClaim.get(key) ?? [];
      list.push(v); byClaim.set(key, list);
    }
    const claims: ClaimView[] = [...byClaim.entries()].map(([claimRef, history]) => ({
      claimRef,
      live: history.find((v) => v.supersededBy === null) ?? null,
      history,
    }));
    return {
      id: f["id"] as number, projectId: f["project_id"] as number,
      content: f["content"] as string, sourceRef: f["source_ref"] as string | null,
      createdAt: f["created_at"] as string, status: f["status"] as string,
      suspicion: f["suspicion"] as number, supersededBy: f["superseded_by"] as number | null,
      anchors, claims,
    };
  });
}

export function listRuns(store: ReadStore, limit = 50): RunView[] {
  return guard(() => store.all<Record<string, unknown>>(
    "SELECT id, project_id, at, detail FROM events WHERE kind = 'audit_completed' ORDER BY id DESC LIMIT ?",
    limit,
  ).map((r) => {
    let detail: Record<string, unknown> | null = null;
    try { detail = JSON.parse((r["detail"] as string | null) ?? "null"); } catch { /* keep null: a run row with broken JSON must still render */ }
    return {
      eventId: r["id"] as number, at: r["at"] as string,
      projectId: r["project_id"] as number | null, detail,
    };
  }));
}

export function listOtherEvents(store: ReadStore, limit = 100) {
  return guard(() => store.all<Record<string, unknown>>(
    "SELECT id, at, kind, project_id FROM events ORDER BY id DESC LIMIT ?", limit,
  ).map((r) => ({
    id: r["id"] as number, at: r["at"] as string,
    kind: r["kind"] as string, projectId: r["project_id"] as number | null,
  })));
}

export function getVersion(store: ReadStore): Version {
  return guard(() => ({
    maxVerdictId: store.get<{ m: number }>("SELECT COALESCE(MAX(id),0) m FROM verdicts")?.m ?? 0,
    maxEventId: store.get<{ m: number }>("SELECT COALESCE(MAX(id),0) m FROM events")?.m ?? 0,
  }));
}
```

(Uygulayan not: `getFindingDetail`'daki claim_ref'i ikinci sorguyla çekmek yerine `toDetail`'a `claimRef` alanı eklemek serbest — testler davranışı ölçer, iç yapıyı değil. Tip tanımları Interfaces bloğundakiyle birebir aynı olmalı.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/serve-api.test.ts`
Expected: PASS (6/6). `npm run typecheck` → rc=0. `npm test` → tam takım yeşil.

- [ ] **Step 5: Commit** *(ana döngü)*

```bash
git add core/src/serve/api.ts core/test/serve-api.test.ts
git commit -m "Add read-only query layer for the explorer API"
```

---

### Task 3: HTTP sunucu (`serve.ts`)

**Files:**
- Create: `core/src/serve/serve.ts`
- Create: `core/web/index.html` (iskelet — Task 5 dolduracak, burada yalnız statik servis testi için minimal içerik)
- Test: `core/test/serve-http.test.ts`

**Interfaces:**
- Consumes: Task 2'nin tüm API fonksiyonları + `SchemaOutdated`; `openStoreReadonly` (Task 1).
- Produces: `export function startServer(opts: { storePath: string; port: number; host?: string }): Promise<import("node:http").Server>` — Task 4 (CLI) bunu çağırır. Sunucu kapanırken açık ReadStore'u kapatır (`server.close` sarmalanır). API sözleşmesi (Task 5-7'nin istemcisi bunu tüketir):
  - `GET /api/summary` → `Summary`
  - `GET /api/verdicts?verdict=&subReason=&source=&review=&limit=` → `VerdictRow[]`
  - `GET /api/findings/:id` → `FindingDetail` | 404 `{error:"not found"}`
  - `GET /api/runs` → `{ runs: RunView[], events: {...}[] }`
  - `GET /api/version` → `Version`
  - Depo dosyası yoksa her `/api/*` → 200 `{ storeMissing: true, path: string }`
  - Depo eski şemalıysa → 200 `{ schemaOutdated: true }`
  - `/` ve statik dosyalar `core/web/`'den; kaçış (`..`) → 404; bilinmeyen yol → 404.

Davranış kuralları:
- **Depo bağlantısı tembel:** sunucu depo dosyası yokken de açılır (spec §7). Her istekte: bağlantı açıksa kullan; değilse `existsSync` + `openStoreReadonly` dene; olmuyorsa `storeMissing` cevabı. Böylece sonradan koşan ilk `audit` depoyu yaratınca sayfa kendiliğinden dolar.
- Sunucu `host` varsayılanı `"127.0.0.1"` — başka değere bağlanma yolu bilerek yok.
- Statik servis: `path.normalize` sonrası hedefin `webRoot` ile başladığı doğrulanır; content-type haritası `.html/.js/.css/.svg/.png` ile sınırlı.

- [ ] **Step 1: Write the failing test**

`core/test/serve-http.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { openStore } from "../src/store/db.ts";
import { appendFinding } from "../src/store/findings.ts";
import { recordVerdict } from "../src/store/verdicts.ts";
import { tmpStorePath, tmpDir } from "./helpers.ts";
import { startServer } from "../src/serve/serve.ts";

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
    const s = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(s.counts["curuk"], 1);
    const rows = await (await fetch(`${base}/api/verdicts?verdict=curuk`)).json();
    assert.equal(rows.length, 1);
    const d = await (await fetch(`${base}/api/findings/${rows[0].findingId}`)).json();
    assert.equal(d.claims[0].live.verdict, "curuk");
    const v = await (await fetch(`${base}/api/version`)).json();
    assert.equal(v.maxVerdictId, 1);
  });
});

test("depo yokken sunucu açılır ve storeMissing döner", async () => {
  const missing = tmpStorePath(); // path exists as a name only; file never created
  await withServer(missing, async (base) => {
    const s = await (await fetch(`${base}/api/summary`)).json();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/serve-http.test.ts`
Expected: FAIL — `serve.ts` yok.

- [ ] **Step 3: Write minimal implementation**

`core/src/serve/serve.ts`:

```ts
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, extname } from "node:path";
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
  if (!target.startsWith(WEB_ROOT) || type === undefined || !existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(target));
}
```

`core/web/index.html` (iskelet — Task 5 gerçek içeriği yazar):

```html
<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Context Police</title></head>
<body><p>keşif gezgini iskeleti</p></body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/serve-http.test.ts`
Expected: PASS (4/4). `npm run typecheck` → rc=0. `npm test` → tam takım yeşil.

- [ ] **Step 5: Commit** *(ana döngü)*

```bash
git add core/src/serve/serve.ts core/web/index.html core/test/serve-http.test.ts
git commit -m "Add local HTTP server for the explorer"
```

---

### Task 4: CLI `serve` komutu

**Files:**
- Modify: `core/src/cli.ts` (COMMANDS tablosu `cli.ts:83-98`, dispatch zinciri `cli.ts:639-671`, usage metni `cli.ts:673-704`)
- Test: `core/test/serve-cli.test.ts`

**Interfaces:**
- Consumes: `startServer` (Task 3), mevcut `arg`/`parseArgs`/`onInterrupt`/`defaultStorePath` kalıpları.
- Produces: `context-police serve [--store <yol>] [--port <n>]` komutu. Port varsayılanı 4870; port doluysa (EADDRINUSE) stderr'e portu ve `--port` çözümünü söyleyen mesaj + `process.exitCode = 1`.

- [ ] **Step 1: Write the failing test**

`core/test/serve-cli.test.ts` (CLI alt süreç kalıbı `audit-m3-cli.test.ts:31-32`'den):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openStore } from "../src/store/db.ts";
import { tmpStorePath } from "./helpers.ts";

const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");

test("serve komutu açılır, summary servis eder, SIGTERM ile kapanır", async () => {
  const path = tmpStorePath();
  openStore(path).close(); // boş ama gerçek depo
  const port = 4899;
  const child = spawn(process.execPath,
    ["--disable-warning=ExperimentalWarning", cliPath, "serve", "--store", path, "--port", String(port)],
    { stdio: ["ignore", "pipe", "pipe"] });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(200);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/summary`);
        up = r.status === 200;
      } catch { /* not yet */ }
    }
    assert.ok(up, "sunucu 10 sn içinde ayağa kalkmadı");
  } finally {
    child.kill("SIGTERM");
    await new Promise((res) => child.once("exit", res));
  }
});

test("bilinmeyen seçenek reddedilir", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", cliPath, "serve", "--bogus", "1"],
    { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/serve-cli.test.ts`
Expected: FAIL — `serve` bilinmeyen komut (usage'a düşer, summary hiç dönmez).

- [ ] **Step 3: Write minimal implementation**

`cli.ts` içinde üç dokunuş:

1. `COMMANDS`'a: `serve: { values: ["store", "port"], flags: [] },`
2. Komut fonksiyonu (`cmdStatus` kalıbı):

```ts
async function cmdServe(): Promise<void> {
  const storePath = arg("store") ?? defaultStorePath();
  const rawPort = arg("port");
  const port = rawPort === undefined ? 4870 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`gecersiz port: ${safe(rawPort ?? "")}`);
  }
  let server;
  try {
    server = await startServer({ storePath, port });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
      console.error(`port ${port} dolu; --port <n> ile baska port verin`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  console.log(`kesif gezgini: http://127.0.0.1:${port} (depo: ${safe(storePath, 200)})`);
  onInterrupt(() => { server.close(); });
  // Keep the process alive until a signal arrives; the interrupt hook exits.
  await new Promise(() => {});
}
```

3. Dispatch zincirine `else if (cmd === "serve") await cmdServe();`, usage metnine `serve` satırı, dosya başına `import { startServer } from "./serve/serve.ts";`.

(Uygulayan not: `UsageError`, `safe`, `onInterrupt`, `defaultStorePath` cli.ts'te zaten var — imzalarını dosyadan doğrula, yenisini yaratma. Sinyal kancası `process.exit` yaptığı için `await new Promise(() => {})` sonsuz beklemesi sızıntı değildir.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && node --test --disable-warning=ExperimentalWarning test/serve-cli.test.ts`
Expected: PASS (2/2). `npm test` tam takım + `npm run typecheck` yeşil.

- [ ] **Step 5: Commit** *(ana döngü)*

```bash
git add core/src/cli.ts core/test/serve-cli.test.ts
git commit -m "Add serve command to the CLI"
```

---

### Task 5: Web kabuğu + Kuyruk ekranı

**Files:**
- Modify: `core/web/index.html` (iskeleti gerçek kabukla değiştir)
- Create: `core/web/style.css`
- Create: `core/web/js/api.js`
- Create: `core/web/js/app.js`
- Create: `core/web/js/queue.js`
- Test: otomatik test YOK (spec §8) — doğrulama Task 8'de görsel denetimle.

**Interfaces:**
- Consumes: Task 3'ün API sözleşmesi (`/api/summary`, `/api/verdicts`, `/api/version`).
- Produces: `js/api.js` → `export async function apiGet(path)` (fetch + JSON; `storeMissing`/`schemaOutdated` alanlarını olduğu gibi geçirir). `js/app.js` → ekran yönlendirme: `#/` kuyruk, `#/finding/<id>` detay (Task 6), `#/runs` koşumlar (Task 7); 3000 ms'de bir `/api/version` poll'u, değişince aktif ekranın `refresh()`'i çağrılır. Ekran modülü sözleşmesi: `export function mount(root, ctx)` + dönen `{ refresh() }`; `ctx = { apiGet, navigate }`.

Görsel yön (spec §6 — tasarım token'ları `style.css`'te `:root` altında):

```css
:root {
  --bg: #0B1020; --panel: #131A33; --panel-2: #0E1428;
  --ink: #E8ECF8; --muted: #8A93B2; --border: #26305A;
  --v-gecerli: #3FB27F; --v-curuk: #D97742; --v-dogustan: #A78BDA;
  --v-olculemez: #7C8DB5; --v-tarihsel: #6F7690;
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 24px; --s-6: 32px;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
}
```

Kurallar (hepsi spec §6'dan):
- Hüküm rozeti = renk + METİN (`gecerli` vb. etiket görünür; renk tek başına anlam taşımaz).
- Eyebrow etiketler: `font: 600 11px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--muted)`.
- Sayılar `font-variant-numeric: tabular-nums`; veri hücreleri `var(--mono)`.
- Dış istek yok (font/CDN yok); ikon gerekiyorsa inline SVG.
- `prefers-reduced-motion: reduce` altında tüm transition'lar kapanır.
- Tablolar `overflow-x: auto` sarmalayıcıda; klavye odağı `outline: 2px solid var(--ink)` görünür.

Kuyruk ekranı (`js/queue.js`):
- Üst şerit: 5 hüküm sayacı (`getSummary().counts`) — her biri tıklanabilir buton, tıklanınca o hüküm filtresiyle liste yenilenir; aktif filtre görsel olarak işaretli.
- Filtre çubuğu: hüküm (5'li), `source`, `review` için `<select>`; `subReason` için metin girişi.
- Tablo sütunları: skor (tabular, 2 hane) · not önizleme (preview) · `claimRef` (boşsa "not geneli") · hüküm rozeti · `subReason` · `repeatCount` (>1 ise "×N" rozeti) · `source` · tarih (kısa).
- Satıra tıklama → `navigate('#/finding/' + row.findingId)`.
- Boş durumlar (spec §7): `storeMissing` → "Depo bulunamadı: <yol> — `context-police audit` bir koşum sonra burayı doldurur." · `schemaOutdated` → "Depo bu gezginden eski — `context-police audit` bir kez koşunca güncellenir." · boş liste → "Bu filtrede hüküm yok."
- TÜM veri yerleştirmeleri `textContent` / `createElement` ile; `innerHTML` yalnız statik (verisiz) iskelet parçalarında.

- [ ] **Step 1: `js/api.js` + `js/app.js` + kabuk `index.html` yaz** — yukarıdaki sözleşmeyle. `index.html`: başlık çubuğu ("CONTEXT POLICE" eyebrow + depo yolu), üç sekme linki (`#/`, `#/runs`), `<main id="root">`, `<script type="module" src="/js/app.js">`.
- [ ] **Step 2: `style.css` yaz** — token bloğu + tablo/rozet/şerit/panel sınıfları + odak/reduced-motion kuralları.
- [ ] **Step 3: `js/queue.js` yaz** — yukarıdaki davranışlarla.
- [ ] **Step 4: El doğrulaması** — `cd core && node --disable-warning=ExperimentalWarning src/cli.ts serve --store <Task 2 fixture'ı gibi doldurulmuş geçici depo> --port 4870` koş; `curl -s http://127.0.0.1:4870/ | head -5` HTML dönüyor, `curl` ile `/style.css` ve `/js/app.js` 200. (Fixture depo üretmek için `node --disable-warning=ExperimentalWarning --eval` ile Task 2'deki seed kodunun eşdeğerini geçici bir dosyaya yazıp koşmak serbest — geçici dosya scratchpad'e, işi bitince silinir.)
- [ ] **Step 5: Commit** *(ana döngü)*

```bash
git add core/web/
git commit -m "Add explorer shell and queue screen"
```

---

### Task 6: Not detayı ekranı (silinmeyen sicil)

**Files:**
- Create: `core/web/js/detail.js`
- Modify: `core/web/js/app.js` (route kaydı: `#/finding/<id>` → detail)
- Modify: `core/web/style.css` (sicil zinciri stilleri)

**Interfaces:**
- Consumes: `GET /api/findings/:id` → `FindingDetail` (Task 2 tip yapısı); ekran modülü sözleşmesi (Task 5).
- Produces: `js/detail.js` → `export function mount(root, ctx, findingId)` + `{ refresh() }`.

Davranış (spec §3.2 + §6):
- Üst blok: not içeriği (`content`, `white-space: pre-wrap`, mono), `sourceRef`, durum, skor, `createdAt`.
- Çapalar bölümü: kind + value + `takenAtCommit` (kısa SHA) — mono tablo; çapasızsa "Çapa yok — bu not sürüklenme sinyali üretemez." satırı.
- **İddia başına sicil kartı (imza öğesi):** en üstte canlı hüküm (tam renk rozet + kanıt + yöntem + varsa `correction` "önerilen düzeltme" kutusunda); altında tarihsel kayıtlar eskiden yeniye, **üstü çizili değil ama soluk (opacity ~0.55) + sol kenar çizgili + hüküm etiketi `text-decoration: line-through`**; her tarihsel kaydın yanında hangi kayıtla değiştirildiği (`superseded_by` → `#id`) ve tarihi. Hiçbir kayıt gizlenmez, "daha eski N kayıt" katlaması YOK (v1'de zincirler kısa).
- `repeatCount > 1` canlı kayıtta "×N koşum aynı sonucu ölçtü" satırı olarak gösterilir.
- 404 → "Bulgu bulunamadı" + kuyruk linki.
- Tüm veri `textContent` ile.

- [ ] **Step 1: `js/detail.js` yaz** — yukarıdaki davranışlarla; `app.js`'e route ekle; `style.css`'e `.ledger`, `.ledger-old`, `.correction` sınıfları.
- [ ] **Step 2: El doğrulaması** — Task 5'teki fixture depoyla serve; tarayıcıda/`curl` ile `/api/findings/1` dolu dönüyor; supersession'lı fixture'da zincir iki kayıt gösteriyor (görsel onay Task 8'de).
- [ ] **Step 3: Commit** *(ana döngü)*

```bash
git add core/web/
git commit -m "Add finding detail screen with the immutable ledger"
```

---

### Task 7: Koşumlar ekranı

**Files:**
- Create: `core/web/js/runs.js`
- Modify: `core/web/js/app.js` (route: `#/runs`)

**Interfaces:**
- Consumes: `GET /api/runs` → `{ runs: RunView[], events }` (Task 2/3).
- Produces: `js/runs.js` → `export function mount(root, ctx)` + `{ refresh() }`.

Davranış:
- Üstte koşum kartları (yeniden eskiye): `at` (yerel saat) + `detail` JSON'unun anahtar-değerleri iki sütunlu mono tablo (anahtar adları olduğu gibi: `verdictsRecorded`, `starvedFindings` vb. — çeviri YOK, bunlar koddaki adlar). `detail` null ise "detay çözülemedi (bozuk JSON)" satırı — sessiz atlama yok (spec §7 ruhu).
- Altında "diğer olaylar" başlığıyla ham olay listesi: id · at · kind (mono), `kind`'a göre istemci tarafı metin filtresi.
- Boş durum: "Henüz koşum yok — `context-police audit` ilk satırı yazar."

- [ ] **Step 1: `js/runs.js` yaz**, `app.js`'e route ekle.
- [ ] **Step 2: El doğrulaması** — fixture depoda `audit_completed` olayı görünüyor (`curl /api/runs`).
- [ ] **Step 3: Commit** *(ana döngü)*

```bash
git add core/web/
git commit -m "Add runs screen"
```

---

### Task 8: Bütünleşme + görsel özdenetim *(ana döngü koşar — subagent'a verilmez)*

**Files:** yalnız okuma/doğrulama; bulunan kusurlar ilgili dosyada düzeltilir.

- [ ] **Step 1:** Tam takım: `cd core && npm test && npm run typecheck` → yeşil.
- [ ] **Step 2:** Gerçek depoyla koş: `node --disable-warning=ExperimentalWarning src/cli.ts serve` (varsayılan `~/.context-police/store.db`, READONLY — yazım imkânsız, kural ihlali yok). Üç ekran gerçek veriyle geziliyor.
- [ ] **Step 3:** Playwright MCP ile `http://127.0.0.1:4870` ekran görüntüsü; frontend-design özdenetimi: imza öğesi (sicil zinciri) gerçekten merkezde mi, kontrast 4.5:1 sağlanıyor mu, klişe-görünüm testi. Kusurlar not edilir ve düzeltilir.
- [ ] **Step 4:** Spec §7 hata durumları elle: olmayan depo yolu ile serve → sayfa yönlendirici mesaj; port çakışması → net hata.
- [ ] **Step 5:** Sunucuyu kapat, geçici fixture dosyalarını sil (temizlik zorunlu adım). Son commit *(ana döngü)*: kalan düzeltmeler + bu planın işaretlenmiş hali.
