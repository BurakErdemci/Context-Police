// Hakem çağrısının MALİYETİNİ ölçer — ve bunu yaparken hakemin ilk
// prototipini koşturur.
//
// Neden var: 13 Ağu'da kapı kaldırıldı ("skor sıralar, hepsi hakeme gider").
// O karar ölçülmemiş bir varsayıma dayanıyor: 28 notluk tam tarama
// kaldırılabilir. Bu araç o varsayımı sınar.
//
// NEDEN CODEX, Claude değil: ürünün tek yürütücüsü Codex
// (`cli.ts:264` → `createCodexExecutor`). Claude üzerinden ölçmek, ürünün
// hiçbir zaman koşmayacağı bir şeyi ölçmek olurdu.
//
// NEDEN --json: `codex exec -o` yalnız son mesajı yazıyor; token sayacı
// yalnız `--json` olay akışındaki `turn.completed.usage` alanında. Bugünkü
// adaptör `-o` kullanıyor, yani ürün şu an kendi maliyetini GÖREMİYOR
// (`ExecutorResult` token taşımıyor). Bu, kapı yeniden tasarlanırken
// kapatılması gereken bir boşluk.
//
// EKSİK ÇIKTI SÖZLEŞMESİ (skor hattı bunu bilmek zorunda):
// Bir notun şemalı iddia kümesi okunamadıysa çıktı EKSİKTİR. İki sebebi var
// ve satırdaki alanlarla ayırt edilir:
//   - TAVAN KESMESİ  → `cap != null` (süre/item; küme yarım kaldı)
//   - BİÇİM ARIZASI  → `parse_failed: true` (koşum kesilmedi, cap yok, rc=0;
//                      cevap kurtarma katmanına rağmen okunamadı)
// Her iki hâlde de `olculemez: true` — hüküm yok, çünkü okunamadı.
// O notun KISMİ iddiaları skorlayıcıya giden claims dosyasına GİRMEZ.
// Sebep: `score.ts` yalnız "kapsanan" notları puanlıyor ve kapsamayı hakem
// çıktısında notun görünmesinden çıkarıyor. Kısmi iddialar girerse not
// "denetlendi" sayılır, kesildiği için göremediği hedef iddialar da kaçırılmış
// sayılır — yakalama oranı SESSİZCE düşer ve düşüşün sebebi hakemin
// kalitesiymiş gibi görünür. Kısmi çıktı dışarıda kalırsa not
// "denetlenmeyen" listesinde raporlanır; bu doğru semantik.
// Mekanizma (YAPISAL, ad kuralına dayanmıyor): tam çıktının ham akışı çıktı
// dosyasının yanına `<cikti>.<not>.raw.jsonl` olarak, EKSİK olanınki ayrı bir
// alt dizine — `<cikti-dizini>/incomplete/<cikti-adı>.<not>.raw.jsonl` —
// yazılır. Ayrım dizin düzeyinde olduğu için `*.raw*` gibi gevşek bir glob
// bile eksiklere ULAŞAMAZ; önceki ad-eki çözümünde (`.raw.incomplete.jsonl`)
// böyle bir glob sözleşmeyi sessizce bozuyordu.
// Biçim pürüzü tek başına notu düşürmez: kod çiti (```json) ve birden çok
// item'a bölünmüş küme için kurtarma katmanı var (bkz. adjudicate-lib.ts:parseClaimsCount).
// Ölçüt tavanın TÜRÜ değil çıktının TAMLIĞI: token tavanı post-hoc
// ateşlendiği için çoğu zaman TAM bir çıktının üstüne biner, o koşum
// `olculemez` sayılmaz (satırda yalnız `cap` raporlanır).
//
// Kullanım:
//   node --experimental-strip-types tools/altin-set/adjudicate-cost.ts \
//     [--evidence] [--parallel N] [--timeout-sec 600] [--max-items 100] \
//     [--max-tokens 2000000] <worktree> <notlar-dizini> <cikti.jsonl> <not> [<not> ...]

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { parseNote, extractAnchors } from "../../core/src/importer/parse.ts";
import { openGit } from "../../core/src/signals/git.ts";
import { checkAnchors } from "../../core/src/signals/anchor-drift.ts";
import { evidenceFor } from "./evidence-block.ts";
// Kararlar (tamlık, kök doğrulaması, usage toplamı) test edilebilsin diye
// kardeş modülde; bu dosya import edildiği anda argv ayrıştırıp çıkıyor.
import {
  type Usage, addUsage, totalTokens,
  decideCompleteness, appendTail, cleanupCommand, validateRoot,
} from "./adjudicate-lib.ts";

