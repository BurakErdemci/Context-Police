// M2 denetimi — B grubu: ALT SÜREÇ ve OKUMA SINIRI bulguları.
//
// Codex kırmızı takımının ürettiği ve ana ağaçta probe ile üretilen dört
// bulgunun İDDİASI burada kalıcı teste terfi ettirildi (probe repoya girmez,
// iddiası girer). Her testin başında bulgunun class'ı anılıyor.
//
// Zaman ÖLÇEN test yok: karesel davranışı gösteren probe'un iddiası, sınırın
// çalıştığını gösteren deterministik iddialara çevrildi (imleç ilerledi mi,
// satır malformed sayıldı mı, veri bozuldu mu).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexExecutor } from "../src/adapters/codex.ts";
import { readIncremental, MAX_LINE_BYTES } from "../src/adapters/claude-code.ts";
import { tmpDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Sahte binary altyapısı (kalıp executor.test.ts'ten). Açılan her dizin dosya
// sonunda silinir — bu depoda daha önce tmp sızıntısı bulgusu çıktı.
// ---------------------------------------------------------------------------

const fakeBinDirs: string[] = [];
/** Test sızdırırsa diye izlenen torun PID'ler; sonda kesin öldürülür. */
const strayPids: number[] = [];

after(() => {
  for (const pid of strayPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* zaten ölmüş — beklenen durum */
    }
  }
  for (const d of fakeBinDirs) rmSync(d, { recursive: true, force: true });
});

function fakeBinary(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-m2-exec-"));
  fakeBinDirs.push(dir);
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** -o bayrağının değerini bulan ortak sh parçası. */
const FIND_OUT = `out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done`;

const VERSION_OK = `if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi`;

/** Bir PID ölene kadar bekler; deadline'a kadar canlıysa false döner. */
async function pidOlduMu(pid: number, deadlineMs = 3000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH — süreç yok
    }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// class: undetected-stdin-delivery-failure  (codex.ts run())
// ---------------------------------------------------------------------------

test("stdin teslim hatası yutulmaz: alt süreç prompt'u okumadan 0 ile çıkarsa ok=false", async () => {
  // Bulgunun tam senaryosu: süreç stdin'i hiç okumadan çıkış 0 veriyor VE boş
  // olmayan bir çıktı dosyası bırakıyor. Eskiden EPIPE sessizce yutulduğu için
  // sonuç ok:true idi; gözlemci o yanıta dayanıp filigranı ilerletiyordu, yani
  // hiç görülmemiş turn'ler "işlenmiş" sayılıyordu.
  const bin = fakeBinary(`${VERSION_OK}
${FIND_OUT}
printf '{"findings":[]}' > "$out"
exit 0`);
  const exec = createCodexExecutor({ binary: bin });

  // Prompt boru tamponundan (64 KiB) büyük olmalı, yoksa yazım OS tamponuna
  // sığar ve teslim edilmemiş oluşu gözlemlenemez. 1 MiB fazlasıyla yeter.
  const res = await exec.run({ prompt: "x".repeat(1024 * 1024) });

  assert.equal(res.ok, false, "yarım teslim edilen prompt başarı sayılmamalı");
  assert.equal(res.output, "", "ok=false iken output MUTLAKA boş dize (executor.ts sözleşmesi)");
  assert.match(res.error!, /stdin/, "hata mesajı sebebi taşımalı");
});

test("stdin'i tümüyle okuyan alt süreçte prompt eksiksiz teslim edilir", async () => {
  // Yukarıdaki katılığın yanlış pozitif üretmediğinin kanıtı: stdin'i drenaj
  // eden süreçte hem ok=true, hem de alt sürecin saydığı bayt promptun tam boyu.
  const bin = fakeBinary(`${VERSION_OK}
${FIND_OUT}
n=$(wc -c | tr -d ' ')
printf '%s' "$n" > "$out"
exit 0`);
  const exec = createCodexExecutor({ binary: bin });

  const prompt = "y".repeat(1024 * 1024);
  const res = await exec.run({ prompt });

  assert.equal(res.ok, true, res.error ?? "");
  assert.equal(res.output.trim(), String(Buffer.byteLength(prompt, "utf8")), "prompt tam teslim edilmeli");
});

// ---------------------------------------------------------------------------
// class: orphaned-descendant-on-timeout  (codex.ts run() timeout)
// ---------------------------------------------------------------------------

test("zaman aşımı yalnız çocuğu değil TÜM süreç grubunu öldürür (torunlar kalmaz)", async () => {
  // Eskiden timeout doğrudan çocuğa SIGKILL yolluyordu; codex'in başlattığı
  // torun süreçler yaşamaya devam edip tekrarlanan zehirli partilerde birikiyordu.
  const work = tmpDir("cp-m2-torun-");
  const pidFile = join(work, "torun.pid");
  const bin = fakeBinary(`${VERSION_OK}
${FIND_OUT}
# Torun: kendi başına yaşayan, uzun ömürlü bir alt süreç.
( while : ; do sleep 1; done ) &
echo $! > "${pidFile}"
sleep 60`);

  // Zaman aşımı bol tutuldu ve torunun PID'si run() BİTMEDEN bekleniyor:
  // 400 ms ile yazıldığında tüm takım paralel koşarken sahte sh süreci o süreye
  // sığmıyor ve test "torun hiç başlamadı" diye kırılıyordu (yük duyarlılığı,
  // ölçüldü). Burada beklenen şey bir süre değil bir OLAY: PID dosyasının varlığı.
  const exec = createCodexExecutor({ binary: bin, timeoutMs: 2000 });
  const calisma = exec.run({ prompt: "x" });

  const torunPid = await new Promise<number>((resolve, reject) => {
    const bitis = Date.now() + 1800;
    const bak = () => {
      if (existsSync(pidFile)) {
        const p = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isInteger(p) && p > 0) return resolve(p);
      }
      if (Date.now() > bitis) return reject(new Error("sahte binary torunu başlatamadı — test bir şey kanıtlamaz"));
      setTimeout(bak, 20);
    };
    bak();
  });

  const res = await calisma;
  assert.equal(res.ok, false);
  assert.match(res.error!, /zaman aşımı/);

  strayPids.push(torunPid);

  assert.ok(
    await pidOlduMu(torunPid),
    `torun süreç ${torunPid} zaman aşımından sonra hâlâ yaşıyor — süreç grubu öldürülmemiş`,
  );
});

// ---------------------------------------------------------------------------
// class: unbounded-executor-detection / unbounded-dependency-detection
// (codex.ts detect() — iki bağımsız lane aynı bulguyu üretti)
// ---------------------------------------------------------------------------

test("detect() asılan --version'da zaman aşımına düşer, sonsuza kadar beklemez", async () => {
  // Bulgu: detect()'te hiç timeout yoktu. PATH'teki codex asılırsa `observe`
  // komutu daha başlamadan K2 kapısında kilitleniyordu.
  const bin = fakeBinary(`sleep 60`);
  const exec = createCodexExecutor({ binary: bin, detectTimeoutMs: 300 });

  const det = await exec.detect();

  assert.equal(det.found, false);
  assert.match(det.error!, /zaman aşımı/);
});

test("detect() zaman aşımı parti timeout'undan AYRI: kısa timeoutMs sürüm sorgusunu kesmez", async () => {
  // Sürüm sorgusu saniyeler sürmez, ama parti sınırıyla aynı kefeye konursa
  // ya çok uzun (180 sn kilit) ya da çok kısa (yanlış "bulunamadı") olur.
  // Burada parti sınırı 50 ms; sürüm sorgusu ondan uzun sürüyor ve YİNE de
  // başarılı olmalı, çünkü detect kendi (10 sn) varsayılanını kullanıyor.
  const bin = fakeBinary(`if [ "$1" = "--version" ]; then sleep 0.4; echo "codex-cli 9.9.9"; exit 0; fi
sleep 60`);
  const exec = createCodexExecutor({ binary: bin, timeoutMs: 50 });

  const det = await exec.detect();

  assert.deepEqual(det, { found: true, version: "9.9.9" });
});

// ---------------------------------------------------------------------------
// class: unbounded-line-buffering  (claude-code.ts readIncremental)
// ---------------------------------------------------------------------------

test("okuma sınırı: gerçek verideki en büyük satır boyutu (1,54 MiB) hâlâ sorunsuz okunur", async () => {
  // Sınır seçilmeden önce gerçek transcript'ler ölçüldü (11 Ağu 2026,
  // ~/.claude/projects, 542 MB): en uzun satır 1.610.098 bayt. Sınır bunun
  // ~5,2 katı. Bu test sınırın gerçek verinin ÜSTÜNDE kaldığını sabitliyor —
  // sınırı düşüren biri veri kaybettirdiğini burada görür.
  const OLCULEN_EN_BUYUK_GERCEK_SATIR = 1_610_098;
  assert.ok(
    MAX_LINE_BYTES > OLCULEN_EN_BUYUK_GERCEK_SATIR,
    "sınır gerçek verideki en büyük satırın altına düşürülmüş — veri kaybı",
  );

  const dir = tmpDir("cp-m2-satir-");
  const f = join(dir, "s.jsonl");
  // Satırın kendisi ölçülen boyuta yakın olsun: 1,5 MiB'lik metin bloğu.
  const buyukMetin = "ö".repeat(750_000); // UTF-8'de 2 bayt/karakter → ~1,5 MB
  writeFileSync(
    f,
    JSON.stringify({ type: "user", uuid: "u1", message: { content: [{ type: "text", text: buyukMetin }] } }) + "\n",
  );

  const r = await readIncremental(f, 0);

  assert.equal(r.counts.malformed, 0, "gerçek boyuttaki satır malformed sayılmamalı");
  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0]!.text.length, buyukMetin.length, "büyük satır bozulmadan birleştirilmeli");
});

