// M4.1 denetimi — DOĞRULAMA TURU (dalga 4).
//
// Buradaki testler dünkü DÜZELTMELERİN kendisinde bulunan kusurları kapatıyor.
// Ortak ders: bir düzeltme takası taşır, ve takasın yanlış tarafa kayması yeni
// bir arıza sınıfıdır — "kapattım" demek ölçüm değil.
//
// Gerçek `codex` binary'si ÇAĞRILMIYOR (kota): sahte binary geçici dizinde
// kuruluyor, test sonunda dizinle birlikte siliniyor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createCodexExecutor } from "../src/adapters/codex.ts";
import { tmpDir } from "./helpers.ts";

/** stdin'i tüketip verilen gövdeyi koşan sahte binary. */
function fakeBinary(body: string): string {
  const p = join(tmpDir(), "fake-codex");
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// --- class: oversize-stream-drop-uncounted (adapters/codex.ts) ---
// Dünkü düzeltme `unparsedLines`/`unknownEvents` sayaçlarını ekledi ama 1 MB
// sınırını aşan sonlanmamış tampon HİÇBİR sayacı artırmadan siliniyordu: 1,1
// MiB'lık GEÇERLİ bir olay sessizce kayboluyor ve düzeltmenin kapattığını
// iddia ettiği ayrım ("akış hiç gelmedi" / "akış anlaşılmadı") açık kalıyordu.

const emitOversize = `
const fs = require("node:fs");
let out;
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === "-o") out = process.argv[i + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "future.event", pad: "x".repeat(1_100_000) }) + "\\n");
  fs.writeFileSync(out, "ok");
});
`;

test("[oversize-stream-drop-uncounted] sınırı aşan tampon GÖRÜNÜR bir sayaca yazılır", async () => {
  const res = await createCodexExecutor({ binary: fakeBinary(emitOversize) }).run({ prompt: "x" });
  assert.equal(res.ok, true, "atılan tampon koşumu düşürmez, yalnız görünür olur");
  assert.ok(res.usage, "ölçüm YOK sanılmamalı: bir şey geldi ve atıldı");
  assert.equal(res.usage!.oversizeDrops, 1, "atılan tampon sayılmalı");
  // Aynı olay "satır geldi, ölçüme dönüşmedi" kümesine de girer; ayrım
  // `oversizeDrops` alanında (sebep: uzunluk, bozuk JSON değil).
  assert.equal(res.usage!.unparsedLines, 1);
  assert.equal(res.usage!.items, undefined, "tanınan olay yok: 0 uydurulmamalı");
});

test("[oversize-stream-drop-uncounted] atılan satırın KUYRUĞU ikinci kez sayılmaz", async () => {
  // Kesme noktasından sonraki parça bağımsız bir satır değil; `{` ile başlarsa
  // eskiden ikinci bir "bozuk satır" olarak sayılıyordu.
  const body = `
const fs = require("node:fs");
let out;
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === "-o") out = process.argv[i + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("{" + "x".repeat(1_100_000) + '{"type":"item.completed"}\\n');
  process.stdout.write('{"type":"item.completed"}\\n');
  fs.writeFileSync(out, "ok");
});
`;
  const res = await createCodexExecutor({ binary: fakeBinary(body) }).run({ prompt: "x" });
  assert.equal(res.usage!.oversizeDrops, 1, "tek satır atıldı, tek sayım");
  assert.equal(res.usage!.unparsedLines, 1);
  assert.equal(res.usage!.items, 1, "atılan satırdan SONRAKİ gerçek olay hâlâ ölçülmeli");
});

test("[oversize-stream-drop-uncounted] normal akışta alan HİÇ yazılmaz (0 uydurma yok)", async () => {
  const body = `
const fs = require("node:fs");
let out;
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === "-o") out = process.argv[i + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write('{"type":"item.completed"}\\n');
  fs.writeFileSync(out, "ok");
});
`;
  const res = await createCodexExecutor({ binary: fakeBinary(body) }).run({ prompt: "x" });
  assert.equal(res.usage!.items, 1);
  assert.equal("oversizeDrops" in res.usage!, false, "yokken yazma");
  assert.equal("unparsedLines" in res.usage!, false);
});

// --- class: cleanup-ownership-released-early (adapters/codex.ts) ---
// `run()` geçici dizini sinyal temizlik defterinden `await rm` ÖNCESİNDE
// düşürüyordu: o pencerede gelen bir SIGINT dizini artık görmüyor ve dizin
// sızıyordu. Sahiplik silme BİTENE kadar bizde kalmalı.

test("[cleanup-ownership-released-early] silme bitene kadar dizin sinyal defterinde kalır", async () => {
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const require = createRequire(import.meta.url);
  const fs = require("node:fs") as typeof import("node:fs");
  const originalRm = fs.promises.rm;

  let cleanupDir: string | undefined;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const noop = (): void => {};

  const body = `
const fs = require("node:fs");
let out;
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === "-o") out = process.argv[i + 1];
process.stdin.resume();
process.stdin.on("end", () => { fs.writeFileSync(out, "ok"); });
`;
  const binary = fakeBinary(body);

  // `rm` GECİKTİRİLİYOR: gerçek yarış penceresi böyle deterministik oluyor.
  (fs.promises as { rm: unknown }).rm = async (p: string) => { cleanupDir = String(p); await gate; };
  syncBuiltinESMExports();
  // SIGINT'i test sürecini öldürmeden gözlemleyebilmek için bir dinleyici:
  // adaptörün kendi işleyicisi prepend edilmiş durumda, önce o koşar.
  process.on("SIGINT", noop);
  try {
    const running = createCodexExecutor({ binary }).run({ prompt: "x" });
    for (let i = 0; i < 200 && cleanupDir === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(cleanupDir, "koşum asenkron temizliğe ulaşmalı");
    // Silme SÜRERKEN gelen sinyal dizini hâlâ görmeli ve senkron silmeli.
    process.emit("SIGINT", "SIGINT");
    assert.equal(existsSync(cleanupDir!), false, "sinyal anında dizin sahipsiz kalmamalı");
    release();
    await running;
  } finally {
    (fs.promises as { rm: unknown }).rm = originalRm;
    syncBuiltinESMExports();
    process.removeListener("SIGINT", noop);
  }
});