// --evidence: mekanik katmanın ZATEN ölçtüğü çapa kanıtını isteme koyar.
// 13 Ağu ölçümü maliyetin keşif turlarından geldiğini gösterdi; bu bayrak o
// keşfin ne kadarının gereksiz olduğunu ölçmek için var.
const argvAll = process.argv.slice(2);
const WITH_EVIDENCE = argvAll.includes("--evidence");
// Değer alan bayraklar tek yerde: pozisyonel ayıklayıcı bunların DEĞERİNİ de
// atlamak zorunda, yoksa `--timeout-sec 30` içindeki 30 not adı sanılıyor.
const VALUE_FLAGS = new Set(["--parallel", "--timeout-sec", "--max-items", "--max-tokens"]);
function numFlag(name: string, dflt: number): number {
  const i = argvAll.indexOf(name);
  if (i === -1) return dflt;
  const v = Number(argvAll[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
// Paralellik yalnız DUVAR SAATİ için. Ölçülen token/süre değerleri çağrı
// başına olduğu için paralellik onları bozmuyor; yalnız toplam bekleme kısalıyor.
const PARALLEL = Math.max(1, numFlag("--parallel", 1));
// Kesme eksenleri. Gerçek `codex exec --json` akışında `turn.completed` koşum
// başına BİR kez, en sonda geliyor — yani tur tavanı akış ORTASINDA
// ateşlenemez; token sayacı da yalnız o olayda taşındığı için token tavanı
// fiilen post-hoc bir rapor (aşımı görür, kesmeyi kurtarmaz). Akış sürerken
// gerçekten kesebilen iki eksen kalıyor: item sayısı ve duvar saati.
const TIMEOUT_SEC = numFlag("--timeout-sec", 600);
// 100: KALİBRE EDİLMEMİŞ tahmin. 28 notluk koşumda gözlenen item dağılımına
// göre ayarlanacak.
const MAX_ITEMS = numFlag("--max-items", 100);
const MAX_TOKENS = numFlag("--max-tokens", 2_000_000); // USAGE_FIELDS toplamı (bkz. totalTokens)
const positional = argvAll.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argvAll[i - 1] ?? ""));
const [wtArg, notesDirArg, outPathArg, ...notes] = positional;
if (!wtArg || !notesDirArg || !outPathArg || notes.length === 0) {
  console.error("kullanım: adjudicate-cost.ts [--evidence] [--parallel N] [--timeout-sec S] [--max-items N] [--max-tokens N] <worktree> <notlar> <cikti.jsonl> <not>...");
  process.exit(2);
}
// Kök, alt sürecin `-C` değeri olmadan ÖNCE doğrulanır (bkz. validateRoot).
const rootCheck = validateRoot(wtArg);
if (!rootCheck.ok) {
  console.error(`kök argümanı reddedildi: ${rootCheck.reason}`);
  process.exit(2);
}
const wt = rootCheck.root;
// Kapıdan sonra tipi `string`e sabitle: daralma kapanışların (one()) içine
// taşınmıyor, `string | undefined` olarak görülüyordu.
const notesDir: string = notesDirArg;
const outPath: string = outPathArg;

// Çıktı şeması: hakem iddia düzeyinde hüküm verir. Altın setin şemasıyla
// aynı hüküm kümesi — yoksa doğruluk ölçülemez.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "line_start", "line_end", "verdict", "evidence"],
        properties: {
          text: { type: "string" },
          line_start: { type: "integer" },
          line_end: { type: "integer" },
          verdict: { enum: ["gecerli", "curuk", "dogustan-yanlis", "olculemez"] },
          evidence: { type: "string" },
        },
      },
    },
  },
};