test("okuma sınırı: sınırı aşan satır malformed sayılır, atlanır ve İMLEÇ İLERLER", async () => {
  // Bulgunun asıl zararı sadece CPU değil ilerlememekti: imleç dev satırın
  // başında kaldığı için maliyet HER taramada yeniden ödeniyordu. Sınırın işi
  // o satırı görünür biçimde (malformed sayacı → scan.ts'te `malformed_line`
  // olayı) düşürüp imleci ilerletmek. Sessiz kayıp yok.
  const dir = tmpDir("cp-m2-asiri-");
  const f = join(dir, "s.jsonl");
  const once = JSON.stringify({ type: "user", uuid: "a", message: { content: "önce" } });
  const devSatir = '{"type":"user","message":{"content":"' + "z".repeat(MAX_LINE_BYTES + 1024) + '"}}';
  const sonra = JSON.stringify({ type: "user", uuid: "b", message: { content: "sonra" } });
  writeFileSync(f, `${once}\n${devSatir}\n${sonra}\n`);

  const r = await readIncremental(f, 0);

  assert.equal(r.counts.malformed, 1, "aşırı satır malformed olarak SAYILMALI (sessiz kayıp olmaz)");
  assert.deepEqual(
    r.turns.map((t) => t.uuid),
    ["a", "b"],
    "aşırı satırın komşuları normal işlenmeli",
  );
  assert.equal(r.byteOffset, statSync(f).size, "imleç dosyanın sonuna kadar ilerlemeli");
});

