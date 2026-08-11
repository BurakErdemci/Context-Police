// M2 denetimi — CLI maliyet kapıları (C grubu). Her test bir bulgu class'ının
// iddiasını sabitler: iddia geri alınırsa test kırılır.
//
// Kararlar observe-cmd.ts'te SAF tutuluyor (cli.ts süreç-çıkışlı ve test
// edilemez); buradaki testler o saf yüzeye bakar.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CALL_BUDGET, WORST_CASE_CALLS_PER_BATCH, MAX_BATCH_TOKENS,
  callBudget, estimateCalls, costGate, budgetExhaustedMessage,
  budgetGuardedOnTurns, BudgetHalt,
  validateBatchTokens, validateEffort, validateModel,
} from "../src/observe-cmd.ts";

// ── class: missing-global-call-budget ───────────────────────────────────────
// Scan modu yalnız "depoda imleç var mı" diye bakıyordu; toplam çağrı sayısını
// hiç hesaplamıyordu. Ölçüldü: ilgisiz tek bir eski imleç varken 21 partilik
// yeni veri --yes olmadan 21 Codex çağrısı yapıp rc=0 döndü.

test("bütçe: --yes yoksa sert tavan var, --yes ile sınırsız", () => {
  assert.equal(callBudget(false), DEFAULT_CALL_BUDGET);
  assert.equal(callBudget(true), undefined, "--yes tavanı kaldırmalı");
  assert.ok(DEFAULT_CALL_BUDGET > 0, "onaysız tavan sıfırdan büyük ve sonlu olmalı");
});

test("bütçe mesajı yarım işi AÇIKÇA söylüyor: çağrı sayısı, yarıda kalma, --yes", () => {
  const msg = budgetExhaustedMessage(20, 20);
  assert.match(msg, /20/, "kaç çağrı yapıldığı yazmalı");
  assert.match(msg, /YARIDA/i, "işin bitmediği yazmalı");
  assert.match(msg, /--yes/, "nasıl sürdürüleceği yazmalı");
  assert.match(msg, /kaybolmadı/, "verinin kaybolmadığı yazmalı — panik gereksiz");
  // maxCalls verilmezse varsayılan sınır gösterilir; boş kalmaz.
  assert.match(budgetExhaustedMessage(5, undefined), new RegExp(String(DEFAULT_CALL_BUDGET)));
});

// Bu kanca olmasa bütçe scan modunda VERİ KAYBETTİRİRDİ: scan.ts imleci onTurns
// normal döndükten SONRA yazıyor, Observer ise bütçe bitince istisna atmadan
// dönüyor — imleç hiç gözlemlenmemiş turn'lerin ötesine geçerdi.
test("bütçe bitince onTurns istisna atar: imleç ilerlemesin (kalıcı gözlem boşluğu)", async () => {
  let exhausted = false;
  const görülen: number[] = [];
  const hook = budgetGuardedOnTurns<number>(
    () => exhausted,
    (n) => {
      görülen.push(n);
      // Observer bütçeyi teslimin ORTASINDA bitirir: bazı partiler işlendi,
      // kalanlar işlenmedi. Kanca bu hâli de yakalamak zorunda.
      if (n === 2) exhausted = true;
    },
  );

  await hook(1); // bütçe var: sorunsuz
  assert.deepEqual(görülen, [1]);

  // Bütçe TAM BU teslimde bitti: iç kanca koştu ama yine de durdurulmalı.
  await assert.rejects(() => hook(2), BudgetHalt);
  assert.deepEqual(görülen, [1, 2], "iç kanca çalışmış olmalı — kısmi iş yazılıydı");

  // Sonraki teslimlerde iç kancaya HİÇ girilmemeli.
  await assert.rejects(() => hook(3), BudgetHalt);
  assert.deepEqual(görülen, [1, 2], "bütçe bitmişken yeni teslim işlenmemeli");
});

// ── class: retry-blind-call-budget ──────────────────────────────────────────
// Eski tahmin yalnız PARTİ sayıyordu. Ölçüldü: "20 çağrı" diye onaysız kabul
// edilen iş, sağlayıcı her isteği reddettiğinde 40 gerçek çağrı yaptı.

test("en kötü durum çarpanı observer.ts callWithRecovery ile aynı", () => {
  // 3 = ilk çağrı + yürütücü hatası tekrarı + bozuk JSON düzeltme turu.
  assert.equal(WORST_CASE_CALLS_PER_BATCH, 3);
});

test("tahmin hem beklenen hem en kötü durumu veriyor", () => {
  const est = estimateCalls(32_000 * 7, 8000); // 7 parti
  assert.equal(est.batches, 7);
  assert.equal(est.expected, 7, "her parti ilk denemede tutarsa");
  assert.equal(est.worst, 21, "her parti kurtarma turlarını sonuna kadar kullanırsa");
});

