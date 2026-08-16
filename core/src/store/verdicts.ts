// Where an adjudication outcome lives. Schema and rationale: schema.sql.
//
// Three things a verdict carries and nothing else in the store can: the verdict
// itself, the evidence it was measured from, and the correction text that will
// be offered to the user. K9 forbids writing that text into a memory file, so
// this table is the only place it lands until the user approves it.

import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";
import { logEvent } from "./events.ts";

/** The project's five-valued space (tools/altin-set/validate.ts). Not extended here. */
export type VerdictValue = "gecerli" | "curuk" | "dogustan-yanlis" | "olculemez" | "tarihsel";

/** Who produced it: the cheap signal layer, or a tool-armed adjudication call. */
export type VerdictSource = "mechanical" | "adjudicator";

export type VerdictReview = "pending" | "approved" | "rejected";

/** '' addresses the whole note; a claim id addresses one statement inside it. */
export const WHOLE_NOTE = "";

export interface VerdictInput {
  projectId: number;
  findingId: number;
  /** Defaults to WHOLE_NOTE. */
  claimRef?: string;
  verdict: VerdictValue;
  /**
   * Refines the verdict without splitting it. Exists so that distinctions found
   * later (an `olculemez` the USER could resolve vs one nobody can) have a home
   * that does not require a sixth verdict value — a new value would make the
   * M0/M4 distributions incomparable.
   */
  subReason?: string | null;
  decayType?: string | null;
  evidence?: string | null;
  method?: string | null;
  correction?: string | null;
  source: VerdictSource;
  runId: string;
  createdAt?: string;
}

export interface VerdictRecord {
  id: number;
  projectId: number;
  findingId: number;
  claimRef: string;
  verdict: VerdictValue;
  subReason: string | null;
  decayType: string | null;
  evidence: string | null;
  method: string | null;
  correction: string | null;
  source: VerdictSource;
  runId: string;
  createdAt: string;
  review: VerdictReview;
  reviewedAt: string | null;
  supersededBy: number | null;
  /**
   * Kaç koşum aynı sonuca vardı. 1 = bir kez ölçüldü. Tekrar için yeni satır
   * yazılmadığından (aşağıda `sameConclusion`) tekrarın başka hiçbir izi yok —
   * ve `olculemez` kayıtlarında taşıdığı sinyal gerçek: bir kez ölçülememek
   * gürültü, on iki koşum üst üste ölçülememek kullanıcının müdahale
   * edebileceği kalıcı bir arıza.
   */
  repeatCount: number;
}

export interface RecordedVerdict {
  /** The live verdict for the claim after the call — new row, or the unchanged one. */
  id: number;
  /** False when the conclusion was already on file and no row was written. */
  recorded: boolean;
  supersededId: number | null;
}

interface VerdictRow {
  id: number;
  project_id: number;
  finding_id: number;
  claim_ref: string;
  verdict: VerdictValue;
  sub_reason: string | null;
  decay_type: string | null;
  evidence: string | null;
  method: string | null;
  correction: string | null;
  source: VerdictSource;
  run_id: string;
  created_at: string;
  review: VerdictReview;
  reviewed_at: string | null;
  superseded_by: number | null;
  repeat_count: number;
}

const COLUMNS =
  "id, project_id, finding_id, claim_ref, verdict, sub_reason, decay_type, evidence, method, " +
  "correction, source, run_id, created_at, review, reviewed_at, superseded_by, repeat_count";

function toRecord(r: VerdictRow): VerdictRecord {
  return {
    id: r.id, projectId: r.project_id, findingId: r.finding_id, claimRef: r.claim_ref,
    verdict: r.verdict, subReason: r.sub_reason, decayType: r.decay_type,
    evidence: r.evidence, method: r.method, correction: r.correction,
    source: r.source, runId: r.run_id, createdAt: r.created_at,
    review: r.review, reviewedAt: r.reviewed_at, supersededBy: r.superseded_by,
    repeatCount: r.repeat_count,
  };
}

/**
 * The conclusion, without the bookkeeping. Two verdicts that agree on these
 * fields say the same thing to the user even if they were measured in different
 * runs — which is why `run_id` and `method` are NOT here.
 */
function sameConclusion(a: VerdictRecord, b: VerdictInput): boolean {
  return a.verdict === b.verdict
    && a.subReason === (b.subReason ?? null)
    && a.decayType === (b.decayType ?? null)
    && a.evidence === (b.evidence ?? null)
    && a.correction === (b.correction ?? null)
    && a.source === b.source;
}

/**
 * Records a verdict, superseding whatever was live for the same claim.
 *
 * Re-measuring an unchanged world writes NOTHING (`recorded: false`). Without
 * that, every audit run would append one row per decayed note forever — the
 * table is append-only, so the growth would be unrecoverable, and the approval
 * queue would show the same conclusion N times. It also means a verdict the user
 * already REJECTED is not resurrected as `pending` by the next run that measures
 * the same thing: re-nagging is how a user learns to approve without reading.
 */
