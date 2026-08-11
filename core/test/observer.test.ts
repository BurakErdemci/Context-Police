import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store/db.ts";
import { Observer } from "../src/observer/observer.ts";
import { upsertProject } from "../src/store/projects.ts";
import { appendFinding, listActive, getFinding, getAnchors } from "../src/store/findings.ts";
import { getWatermark } from "../src/store/watermarks.ts";
import { countEvents, listEvents } from "../src/store/events.ts";
import { fakeExecutor } from "./helpers.ts";
import type { ExecutorAdapter } from "../src/adapters/executor.ts";
import type { Turn } from "../src/types.ts";

const t = (text: string, uuid: string): Turn => ({ role: "user", text, uuid });

function setup() {
  const store = openStore(":memory:");
  const pid = upsertProject(store, { path: "/proj", adapterId: "claude-code", transcriptDir: "/t" });
  return { store, pid };
}

test("başarılı parti: bulgular çapalarıyla yazılır, filigran ilerler, olay düşer", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([{
    output: JSON.stringify({ findings: [
      { content: "Karar: X kullanılmayacak çünkü Y ölçüldü.", anchors: [{ kind: "file_path", value: "src/a.ts" }] },
      { content: "Tercih: teraslı çıktı isteniyor.", anchors: [] },
    ]}),
  }]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("konuşma", "u1")] });

  const active = listActive(store, pid);
  assert.equal(active.length, 2);
  const anchored = active.find((f) => f.content.startsWith("Karar"))!;
  assert.equal(anchored.status, "active");
  assert.equal(anchored.source, "observed");
  assert.equal(anchored.sourceRef, "s1#u1");
  assert.deepEqual(getAnchors(store, anchored.id), [{ kind: "file_path", value: "src/a.ts", takenAtCommit: null }]);
  // Çapasız bulgu unanchored sınıfına düşer (M1 kuralı, otomatik).
  assert.equal(active.find((f) => f.content.startsWith("Tercih"))!.status, "unanchored");
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "u1");
  assert.equal(countEvents(store, "observer_batch_ok"), 1);
  assert.equal(obs.stats.findings, 2);
  store.close();
});

test("gözlemci mevcut bulgu başlıklarını görür ve supersedes uygulanır", async () => {
  const { store, pid } = setup();
  const oldId = appendFinding(store, {
    projectId: pid, source: "observed", content: "Eski karar: Z geçerli.",
    anchors: [{ kind: "symbol", value: "z" }],
  });
  const exec = fakeExecutor([{
    output: JSON.stringify({ findings: [
      { content: "Z kararı geri alındı, ölçüm tersini gösterdi.", anchors: [{ kind: "symbol", value: "z" }], supersedes: oldId },
    ]}),
  }]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("Z'yi geri aldık", "u1")] });

  assert.match(exec.calls[0]!.prompt, new RegExp(`#${oldId}: Eski karar`));
  const old = getFinding(store, oldId)!;
  assert.equal(old.status, "superseded");
  assert.ok(old.supersededBy != null);
  assert.equal(getFinding(store, old.supersededBy!)!.content, "Z kararı geri alındı, ölçüm tersini gösterdi.");
  assert.equal(obs.stats.superseded, 1);
  store.close();
});

test("başka projenin bulgusu supersede EDİLEMEZ; içerik yine de yazılır", async () => {
  const { store, pid } = setup();
  const otherPid = upsertProject(store, { path: "/baska", adapterId: "claude-code", transcriptDir: "/t2" });
  // Çapa şart: çapasız bulgu "unanchored" doğar (M0-D5) ve o durumda
  // "supersede edilmedi" iddiası çapa kuralına takılıp anlamını yitirirdi.
  const foreignId = appendFinding(store, {
    projectId: otherPid, source: "observed", content: "başkasının bulgusu",
    anchors: [{ kind: "file_path", value: "baska/b.ts" }],
  });
  const exec = fakeExecutor([{
    output: JSON.stringify({ findings: [{ content: "sahtekar", anchors: [], supersedes: foreignId }] }),
  }]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("x", "u1")] });

  assert.equal(getFinding(store, foreignId)!.status, "active", "yabancı bulgu supersede edildi!");
  assert.equal(listActive(store, pid).length, 1, "içerik yazılmalıydı");
  store.close();
});

test("tekrar teslim (en-az-bir-kez) filigranla elenir, ikinci codex çağrısı olmaz", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([
    { output: JSON.stringify({ findings: [{ content: "bir", anchors: [] }] }) },
  ]);
  const obs = new Observer({ store, executor: exec });
  const turns = [t("a", "u1"), t("b", "u2")];
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns });
  // İmleç yazılamadan çöküldü senaryosu: aynı turn'ler yeniden gelir.
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns });

  assert.equal(exec.calls.length, 1, "tekrar teslim yeniden Codex'e gitti");
  assert.equal(listActive(store, pid).length, 1);
  assert.equal(obs.stats.skippedTurns, 2);
  store.close();
});

