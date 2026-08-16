#!/usr/bin/env bash
# PreToolUse guard: protect this project's two irreplaceable assets.
#
#   1. ~/.context-police/  — the live store and the golden notes it holds. This
#      is the user's real memory data. Read freely, never write. During the M3
#      audit its integrity was checked by comparing store.db's md5 by hand
#      (34b69f40e57314094dba492770dfa57d) — a habit, not a guarantee.
#   2. docs/olcumler/altin-set/golden-*.jsonl — the measuring instrument every
#      score in this project is computed against. Silently altering it
#      invalidates every published number with nothing downstream able to catch
#      it, which is the exact failure class this project exists to detect.
#
# MODIFYING an existing golden file is blocked; CREATING a new one is not.
# golden-v2.jsonl was legitimately produced from v1 by
# tools/altin-set/apply-corrections.ts, and a future v3 must follow the same
# path. "Copy and work on the copy" is the rule, so a new name is always fine.
#
# Two layers, because neither is sufficient alone:
#   - Write/Edit: exact, matches on file_path.
#   - Bash: best-effort. A shell regex cannot see through a script that writes
#     the path indirectly, so this catches the direct mistake, not every
#     possible one. It is a guard rail, not a sandbox.
#
# Exit 0 = allow, exit 2 = block (stderr is shown to Claude).
# Remove: delete the PreToolUse entries from .claude/settings.json and this file.

set -uo pipefail

cat | HOME="$HOME" node -e '
const path = require("path");
const fs = require("fs");

const HOME = process.env.HOME || "";
const STORE = path.join(HOME, ".context-police");

let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  let p;
  try { p = JSON.parse(s); } catch { process.exit(0); }
  const name = p?.tool_name ?? "";
  const t = p?.tool_input ?? {};

  const block = (why) => { process.stderr.write("BLOCKED: " + why + "\n"); process.exit(2); };

  // --- Layer 1: exact, for the file-editing tools -------------------------
  const target = t.file_path ?? t.notebook_path;
  if (typeof target === "string" && target.length > 0) {
    const abs = path.resolve(target);
    if (abs === STORE || abs.startsWith(STORE + path.sep)) {
      block("~/.context-police/ is the live memory store. It is read-only for this project — copy it out and work on the copy.");
    }
    if (/\/docs\/olcumler\/altin-set\/golden-[^/]*\.jsonl$/.test(abs) && fs.existsSync(abs)) {
      block("golden-*.jsonl is the measuring instrument every score is computed against, and this one already exists. Editing it invalidates every published number silently. Write a NEW golden file (the apply-corrections.ts path) instead.");
    }
    process.exit(0);
  }

  // --- Layer 2: best-effort, for shell commands ---------------------------
  if (name !== "Bash") process.exit(0);
  const cmd = t.command ?? "";
  if (typeof cmd !== "string" || !cmd) process.exit(0);

  const mentionsStore  = /(\$HOME|~|\/Users\/[^/\s]+)\/\.context-police\b/.test(cmd);
  const mentionsGolden = /golden-[A-Za-z0-9._-]*\.jsonl/.test(cmd);
  if (!mentionsStore && !mentionsGolden) process.exit(0);

  // Mutating constructs. Plain reads (cat/grep/wc/jq/head) fall through, and
  // they have to: scoring reads the golden set on every run.
  const mutates =
    />>?\s*[^\s|&;]*(\.context-police|golden-)/.test(cmd) ||
    /\b(rm|mv|cp|truncate|shred|install)\b/.test(cmd) ||
    /\bsed\b[^|;]*-[a-zA-Z]*i/.test(cmd) ||
    /\btee\b/.test(cmd) ||
    /\bdd\b[^|;]*\bof=/.test(cmd);
  if (!mutates) process.exit(0);

  block(
    (mentionsStore ? "~/.context-police/ (live memory store)" : "golden-*.jsonl (the measuring instrument)") +
    " appears in a command that writes, moves or deletes. Both are read-only for this project. " +
    "If this is a legitimate new artifact, use a new filename outside those paths."
  );
});
'
