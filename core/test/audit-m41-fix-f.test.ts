// M4.1 denetim dalgası 3 — SINIF KAPANIŞI.
//
// Bu dosyadaki her test bir BULGU SINIFININ adını taşıyor. Beşi de aynı kök
// sınıfın varyantı: "sebep sessizce yutuluyor". Yutmanın bedeli her yüzeyde
// farklı — kimini mükerrer teslimat, kimini kayıp teşhis, kimini yabancı bir
// sürece sinyal — ama düzeltme ortak: arıza bir OLAYA ya da SAYACA dönüşür.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, closeQuietly } from "../src/store/db.ts";
import { claudeCodeAdapter, readCwdDetailed } from "../src/adapters/claude-code.ts";
import { scanOnce, type IdentityProbe } from "../src/scan.ts";
import { listEvents, countEvents } from "../src/store/events.ts";
import { parseObserverOutput } from "../src/observer/prompt.ts";
import { getCursor } from "../src/store/projects.ts";
import { tmpDir } from "./helpers.ts";
import type { Turn } from "../src/types.ts";

const userLine = (text: string, cwd?: string) =>
  JSON.stringify({ type: "user", ...(cwd ? { cwd } : {}), message: { role: "user", content: text } }) + "\n";

/** Tek projeli, tek oturumlu sahte kök. */
function fakeRoot(text = "bir"): { root: string; file: string } {
  const root = tmpDir();
  const dir = join(root, "-tmp-proje-f");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sess-1.jsonl");
  writeFileSync(file, userLine(text, "/tmp/proje-f"));
  return { root, file };
}

const realProbe: IdentityProbe = {
  realpath: (p) => import("node:fs/promises").then((m) => m.realpath(p)),
  stat: (p) => import("node:fs/promises").then((m) => m.stat(p)),
};

