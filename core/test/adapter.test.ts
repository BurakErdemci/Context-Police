import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, appendFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseLine, readIncremental, discover } from "../src/adapters/claude-code.ts";
import { tmpDir } from "./helpers.ts";

const line = (o: unknown) => JSON.stringify(o);

// --- satır süzme ---

test("assistant text bloğu turn üretir", () => {
  const r = parseLine(
    line({ type: "assistant", uuid: "u1", timestamp: "2026-08-10T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "merhaba" }] } }),
  );
  assert.equal(r.kind, "turn");
  assert.equal(r.kind === "turn" && r.turn.text, "merhaba");
  assert.equal(r.kind === "turn" && r.turn.uuid, "u1");
});

test("string içerik aynen alınır", () => {
  const r = parseLine(line({ type: "user", message: { role: "user", content: "düz metin" } }));
  assert.equal(r.kind === "turn" && r.turn.text, "düz metin");
});

test("tool_use yalnız başlık bırakır, parametreler gitmez", () => {
  const r = parseLine(
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "rm -rf /", gizli: "PAROLA123" } }] } }),
  );
  assert.equal(r.kind === "turn" && r.turn.text, "[araç: Bash]");
  assert.ok(r.kind === "turn" && !r.turn.text.includes("PAROLA123"), "araç parametreleri sızmamalı");
});

test("tool_result gövdesi ASLA çıktıya girmez", () => {
  // Ölçüm: tool_result tek başına 178 MB'ın büyük kısmı. Sızarsa hem hacim
  // hem gizlilik problemi olur.
  const r = parseLine(
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "500 satırlık dosya içeriği" }] } }),
  );
  assert.equal(r.kind, "skip");
});

test("yalnız thinking içeren assistant satırı turn üretmez", () => {
  const r = parseLine(line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "iç ses" }] } }));
  assert.equal(r.kind, "skip");
});

test("karışık blok: text kalır, thinking ve tool_result düşer", () => {
  const r = parseLine(
    line({ type: "assistant", message: { role: "assistant", content: [
      { type: "thinking", thinking: "gizli" },
      { type: "text", text: "görünen" },
      { type: "tool_use", name: "Read" },
    ] } }),
  );
  assert.equal(r.kind === "turn" && r.turn.text, "görünen\n[araç: Read]");
});

test("bilinen bulgusuz tipler skip döner", () => {
  const known = ["queue-operation", "attachment", "file-history-snapshot", "file-history-delta",
    "ai-title", "last-prompt", "system", "mode", "permission-mode",
    // İlk gerçek taramada aracın kendi bulduğu iki tip:
    "custom-title", "frame-link"];
  for (const t of known) {
    assert.equal(parseLine(line({ type: t })).kind, "skip", `${t} skip olmalı`);
  }
});

test("tanınmayan tip unknown döner — sessizce yutulmaz", () => {
  const r = parseLine(line({ type: "gelecekteki-yeni-tip", veri: 1 }));
  assert.equal(r.kind, "unknown");
  assert.equal(r.kind === "unknown" && r.lineType, "gelecekteki-yeni-tip");
});

test("bozuk JSON malformed döner, çağıran çökmez", () => {
  const r = parseLine('{"type":"user", bozuk');
  assert.equal(r.kind, "malformed");
  assert.ok(r.kind === "malformed" && r.sample.length > 0);
});

// --- artımlı okuma ---

test("yalnız yeni satırlar okunur, imleç ilerler", async () => {
  const f = join(tmpDir(), "s.jsonl");
  const t = (x: string) => line({ type: "user", message: { role: "user", content: x } }) + "\n";
  writeFileSync(f, t("bir") + t("iki"));

  const r1 = await readIncremental(f, 0);
  assert.deepEqual(r1.turns.map((x) => x.text), ["bir", "iki"]);

  appendFileSync(f, t("üç"));
  const r2 = await readIncremental(f, r1.byteOffset, r1.inode);
  assert.deepEqual(r2.turns.map((x) => x.text), ["üç"], "eski satırlar tekrar okunmamalı");
});

test("yarım satır işlenmez; \\n gelince tam işlenir", async () => {
  const f = join(tmpDir(), "s.jsonl");
  const full = line({ type: "user", message: { role: "user", content: "tam" } }) + "\n";
  const half = line({ type: "user", message: { role: "user", content: "yarım" } });
  writeFileSync(f, full + half); // son satır \n'siz

  const r1 = await readIncremental(f, 0);
  assert.deepEqual(r1.turns.map((x) => x.text), ["tam"]);
  assert.equal(r1.byteOffset, Buffer.byteLength(full), "imleç yarım satırın başında kalmalı");

  appendFileSync(f, "\n");
  const r2 = await readIncremental(f, r1.byteOffset, r1.inode);
  assert.deepEqual(r2.turns.map((x) => x.text), ["yarım"]);
});

