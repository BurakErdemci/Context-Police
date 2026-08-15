// M4.1 — tavan aşımının ÇIKTI sözleşmesi. Kaynak: adapters/codex.ts.
//
// Yapısal kısıt (executor.ts ExecutorCaps): usage tek bir `turn.completed`
// ile akışın SONUNDA düşüyor, yani token aşımı çoğu zaman ancak cevap
// TAMAMEN geldikten sonra görülebiliyor. Orada kesilen bir iş yok; cevabı
// atmak harcanmış bütçeyi ikinci kez ödetirdi. Akış ortasında kesilen aşım
// ise gerçekten yarım kalmıştır ve çıktısı taşınmaz — ayrımı bu iki test
// birlikte sabitliyor.
//
// İkisi de gerçek bir alt süreç akışı üretip ürünü çağırıyor; kaynak metni
// taranmıyor.

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

// Yapısal kısıt (executor.ts ExecutorCaps): usage tek bir `turn.completed` ile
// akışın SONUNDA düşüyor. Aşım o an görülüyorsa kesilen bir iş yok — cevap
// eksiksiz geldi. Atmak, harcanmış bütçeyi ikinci kez ödetmek olurdu.

test("post-hoc token aşımı: çıktı KORUNUR, aşım capExceeded ile raporlanır", async () => {
  const body = `${prelude}
process.stdin.on("end", () => {
  fs.writeFileSync(out, "tam gelmiş cevap");
  // Yeni-satırsız: satır finish()'te, süreç KAPANDIKTAN sonra işlenir — aşımın
  // ancak iş bittikten sonra görülebildiği gerçek yol.
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":5000}}');
});
`;
  const res = await createCodexExecutor({ binary: fakeBinary(body), timeoutMs: 10_000 }).run({
    prompt: "x",
    caps: { maxTotalTokens: 1000 },
  });
  assert.equal(res.output, "tam gelmiş cevap", "post-hoc aşımda gelen cevap atılmamalı");
  assert.equal(res.ok, false, "bütçe ihlali sessizce geçmemeli");
  assert.equal(res.capExceeded?.kind, "tokens");
  assert.equal(res.capExceeded?.observed, 5000);
  assert.equal(res.capExceeded?.limit, 1000);
});

test("akış ORTASINDA kesilen aşım çıktıyı korumaz (iş gerçekten yarıda kaldı)", async () => {
  const body = `${prelude}
process.stdin.on("end", () => {
  fs.writeFileSync(out, "yarım cevap");
  let n = 0;
  const t = setInterval(() => {
    process.stdout.write('{"type":"item.completed"}\\n');
    if (++n > 50) clearInterval(t);
  }, 5);
});
`;
  const res = await createCodexExecutor({ binary: fakeBinary(body), timeoutMs: 10_000 }).run({
    prompt: "x",
    caps: { maxItems: 3 },
  });
  assert.equal(res.ok, false);
  assert.equal(res.capExceeded?.kind, "items");
  assert.equal(res.output, "", "kesilen koşumun çıktısı güvenilmez, taşınmaz");
  // Koşumu bitiren KARAR tavandır: kesme erken dönüşten geçmezse hata mesajı
  // öldürülmüş sürecin çıkış koduna düşer ve sebep kaybolur.
  assert.match(res.error ?? "", /maliyet tavanı/, "kesme sebebi tavan olarak raporlanmalı");
});
