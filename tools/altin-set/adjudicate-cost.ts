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
  decideCompleteness, appendTail, cleanupCommand, validateRoot, validateNoteName, validateOutPath,
  buildPrompt, adjudicatorSchema, authorshipBound, purgeStaleArtifacts,
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
// Not adları da yol bileşeni oluyor (girdi `<notlar>/<not>.md`, ham çıktı
// `<cikti>.<not>.raw.jsonl`) — kökle AYNI kalıpla, işe başlamadan önce
// doğrulanıyorlar. Reddetme sessiz değil: hangi ad neden reddedildi yazılıyor.
const badNames = notes.map((n) => [n, validateNoteName(n)] as const)
  .filter((pair): pair is readonly [string, { ok: false; reason: string }] => !pair[1].ok);
if (badNames.length > 0) {
  for (const [, check] of badNames) console.error(`not adı reddedildi: ${check.reason}`);
  process.exit(2);
}
// Çıktı yolu da doğrulanıyor — `note` ile AYNI sınıfın öbür yarısı: ondan üç
// yol türetiliyor (sonuç JSONL'i, `<outPath>.<not>.raw.jsonl`, ve
// `incomplete/<basename(outPath)>...`). Bkz. validateOutPath.
const outCheck = validateOutPath(outPathArg);
if (!outCheck.ok) {
  console.error(`çıktı yolu reddedildi: ${outCheck.reason}`);
  process.exit(2);
}
// Kapıdan sonra tipi `string`e sabitle: daralma kapanışların (one()) içine
// taşınmıyor, `string | undefined` olarak görülüyordu.
const notesDir: string = notesDirArg;
const outPath: string = outCheck.path;

// Çıktı şeması hakemin iddia düzeyindeki hükmünü kısıtlar; `adjudicate-lib`de,
// çünkü `dogustan-yanlis`in ne zaman kullanılabilir olduğu bir SÖZLEŞME kararı
// (bkz. M4.2 bloğu) ve test edilebilir bir yerde durmalı. Not başına iki
// biçimden biri seçiliyor: notun yazılma zamanı ölçülebiliyorsa hüküm açık.

type Cap = { kind: "time" | "items" | "tokens"; limit: number; observed: number };

/**
 * Ayrıştırıcının BEKLEDİĞİ olay adları; dışındaki her ad ŞEMA KAYMASI sayılır.
 * Ürünle (`core/src/adapters/codex.ts:217`) aynı küme — araç ürünün göreceği
 * akışı ölçmeli, kendi genişletilmiş kümesini değil.
 */
const KNOWN_EVENT_TYPES = new Set(["item.completed", "turn.completed"]);

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

/**
 * Süreç HÂLÂ yaşıyor mu? `kill(pid, 0)` sinyal göndermez, yalnız varlığı sınar.
 *
 * Bulgu (M4.1 üçüncü dalga, stale-process-group-registration): bu fonksiyon
 * dosyada zaten VARDI ama yalnız `leaked_pid` raporunda kullanılıyordu; sinyal
 * temizliği (cleanupNow) defterdeki her PID'yi KOŞULSUZ öldürüyordu. Oysa
 * defterden düşüş `finish()` içinde, yani `close`'da — çocuk ondan ÖNCE ölüyor.
 * Ölçüldü (bu dalga, probe1-stale-group.sh): pencere normalde ~0,67 ms, ama
 * çocuğun TORUNU stdout borusunu açık tutuyorsa `close` saniyelerce gecikiyor
 * ve kayıt o boyunca bayat kalıyor. O aralıkta gelen bir SIGINT, işletim
 * sisteminin GERİ DÖNÜŞTÜRDÜĞÜ bir PID'nin grubuna SIGKILL atabilir.
 */
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

