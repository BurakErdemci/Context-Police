// M4.8 — cross-check over the adjudicator's OUTPUT.
//
// This is not a second adjudication. The input is a verdict that already
// exists (claim text + verdict + evidence) and the job is to re-examine THAT,
// against the repo, without re-running the whole note through the model.
//
// WHY SAME MODEL FIRST (architect's call, and the reason is invisible from the
// code): of the 20 adjudicator errors measured in this repo, 17 fell into four
// classes and NONE of them was "the model was too weak". They were brief gaps —
// a claim never measured, a count never run, a verdict reached from the note's
// own narrative instead of from disk. A gap like that closes when the SAME model
// is pointed at the evidence with a measurement task. A second model is a far
// more expensive answer to a cheaper problem, so it is pass 2 and only pass 2.
//
// WHY DEFAULT OFF: every cross-check is another metered model call. Running it
// on every claim spends the audit budget uniformly over a population where the
// errors are concentrated. Two explicit conditions open the gate — the
// adjudicator is undecided, or the verdict is above an impact threshold — and
// nothing else does. Both are named predicates below so they can be measured
// and moved separately.
//
// This module NEVER spawns a process. The model call is an injected `runner`;
// the caller owns the `codex` binary, the quota and the transport.

import { fenceUntrusted, DATA_FENCE_RULE } from "../../core/src/prompt-fence.ts";
import { BORN_WRONG, OLCULEMEZ, USER_RESOLVABLE } from "./adjudicate-lib.ts";

export const VALID = "gecerli";
export const DECAYED = "curuk";
export const HISTORICAL = "tarihsel";

/** The five verdicts the adjudicator may emit. Anything else is unrecognised. */
export const KNOWN_VERDICTS = [VALID, DECAYED, BORN_WRONG, OLCULEMEZ, HISTORICAL] as const;

export type AdjudicatedClaim = {
  note: string;
  text: string;
  line_start: number;
  line_end: number;
  verdict: string;
  evidence?: string;
  /** `olculemez` sub-reason; `user_resolvable` = the user can settle it. */
  unmeasurable_reason?: string;
};

/* --- measurement trace ---------------------------------------------------
 *
 * The tell of a brief-gap error is a decisive verdict whose evidence contains
 * no measurement: no command, no sha, no path, no counted number — only a
 * retelling of the note. A verdict like that was reached from the note's
 * narrative, which is the exact failure mode this project exists to catch.
 *
 * The same predicate decides whether a cross-check PASS settled anything: a
 * pass that answers without a measurement re-affirms from the same context that
 * produced the error, and re-affirmation is not evidence.
 */
const MEASUREMENT_TRACE_PATTERNS: RegExp[] = [
  /\bkomut:\s*\S/,                                   // counting-claim evidence format
  /\bgit\s+(log|show|grep|ls-files|diff|blame)\b/,
  /\b(wc|rg|grep|ls|cat|find)\s+-/,
  /\b[0-9a-f]{7,40}\b/,                              // commit sha
  /[\w./-]+\.(ts|tsx|js|mjs|json|md|py|toml|ya?ml|sh|sql)\b/,  // a concrete file
];

export function hasMeasurementTrace(evidence: string | undefined): boolean {
  const e = (evidence ?? "").trim();
  if (e === "") return false;
  return MEASUREMENT_TRACE_PATTERNS.some((re) => re.test(e));
}

/* --- gate condition 1: undecided ---------------------------------------- */

/**
 * The verdict itself says no conclusion was reached against the repo — AND
 * nothing was measured on the way there.
 *
 * The measurement requirement is not decoration; it was measured. On the real
 * adjudicator run (`docs/olcumler/altin-set/hakem-full28-ciktisi.jsonl`, 1210
 * claims, 15 Aug 2026) `olculemez` alone opened the gate for 498/498 claims and
 * the gate fired on 57.7% of the population — a "default off" that is on for
 * more than half of everything. Requiring the absence of a measurement trace
 * drops it to 40.6% (491/1210, undecided 348, `olculemez` 291/498); the other
 * verdicts are untouched.
 *
 * The reason it was wrong is internal, not statistical: `readPass()` treats an
 * `olculemez` answer WITH a measurement behind it as a settled confirmation, so
 * treating the same shape as undecided here made "undecided" mean two different
 * things in two places. "I looked, and it is repo-external" (session ids,
 * memory-system metadata, tool behaviour outside the pin — this population is
 * full of them) is an answer, not an open question.
 *
 * The `user_resolvable` sub-reason stays EXCLUDED: that claim is already routed
 * to a human question queue (adjudicate-lib.ts), and no model pass supplies the
 * missing fact.
 */
