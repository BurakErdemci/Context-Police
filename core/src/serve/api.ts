import { basename } from "node:path";
import type { ReadStore } from "../store/db.ts";
import type { VerdictValue } from "../store/verdicts.ts";
import { WHOLE_NOTE } from "../store/verdicts.ts";
import { diagnose } from "./diagnose.ts";
import type { Diagnosis } from "./diagnose.ts";

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

export type Summary = {
  counts: Partial<Record<VerdictValue, number>>;
  pending: number;
  findings: number;
  projects: { id: number; path: string }[];
};

export type VerdictRow = {
  id: number;
  findingId: number;
  projectId: number;
  claimRef: string;
  verdict: VerdictValue;
  subReason: string | null;
  source: string;
  review: string;
  repeatCount: number;
  createdAt: string;
  suspicion: number;
  findingStatus: string;
  preview: string;
  diagnosis: Diagnosis;
};

export type VerdictFilters = {
  verdict?: string;
  subReason?: string;
  source?: string;
  review?: string;
  limit?: number;
};

export type VerdictDetail = {
  id: number;
  verdict: VerdictValue;
  subReason: string | null;
  decayType: string | null;
  evidence: string | null;
  method: string | null;
  correction: string | null;
  source: string;
  runId: string;
  createdAt: string;
  review: string;
  reviewedAt: string | null;
  supersededBy: number | null;
  repeatCount: number;
};

export type ClaimView = {
  claimRef: string;
  live: VerdictDetail | null;
  history: VerdictDetail[];
};

export type FindingDetail = {
  id: number;
  projectId: number;
  content: string;
  sourceRef: string | null;
  createdAt: string;
  status: string;
  suspicion: number;
  supersededBy: number | null;
  anchors: { kind: string; value: string; takenAtCommit: string | null }[];
  claims: ClaimView[];
  diagnosis: Diagnosis;
};

export type ProjectCard = {
  id: number;
  path: string;
  name: string;
  notes: number;
  suspects: number;
  pending: number;
  anchorless: number;
  clean: number;
  lastRunAt: string | null;
  runSeries: number[];
  healthPct: number;
};

export type RunView = {
  eventId: number;
  at: string;
  projectId: number | null;
  detail: Record<string, unknown> | null;
};

export type Version = {
  maxVerdictId: number;
  maxEventId: number;
};

function toDetail(r: Record<string, unknown>): VerdictDetail {
  return {
    id: r["id"] as number,
    verdict: r["verdict"] as VerdictValue,
    subReason: r["sub_reason"] as string | null,
    decayType: r["decay_type"] as string | null,
    evidence: r["evidence"] as string | null,
    method: r["method"] as string | null,
    correction: r["correction"] as string | null,
    source: r["source"] as string,
    runId: r["run_id"] as string,
    createdAt: r["created_at"] as string,
    review: r["review"] as string,
    reviewedAt: r["reviewed_at"] as string | null,
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
      ["verdict", "v.verdict"],
      ["source", "v.source"],
      ["review", "v.review"],
    ] as const) {
      const val = filters[key];
      if (val !== undefined) {
        where.push(`${col} = ?`);
        params.push(val);
      }
    }
    // subReason is a substring match (queue.js's placeholder says "alt sebep içerir…"),
    // not exact — value stays a bound parameter, only the wildcards are concatenated.
    if (filters.subReason !== undefined) {
      where.push("v.sub_reason LIKE '%' || ? || '%'");
      params.push(filters.subReason);
    }
    params.push(filters.limit ?? 200);
    return store
      .all<Record<string, unknown>>(
        // project_id comes off findings, not verdicts: findings owns the note's
        // project and the row's other fields are already read from that join.
        `SELECT ${VERDICT_COLS}, f.project_id, f.suspicion, f.status AS finding_status,
              f.content AS finding_content, substr(f.content, 1, 160) AS preview
       FROM verdicts v JOIN findings f ON f.id = v.finding_id
       WHERE ${where.join(" AND ")}
       ORDER BY f.suspicion DESC, v.id DESC LIMIT ?`,
        ...params,
      )
      .map((r) => {
        // Bounded by `limit` (default 200) — one small anchors query per row
        // is fine at this scale (spec: "fetch anchors per finding, bounded N").
        const anchors = store.all<{ kind: string; value: string }>(
          "SELECT kind, value FROM anchors WHERE finding_id = ?",
          r["finding_id"] as number,
        );
        const diagnosis = diagnose({
          content: r["finding_content"] as string,
          status: r["finding_status"] as string,
          suspicion: r["suspicion"] as number,
          verdict: toDetail(r),
          anchors,
        });
        return {
          id: r["id"] as number,
          findingId: r["finding_id"] as number,
          projectId: r["project_id"] as number,
          claimRef: r["claim_ref"] as string,
          verdict: r["verdict"] as VerdictValue,
          subReason: r["sub_reason"] as string | null,
          source: r["source"] as string,
          review: r["review"] as string,
          repeatCount: r["repeat_count"] as number,
          createdAt: r["created_at"] as string,
          suspicion: r["suspicion"] as number,
          findingStatus: r["finding_status"] as string,
          preview: r["preview"] as string,
          diagnosis,
        };
      });
  });
}