// ÇERÇEVE (CLAUDE.md §2.1): ölçüm görevi, hatırlama görevi değil. Modele
// "bu not doğru mu" diye sorulmuyor; "diske karşı ÖLÇ" deniyor. Emir kipiyle
// "kır / saldır" da yok — o dil sağlayıcı reddine yol açıyor
// (codex-cyberpolicy-reddi, 11 Ağu ölçümü).
function buildPrompt(note: string, body: string, evidence: string | null): string {
  const ev = evidence
    ? `\n--- ÖNCEDEN ÖLÇÜLMÜŞ KANIT (mekanik katman, aynı commit) ---\n${evidence}\n--- KANIT SONU ---\n\nBu kanıt zaten ölçüldü; yeniden ölçme. Yalnız kanıtın YETMEDİĞİ yerlerde depoya bak.\n`
    : "";
  return `Bir yazılım deposunun kök dizinindesin. Depo \`b4065f1\` commit'ine sabitlenmiş.

Aşağıda o depoya ait bir hafıza notu var. Görevin bu notu OKUMAK değil, ÖLÇMEK:
notun her doğrulanabilir iddiasının bu commit'te geçerli olup olmadığını
depodan tespit et.

Yöntem: dosyaları oku, \`git log\`/\`git show\`/\`git ls-files\` çalıştır.
Hükmü koddan çıkar, notun kendi anlatısından değil. Not bir şeyin var
olduğunu söylüyorsa bak; olmadığını söylüyorsa yine bak.

Her iddia için hüküm:
- gecerli          : bu commit'te doğru
- curuk            : yazıldığında doğruydu, bu commit'te yanlış
- dogustan-yanlis  : yazıldığı an da yanlıştı (kod hiç öyle olmamış)
- olculemez        : depoya karşı doğrulanamaz (dış servis, ağ, kullanıcı
                     beyanı, tarihsel anlatı). Bu ONURLU bir cevap —
                     ölçemediğin şeye hüküm verme.

SAYIM İDDİALARINI ATLAMA. Not bir sayı veriyorsa ("X.py 1682 satır",
"45 kayıtlı araç var", "3 test geçiyor", "8 sağlayıcı yolu") o sayıyı KOŞTUR
ve karşılaştır: \`wc -l\`, \`git grep -c\`, \`git ls-files | wc -l\`. Ölçülen
kaçtı, notta kaç yazıyor, ikisini de evidence'a yaz. (Ölçüldü: hakemin
kaçırdığı iddiaların hepsi bu sınıftandı.)

Notun HER doğrulanabilir ifadesini kapsa — yalnız dikkat çekenleri değil.

\`evidence\` alanına ölçtüğün somut şeyi yaz: SHA, dosya yolu, sembol adı,
sayı. Özet yargı değil.

\`line_start\`/\`line_end\`, iddianın notun kaçıncı satırlarından geldiği
(1'den başlayarak, aşağıdaki gövdeye göre).

Ölçüm bütçesi: hiçbir komut 60 saniyeyi geçmesin, arka planda süreç bırakma.

${ev}
--- NOT: ${note}.md ---
${body}
--- NOT SONU ---`;
}

type Cap = { kind: "time" | "items" | "tokens"; limit: number; observed: number };

// SIGKILL'den sonra çekirdeğin süreci toplaması milisaniyeler sürer; 5 sn
// cömert bir üst sınır. Bu süre dolduysa kill GERÇEKTEN tutmamıştır.
const KILL_GRACE_MS = 5_000;

/**
 * Süreç GRUBUNU öldürür, olmazsa tekil PID'ye düşer.
 *
 * Bu, ürünün `core/src/adapters/codex.ts:killProcessGroup` kalıbının BİLİNÇLİ
 * bir kopyası. Import edilmiyor: bu bir ölçüm aracı ve araç/ürün ayrımı
 * korunuyor — araç ürünün iç API'sine bağlanırsa ürün ölçüm aracının
 * ihtiyaçlarına göre şekillenmeye başlıyor. Kopyanın bedeli: kalıp
 * değişirse iki yerde değişir.
 *
 * Negatif PID tüm gruba sinyal gönderir (spawn `detached:true` sayesinde
 * pgid == child.pid); codex'in torunları böylece geride kalmıyor. POSIX dışı
 * platformda ilk deneme hata verir ve tekil PID'ye düşülür.
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid == null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* zaten ölmüş */ }
  }
}

/**
 * İKİNCİ deneme: grup VE düz PID, ilki hata vermese bile.
 *
 * Bulgu (M4.1, adjudicate-kill-failure-leaks): `killProcessGroup` düz PID'ye
 * yalnız grup denemesi İSTİSNA fırlattığında düşüyor. Sinyalin gönderildiği
 * ama teslim edilmediği hâlde (izin sorunu, D durumundaki süreç) fallback hiç
 * denenmiyordu ve tek denemeden sonra süreç sahipsiz kalıyordu.
 */
