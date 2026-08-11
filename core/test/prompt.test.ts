import { test } from "node:test";
import assert from "node:assert/strict";
import {
  titleOf, buildStateTitles, buildObserverPrompt, parseObserverOutput,
} from "../src/observer/prompt.ts";
import type { Finding } from "../src/types.ts";

const finding = (id: number, content: string): Finding => ({
  id, projectId: 1, source: "observed", content, sourceRef: null,
  createdAt: "2026-08-11T00:00:00.000Z", status: "active", supersededBy: null, suspicion: 0,
});

test("başlık ilk satırdır ve 80 karakterde kesilir", () => {
  assert.equal(titleOf("Kısa karar.\nAyrıntı..."), "Kısa karar.");
  assert.equal(titleOf("x".repeat(100)).length, 81); // 80 + '…'
});

test("durum listesi bütçeyi aşınca en yeniler kalır, atlanan sayılır", () => {
  const findings = Array.from({ length: 50 }, (_, i) => finding(i + 1, `bulgu ${i + 1}: ${"a".repeat(60)}`));
  const { titles, omitted } = buildStateTitles(findings, 500);
  assert.ok(titles.length < 50 && titles.length > 0);
  assert.equal(titles.length + omitted, 50);
  // En yeni (en büyük id) kesinlikle içeride:
  assert.ok(titles.some((t) => t.id === 50));
});

test("prompt mevcut başlıkları id'leriyle, turn'leri rolleriyle taşır", () => {
  const p = buildObserverPrompt({
    projectPath: "/proj",
    titles: [{ id: 7, title: "Karar: X yapılmaz" }],
    omitted: 3,
    turns: [{ role: "user", text: "şunu ölçtüm" }, { role: "assistant", text: "sonuç 42" }],
  });
  assert.match(p, /#7: Karar: X yapılmaz/);
  assert.match(p, /3 bulgu daha var/);
  assert.match(p, /\[user\] şunu ölçtüm/);
  assert.match(p, /\[assistant\] sonuç 42/);
  assert.match(p, /supersedes/);
});

test("geçerli çıktı ayrıştırılır: çit bloklu JSON da kabul", () => {
  const raw = '```json\n{"findings":[{"content":"Karar: Y","anchors":[{"kind":"file_path","value":"src/a.ts"}]}]}\n```';
  const r = parseObserverOutput(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.anchors[0]!.kind, "file_path");
    assert.equal(r.items[0]!.supersedes, undefined);
  }
});

test("boş bulgu listesi geçerlidir", () => {
  const r = parseObserverOutput('{"findings":[]}');
  assert.equal(r.ok, true);
});

test("düşmanca çıktılar tek tek reddedilir, sebep söylenir", () => {
  const bad = [
    "hiç JSON değil",
    '{"findings":"dizi değil"}',
    '{"findings":[{"anchors":[]}]}',                                     // content yok
    '{"findings":[{"content":"","anchors":[]}]}',                        // boş content
    `{"findings":[{"content":"${"a".repeat(5000)}","anchors":[]}]}`,     // şişkin content
    '{"findings":[{"content":"x","anchors":[{"kind":"line_number","value":"12"}]}]}', // geçersiz çapa türü
    '{"findings":[{"content":"x","anchors":[{"kind":"symbol","value":""}]}]}',        // boş çapa değeri
    '{"findings":[{"content":"x","anchors":[],"supersedes":-3}]}',       // negatif id
    '{"findings":[{"content":"x","anchors":[],"supersedes":1.5}]}',      // tam sayı değil
    '[]',                                                                // üst düzey dizi
  ];
  for (const raw of bad) {
    const r = parseObserverOutput(raw);
    assert.equal(r.ok, false, `reddedilmedi: ${raw.slice(0, 60)}`);
    if (!r.ok) assert.ok(r.error.length > 0);
  }
});

