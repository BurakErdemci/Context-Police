import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClassifyPrompt, parseClassifyOutput, classifyCandidates, MAX_CLASSIFY_ITEMS, CLASSIFY_OUTPUT_SCHEMA,
} from "../src/signals/classify.ts";
import { fakeExecutor } from "./helpers.ts";
import type { Candidate, NoteView } from "../src/signals/contradiction.ts";

const note = (findingId: number, content: string, description: string | null = null): NoteView =>
  ({ findingId, content, anchors: [], description, hasStatus: false });
const cand = (aId: number, bId: number | null, kind: Candidate["kind"] = "cross"): Candidate =>
  ({ kind, aId, bId, reason: "test" });

test("şema strict-mode uyumlu: her property required listesinde (M2 dersi)", () => {
  const item = (CLASSIFY_OUTPUT_SCHEMA as any).properties.verdicts.items;
  assert.deepEqual(Object.keys(item.properties).sort(), [...item.required].sort());
});

test("prompt ölçüm çerçevesi taşır ve alıntıları sınırlar (cyberPolicy dersi + §2.2)", () => {
  const long = "x".repeat(9000);
  const p = buildClassifyPrompt([{ index: 0, kind: "cross", aText: long, bText: "kısa", reason: "ortak çapa" }]);
  assert.ok(p.includes("ÇELİŞİYOR MU"));
  assert.ok(!/\bkır\b|saldır/i.test(p));
  assert.ok(p.length < 5000); // alıntı kırpıldı
});

// Denetim: classify-reason-unbounded. Gövdeler kırpılıyordu ama reason kırpılmıyordu;
// ölçüldü: 200.007 karakterlik tek bir yol çapası, gövdeler kısayken 200.449
// karakterlik prompt üretiyor — her denetimde bellek, stdin ve model bağlamı.
test("aday gerekçesi de kırpılır: uzun bir çapa promptu şişiremez", () => {
  const p = buildClassifyPrompt([{
    index: 0, kind: "cross", aText: "kısa", bText: "kısa", reason: `ortak çapa: ${"a/".repeat(100_000)}x.ts`,
  }]);
  assert.ok(p.length < 5000, `prompt sınırsız: ${p.length} karakter`);
  assert.ok(p.includes("ortak çapa: a/a/")); // teşhis için baş kısım duruyor
});

test("parseClassifyOutput: düzyazıya sarılı JSON kurtarılır, aralık dışı index atılır", () => {
  const raw = 'Sonuç:\n{"verdicts":[{"index":0,"verdict":"celiski","evidence":"e"},{"index":9,"verdict":"uyumlu","evidence":"e"}]}\nbitti';
  const r = parseClassifyOutput(raw, 1);
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.verdicts.length, 1); assert.equal(r.verdicts[0]!.verdict, "celiski"); }
});

test("classifyCandidates: onaylanan çift döner, tavan üstü aday sayılır, tek çağrı", async () => {
  const notes = new Map([[1, note(1, "A doğru")], [2, note(2, "A yanlış")], [3, note(3, "ilgisiz")]]);
  const many = [cand(1, 2), ...Array.from({ length: MAX_CLASSIFY_ITEMS + 2 }, () => cand(1, 3))];
  const fake = fakeExecutor([
    { output: '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"zıt ifadeler"}]}' },
  ]);
  const r = await classifyCandidates(fake, many, notes);
  assert.equal(r.ok, true);
  assert.equal(r.confirmed.length, 1);
  assert.deepEqual([r.confirmed[0]!.aId, r.confirmed[0]!.bId], [1, 2]);
  assert.equal(r.dropped, 3); // tavan üstü — sessiz değil
  assert.equal(fake.calls.length, 1);
});

test("bozuk JSON'da bir düzeltme turu, yine bozuksa ok=false (spec §3.7)", async () => {
  const notes = new Map([[1, note(1, "a")], [2, note(2, "b")]]);
  const fake = fakeExecutor([{ output: "bozuk" }, { output: "yine bozuk" }]);
  const r = await classifyCandidates(fake, [cand(1, 2)], notes);
  assert.equal(r.ok, false);
  assert.equal(r.calls, 2);
});
