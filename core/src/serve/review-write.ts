// The ONE deliberate relaxation of the explorer's read-only guarantee
// (design §2). Every other module under serve/ is typed against `ReadStore`;
// this file is the only one allowed to import `openStore`.
//
// The store handle is opened and closed PER CALL. A long-lived writable handle
// would widen the race window against a running audit for no gain — approval is
// a rare, user-driven action.
//
// Deliberately HTTP-free: this is the seam a Tauri IPC command calls directly,
// so no request, header or origin concept may leak in here.

import { existsSync } from "node:fs";
import { closeQuietly, openStore } from "../store/db.ts";
import { getVerdict, reviewVerdict } from "../store/verdicts.ts";
import type { VerdictRecord } from "../store/verdicts.ts";

export type ReviewDecision = "approved" | "rejected";

export type ReviewFailure = "not_found" | "already_decided" | "superseded" | "store_missing";

export type ReviewResult =
  | { ok: true; row: VerdictRecord }
  | { ok: false; code: ReviewFailure };

export function applyReview(
  storePath: string,
  verdictId: number,
  decision: ReviewDecision,
): ReviewResult {
  // `openStore` CREATES the file it cannot find. On a write path a missing
  // store must not look like a fresh empty success (design §3), so existence is
  // checked before the handle is opened, never after.
  if (!existsSync(storePath)) return { ok: false, code: "store_missing" };

  const store = openStore(storePath);
  try {
    const before = getVerdict(store, verdictId);
    if (before === undefined) return { ok: false, code: "not_found" };
    if (before.supersededBy !== null) return { ok: false, code: "superseded" };
    if (before.review !== "pending") return { ok: false, code: "already_decided" };
    // reviewVerdict re-checks liveness inside its own transaction; a false here
    // means another writer superseded the row between the read and the write.
    if (!reviewVerdict(store, verdictId, decision)) return { ok: false, code: "superseded" };
    return { ok: true, row: getVerdict(store, verdictId)! };
  } finally {
    closeQuietly(store);
  }
}
