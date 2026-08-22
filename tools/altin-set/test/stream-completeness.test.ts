// Regression tests promoted from the 22 Aug 2026 codex-audit probes (hunt round
// plus two verification rounds). Archived proofs:
// `.delegate-runs/ARCHIVE/2026-08-22-*/probes/`.
//
// The completeness model these assert: a stream is complete when its last
// completed item is an `agent_message` AND a `turn.completed` follows it.
// Measured 22 Aug 2026 — all 29 recorded raw files end that way, a truncated
// prefix does not. Three earlier versions inferred truncation from indirect
// tail evidence instead; each one failed a verification round, twice in the
// direction that REJECTS healthy runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaimsFromRaw, extractGatedClaims, gateClaims, streamMessageCandidates,
  balancedBlocks,
} from "../adjudicate-lib.ts";

const ev = (o: unknown) => JSON.stringify(o);
const msg = (text: string, id = "m") =>
  ev({ type: "item.completed", item: { id, type: "agent_message", text } });
const END = ev({ type: "turn.completed", usage: {} });
const CLAIM = { text: "x", line_start: 1, line_end: 1, verdict: "olculemez", evidence: "e" };
const payload = (n = 1) => JSON.stringify({ claims: Array.from({ length: n }, () => CLAIM) });
const stream = (...lines: string[]) => [...lines, END].join("\n");

// --- tamlık kapısı: doğrudan sinyal ---

test("turn.completed gelmeyen akış eksiktir", () => {
  assert.equal(parseClaimsFromRaw(msg(payload())), null);
});

test("son mesajdan sonra item.started varsa akış kesiktir", () => {
  assert.equal(parseClaimsFromRaw([msg(payload()), ev({ type: "item.started", item: {} })].join("\n")), null);
});

test("son mesajdan sonra yarım JSON satırı varsa akış kesiktir", () => {
  assert.equal(parseClaimsFromRaw([msg(payload()), '{"type":"item.star'].join("\n")), null);
});

test("gerçek kesik önek: tamamlanmamış komut + ara mesaj kabul EDİLMEZ", () => {
  // Ölçüldü: test-standardi 14. satırda kesilince eski model 1 iddia ile "tam"
  // diyordu; tam dosyada 52 iddia var.
  const raw = [
    ev({ type: "item.started", item: { id: "c1", type: "command_execution" } }),
    ev({ type: "item.started", item: { id: "c2", type: "command_execution" } }),
    msg(payload()),
  ].join("\n");
  assert.equal(parseClaimsFromRaw(raw), null);
});

test("turn.completed'dan sonra gelen mesaj turu yeniden açar", () => {
  assert.equal(parseClaimsFromRaw([msg(payload()), END, msg(payload(2), "b")].join("\n")), null);
});

// --- mesaj yüklemi ---

test("komut çıktısı modelin hükmü sayılmaz", () => {
  // 29 gerçek ham dosyada 688 command_execution item'ı var.
  const raw = stream(ev({ type: "item.completed", item: { id: "c", type: "command_execution", content: payload() } }));
  assert.equal(parseClaimsFromRaw(raw), null);
});

test("reasoning item'ı aday olamaz", () => {
  assert.equal(parseClaimsFromRaw(stream(ev({ type: "item.completed", item: { id: "r", type: "reasoning", text: payload() } }))), null);
});

// --- satır sınıflandırma ---

test("son mesajdan sonraki düz metin satırı akışı geçersiz kılmaz", () => {
  // Koşucu `{` ile başlamayan satırı bilerek atlıyor: gerçek akışta
  // ilerleme/uyarı satırları düz metin geliyor.
  assert.equal(parseClaimsFromRaw(stream(msg(payload()), "warning: diagnostic"))?.length, 1);
});

test("tanınmayan tek satır tüm dosyayı düşürmez", () => {
  for (const noise of ['{"no_type":1}', "null", "42", '"metin"', "true", "[1,2]"]) {
    assert.equal(parseClaimsFromRaw(stream(noise, ev({ type: "thread.started" }), msg(payload())))?.length, 1, noise);
  }
});

test("type anahtarı taşıyan düz JSON olay akışı sanılmaz", () => {
  assert.equal(parseClaimsFromRaw(JSON.stringify({ type: "report", claims: [CLAIM] }))?.length, 1);
  assert.deepEqual(parseClaimsFromRaw(JSON.stringify({ type: "report", claims: [] })), []);
});

test("olay adıyla çakışan type taşıyan hüküm belgesi, olaydan sonra da okunur", () => {
  for (const t of ["item.completed", "turn.completed"]) {
    const doc = JSON.stringify({ type: t, claims: [CLAIM] });
    assert.equal(parseClaimsFromRaw(doc)?.length, 1, `tek başına: ${t}`);
    assert.equal(parseClaimsFromRaw([END, doc].join("\n"))?.length, 1, `olaydan sonra: ${t}`);
  }
});

// --- aday seçimi ve kurtarma ---

test("son mesaj ayrıştırılamıyorsa önceki mesajdan kurtarma YAPILMAZ", () => {
  assert.equal(parseClaimsFromRaw(stream(msg(payload(), "a"), msg('{"claims":[', "b"))), null);
});

test("bölünmüş küme sıralı birleşimden onarılır", () => {
  const whole = payload(2); const cut = Math.floor(whole.length / 2);
  assert.equal(parseClaimsFromRaw(stream(msg(whole.slice(0, cut), "a"), msg(whole.slice(cut), "b")))?.length, 2);
});