test("bilinmeyen madde anahtarları yutulur, bilinenler kalır (model gürültüsü toleransı)", () => {
  const r = parseObserverOutput('{"findings":[{"content":"x","anchors":[],"confidence":0.9}]}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(Object.keys(r.items[0]!).sort(), ["anchors", "content"]);
});

// ————— Kendi düşmanca vakalarım (brief listesi taban, tavan değil) —————

test("düşmanca çıktılar, ikinci tur: parser'ın kendi kör noktaları", () => {
  const bad: Array<[string, string]> = [
    ["null gövde", "null"],
    ["JSON dize", '"findings"'],
    ["sayı gövde", "42"],
    ["findings eksik", '{"items":[]}'],
    ["findings null", '{"findings":null}'],
    ["madde null", '{"findings":[null]}'],
    ["madde dize", '{"findings":["x"]}'],
    ["content dize değil", '{"findings":[{"content":42,"anchors":[]}]}'],
    ["content yalnız boşluk", '{"findings":[{"content":"   \\n  ","anchors":[]}]}'],
    ["anchors nesne", '{"findings":[{"content":"x","anchors":{}}]}'],
    ["çapa dize", '{"findings":[{"content":"x","anchors":["src/a.ts"]}]}'],
    ["çapa null", '{"findings":[{"content":"x","anchors":[null]}]}'],
    ["çapa kind eksik", '{"findings":[{"content":"x","anchors":[{"value":"a"}]}]}'],
    ["çapa value eksik", '{"findings":[{"content":"x","anchors":[{"kind":"symbol"}]}]}'],
    ["çapa value sayı", '{"findings":[{"content":"x","anchors":[{"kind":"symbol","value":7}]}]}'],
    ["çapa değeri şişkin", `{"findings":[{"content":"x","anchors":[{"kind":"file_path","value":"${"a".repeat(513)}"}]}]}`],
    ["çapa sayısı sınır üstü", `{"findings":[{"content":"x","anchors":[${Array.from({ length: 17 }, () => '{"kind":"symbol","value":"s"}').join(",")}]}]}`],
    ["supersedes sıfır", '{"findings":[{"content":"x","anchors":[],"supersedes":0}]}'],
    ["supersedes dize", '{"findings":[{"content":"x","anchors":[],"supersedes":"12"}]}'],
    ["supersedes NaN benzeri", '{"findings":[{"content":"x","anchors":[],"supersedes":1e999}]}'],
    ["boş girdi", ""],
    ["yalnız boşluk", "   \n\t "],
  ];
  for (const [ad, raw] of bad) {
    const r = parseObserverOutput(raw);
    assert.equal(r.ok, false, `reddedilmedi: ${ad}`);
    if (!r.ok) assert.ok(r.error.length > 0, `sebep boş: ${ad}`);
  }
});

test("sınır değerler kabul edilir: tam sınırda content, çapa, çapa sayısı", () => {
  const okCases: Array<[string, string]> = [
    ["content tam 4000", `{"findings":[{"content":"${"a".repeat(4000)}","anchors":[]}]}`],
    ["çapa değeri tam 512", `{"findings":[{"content":"x","anchors":[{"kind":"file_path","value":"${"a".repeat(512)}"}]}]}`],
    ["çapa sayısı tam 16", `{"findings":[{"content":"x","anchors":[${Array.from({ length: 16 }, () => '{"kind":"symbol","value":"s"}').join(",")}]}]}`],
    ["supersedes 1", '{"findings":[{"content":"x","anchors":[],"supersedes":1}]}'],
  ];
  for (const [ad, raw] of okCases) {
    const r = parseObserverOutput(raw);
    assert.equal(r.ok, true, `reddedildi: ${ad} — ${r.ok ? "" : r.error}`);
  }
});

test("dört çapa türü de tanınır", () => {
  const raw = '{"findings":[{"content":"x","anchors":[' +
    '{"kind":"file_path","value":"a.ts"},{"kind":"symbol","value":"f"},' +
    '{"kind":"commit_sha","value":"deadbee"},{"kind":"external_path","value":"/m/n.md"}]}]}';
  const r = parseObserverOutput(raw);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.items[0]!.anchors.map((a) => a.kind),
    ["file_path", "symbol", "commit_sha", "external_path"]);
});

test("çıplak çit, BOM ve etrafındaki boşluk ayrıştırmayı bozmaz", () => {
  for (const raw of [
    '```\n{"findings":[]}\n```',              // dilsiz çit
    '\n\n  {"findings":[]}  \n\n',            // trim gerekli (Görev 2: executor trim etmiyor)
    '﻿{"findings":[]}',                  // BOM
    '```json\n\n{"findings":[]}\n\n```',      // çit içi boş satırlar
  ]) {
    const r = parseObserverOutput(raw);
    assert.equal(r.ok, true, `reddedildi: ${JSON.stringify(raw.slice(0, 24))}`);
  }
});

test("__proto__ anahtarı prototip kirletmez, çıktıya da sızmaz", () => {
  const r = parseObserverOutput('{"findings":[{"content":"x","anchors":[],"__proto__":{"kirli":true}}]}');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(Object.keys(r.items[0]!).sort(), ["anchors", "content"]);
    assert.equal(({} as Record<string, unknown>)["kirli"], undefined, "Object.prototype kirlendi");
  }
});

