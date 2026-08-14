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
import { createCodexExecutor } from "../src/adapters/codex.ts";
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

// GÜNCELLENDİ (doğrulama turu, 14 Ağu — sınıf: persistent-identity-starvation):
// bu iki test eskiden "realpath arızası → HİÇ teslimat" davranışını sabitliyordu.
// O davranış takası yanlış tarafa kaydırıyordu: sürekli realpath arızası
// (EIO) olan ama dosyası okunabilen bir oturum HER taramada atlanıyor, yani
// mükerrer teslimat yerine sürekli TESLİMATSIZLIK oluşuyordu. Yeni sözleşme:
// kimlik iki ölçümden birinden kurulabilir; atlama ancak İKİSİ de düşerse.
// (Mükerrer teslimatı önleyen şey inode indeksi — aşağıda ayrıca sınanıyor.)

test("[persistent-identity-starvation] realpath arızasında kimlik inode'dan kurulur, teslimat DURMAZ", async () => {
  const { root, file } = fakeRoot();
  const store = openStore(":memory:");
  const seen: Turn[] = [];

  const sum = await scanOnce(store, {
    adapter: claudeCodeAdapter,
    root,
    identityProbe: { realpath: () => Promise.reject(errno("EACCES")), stat: realProbe.stat },
    onTurns: ({ turns }) => void seen.push(...turns),
  });

  assert.equal(seen.length, 1, "okunabilir bir oturum realpath yüzünden aç kalmamalı");
  assert.equal(sum.turns, 1);
  // Still counted and still written to the event log — but as a RECOVERED
  // failure. `sessionErrors` is rendered as "unreadable session" and this
  // session was read, so counting it there reported a delivery as a read
  // failure (verification round 2, 15 Aug).
  assert.equal(sum.sessionErrors, 0);
  assert.equal(sum.identityRecovered, 1);

  const ev = listEvents(store, { kind: "cursor_identity_failed", limit: 5 });
  assert.equal(ev.length, 1);
  const d = JSON.parse(ev[0]!.detail ?? "{}") as {
    probe: string; code: string; missing: boolean;
    tried: { probe: string; code: string }[]; resolved: boolean; recoveredBy: string | null;
  };
  assert.equal(d.probe, "realpath");
  assert.equal(d.code, "EACCES");
  assert.equal(d.missing, false, "ölçüm arızası 'dosya yok' ile karıştırılmamalı");
  // Hangi ölçümlerin denendiği ve sonucun ne olduğu olayda YAZILI olmalı.
  assert.deepEqual(d.tried.map((t) => t.probe), ["realpath"]);
  assert.equal(d.resolved, true);
  assert.equal(d.recoveredBy, "stat");

  // İmleç yazıldı ve inode'u taşıyor: mükerrer teslimatı önleyen indeks bu.
  const cursor = getCursor(store, file);
  assert.ok(cursor, "kimlik kurulduysa imleç de yazılmalı");
  assert.equal(cursor!.inode, String(statSync(file).ino));
  store.close();
});

test("[persistent-identity-starvation] SÜREKLİ realpath arızasında ikinci tarama AYNI turn'ü tekrar teslim etmez", async () => {
  const { root } = fakeRoot("kritik-turn");
  const storePath = join(tmpDir(), "s.db");

  const store = openStore(storePath);
  const seen: string[] = [];
  // Arıza HİÇ geçmiyor — ölçülen arıza sınıfı buydu (kalıcı EIO).
  const probe: IdentityProbe = {
    realpath: () => Promise.reject(errno("EIO")),
    stat: realProbe.stat,
  };

  for (let i = 0; i < 2; i++) {
    await scanOnce(store, {
      adapter: claudeCodeAdapter, root, identityProbe: probe,
      onTurns: ({ turns }) => void seen.push(...turns.map((t) => t.text)),
    });
  }
  assert.deepEqual(seen, ["kritik-turn"], "ilk taramada teslim, ikincisinde TEKRAR YOK");
  assert.equal(countEvents(store, "cursor_identity_failed"), 2, "her tur arıza kaydı düşmeli");
  store.close();
});