function killHard(pid: number | undefined): void {
  if (pid == null) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* grup yok */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* zaten ölmüş */ }
}

function isAlive(pid: number | undefined): boolean {
  if (pid == null) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/*
 * --- Sinyal temizliği ---------------------------------------------------
 *
 * Bulgu (M4.1, adjudicate-parent-signal-leaks): temizlik yalnız normal akışa
 * bağlıydı. Node varsayılanında SIGINT/SIGTERM süreci doğrudan sonlandırıyor —
 * hiçbir kapanış kodu koşmuyor — ve geride detached bir codex süreç grubu ile
 * bir `adj-*` dizini kalıyordu. CLAUDE.md §3: yaratan her adımın kapanışında
 * silen adım zorunlu.
 *
 * Bu blok ürünün `core/src/adapters/codex.ts` kalıbının BİLİNÇLİ bir kopyası
 * (import edilmiyor; araç/ürün ayrımı yukarıdaki killProcessGroup notunda
 * gerekçelendirildi).
 *
 * ÇÖZÜLEMEYEN kısım: SIGKILL. Orada kullanıcı kodu çalışmaz; artıklar bilerek
 * kabul ediliyor.
 */
const liveTempDirs = new Set<string>();
const liveGroups = new Set<number>();

/** Sinyal işleyicisi senkron olmak zorunda: süreç kapanmadan önce bitmeli. */
function cleanupNow(): void {
  for (const pid of liveGroups) killHard(pid);
  liveGroups.clear();
  for (const dir of liveTempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* silinemiyorsa geç */ }
  }
  liveTempDirs.clear();
}

const FATAL_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function onFatalSignal(sig: NodeJS.Signals): void {
  cleanupNow();
  for (const [s, h] of signalHandlers) process.removeListener(s, h);
  signalHandlers.clear();
  // Bir dinleyici EKLEMEK Node'un varsayılan sonlandırmasını iptal ediyor;
  // kimse kalmadıysa varsayılanı geri getir, yoksa Ctrl-C süreci ASARDI.
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}

function installSignalHandlers(): void {
  if (signalHandlers.size > 0) return;
  for (const sig of FATAL_SIGNALS) {
    const h = () => onFatalSignal(sig);
    signalHandlers.set(sig, h);
    process.prependListener(sig, h);
  }
}