export function getFindingDetail(store: ReadStore, id: number): FindingDetail | undefined {
  return guard(() => {
    const f = store.get<Record<string, unknown>>("SELECT * FROM findings WHERE id = ?", id);
    if (f === undefined) return undefined;
    const anchors = store
      .all<Record<string, unknown>>(
        "SELECT kind, value, taken_at_commit FROM anchors WHERE finding_id = ?",
        id,
      )
      .map((a) => ({
        kind: a["kind"] as string,
        value: a["value"] as string,
        takenAtCommit: a["taken_at_commit"] as string | null,
      }));
    const all = store
      .all<Record<string, unknown>>(
        `SELECT ${VERDICT_COLS} FROM verdicts v WHERE v.finding_id = ? ORDER BY v.id`,
        id,
      )
      .map(toDetail);
    const byClaim = new Map<string, VerdictDetail[]>();
    for (const v of all) {
      const key = (store.get<{ claim_ref: string }>(
        "SELECT claim_ref FROM verdicts WHERE id = ?",
        v.id,
      ))!.claim_ref;
      const list = byClaim.get(key) ?? [];
      list.push(v);
      byClaim.set(key, list);
    }
    const claims: ClaimView[] = [...byClaim.entries()].map(([claimRef, history]) => ({
      claimRef,
      live: history.find((v) => v.supersededBy === null) ?? null,
      history,
    }));
    // The card-level diagnosis speaks about the whole note, not one claim:
    // prefer the whole-note verdict (claim_ref = WHOLE_NOTE) if it exists,
    // else fall back to whatever single claim the note carries.
    const primaryVerdict = claims.find((c) => c.claimRef === WHOLE_NOTE)?.live
      ?? claims[0]?.live
      ?? null;
    const content = f["content"] as string;
    const status = f["status"] as string;
    const suspicion = f["suspicion"] as number;
    return {
      id: f["id"] as number,
      projectId: f["project_id"] as number,
      content,
      sourceRef: f["source_ref"] as string | null,
      createdAt: f["created_at"] as string,
      status,
      suspicion,
      supersededBy: f["superseded_by"] as number | null,
      anchors,
      claims,
      diagnosis: diagnose({ content, status, suspicion, verdict: primaryVerdict, anchors }),
    };
  });
}

