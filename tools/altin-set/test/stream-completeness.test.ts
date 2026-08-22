// Regression tests promoted from the 22 Aug 2026 codex-audit probes.
// Every case below reproduced against the pre-fix parser; the archived proofs
// are under `.delegate-runs/ARCHIVE/2026-08-22-*/probes/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaimsFromRaw, extractGatedClaims, gateClaims, streamMessageCandidates,
} from "../adjudicate-lib.ts";

const ev = (o: unknown) => JSON.stringify(o);
const msg = (text: string, id = "m") =>
  ev({ type: "item.completed", item: { id, type: "agent_message", text } });
const CLAIM = { text: "x", line_start: 1, line_end: 1, verdict: "olculemez", evidence: "e" };
const payload = (n = 1) => JSON.stringify({ claims: Array.from({ length: n }, () => CLAIM) });

test("son mesajdan sonra item.started varsa akış kesiktir", () => {
  const raw = [msg(payload()), ev({ type: "item.started", item: { id: "c", type: "command_execution" } })].join("\n");
  assert.equal(parseClaimsFromRaw(raw), null);
});

test("son mesajdan sonra yarım JSON satırı varsa akış kesiktir", () => {
  assert.equal(parseClaimsFromRaw([msg(payload()), '{"type":"item.star'].join("\n")), null);
});

test("komut çıktısı modelin hükmü sayılmaz", () => {
  // 29 gerçek ham dosyada 688 command_execution item'ı var; bugün yalnız
  // metinleri string OLMADIĞI için eleniyorlardı.
  const raw = ev({ type: "item.completed", item: { id: "c", type: "command_execution", content: payload() } });
  assert.equal(parseClaimsFromRaw(raw), null);
});

test("son mesaj ayrıştırılamıyorsa önceki mesajdan kurtarma YAPILMAZ", () => {
  const raw = [msg(payload(), "a"), msg('{"claims":[', "b")].join("\n");
  assert.equal(parseClaimsFromRaw(raw), null);
});

test("bölünmüş küme sıralı birleşimden hâlâ onarılır", () => {
  const whole = payload(2);
  const cut = Math.floor(whole.length / 2);
  const raw = [msg(whole.slice(0, cut), "a"), msg(whole.slice(cut), "b")].join("\n");
  assert.equal(parseClaimsFromRaw(raw)?.length, 2);
});

test("tanınmayan tek satır tüm dosyayı düşürmez", () => {
  // Koşucu bu satırı bilinmeyen olay sayıp devam ediyor; ayrıştırıcı da öyle.
  for (const noise of ['{"no_type":1}', "null", "42", '"metin"', "true", "[1,2]"]) {
    const raw = [noise, ev({ type: "thread.started", thread_id: "t" }), msg(payload())].join("\n");
    assert.equal(parseClaimsFromRaw(raw)?.length, 1, `gürültü: ${noise}`);
  }
});

test("type anahtarı taşıyan düz JSON olay akışı sanılmaz", () => {
  const plain = JSON.stringify({ type: "report", claims: [CLAIM] });
  assert.equal(parseClaimsFromRaw(plain)?.length, 1);
  assert.deepEqual(parseClaimsFromRaw(JSON.stringify({ type: "report", claims: [] })), []);
});

test("turn.completed kuyruğu tamlığı bozmaz", () => {
  const raw = [msg(payload()), ev({ type: "turn.completed", usage: {} })].join("\n");
  assert.equal(parseClaimsFromRaw(raw)?.length, 1);
});

test("streamMessageCandidates kuyruk iznini ayrı raporlar", () => {
  const ok = streamMessageCandidates([msg(payload()), ev({ type: "turn.completed" })].join("\n"));
  assert.deepEqual([ok?.lastItemIsMessage, ok?.trailerIntact], [true, true]);
  const cut = streamMessageCandidates([msg(payload()), ev({ type: "item.started", item: {} })].join("\n"));
  assert.deepEqual([cut?.lastItemIsMessage, cut?.trailerIntact], [true, false]);
});

test("sınır beslenmişken şemanın tanımadığı alan kapıdan geçmez", () => {
  const claims = [{ ...CLAIM, unmeasurable_reason: "user_resolvable" }];
  const gated = gateClaims(claims, true) as Record<string, unknown>[];
  assert.equal("unmeasurable_reason" in gated[0]!, false);
  assert.equal(gated[0]!.verdict, "olculemez"); // hükmün kendisi korunur
});

test("sınır beslenmemişken alan olduğu gibi kalır", () => {
  const claims = [{ ...CLAIM, unmeasurable_reason: "not_measurable" }];
  const gated = gateClaims(claims, false) as Record<string, unknown>[];
  assert.equal(gated[0]!.unmeasurable_reason, "not_measurable");
});

test("uçtan uca: kesik akış kapıdan da null döner", () => {
  const raw = [msg(payload()), '{"type":"item.star'].join("\n");
  assert.equal(extractGatedClaims(raw, false), null);
});

// --- 22 Ağu 2026 doğrulama turundan (düzeltmenin kendisini denetleyen lane) ---

test("son mesajdan sonraki düz metin satırı akışı geçersiz kılmaz", () => {
  // Koşucu `{` ile başlamayan satırı BİLEREK atlıyor: gerçek akışta
  // ilerleme/uyarı satırları düz metin geliyor. Ara sürüm bunları kesilme
  // sayıyordu, yani sağlam koşumları düşürecekti.
  const raw = [msg(payload()), "warning: something diagnostic"].join("\n");
  assert.equal(parseClaimsFromRaw(raw)?.length, 1);
});

test("olay adıyla çakışan type taşıyan düz claims belgesi akış sanılmaz", () => {
  for (const t of ["item.completed", "turn.completed"]) {
    const plain = JSON.stringify({ type: t, claims: [CLAIM] });
    assert.equal(parseClaimsFromRaw(plain)?.length, 1, `type: ${t}`);
  }
});

test("{ ile başlayıp ayrıştırılamayan kuyruk hâlâ kesilme izidir", () => {
  // Düz metin muafiyeti yarım yazılmış OLAYI kapsamamalı.
  assert.equal(parseClaimsFromRaw([msg(payload()), '{"type":"item.star'].join("\n")), null);
});
