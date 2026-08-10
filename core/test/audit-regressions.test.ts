// Denetimden (10 Ağu 2026, codex-audit) doğan regresyon testleri.
//
// Her testin adı bulgunun sınıfıdır. Bunlar probe'lardan terfi ettirildi:
// probe script'i repoya girmez, iddiası girer. Bir düzeltmenin ileride geri
// alınması bu dosyayı kırar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, statSync, openSync, writeSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { claudeCodeAdapter, parseLine, readIncremental } from "../src/adapters/claude-code.ts";
import { scanOnce } from "../src/scan.ts";
import { appendFinding } from "../src/store/findings.ts";
import { logEvent, listEvents, countEvents } from "../src/store/events.ts";
import { upsertProject } from "../src/store/projects.ts";
import { tmpDir, tmpStorePath } from "./helpers.ts";
import type { DiscoveredProject, TranscriptAdapter } from "../src/types.ts";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const userLine = (text: string, cwd?: string) =>
  line({ type: "user", ...(cwd ? { cwd } : {}), message: { role: "user", content: text } });

// class: uncontained-transcript-shape
test("tek bir `null` satırı taramayı kilitlemez", async () => {
  // Denetim: JSON.parse("null") null döner, obj.type patlardı; imleç
  // ilerlemediği için her tarama aynı yerde ölüyordu — kalıcı kilit.
  assert.equal(parseLine("null").kind, "malformed");
  assert.equal(parseLine("[1,2,3]").kind, "malformed");
  assert.equal(parseLine('"düz dize"').kind, "malformed");

  const root = tmpDir();
  const dir = join(root, "-tmp-null");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), userLine("önce", "/tmp/null") + "null\n" + line({ type: "sonraki-tip" }));

  const store = openStore(":memory:");
  const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(sum.turns, 1, "null'dan önceki turn işlenmeli");
  assert.equal(sum.malformed, 1);
  assert.equal(sum.unknown, 1, "null'dan SONRAKİ satır da işlenmeli");
  assert.equal(countEvents(store, "unknown_line_type"), 1);
  store.close();
});

// class: audit-event-loss
test("altı farklı bilinmeyen tip: altısı da olaya düşer (beş sınırı yok)", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-cok-tip");
  mkdirSync(dir, { recursive: true });
  const lines = [userLine("x", "/tmp/cok-tip")];
  for (let i = 1; i <= 6; i++) lines.push(line({ type: `yeni-tip-${i}` }));
  writeFileSync(join(dir, "s.jsonl"), lines.join(""));

  const store = openStore(":memory:");
  const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(sum.unknown, 6);
  const types = listEvents(store, { kind: "unknown_line_type" }).map(
    (e) => JSON.parse(e.detail!).lineType as string,
  );
  for (let i = 1; i <= 6; i++) {
    assert.ok(types.includes(`yeni-tip-${i}`), `yeni-tip-${i} olaya düşmedi — sessizce yutuldu`);
  }
  store.close();
});

// class: unfiltered-transcript-persistence
test("bilinmeyen satır olayı transcript İÇERİĞİ taşımaz, yalnız şekil", async () => {
  // Denetim: ham satırın ilk 200 karakteri events.detail'e yazılıyordu. Bu
  // süzgeci baypas ediyordu — oturumdaki bir API anahtarı silinemez denetim
  // günlüğüne kalıcı düşebiliyordu.
  const SECRET = "sk-CANLI-ANAHTAR-1234567890";
  const root = tmpDir();
  const dir = join(root, "-tmp-sizinti");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "s.jsonl"),
    userLine("x", "/tmp/sizinti") +
      line({ type: "gelecek-tipi", message: { role: "user", content: [{ type: "tool_result", content: SECRET }] } }),
  );

  const path = tmpStorePath();
  const store = openStore(path);
  await scanOnce(store, { adapter: claudeCodeAdapter, root });
  const dump = listEvents(store, {}).map((e) => e.detail ?? "").join("\n");
  assert.ok(!dump.includes(SECRET), "gizli değer olay günlüğüne sızdı");
  // Teşhis değeri korunmalı: tip ve şekil hâlâ orada.
  assert.ok(dump.includes("gelecek-tipi"));
  assert.ok(dump.includes("message"), "üst düzey anahtarlar şekil olarak kalmalı");
  store.close();
});