function runCodex(prompt: string, schemaPath: string): Promise<{
  rc: number;
  usage: Usage | null;
  ms: number;
  claims: number;
  raw: string;
  cap: Cap | null;
  items: number;
  turns: number;
  claimsComplete: boolean;
  killFailed: boolean;
  leakedPid: number | null;
  cleanupCmd: string | null;
  stderrTail: string;
}> {
  return new Promise((resolve) => {
    const args = [
      "exec", "--ephemeral", "--skip-git-repo-check", "--color", "never",
      "-s", "read-only",          // K9: hakem diske YAZMAZ; okumaya ve komut koşturmaya izin var
      "-C", wt,                   // araçlı hakem: çalışma kökü depo (executor.ts:20 bunu öngörmüştü)
      "--output-schema", schemaPath,
      "--json", "-",
    ];
    const t0 = Date.now();
    // detached: çocuk kendi süreç grubunun lideri olur; kesme torunları da
    // kapsasın diye (bkz. killProcessGroup). unref YOK — çıktıyı bekliyoruz.
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    // Sinyal defterine YAZ: Ctrl-C geldiğinde bu grup öldürülsün (bkz. cleanupNow).
    if (child.pid != null) liveGroups.add(child.pid);
    installSignalHandlers();
    let out = "";
    // Alt sürecin stderr KUYRUĞU. Eskiden `on("data", () => {})` ile tümüyle
    // atılıyordu: codex hata verdiğinde satırda yalnız `rc` kalıyor, SEBEP
    // hiçbir yere gitmiyordu (M4.1, adjudicate-stderr-discarded).
    let stderrTail = "";
    let pending = "";       // satır tamponu: bir olay iki chunk'a bölünebilir
    let usage: Usage | null = null;
    let claims = 0;
    let items = 0;
    let turns = 0;
    // Şemalı iddia kümesi EKSİKSİZ ayrıştırıldı mı. Bu bayrak `olculemez`
    // hükmünün tek ölçütü: tavan türü değil ÇIKTININ TAMLIĞI belirler.
    // Yalnız katı JSON.parse başarısı sayılır — regex'le "verdict" saymak
    // yarım kesilmiş bir metinde de sayı üretir, yani tamlık kanıtı değildir.
    // Hüküm akış sırasında DEĞİL `finish` içinde veriliyor (oradaki nota bak).
    let claimsComplete = false;
    // İddia taşıyan MESAJ item'larının metinleri sırayla. Reasoning item'ları
    // buraya girmez. Tamlık hükmü bu listenin sonuncusundan, tutmazsa sıralı
    // birleşiminden çıkarılır (finish içinde).
    const verdictTexts: string[] = [];
    let lastItemIsMessage = false;
    let cap: Cap | null = null;
    // Süreç kapandıktan SONRA kill YASAK: PID'yi işletim sistemi geri
    // dönüştürmüş olabilir ve kill(-pid) alakasız bir grubu vurur. Gerçek yol:
    // close handler'ının içinde tampondaki son (yeni-satırsız) satır işleniyor
    // ve o satır tavanı aşabiliyor. Aşım yine raporlanır, yalnız kill atlanır.
    let closed = false;
    let killedAt: number | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let settled = false;

    // Öldürme + EMNİYET ZAMANLAYICISI. İki kill denemesi de tutmazsa (izin
    // sorunu, D durumunda takılı süreç) `close` HİÇ gelmez; paralel modda tek
    // asılı işçi Promise.all'u kilitler ve 28 notluk koşum sonsuza kadar
    // bekler. O yüzden kill'den sonra kısa bir süre beklenir, gelmezse sonuç
    // satırı `kill_failed` + sızan PID ile yazılıp promise çözülür — koşum
    // devam eder, temizlik el ile yapılabilsin diye PID kayda geçer.
    function kill(): void {
      if (closed || killedAt !== null) return; // kapandıysa PID geri dönüşümü riski (aşağıdaki not)
      killedAt = Date.now();
      killProcessGroup(child.pid);
      const grace = setTimeout(retryKill, KILL_GRACE_MS);
      grace.unref(); // ilk beklemede süreç kapanışını geciktirme
      graceTimer = grace;
    }

    // İKİNCİ deneme. Bulgu (M4.1, adjudicate-kill-failure-leaks): tek denemeden
    // sonra `unref` + `leaked_pid` yazıp çıkmak, temizliği tümüyle operatörün o
    // satırı OKUMASINA bağlıyordu. Şimdi grup VE düz PID bir kez daha
    // denenir, ikinci bir grace beklenir (bu sefer `unref` YOK: sahiplik
    // temizlik bitene kadar bırakılmıyor), sonra hâlâ canlıysa kopyalanabilir
    // temizlik komutu hem konsola hem kalıcı satıra basılır.
    function retryKill(): void {
      if (settled) return;
      killHard(child.pid);
      graceTimer = setTimeout(() => finish(-1, { killFailed: true }), KILL_GRACE_MS);
    }

    function checkCaps(): void {
      if (cap) return; // ilk aşım kazanır
      if (usage && totalTokens(usage) > MAX_TOKENS) {
        cap = { kind: "tokens", limit: MAX_TOKENS, observed: totalTokens(usage) };
      } else if (items > MAX_ITEMS) {
        cap = { kind: "items", limit: MAX_ITEMS, observed: items };
      } else return;
      kill();
    }

    function handleLine(line: string): void {
      const s = line.trim();
      if (!s.startsWith("{")) return;
      try {
        const o = JSON.parse(s);
        if (o.type === "turn.completed") {
          turns++;
          if (o.usage) usage = addUsage(usage, o.usage);
        }
        if (o.type === "item.completed") {
          items++;
          // Son mesaj metin olarak geliyor; şemalı çıktı o metnin İÇİNDE
          // JSON. Olayın kendisini JSON.stringify edip "verdict" saymak
          // kaçırıyordu (kaçış karakterleri) — metni ayrıca ayrıştır.
          const txt = o.item?.text ?? o.item?.content ?? "";
          // AKIL YÜRÜTME METNİ VERİ DEĞİLDİR. Prompt çıktı şemasını tarif
          // ettiği için modelin reasoning'inde biçimi örnekleyen çitli bir
          // blok görülebiliyor; o blok tamlık kanıtı sayılırsa SONRADAN
          // tavanla kesilen bir koşum "tam" damgası alıp kısmi iddialarını
          // skor hattına sızdırıyor (ölçüldü, fix turu 2 review'ı) — yani
          // sözleşmenin engellemek için var olduğu sessiz deflasyon geri
          // geliyor. Bu yüzden reasoning item'ları kurtarmaya HİÇ girmiyor.
          //
          // ADAY SÜZGECİ METİN SEZGİSİ DEĞİL: eskiden `txt.includes("verdict")`
          // aranıyordu; şemaya uygun `{"claims":[]}` o anahtarı taşımadığı için
          // aday bile olamıyor ve `parse_failed` damgası yiyordu (M4.1,
          // adjudicate-empty-claims-rejected). Aday = reasoning OLMAYAN, metni
          // boş olmayan item; tamlık hükmünü yalnız yapısal ayrıştırma veriyor
          // (adjudicate-lib.ts:decideCompleteness).
          const isMessage =
            typeof txt === "string" && txt.length > 0 && o.item?.type !== "reasoning";
          // Akışın SON item'ı böyle bir mesaj mı: tamlık kanıtının ön koşulu
          // (decideCompleteness'taki guard). Her item.completed'da yeniden
          // yazılıyor, yani "en son ne geldi" bilgisi taze kalıyor.
          lastItemIsMessage = isMessage;
          if (isMessage) {
            verdictTexts.push(txt);
            // Tamlık kanıtı DEĞİL: yarım metinde de sayı üretir. Yalnız
            // "kaç iddia görünüyor" bilgisi için. Hüküm `finish`te veriliyor.
            const m = txt.match(/"verdict"/g);
            if (m) claims = Math.max(claims, m.length);
          }
        }
      } catch { /* akışta JSON olmayan satırlar olabilir */ }
      checkCaps();
    }

    const timer = setTimeout(() => {
      if (!cap) cap = { kind: "time", limit: TIMEOUT_SEC, observed: Math.round((Date.now() - t0) / 1000) };
      kill();
    }, TIMEOUT_SEC * 1000);

    child.stdout.setEncoding("utf8"); // çok baytlı karakter chunk sınırında bölünmesin
    child.stdout.on("data", (d: string) => {
      out += d;
      pending += d;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const l of parts) handleLine(l);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => { stderrTail = appendTail(stderrTail, d); });
    // Süreç tavanla öldürüldüğünde prompt yazımı EPIPE ile patlıyor; ölçüm
    // aracının o notu kaybetmesine değil, cap'li satır yazmasına ihtiyaç var.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    function finish(rc: number, opts?: { killFailed?: boolean }): void {
      if (settled) return; // emniyet zamanlayıcısı ile geç gelen close yarışabilir
      settled = true;
      closed = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (pending) handleLine(pending);
      // TAMLIK HÜKMÜ BURADA VERİLİR, akış sırasında değil: "akıştaki herhangi
      // bir item parse edilebildi" ölçütü, kesilmeden ÖNCE gelen bir ara
      // mesajı tam çıktı sayıyordu.
      //
      // GUARD: kanıt yalnız akışın SON `item.completed`'ından kabul edilir.
      // Ölçülmüş dayanak (14 Ağu json-probe): gerçek `codex exec --json`
      // akışında son item.completed final `agent_message`'ın kendisi;
      // ondan sonra yalnız `turn.completed` geliyor — o bir item DEĞİL.
      // Tek örneklem olduğu için HATA YÖNÜ BİLİNÇLİ SEÇİLDİ: akış ileride
      // mesaj-dışı bir item'la biterse not GÜRÜLTÜLÜ şekilde `olculemez`
      // olur (görülür ve düzeltilir), sessizce sızmaz.
      const verdict = decideCompleteness(verdictTexts, lastItemIsMessage);
      claimsComplete = verdict.complete;
      if (verdict.complete) claims = Math.max(claims, verdict.claims);
      let leakedPid: number | null = null;
      let cleanupCmd: string | null = null;
      if (opts?.killFailed) {
        // İki kill denemesi de tutmadı. Süreç hâlâ yaşıyorsa sahipliği
        // bırakıyoruz (koşum devam etmeli, bkz. kill()'deki not) ama
        // operatörün elinde KOPYALANABİLİR bir komut kalsın.
        if (isAlive(child.pid) && child.pid != null) {
          leakedPid = child.pid;
          cleanupCmd = cleanupCommand(child.pid);
        }
        // Süreç hâlâ yaşıyor ve borularımıza yazmaya devam edebilir; Node'un
        // çıkışını engellememesi için event loop'tan çıkar.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      // Sinyal defterinden düş: bu grubun sahibi artık bu koşum değil (sızan
      // PID'de de öyle — Ctrl-C'de öldürmeyi denemek PID geri dönüşümü riski).
      if (child.pid != null) liveGroups.delete(child.pid);
      resolve({
        rc, usage, ms: Date.now() - t0, claims, raw: out, cap, items, turns,
        claimsComplete,
        killFailed: opts?.killFailed === true,
        leakedPid,
        cleanupCmd,
        stderrTail,
      });
    }
    child.on("error", () => finish(-1));
    child.on("close", (rc) => finish(rc ?? -1));
  });
}