test("maliyet kapısı EN KÖTÜ duruma göre karar veriyor, beklenene göre değil", () => {
  // 7 parti: beklenen 7 (eşiğin altında) ama en kötü 21 (eşiğin üstünde).
  // Eski davranış bunu onaysız geçiriyordu — bulgunun ta kendisi.
  const yediParti = estimateCalls(32_000 * 7, 8000);
  const kapı = costGate(yediParti, false);
  assert.equal(kapı.ok, false, "beklenen 7 olsa da en kötü 21 çağrı onaysız geçmemeli");
  assert.match(kapı.reason!, /--yes/);
  assert.match(kapı.reason!, /21/, "en kötü sayı ekranda görünmeli");

  // 6 parti → en kötü 18 ≤ 20: onaysız geçer.
  assert.equal(costGate(estimateCalls(32_000 * 6, 8000), false).ok, true);
  // --yes her hâlükârda geçer.
  assert.equal(costGate(estimateCalls(32_000 * 500, 8000), true).ok, true);
  // Hiç iş yoksa kapı takılmaz.
  assert.equal(costGate(estimateCalls(0, 8000), false).ok, true);
});

// ── class: unvalidated-executor-option-data-loss ────────────────────────────
// Geçersiz --effort her Codex çağrısını bozuyor; zehirli parti yolu 2 denemeden
// sonra partiyi "işlenemedi" yazıp FİLİGRANI İLERLETİYOR → o turn'ler bir daha
// hiç gözlemlenmiyor. Yazım hatasının bedeli kalıcı gözlem boşluğu olamaz.

test("--effort bilinen kümeye karşı doğrulanıyor (cast değil)", () => {
  assert.equal(validateEffort(undefined), "low", "varsayılan");
  for (const v of ["minimal", "low", "medium", "high"]) assert.equal(validateEffort(v), v);
  assert.throws(() => validateEffort("hgih"), /geçersiz --effort/, "yazım hatası");
  assert.throws(() => validateEffort("HIGH"), /geçersiz --effort/, "büyük harf codex'e geçmez");
  assert.throws(() => validateEffort(""), /geçersiz --effort/);
  // `--effort --yes` yazıldığında arg() "--yes" döndürüyor: bayrak yutulması.
  assert.throws(() => validateEffort("--yes"), /geçersiz --effort/);
});

test("--model boş ya da tire ile başlayan değeri reddediyor", () => {
  assert.equal(validateModel(undefined), undefined);
  assert.equal(validateModel("gpt-5-codex"), "gpt-5-codex", "içinde tire olması sorun değil");
  assert.throws(() => validateModel(""), /geçersiz --model/);
  assert.throws(() => validateModel("   "), /geçersiz --model/);
  assert.throws(() => validateModel("--yes"), /geçersiz --model/, "argv'de bayrak yutulması");
  assert.throws(() => validateModel("-s"), /geçersiz --model/);
});

// ── class: numeric-budget-overflow ──────────────────────────────────────────
// 1e308 eski doğrulamadan geçiyordu; batchTokens*4 Infinity'ye taşıyor ve
// Math.ceil(bayt/Infinity) = 0 — maliyet ekranı da onay kapısı da SIFIR çağrı
// gösteriyordu.

test("--batch-tokens üst sınır: taşan değer tahmini sıfırlayamaz", () => {
  assert.throws(() => validateBatchTokens("1e308"), /geçersiz --batch-tokens/);
  assert.throws(() => validateBatchTokens(String(Number.MAX_VALUE)), /geçersiz --batch-tokens/);
  assert.throws(() => validateBatchTokens("9007199254740993"), /geçersiz --batch-tokens/, "güvenli olmayan tam sayı");
  assert.throws(() => validateBatchTokens(String(MAX_BATCH_TOKENS + 1)), /geçersiz --batch-tokens/);
  assert.equal(validateBatchTokens(String(MAX_BATCH_TOKENS)), MAX_BATCH_TOKENS, "sınırın kendisi geçerli");

  // Arızanın kendisi: sınır olmasa tahmin 0 çıkıyordu.
  assert.equal(estimateCalls(10_000_000, 1e308).expected, 0, "taşma gerçekten tahmini sıfırlıyor");
  // Sınır içindeki en büyük değerde çarpım hâlâ güvenli aralıkta.
  assert.ok(Number.isSafeInteger(MAX_BATCH_TOKENS * 4));
  assert.equal(estimateCalls(MAX_BATCH_TOKENS * 4 + 1, MAX_BATCH_TOKENS).expected, 2);
});
