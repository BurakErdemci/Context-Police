import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, dropThroughWatermark, deliveryKey, cutBatches } from "../src/observer/batch.ts";
import type { Turn } from "../src/types.ts";

const t = (text: string, uuid?: string): Turn => ({ role: "user", text, uuid });

test("token tahmini bayt/4'tür ve asla sıfır olmaz", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(""), 0);
  // Çok baytlı karakterler bayt üzerinden sayılır (Türkçe metin gerçeği).
  assert.equal(estimateTokens("şşşş"), 2); // 8 bayt / 4
});

// SÖZLEŞME DEĞİŞTİ (kök tasarım A): eleme uuid'e değil TESLİMATIN KONUMUNA
// bakıyor. Eski hâl "filigran uuid'i dizide nerede" diye arıyordu ve o arama üç
// ayrı kayıp sınıfı üretti (batch.ts'te ölçümleriyle yazılı).
test("filigran süzmesi konumsaldır: aralık kapsanıyorsa hiçbiri, aksi hâlde hepsi kalır", () => {
  const turns = [t("a", "u1"), t("b", "u2"), t("c", "u3")];
  const range = { from: 100, to: 300, truncated: false };
  const wm = (byteOffset: number | null, key: string | null = null, deliveryTurns: number | null = null) =>
    ({ byteOffset, deliveryKey: key, deliveryTurns });

  // Filigran yok: eleyecek bilgi yok.
  assert.deepEqual(dropThroughWatermark(turns, null, range).map((x) => x.text), ["a", "b", "c"]);
  // Ofset teslimatın sonunu kapsıyor: tamamı işlenmiş.
  assert.deepEqual(dropThroughWatermark(turns, wm(300), range), []);
  assert.deepEqual(dropThroughWatermark(turns, wm(999), range), []);
  // Ofset aralığın İÇİNDE: hangi turn'ün hangi baytta başladığı bilinmiyor →
  // tahmin yerine tekrar (mükerrer geri alınabilir, kayıp alınamaz).
  assert.deepEqual(dropThroughWatermark(turns, wm(200), range).map((x) => x.text), ["a", "b", "c"]);
  // Aynı teslimat yarım kalmışsa işlenmiş ön ek atlanır.
  const key = deliveryKey(turns, range);
  assert.deepEqual(dropThroughWatermark(turns, wm(100, key, 2), range).map((x) => x.text), ["c"]);
  // Kısalma: saklanan ofset başka bir dosyanın ofseti, eleme YOK.
  assert.deepEqual(
    dropThroughWatermark(turns, wm(999), { from: 0, to: 300, truncated: true }).map((x) => x.text),
    ["a", "b", "c"],
  );
});

test("teslimat kimliği: aralıksız çağrıda içerik özeti kullanılır, uuid'e bakılmaz", () => {
  const turns = [t("a", "u1"), t("b", "u2")];
  // Aynı liste = aynı kimlik; mükerrer uuid ya da eşit damga onu bozamaz.
  assert.equal(deliveryKey(turns, null), deliveryKey([t("a", "u1"), t("b", "u2")], null));
  // Metin değişince kimlik değişir: farklı teslimat, eleme yok.
  assert.notEqual(deliveryKey(turns, null), deliveryKey([t("a", "u1"), t("bb", "u2")], null));
  // Turn sayısı kimliğe giriyor: aynı aralıktan farklı sayıda turn çıkması ön
  // eki atlamayı güvensiz kılar.
  const r = { from: 0, to: 10, truncated: false };
  assert.notEqual(deliveryKey(turns, r), deliveryKey([t("a", "u1")], r));
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