const gitCtx = WITH_EVIDENCE ? await openGit(wt, { fetch: false, originRef: "19c623f" }) : null;
if (WITH_EVIDENCE && !gitCtx) { console.error("git bağlamı açılamadı"); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), "adj-"));
// Yaratıldığı satırda temizliğe KAYDEDİLİYOR (CLAUDE.md §3): Ctrl-C'de
// cleanupNow bu dizini siler, normal kapanışta aşağıdaki `finally` siler.
liveTempDirs.add(tmp);
installSignalHandlers();
const schemaPath = join(tmp, "schema.json");
writeFileSync(schemaPath, JSON.stringify(SCHEMA));

writeFileSync(outPath, "");
// Eksik hamların yeri: çıktı dosyasının dizini altında `incomplete/`.
const incompleteDir = join(dirname(outPath), "incomplete");
mkdirSync(incompleteDir, { recursive: true });
console.log("not".padEnd(36) + "satır  süre(sn)  girdi   önbellek  önb-yaz  çıktı  akıl   iddia");
console.log("─".repeat(88));

/** Tek yazma noktası: her satır buradan geçer, hiçbir sonuç konsolda kalmaz. */
function appendRow(row: Record<string, unknown>): void {
  appendFileSync(outPath, JSON.stringify(row) + "\n");
}