export function verdictIsUnsettled(claim: AdjudicatedClaim): boolean {
  if (claim.verdict !== OLCULEMEZ) return false;
  if (claim.unmeasurable_reason === USER_RESOLVABLE) return false;
  return !hasMeasurementTrace(claim.evidence);
}

/** A decisive verdict whose evidence carries no measurement — a brief gap. */
export function evidenceIsUnmeasured(claim: AdjudicatedClaim): boolean {
  return !hasMeasurementTrace(claim.evidence);
}

/**
 * Explicit definition of "the adjudicator is undecided": nothing was measured.
 * Nothing else counts — not the verdict on its own, not the note's age.
 *
 * Both terms are kept named and exported even though the first is now a subset
 * of the second, because they answer different questions when read one by one
 * ("did the adjudicator declare itself unable?" vs "is there a measurement?").
 * Consequence worth seeing: the `user_resolvable` exclusion inside
 * `verdictIsUnsettled` no longer changes this disjunction — such a claim still
 * opens the gate through the second term when its evidence carries no trace.
 */
export function isUndecided(claim: AdjudicatedClaim): boolean {
  return verdictIsUnsettled(claim) || evidenceIsUnmeasured(claim);
}

/* --- gate condition 2: impact ------------------------------------------- */

/**
 * Impact = what acting on this verdict costs if it is wrong.
 *
 * `curuk` and `dogustan-yanlis` are the actionable ones: they supersede a note,
 * i.e. they take knowledge away from the agent (they are also exactly the
 * numerator of the exit gate in `score.ts`). `gecerli` is cheaper but not free —
 * a wrong `gecerli` keeps a rotted note alive — and `olculemez`/`tarihsel`
 * change nothing on their own.
 */
export const VERDICT_IMPACT: Record<string, number> = {
  [DECAYED]: 1,
  [BORN_WRONG]: 1,
  [VALID]: 0.4,
  [OLCULEMEZ]: 0.2,
  [HISTORICAL]: 0.1,
};

/** At 1.0 with the default weights, only the note-superseding verdicts pass. */
export const DEFAULT_IMPACT_THRESHOLD = 1;

export type CrossCheckOptions = {
  impactThreshold?: number;
  verdictImpact?: Record<string, number>;
  /**
   * Per-note multiplier — the CLAUDE.md §3.1 hook: "high usage × high decay
   * risk goes to the top of the queue". The caller supplies usage; this module
   * does not measure it.
   */
  noteWeight?: number;
  /** Bypass the gate when the caller has already decided. */
  force?: boolean;
  /** Model id for pass 1; `null`/absent means "whatever ran the adjudication". */
  sameModel?: string | null;
  /** Model id for pass 2. Absent means pass 2 is disabled. */
  secondModel?: string | null;
};

export function impactScore(claim: AdjudicatedClaim, opts: CrossCheckOptions = {}): number {
  const table = opts.verdictImpact ?? VERDICT_IMPACT;
  const base = table[claim.verdict] ?? 0;
  return base * (opts.noteWeight ?? 1);
}

/** `>=` on purpose: the default threshold is the weight of a note-superseding verdict. */
export function isAboveImpactThreshold(claim: AdjudicatedClaim, opts: CrossCheckOptions = {}): boolean {
  return impactScore(claim, opts) >= (opts.impactThreshold ?? DEFAULT_IMPACT_THRESHOLD);
}

export type GateTrigger = "undecided" | "impact" | "forced";

export type GateDecision = {
  run: boolean;
  triggers: GateTrigger[];
  undecided: boolean;
  aboveImpactThreshold: boolean;
  impact: number;
};

/** The default-off gate. Both conditions are named and independently testable. */
export function shouldCrossCheck(claim: AdjudicatedClaim, opts: CrossCheckOptions = {}): GateDecision {
  const undecided = isUndecided(claim);
  const aboveImpactThreshold = isAboveImpactThreshold(claim, opts);
  const triggers: GateTrigger[] = [];
  if (undecided) triggers.push("undecided");
  if (aboveImpactThreshold) triggers.push("impact");
  if (opts.force && triggers.length === 0) triggers.push("forced");
  return {
    run: triggers.length > 0,
    triggers,
    undecided,
    aboveImpactThreshold,
    impact: impactScore(claim, opts),
  };
}

