import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openStore } from "../src/store/db.ts";
import { tmpStorePath } from "./helpers.ts";

const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");

test("serve komutu açılır, summary servis eder, SIGTERM ile kapanır", async () => {
  const path = tmpStorePath();
  openStore(path).close(); // boş ama gerçek depo
  const port = 4899;
  const child = spawn(process.execPath,
    ["--disable-warning=ExperimentalWarning", cliPath, "serve", "--store", path, "--port", String(port)],
    { stdio: ["ignore", "pipe", "pipe"] });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(200);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/summary`);
        up = r.status === 200;
      } catch { /* not yet */ }
    }
    assert.ok(up, "sunucu 10 sn içinde ayağa kalkmadı");
  } finally {
    child.kill("SIGTERM");
    await new Promise((res) => child.once("exit", res));
  }
});

test("bilinmeyen seçenek reddedilir", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", cliPath, "serve", "--bogus", "1"],
    { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 1);
});