async function one(note: string): Promise<void> {
  const body = readFileSync(join(notesDir, `${note}.md`), "utf8");
  const lines = body.split("\n").length;
  let evidence: string | null = null;
  if (WITH_EVIDENCE) {
    const { anchors } = extractAnchors(body);
    const verdicts = await checkAnchors(gitCtx!, anchors, new Date(0).toISOString());
    evidence = evidenceFor(verdicts);
  }
  const r = await runCodex(buildPrompt(note, body, evidence), schemaPath);
  // Ham akışın YERİ hükme göre değişiyor: tam çıktılar çıktı dosyasının
  // yanında, eksikler AYRI BİR ALT DİZİNDE (`incomplete/`). Ad eki yerine
  // dizin, çünkü ayrım YAPISAL olmalı: `*.raw*` gibi gevşek bir glob bile
  // alt dizine inemez (bkz. dosya başındaki "EKSİK ÇIKTI SÖZLEŞMESİ").
  // Kanıt atılmıyor, yalnız skor hattının erişemeyeceği yere konuyor.
  const rawPath = r.claimsComplete
    ? `${outPath}.${note}.raw.jsonl`
    : join(incompleteDir, `${basename(outPath)}.${note}.raw.jsonl`);
  writeFileSync(rawPath, r.raw);
  const parseFailed = !r.claimsComplete && r.cap === null && r.rc === 0;
  const u = r.usage ?? {};
  appendRow({
    note, lines, rc: r.rc, ms: r.ms, evidence_fed: WITH_EVIDENCE,
    // Bu satır bir İŞÇİ İSTİSNASI satırı değil (bkz. aşağıdaki catch).
    worker_error: null,
    // ÖLÇÜT TAVAN TÜRÜ DEĞİL, ÇIKTININ TAMLIĞI. Token tavanı post-hoc
    // ateşleniyor: şemalı iddia kümesi çoktan eksiksiz gelmiş olabilir. Öyle
    // bir koşumu `olculemez` saymak TAM ölçülmüş bir notu çöpe atardı —
    // maliyet aşımı raporlanır (`cap` yazılır) ama veri korunur.
    cap: r.cap,
    olculemez: !r.claimsComplete,
    claims_complete: r.claimsComplete,
    // Eksik çıktının İKİ sebebi var ve ayırt edilmeleri şart: tavan kesmesi
    // (`cap != null`) ile BİÇİM ARIZASI. İkincisi koşum hiç kesilmediği hâlde
    // (cap yok, rc=0) çıktının okunamamasıdır — tavan kalibrasyonuyla değil
    // kurtarma katmanıyla ilgilenir, o yüzden ayrı alan.
    parse_failed: parseFailed,
    // `--max-items` tahminini kalibre edecek veri: usage'dan BAĞIMSIZ
    // sayaçlar, çünkü zaman kesmesinde `turn.completed` hiç gelmiyor ve
    // usage null kalıyor.
    items: r.items,
    turns: r.turns,
    kill_failed: r.killFailed,
    leaked_pid: r.leakedPid,
    // Sızan süreç için operatörün kopyalayacağı komut; kalıcı satıra da girer
    // ki temizlik konsol kaydırma tamponunun ömrüne bağlı kalmasın.
    cleanup_command: r.cleanupCmd,
    // Alt sürecin hata SEBEBİ. Eskiden stderr tümüyle atılıyordu ve satırda
    // yalnız `rc` kalıyordu — "codex neden 1 döndü" sorusu cevapsızdı.
    stderr_tail: r.stderrTail === "" ? null : r.stderrTail,
    input_tokens: u.input_tokens ?? null,
    cached_input_tokens: u.cached_input_tokens ?? null,
    cache_write_input_tokens: u.cache_write_input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    reasoning_output_tokens: u.reasoning_output_tokens ?? null,
    claims: r.claims,
  });
  console.log(
    note.padEnd(36) + String(lines).padStart(5) + String((r.ms / 1000).toFixed(0)).padStart(9) +
    String(u.input_tokens ?? "-").padStart(8) + String(u.cached_input_tokens ?? "-").padStart(10) +
    String(u.cache_write_input_tokens ?? "-").padStart(9) +
    String(u.output_tokens ?? "-").padStart(7) + String(u.reasoning_output_tokens ?? "-").padStart(7) +
    String(r.claims).padStart(7) + (r.rc === 0 ? "" : `  rc=${r.rc}`) +
    (r.cap ? `  CAP ${r.cap.kind} ${r.cap.observed}/${r.cap.limit}` : "") +
    (r.claimsComplete ? "" : `  ${parseFailed ? "PARSE ARIZASI" : "EKSİK ÇIKTI"} → olculemez`) +
    (r.killFailed ? `  KILL BAŞARISIZ (sızan pid ${r.leakedPid})` : "") +
    (r.rc !== 0 && r.stderrTail ? `  stderr: ${r.stderrTail.trim()}` : ""),
  );
  if (r.cleanupCmd) console.log(`  ↳ elle temizlik:  ${r.cleanupCmd}`);
}