/**
 * Sinyal işleyicisi senkron olmak zorunda: süreç kapanmadan önce bitmeli.
 *
 * NEDEN ÜRÜNÜN KALIBI BİREBİR KOPYALANIYOR (`core/src/adapters/codex.ts:137`,
 * `if (isProcessAlive(pid)) killProcessGroup(pid)`): buradaki karar bir ölçüm
 * tercihi değil, SİNYAL GÜVENLİĞİ kararı — "hangi süreci öldürmek meşru"
 * sorusunun cevabı araçta ve üründe farklı olamaz. Yukarıdaki killProcessGroup
 * notunda gerekçelenen araç/ürün kopya ayrımı davranışın ÖLÇÜM tarafı içindi
 * (araç ürünün iç API'sine bağlanmasın); alt süreç öldürmenin doğru kalıbı ise
 * ortak bir emniyet ilkesi ve ıraksaması, ürün tarafında kapatılan bir bulgunun
 * araçta açık kalması demek. Kopya, import değil: bağımlılık yönü korunuyor.
 *
 * İki fark, ikisi de bilinçli:
 *   - ÖNCE canlılık sınanıyor (yukarıdaki isAlive notu): bayat kayıt geri
 *     dönüştürülmüş bir PID'yi gösterebilir.
 *   - `killHard` DEĞİL `killProcessGroup` çağrılıyor: killHard grup denemesi
 *     BAŞARILI olsa bile ayrıca düz PID'yi de vuruyor, yani sinyal yüzeyi
 *     ürünün iki katı. killHard'ın geniş yüzeyi `retryKill` için var — orada
 *     ilk denemenin TUTMADIĞI ölçülmüş bir olgu (adjudicate-kill-failure-leaks),
 *     burada ise öyle bir kanıt yok.
 */