// class: insecure-secret-storage-permissions
test("depo dizini 0700, veritabanı dosyaları 0600", () => {
  const prev = process.umask(0o022); // en gevşek yaygın umask altında bile
  try {
    const path = join(tmpDir(), "alt", "store.db");
    const store = openStore(path);
    logEvent(store, { kind: "scan_completed", detail: "x" });
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700, "depo dizini başkasına açık");
    for (const f of [path, `${path}-wal`]) {
      assert.equal(statSync(f).mode & 0o777, 0o600, `${f} başkasına okunur`);
    }
    store.close();
  } finally {
    process.umask(prev);
  }
});

// class: append-only-trigger-bypass
test("INSERT OR REPLACE append-only sözleşmesini delemez", () => {
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });
  const fid = appendFinding(store, { projectId: pid, source: "observed", content: "özgün" });
  logEvent(store, { projectId: pid, kind: "scan_completed", detail: "özgün olay" });
  const eid = store.get<{ id: number }>("SELECT id FROM events ORDER BY id DESC LIMIT 1")!.id;

  assert.throws(
    () =>
      store.run(
        "INSERT OR REPLACE INTO findings (id, project_id, source, content, created_at) VALUES (?,?,?,?,?)",
        fid, pid, "observed", "ELE GEÇİRİLDİ", "2026-08-10T00:00:00.000Z",
      ),
    /silinemez/,
  );
  assert.throws(
    () => store.run("INSERT OR REPLACE INTO events (id, at, kind) VALUES (?,?,?)", eid, "2026-08-10T00:00:00.000Z", "sahte"),
    /silinemez/,
  );
  assert.equal(store.get<{ content: string }>("SELECT content FROM findings WHERE id=?", fid)!.content, "özgün");
  store.close();
});

// class: transaction-rollback-failure
test("iç içe işlem geri alınabiliyor; async geri çağırım reddediliyor", () => {
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/p", adapterId: "claude-code", transcriptDir: "/t" });

  // Dış işlem iç hatayı yutarsa iç yazımlar da geri alınmalı.
  store.tx(() => {
    try {
      store.tx(() => {
        appendFinding(store, { projectId: pid, source: "observed", content: "yarım" });
        throw new Error("iç hata");
      });
    } catch {
      /* dış işlem devam ediyor */
    }
    appendFinding(store, { projectId: pid, source: "observed", content: "sağlam" });
  });
  const contents = store.all<{ content: string }>("SELECT content FROM findings").map((r) => r.content);
  assert.deepEqual(contents, ["sağlam"], "geri alınmayan yarım yazım kaldı");

  // Async geri çağırım sessizce erken commit edilirdi; artık gürültülü hata.
  assert.throws(() => store.tx((() => Promise.resolve(1)) as unknown as () => number), /senkron/);
  store.close();
});

// class: stale-cursor-after-truncation / transcript-generation-confusion
test("yerinde kısaltma ve aynı boyutta yeniden yazım tarama seviyesinde yakalanır", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-kisalma");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "s.jsonl");
  writeFileSync(f, userLine("bir", "/tmp/kisalma") + userLine("iki") + userLine("uc"));

  const store = openStore(":memory:");
  const first = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(first.turns, 3);

  // (a) yerinde kısaltma — inode aynı, boyut küçük
  const inodeBefore = statSync(f).ino;
  writeFileSync(f, userLine("yeni-tek", "/tmp/kisalma"));
  assert.equal(statSync(f).ino, inodeBefore, "test kurulumu: inode değişmemeli");
  const second = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(second.truncations, 1, "kısalma tespit edilmedi");
  assert.equal(second.turns, 1, "kısaltılan dosyanın yeni içeriği okunmadı");

  // (b) aynı boyutta farklı içerik, farklı inode
  const before = statSync(f).size;
  const other = join(dir, "tmp.jsonl");
  writeFileSync(other, userLine("degisik!", "/tmp/kisalma"));
  const fd = openSync(other, "r+");
  writeSync(fd, Buffer.alloc(Math.max(0, before - statSync(other).size), 0x20), 0, Math.max(0, before - statSync(other).size), statSync(other).size);
  closeSync(fd);
  renameSync(other, f);
  const third = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(third.truncations, 1, "aynı boyutlu değişim (inode farkı) yakalanmadı");
  store.close();
});

