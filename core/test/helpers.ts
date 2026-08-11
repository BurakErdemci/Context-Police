import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { ExecutorAdapter, ExecutorRequest, ExecutorResult } from "../src/adapters/executor.ts";

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

type FakeStep = Partial<ExecutorResult> | ((req: ExecutorRequest) => Partial<ExecutorResult>);

/**
 * Senaryolu sahte yürütücü. Her run() çağrısı senaryodan bir adım tüketir;
 * senaryo biterse varsayılan "boş bulgu" cevabı döner. Çağrılar `calls`te
 * birikir — testler prompt içeriğini buradan denetler.
 */
export function fakeExecutor(script: FakeStep[]): ExecutorAdapter & { calls: ExecutorRequest[] } {
  const calls: ExecutorRequest[] = [];
  let i = 0;
  return {
    id: "fake",
    calls,
    async detect() {
      return { found: true, version: "fake-1.0.0" };
    },
    async run(req) {
      calls.push(req);
      const step = script[i++];
      const partial = typeof step === "function" ? step(req) : (step ?? {});
      return {
        ok: partial.ok ?? true,
        output: partial.output ?? '{"findings":[]}',
        error: partial.error,
        durationMs: partial.durationMs ?? 1,
      };
    },
  };
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
