// `crosscheck.ts` — the gate, the two passes and the outcome distinction.
//
// Everything runs through the injected `runner`; no process is spawned and the
// metered `codex` binary is never touched. Assertions are on BEHAVIOUR through
// the public functions — source text is not scanned, because a source scan
// stays green when the code it guards is mutated away (measured in this repo).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  crossCheck, shouldCrossCheck, isUndecided, isAboveImpactThreshold, isConfirmed,
  hasMeasurementTrace, verdictIsUnsettled, evidenceIsUnmeasured, impactScore,
  type AdjudicatedClaim, type CrossCheckRequest, type CrossCheckResponse,
  type CrossCheckResult, type PassRecord, type Runner,
} from "../crosscheck.ts";

/** Indexed access that fails the test instead of silently yielding undefined. */
function at<T>(xs: T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new assert.AssertionError({ message: `eleman yok: [${i}]` });
  return x;
}
const callAt = (r: { calls: CrossCheckRequest[] }, i: number) => at(r.calls, i);
const passAt = (r: CrossCheckResult, i: number): PassRecord => at(r.passes, i);

const MEASURED = "komut: git grep -c foo core/src/a.ts | olculen: 3 | notta: 3";
const NARRATIVE = "Not bunu söylüyor ve makul görünüyor.";

const claim = (over: Partial<AdjudicatedClaim> = {}): AdjudicatedClaim => ({
  note: "n1", text: "X modülü 3 sağlayıcı taşıyor", line_start: 4, line_end: 5,
  verdict: "gecerli", evidence: MEASURED, ...over,
});

/** Records every request so tests can assert on what the model was actually asked. */
function recordingRunner(...responses: CrossCheckResponse[]): Runner & { calls: CrossCheckRequest[] } {
  const calls: CrossCheckRequest[] = [];
  const fn = async (req: CrossCheckRequest) => {
    calls.push(req);
    return responses[calls.length - 1] ?? {};
  };
  return Object.assign(fn, { calls });
}

/* --- the gate ------------------------------------------------------------ */

test("gate is OFF by default: a measured, low-impact verdict is not cross-checked", async () => {
  const c = claim();
  const g = shouldCrossCheck(c);
  assert.equal(g.run, false);
  assert.deepEqual(g.triggers, []);

  const runner = recordingRunner({ verdict: "curuk", evidence: MEASURED });
  const r = await crossCheck(c, runner);
  assert.equal(r.status, "skipped");
  assert.equal(r.verdict, "gecerli");
  assert.equal(runner.calls.length, 0, "kapı kapalıyken model hiç çağrılmamalı");
});

test("condition 1 alone: undecided opens the gate below the impact threshold", async () => {
  // `olculemez` with nothing measured behind it: the adjudicator reached no
  // conclusion and cannot show it looked.
  const c = claim({ verdict: "olculemez", unmeasurable_reason: "not_measurable", evidence: NARRATIVE });
  assert.equal(verdictIsUnsettled(c), true);
  assert.equal(isUndecided(c), true);
  assert.equal(isAboveImpactThreshold(c), false, "olculemez tek başına eşiği geçmemeli");

  const g = shouldCrossCheck(c);
  assert.equal(g.run, true);
  assert.deepEqual(g.triggers, ["undecided"]);

  const runner = recordingRunner({ verdict: "olculemez", evidence: MEASURED });
  await crossCheck(c, runner);
  assert.equal(runner.calls.length, 1);
});

test("condition 1: a decisive verdict with no measurement behind it counts as undecided", () => {
  const c = claim({ verdict: "gecerli", evidence: NARRATIVE });
  assert.equal(verdictIsUnsettled(c), false, "hüküm kesin — belirsizlik kanıttan geliyor");
  assert.equal(evidenceIsUnmeasured(c), true);
  assert.equal(isUndecided(c), true);
  assert.deepEqual(shouldCrossCheck(c).triggers, ["undecided"]);
});

test("condition 1: a MEASURED olculemez is an answer, not an open question", async () => {
  // Measured on the real 1210-claim run: without this, `olculemez` alone opened
  // the gate 498/498 and "default off" fired on 57.7% of the population.
  // "I looked, and it is repo-external" is settled — the gate must stay shut.
  const c = claim({
    verdict: "olculemez", unmeasurable_reason: "not_measurable",
    evidence: "b4065f1'de bu not izlenmiyor; git ls-files boş döndü — depo dışı metadata",
  });
  assert.equal(verdictIsUnsettled(c), false);
  assert.equal(evidenceIsUnmeasured(c), false);
  assert.equal(isUndecided(c), false);
  assert.equal(isAboveImpactThreshold(c), false);

  const runner = recordingRunner({ verdict: "olculemez", evidence: MEASURED });
  const r = await crossCheck(c, runner);
  assert.equal(r.status, "skipped");
  assert.equal(runner.calls.length, 0);
});

