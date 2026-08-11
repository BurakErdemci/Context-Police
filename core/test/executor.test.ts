import { test } from "node:test";
import assert from "node:assert/strict";
import { registerExecutor, getExecutor } from "../src/adapters/executor.ts";
import { fakeExecutor } from "./helpers.ts";

test("registry kayıtlı yürütücüyü döndürür, bilinmeyeni adlarıyla reddeder", () => {
  const fake = fakeExecutor([]);
  registerExecutor(fake);
  assert.equal(getExecutor(fake.id), fake);
  assert.throws(() => getExecutor("yok-boyle-motor"), /bilinmeyen yürütücü/);
});

test("fakeExecutor senaryoyu sırayla oynar ve istekleri kaydeder", async () => {
  const fake = fakeExecutor([
    { output: '{"findings":[]}' },
    (req) => ({ ok: false, error: `patladı: ${req.prompt.slice(0, 5)}` }),
  ]);
  const r1 = await fake.run({ prompt: "birinci" });
  assert.equal(r1.ok, true);
  assert.equal(r1.output, '{"findings":[]}');
  const r2 = await fake.run({ prompt: "ikinci" });
  assert.equal(r2.ok, false);
  assert.match(r2.error!, /patladı: ikinc/);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0]!.prompt, "birinci");
});