test("geçersiz JSON bir kez düzeltilerek yeniden istenir; düzelirse işlenir", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([
    { output: "bozuk çıktı %%" },
    { output: JSON.stringify({ findings: [{ content: "düzeldi", anchors: [] }] }) },
  ]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("x", "u1")] });

  assert.equal(exec.calls.length, 2);
  assert.match(exec.calls[1]!.prompt, /GEÇERSİZDİ/);
  assert.equal(listActive(store, pid).length, 1);
  store.close();
});

test("iki kez geçersiz JSON → parti işlenemedi, filigran yine de ilerler (D-M2-3)", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([{ output: "bozuk 1" }, { output: "bozuk 2" }]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("x", "u1")] });

  assert.equal(listActive(store, pid).length, 0);
  assert.equal(countEvents(store, "observer_batch_unprocessed"), 1);
  const ev = JSON.parse(listEvents(store, { kind: "observer_batch_unprocessed" })[0]!.detail!);
  assert.equal(ev.sessionId, "s1");
  assert.equal(ev.lastUuid, "u1");
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "u1", "zehirli parti sonsuz döngüye girer");
  assert.equal(obs.stats.unprocessed, 1);
  store.close();
});

test("yürütücü hatası bir kez tekrarlanır; ikisi de düşerse parti işlenemedi", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([
    { ok: false, error: "ağ koptu" },
    { ok: false, error: "ağ yine koptu" },
  ]);
  const obs = new Observer({ store, executor: exec });
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns: [t("x", "u1")] });

  assert.equal(exec.calls.length, 2);
  assert.equal(countEvents(store, "observer_batch_unprocessed"), 1);
  store.close();
});

// D-M2-2'nin asıl iddiası tek partide görünmüyor: orada kısmi hâl yok. Çok
// partili akışta parti ortasında çökülünce commit'lenmiş partinin mükerrer
// üretilmemesi gerekir — tx sınırının ölçüldüğü yer burası.
test("parti ortasında çökme: işlenmiş parti tekrarlanmaz, kalanı yeniden işlenir", async () => {
  const { store, pid } = setup();
  let n = 0;
  const flaky: ExecutorAdapter = {
    id: "flaky",
    async detect() {
      return { found: true };
    },
    async run() {
      n++;
      // 2. parti sırasında süreç çöker (yürütücü hatası DEĞİL: atılan istisna).
      if (n === 2) throw new Error("süreç çöktü");
      return { ok: true, output: JSON.stringify({ findings: [{ content: `b${n}`, anchors: [] }] }), durationMs: 1 };
    },
  };
  const turns = Array.from({ length: 4 }, (_, i) => t("y".repeat(100), `u${i + 1}`));
  const obs = new Observer({ store, executor: flaky, batchTokens: 50 });
  await assert.rejects(() => obs.handleTurns({ projectId: pid, sessionId: "s1", turns }));
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "u2", "1. parti commit'lenmemiş");
  assert.equal(listActive(store, pid).length, 1);

  // scan.ts onTurns hatasında imleci İLERLETMEZ → aynı turn'ler yeniden gelir.
  const exec = fakeExecutor([{ output: JSON.stringify({ findings: [{ content: "kalan", anchors: [] }] }) }]);
  const obs2 = new Observer({ store, executor: exec, batchTokens: 50 });
  await obs2.handleTurns({ projectId: pid, sessionId: "s1", turns });

  assert.deepEqual(listActive(store, pid).map((f) => f.content).sort(), ["b1", "kalan"], "1. parti mükerrer üretildi");
  assert.equal(obs2.stats.skippedTurns, 2);
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "u4");
  store.close();
});

test("uzun akış birden çok partiye bölünür, her parti kendi çağrısını yapar", async () => {
  const { store, pid } = setup();
  const exec = fakeExecutor([]); // hepsi varsayılan boş cevap
  const obs = new Observer({ store, executor: exec, batchTokens: 50 });
  // Her turn ~25 token (100 bayt): 6 turn → 150 token → 3 parti.
  const turns = Array.from({ length: 6 }, (_, i) => t("y".repeat(100), `u${i}`));
  await obs.handleTurns({ projectId: pid, sessionId: "s1", turns });

  assert.equal(exec.calls.length, 3);
  assert.equal(obs.stats.batches, 3);
  assert.equal(getWatermark(store, pid, "s1")!.lastUuid, "u5");
  store.close();
});
