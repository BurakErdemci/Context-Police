// M2'den devreden iki borç: (3) kısmi örtüşmede tam-parti tekrarının SIKLIĞI
// ölçülemiyordu — karar "fresh" ile aynı kovaya düşüyordu; (4) bütçe dolunca
// kalan her oturum bir observer_failed üretiyordu, yani maliyet sınırı denetim
// günlüğünde arıza gibi görünüyordu.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dropThroughWatermarkDetailed } from "../src/observer/batch.ts";
import { scanOnce } from "../src/scan.ts";
import { BudgetHalt } from "../src/observe-cmd.ts";
import { countEvents } from "../src/store/events.ts";
import { openStore } from "../src/store/db.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { tmpDir } from "./helpers.ts";

const turn = (uuid: string) =>
  ({ role: "user" as const, text: "x", uuid, timestamp: "2026-08-11T10:00:00Z" });

test("kısmi örtüşme ayrı eşleşme türü olarak raporlanır (borç 3 ölçümü)", () => {
  // Saklanan ofset aralığın İÇİNDE, kimlik tutmuyor → tamamı yeniden gönderilir
  // ama artık görünür bir 'overlap-resent' olarak.
  const wm = { byteOffset: 500, deliveryKey: "b:0:500:5", deliveryTurns: 5 };
  const d = dropThroughWatermarkDetailed([turn("a"), turn("b")], wm, { from: 200, to: 900, truncated: false });
  assert.equal(d.match, "overlap-resent");
  assert.equal(d.fresh.length, 2); // tekrar tercih ediliyor — davranış değişmedi, yalnız görünürlük eklendi
});

test("BudgetHalt taramayı erken durdurur: tek olay, sıfır observer_failed, imleç ilerlemez", async () => {
  const root = tmpDir("cp-halt-");
  const projDir = join(root, "-p1");
  mkdirSync(projDir);
  const line = (uuid: string) =>
    JSON.stringify({
      type: "user", uuid, timestamp: "2026-08-11T10:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "merhaba" }] }, cwd: "/p1",
    }) + "\n";
  writeFileSync(join(projDir, "s1.jsonl"), line("u1"));
  writeFileSync(join(projDir, "s2.jsonl"), line("u2"));

  const store = openStore(":memory:");
  const sum = await scanOnce(store, {
    adapter: claudeCodeAdapter,
    root,
    onTurns: () => { throw new BudgetHalt(); }, // bütçe ilk teslimatta dolu
  });

  assert.equal(sum.budgetHalted, true);
  assert.equal(countEvents(store, "observer_budget_halt"), 1);   // tek kayıt, oturum başına değil
  assert.equal(countEvents(store, "observer_failed"), 0);        // gürültü yok
  assert.equal(sum.sessionErrors, 0);                            // bütçe bir HATA değil
  const cursors = store.get<{ n: number }>("SELECT COUNT(*) n FROM cursors")?.n ?? 0;
  assert.equal(cursors, 0);                                      // hiçbir imleç ilerlemedi

  // Proje "tarandı" damgası da yenilenmemeli: oturumlarının hiçbiri okunmadı,
  // ve tetikleyici mantığı (spec §2.4) bu damgaya bakıyor — yarım taramayı tam
  // göstermek, kalan oturumları bir sonraki tetikte de atlatırdı.
  const scannedAt = store.get<{ v: string | null }>("SELECT last_scanned_at v FROM projects")?.v ?? null;
  assert.equal(scannedAt, null);
  store.close();
});