export function recordVerdict(store: Store, input: VerdictInput): RecordedVerdict {
  const claimRef = input.claimRef ?? WHOLE_NOTE;
  return store.tx(() => {
    const live = getLiveVerdict(store, input.findingId, claimRef);
    if (live !== undefined && sameConclusion(live, input)) {
      // Satır yazılmıyor ama ölçüm YAPILDI: sayaç o ölçümün tek izi. Olay da
      // düşmüyor — bir kere ölçülüp yüz kere teyit edilen bir hüküm, günlüğü
      // yüz satırla doldurmadan sayıdan okunabilmeli.
      store.run("UPDATE verdicts SET repeat_count = repeat_count + 1 WHERE id = ?", live.id);
      return { id: live.id, recorded: false, supersededId: null };
    }

    // Id is allocated by hand because the supersession pointer has to be written
    // BEFORE the row it points at exists (schema.sql: the live-verdict index is
    // checked per statement). Nothing is ever deleted from this table, so
    // MAX(id)+1 cannot collide with a reused id; a racing writer that guessed the
    // same id hits `verdicts_no_replace` and aborts loudly instead of overwriting.
    const id = (store.get<{ next: number }>("SELECT IFNULL(MAX(id), 0) + 1 AS next FROM verdicts")!).next;

    if (live !== undefined) {
      store.run("UPDATE verdicts SET superseded_by = ? WHERE id = ?", id, live.id);
    }
    store.run(
      "INSERT INTO verdicts (id, project_id, finding_id, claim_ref, verdict, sub_reason, decay_type, " +
        "evidence, method, correction, source, run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, input.projectId, input.findingId, claimRef, input.verdict,
      input.subReason ?? null, input.decayType ?? null, input.evidence ?? null,
      input.method ?? null, input.correction ?? null, input.source, input.runId,
      input.createdAt ?? nowIso(),
    );

    // Same transaction as the row it describes: an event saying "verdict
    // recorded" next to a store that has no such verdict is the audit log lying
    // about the store (same rule as audit.ts contradiction events).
    logEvent(store, {
      projectId: input.projectId,
      kind: "verdict_recorded",
      detail: {
        runId: input.runId, verdictId: id, findingId: input.findingId, claimRef,
        verdict: input.verdict, subReason: input.subReason ?? null,
        source: input.source, supersededId: live?.id ?? null,
        hasCorrection: (input.correction ?? null) !== null,
      },
    });
    return { id, recorded: true, supersededId: live?.id ?? null };
  });
}

/** The current verdict for a claim, or undefined if the claim was never judged. */
export function getLiveVerdict(store: Store, findingId: number, claimRef = WHOLE_NOTE): VerdictRecord | undefined {
  const r = store.get<VerdictRow>(
    `SELECT ${COLUMNS} FROM verdicts WHERE finding_id = ? AND claim_ref = ? AND superseded_by IS NULL`,
    findingId, claimRef,
  );
  return r === undefined ? undefined : toRecord(r);
}

export function getVerdict(store: Store, id: number): VerdictRecord | undefined {
  const r = store.get<VerdictRow>(`SELECT ${COLUMNS} FROM verdicts WHERE id = ?`, id);
  return r === undefined ? undefined : toRecord(r);
}

/** The approval queue: live and not yet reviewed, oldest first. */
export function listPendingVerdicts(store: Store, projectId: number, limit = 100): VerdictRecord[] {
  return store
    .all<VerdictRow>(
      `SELECT ${COLUMNS} FROM verdicts WHERE project_id = ? AND review = 'pending' ` +
        "AND superseded_by IS NULL ORDER BY id LIMIT ?",
      projectId, limit,
    )
    .map(toRecord);
}

/**
 * Everything ever concluded about a note, oldest first, superseded rows
 * included — that is the point of the table (spec §3.2: the record stays and the
 * tool's reversal rate stays countable).
 */
export function listVerdictHistory(store: Store, findingId: number, claimRef?: string): VerdictRecord[] {
  const rows = claimRef === undefined
    ? store.all<VerdictRow>(
        `SELECT ${COLUMNS} FROM verdicts WHERE finding_id = ? ORDER BY claim_ref, id`, findingId)
    : store.all<VerdictRow>(
        `SELECT ${COLUMNS} FROM verdicts WHERE finding_id = ? AND claim_ref = ? ORDER BY id`, findingId, claimRef);
  return rows.map(toRecord);
}

/**
 * The user's decision. A superseded verdict cannot be reviewed: approving one
 * would hand the next milestone a correction that a later measurement already
 * withdrew. Returns false when nothing was reviewable.
 */
export function reviewVerdict(
  store: Store,
  id: number,
  review: Exclude<VerdictReview, "pending">,
  at: string = nowIso(),
): boolean {
  return store.tx(() => {
    const { changes } = store.run(
      "UPDATE verdicts SET review = ?, reviewed_at = ? WHERE id = ? AND superseded_by IS NULL",
      review, at, id,
    );
    if (changes === 0) return false;
    const v = getVerdict(store, id)!;
    logEvent(store, {
      projectId: v.projectId,
      kind: "verdict_reviewed",
      detail: { verdictId: id, findingId: v.findingId, claimRef: v.claimRef, verdict: v.verdict, review },
    });
    return true;
  });
}
