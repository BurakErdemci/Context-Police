// `score.ts` — kullanıcıya devredilen hükümlerin raporda GÖRÜNMESİ.
//
// NEDEN BU TESTLER VAR: `olculemez` skor paydasından düşüyor (dosya başındaki
// gerekçe). Bu, her şeye "ölçemedim" diyen dejenere bir hakeme kusursuz bir
// yanlış-alarm oranı verir. Kapının üç sayısı bu yüzden tek başına okunamamalı.
// Testler aracı GERÇEKTEN KOŞTURUYOR ve çıktısını okuyor; kaynak metin
// taranmıyor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCORE = join(HERE, "..", "score.ts");

type Row = Record<string, unknown>;
const jsonl = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const g = (note: string, line: number, verdict: string): Row =>
  ({ note, claim_id: `${note}#${line}`, line_start: line, line_end: line, text: `g${line}`, verdict });

function runScore(golden: Row[], hakem: Row[], cost?: Row[]): string {
  const dir = mkdtempSync(join(tmpdir(), "score-"));
  try {
    const gp = join(dir, "golden.jsonl");
    const hp = join(dir, "hakem.jsonl");
    writeFileSync(gp, jsonl(golden));
    writeFileSync(hp, jsonl(hakem));
    const args = ["--disable-warning=ExperimentalWarning", SCORE, gp, hp];
    if (cost) {
      const cp = join(dir, "maliyet.jsonl");
      writeFileSync(cp, jsonl(cost));
      args.push(cp);
    }
    const r = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(r.status, 0, `score.ts hata verdi: ${r.stderr}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Altın set: n1 çürük (hedef), n2 geçerli (yanlış alarm zemini).
const GOLDEN: Row[] = [g("n1", 1, "curuk"), g("n2", 1, "gecerli")];

test("kullanıcıya devredilen hüküm kapının üç sayısıyla AYNI blokta basılır", () => {
  const out = runScore(GOLDEN, [
    { note: "n1", line_start: 1, line_end: 1, text: "h", verdict: "curuk", evidence: "e" },
    {
      note: "n2", line_start: 1, line_end: 1, text: "h", verdict: "olculemez",
      unmeasurable_reason: "user_resolvable", evidence: "e",
    },
  ]);
  const gate = out.slice(out.indexOf("── ÇIKIŞ KAPISI"), out.indexOf("── not düzeyine"));
  assert.match(gate, /YAKALAMA {6}1\/1/);
  assert.match(gate, /YANLIŞ ALARM {2}0/);
  // Üç sayıyı okuyan aynı blokta bunu da okumak ZORUNDA.
  assert.match(gate, /KULLANICIYA {3}1\b/);
  assert.match(gate, /PAYDA DIŞI/);
  assert.match(gate, /1 notta/);
});

test("sıradan olculemez kullanıcı sayısına girmez", () => {
  const out = runScore(GOLDEN, [
    { note: "n1", line_start: 1, line_end: 1, text: "h", verdict: "curuk", evidence: "e" },
    // Alt sebep yok (eski çıktı biçimi) ve `not_measurable`: ikisi de kuyruğa girmez.
    { note: "n2", line_start: 1, line_end: 1, text: "h", verdict: "olculemez", evidence: "e" },
    {
      note: "n2", line_start: 1, line_end: 1, text: "h", verdict: "olculemez",
      unmeasurable_reason: "not_measurable", evidence: "e",
    },
  ]);
  assert.match(out, /KULLANICIYA {3}0 {3}\(olculemez · kullanıcı çözebilir, 0 notta/);
});

test("dejenere hakem: her şeye devrettiğinde üç sayı temiz kalır ama devir görünür", () => {
  // Ölçülen tehlike buydu: bu hakem SIFIR yanlış alarm alıyor. Sayı raporda
  // durmasa "kusursuz" görünürdü.
  const out = runScore(GOLDEN, [
    {
      note: "n1", line_start: 1, line_end: 1, text: "h", verdict: "olculemez",
      unmeasurable_reason: "user_resolvable", evidence: "e",
    },
    {
      note: "n2", line_start: 1, line_end: 1, text: "h", verdict: "olculemez",
      unmeasurable_reason: "user_resolvable", evidence: "e",
    },
  ]);
  assert.match(out, /YAKALAMA {6}0\/1/);
  assert.match(out, /YANLIŞ ALARM {2}0/);
  assert.match(out, /KULLANICIYA {3}2 {3}\(olculemez · kullanıcı çözebilir, 2 notta/);
  // Not düzeyine yuvarlamada da görünüyor.
  assert.match(out, /kullanıcıya {3}2\/2/);
});

// KUSUR C1 (15 Ağu 2026 doğrulama turu). Kapsam sayacının PAYI hakem/maliyet
// çıktısındaki TÜM not adlarını sayıyor, PAYDASI yalnız altın set notlarını
// sayıyordu. Altın sette olmayan bir not (yeniden adlandırılmış, yazım hatalı,
// bayat) payı şişiriyordu. Ölçülen arıza: tek altın not, boş maliyet günlüğü,
// hakem çıktısında tek `unknown-note` satırı → araç
// `kapsanan not: 1/1 (denetlenmeyen: golden-note)` basıyordu; aynı satır hem tam
// kapsama hem "tek hedef not incelenmedi" diyordu. Operatör koşumun tam olup
// olmadığına bu satıra bakarak karar veriyor.

test("kapsam payı altın set EVRENİNDE: yabancı not oranı şişiremez", () => {
  const out = runScore(
    [g("golden-note", 1, "curuk")],
    [{ note: "unknown-note", line_start: 1, line_end: 1, text: "h", verdict: "curuk", evidence: "e" }],
    [], // boş maliyet günlüğü: hiçbir not denenmemiş
  );
  assert.match(out, /kapsanan not: 0\/1/);
  assert.match(out, /denetlenmeyen: golden-note/);
  // Kendi kendini yalanlayan satır bir daha basılmamalı.
  assert.equal(/kapsanan not: 1\/1/.test(out), false, "yabancı not payı şişirmemeli");
});

test("altın sette olmayan not SESSİZCE düşmez: ayrı satırda 'skora girmez' der", () => {
  // Sayımdan çıkarmak yetmez — uydurulmuş ya da yeniden adlandırılmış bir not
  // koşum hakkında gerçek bir sinyal; söylenmeden düşürülürse o sinyal kaybolur.
  const out = runScore(
    [g("golden-note", 1, "curuk")],
    [
      { note: "unknown-note", line_start: 1, line_end: 1, text: "h", verdict: "curuk", evidence: "e" },
      { note: "golden-note", line_start: 1, line_end: 1, text: "h", verdict: "curuk", evidence: "e" },
    ],
    [{ note: "yazim-hatasi-notu" }],
  );
  assert.match(out, /kapsanan not: 1\/1/);
  assert.match(out, /altın sette OLMAYAN 2 not çıktıda geçiyor \(skora girmez\)/);
  assert.match(out, /unknown-note/);
  assert.match(out, /yazim-hatasi-notu/);
});

test("mevcut üç sayının hesabı DEĞİŞMEDİ", () => {
  // Yanlış alarm: hakem geçerli altın iddianın üstüne `curuk` demiş.
  const out = runScore(GOLDEN, [
    { note: "n1", line_start: 1, line_end: 1, text: "h", verdict: "gecerli", evidence: "e" },
    { note: "n2", line_start: 1, line_end: 1, text: "h", verdict: "curuk", evidence: "e" },
  ]);
  assert.match(out, /YAKALAMA {6}0\/1 {3}%0\.0/);
  assert.match(out, /YANLIŞ ALARM {2}1 {3}\(geçerli altın iddia: 1\)/);
  assert.match(out, /KULLANICIYA {3}0/);
});