test("okuma sınırı: sonlanmamış aşırı satırda imleç satırın BAŞINDA kalır", async () => {
  // Yarım satır hiçbir zaman işlenmez (spec §3.3) — sınır bu sözleşmeyi
  // değiştirmiyor. Aşırı uzun ve henüz "\n" görmemiş bir satır için de imleç
  // satırın başında bırakılır; parçalar biriktirilmediği için bellek sınırlı.
  const dir = tmpDir("cp-m2-yarim-");
  const f = join(dir, "s.jsonl");
  const once = JSON.stringify({ type: "user", uuid: "a", message: { content: "önce" } });
  const oncekiBayt = Buffer.byteLength(once, "utf8") + 1;
  writeFileSync(f, `${once}\n` + "z".repeat(MAX_LINE_BYTES + 1024)); // sonda "\n" YOK

  const r = await readIncremental(f, 0);

  assert.equal(r.turns.length, 1);
  assert.equal(r.counts.malformed, 0, "satır henüz tamamlanmadı — daha malformed değil");
  assert.equal(r.byteOffset, oncekiBayt, "imleç tamamlanmamış satırın başında kalmalı");
});

test("doğrusal biriktirme: chunk sınırına denk gelen çok baytlı UTF-8 bozulmaz", async () => {
  // Biriktirme yeniden yazıldığı için (tek Buffer.concat, parça listesi) chunk
  // sınırı davranışı yeniden sabitleniyor: akış 64 KiB'lık parçalar veriyor ve
  // 4 baytlık bir karakter tam o sınıra denk gelirse metin bozulmamalı.
  const dir = tmpDir("cp-m2-utf8-");
  const f = join(dir, "s.jsonl");
  // Emoji'yi 64 KiB sınırına oturt: JSON zarfı + dolgu ile tam hizala.
  const zarfOncesi = '{"type":"user","uuid":"a","message":{"content":"';
  const dolgu = "a".repeat(64 * 1024 - Buffer.byteLength(zarfOncesi, "utf8") - 2);
  const metin = dolgu + "🐙" + "b".repeat(100);
  writeFileSync(f, JSON.stringify({ type: "user", uuid: "a", message: { content: metin } }) + "\n");

  const r = await readIncremental(f, 0);

  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0]!.text, metin, "chunk sınırındaki çok baytlı karakter bozulmamalı");
});

test("doğrusal biriktirme: birden çok chunk'a yayılan satırda parça sırası korunur", async () => {
  // Parça listesi + tek concat'e geçişte en olası hata sıra/kayıp hatası olurdu
  // ve bu SESSİZ olurdu (JSON yine parse edilebilir, metin yanlış olurdu).
  // Bu yüzden içerik bayt bayt karşılaştırılıyor, uzunluk değil.
  const dir = tmpDir("cp-m2-parca-");
  const f = join(dir, "s.jsonl");
  // Her 1 KiB'da farklı bir damga → herhangi bir yer değiştirme yakalanır.
  const bloklar: string[] = [];
  for (let i = 0; i < 400; i++) bloklar.push(`[${i}]` + "-".repeat(1021 - String(i).length));
  const metin = bloklar.join("");
  writeFileSync(f, JSON.stringify({ type: "assistant", uuid: "z", message: { content: metin } }) + "\n");

  const r = await readIncremental(f, 0);

  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0]!.text, metin, "çok parçalı satır sırasıyla birleştirilmeli");
});