test("condition 1: user_resolvable olculemez is NOT undecided — it belongs to the user", () => {
  const c = claim({
    verdict: "olculemez", unmeasurable_reason: "user_resolvable", evidence: MEASURED,
  });
  assert.equal(verdictIsUnsettled(c), false);
  assert.equal(isUndecided(c), false);
  assert.equal(shouldCrossCheck(c).run, false);
});

test("condition 2 alone: impact opens the gate for a fully measured verdict", async () => {
  // curuk/dogustan-yanlis supersede a note; that is what makes them expensive.
  for (const v of ["curuk", "dogustan-yanlis"]) {
    const c = claim({ verdict: v, evidence: MEASURED });
    assert.equal(isUndecided(c), false, `${v}: belirsiz olmamalı`);
    assert.equal(isAboveImpactThreshold(c), true, `${v}: eşiği geçmeli`);
    assert.deepEqual(shouldCrossCheck(c).triggers, ["impact"]);
  }
  const runner = recordingRunner({ verdict: "curuk", evidence: MEASURED });
  await crossCheck(claim({ verdict: "curuk" }), runner);
  assert.equal(runner.calls.length, 1);
});

test("impact threshold is a number, not a verdict list: note weight and threshold move it", () => {
  const valid = claim({ verdict: "gecerli", evidence: MEASURED });
  assert.equal(impactScore(valid), 0.4);
  assert.equal(isAboveImpactThreshold(valid), false);
  // §3.1 hook: a heavily used note raises the same verdict over the line.
  assert.equal(isAboveImpactThreshold(valid, { noteWeight: 3 }), true);
  // And a caller can raise the bar so even curuk stops triggering.
  assert.equal(isAboveImpactThreshold(claim({ verdict: "curuk" }), { impactThreshold: 5 }), false);
});

test("measurement trace: a command, sha or file counts; a retelling does not", () => {
  assert.equal(hasMeasurementTrace(MEASURED), true);
  assert.equal(hasMeasurementTrace("git log --until=2026-08-01 → 9af61aa"), true);
  assert.equal(hasMeasurementTrace(NARRATIVE), false);
  assert.equal(hasMeasurementTrace(""), false);
  assert.equal(hasMeasurementTrace(undefined), false);
});

/* --- the passes ---------------------------------------------------------- */

test("pass 1 runs against the SAME model and pass 2 is not reached when it settles", async () => {
  const runner = recordingRunner({ verdict: "curuk", evidence: MEASURED });
  const r = await crossCheck(claim({ verdict: "curuk" }), runner, {
    sameModel: "m-a", secondModel: "m-b",
  });
  assert.equal(r.status, "confirmed");
  assert.equal(isConfirmed(r), true);
  assert.equal(r.status === "confirmed" && r.settledBy, 1);
  assert.equal(runner.calls.length, 1, "pass 1 karar verdiyse ikinci model çağrılmaz");
  assert.equal(callAt(runner, 0).pass, 1);
  assert.equal(callAt(runner, 0).model, "m-a");
});

test("pass 2 IS reached — with the second model — when pass 1 settles nothing", async () => {
  const runner = recordingRunner(
    { verdict: "curuk", evidence: NARRATIVE },   // no measurement → settles nothing
    { verdict: "curuk", evidence: MEASURED },
  );
  const r = await crossCheck(claim({ verdict: "curuk" }), runner, {
    sameModel: "m-a", secondModel: "m-b",
  });
  assert.equal(runner.calls.length, 2);
  assert.equal(callAt(runner, 1).pass, 2);
  assert.equal(callAt(runner, 1).model, "m-b");
  assert.equal(r.status, "confirmed");
  assert.equal(r.status === "confirmed" && r.settledBy, 2);
  assert.equal(passAt(r, 0).outcome, "unsettled");
  assert.equal(passAt(r, 0).unsettledReason, "no_measurement");
});

test("no second model configured: pass 1 is the only call and the result stays unsettled", async () => {
  const runner = recordingRunner({ verdict: "curuk", evidence: NARRATIVE });
  const r = await crossCheck(claim({ verdict: "curuk" }), runner);
  assert.equal(runner.calls.length, 1);
  assert.equal(r.status, "unsettled");
  assert.equal(r.status === "unsettled" && r.reason, "no_second_model");
});

test("overturn propagates the new verdict and keeps the previous one", async () => {
  const runner = recordingRunner({ verdict: "gecerli", evidence: MEASURED });
  const r = await crossCheck(claim({ verdict: "curuk" }), runner, { secondModel: "m-b" });
  assert.equal(r.status, "overturned");
  assert.equal(r.verdict, "gecerli");
  assert.equal(r.status === "overturned" && r.previousVerdict, "curuk");
  assert.equal(runner.calls.length, 1);
});

