import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const dirs: string[] = [];

/** Test için geçici dizin. Süreç sonunda silinir — gerçek depoya asla dokunulmaz. */
export function tmpDir(prefix = "cp-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export function tmpStorePath(): string {
  return join(tmpDir(), "store.db");
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
