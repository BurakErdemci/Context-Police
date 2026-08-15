// M4.1 — akış satır tavanı (kök değişiklik) + post-hoc tavan aşımında çıktının
// korunması. Kaynak: adapters/codex.ts.
//
// Aynı SINIF üç turda üç kez çıktı: (1) atılan tampon hiçbir sayacı artırmıyordu,
// (2) tavan UTF-16 kod birimi sayıyordu, (3) tavan tamamlanmış satıra HİÇ
// uygulanmıyordu. Üçü de sorunun yanlış sorulmasından: "biriken tampon büyüdü mü"
// değil, "bu satır büyük mü". Buradaki testler o soruyu sabitliyor.
//
// Hiçbiri kaynak metnine bakmıyor — hepsi gerçek bir alt süreç akışı üretip
// ürünü çağırıyor (metin tarayan test, korunan kod mutasyonla kaldırılınca da
// yeşil kalıyor; bu depoda ölçüldü).

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createCodexExecutor } from "../src/adapters/codex.ts";
import { tmpDir } from "./helpers.ts";

function fakeBinary(body: string): string {
  const p = join(tmpDir(), "fake-codex");
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** `-o` yolunu argv'den bulup dolduran ortak önek; boş çıktı dosyası arıza sayılır. */
const prelude = `
const fs = require("node:fs");
let out;
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === "-o") out = process.argv[i + 1];
process.stdin.resume();
`;

/** Yeni-satırıyla birlikte TEK yazımda basılan satırlar. */
function emitter(lines: string[]): string {
  return `${prelude}
process.stdin.on("end", () => {
  const lines = ${JSON.stringify(lines)};
  for (const l of lines) process.stdout.write(l + "\\n");
  fs.writeFileSync(out, "ok");
});
`;
}

const OVERSIZE_ASCII = JSON.stringify({ type: "item.completed", pad: "x".repeat(1_000_050) });
const ITEM = '{"type":"item.completed"}';

test("tamamlanmış oversize satır ATILIR ve sayılır (yeni-satırı aynı yazımda gelse bile)", async () => {
  const res = await createCodexExecutor({ binary: fakeBinary(emitter([OVERSIZE_ASCII])) }).run({ prompt: "x" });
  assert.equal(res.ok, true);
  assert.ok(res.usage, "bir şey geldi: ölçüm yok sanılmamalı");
  assert.equal(res.usage!.oversizeDrops, 1, "sonlandırılmış satır da tavana tabi");
  assert.equal(res.usage!.unparsedLines, 1, "atılan satır 'ölçüme dönüşmedi' kümesinde");
  assert.equal(res.usage!.items, undefined, "atılan satır ayrıştırılmış SAYILMAMALI");
});

test("atılan tamamlanmış satır SONRAKİ satırı yutmaz", async () => {
  // Tamamlanmış satırın kuyruğu yok — tamamı zaten tüketildi. `dropping`
  // kurulursa ondan sonraki GEÇERLİ olay sessizce yenirdi.
  const res = await createCodexExecutor({ binary: fakeBinary(emitter([OVERSIZE_ASCII, ITEM, ITEM])) }).run({
    prompt: "x",
  });
  assert.equal(res.usage!.oversizeDrops, 1);
  assert.equal(res.usage!.items, 2, "atılan satırdan sonraki iki olay da ölçülmeli");
});

test("tavanın ALTINDAKİ uzun satır atılmaz (yanlış alarm yok)", async () => {
  const buyukAmaGecerli = JSON.stringify({ type: "item.completed", pad: "x".repeat(900_000) });
  const res = await createCodexExecutor({ binary: fakeBinary(emitter([buyukAmaGecerli])) }).run({ prompt: "x" });
  assert.equal(res.usage!.items, 1);
  assert.equal("oversizeDrops" in res.usage!, false, "900 KB tavanın altında");
});

test("tamamlanmış satırın tavanı BAYT ölçer, UTF-16 kod birimi değil", async () => {
  // 500.050 adet `é`: 500.050 kod birimi (tavanın ALTINDA), 1.000.100 bayt
  // (ÜSTÜNDE). Satır kasten tavanın hemen üstünde tutuldu ki tek yazımda gelsin
  // ve tampon yoluna değil TAMAMLANMIŞ SATIR yoluna girsin.
  const body = `${prelude}
process.stdin.on("end", () => {
  process.stdout.write('{"type":"item.completed","pad":"' + "\\u00e9".repeat(500050) + '"}\\n');
  fs.writeFileSync(out, "ok");
});
`;
  const res = await createCodexExecutor({ binary: fakeBinary(body) }).run({ prompt: "x" });
  assert.equal(res.usage!.oversizeDrops, 1, "baytı tavanı aşan satır atılmalı");
  assert.equal(res.usage!.items, undefined);
});

test("oversize atım unparsedLines'a girer, oversizeDrops SEBEBİ ayırır", async () => {
  const res = await createCodexExecutor({
    binary: fakeBinary(emitter([OVERSIZE_ASCII, "{bozuk json", ITEM])),
  }).run({ prompt: "x" });
  assert.equal(res.usage!.oversizeDrops, 1, "yalnız uzunluktan atılan sayılır");
  assert.equal(res.usage!.unparsedLines, 2, "uzunluk + bozuk JSON: ikisi de ölçüme dönüşmedi");
  assert.equal(res.usage!.items, 1);
});

// Yeni-satırı HİÇ gelmeyen satır: tamamlanmış satır kapısı bunu asla görmez,
// dolayısıyla tampon kapısı kalmak zorunda — yoksa bellek sınırsız büyür ve
// satır sonunda "bozuk JSON" diye ölçülür, "hiç görmedim" diye değil.
test("yeni-satırı hiç gelmeyen oversize satır sınırlanır ve chunk başına DEĞİL satır başına sayılır", async () => {
  const body = `${prelude}
process.stdin.on("end", () => {
  // Aralarında gerçek bir olay döngüsü turu var: parçaların ayrı chunk olarak
  // geldiği garanti. Yeni-satır asla basılmıyor.
  let n = 0;
  const t = setInterval(() => {
    process.stdout.write("x".repeat(700000));
    if (++n === 4) { clearInterval(t); fs.writeFileSync(out, "ok"); process.stdout.end(); }
  }, 25);
});
`;
  const res = await createCodexExecutor({ binary: fakeBinary(body), timeoutMs: 10_000 }).run({ prompt: "x" });
  assert.equal(res.usage!.oversizeDrops, 1, "2,8 MB tek satırdır: tavan bir kez, chunk başına değil");
  assert.equal(res.usage!.unparsedLines, 1);
  assert.equal(res.usage!.items, undefined);
});

// Atılan satırın kuyruğu bağımsız bir satır değil: kesme noktası şansa `{`'a
// denk gelirse ikinci kez "bozuk satır" diye sayılıyordu.
test("tampon atımından sonraki KUYRUK ikinci kez sayılmaz", async () => {
  const body = `${prelude}
process.stdin.on("end", () => {
  process.stdout.write('{"type":"item.completed","pad":"' + "x".repeat(700000));
  setTimeout(() => {
    process.stdout.write("x".repeat(700000));
    setTimeout(() => {
      process.stdout.write('{"kuyruk\\n');
      process.stdout.write('{"type":"item.completed"}\\n');
      fs.writeFileSync(out, "ok");
    }, 30);
  }, 30);
});
`;
  const res = await createCodexExecutor({ binary: fakeBinary(body), timeoutMs: 10_000 }).run({ prompt: "x" });
  assert.equal(res.usage!.oversizeDrops, 1);
  assert.equal(res.usage!.unparsedLines, 1, "atılan satırın kuyruğu ikinci kez sayılmamalı");
  assert.equal(res.usage!.items, 1, "atımdan sonraki gerçek olay hâlâ ölçülmeli");
});