const queue = [...notes];
try {
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (;;) {
        const n = queue.shift();
        if (!n) return;
        try {
          await one(n);
        } catch (e) {
          // KANIT ATILMAZ. İstisna eskiden yalnız konsola yazılıyordu: not
          // sonuç JSONL'ine HİÇ girmiyor, sonraki adım "hiç koşulmamış" ile
          // "patlamış"ı ayıramıyordu (M4.1, adjudicate-worker-error-omitted).
          // Bu, dosyanın kendi `incomplete/` sözleşmesiyle çelişiyordu.
          // Ayırt edici işaret: `worker_error` dolu ve `rc: null` (süreç hiç
          // çıkmadı ya da hiç başlamadı).
          const msg = (e as Error).message;
          console.log(`${n.padEnd(36)}  HATA: ${msg}`);
          appendRow({
            note: n, lines: null, rc: null, ms: null, evidence_fed: WITH_EVIDENCE,
            worker_error: msg,
            cap: null, olculemez: true, claims_complete: false, parse_failed: false,
            items: 0, turns: 0, kill_failed: false, leaked_pid: null,
            cleanup_command: null, stderr_tail: null,
            input_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null,
            output_tokens: null, reasoning_output_tokens: null, claims: 0,
          });
        }
      }
    }),
  );
} finally {
  // Yaratanın kapanışı: şema dizini normal yolda burada siliniyor
  // (sinyal yolunda cleanupNow siliyor).
  liveTempDirs.delete(tmp);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* zaten yok */ }
}
console.log(`\nham kayıt: ${outPath}`);