test("[persistent-identity-starvation] İKİ ölçüm de düşerse oturum atlanır ve iki deneme de kaydedilir", async () => {
  const { root } = fakeRoot();
  const store = openStore(":memory:");
  const seen: Turn[] = [];

  const sum = await scanOnce(store, {
    adapter: claudeCodeAdapter,
    root,
    identityProbe: {
      realpath: () => Promise.reject(errno("EIO")),
      stat: () => Promise.reject(errno("EACCES")),
    },
    onTurns: ({ turns }) => void seen.push(...turns),
  });

  assert.equal(seen.length, 0, "kimlik HİÇ kurulamıyorsa teslimat yapılmamalı");
  assert.equal(sum.sessionErrors, 1);
  const d = JSON.parse(listEvents(store, { kind: "cursor_identity_failed", limit: 1 })[0]!.detail ?? "{}") as
    { probe: string; tried: { probe: string; code: string }[]; resolved: boolean };
  assert.deepEqual(d.tried.map((t) => t.probe), ["realpath", "stat"], "denenen ölçümler yazılmalı");
  assert.deepEqual(d.tried.map((t) => t.code), ["EIO", "EACCES"]);
  assert.equal(d.resolved, false);
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
      // -tmp-a'da İKİ ölçüm de düşüyor → o oturum atlanır; öbürü sağlam.
      realpath: (p) => (p.includes("-tmp-a") ? Promise.reject(errno("ELOOP")) : realProbe.realpath(p)),
      stat: (p) => (p.includes("-tmp-a") ? Promise.reject(errno("ELOOP")) : realProbe.stat(p)),
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
//
// GÜNCELLENDİ (doğrulama turu, 14 Ağu — sınıf: source-text-test): bu test
// eskiden KAYNAK METNİ tarıyordu. Ölçüldü: üç korumalı çağrı bellekte
// `if (closed) killProcessGroup(...)` gibi GÜVENSİZ hâle mutasyona uğratıldığında
// metin taraması SIFIR hata verdi — yani timeout güvenliğini kanıtlamıyordu.
// Artık ölçülen şey ÇALIŞMA ZAMANI davranışı: sahte binary, gerçek zamanlama,
// `process.kill` çağrılarının gerçek dizisi.
//
// Gerçek `codex` ÇAĞRILMIYOR (kota); sahte binary geçici dizinde, sonda siliniyor.

/**
 * Testin KENDİ üst sınırı. Gerekçe: koruma güvensiz hâle mutasyona uğradığında
 * (ölçüldü, 14 Ağu) sahte binary hiç öldürülmüyor ve test ASILIYOR — süresiz
 * bir asılma "kırmızı" değil, sadece durmuş bir koşum. Sınır o hâli hızlı bir
 * BAŞARISIZLIĞA çeviriyor.
 */
const KILL_TEST_OPTS = { timeout: 15_000 };

/** `process.kill` çağrılarını kaydeder; sinyal GERÇEKTEN gönderilir. */
function recordKills(): { calls: { pid: number; signal: unknown }[]; restore: () => void } {
  const calls: { pid: number; signal: unknown }[] = [];
  const original = process.kill.bind(process);
  process.kill = ((pid: number, signal?: unknown) => {
    calls.push({ pid, signal: signal ?? "SIGTERM" });
    return original(pid, signal as never);
  }) as typeof process.kill;
  return { calls, restore: () => { process.kill = original; } };
}

/** Süresiz çalışan, stdin'i tüketen sahte binary. */
function fakeHangingBinary(dir: string, body: string): string {
  const p = join(dir, "fake-codex");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

test("[unguarded-timeout-kill] timeout GERÇEKTEN öldürüyor ve önce canlılık sınıyor", KILL_TEST_OPTS, async () => {
  const dir = tmpDir();
  // stdin'i tüket, sonra asıl: timeout'un tek çıkış yolu kill olsun.
  const binary = fakeHangingBinary(dir, "cat > /dev/null\nwhile true; do sleep 1; done");
  const rec = recordKills();
  try {
    const res = await createCodexExecutor({ binary, timeoutMs: 300 }).run({ prompt: "x" });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /zaman aşımı/, "koşum timeout ile bitmeli");

    // DAVRANIŞ 1: SIGKILL gerçekten gönderildi (mutasyon `if (closed) kill`
    // altında hiç gönderilmez ve koşum timeout'a rağmen asılı kalırdı).
    const kills = rec.calls.filter((c) => c.signal === "SIGKILL");
    assert.ok(kills.length > 0, "timeout'ta süreç grubu öldürülmeli");
    assert.ok(kills.some((c) => c.pid < 0), "grup öldürme negatif PID ile gider (torunlar)");

    // DAVRANIŞ 2: SIGKILL'den ÖNCE sinyal-0 canlılık sınaması var. Koruma
    // kaldırıldığında bu sıra kaybolur — ölçülen şey kaynak metni değil,
    // sürecin gerçekten gönderdiği sinyaller.
    const firstKill = rec.calls.findIndex((c) => c.signal === "SIGKILL");
    const probeBefore = rec.calls.slice(0, firstKill).some((c) => c.signal === 0);
    assert.ok(probeBefore, "öldürmeden önce kill(pid, 0) ile canlılık sınanmalı");
  } finally {
    rec.restore();
  }
});

test("[unguarded-timeout-kill] detect() timeout'u da aynı korumadan geçiyor", KILL_TEST_OPTS, async () => {
  const dir = tmpDir();
  const binary = fakeHangingBinary(dir, "while true; do sleep 1; done");
  const rec = recordKills();
  try {
    const d = await createCodexExecutor({ binary, detectTimeoutMs: 300 }).detect();
    assert.equal(d.found, false, "asılan --version tespiti başarısız saymalı");
    const firstKill = rec.calls.findIndex((c) => c.signal === "SIGKILL");
    assert.ok(firstKill >= 0, "detect timeout'unda da süreç öldürülmeli");
    assert.ok(
      rec.calls.slice(0, firstKill).some((c) => c.signal === 0),
      "detect yolunda da önce canlılık sınaması",
    );
  } finally {
    rec.restore();
  }
});

test("[unguarded-timeout-kill] maliyet tavanı kesmesi de aynı korumadan geçiyor", KILL_TEST_OPTS, async () => {
  const dir = tmpDir();
  // Tavanı aşacak tek bir turn.completed bas, sonra asıl.
  const binary = fakeHangingBinary(
    dir,
    `cat > /dev/null\nprintf '{"type":"turn.completed","usage":{"input_tokens":5000}}\\n'\nwhile true; do sleep 1; done`,
  );
  const rec = recordKills();
  try {
    const res = await createCodexExecutor({ binary, timeoutMs: 10_000 })
      .run({ prompt: "x", caps: { maxTotalTokens: 10 } });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /maliyet tavanı/, "koşumu bitiren karar tavan olmalı");
    const firstKill = rec.calls.findIndex((c) => c.signal === "SIGKILL");
    assert.ok(firstKill >= 0, "tavan aşımında süreç öldürülmeli");
    assert.ok(
      rec.calls.slice(0, firstKill).some((c) => c.signal === 0),
      "tavan yolunda da önce canlılık sınaması",
    );
  } finally {
    rec.restore();
  }
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