function cleanupNow(): void {
  for (const pid of liveGroups) if (isAlive(pid)) killProcessGroup(pid);
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
  unparsedLines: number;
  unknownEvents: number;
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
    // ŞEMA KAYMASI SAYAÇLARI (bulgu: silent-stream-schema-drift).
    //
    // Davranış değişmiyor — bu satırlar eskiden de atlanıyordu; değişen tek şey
    // atlamanın GÖRÜNÜR olması. Neden bu araçta kritik: bu dosyanın bütün
    // varlık sebebi hakemin TAVAN kararını beslemek, ve tavan kararının girdisi
    // (`usage`, `items`, `turns`, `claims`) tek tek bu ayrıştırıcıdan geliyor.
    // Yükseltilen bir codex sürümü olay adlarını ya da satır biçimini
    // değiştirirse ayrıştırıcı sessizce hiçbir şey görmez: maliyet ölçümü
    // SIFIRA düşer, `--max-tokens` tavanı hiç ateşlenmez ve 28 notluk koşumun
    // manşet sayısı — "tam sweep kaç token" — yanlış çıkar. Yanlış çıktığı da
    // hiçbir yerde belli olmaz, çünkü "akış gelmedi" ile "akış geldi ama
    // anlaşılmadı" aynı boş sonuca düşüyordu. Sayaçlar tam bu ayrımı yapıyor.
    let unparsedLines = 0;
    let unknownEvents = 0;
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
      // `{` ile başlamayan satır sayaca GİRMİYOR — ürünle bilinçli parite
      // (codex.ts:245). Gerçek akışta ilerleme/uyarı satırları düz metin
      // geliyor; onları kayma saymak sayacı normal koşumda da doldurur ve
      // sinyal olmaktan çıkarırdı.
      if (!s.startsWith("{")) return;
      // Ayrıştırma HATASI ile olay işleme hatası ayrı tutuluyor: eskiden tek
      // `try` her ikisini de yutuyordu, o yüzden hangisinin olduğu bilinemezdi.
      let o: {
        type?: unknown;
        usage?: Record<string, unknown>;
        item?: { type?: unknown; text?: unknown; content?: unknown };
      };
      try {
        o = JSON.parse(s);
      } catch {
        unparsedLines++;
        return; // bozuk/yarım satır ölçümü düşürmez, yalnız sayılır
      }
      const type = typeof o?.type === "string" ? o.type : "";
      // TANINMAYAN OLAY: ayrıştırıldı ama adı beklenen kümede değil. `usage`
      // taşımayan `turn.completed` tanınan bir olaydır (ürünle aynı ayrım) —
      // sayaca yalnız adını hiç bilmediğimiz olay girer.
      if (!KNOWN_EVENT_TYPES.has(type)) {
        unknownEvents++;
        return; // ölçümü değiştirmeyen satır tavanı da değiştiremez
      }
      if (type === "turn.completed") {
        turns++;
        if (o.usage) usage = addUsage(usage, o.usage);
      }
      if (type === "item.completed") {
        items++;
        // Son mesaj metin olarak geliyor; şemalı çıktı o metnin İÇİNDE
        // JSON. Olayın kendisini JSON.stringify edip "verdict" saymak
        // kaçırıyordu (kaçış karakterleri) — metni ayrıca ayrıştır.
        const rawTxt = o.item?.text ?? o.item?.content;
        const txt = typeof rawTxt === "string" ? rawTxt : "";
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
        const isMessage = txt.length > 0 && o.item?.type !== "reasoning";
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
        unparsedLines, unknownEvents,
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
// İki şema dosyası önden yazılıyor; not başına biri seçiliyor (bkz. one()).
const schemaPaths = {
  open: join(tmp, "schema-born-wrong-open.json"),
  gated: join(tmp, "schema-born-wrong-gated.json"),
};
writeFileSync(schemaPaths.open, JSON.stringify(adjudicatorSchema({ bornWrongAvailable: true })));
writeFileSync(schemaPaths.gated, JSON.stringify(adjudicatorSchema({ bornWrongAvailable: false })));

// Eksik hamların yeri: çıktı dosyasının dizini altında `incomplete/`.
const incompleteDir = join(dirname(outPath), "incomplete");
mkdirSync(incompleteDir, { recursive: true });
// ÇIKTIYI SIFIRLAMAK ARTEFAKTLARI SİLMEZ, ve bu araç kapı ölçümünü yapan araç:
// bayat ham dosyalar kalırsa 28 notluk koşum iki koşumu karıştırır. Kardeş
// koşucuda (`adjudicate-opencode.ts`) 15 Ağu'da düzeltilmişti, burada açık
// kalmıştı — aynı sınıfın iki dosyada ayrışması, fonksiyonun artık `lib`de
// tek nüsha durmasının sebebi. Temizlik sıfırlamayla AYNI adımda (CLAUDE.md §3).
const purged = purgeStaleArtifacts([dirname(outPath), incompleteDir], `${basename(outPath)}.`);
writeFileSync(outPath, "");
// Sessiz silme bu projede bulgu: kaç dosya gittiği ölçülebilir kalsın.
console.error(`bayat artefakt silindi: ${purged}`);
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
  // Şema ile istem AYNI kaynaktan karar alıyor: notun yazılma zamanı gövdeden
  // çıkarılabiliyorsa `dogustan-yanlis` her ikisinde de açık, çıkarılamıyorsa
  // her ikisinde de kapalı.
  const bornWrongAvailable = authorshipBound(body) !== null;
  const r = await runCodex(
    buildPrompt(note, body, evidence),
    bornWrongAvailable ? schemaPaths.open : schemaPaths.gated,
  );
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
    // The raw output is written UNGATED, so whoever applies the gate later
    // (flatten.ts) must know which branch ran. Recomputing it from the note body
    // gets the other branch once the body changes, and `gateClaims(..., false)`
    // then rewrites real `dogustan-yanlis` verdicts into `olculemez` — targets
    // vanish from the scored file with no error anywhere. Recorded as a fact so
    // it cannot be re-derived wrongly.
    born_wrong_available: bornWrongAvailable,
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
    // ŞEMA KAYMASI SAYAÇLARI (bulgu: silent-stream-schema-drift).
    // Burada 0 UYDURMA DEĞİL, ölçümün kendisi: ayrıştırıcı bu koşumda gerçekten
    // koştu ve sıfır bozuk satır/tanınmayan olay gördü. Ayrıştırıcının HİÇ
    // koşmadığı tek yol işçi istisnası satırı — orada bu alanlar `null`
    // (aşağıdaki catch). Ürün (`ExecutorUsage`) aynı ayrımı alanın YOKLUĞUYLA
    // yapıyor; burada satır şeması sabit olduğu için `null` ile yapılıyor.
    unparsed_lines: r.unparsedLines,
    unknown_events: r.unknownEvents,
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
    // Kayma sessiz kalmasın: kalıcı satırda zaten var, ama operatör koşumu
    // izlerken de görmeli — kalibrasyon kararı bu sayılara bakılarak veriliyor.
    (r.unparsedLines > 0 || r.unknownEvents > 0
      ? `  ŞEMA KAYMASI (bozuk satır ${r.unparsedLines}, tanınmayan olay ${r.unknownEvents})`
      : "") +
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
            // The exception can precede the body read, so the branch was never
            // measured. `false` would assert "the gate was closed"; null says
            // "unknown", matching the other unmeasured fields on this row.
            born_wrong_available: null,
            cap: null, olculemez: true, claims_complete: false, parse_failed: false,
            items: 0, turns: 0,
            // Ayrıştırıcı HİÇ koşmadı → ölçüm yok. 0 yazmak "sıfır kayma
            // ölçtüm" derdi; doğrusu "ölçemedim".
            unparsed_lines: null, unknown_events: null,
            kill_failed: false, leaked_pid: null,
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
