// M4.6 — anchor quality. Two defects fixed in importer/parse.ts:
//   1. PATH_RE was quadratic in the length of one unbroken [\w.-] run.
//   2. The symbol pattern matched any backticked word, so prose keywords became
//      anchors and an anchor that matches everything cannot be a trigger.
//
// Measurements behind the assertions (15 Aug 2026, node 24.10 / macOS):
//   - 256 KiB single run: 32.722 ms -> 0,89 ms. Old grew exactly 4x per doubling
//     (4 KiB 9,8 · 8 KiB 34,4 · 16 KiB 136 · 32 KiB 550 · 64 KiB 2.109 ·
//     128 KiB 8.024 ms); new stays linear to 64 MiB (216 ms).
//   - Symbol selectivity over the 28 golden GaMachine notes, scored by commits
//     touched (`git log --all -S<sym>`, 263-commit repo): rejected symbols median
//     23 commits / mean 38,2 (worst `return` 193 = 73% of history); kept symbols
//     median 3 / mean 5,3 (worst `workspace_path` 35).

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAnchors } from "../src/importer/parse.ts";

const values = (text: string, kind: string) =>
  extractAnchors(text).anchors.filter((a) => a.kind === kind).map((a) => a.value);

test("a path glued to the preceding token produces no path anchor", () => {
  // The one input class the linearising lookbehind changes. Previously the engine
  // restarted mid-token and emitted the tail; re-measured over 122 real note files
  // the class occurs ZERO times, so it is pinned here rather than by corpus.
  assert.deepEqual(values("see~/x/a.ts", "external_path"), []);
  assert.deepEqual(values("see~/x/a.ts", "file_path"), []);
});

test("a glued absolute path cannot be re-read as a relative one", () => {
  // Sharper form of the same class: restarting one character later flipped the
  // anchor's KIND, which is worse than dropping it — `/a/b.ts` (external_path)
  // and `a/b.ts` (file_path) are checked against git differently.
  const { anchors } = extractAnchors("foo//a/b.ts");
  assert.deepEqual(anchors, []);
});

test("paths at a token boundary are still extracted", () => {
  // Guards the lookbehind against over-restriction: separators that legitimately
  // precede a path must not suppress it.
  assert.deepEqual(values("see ~/x/a.ts here", "external_path"), ["~/x/a.ts"]);
  assert.deepEqual(values("(src/a.ts) and [lib/b.ts]", "file_path"), ["src/a.ts", "lib/b.ts"]);
  assert.deepEqual(values("/Users/x/y.ts", "external_path"), ["/Users/x/y.ts"]);
});

test("a dash-prefixed path is still refused after the lookbehind", () => {
  // The flag-shaped rejection (audit: imported-flag-anchor) must survive: ASCII
  // dash is inside PATH_RE's class, the unicode variants are not, and the two
  // reach the rejection by different routes.
  assert.deepEqual(extractAnchors("--output/tmp/audit.txt").anchors, []);
  assert.deepEqual(extractAnchors("—src/a.ts").anchors, []);
});

test("a pathological single run is linear, not quadratic", () => {
  // 128 KiB unbroken run. Measured old 8.024 ms, new 0,62 ms. The 500 ms bound is
  // ~800x the measured cost and ~16x below the old cost, so it separates the two
  // regimes without being sensitive to machine speed.
  const pathological = "a/b/" + "a".repeat(128 * 1024);
  const t = process.hrtime.bigint();
  extractAnchors(pathological);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 500, `pathological input took ${ms.toFixed(1)} ms — quadratic behaviour is back`);
});

test("prose keywords in backticks are not symbol anchors", () => {
  // Every one of these is a real extraction from the golden set. Commits touched
  // in the 263-commit measurement repo: return 193, list 142, type 131, None 127,
  // write 115, false 114, const 113, true 108, null 101, value 94, tool 93.
  const noise = ["return", "true", "null", "type", "const", "false", "list", "value", "tool", "memory", "HEAD", "PATH"];
  const text = noise.map((w) => `\`${w}\``).join(" and ");
  assert.deepEqual(values(text, "symbol"), []);
});

test("naming-convention markers keep a symbol", () => {
  // The three shapes the rule accepts: separator, camelCase, PascalCase compound.
  assert.deepEqual(
    values("`write_file` `_resolve_binary` `unityMCP` `cyberPolicy` `ToastContainer` `IOException` `$element`", "symbol"),
    ["write_file", "_resolve_binary", "unityMCP", "cyberPolicy", "ToastContainer", "IOException", "$element"],
  );
});

test("a call suffix does not rescue a low-selectivity word", () => {
  // Measured and rejected as an escape hatch: across the golden set only 16
  // symbols are written as `name()`, and it would rescue exactly 3 rejected ones
  // (decide, Sync, poll) — all still low-selectivity words.
  assert.deepEqual(values("`decide()` `poll()` `Sync()`", "symbol"), []);
  assert.deepEqual(values("`_self_check()`", "symbol"), ["_self_check"]);
});

test("a note whose only backticked words are keywords stays unanchored", () => {
  // M0-D5: an unanchored note is neutral and scores nothing. That is the correct
  // outcome — better than a false anchor that makes the note look verifiable.
  assert.deepEqual(extractAnchors("The agent will `return` the `value` of `type`.").anchors, []);
});

test("dropping keyword symbols frees cap budget for real ones", () => {
  // Real effect measured on the golden set: 7 of 28 notes had genuine symbols
  // pushed out of the 16-anchor cap by keyword noise and now keep them. Shape
  // reproduced here: keywords appear first, so under the old pattern they took
  // the first 6 of the 16 slots and the last real symbols fell off the end.
  const noise = ["return", "true", "null", "type", "const", "false"];
  const real = Array.from({ length: 18 }, (_, i) => `run_step_${String.fromCharCode(97 + i)}`);
  // Cap widened by variant C (17 Aug 2026): symbols draw on their own 6-slot
  // display budget plus whatever the measurable budget leaves, so a symbol-only
  // note keeps up to 22. If the keywords still counted, the first 6 slots would
  // be theirs and the last real symbols would fall off — the discrimination the
  // assertion carries is unchanged.
  const got = values([...noise, ...real].map((w) => `\`${w}\``).join(" "), "symbol");
  assert.deepEqual(got, real);
});