export function listRuns(store: ReadStore, limit = 50): RunView[] {
  return guard(() =>
    store
      .all<Record<string, unknown>>(
        "SELECT id, project_id, at, detail FROM events WHERE kind = 'audit_completed' ORDER BY id DESC LIMIT ?",
        limit,
      )
      .map((r) => {
        let detail: Record<string, unknown> | null = null;
        try {
          detail = JSON.parse((r["detail"] as string | null) ?? "null");
        } catch {
          /* keep null: a run row with broken JSON must still render */
        }
        return {
          eventId: r["id"] as number,
          at: r["at"] as string,
          projectId: r["project_id"] as number | null,
          detail,
        };
      }),
  );
}

export function listOtherEvents(store: ReadStore, limit = 100) {
  return guard(() =>
    store
      .all<Record<string, unknown>>(
        "SELECT id, at, kind, project_id FROM events ORDER BY id DESC LIMIT ?",
        limit,
      )
      .map((r) => ({
        id: r["id"] as number,
        at: r["at"] as string,
        kind: r["kind"] as string,
        projectId: r["project_id"] as number | null,
      })),
  );
}

/** Last N `audit_completed` events for a project, oldest→newest. */
const RUN_SERIES_LEN = 8;

export function listProjectCards(store: ReadStore): ProjectCard[] {
  return guard(() => {
    const projects = store.all<{ id: number; path: string }>(
      "SELECT id, path FROM projects ORDER BY path",
    );
    return projects.map((p) => {
      const notes = store.get<{ c: number }>(
        "SELECT COUNT(*) c FROM findings WHERE project_id = ? AND status != 'superseded'",
        p.id,
      )?.c ?? 0;
      const suspects = store.get<{ c: number }>(
        "SELECT COUNT(*) c FROM findings WHERE project_id = ? AND status = 'suspect'",
        p.id,
      )?.c ?? 0;
      const pending = store.get<{ c: number }>(
        `SELECT COUNT(*) c FROM verdicts v JOIN findings f ON f.id = v.finding_id
         WHERE f.project_id = ? AND v.superseded_by IS NULL AND v.review = 'pending'`,
        p.id,
      )?.c ?? 0;
      const anchorless = store.get<{ c: number }>(
        `SELECT COUNT(*) c FROM findings f
         WHERE f.project_id = ? AND f.status != 'superseded'
           AND NOT EXISTS (SELECT 1 FROM anchors a WHERE a.finding_id = f.id)`,
        p.id,
      )?.c ?? 0;
      const clean = Math.max(0, notes - suspects);
      const lastRunAt = store.get<{ at: string }>(
        `SELECT at FROM events WHERE project_id = ? AND kind = 'audit_completed'
         ORDER BY id DESC LIMIT 1`,
        p.id,
      )?.at ?? null;
      const runRows = store.all<{ detail: string | null }>(
        `SELECT detail FROM events WHERE project_id = ? AND kind = 'audit_completed'
         ORDER BY id DESC LIMIT ?`,
        p.id, RUN_SERIES_LEN,
      );
      const runSeries = runRows
        .map((r) => {
          try {
            const parsed = JSON.parse(r.detail ?? "null") as { verdictsRecorded?: number } | null;
            return parsed?.verdictsRecorded ?? 0;
          } catch {
            return 0; // a run row with broken JSON must still render (same contract as listRuns)
          }
        })
        .reverse();
      // A project with nothing to decay is healthy, not 0% — "unused ≠ decayed"
      // (tasarım-notu.md). Math.max(1, notes) would otherwise divide 0/1 → 0%.
      const healthPct = notes === 0 ? 100 : Math.round((100 * clean) / notes);
      return {
        id: p.id, path: p.path, name: basename(p.path), notes, suspects, pending,
        anchorless, clean, lastRunAt, runSeries, healthPct,
      };
    });
  });
}

export function getVersion(store: ReadStore): Version {
  return guard(() => ({
    maxVerdictId:
      store.get<{ m: number }>("SELECT COALESCE(MAX(id),0) m FROM verdicts")?.m ?? 0,
    maxEventId: store.get<{ m: number }>("SELECT COALESCE(MAX(id),0) m FROM events")?.m ?? 0,
  }));
}
