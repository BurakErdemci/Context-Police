import { test } from "node:test";
import assert from "node:assert/strict";
import { findCandidates, MAX_NOTES_PER_ANCHOR } from "../src/signals/contradiction.ts";

const note = (findingId: number, over: Partial<Parameters<typeof findCandidates>[0][0]> = {}) => ({
  findingId, content: "içerik", anchors: [], description: null, hasStatus: false, ...over,
});

test("çapraz yüzey: aynı çapayı paylaşan çift aday olur, çift yönde tek kayıt", () => {
  const a = { kind: "file_path" as const, value: "src/x.ts" };
  const { candidates } = findCandidates([
    note(1, { anchors: [a] }), note(2, { anchors: [a] }), note(3),
  ]);
  const cross = candidates.filter((c) => c.kind === "cross");
  assert.equal(cross.length, 1);
  assert.deepEqual([cross[0]!.aId, cross[0]!.bId], [1, 2]);
  assert.ok(cross[0]!.reason.includes("src/x.ts"));
});

// reason yalnız prompt'a değil denetim olayına da yazılıyor (audit.ts:
// contradiction_confirmed + signal_scored). Sınır bu yüzden üretim yerinde.
test("çapa etiketi reason'a sınırsız girmez: uzun yol kırpılır", () => {
  const a = { kind: "file_path" as const, value: `${"a/".repeat(100_000)}x.ts` };
  const { candidates } = findCandidates([note(1, { anchors: [a] }), note(2, { anchors: [a] })]);
  const cross = candidates.find((c) => c.kind === "cross")!;
  assert.ok(cross.reason.length < 300, `reason sınırsız: ${cross.reason.length} karakter`);
  assert.ok(cross.reason.startsWith("ortak çapa: a/a/"));
});

test("4'ten çok notta geçen çapa ayırt edici değil: çift üretmez, sayılır (sessiz kırpma yok)", () => {
  const a = { kind: "file_path" as const, value: "README.md" };
  const many = Array.from({ length: MAX_NOTES_PER_ANCHOR + 1 }, (_, i) => note(i + 1, { anchors: [a] }));
  const { candidates, skippedAnchors } = findCandidates(many);
  assert.equal(candidates.filter((c) => c.kind === "cross").length, 0);
  assert.equal(skippedAnchors, 1);
});

test("not içi (DURUM'lu) ve frontmatter (description'lı) yüzeyleri", () => {
  const { candidates } = findCandidates([
    note(1, { hasStatus: true }),
    note(2, { description: "özet satırı" }),
    note(3),
  ]);
  assert.deepEqual(
    candidates.map((c) => [c.kind, c.aId]),
    [["intra", 1], ["frontmatter", 2]],
  );
});
