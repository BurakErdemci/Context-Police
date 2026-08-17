// Thin fetch wrapper. `storeMissing` / `schemaOutdated` responses are passed
// through as-is (they are 200s with a structured body, not HTTP errors) —
// screens decide how to render them.
export async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * A refused review. `status` is 0 when the request never reached the server
 * (offline, server down) — the caller needs that apart from a real 4xx so it
 * can say "unreachable" instead of "refused".
 */
export class ReviewError extends Error {
  constructor(status, body) {
    super(`review: ${status}`);
    this.name = "ReviewError";
    this.status = status;
    this.body = body;
  }
}

/**
 * The one write the explorer performs. `X-CP-Review` is not decoration: the
 * server rejects the request without it (design §3) — a cross-origin page
 * cannot set a custom header without a preflight, and none is answered.
 */
export async function postReview(id, decision) {
  let res;
  try {
    res = await fetch(`/api/verdicts/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-CP-Review": "1" },
      body: JSON.stringify({ decision }),
    });
  } catch (err) {
    throw new ReviewError(0, null);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* an error response is not guaranteed to be JSON; status alone still speaks */
  }
  if (!res.ok) throw new ReviewError(res.status, body);
  return body;
}