/* --- the passes ---------------------------------------------------------- */

export type CrossCheckRequest = {
  pass: 1 | 2;
  /** `null` = the model that produced the original verdict. */
  model: string | null;
  prompt: string;
  claim: AdjudicatedClaim;
};

export type CrossCheckResponse = {
  /** The verdict this pass MEASURED. Unrecognised or absent → the pass settled nothing. */
  verdict?: string | null;
  unmeasurable_reason?: string;
  /** Must carry a measurement trace, otherwise the pass counts as unsettled. */
  evidence?: string;
};

export type Runner = (req: CrossCheckRequest) => Promise<CrossCheckResponse>;

/**
 * MEASUREMENT FRAME, not recall (CLAUDE.md §2.1).
 *
 * The forbidden question is "is this verdict of yours still right?" — it asks a
 * context that already absorbed the verdict as true and answers from the same
 * delusion that produced it. So the verdict is presented as one of two
 * statements of unknown standing, its author is not named, and the task is to
 * go to disk and say which one holds today.
 */
export function buildPass1Prompt(claim: AdjudicatedClaim): string {
  return `Bir yazılım deposunun kök dizinindesin. Görevin hatırlamak değil ÖLÇMEK.

Aşağıda AYNI satırlar hakkında iki ifade var. Hangisinin kimden geldiği önemli
değil ve ikisi de doğru varsayılmıyor; en az biri yanlış olabilir.

${DATA_FENCE_RULE}

${fenceUntrusted(`IFADE A — notun iddiası (${claim.note}:${claim.line_start}-${claim.line_end})`, claim.text)}

${fenceUntrusted(`IFADE B — bu iddia için kayda geçmiş hüküm: ${claim.verdict}`, claim.evidence ?? "(kanıt yok)")}

Yöntem: dosyaları oku, \`git log\`/\`git show\`/\`git grep\`/\`git ls-files\`
çalıştır, sayım iddialarını KOŞTUR. Hükmü koddan çıkar; iki ifadenin
anlatısından değil.

Cevabın şu üçünden biri olacak:
- Ölçüm B'yi doğruluyor  → aynı hükmü, bu sefer ölçümünle yaz.
- Ölçüm B'yi çürütüyor   → doğru hükmü yaz.
- Ölçemedin              → \`${OLCULEMEZ}\` yaz. Bu ONURLU bir cevap;
  ölçmediğin şeye hüküm verme, B'yi de sırf orada duruyor diye tekrarlama.

Kanıt alanına ÖLÇÜMÜ yaz: koştuğun komut, gördüğün sha, okuduğun dosya ve
satır. Ölçüm taşımayan bir kanıt bu turda cevap sayılmıyor.`;
}

/**
 * Pass 2 exists only because pass 1 could not measure. It gets the same two
 * statements plus what pass 1 was able to establish — passing pass 1's answer
 * as a THIRD statement of unknown standing, again never as an authority.
 */
export function buildPass2Prompt(claim: AdjudicatedClaim, pass1: CrossCheckResponse): string {
  const p1 = [
    pass1.verdict ? `hüküm: ${pass1.verdict}` : "hüküm: yok (ölçüm tamamlanamadı)",
    `kanıt: ${(pass1.evidence ?? "").trim() || "(yok)"}`,
  ].join("\n");
  return `${buildPass1Prompt(claim)}

${fenceUntrusted("IFADE C — bağımsız bir ölçüm turunun bıraktığı iz (sonuçsuz kaldı)", p1)}

C bir otorite değil, yalnız nerede tıkanıldığının kaydı. Aynı yerde tıkanmak
zorunda değilsin: ölçümü sen yap ve hükmü kendi ölçümünden çıkar.`;
}

/* --- outcome ------------------------------------------------------------- */

export type PassOutcome = "confirmed" | "overturned" | "unsettled";

export type PassRecord = {
  pass: 1 | 2;
  model: string | null;
  outcome: PassOutcome;
  verdict: string | null;
  evidence: string;
  /** Why the pass settled nothing; absent when it did settle. */
  unsettledReason?: UnsettledReason;
};

export type UnsettledReason =
  | "no_verdict"          // response carried nothing recognisable
  | "no_measurement"      // a verdict, but no measurement behind it
  | "answered_olculemez"  // the pass itself says it could not measure
  | "no_second_model"     // pass 1 unsettled and pass 2 is disabled
  | "second_pass_unsettled";