function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: enjekte edilmiş ölçüm arızası`);
  err.code = code;
  return err;
}

// --- class: silent-fallback-breaks-delivery-contract (scan.ts) ---

test("[silent-fallback-breaks-delivery-contract] realpath ölçüm arızasında oturum ATLANIR, ham yola düşülmez", async () => {
  const { root } = fakeRoot();
  const store = openStore(":memory:");
  const seen: Turn[] = [];

  const sum = await scanOnce(store, {
    adapter: claudeCodeAdapter,
    root,
    identityProbe: { realpath: () => Promise.reject(errno("EACCES")), stat: realProbe.stat },
    onTurns: ({ turns }) => void seen.push(...turns),
  });

  // DAVRANIŞ: hiçbir teslimat yapılmadı ve hiçbir imleç yazılmadı. Eski hâl
  // ham yola düşüp turn'ü teslim ediyor ve o ham yolu anahtar olarak
  // yazıyordu — aynı akış gerçek yolla ikinci kez teslim edilebilirdi.
  assert.equal(seen.length, 0, "kimlik ölçülemeden teslimat yapılmamalı");
  assert.equal(sum.turns, 0);
  assert.equal(sum.sessionErrors, 1);

  const ev = listEvents(store, { kind: "cursor_identity_failed", limit: 5 });
  assert.equal(ev.length, 1);
  const d = JSON.parse(ev[0]!.detail ?? "{}") as { probe: string; code: string; missing: boolean };
  assert.equal(d.probe, "realpath");
  assert.equal(d.code, "EACCES");
  assert.equal(d.missing, false, "ölçüm arızası 'dosya yok' ile karıştırılmamalı");
  store.close();
});

test("[silent-fallback-breaks-delivery-contract] atlanan oturum SONRAKİ taramada tam teslim edilir (en-az-bir-kez korunur)", async () => {
  const { root } = fakeRoot("kritik-turn");
  const storePath = join(tmpDir(), "s.db");

  const store = openStore(storePath);
  let fail = true;
  const seen: string[] = [];
  const probe: IdentityProbe = {
    realpath: (p) => (fail ? Promise.reject(errno("EIO")) : realProbe.realpath(p)),
    stat: realProbe.stat,
  };

  await scanOnce(store, {
    adapter: claudeCodeAdapter, root, identityProbe: probe,
    onTurns: ({ turns }) => void seen.push(...turns.map((t) => t.text)),
  });
  assert.equal(seen.length, 0, "arıza turunda teslimat yok");

  // Arıza geçti: aynı baytlar BAŞTAN okunur, çünkü imleç ilerlemedi.
  fail = false;
  await scanOnce(store, {
    adapter: claudeCodeAdapter, root, identityProbe: probe,
    onTurns: ({ turns }) => void seen.push(...turns.map((t) => t.text)),
  });
  assert.deepEqual(seen, ["kritik-turn"], "ertelenen teslimat kaybolmamalı");
  store.close();
});

test("[silent-fallback-breaks-delivery-contract] stat arızasında AKIŞ BAŞTAN yeniden teslim edilmez", async () => {
  // En somut mükerrer-teslimat yolu buydu: gerçek yol imleç tablosunda yoksa
  // sabit-bağ araması yapılıyor; `stat` düşünce "kayıtlı değil" varsayılıyor,
  // `from` 0 oluyor ve akışın TAMAMI yeniden gönderiliyordu.
  const root = tmpDir();
  const dir = join(root, "-tmp-proje-f");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sess-1.jsonl");
  writeFileSync(file, userLine("bir", "/tmp/proje-f") + userLine("iki"));

  const store = openStore(":memory:");
  const deliveries: string[][] = [];

  // 1. tur: normal. İmleç GERÇEK yol anahtarıyla yazılır.
  await scanOnce(store, {
    adapter: claudeCodeAdapter, root,
    onTurns: ({ turns }) => void deliveries.push(turns.map((t) => t.text)),
  });
  assert.deepEqual(deliveries, [["bir", "iki"]]);

  // 2. tur: realpath BAŞKA bir ada çözülüyor (sembolik bağ etkisi taklidi), yani
  // imleç yol anahtarıyla bulunamıyor; inode araması ise arızalı.
  writeFileSync(file, userLine("bir", "/tmp/proje-f") + userLine("iki") + userLine("uc"));
  const sum = await scanOnce(store, {
    adapter: claudeCodeAdapter, root,
    identityProbe: {
      realpath: () => Promise.resolve(join(dir, "baska-ad.jsonl")),
      stat: () => Promise.reject(errno("EPERM")),
    },
    onTurns: ({ turns }) => void deliveries.push(turns.map((t) => t.text)),
  });

  assert.equal(deliveries.length, 1, "kimlik ölçülemezken akış BAŞTAN teslim edilmemeli");
  assert.equal(sum.sessionErrors, 1);
  const d = JSON.parse(listEvents(store, { kind: "cursor_identity_failed", limit: 1 })[0]!.detail ?? "{}") as
    { probe: string; code: string };
  assert.equal(d.probe, "stat");
  assert.equal(d.code, "EPERM");
  store.close();
});

test("[silent-fallback-breaks-delivery-contract] arıza taramanın tamamını öldürmez", async () => {
  const root = tmpDir();
  for (const [key, cwd] of [["-tmp-a", "/tmp/a"], ["-tmp-b", "/tmp/b"]] as const) {
    mkdirSync(join(root, key), { recursive: true });
    writeFileSync(join(root, key, "s.jsonl"), userLine("veri", cwd));
  }
  const store = openStore(":memory:");
  const sum = await scanOnce(store, {
    adapter: claudeCodeAdapter,
    root,
    identityProbe: {
      realpath: (p) => (p.includes("-tmp-a") ? Promise.reject(errno("ELOOP")) : realProbe.realpath(p)),
      stat: realProbe.stat,
    },
  });
  assert.equal(sum.turns, 1, "sağlam projenin turn'ü işlenmeli");
  assert.equal(sum.sessionErrors, 1);
  assert.equal(countEvents(store, "scan_completed"), 1);
  store.close();
});

test("[silent-fallback-breaks-delivery-contract] sağlam yolda imleç hâlâ GERÇEK yolla yazılıyor", async () => {
  // Düzeltme kimlik sözleşmesini zayıflatmamalı: arıza yokken davranış aynı.
  const { root, file } = fakeRoot();
  const store = openStore(":memory:");
  await scanOnce(store, { adapter: claudeCodeAdapter, root });
  const real = statSync(file).ino;
  // Anahtar ÇÖZÜLMÜŞ yoldur, ham yol değil (scan.ts'teki kimlik sözleşmesi).
  // macOS'ta bu ayrım görünür: mkdtemp `/var/...` verir, realpath `/private/var/...`.
  // Ham yolla aramak testi ürün doğruyken kırıyordu — ölçüldü, 14 Ağu.
  const cursor = getCursor(store, realpathSync(file));
  assert.ok(cursor, "imleç gerçek yol anahtarıyla bulunmalı");
  assert.equal(cursor!.inode, String(real));
  store.close();
});

// --- class: errno-lost-in-cwd-probe (adapters/claude-code.ts) ---

test("[errno-lost-in-cwd-probe] okunamayan transcript ile cwd'siz transcript AYRI görünür", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root her dosyayı okuyabilir; EACCES üretilemez");

  const root = tmpDir();
  // Proje 1: dosya var ama okunamıyor (izin) → read_failed + errno.
  const kapali = join(root, "-tmp-kapali");
  mkdirSync(kapali, { recursive: true });
  const gizli = join(kapali, "s.jsonl");
  writeFileSync(gizli, userLine("veri", "/tmp/kapali"));
  chmodSync(gizli, 0o000);

  // Proje 2: dosya okunuyor ama cwd alanı yok → ARIZA DEĞİL, olay yazılmamalı.
  const cwdsiz = join(root, "-tmp-cwdsiz");
  mkdirSync(cwdsiz, { recursive: true });
  writeFileSync(join(cwdsiz, "s.jsonl"), userLine("veri"));

  const store = openStore(":memory:");
  try {
    await scanOnce(store, { adapter: claudeCodeAdapter, root });

    const evs = listEvents(store, { kind: "cwd_probe_failed", limit: 10 });
    assert.equal(evs.length, 1, "yalnız OKUNAMAYAN proje için arıza kaydı düşmeli");
    const d = JSON.parse(evs[0]!.detail ?? "{}") as {
      transcriptDir: string;
      probes: { outcome: string; code: string; error: string }[];
    };
    assert.ok(d.transcriptDir.endsWith("-tmp-kapali"));
    assert.equal(d.probes[0]!.outcome, "read_failed");
    assert.equal(d.probes[0]!.code, "EACCES", "errno sağ kalmalı");
    assert.match(d.probes[0]!.error, /EACCES/);
  } finally {
    chmodSync(gizli, 0o600); // temizlik: after() hook'u silebilsin
    store.close();
  }
});

test("[errno-lost-in-cwd-probe] bozuk JSONL 'cwd yok'tan ayrı sınıflanır", async () => {
  const root = tmpDir();
  const dir = join(root, "-tmp-bozuk-f");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), "{bu json degil\n{yine degil\n");

  const store = openStore(":memory:");
  await scanOnce(store, { adapter: claudeCodeAdapter, root });

  const evs = listEvents(store, { kind: "cwd_probe_failed", limit: 5 });
  assert.equal(evs.length, 1);
  const d = JSON.parse(evs[0]!.detail ?? "{}") as { probes: { outcome: string; malformedLines: number }[] };
  assert.equal(d.probes[0]!.outcome, "malformed");
  assert.equal(d.probes[0]!.malformedLines, 2, "bozuk satırlar sayılmalı");
  store.close();
});

test("[errno-lost-in-cwd-probe] çözülemeyen proje kaydı SEBEBİ taşır", async () => {
  const root = tmpDir();
  // Anahtar tahmini de tutmasın diye var olmayan bir yola çözülen anahtar.
  const dir = join(root, "-yok-boyle-bir-yol-f9x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), userLine("veri")); // cwd YOK

  const store = openStore(":memory:");
  const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root });
  assert.equal(sum.unresolvedProjects, 1);

  const d = JSON.parse(listEvents(store, { kind: "unresolved_project_key", limit: 1 })[0]!.detail ?? "{}") as
    { probes: { outcome: string }[] };
  assert.equal(d.probes.length, 1, "hangi oturumun neden yetmediği kayıtta olmalı");
  assert.equal(d.probes[0]!.outcome, "no_cwd");
  store.close();
});

test("[errno-lost-in-cwd-probe] readCwdDetailed sayaçları doğru; readCwd sözleşmesi bozulmadı", async () => {
  const dir = tmpDir();
  const f = join(dir, "a.jsonl");
  writeFileSync(f, "bozuk\n" + userLine("veri", "/tmp/x"));
  const r = await readCwdDetailed(f);
  assert.equal(r.cwd, "/tmp/x");
  assert.equal(r.malformedLines, 1);
  assert.equal(r.scannedLines, 2);

  const g = join(dir, "b.jsonl");
  writeFileSync(g, userLine("veri")); // newline'lı, cwd'siz
  const r2 = await readCwdDetailed(g);
  assert.equal(r2.cwd, null);
  assert.equal(r2.malformedLines, 0);
  assert.equal(r2.scannedLines, 1);

  // Okuma arızası artık YUTULMUYOR: fırlar, sınıflandırma çağırana ait.
  await assert.rejects(() => readCwdDetailed(join(dir, "hic-yok.jsonl")), /ENOENT/);
});

// --- class: cleanup-clobbers-result (cli.ts / store/db.ts) ---

test("[cleanup-clobbers-result] closeQuietly kapatma hatasını YUTMAZ ama sonucu da EZMEZ", () => {
  const db = new DatabaseSync(":memory:");
  db.close();
  // Kapanmış bir DatabaseSync'te ikinci close() FIRLIYOR — `finally` içinde
  // olsaydı try bloğunun sonucunu/hatasını yerinden ederdi.
  assert.throws(() => db.close(), "mekanizma varsayımı: ikinci close fırlatır");

  const said: string[] = [];
  const ok = closeQuietly({ close: () => db.close() }, (m) => said.push(m));
  assert.equal(ok, false);
  assert.equal(said.length, 1, "ikincil hata sessizce kaybolmamalı");
  assert.match(said[0]!, /depo kapatılamadı/);
});

test("[cleanup-clobbers-result] closeQuietly `finally`de sonucu korur", () => {
  const calisan = (): string => {
    try {
      return "gerçek sonuç";
    } finally {
      closeQuietly({ close: () => { throw new Error("kapanış patladı"); } }, () => {});
    }
  };
  assert.equal(calisan(), "gerçek sonuç");

  const patlayan = (): string => {
    try {
      throw new Error("gerçek hata");
    } finally {
      closeQuietly({ close: () => { throw new Error("kapanış patladı"); } }, () => {});
    }
  };
  assert.throws(patlayan, /gerçek hata/, "ikincil hata birincil teşhisi ezmemeli");
});

test("[cleanup-clobbers-result] closeQuietly temiz yolda true döner ve susar", () => {
  const said: string[] = [];
  const store = openStore(":memory:");
  assert.equal(closeQuietly(store, (m) => said.push(m)), true);
  assert.deepEqual(said, []);
});

// --- class: unguarded-timeout-kill (adapters/codex.ts) ---
// Gerçek `codex` ÇAĞRILMIYOR (kota). Sınanan şey kaynak sözleşmesi: timeout
// yolları da `cleanupNow` ile aynı canlılık sınamasını yapıyor mu.

test("[unguarded-timeout-kill] her timeout kill'i canlılık sınamasından geçiyor", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const src = await readFile(
    fileURLToPath(new URL("../src/adapters/codex.ts", import.meta.url)), "utf8",
  );

  // `killProcessGroup(` çağrılarının HEPSİ ya isProcessAlive korumasının
  // içinde ya da fonksiyon tanımının kendisinde olmalı. Ölçüm: korumasız bir
  // çağrı, çocuk `exit` ile `close` arasındayken (ölçülen aralık ~1,1–1,4 ms)
  // geri dönüştürülmüş bir PID'nin grubuna SIGKILL atabiliyor.
  const korumasiz = src
    .split("\n")
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => /killProcessGroup\(/.test(l))
    .filter(([, l]) => !/function killProcessGroup/.test(l))
    .filter(([, l]) => !/isProcessAlive\(/.test(l))
    // Akış yolundaki karşılığı `closed` bayrağı; o da meşru bir koruma.
    .filter(([, l]) => !/closed/.test(l));

  assert.deepEqual(
    korumasiz.map(([n]) => n),
    [],
    `korumasız killProcessGroup çağrısı: satır ${korumasiz.map(([n]) => n).join(", ")}`,
  );
});

// --- class: unknown-item-keys-uncounted (observer/prompt.ts) ---

test("[unknown-item-keys-uncounted] tanınmayan madde anahtarları yutulur ama SAYILIR", () => {
  const res = parseObserverOutput(JSON.stringify({
    findings: [
      { content: "a", anchors: [], confidence: 0.9, kind: "decision" },
      { content: "b", anchors: [], confidence: 0.4 },
    ],
  }));
  assert.equal(res.ok, true);
  assert.ok(res.ok);
  assert.equal(res.items.length, 2, "süs alan partiyi REDDETMEMELİ (gevşetme değil, ölçülmüş karar)");
  assert.equal(res.unknownItemKeys, 3);
  assert.deepEqual(res.unknownItemKeyNames, ["confidence", "kind"]);
});

test("[unknown-item-keys-uncounted] temiz şemada sayaç sıfır", () => {
  const res = parseObserverOutput(JSON.stringify({
    findings: [{ content: "a", anchors: [{ kind: "file_path", value: "src/a.ts" }], supersedes: null }],
  }));
  assert.ok(res.ok);
  assert.equal(res.unknownItemKeys, 0);
  assert.deepEqual(res.unknownItemKeyNames, []);
});

test("[unknown-item-keys-uncounted] ad listesi TAVANLI, sayı tavansız", () => {
  const sus: Record<string, number> = {};
  for (let i = 0; i < 30; i++) sus[`x${String(i).padStart(2, "0")}`] = i;
  const res = parseObserverOutput(JSON.stringify({ findings: [{ content: "a", anchors: [], ...sus }] }));
  assert.ok(res.ok);
  assert.equal(res.unknownItemKeys, 30, "sayı kırpılmamalı");
  assert.equal(res.unknownItemKeyNames.length, 10, "ad listesi events şişmesini önlemek için tavanlı");
});