test("çok baytlı karakter chunk sınırına denk gelse de bozulmaz", async () => {
  // Türkçe karakterler UTF-8'de 2 bayt; bayt bazlı okuma yanlış yapılırsa burada kırılır.
  const f = join(tmpDir(), "s.jsonl");
  const text = "ığüşöçİĞÜŞÖÇ".repeat(5000);
  writeFileSync(f, line({ type: "user", message: { role: "user", content: text } }) + "\n");
  const r = await readIncremental(f, 0);
  assert.equal(r.turns[0]!.text, text);
});

test("dosya kısalınca imleç sıfırlanır ve truncated bildirilir", async () => {
  const f = join(tmpDir(), "s.jsonl");
  const t = (x: string) => line({ type: "user", message: { role: "user", content: x } }) + "\n";
  writeFileSync(f, t("bir") + t("iki") + t("üç"));
  const r1 = await readIncremental(f, 0);
  assert.equal(r1.turns.length, 3);

  writeFileSync(f, t("yeni")); // dosya küçüldü
  const r2 = await readIncremental(f, r1.byteOffset, r1.inode);
  assert.equal(r2.truncated, true);
  assert.deepEqual(r2.turns.map((x) => x.text), ["yeni"]);
});

test("dosyanın yerine yenisi konunca (inode değişimi) baştan okunur", async () => {
  const d = tmpDir();
  const f = join(d, "s.jsonl");
  const t = (x: string) => line({ type: "user", message: { role: "user", content: x } }) + "\n";
  writeFileSync(f, t("a") + t("b"));
  const r1 = await readIncremental(f, 0);

  const other = join(d, "other.jsonl");
  writeFileSync(other, t("a") + t("b") + t("c")); // daha BÜYÜK ama farklı inode
  renameSync(other, f);

  const r2 = await readIncremental(f, r1.byteOffset, r1.inode);
  assert.equal(r2.truncated, true, "inode değişimi boyut büyüse bile yakalanmalı");
  assert.equal(r2.turns.length, 3);
});

test("sayaçlar: unknown ve malformed raporlanıyor", async () => {
  const f = join(tmpDir(), "s.jsonl");
  writeFileSync(f, [
    line({ type: "user", message: { role: "user", content: "x" } }),
    line({ type: "yeni-tip" }),
    "{bozuk",
    line({ type: "mode" }),
  ].join("\n") + "\n");

  const r = await readIncremental(f, 0);
  assert.equal(r.turns.length, 1);
  assert.equal(r.counts.unknown, 1);
  assert.equal(r.counts.malformed, 1);
  assert.equal(r.counts.skipped, 1);
  assert.equal(r.unknownSamples[0]!.lineType, "yeni-tip");
});

// --- keşif ---

test("keşif: cwd'den gerçek yol çözülür (anahtar kayıplı olsa bile)", async () => {
  // M0'daki gerçek vaka: dizin anahtarı "unitya-Python" ama gerçek yol
  // "unityaıPython" (noktasız ı). Anahtarı tersine çeviren yaklaşım yanılır.
  const root = tmpDir();
  const key = join(root, "-Users-test-Documents-unitya-Python");
  mkdirSync(key, { recursive: true });
  mkdirSync(join(key, "memory"));
  writeFileSync(
    join(key, "sess-1.jsonl"),
    [
      line({ type: "queue-operation" }),
      line({ type: "user", cwd: "/Users/test/Documents/unityaıPython", message: { role: "user", content: "x" } }),
    ].join("\n") + "\n",
  );

  const found = await discover(root);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.path, "/Users/test/Documents/unityaıPython");
  assert.equal(found[0]!.unresolved, false);
  assert.ok(found[0]!.memoryDir?.endsWith("memory"));
  assert.equal(found[0]!.sessions.length, 1);
  assert.equal(found[0]!.sessions[0]!.sessionId, "sess-1");
});

test("keşif: memory dizini yoksa null", async () => {
  const root = tmpDir();
  const key = join(root, "-tmp-x");
  mkdirSync(key, { recursive: true });
  writeFileSync(join(key, "s.jsonl"), line({ type: "user", cwd: "/tmp/x", message: { role: "user", content: "x" } }) + "\n");
  const found = await discover(root);
  assert.equal(found[0]!.memoryDir, null);
});

test("keşif: cwd bulunamazsa unresolved işaretlenir, atlanmaz", async () => {
  const root = tmpDir();
  const key = join(root, "-var-olmayan-yol-xyz");
  mkdirSync(key, { recursive: true });
  writeFileSync(join(key, "s.jsonl"), line({ type: "mode" }) + "\n");

  const found = await discover(root);
  assert.equal(found.length, 1, "çözülemeyen proje listeden düşmemeli");
  assert.equal(found[0]!.unresolved, true);
});