export type CrossCheckResult =
  | { status: "skipped"; gate: GateDecision; verdict: string; passes: PassRecord[] }
  | { status: "confirmed"; gate: GateDecision; verdict: string; settledBy: 1 | 2; passes: PassRecord[] }
  | {
      status: "overturned"; gate: GateDecision; verdict: string; previousVerdict: string;
      settledBy: 1 | 2; passes: PassRecord[];
    }
  | { status: "unsettled"; gate: GateDecision; verdict: string; reason: UnsettledReason; passes: PassRecord[] };

/**
 * `unsettled` is NOT `confirmed`. "We could not settle it" and "we checked and
 * it held" are different facts, and folding the first into the second
 * manufactures a measurement nobody made — the exact defect this tool exists to
 * find. Callers that want the confirmed set must use this predicate, never
 * `status !== "overturned"`.
 */
export function isConfirmed(r: CrossCheckResult): boolean {
  return r.status === "confirmed";
}

function readPass(claim: AdjudicatedClaim, res: CrossCheckResponse): {
  outcome: PassOutcome; verdict: string | null; reason?: UnsettledReason;
} {
  const v = typeof res.verdict === "string" ? res.verdict : null;
  if (v === null || !(KNOWN_VERDICTS as readonly string[]).includes(v)) {
    return { outcome: "unsettled", verdict: null, reason: "no_verdict" };
  }
  // A pass answering `olculemez` is reporting that it could not measure. Reading
  // that as an overturn of a decisive verdict would invent a measurement.
  if (v === OLCULEMEZ && claim.verdict !== OLCULEMEZ) {
    return { outcome: "unsettled", verdict: null, reason: "answered_olculemez" };
  }
  if (!hasMeasurementTrace(res.evidence)) {
    return { outcome: "unsettled", verdict: null, reason: "no_measurement" };
  }
  if (v === OLCULEMEZ && claim.verdict === OLCULEMEZ) {
    // The original was already "could not measure" and the pass agrees, with a
    // measurement behind it this time. That is a settled confirmation.
    return { outcome: "confirmed", verdict: v };
  }
  return v === claim.verdict
    ? { outcome: "confirmed", verdict: v }
    : { outcome: "overturned", verdict: v };
}

/**
 * Pass 1 re-examines the existing evidence with the SAME model; pass 2 (a second
 * model) runs ONLY if pass 1 settled nothing and a second model was configured.
 * `runner` is injected — this function never spawns anything.
 */
export async function crossCheck(
  claim: AdjudicatedClaim,
  runner: Runner,
  opts: CrossCheckOptions = {},
): Promise<CrossCheckResult> {
  const gate = shouldCrossCheck(claim, opts);
  if (!gate.run) return { status: "skipped", gate, verdict: claim.verdict, passes: [] };

  const passes: PassRecord[] = [];

  const res1 = await runner({
    pass: 1,
    model: opts.sameModel ?? null,
    prompt: buildPass1Prompt(claim),
    claim,
  });
  const r1 = readPass(claim, res1);
  passes.push({
    pass: 1, model: opts.sameModel ?? null, outcome: r1.outcome,
    verdict: r1.verdict, evidence: res1.evidence ?? "", unsettledReason: r1.reason,
  });
  if (r1.outcome === "confirmed") {
    return { status: "confirmed", gate, verdict: claim.verdict, settledBy: 1, passes };
  }
  if (r1.outcome === "overturned") {
    return {
      status: "overturned", gate, verdict: r1.verdict as string,
      previousVerdict: claim.verdict, settledBy: 1, passes,
    };
  }

  const second = opts.secondModel ?? null;
  if (second === null) {
    return { status: "unsettled", gate, verdict: claim.verdict, reason: "no_second_model", passes };
  }

  const res2 = await runner({
    pass: 2,
    model: second,
    prompt: buildPass2Prompt(claim, res1),
    claim,
  });
  const r2 = readPass(claim, res2);
  passes.push({
    pass: 2, model: second, outcome: r2.outcome,
    verdict: r2.verdict, evidence: res2.evidence ?? "", unsettledReason: r2.reason,
  });
  if (r2.outcome === "confirmed") {
    return { status: "confirmed", gate, verdict: claim.verdict, settledBy: 2, passes };
  }
  if (r2.outcome === "overturned") {
    return {
      status: "overturned", gate, verdict: r2.verdict as string,
      previousVerdict: claim.verdict, settledBy: 2, passes,
    };
  }
  return { status: "unsettled", gate, verdict: claim.verdict, reason: "second_pass_unsettled", passes };
}