// class: transcript-generation-confusion (en zor varyant)
test("aynı boyut VE aynı inode ile yerinde yeniden yazım da yakalanır", async () => {
  // Bu vakayı red-team probe'u yakaladı, ilk düzeltmem kaçırıyordu: boyut da
  // inode da değişmediğinde (boyut, inode) ikilisi "hiç değişmemiş" diyor.
  // Ayırt eden tek ucuz işaret mtime.
  const root = tmpDir();
  const dir = join(root, "-tmp-yerinde");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "s.jsonl");
  const first = userLine("aaaa", "/tmp/yerinde");
  writeFileSync(f, first);

  const store = openStore(":memory:");
  const r1 = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(r1.turns, 1);

  const inodeBefore = statSync(f).ino;
  const sizeBefore = statSync(f).size;
  const replacement = userLine("bbbb", "/tmp/yerinde"); // aynı uzunluk
  assert.equal(Buffer.byteLength(replacement), sizeBefore, "test kurulumu: boyut eşit olmalı");

  // Aynı dosya tanıtıcısına yaz: inode korunur.
  const fd = openSync(f, "r+");
  writeSync(fd, Buffer.from(replacement), 0, Buffer.byteLength(replacement), 0);
  closeSync(fd);
  assert.equal(statSync(f).ino, inodeBefore, "test kurulumu: inode korunmalı");
  assert.equal(statSync(f).size, sizeBefore, "test kurulumu: boyut korunmalı");

  const r2 = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(r2.truncations, 1, "yerinde aynı-boyut yeniden yazım kaçtı");
  assert.equal(r2.turns, 1, "yeni içerik okunmadı — sessiz veri kaybı");
  store.close();
});

// class: unisolated-session-io-failure
test("kaybolan tek oturum taramayı öldürmez ve iz bırakır", async () => {
  const root = tmpDir();
  for (const [key, cwd] of [["-tmp-bozuk", "/tmp/bozuk"], ["-tmp-saglam", "/tmp/saglam"]] as const) {
    mkdirSync(join(root, key), { recursive: true });
    writeFileSync(join(root, key, "s.jsonl"), userLine("veri", cwd));
  }

  // Keşif ile okuma arasında dosyanın silinmesi (gerçek yarış) taklit ediliyor.
  const adapter: TranscriptAdapter = {
    id: claudeCodeAdapter.id,
    parseLine: claudeCodeAdapter.parseLine,
    async discover(r?: string): Promise<DiscoveredProject[]> {
      const found = await claudeCodeAdapter.discover(r);
      const victim = found.find((p) => p.path === "/tmp/bozuk")!;
      victim.sessions[0]!.filePath = join(root, "-tmp-bozuk", "yok-olmus.jsonl");
      return found;
    },
  };

  const store = openStore(":memory:");
  const sum = await scanOnce(store, { adapter, root });
  assert.equal(sum.sessionErrors, 1);
  assert.equal(sum.turns, 1, "sağlam projenin turn'ü işlenmeliydi");
  assert.equal(countEvents(store, "session_read_failed"), 1);
  assert.equal(countEvents(store, "scan_completed"), 1, "tarama tamamlandı kaydı düşmeli");
  store.close();
});

// class: raw-transcript-terminal-disclosure
test("CLI güvenilmeyen değerleri terminale ham basmaz", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  const root = tmpDir();
  const dir = join(root, "-tmp-kacis");
  mkdirSync(dir, { recursive: true });
  // Satır tipi ve cwd'ye ANSI kaçış dizisi + kontrol karakteri konuyor.
  writeFileSync(
    join(dir, "s.jsonl"),
    line({ type: "user", cwd: "/tmp/[31mkirmizi", message: { role: "user", content: "x" } }) +
      line({ type: "tip-[2Jsil" }),
  );

  const storePath = tmpStorePath();
  const env = { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" };
  const scanOut = execFileSync("node", [cli, "scan", "--dir", root, "--store", storePath], { encoding: "utf8", env });
  const statusOut = execFileSync("node", [cli, "status", "--store", storePath], { encoding: "utf8", env });

  for (const [name, out] of [["scan", scanOut], ["status", statusOut]] as const) {
    assert.ok(!out.includes(""), `${name} çıktısına ESC karakteri sızdı`);
    assert.ok(!out.includes(""), `${name} çıktısına BEL karakteri sızdı`);
  }
  assert.ok(scanOut.includes("\\x1b"), "kontrol karakteri gizlenmeyip görünür hâle getirilmeli");
});