test("overturn from pass 2 propagates too", async () => {
  const runner = recordingRunner(
    {},                                                 // nothing usable
    { verdict: "dogustan-yanlis", evidence: MEASURED },
  );
  const r = await crossCheck(claim({ verdict: "curuk" }), runner, { secondModel: "m-b" });
  assert.equal(r.status, "overturned");
  assert.equal(r.verdict, "dogustan-yanlis");
  assert.equal(r.status === "overturned" && r.settledBy, 2);
  assert.equal(passAt(r, 0).unsettledReason, "no_verdict");
});

/* --- unsettled is not confirmed ------------------------------------------ */

test("unsettled never collapses into confirmed", async () => {
  const runner = recordingRunner(
    { verdict: "curuk", evidence: NARRATIVE },
    { verdict: "curuk", evidence: NARRATIVE },
  );
  const r = await crossCheck(claim({ verdict: "curuk" }), runner, { secondModel: "m-b" });
  assert.equal(r.status, "unsettled");
  assert.equal(r.status === "unsettled" && r.reason, "second_pass_unsettled");
  assert.equal(isConfirmed(r), false);
  // The original verdict is carried unchanged — nothing was overturned either.
  assert.equal(r.verdict, "curuk");
  assert.equal(r.passes.length, 2);
});

test("a pass answering olculemez does not overturn a decisive verdict — it is unsettled", async () => {
  const runner = recordingRunner({ verdict: "olculemez", evidence: MEASURED });
  const r = await crossCheck(claim({ verdict: "curuk" }), runner);
  assert.equal(r.status, "unsettled");
  assert.equal(passAt(r, 0).unsettledReason, "answered_olculemez");
  assert.equal(r.verdict, "curuk", "ölçülemeyen bir tur hükmü değiştirmez");
});

test("an unrecognised verdict settles nothing", async () => {
  const runner = recordingRunner({ verdict: "belki", evidence: MEASURED });
  const r = await crossCheck(claim({ verdict: "curuk" }), runner);
  assert.equal(r.status, "unsettled");
  assert.equal(passAt(r, 0).unsettledReason, "no_verdict");
});

test("an undecided olculemez can be confirmed — but only with a measurement behind it", async () => {
  const c = claim({ verdict: "olculemez", unmeasurable_reason: "not_measurable", evidence: NARRATIVE });
  const settled = await crossCheck(c, recordingRunner({ verdict: "olculemez", evidence: MEASURED }));
  assert.equal(settled.status, "confirmed");

  const unmeasured = await crossCheck(c, recordingRunner({ verdict: "olculemez", evidence: NARRATIVE }));
  assert.equal(unmeasured.status, "unsettled");
});

/* --- the prompt is a measurement task ------------------------------------ */

test("pass 1 is asked as a measurement task, never as recall", async () => {
  const c = claim({ verdict: "curuk", evidence: "eski yol core/src/eski.ts silinmiş" });
  const runner = recordingRunner({ verdict: "curuk", evidence: MEASURED });
  await crossCheck(c, runner);
  const p = callAt(runner, 0).prompt;

  // Measurement: it names the tools and orders them to be run.
  assert.match(p, /git log/);
  assert.match(p, /ÖLÇMEK/);
  // Both statements are in front of the model, and neither is attributed to it.
  assert.ok(p.includes(c.text), "iddia metni istemde olmalı");
  assert.ok(p.includes(c.evidence as string), "mevcut kanıt istemde olmalı");
  assert.match(p, /IFADE A/);
  assert.match(p, /IFADE B/);
  // Recall framing: asking the model about its own earlier answer queries the
  // same context that produced it.
  assert.doesNotMatch(p, /senin hükmün|kendi hükmün|önceki cevab|hâlâ doğru mu|haklı mıydın/i);
  assert.match(p, /hatırlamak değil/);
  // "I could not measure" must remain an available answer.
  assert.match(p, /olculemez/);
});

test("pass 2 carries pass 1's trace as a third statement, not as an authority", async () => {
  const runner = recordingRunner(
    { verdict: "curuk", evidence: "sadece anlatı" },
    { verdict: "curuk", evidence: MEASURED },
  );
  await crossCheck(claim({ verdict: "curuk" }), runner, { secondModel: "m-b" });
  const p = callAt(runner, 1).prompt;
  assert.match(p, /IFADE C/);
  assert.ok(p.includes("sadece anlatı"), "1. turun izi 2. turda görünmeli");
  assert.match(p, /otorite değil/);
  assert.doesNotMatch(p, /senin hükmün|kendi hükmün|önceki cevab/i);
});

test("the claim travels with the request so the caller can build its own transport", async () => {
  const c = claim({ verdict: "curuk" });
  const runner = recordingRunner({ verdict: "curuk", evidence: MEASURED });
  await crossCheck(c, runner);
  assert.equal(callAt(runner, 0).claim, c);
  assert.equal(callAt(runner, 0).model, null, "model verilmediyse 'hükmü üreten modelle aynı' demek");
});
