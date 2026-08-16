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
