// `tools/altin-set/` bugüne kadar SIFIR otomatik teste sahipti ve M4.1
// denetiminin 6 bulgusunun 6'sı da o dizindeydi. Buradaki testlerin adları
// bulgu sınıflarını taşıyor: bir gerileme olursa hangi denetim bulgusunun geri
// geldiği doğrudan okunuyor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addUsage, totalTokens, firstBalancedBlock, parseClaimsCount, decideCompleteness,
  appendTail, STDERR_TAIL, cleanupCommand, validateRoot,
} from "../adjudicate-lib.ts";

// --- BULGU: geçerli boş iddia kümesi reddediliyor -------------------------

test("boş claims dizisi tam sayılır", () => {
  assert.equal(parseClaimsCount('{"claims":[]}'), 0);
  const d = decideCompleteness(['{"claims":[]}'], true);
  assert.deepEqual(d, { complete: true, claims: 0 });
});

test("tamlık kararı 'verdict' alt dizesine bakmaz", () => {
  // Şemaya uygun ama `verdict` anahtarı taşımayan çıktı: eski metin sezgisi
  // bunu `parse_failed` sayıyordu.
  assert.equal(JSON.stringify('{"claims":[]}').includes("verdict"), false);
  assert.equal(decideCompleteness(['{"claims":[]}'], true).complete, true);
});

test("dolu claims dizisi sayılır ve tam sayılır", () => {
  const txt = '{"claims":[{"verdict":"gecerli"},{"verdict":"curuk"}]}';
  assert.deepEqual(decideCompleteness([txt], true), { complete: true, claims: 2 });
});

test("kod çitiyle sarılmış çıktı kurtarılır", () => {
  assert.equal(parseClaimsCount('```json\n{"claims":[{"a":1}]}\n```'), 1);
});

test("iki item'a bölünmüş küme birleşimden kurtarılır", () => {
  const a = '{"claims":[{"verdict":"gecerli"},';
  const b = '{"verdict":"curuk"}]}';
  assert.deepEqual(decideCompleteness([a, b], true), { complete: true, claims: 2 });
});

test("yarım kesilmiş çıktı tam sayılmaz", () => {
  assert.equal(parseClaimsCount('{"claims":[{"verdict":"gec'), null);
  assert.equal(decideCompleteness(['{"claims":[{"verdict":"gec'], true).complete, false);
});

test("akış mesaj-dışı bir item'la biterse tam sayılmaz (guard)", () => {
  // Kanıt yalnız SON item mesajken kabul edilir; hata yönü bilinçli olarak
  // gürültülü `olculemez` tarafında.
  assert.equal(decideCompleteness(['{"claims":[]}'], false).complete, false);
});

test("aday yoksa tam sayılmaz", () => {
  assert.deepEqual(decideCompleteness([], true), { complete: false, claims: 0 });
});

test("claims dizi değilse tam sayılmaz", () => {
  assert.equal(parseClaimsCount('{"claims":{"a":1}}'), null);
  assert.equal(parseClaimsCount('{"sonuc":[]}'), null);
});

// --- dengeli blok kurtarması ---------------------------------------------

test("geçerli JSON'un arkasındaki düz metin kurtarmayı bozmaz", () => {
  const s = '{"claims":[]} sonrasında {bkz. şema} diye bir not var';
  assert.equal(firstBalancedBlock(s), '{"claims":[]}');
  assert.equal(parseClaimsCount(s), 0);
});

test("dize içindeki süslü parantez sayılmaz", () => {
  assert.equal(firstBalancedBlock('{"t":"a{b}c"} kuyruk'), '{"t":"a{b}c"}');
});

test("süslü parantez yoksa null döner", () => {
  assert.equal(firstBalancedBlock("düz metin"), null);
});

// --- usage toplama --------------------------------------------------------

test("usage turlar boyunca TOPLANIR, üzerine yazılmaz", () => {
  let u = addUsage(null, { input_tokens: 10, output_tokens: 3 });
  u = addUsage(u, { input_tokens: 5, reasoning_output_tokens: 7 });
  assert.equal(u.input_tokens, 15);
  assert.equal(u.output_tokens, 3);
  assert.equal(u.reasoning_output_tokens, 7);
  assert.equal(totalTokens(u), 25);
});

test("sayı olmayan usage alanları yok sayılır", () => {
  const u = addUsage(null, { input_tokens: "12", cached_input_tokens: 4 });
  assert.equal(u.input_tokens, undefined);
  assert.equal(totalTokens(u), 4);
});

// --- BULGU: alt süreç stderr'i tamamen atılıyor ---------------------------

test("stderr kuyruğu sınıra kadar birikir", () => {
  assert.equal(appendTail("", "hata sebebi"), "hata sebebi");
  assert.equal(appendTail("a", "b"), "ab");
});

test("stderr kuyruğu sınırı aşınca SONU korur", () => {
  const long = "x".repeat(STDERR_TAIL + 50) + "SON";
  const tail = appendTail("", long);
  assert.equal(tail.length, STDERR_TAIL);
  assert.ok(tail.endsWith("SON"));
});

// --- BULGU: kill tutmazsa süreç sahipsiz kalıyor --------------------------

test("temizlik komutu pid taşır ve kopyalanabilir", () => {
  const cmd = cleanupCommand(4242);
  assert.ok(cmd.includes("4242"));
  assert.ok(cmd.includes("-4242")); // önce grup, sonra düz pid
});

// --- BULGU: kök argümanı doğrulanmıyor ------------------------------------

test("kök doğrulaması var olmayan yolu reddeder", () => {
  const r = validateRoot(join(tmpdir(), "boyle-bir-yol-yok-4711"));
  assert.equal(r.ok, false);
});

test("kök doğrulaması boş argümanı reddeder", () => {
  assert.equal(validateRoot(undefined).ok, false);
  assert.equal(validateRoot("").ok, false);
});

test("kök doğrulaması .git taşımayan dizini reddeder", () => {
  const dir = mkdtempSync(join(tmpdir(), "adj-test-"));
  try {
    const r = validateRoot(dir);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason.includes(".git"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kök doğrulaması dosyayı reddeder", () => {
  const dir = mkdtempSync(join(tmpdir(), "adj-test-"));
  try {
    const f = join(dir, "dosya.txt");
    writeFileSync(f, "x");
    const r = validateRoot(f);
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kök doğrulaması .git dizini olan depoyu kabul eder", () => {
  const dir = mkdtempSync(join(tmpdir(), "adj-test-"));
  try {
    mkdirSync(join(dir, ".git"));
    const r = validateRoot(dir);
    assert.equal(r.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kök doğrulaması bağlı worktree'yi (.git DOSYASI) kabul eder", () => {
  const dir = mkdtempSync(join(tmpdir(), "adj-test-"));
  try {
    writeFileSync(join(dir, ".git"), "gitdir: /baska/yer/.git/worktrees/x\n");
    const r = validateRoot(dir);
    assert.equal(r.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
