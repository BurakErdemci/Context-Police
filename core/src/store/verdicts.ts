// Where an adjudication outcome lives. Schema and rationale: schema.sql.
//
// Three things a verdict carries and nothing else in the store can: the verdict
// itself, the evidence it was measured from, and the correction text that will
// be offered to the user. K9 forbids writing that text into a memory file, so
// this table is the only place it lands until the user approves it.

import { createHash } from "node:crypto";
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
  /**
   * Overrides the fingerprint derived from `verdict`+`evidence`. A caller that
   * measured more than the evidence line says (anchor states, claim text) passes
   * its own so that suppression compares what was actually measured. Omitted =
   * derived; there is no way to ask for a NULL one, because a new row with no
   * fingerprint could never be suppressed and would re-nag forever.
   */
  evidenceFingerprint?: string;
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
  /** NULL on rows written before the column existed; such a row never suppresses. */
  evidenceFingerprint: string | null;
}

export interface RecordedVerdict {
  /** The live verdict for the claim after the call — new row, or the unchanged one. */
  id: number;
  /** False when the conclusion was already on file and no row was written. */
  recorded: boolean;
  supersededId: number | null;
  /**
   * The row was not written because the user already rejected this exact
   * complaint (design §5). Separate from `recorded: false` for the repeat case:
   * one means "nothing new to say", the other means "the user said no" — and
   * only the second is a number worth watching (design §8).
   */
  suppressed: boolean;
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
  evidence_fingerprint: string | null;
}

const COLUMNS =
  "id, project_id, finding_id, claim_ref, verdict, sub_reason, decay_type, evidence, method, " +
  "correction, source, run_id, created_at, review, reviewed_at, superseded_by, repeat_count, " +
  "evidence_fingerprint";

function toRecord(r: VerdictRow): VerdictRecord {
  return {
    id: r.id, projectId: r.project_id, findingId: r.finding_id, claimRef: r.claim_ref,
    verdict: r.verdict, subReason: r.sub_reason, decayType: r.decay_type,
    evidence: r.evidence, method: r.method, correction: r.correction,
    source: r.source, runId: r.run_id, createdAt: r.created_at,
    review: r.review, reviewedAt: r.reviewed_at, supersededBy: r.superseded_by,
    repeatCount: r.repeat_count, evidenceFingerprint: r.evidence_fingerprint,
  };
}

/**
 * The identity of the COMPLAINT, without the evidence behind it: two verdicts
 * with the same reason accuse the note of the same thing. Rejection is scoped to
 * this — the user dismissed a complaint, not a run.
 *
 * `evidence` is deliberately out (it is the other half of the pair: same reason
 * + same evidence = suppress, same reason + new evidence = ask again), and so
 * are `source`, `method` and `run_id` — who measured it does not change what is
 * being claimed.
 */
export function verdictReason(v: {
  verdict: VerdictValue; subReason?: string | null; decayType?: string | null;
}): string {
  return `${v.verdict}|${v.subReason ?? ""}|${v.decayType ?? ""}`;
}

/**
 * The evidence a verdict rests on, as one stable hash.
 *
 * Fields are serialised in alphabetical order and separated by control
 * characters that cannot occur in a file path, a note or a git output line —
 * a plain concatenation would let ("a","bc") and ("ab","c") collide, which
 * would silently suppress a complaint the user never saw.
 *
 * `anchorStates` is sorted: the order anchors happen to be iterated in is not
 * evidence, and letting it into the hash would make every run look like new
 * evidence and defeat suppression entirely.
 */
