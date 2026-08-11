import { test } from "node:test";
import assert from "node:assert/strict";
import { hasStatusPattern, matchedStatusPatterns } from "../src/signals/status-pattern.ts";

test("M0-D1 kalıpları yakalanır", () => {
  for (const t of [
    "DURUM: 11 Ağu · iş sürüyor",
    "değişiklikler henüz pushlanmadı",
    "şu an refactor ortasındayız",
    "sıradaki iş: adapter",
    "commit edilmedi, bekliyor",
  ]) assert.equal(hasStatusPattern(t), true, t);
});

test("kalıcı ders/karar metni tetiklemez", () => {
  for (const t of [
    "Karar: adapter seam'i gün birden tanımlı. Gerekçe: sonradan seam açmak pahalı.",
    "Ölçüm: 3 denendi, 1'i döndü.",
    "durum makinesi deseni kullanıldı", // 'durum' kelimesi tek başına yetmez
  ]) assert.equal(hasStatusPattern(t), false, t);
});

test("hangi kalıbın tetiklediği raporlanabilir (olay detayı için)", () => {
  const m = matchedStatusPatterns("DURUM: sürüyor, henüz bitmedi");
  assert.equal(m.length, 2);
});
