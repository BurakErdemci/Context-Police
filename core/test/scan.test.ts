import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { scanOnce } from "../src/scan.ts";
import { listProjects } from "../src/store/projects.ts";
import { countEvents } from "../src/store/events.ts";
import { tmpDir } from "./helpers.ts";
import type { Turn } from "../src/types.ts";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const userLine = (text: string, cwd?: string) =>
  line({ type: "user", ...(cwd ? { cwd } : {}), message: { role: "user", content: text } });

function fakeRoot() {
  const root = tmpDir();
  const dir = join(root, "-tmp-proje-a");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "memory"));
  writeFileSync(join(dir, "sess-1.jsonl"), userLine("bir", "/tmp/proje-a") + userLine("iki"));
  return { root, dir };
}

test("uçtan uca: proje kaydediliyor, turn'ler süzülüyor, imleç ilerliyor", async () => {
  const { root } = fakeRoot();
  const store = openStore(":memory:");
  const seen: Turn[] = [];

  const sum = await scanOnce(store, {
    adapter: claudeCodeAdapter,
    root,
    onTurns: ({ turns }) => void seen.push(...turns),
  });

  assert.equal(sum.projects, 1);
  assert.equal(sum.turns, 2);
  assert.deepEqual(seen.map((t) => t.text), ["bir", "iki"]);

  const projects = listProjects(store);
  assert.equal(projects[0]!.path, "/tmp/proje-a", "yol cwd'den çözülmeli");
  assert.ok(projects[0]!.memory_dir, "memory dizini yakalanmalı");
  store.close();
});

test("ikinci tarama sıfır iş yapar (imleç kalıcılığı)", async () => {
  const { root } = fakeRoot();
  const store = openStore(":memory:");

  const first = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(first.turns, 2);

  const second = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(second.turns, 0, "aynı veri iki kez işlenmemeli");
  assert.equal(second.sessionsTouched, 0);
  store.close();
});

test("yeni satır eklenince yalnız o işlenir", async () => {
  const { root, dir } = fakeRoot();
  const store = openStore(":memory:");
  await scanOnce(store, { adapter: claudeCodeAdapter, root });

  appendFileSync(join(dir, "sess-1.jsonl"), userLine("üç"));
  const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(sum.turns, 1);
  store.close();
});

test("bilinmeyen satır tipi olaya yazılır — sessizce yutulmaz", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-b");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "s.jsonl"),
    userLine("x", "/tmp/b") + line({ type: "yepyeni-tip" }) + "{bozuk\n",
  );

  const store = openStore(":memory:");
  const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(sum.unknown, 1);
  assert.equal(sum.malformed, 1);
  assert.equal(countEvents(store, "unknown_line_type"), 1);
  assert.equal(countEvents(store, "malformed_line"), 1);
  store.close();
});

test("çözülemeyen proje anahtarı raporlanıyor ama proje düşmüyor", async () => {
  const root = tmpDir();
  const dir = join(root, "-var-olmayan-abc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), line({ type: "mode" }));

  const store = openStore(":memory:");
  const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(sum.projects, 1);
  assert.equal(sum.unresolvedProjects, 1);
  assert.equal(countEvents(store, "unresolved_project_key"), 1);
  store.close();
});

test("only filtresi yalnız verilen projeyi tarar", async () => {
  const root = tmpDir();
  for (const [key, cwd] of [["-tmp-x", "/tmp/x"], ["-tmp-y", "/tmp/y"]] as const) {
    mkdirSync(join(root, key), { recursive: true });
    writeFileSync(join(root, key, "s.jsonl"), userLine("t", cwd));
  }
  const store = openStore(":memory:");
  const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root, only: ["/tmp/y"] });
  assert.equal(sum.projects, 1);
  assert.equal(listProjects(store)[0]!.path, "/tmp/y");
  store.close();
});
