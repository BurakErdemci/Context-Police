import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, appendFileSync, mkdirSync, truncateSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { scanOnce } from "../src/scan.ts";
import { listProjects, upsertProject } from "../src/store/projects.ts";
import { countEvents } from "../src/store/events.ts";
import { observeGuard, estimateSessionCalls, validateBatchTokens } from "../src/observe-cmd.ts";
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

test("sel koruması: imleçsiz depo observe'u reddeder, --yes geçer (D-M2-4)", () => {
  const store = openStore(":memory:");
  const g1 = observeGuard(store, false);
  assert.equal(g1.ok, false);
  assert.match(g1.reason!, /scan/);
  assert.equal(observeGuard(store, true).ok, true);

  // Bir imleç varsa taban çizgisi var demektir: serbest.
  const pid = upsertProject(store, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });
  store.run(
    "INSERT INTO cursors (file_path, project_id, session_id, byte_offset) VALUES (?,?,?,?)",
    "/t/s.jsonl", pid, "s", 10,
  );
  assert.equal(observeGuard(store, false).ok, true);
  store.close();
});

test("çağrı tahmini: süzülmüş bayt → parti sayısı", () => {
  // 8000 token'lık parti ≈ 32000 bayt.
  assert.equal(estimateSessionCalls(0, 8000), 0);
  assert.equal(estimateSessionCalls(31_999, 8000), 1);
  assert.equal(estimateSessionCalls(64_001, 8000), 3);
});

test("--batch-tokens doğrulaması: tam sayı ve ≥500 (üst sınır: audit-m2-cli)", () => {
  assert.equal(validateBatchTokens(undefined), 8000);
  assert.equal(validateBatchTokens("500"), 500);
  assert.equal(validateBatchTokens("12000"), 12000);
  // Küçük değer: cutBatches maxTokens<16'da negatif subarray üretiyor (Görev 4
  // ölçümü) ve küçük partiler maliyeti katlıyor.
  assert.throws(() => validateBatchTokens("8"), /geçersiz --batch-tokens/);
  assert.throws(() => validateBatchTokens("0"), /geçersiz --batch-tokens/);
  assert.throws(() => validateBatchTokens("-1000"), /geçersiz --batch-tokens/);
  // Sayı olmayan / tam sayı olmayan.
  assert.throws(() => validateBatchTokens("abc"), /geçersiz --batch-tokens/);
  assert.throws(() => validateBatchTokens(""), /geçersiz --batch-tokens/);
  assert.throws(() => validateBatchTokens("8000.5"), /geçersiz --batch-tokens/);
  assert.throws(() => validateBatchTokens("Infinity"), /geçersiz --batch-tokens/);
});

// --- kilit tanıtıcısının dışarı verilmesi (sinyal temizliği) -----------------

test("scanOnce kilit tanıtıcısını dışarı verir ve iş bitince kancayı söker", async () => {
  // Kilit taramanın İÇİNDE alınıyor, dolayısıyla CLI onu kendi sinyal
  // kancasına bağlayamıyordu; `observe --session` ve `audit` bağlayabildiği
  // için yalnız `scan` yolu SIGTERM'de kilidi asılı bırakıyordu. Dikiş burada.
  const { root } = fakeRoot();
  const store = openStore(":memory:");
  let tutuluyken: string | undefined;
  let sokuldu = false;
  await scanOnce(store, {
    adapter: claudeCodeAdapter,
    root,
    onLock: (lock) => {
      tutuluyken = lock.holder;
      // Kanca gerçekten kilit ALINDIKTAN sonra kuruluyor mu: satır ortada olmalı.
      assert.ok(store.get("SELECT holder FROM scan_lock WHERE id = 1"));
      return () => { sokuldu = true; };
    },
  });
  assert.ok(tutuluyken, "kilit tanıtıcısı hiç verilmedi");
  assert.ok(sokuldu, "sökme fonksiyonu çağrılmadı: kanca listesi koşumdan koşuma birikirdi");
  store.close();
});

test("scan: SIGTERM kilidi asılı bırakmaz", async () => {
  // Ölçüldü (probe: scan-sigterm-leaves-lock): `process.exit()` finally'leri
  // koşturmuyor, dolayısıyla kilit satırı diskte kalıyor ve sonraki koşum
  // bayatlama süresi (10 dk) boyunca ScanLockBusy alıyordu.
  const root = tmpDir();
  const dir = join(root, "-tmp-uzun-tarama");
  mkdirSync(dir, { recursive: true });
  const dosya = join(dir, "sess-uzun.jsonl");
  writeFileSync(dosya, "");
  // SEYREK 1 GB: diskte yer kaplamıyor ama taramayı sinyal atacak kadar
  // (ölçüldü: ~400 MB/sn, yani ~2,5 sn) ayakta tutuyor. Sabit bir uyku yerine
  // gerçek iş: testin beklediği şey tam da "iş sürerken sinyal".
  truncateSync(dosya, 1024 * 1024 * 1024);
  const storePath = join(root, "store.db");

  const child = spawn(process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "..", "src", "cli.ts"),
      "scan", "--dir", root, "--store", storePath],
    { stdio: "ignore" });
  const bitti = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));

  const kilitVar = (): boolean => {
    if (!existsSync(storePath)) return false;
    try {
      const db = new DatabaseSync(storePath, { readOnly: true });
      const row = db.prepare("SELECT holder FROM scan_lock WHERE id = 1").get();
      db.close();
      return row !== undefined;
    } catch {
      return false; // depo henüz kurulmadı ya da yazılıyor
    }
  };
  let alindi = false;
  for (let i = 0; i < 250 && !alindi; i++) {
    alindi = kilitVar();
    if (!alindi) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(alindi, "tarama kilidi hiç görülmedi: senaryo kurulmadı (sinyal erken atılırdı)");

  child.kill("SIGTERM");
  assert.equal(await bitti, 143, "SIGTERM kabuk sözleşmesiyle 128+15 dönmeli");
  assert.equal(kilitVar(), false,
    "scan SIGTERM'de kilidi asılı bıraktı: sonraki koşum 10 dakika ScanLockBusy alır");
});