test("çapa listesi maddeler arasında paylaşılmaz", () => {
  const r = parseObserverOutput(
    '{"findings":[{"content":"a","anchors":[{"kind":"symbol","value":"s"}]},{"content":"b","anchors":[]}]}',
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.items[0]!.anchors.length, 1);
    assert.equal(r.items[1]!.anchors.length, 0);
    assert.notEqual(r.items[0]!.anchors, r.items[1]!.anchors);
  }
});

test("boş durum listesi ve sıfır atlanan prompt'ta doğru görünür", () => {
  const p = buildObserverPrompt({ projectPath: "/p", titles: [], omitted: 0, turns: [] });
  assert.match(p, /\(henüz bulgu yok\)/);
  assert.doesNotMatch(p, /bulgu daha var/);
});

test("bütçe tek başlığa bile yetmezse liste boşalır, sayım tutar", () => {
  const findings = Array.from({ length: 5 }, (_, i) => finding(i + 1, "a".repeat(60)));
  const { titles, omitted } = buildStateTitles(findings, 1);
  assert.equal(titles.length, 0);
  assert.equal(omitted, 5);
});

test("başlıklar prompt'ta eski→yeni sırada, kaynak dizi bozulmadan", () => {
  const findings = [finding(3, "üç"), finding(1, "bir"), finding(2, "iki")];
  const { titles, omitted } = buildStateTitles(findings);
  assert.deepEqual(titles.map((t) => t.id), [1, 2, 3]);
  assert.equal(omitted, 0);
  assert.deepEqual(findings.map((f) => f.id), [3, 1, 2], "girdi dizisi yerinde sıralanmamalı");
});

test("başlık CRLF ve baştaki boşlukla da ilk satırı verir", () => {
  assert.equal(titleOf("  Karar: X\r\nayrıntı"), "Karar: X");
  assert.equal(titleOf(""), "");
});

// ————— Mimar kararı (11 Ağu): parser toleransı — endişe 1 ve 3 —————

test("supersedes null, alan hiç yokmuş gibi karşılanır", () => {
  const r = parseObserverOutput('{"findings":[{"content":"x","anchors":[],"supersedes":null}]}');
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (r.ok) {
    assert.equal(r.items[0]!.supersedes, undefined);
    assert.deepEqual(Object.keys(r.items[0]!).sort(), ["anchors", "content"], "null alan çıktıya sızmamalı");
  }
});

test("düzyazıyla sarmalanmış JSON kurtarılır", () => {
  const cases: Array<[string, string]> = [
    ["önce ve sonra düzyazı", 'İşte bulgular:\n{"findings":[{"content":"Karar: Y","anchors":[]}]}\nUmarım yardımcı olur.'],
    ["yalnız önde düzyazı", 'İşte bulgular:\n{"findings":[]}'],
    ["düzyazı + çit", 'Sonuç:\n```json\n{"findings":[]}\n```\nbitti'],
    ["çit kapanmamış", '```json\n{"findings":[]}'],
  ];
  for (const [ad, raw] of cases) {
    const r = parseObserverOutput(raw);
    assert.equal(r.ok, true, `kurtarılamadı: ${ad} — ${r.ok ? "" : r.error}`);
  }
  const r2 = parseObserverOutput('İşte bulgular:\n{"findings":[{"content":"Karar: Y","anchors":[]}]}\nUmarım yardımcı olur.');
  if (r2.ok) assert.equal(r2.items[0]!.content, "Karar: Y", "kurtarma içeriği bozmamalı");
});

test("kurtarma çöpü kabul etmez: ilk { ile son } arası da doğrulanır", () => {
  const bad: Array<[string, string]> = [
    ["sarmal içi bozuk JSON", 'İşte bulgular:\n{"findings":[bozuk}\nbitti.'],
    ["iki ayrı süslü parantez bloğu", "{ merhaba } ve { dünya }"],
    ["kurtarılan JSON yanlış şekilli", 'not: {"a":1} son'],
    ["kurtarılan JSON şema dışı", 'bak: {"findings":[{"content":"x","anchors":[{"kind":"line_number","value":"1"}]}]} bitti'],
    ["yalnız açılış parantezi", 'İşte: {"findings":[]'],
    ["parantezler ters sırada", "} önce kapanış { sonra açılış"],
  ];
  for (const [ad, raw] of bad) {
    const r = parseObserverOutput(raw);
    assert.equal(r.ok, false, `kabul edildi: ${ad}`);
    if (!r.ok) assert.ok(r.error.length > 0, `sebep boş: ${ad}`);
  }
});

test("prompt turn metnini olduğu gibi taşır, çok satırlı olsa da", () => {
  const p = buildObserverPrompt({
    projectPath: "/p",
    titles: [],
    omitted: 0,
    turns: [{ role: "user", text: "satır1\nsatır2" }],
  });
  assert.match(p, /\[user\] satır1\nsatır2/);
});
