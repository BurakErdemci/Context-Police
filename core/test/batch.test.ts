import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, dropThroughWatermark, cutBatches } from "../src/observer/batch.ts";
import type { Turn } from "../src/types.ts";

const t = (text: string, uuid?: string): Turn => ({ role: "user", text, uuid });

test("token tahmini bayt/4'tür ve asla sıfır olmaz", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(""), 0);
  // Çok baytlı karakterler bayt üzerinden sayılır (Türkçe metin gerçeği).
  assert.equal(estimateTokens("şşşş"), 2); // 8 bayt / 4
});

test("filigran süzmesi: uuid bulunursa sonrası kalır, bulunmazsa hepsi kalır", () => {
  const turns = [t("a", "u1"), t("b", "u2"), t("c", "u3")];
  assert.deepEqual(dropThroughWatermark(turns, "u2").map((x) => x.text), ["c"]);
  assert.deepEqual(dropThroughWatermark(turns, null).map((x) => x.text), ["a", "b", "c"]);
  // Normal akış: imleç filigranla hizalı, gelen turn'ler tamamen yeni → uuid yok → hepsi işlenir.
  assert.deepEqual(dropThroughWatermark(turns, "u99").map((x) => x.text), ["a", "b", "c"]);
  // Filigran son turn'se her şey işlenmiş demektir.
  assert.deepEqual(dropThroughWatermark(turns, "u3"), []);
});

test("partiler eşikte kesilir, son parti eşik altı kalabilir (D-M2-1)", () => {
  // Her turn ~100 token: 400 baytlık metin.
  const turns = Array.from({ length: 5 }, (_, i) => t("x".repeat(400), `u${i}`));
  const batches = cutBatches(turns, 250);
  // 100+100+100 ≥ 250 → ilk parti 3 turn; kalan 2 turn ikinci parti.
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.turns.length, 3);
  assert.equal(batches[0]!.lastUuid, "u2");
  assert.equal(batches[1]!.turns.length, 2);
  assert.equal(batches[1]!.lastUuid, "u4");
});

test("tek başına eşik üstü turn kendi partisi olur ve metni kısaltılır", () => {
  const huge = t("y".repeat(4000), "dev");
  const batches = cutBatches([t("a", "u0"), huge, t("b", "u1")], 250);
  assert.equal(batches.length, 3, "dev turn kendi partisine ayrılmalı");
  const devParti = batches[1]!;
  assert.equal(devParti.lastUuid, "dev");
  assert.ok(estimateTokens(devParti.turns[0]!.text) <= 250, "kısaltılmamış");
  assert.match(devParti.turns[0]!.text, /\[kısaltıldı: 4000 bayt\]/);
});

test("uuid'siz turn'lerde lastUuid partideki son uuid'li turn'dür", () => {
  const batches = cutBatches([t("a", "u1"), t("b"), t("c")], 9999);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.lastUuid, "u1");
});

test("boş girdi boş parti listesi verir", () => {
  assert.deepEqual(cutBatches([], 250), []);
});