test("JSON string'inin içinden bölünmüş küme de onarılır", () => {
  const whole = JSON.stringify({ claims: [{ ...CLAIM, text: "boundary" }] });
  const cut = whole.indexOf("boundary") + 4;
  const raw = stream(msg(whole.slice(0, cut), "a"), msg(whole.slice(cut), "b"));
  assert.equal((parseClaimsFromRaw(raw)?.[0] as { text: string }).text, "boundary");
});

test("bölünmeden ÖNCEKİ ilerleme mesajı onarımı engellemez", () => {
  const whole = payload(1); const cut = Math.floor(whole.length / 2);
  const raw = stream(msg(payload(3), "p"), msg(whole.slice(0, cut), "a"), msg(whole.slice(cut), "b"));
  assert.equal(parseClaimsFromRaw(raw)?.length, 1);
});

test("örnek blok cevap sanılmaz: son geçerli blok kazanır", () => {
  const text = `Örnek biçim: {"claims":[]}\nCevap: {"claims":[{"text":"final"}]}\n{"claims":[`;
  assert.equal((parseClaimsFromRaw(stream(msg(text)))?.[0] as { text: string }).text, "final");
});

test("balancedBlocks iç içe blokları değil, kardeşleri sırayla verir", () => {
  assert.deepEqual(balancedBlocks('a {"x":{"y":1}} b {"z":2} c'), ['{"x":{"y":1}}', '{"z":2}']);
});

// --- ayrıştırıcı sözleşmesi ---

test("streamMessageCandidates tamlık sinyalini ayrı raporlar", () => {
  const ok = streamMessageCandidates(stream(msg(payload())));
  assert.deepEqual([ok?.lastItemIsMessage, ok?.runClosed], [true, true]);
  const cut = streamMessageCandidates(msg(payload()));
  assert.deepEqual([cut?.lastItemIsMessage, cut?.runClosed], [true, false]);
});

// --- kapı ---

test("sınır beslenmişken şemanın tanımadığı alan kapıdan geçmez", () => {
  const gated = gateClaims([{ ...CLAIM, unmeasurable_reason: "user_resolvable" }], true) as Record<string, unknown>[];
  assert.equal("unmeasurable_reason" in gated[0]!, false);
  assert.equal(gated[0]!.verdict, "olculemez");
});

test("sınır beslenmemişken alan olduğu gibi kalır", () => {
  const gated = gateClaims([{ ...CLAIM, unmeasurable_reason: "not_measurable" }], false) as Record<string, unknown>[];
  assert.equal(gated[0]!.unmeasurable_reason, "not_measurable");
});

test("uçtan uca: kesik akış kapıdan da null döner", () => {
  assert.equal(extractGatedClaims([msg(payload()), '{"type":"item.star'].join("\n"), false), null);
});

// --- 22 Ağu 2026, 3. doğrulama turu ---

test("düzyazıdaki başıboş { arkasındaki cevabı gizlemez", () => {
  // Sağlam koşumu reddeden yön — üçüncü kez aynı taraf.
  const raw = stream(msg(`Bitmemiş notasyon {\nCevap: ${payload()}`));
  assert.equal(parseClaimsFromRaw(raw)?.length, 1);
});

test("iki farklı dolu hüküm belgesi çıkarsa GÜRÜLTÜLÜ reddedilir", () => {
  // Konuma göre tahmin bu dosyada iki kez yanlış tarafa düştü (önce ilk blok,
  // sonra son blok). Belirsizlikte sessiz tahmin yerine görünür olculemez.
  const a = JSON.stringify({ claims: [{ text: "a" }] });
  const b = JSON.stringify({ claims: [{ text: "b" }] });
  assert.equal(parseClaimsFromRaw(stream(msg(`Cevap ${a}\nÖrnek ${b}`))), null);
});

test("boş örnek bloğu gerçek cevabı gölgelemez", () => {
  const ans = JSON.stringify({ claims: [{ text: "final" }] });
  const raw = stream(msg(`Örnek: {"claims":[]}\nCevap: ${ans}\nyarım {`));
  assert.equal((parseClaimsFromRaw(raw)?.[0] as { text: string }).text, "final");
});

test("kapanıştan sonra yeni bir akış başlıyorsa eski kapanış miras kalmaz", () => {
  for (const tail of [ev({ type: "item.started", item: {} }), '{"type":"item.star', ev({ type: "thread.started" })]) {
    assert.equal(parseClaimsFromRaw([msg(payload()), END, tail].join("\n")), null, tail.slice(0, 24));
  }
});

test("olay gövdesi taşıyan turn.completed, claims alanı olsa da kapanıştır", () => {
  // Koşucu tip üzerinden kapanış sayıyor; parite için burası da öyle saymalı.
  const raw = [msg(payload()), ev({ type: "turn.completed", claims: [], usage: {} })].join("\n");
  assert.equal(parseClaimsFromRaw(raw)?.length, 1);
});

test("olay gövdesi olmayan nesne, adı olay olsa da hükümdür", () => {
  for (const t of ["item.completed", "turn.completed"]) {
    assert.equal(parseClaimsFromRaw(JSON.stringify({ type: t, claims: [CLAIM] }))?.length, 1, t);
  }
});

test("parçalardan kurulan BOŞ küme kurtarma sayılmaz", () => {
  // `{"claims":[` + `]}` birleşince geçerli ama anlamsız: "model hiç iddia
  // bulmadı" demek değil, ayrıştırma artefaktı.
  const raw = stream(msg(payload(), "ans"), msg("Yalnız örnek:", "lbl"), msg('{"claims":[', "a"), msg("]}", "b"));
  assert.equal(parseClaimsFromRaw(raw), null);
});