export function computeEvidenceFingerprint(input: {
  reason: string; claimText?: string; anchorStates?: string[];
}): string {
  const fields: [string, string][] = [
    ["anchorStates", [...(input.anchorStates ?? [])].sort().join("\u001d")],
    ["claimText", input.claimText ?? ""],
    ["reason", input.reason],
  ];
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = fields.map(([k, v]) => `${k}\u001f${v}`).join("\u001e");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The most recent REJECTED verdict for a complaint. Superseded rows included on
 * purpose: the rejection that matters is usually no longer live (a later
 * measurement withdrew it), which is exactly why `sameConclusion` — which only
 * looks at the live row — cannot see the re-nag coming.
 *
 * Only the CURRENT review counts: the column is mutable (design §7b), so a
 * rejection the user took back stops suppressing on the next run — otherwise an
 * undone misclick would silence the complaint forever.
 *
 * `claimRef` omitted = any claim on the note.
 */
export function findLastRejected(
  store: Store, findingId: number, reason: string, claimRef?: string,
): VerdictRecord | undefined {
  const reasonSql = "verdict || '|' || IFNULL(sub_reason,'') || '|' || IFNULL(decay_type,'')";
  const r = claimRef === undefined
    ? store.get<VerdictRow>(
        `SELECT ${COLUMNS} FROM verdicts WHERE finding_id = ? AND review = 'rejected' ` +
          `AND ${reasonSql} = ? ORDER BY id DESC LIMIT 1`,
        findingId, reason)
    : store.get<VerdictRow>(
        `SELECT ${COLUMNS} FROM verdicts WHERE finding_id = ? AND claim_ref = ? AND review = 'rejected' ` +
          `AND ${reasonSql} = ? ORDER BY id DESC LIMIT 1`,
        findingId, claimRef, reason);
  return r === undefined ? undefined : toRecord(r);
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
      return { id: live.id, recorded: false, supersededId: null, suppressed: false };
    }

    // The user already dismissed this exact complaint (design §5). The check
    // lives HERE, at the one place a verdict row is born, because every caller
    // (audit's three branches, the adjudicator later) would otherwise need its
    // own copy — and a suppression rule that one caller forgets is a rule that
    // does not exist.
    //
    // AFTER the repeat branch on purpose: a still-live rejected verdict being
    // re-measured is a repeat, not a suppression, and counting it as the latter
    // would inflate the one number design §8 asks us to watch.
    const reason = verdictReason(input);
    const fingerprint = input.evidenceFingerprint
      ?? computeEvidenceFingerprint({ reason, claimText: input.evidence ?? undefined });
    const rejected = findLastRejected(store, input.findingId, reason, claimRef);
    if (rejected !== undefined && rejected.evidenceFingerprint === fingerprint) {
      // Nothing is deleted and nothing is hidden: the non-production is itself a
      // record, so a suppression rule that bites too hard is measurable rather
      // than invisible (design §8).
      logEvent(store, {
        projectId: input.projectId,
        kind: "verdict_suppressed",
        detail: {
          runId: input.runId, findingId: input.findingId, claimRef, reason, fingerprint,
          rejectedVerdictId: rejected.id,
        },
      });
      return { id: live?.id ?? rejected.id, recorded: false, supersededId: null, suppressed: true };
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
        "evidence, method, correction, source, run_id, created_at, evidence_fingerprint) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, input.projectId, input.findingId, claimRef, input.verdict,
      input.subReason ?? null, input.decayType ?? null, input.evidence ?? null,
      input.method ?? null, input.correction ?? null, input.source, input.runId,
      input.createdAt ?? nowIso(), fingerprint,
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
    return { id, recorded: true, supersededId: live?.id ?? null, suppressed: false };
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
 *
 * The decision is NOT final (design §7b). `pending` reverts it, and a decided
 * row can be re-decided; the column holds the LATEST state while every change
 * appends a `verdict_reviewed` event carrying from→to, so the full path stays
 * reconstructable and append-only is not broken. A misclick that could not be
 * undone would be the one irreversible action in a tool whose whole premise is
 * that its own errors must cost nothing (spec §3.2).
 */
export function reviewVerdict(
  store: Store,
  id: number,
  review: VerdictReview,
  at: string = nowIso(),
): boolean {
  return store.tx(() => {
    const before = getVerdict(store, id);
    if (before === undefined || before.supersededBy !== null) return false;
    // Re-asserting the same decision is a no-op, not an error: a double click
    // must not spend a ledger line saying nothing changed.
    if (before.review === review) return true;
    const { changes } = store.run(
      // Reverting clears the stamp too — a `pending` row carrying a review time
      // would read as decided to every query that checks the timestamp.
      "UPDATE verdicts SET review = ?, reviewed_at = ? WHERE id = ? AND superseded_by IS NULL",
      review, review === "pending" ? null : at, id,
    );
    if (changes === 0) return false;
    const v = getVerdict(store, id)!;
    logEvent(store, {
      projectId: v.projectId,
      kind: "verdict_reviewed",
      detail: {
        verdictId: id, findingId: v.findingId, claimRef: v.claimRef, verdict: v.verdict,
        review, from: before.review, to: review,
      },
    });
    return true;
  });
}