// class: non-atomic-cursor-claim
test("iki tarama aynı anda koşamaz — kilit ikinciyi reddeder", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-kilit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), userLine("bir", "/tmp/kilit"));

  const store = openStore(":memory:");
  const seen: string[] = [];
  let inside: (() => void) | null = null;
  const firstEnteredCallback = new Promise<void>((r) => (inside = r));

  // Birinci tarama gözlemcinin içinde bekletiliyor; ikincisi bu sırada başlıyor.
  const release = Promise.withResolvers<void>();
  const first = scanOnce(store, {
    adapter: claudeCodeAdapter, root, lockHolder: "birinci",
    onTurns: async ({ turns }) => {
      seen.push(...turns.map((t) => t.text));
      inside!();
      await release.promise;
    },
  });

  await firstEnteredCallback;
  await assert.rejects(
    () => scanOnce(store, { adapter: claudeCodeAdapter, root, lockHolder: "ikinci", onTurns: ({ turns }) => void seen.push(...turns.map((t) => t.text)) }),
    /başka bir tarama sürüyor/,
  );
  release.resolve();
  await first;

  assert.deepEqual(seen, ["bir"], "aynı turn iki kez teslim edildi");
  // Kilit bırakıldıktan sonra yeni tarama serbest.
  await assert.doesNotReject(() => scanOnce(store, { adapter: claudeCodeAdapter, root }));
  store.close();
});

// class: observer-cursor-atomicity-gap
test("gözlemci çökerse turn kaybolmaz, sonraki taramada yeniden gelir", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-gozlemci");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), userLine("kiymetli", "/tmp/gozlemci"));

  const store = openStore(":memory:");
  const sum1 = await scanOnce(store, {
    adapter: claudeCodeAdapter, root,
    onTurns: () => { throw new Error("gözlemci patladı"); },
  });
  assert.equal(sum1.sessionErrors, 1);
  assert.equal(countEvents(store, "observer_failed"), 1, "gözlemci hatası okuma hatasından ayrı sınıflanmalı");
  assert.equal(countEvents(store, "session_read_failed"), 0);

  // İmleç ilerlemediği için turn yeniden teslim edilir: en-az-bir-kez.
  const seen: string[] = [];
  await scanOnce(store, { adapter: claudeCodeAdapter, root, onTurns: ({ turns }) => void seen.push(...turns.map((t) => t.text)) });
  assert.deepEqual(seen, ["kiymetli"], "gözlemci çökünce turn kalıcı olarak kayboldu");
  store.close();
});

// class: untrusted-project-identity-collision
test("kimlik sonradan çözülse bile turn ikinci kez teslim edilmez", async () => {
  // Denetim: proje kimliği transcript'ten okunan cwd'ye bağlı ve sonradan
  // değişebiliyor. İmleç (proje, oturum) ile anahtarlıyken kimlik değişince
  // yetim kalıyor ve tüm dosya yeniden okunuyordu. Artık imlecin anahtarı
  // fiziksel dosya yolu — kimlik üst-veri, bayt akışının kimliği değil.
  const root = tmpDir();
  const dir = join(root, "-cozulemeyen-yol-xyz");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "s.jsonl");
  writeFileSync(f, line({ type: "user", message: { role: "user", content: "cwd-siz" } }));

  const store = openStore(":memory:");
  const seen: string[] = [];
  const collect = ({ turns }: { turns: { text: string }[] }) => void seen.push(...turns.map((t) => t.text));

  await scanOnce(store, { adapter: claudeCodeAdapter, root, onTurns: collect });
  writeFileSync(f, line({ type: "user", message: { role: "user", content: "cwd-siz" } }) + userLine("cwd-li", "/gercek/proje"));
  await scanOnce(store, { adapter: claudeCodeAdapter, root, onTurns: collect });

  assert.deepEqual(seen, ["cwd-siz", "cwd-li"], "kimlik değişince geçmiş yeniden teslim edildi");
  store.close();
});
