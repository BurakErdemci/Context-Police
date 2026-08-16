// `adjudicate-cost.ts`'in KARDEŞİ: aynı hakem işini ÜCRETSİZ bir model üzerinden
// `opencode` ile koşturur ve BAYT UYUMLU çıktı üretir.
//
// Neden ayrı dosya, ortak bir yürütücü değil: iki CLI'ın akış biçimi, kesme
// eksenleri ve ÇIKTI SÖZLEŞMESİNİ DAYATMA GÜCÜ ıraksak. `codex exec --json`
// olay adlarıyla (`item.completed`, `turn.completed`) ve koşum başına TEK bir
// usage olayıyla konuşuyor, ayrıca `--output-schema` ile biçimi ZORLUYOR;
// `opencode run --format json` adım başına (`step_finish`) usage yayıyor, metni
// ayrı `text` olaylarına bölüyor ve şema dayatan hiçbir bayrağı YOK. Ortak bir
// soyutlama iki akışın da yalnız kesişimini ölçerdi; ölçüm aracının işi tam da
// farkı görmek.
//
// SÖZLEŞME: bu aracın yazdığı artefaktlar `flatten.ts` → `score.ts` hattına
// DEĞİŞİKLİK OLMADAN girer:
//   - ham çıktı `<cikti>.<not>.raw.jsonl` (tam) / `incomplete/<taban>.<not>.raw.jsonl` (eksik),
//   - not başına satırda `note` ve `born_wrong_available` alanları,
//   - ham metin KAPISIZ (ungated) yazılır — kapıyı `flatten.ts` uyguluyor.
// Ham dosyaya modelin ASİSTAN METNİ yazılır, olay akışının tamamı değil:
// `flatten.ts` o dosyayı `extractGatedClaims` ile ayrıştırıyor ve o ayrıştırıcı
// bir JSONL olay akışının içindeki iddia kümesini bulamaz.
//
// --- NEDEN İKİ GEÇİŞ ------------------------------------------------------
//
// ÖLÇÜLDÜ (15 Ağu 2026, gerçek not `lisans-karari`, b4065f1'e sabitlenmiş
// klonda): `buildPrompt` aynen — codex'e gönderildiği hâliyle — verildiğinde
// opencode koşumu 92 saniye sürdü, rc=0, 55 olay, 20 araç çağrısı (bash/read/
// grep), maliyet 0. Model GERÇEKTEN ölçtü: git komutları koşturdu, dosya okudu,
// vardığı hükümler makuldü. AMA `extractGatedClaims` NULL döndü — cevap
// MARKDOWN TABLOSUYDU, sözleşmedeki JSON değil. Sebep yapısal: codex şemaya
// uydu çünkü şema `--output-schema` ile DAYATILMIŞTI; opencode'da öyle bir
// bayrak yok ve ücretsiz modeli biçime bağlayan hiçbir şey kalmıyor.
// Tek geçişli bir koşum bu yüzden 28 notun 28'ini `incomplete/`e yollar.
//
// ÇÖZÜM DE ÖLÇÜLDÜ: AYNI OTURUMDA ikinci bir geçiş, modelin KENDİ cevabını
// sözleşmeye çeviriyor (`--session <sessionID>`). 12-15 saniye (bağlam zaten
// önbellekte), maliyet 0, ve `extractGatedClaims` temiz ayrıştırdı — 8 iddia.
// `sessionID` pass 1 akışındaki herhangi bir olayın üst düzey alanından geliyor.
//
// TUZAK (bir probe'a mal oldu): `parseClaimsArray` üst düzeyde NESNE istiyor —
// `{"claims":[…]}`. Çıplak `[…]` dizisi isteyen bir çevirme istemi, JSON kusursuz
// olduğu hâlde NULL döndürüyor. O yüzden aşağıdaki istem nesne biçimini AÇIKÇA
// ve tekrar tekrar söylüyor.
//
// PASS 1'İN METNİ ATILMIYOR (`<cikti>.<not>.pass1.txt`): ölçüm anlatısı ve araç
// çağrıları orada. Atılırsa yanlış bir hüküm TEŞHİS EDİLEMEZ hâle gelir — kanıtı
// üreten geçiş kaybolduğu için "model neye bakarak böyle dedi" sorulamaz.
// Uzantı bilerek `.txt`: `flatten.ts` yalnız `.raw.jsonl` ile bitenleri topluyor,
// dolayısıyla bu dosya skor hattına KAZAEN giremez.
//
// ÖLÇÜLMÜŞ OPENCODE OLGULARI (1.18.16, 15 Ağu 2026) — yeniden keşfedilmesin:
//   1. `--format json` STDIN'DE BLOKLAR. stdin açık bırakılırsa çağrı süresiz
//      asılıyor (5+ dakika sıfır bayt); stdin kapalıyken aynı çağrı 6 saniyede
//      bitiyor. O yüzden `stdio[0] = "ignore"` — bu satır kozmetik değil,
//      aracın çalışmasının ön koşulu.
//   2. `--pure` ZORUNLU: onsuz kullanıcının global skill/MCP yapılandırması
//      yükleniyor (bir kişisel-hafıza skill'i probelardan birinde ateşlendi) ve
//      sabit istem yükü ~11.600 → ~4.200 girdi jetonu farkı yapıyor.
//   3. Akış JSONL: satır başına bir olay, üst düzey `type`/`timestamp`/
//      `sessionID`/`part`. `step_finish` ADIM BAŞINA gelir — jeton sayaçları
//      TOPLANIR, sonuncusu alınmaz.
//   4. Ücretsiz model her probede `cost: 0` bildirdi.
//
// ARGV BOYUTU ÖLÇÜLDÜ: en büyük altın not (`bekleyen-isler.md`, 45.439 bayt)
// için istem 49.930 bayt. macOS `ARG_MAX` = 1.048.576 ve tek argüman için ayrı
// bir üst sınır yok (500 KB'lık argümanla `spawnSync` doğrulandı, E2BIG yok).
// ~20x pay var, o yüzden istem POZİSYONEL ARGÜMAN olarak geçiyor — geçici dosya
// ya da stdin gerekmiyor. (stdin zaten kullanılamaz: bkz. olgu 1.)
//
// Kullanım:
//   node --experimental-strip-types tools/altin-set/adjudicate-opencode.ts \
//     [--evidence] [--parallel N] [--timeout-sec 600] [--model M] [--binary PATH] \
//     <worktree> <notlar-dizini> <cikti.jsonl> <not> [<not> ...]

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { extractAnchors } from "../../core/src/importer/parse.ts";
import { openGit } from "../../core/src/signals/git.ts";
import { checkAnchors } from "../../core/src/signals/anchor-drift.ts";
import { evidenceFor } from "./evidence-block.ts";
import {
  type Usage, addUsage,
  appendTail, cleanupCommand, validateRoot, validateNoteName, validateOutPath,
  buildPrompt, adjudicatorSchema, authorshipBound, extractGatedClaims, purgeStaleArtifacts,
} from "./adjudicate-lib.ts";

const argvAll = process.argv.slice(2);
const WITH_EVIDENCE = argvAll.includes("--evidence");
const VALUE_FLAGS = new Set(["--parallel", "--timeout-sec", "--model", "--binary"]);

function numFlag(name: string, dflt: number): number {
  const i = argvAll.indexOf(name);
  if (i === -1) return dflt;
  const v = Number(argvAll[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
function strFlag(name: string, dflt: string): string {
  const i = argvAll.indexOf(name);
  const v = i === -1 ? undefined : argvAll[i + 1];
  return v === undefined || v.startsWith("--") ? dflt : v;
}

const PARALLEL = Math.max(1, numFlag("--parallel", 1));
/**
 * GEÇİŞ BAŞINA süre tavanı — not başına değil.
 *
 * Ölçülen bütçe: pass 1 ~92 sn, pass 2 ~12-15 sn, not başına ~105 sn (28 notluk
 * toplu koşum ≈ 50 dakika). 600 sn geçiş başına ~6,5 kat pay demek. Tavan
 * ASILMAYI kesmek için var, tipik koşumu değil: 92 saniyelik meşru bir ölçüm
 * kesilirse araç kendi verisini yok eder ve kesildiği satırda `cap` ile
 * görünür — ama veri geri gelmez.
 */
const TIMEOUT_SEC = numFlag("--timeout-sec", 600);
// Ücretsiz model. Ad config'e bağlı ve uydurulamaz (hafıza: codex-model-kapasitesi
// — model adı tahmin edilmez), o yüzden bayrakla değiştirilebilir.
const MODEL = strFlag("--model", "opencode/deepseek-v4-flash-free");
// İkili YOL OLARAK enjekte edilebilir: testler gerçek `opencode`'u ÇAĞIRMAZ,
// kendi sahte betiklerini gösterir. PATH'e sahte ikili koymak da işe yarardı ama
// bayrak açık bir sözleşme — testin ne değiştirdiği çağrıda görünür kalıyor.
const BINARY = strFlag("--binary", "opencode");

const positional = argvAll.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argvAll[i - 1] ?? ""));
const [wtArg, notesDirArg, outPathArg, ...notes] = positional;
if (!wtArg || !notesDirArg || !outPathArg || notes.length === 0) {
  console.error("kullanım: adjudicate-opencode.ts [--evidence] [--parallel N] [--timeout-sec S] [--model M] [--binary P] <worktree> <notlar> <cikti.jsonl> <not>...");
  process.exit(2);
}
// Üç kapı da kardeş araçtakiyle AYNI: aynı yolları türetiyorlar, dolayısıyla
// aynı arıza sınıfına açıklar. Kopya değil, import.
const rootCheck = validateRoot(wtArg);
if (!rootCheck.ok) {
  console.error(`kök argümanı reddedildi: ${rootCheck.reason}`);
  process.exit(2);
}
const wt = rootCheck.root;
const badNames = notes.map((n) => [n, validateNoteName(n)] as const)
  .filter((pair): pair is readonly [string, { ok: false; reason: string }] => !pair[1].ok);
if (badNames.length > 0) {
  for (const [, check] of badNames) console.error(`not adı reddedildi: ${check.reason}`);
  process.exit(2);
}
const outCheck = validateOutPath(outPathArg);
if (!outCheck.ok) {
  console.error(`çıktı yolu reddedildi: ${outCheck.reason}`);
  process.exit(2);
}
const notesDir: string = notesDirArg;
const outPath: string = outCheck.path;

// Kardeş araçla aynı `cap` şekli. YALNIZ `time` üretiliyor: item/token tavanları
// orada MALİYETİ sınırlamak için var, bu koşumun modeli ücretsiz. Şekil yine de
// korunuyor ki iki aracın satırları aynı şemayla okunabilsin. `pass` alanı
// eklendi çünkü hangi geçişin kesildiği teşhis için ayrı bir bilgi.
type Cap = { kind: "time"; limit: number; observed: number; pass: 1 | 2 };

/** Ayrıştırıcının BEKLEDİĞİ olay adları; dışındaki her ad ŞEMA KAYMASI sayılır. */
const KNOWN_EVENT_TYPES = new Set(["step_start", "text", "tool_use", "step_finish"]);

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
 * `killProcessGroup` düz PID'ye yalnız grup denemesi İSTİSNA fırlattığında
 * düşüyor; sinyalin gönderildiği ama teslim edilmediği hâlde (izin sorunu, D
 * durumundaki süreç) fallback hiç denenmiyor. Kardeş araçta ölçülmüş bulgu
 * (M4.1, adjudicate-kill-failure-leaks).
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

// SIGKILL'den sonra çekirdeğin süreci toplaması milisaniyeler sürer; 5 sn
// cömert bir üst sınır. Bu süre dolduysa kill GERÇEKTEN tutmamıştır.
// (Kardeş araçtaki `KILL_GRACE_MS` ile aynı gerekçe ve aynı değer.)
const KILL_GRACE_MS = 5_000;

/**
 * Kesme anında `pid`'nin ALTINDA duran her süreç, geçişli olarak.
 *
 * Neden grup kill'i yetmiyor — ÖLÇÜLDÜ (15 Ağu 2026, fake-killstat probe'u):
 * `setsid()` çağıran bir torun KENDİ oturumuna geçiyor, dolayısıyla
 * `kill(-pgid)` ona ULAŞMIYOR. Çocuk 3 ms'de ölüp `close` yayıyor, torun 300
 * saniye yaşamaya devam ediyor ve satır "hiçbir şey kaçmadı" diyor. Torun grubu
 * terk etse de kesme anında PPID zinciri HÂLÂ çocuğa çıkıyor (ebeveyni ölmeden
 * önce bakıldığı için), o yüzden tek `ps` çekimi onu yakalıyor.
 *
 * `ps -Ao` bilerek: macOS'ta `-e` "ortamı da göster" demek, `-A` ise iki
 * platformda da "tüm süreçler". Ölçüm alınamazsa boş küme dönüyor — o zaman
 * yalnız grup kill'i kalır, yani eski davranış.
 */
/**
 * Descendants reachable from ONE `ps` snapshot taken before the kill.
 *
 * Known blind spot, measured by the verification round: a helper that already
 * called setsid() and was reparented away before this snapshot appears in
 * neither the process group nor this PPID tree, so it survives the kill and is
 * absent from the accounting. `kill_failed:false` therefore means "nothing in
 * the measured set survived", not "nothing survived" — the row records
 * KILL_ACCOUNTING so the number is never read as exhaustive.
 *
 * Closing it fully would mean tracking every process the subprocess ever
 * spawned, which nothing here can do for a third-party binary. Naming the
 * limit is what keeps the measurement honest.
 */
function descendantsOf(pid: number): number[] {
  const r = spawnSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const kid = Number(m[1]);
    const parent = Number(m[2]);
    if (kid === parent) continue; // kendi ebeveyni olan bir kayıt sonsuz döngü demek
    const sibs = children.get(parent);
    if (sibs) sibs.push(kid); else children.set(parent, [kid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([pid, process.pid]); // kendimizi ASLA hedef alma
  const stack = [pid];
  while (stack.length > 0) {
    for (const kid of children.get(stack.pop()!) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push(kid);
      stack.push(kid);
    }
  }
  return out;
}

/** Tek tek SIGKILL: gruptan ayrılmış torunlara ulaşmanın tek yolu. */
function killPids(pids: number[]): void {
  for (const p of pids) {
    try { process.kill(p, "SIGKILL"); } catch { /* zaten ölmüş */ }
  }
}

// Sinyal temizliği (CLAUDE.md §3): yaratan adımın kapanışı zorunlu yazılır.
// Node varsayılanında SIGINT süreci doğrudan sonlandırır ve geride detached bir
// opencode süreç grubu kalırdı. Bu araç geçici DİZİN yaratmıyor (şema isteme
// gömülü), o yüzden defterde yalnız süreç grupları var.
const liveGroups = new Set<number>();

function cleanupNow(): void {
  // Canlılık ÖNCE sınanıyor: defterden düşüş `close`'da olduğu için kayıt bir
  // süre bayat kalabiliyor ve geri dönüştürülmüş bir PID'nin grubunu vurmak
  // alakasız süreçleri öldürür (kardeş araçta ölçülmüş bir arıza sınıfı).
  for (const pid of liveGroups) if (isAlive(pid)) killProcessGroup(pid);
  liveGroups.clear();
}

const FATAL_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function onFatalSignal(sig: NodeJS.Signals): void {
  cleanupNow();
  for (const [s, h] of signalHandlers) process.removeListener(s, h);
  signalHandlers.clear();
  // Dinleyici EKLEMEK Node'un varsayılan sonlandırmasını iptal ediyor; kimse
  // kalmadıysa varsayılanı geri getir, yoksa Ctrl-C süreci ASARDI.
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

/**
 * `opencode`'un jeton alanlarını satırın (yani `codex`'in) alan adlarına çevirir.
 *
 * Alan adları UYDURULMUYOR, eşleniyor: iki koşumun satırları aynı sütunlarla
 * karşılaştırılabilmeli, yoksa "ücretsiz model ne kadar tuttu" sorusu iki ayrı
 * şemayı elle hizalamayı gerektirir. Eşleme:
 *   input → input_tokens · cache.read → cached_input_tokens
 *   cache.write → cache_write_input_tokens · output → output_tokens
 *   reasoning → reasoning_output_tokens
 * `total` bilerek DÜŞÜRÜLÜYOR: kardeş araçta böyle bir alan yok ve toplam zaten
 * parçalardan çıkarılabiliyor (bkz. totalTokens).
 */
function mapTokens(tokens: unknown): Record<string, unknown> | null {
  if (typeof tokens !== "object" || tokens === null) return null;
  const t = tokens as Record<string, unknown>;
  const cacheRaw = t.cache;
  const cache = (typeof cacheRaw === "object" && cacheRaw !== null)
    ? cacheRaw as Record<string, unknown>
    : {};
  const out: Record<string, unknown> = {};
  if (typeof t.input === "number") out.input_tokens = t.input;
  if (typeof cache.read === "number") out.cached_input_tokens = cache.read;
  if (typeof cache.write === "number") out.cache_write_input_tokens = cache.write;
  if (typeof t.output === "number") out.output_tokens = t.output;
  if (typeof t.reasoning === "number") out.reasoning_output_tokens = t.reasoning;
  return out;
}

/**
 * PASS 2'nin istemi: modelin KENDİ cevabını sözleşmeye çevirtir.
 *
 * Neden yeniden ölçüm İSTENMİYOR: pass 1 zaten ölçtü (araç çağrıları, git
 * komutları, dosya okumaları oradaydı) ve aynı oturumda duruyor. İkinci bir
 * ölçüm hem süreyi ikiye katlar hem hükmü değiştirebilir — o zaman diskteki
 * `pass1.txt` ile `raw.jsonl` farklı iki gerçekliği anlatırdı ve teşhis için
 * saklanan dosya yanıltıcı olurdu.
 *
 * Şema `adjudicatorSchema`'dan geliyor, elle yazılmıyor: kapı kararı
 * (`dogustan-yanlis` hangi koşumda kullanılabilir) istemde, şemada ve
 * ayrıştırıcıda tek kaynaktan gelmezse model istemi değil şemayı yorumlar.
 *
 * NESNE BİÇİMİ ÖLÇÜLMÜŞ BİR TUZAK: `parseClaimsArray` üst düzeyde `claims`
 * anahtarlı bir NESNE arıyor. Çıplak dizi isteyen ilk çevirme istemi kusursuz
 * JSON üretti ve ayrıştırma yine NULL döndü. O yüzden nesne biçimi burada üç
 * kez, üç ayrı cümleyle söyleniyor.
 */
function conversionPrompt(bornWrongAvailable: boolean): string {
  const schema = JSON.stringify(adjudicatorSchema({ bornWrongAvailable }), null, 2);
  return `Az önce yaptığın ölçümü şimdi makine okunur biçime çevir.

YENİDEN ÖLÇME. Yeni komut koşturma, yeni dosya okuma, hükümlerini değiştirme.
Tek iş: yukarıda zaten vardığın hükümleri aşağıdaki biçimde yaz.

Cevabın YALNIZ TEK BİR JSON NESNESİ olsun. Dizi DEĞİL, nesne: en dıştaki değer
\`{\` ile başlayıp \`}\` ile bitmeli ve tek anahtarı \`claims\` olmalı.

  {"claims": [ {...}, {...} ]}

Çıplak \`[...]\` dizisi YANLIŞTIR ve okunamaz. Nesnenin dışına hiçbir şey yazma:
açıklama, başlık, markdown tablosu, kod çiti (\`\`\`) ya da sonrasında metin YOK.

Nesne şu JSON Schema'ya uymalı:

${schema}

\`line_start\`/\`line_end\` iddianın notun kaçıncı satırlarından geldiği (nottaki
gövdeye göre, 1'den başlayarak). \`evidence\` alanına ölçtüğün somut şeyi yaz:
SHA, dosya yolu, sembol adı, sayı.

Hiç doğrulanabilir iddia bulmadıysan \`{"claims": []}\` yaz — boş dizi geçerli
ve TAM bir cevaptır.`;
}

type PassResult = {
  rc: number;
  usage: Usage | null;
  ms: number;
  text: string;
  sessionId: string | null;
  cap: Omit<Cap, "pass"> | null;
  items: number;
  turns: number;
  unparsedLines: number;
  unknownEvents: number;
  costUsd: number | null;
  stderrTail: string;
  // ÖLÇÜM, sabit değil: iki kill denemesinden sonra hâlâ yaşayan bir süreç var mı.
  killFailed: boolean;
  leakedPid: number | null;
  cleanupCmd: string | null;
};

/**
 * Tek bir opencode geçişi. `session` verilirse AYNI oturuma devam edilir —
 * pass 2'nin bağlamı zaten orada olduğu için hem hızlı hem ücretsiz.
 */
function runPass(prompt: string, session: string | null): Promise<PassResult> {
  return new Promise((resolve) => {
    const args = [
      "run",
      // Kullanıcının global skill/MCP yapılandırmasını YÜKLEME (ölçülmüş olgu 2).
      "--pure",
      "--format", "json",
      "--model", MODEL,
      // Çalışma kökü depo: araçlı hakem `git log`/`git show` koşturuyor.
      "--dir", wt,
      ...(session === null ? [] : ["--session", session]),
      prompt,
    ];
    const t0 = Date.now();
    // stdio[0] = "ignore": `--format json` STDIN'DE BLOKLAR (ölçülmüş olgu 1).
    // Bu `ignore` kaldırılırsa koşum sıfır bayt üreterek süresiz asılır.
    // detached: çocuk kendi süreç grubunun lideri olur; kesme torunları da
    // kapsasın diye (bkz. killProcessGroup).
    const child = spawn(BINARY, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid != null) liveGroups.add(child.pid);
    installSignalHandlers();

    let pending = "";
    let usage: Usage | null = null;
    let text = "";
    let sessionId: string | null = null;
    let items = 0;
    let turns = 0;
    let unparsedLines = 0;
    let unknownEvents = 0;
    let costUsd: number | null = null;
    let stderrTail = "";
    let cap: Omit<Cap, "pass"> | null = null;
    let settled = false;
    // Kesme anında çekilen hedef listesi (çocuk + torunları). Boş kaldığı sürece
    // "bu geçişi biz kesmedik" demek — `close` doğrudan sonucu yazar.
    let killTargets: number[] = [];
    let graceTimer: NodeJS.Timeout | null = null;

    function handleLine(line: string): void {
      const s = line.trim();
      // `{` ile başlamayan satır sayaca GİRMİYOR — kardeş araçla bilinçli
      // parite: gerçek akışta ilerleme/uyarı satırları düz metin geliyor ve
      // onları kayma saymak sayacı normal koşumda da doldururdu.
      if (!s.startsWith("{")) return;
      let o: { type?: unknown; sessionID?: unknown; part?: Record<string, unknown> };
      try {
        o = JSON.parse(s);
      } catch {
        unparsedLines++;
        return;
      }
      // Oturum kimliği HERHANGİ bir olaydan alınabiliyor; ilk görülen kazanır.
      // Pass 2'nin tek bağı bu — alınamazsa ikinci geçiş hiç denenmez.
      if (sessionId === null && typeof o.sessionID === "string" && o.sessionID !== "") {
        sessionId = o.sessionID;
      }
      const type = typeof o?.type === "string" ? o.type : "";
      if (!KNOWN_EVENT_TYPES.has(type)) {
        unknownEvents++;
        return;
      }
      const part = o.part ?? {};
      if (type === "text") {
        // SIRA KORUNUYOR: asistan metni birden çok `text` olayına bölünüyor ve
        // iddia kümesi o parçaların BİRLEŞİMİ. Sonuncuyu almak kümenin ortasını
        // keserdi.
        if (typeof part.text === "string") text += part.text;
        items++;
      } else if (type === "tool_use") {
        items++;
      } else if (type === "step_finish") {
        turns++;
        // `step_finish` ADIM BAŞINA geliyor: TOPLA, üzerine yazma (ölçülmüş
        // olgu 3). Kardeş araçtaki `addUsage` aynı hatayı orada da kapatmıştı.
        const mapped = mapTokens(part.tokens);
        if (mapped) usage = addUsage(usage, mapped);
        if (typeof part.cost === "number") costUsd = (costUsd ?? 0) + part.cost;
      }
    }

    const timer = setTimeout(() => {
      cap = { kind: "time", limit: TIMEOUT_SEC, observed: Math.round((Date.now() - t0) / 1000) };
      // macOS'ta `timeout` ikilisi YOK (hafıza: kabuk-tuzaklari-macos); kesme
      // süreç içinde. Hedefler kill'den ÖNCE çekiliyor: ebeveyn öldükten sonra
      // torunlar init'e evlat ediniliyor ve PPID zinciri kopuyor, yani listeyi
      // sonra çıkarmak imkânsız.
      if (child.pid != null) killTargets = [child.pid, ...descendantsOf(child.pid)];
      killProcessGroup(child.pid);
      killPids(killTargets);
      // Kill'den sonra `close` beklenir — gelmezse emniyet zamanlayıcısı
      // doğrulamayı başlatır, yoksa tek asılı işçi Promise.all'u kilitler ve
      // 28 notluk koşum sonsuza kadar bekler.
      graceTimer = setTimeout(verifyKill, KILL_GRACE_MS);
      graceTimer.unref(); // ilk beklemede süreç kapanışını geciktirme
    }, TIMEOUT_SEC * 1000);

    /**
     * İKİNCİ deneme + HÜKÜM. Kardeş araçtaki `retryKill` kalıbı, tek farkı
     * hedefin yalnız `child.pid` değil kesme anındaki tüm alt ağaç olması.
     *
     * Hiçbir hedef yaşamıyorsa sonuç ANINDA yazılır (kesme yolu tipik olarak
     * buraya düşer, ek gecikme yok). Yaşayan varsa grup VE düz PID bir kez daha
     * denenir, ikinci grace beklenir (bu sefer `unref` YOK: sahiplik temizlik
     * bitene kadar bırakılmıyor) ve hâlâ yaşayan varsa satıra SIZAN PID ile
     * kopyalanabilir temizlik komutu düşer.
     */
    function verifyKill(): void {
      if (settled) return;
      // `close` bekleme dolmadan geldiyse bekleyen tetik iptal: aksi hâlde aynı
      // doğrulama iki kez koşup üst üste grace zamanlayıcısı yığar.
      if (graceTimer) clearTimeout(graceTimer);
      const alive = killTargets.filter(isAlive);
      if (alive.length === 0) { finish(-1); return; }
      killHard(child.pid);
      killPids(alive);
      graceTimer = setTimeout(() => {
        const still = killTargets.filter(isAlive);
        finish(-1, { leakedPid: still[0] ?? null });
      }, KILL_GRACE_MS);
    }

    child.stdout.setEncoding("utf8"); // çok baytlı karakter chunk sınırında bölünmesin
    child.stdout.on("data", (d: string) => {
      pending += d;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const l of parts) handleLine(l);
    });
    child.stderr.setEncoding("utf8");
    // stderr ATILMIYOR: kuyruğu tutulmazsa "opencode neden 1 döndü" sorusu
    // cevapsız kalır ve satırda yalnız `rc` görünür (kardeş araçta ölçülmüş
    // bulgu: adjudicate-stderr-discarded).
    child.stderr.on("data", (d: string) => { stderrTail = appendTail(stderrTail, d); });

    function finish(rc: number, opts?: { leakedPid: number | null }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (pending) handleLine(pending);
      const leakedPid = opts?.leakedPid ?? null;
      if (leakedPid !== null) {
        // Süreç hâlâ yaşıyor ve borularımıza yazmaya devam edebilir; Node'un
        // çıkışını engellememesi için event loop'tan çıkar.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        // Sızan süreç ÇOCUK OLMAYABİLİR (kaçan bir torun da olabilir) ve o
        // hâlde deftere hiç girmemişti. Deftere alınıyor ki sinyal temizliği
        // ona da uzansın: `setsid` çağırmış bir torunun grup kimliği kendi
        // PID'si, dolayısıyla `killProcessGroup` onun için de doğru araç.
        liveGroups.add(leakedPid);
      }
      // Defterden düşüş KOŞULLU: süreç hâlâ canlıyken kaydı silmek, çıkış/sinyal
      // temizliğinin (cleanupNow) ona ulaşmasını imkânsız kılardı — kaçağı
      // bulan ölçüm aynı anda onu sahipsiz bırakırdı.
      if (child.pid != null && !isAlive(child.pid)) liveGroups.delete(child.pid);
      resolve({
        rc, usage, ms: Date.now() - t0, text, sessionId, cap, items, turns,
        unparsedLines, unknownEvents, costUsd, stderrTail,
        killFailed: leakedPid !== null,
        leakedPid,
        cleanupCmd: leakedPid === null ? null : cleanupCommand(leakedPid),
      });
    }
    // `error` (ENOENT: ikili yok) da bir SONUÇ — koşumu düşürmez, satır yazılır.
    child.on("error", (e) => {
      stderrTail = appendTail(stderrTail, String((e as Error).message));
      finish(-1);
    });
    // KESME YOLUNDA `close` SONUCU YAZMAZ. Çocuk SIGKILL'den ~3 ms sonra kapanıyor
    // (ölçüldü); o anda satır yazılırsa gruptan kaçmış bir torun daha ölmeden
    // "hiçbir şey kaçmadı" iddiası kaydedilir. Hükmü `verifyKill` veriyor.
    child.on("close", (rc) => {
      if (killTargets.length > 0) { verifyKill(); return; }
      finish(rc ?? -1);
    });
  });
}

const gitCtx = WITH_EVIDENCE ? await openGit(wt, { fetch: false, originRef: "19c623f" }) : null;
if (WITH_EVIDENCE && !gitCtx) { console.error("git bağlamı açılamadı"); process.exit(1); }

const RAW_SUFFIX = ".raw.jsonl";
const PASS1_SUFFIX = ".pass1.txt";

const incompleteDir = join(dirname(outPath), "incomplete");
mkdirSync(incompleteDir, { recursive: true });
// MALİYET DOSYASININ SIFIRLANMASIYLA ARTEFAKTLARIN SİLİNMESİ TEK ADIM.
// Ölçüldü (15 Ağu 2026, stale-raw probe'u): yalnız `writeFileSync(outPath, "")`
// yapılınca önceki koşumun `<cikti>.<not>.raw.jsonl` dosyaları yerinde kalıyor
// ve `flatten.ts` DİZİNDEKİ TÜM ham dosyaları topladığı için 2 notluk bir
// koşumun ardından 1 notla yapılan yeniden koşum düz dosyada yine 2 not
// puanlıyor. Daha kötü varyantı: bugün EKSİK çıkan bir not `incomplete/`e
// giderken dünkü TAM ham dosyası üst dizinde kalıyor ve ESKİ hükümler puanlanıyor.
// Ayrı bırakılan temizlik yapılmıyor (CLAUDE.md §3), o yüzden aynı satırda.
const purged = purgeStaleArtifacts([dirname(outPath), incompleteDir], `${basename(outPath)}.`);
writeFileSync(outPath, "");
// Sessiz silme bu projede bulgu: kaç dosya gittiği ölçülebilir kalsın.
console.error(`bayat artefakt silindi: ${purged}`);
console.log("not".padEnd(30) + "satır  p1(sn) p2(sn)  girdi  önbellek  çıktı   akıl  iddia");
console.log("─".repeat(88));

/** Tek yazma noktası: her satır buradan geçer, hiçbir sonuç konsolda kalmaz. */
function appendRow(row: Record<string, unknown>): void {
  appendFileSync(outPath, JSON.stringify(row) + "\n");
}

/** İki geçişin sayaçlarını TEK satıra toplar; maliyet sorusu not başına sorulur. */
function sumPasses(p1: PassResult, p2: PassResult | null): {
  usage: Usage; cost: number | null; items: number; turns: number;
  unparsed: number; unknown: number;
} {
  let usage: Usage | null = null;
  for (const p of [p1, p2]) {
    if (p?.usage) usage = addUsage(usage, p.usage as Record<string, unknown>);
  }
  // `null` ile `0` ayrımı korunuyor: hiçbir geçiş maliyet bildirmediyse cevap
  // "ölçemedim", "sıfırdı" değil. Ücretsiz modelin 0 bildirdiği iddiası ancak
  // bu ayrım varken sınanabilir.
  const costs = [p1.costUsd, p2?.costUsd ?? null].filter((c): c is number => c !== null);
  return {
    usage: usage ?? {},
    cost: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    items: p1.items + (p2?.items ?? 0),
    turns: p1.turns + (p2?.turns ?? 0),
    unparsed: p1.unparsedLines + (p2?.unparsedLines ?? 0),
    unknown: p1.unknownEvents + (p2?.unknownEvents ?? 0),
  };
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
  const bornWrongAvailable = authorshipBound(body) !== null;

  // PASS 1: ölçüm. İstem `buildPrompt`ten AYNEN geliyor — kardeş araç codex'e ne
  // gönderiyorsa o. Buraya biçim talimatı EKLENMİYOR: ölçülen olgu, modelin bu
  // geçişte biçime uymadığı; talimatı buraya koymak ölçümü değiştirmeden yalnız
  // iki aracın istemini ıraksatırdı.
  const p1 = await runPass(buildPrompt(note, body, evidence), null);
  // Pass 1'in anlatısı TEŞHİS KANITI — atılmıyor. `.txt` uzantısı bilerek:
  // `flatten.ts` yalnız `.raw.jsonl` ile bitenleri topluyor.
  writeFileSync(`${outPath}.${note}.pass1.txt`, p1.text);

  // PASS 1 BAŞARISIZSA PASS 2 HİÇ DENENMEZ. Üç ön koşul da aynı şeyi söylüyor:
  // çevirecek bir cevap yok. Oturumsuz bir ikinci çağrı YENİ bir oturum açar ve
  // model hiç yapmadığı bir ölçümü "çevirmeye" çalışır — uydurma bir iddia
  // kümesi üretmenin en kısa yolu bu olurdu.
  const canConvert = p1.rc === 0 && p1.cap === null && p1.sessionId !== null;
  const p2 = canConvert ? await runPass(conversionPrompt(bornWrongAvailable), p1.sessionId) : null;

  // Sözleşmeye uyan metin PASS 2'ninki. Pass 1 yoksa/başarısızsa elde çevrilmiş
  // metin de yok; ham dosya boş kalmasın diye pass 1'in metni yazılıyor —
  // ayrıştırılamayacağı için not zaten `incomplete/`e gidiyor, ama kanıt orada.
  const rawText = p2 === null ? p1.text : p2.text;

  // TAMLIK PROBU. `extractGatedClaims` yalnız "okunabildi mi" sorusunu cevaplamak
  // için çağrılıyor; DÖNDÜRDÜĞÜ kapılı küme ATILIYOR ve diske modelin HAM metni
  // yazılıyor. Sebep sözleşme: kapıyı `flatten.ts` uyguluyor, iki kez uygulanan
  // bir kapı `evidence` alanına iki kez iz düşürür ve kayıt bozulur.
  const gated = extractGatedClaims(rawText, bornWrongAvailable);
  const claimsComplete = gated !== null;
  const claims = gated?.length ?? 0;
  // Ham akışın YERİ hükme göre değişiyor: tamlar çıktı dosyasının yanında,
  // eksikler AYRI BİR ALT DİZİNDE — ayrım YAPISAL, ad ekine dayanmıyor, çünkü
  // `*.raw*` gibi gevşek bir glob alt dizine inemez. `flatten.ts` yalnız üst
  // dizini puanlıyor, `incomplete/` içindekileri duyurup dışarıda bırakıyor.
  const rawPath = claimsComplete
    ? `${outPath}.${note}.raw.jsonl`
    : join(incompleteDir, `${basename(outPath)}.${note}.raw.jsonl`);
  writeFileSync(rawPath, rawText);

  const cap: Cap | null = p1.cap ? { ...p1.cap, pass: 1 }
    : p2?.cap ? { ...p2.cap, pass: 2 } : null;
  const rc = p2 === null ? p1.rc : p2.rc;
  const parseFailed = !claimsComplete && cap === null && p1.rc === 0 && rc === 0;
  const s = sumPasses(p1, p2);
  const u = s.usage;
  const stderrTail = [p1.stderrTail, p2?.stderrTail ?? ""].filter(Boolean).join("\n");
  // İki geçişin herhangi biri sızdırdıysa not sızdırmıştır: satır tek, sızıntı
  // ise geçiş başına ölçülüyor. İlk sızan PID kazanır — ikincisi varsa aynı
  // temizlik komutu grubu zaten kapsıyor.
  const leaked = p1.leakedPid ?? p2?.leakedPid ?? null;
  const kill = {
    failed: p1.killFailed || (p2?.killFailed ?? false),
    pid: leaked,
    cmd: p1.cleanupCmd ?? p2?.cleanupCmd ?? null,
  };
  appendRow({
    note, lines, rc, ms: p1.ms + (p2?.ms ?? 0), evidence_fed: WITH_EVIDENCE,
    // Kapı dalı ÖLÇÜLMÜŞ OLGU olarak kaydediliyor: `flatten.ts` bunu okuyor ve
    // alan yoksa not gövdesinden YENİDEN hesaplıyor. Gövde bu arada tarih
    // kazandıysa/kaybettiyse yeniden hesap öbür dalı verir ve gerçek
    // `dogustan-yanlis` hükümleri sessizce `olculemez`e çevrilir.
    born_wrong_available: bornWrongAvailable,
    worker_error: null,
    cap,
    olculemez: !claimsComplete,
    claims_complete: claimsComplete,
    parse_failed: parseFailed,
    items: s.items,
    turns: s.turns,
    unparsed_lines: s.unparsed,
    unknown_events: s.unknown,
    // Kill-emniyeti alanları ÖLÇÜM, sabit değil. İki aracın satırları aynı
    // okuyucudan geçiyor; burada sabit bırakmak "hiçbir şey kaçmadı"yı BAKMADAN
    // iddia etmek olurdu ve bir ölçüm aletinde en pahalı hata sınıfı bu.
    kill_failed: kill.failed,
    leaked_pid: kill.pid,
    cleanup_command: kill.cmd,
    // The REACH of the measurement above, recorded beside its result. A
    // pre-snapshot setsid escapee is outside both the group and the PPID tree
    // (see descendantsOf), so `kill_failed:false` means "nothing in the
    // measured set survived". Without this field a reader cannot tell that
    // from "nothing survived", which is the same over-claim the constants were.
    kill_accounting: "group+ps-snapshot",
    stderr_tail: stderrTail === "" ? null : stderrTail,
    input_tokens: u.input_tokens ?? null,
    cached_input_tokens: u.cached_input_tokens ?? null,
    cache_write_input_tokens: u.cache_write_input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    reasoning_output_tokens: u.reasoning_output_tokens ?? null,
    claims,
    // --- İKİ GEÇİŞLİ AKIŞA ÖZGÜ ALANLAR ---
    // Yukarıdaki jeton/sayaç alanları İKİ GEÇİŞİN TOPLAMI. Not başına maliyet
    // sorusunun cevabı o; ama hangi geçişin ne kadar sürdüğü ayrı bir soru ve
    // teşhis için gerekli (pass 1 ölçüyor, pass 2 yalnız çeviriyor — pass 2
    // uzuyorsa çevirme istemi yeniden ölçüm tetikliyor demektir).
    runner: "opencode",
    model: MODEL,
    cost_usd: s.cost,
    session_id: p1.sessionId,
    pass1_rc: p1.rc,
    pass1_ms: p1.ms,
    pass2_rc: p2?.rc ?? null,
    pass2_ms: p2?.ms ?? null,
    // `false` = pass 1 çevrilecek bir cevap bırakmadı (rc, tavan ya da oturum
    // kimliği). `null` ile karıştırılmasın diye bool: karar VERİLDİ.
    pass2_attempted: p2 !== null,
  });
  console.log(
    note.padEnd(30) + String(lines).padStart(5) +
    String((p1.ms / 1000).toFixed(0)).padStart(7) +
    String(p2 === null ? "-" : (p2.ms / 1000).toFixed(0)).padStart(7) +
    String(u.input_tokens ?? "-").padStart(7) + String(u.cached_input_tokens ?? "-").padStart(10) +
    String(u.output_tokens ?? "-").padStart(7) + String(u.reasoning_output_tokens ?? "-").padStart(7) +
    String(claims).padStart(7) + (rc === 0 ? "" : `  rc=${rc}`) +
    (cap ? `  CAP ${cap.kind} ${cap.observed}/${cap.limit} (geçiş ${cap.pass})` : "") +
    (p2 === null ? "  PASS2 ATLANDI" : "") +
    (claimsComplete ? "" : `  ${parseFailed ? "PARSE ARIZASI" : "EKSİK ÇIKTI"} → olculemez`) +
    (s.unparsed > 0 || s.unknown > 0
      ? `  ŞEMA KAYMASI (bozuk satır ${s.unparsed}, tanınmayan olay ${s.unknown})`
      : "") +
    (kill.failed ? `  KILL BAŞARISIZ (sızan pid ${kill.pid})` : "") +
    (rc !== 0 && stderrTail ? `  stderr: ${stderrTail.trim()}` : ""),
  );
  // Sızan süreç SESSİZ kalmıyor: temizlik komutu satırda da var ama operatörün
  // konsolda görmesi gereken tek şey bu.
  if (kill.cmd) console.log(`  ↳ elle temizlik:  ${kill.cmd}`);
}

const queue = [...notes];
await Promise.all(
  Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    for (;;) {
      const n = queue.shift();
      if (!n) return;
      try {
        await one(n);
      } catch (e) {
        // BİR NOT 28'İ KAYBETTİRMEZ. İstisna yalnız konsola yazılırsa not sonuç
        // dosyasına hiç girmez ve sonraki adım "hiç koşulmamış" ile "patlamış"ı
        // ayıramaz. Ayırt edici işaret: `worker_error` dolu ve `rc: null`.
        const msg = (e as Error).message;
        console.log(`${n.padEnd(30)}  HATA: ${msg}`);
        appendRow({
          note: n, lines: null, rc: null, ms: null, evidence_fed: WITH_EVIDENCE,
          worker_error: msg,
          // İstisna gövde okumasından ÖNCE gelebilir, yani dal hiç ölçülmedi.
          // `false` "kapı kapalıydı" diye bir ölçüm İDDİA ederdi; `null` "bilmiyorum".
          born_wrong_available: null,
          cap: null, olculemez: true, claims_complete: false, parse_failed: false,
          items: 0, turns: 0,
          // Ayrıştırıcı HİÇ koşmadı → 0 yazmak "sıfır kayma ölçtüm" derdi.
          unparsed_lines: null, unknown_events: null,
          // The exception can land before OR after the spawn, so whether
          // anything survived was never measured. `false` would assert it was.
          kill_failed: null, leaked_pid: null,
          cleanup_command: null, kill_accounting: null, stderr_tail: null,
          input_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null,
          output_tokens: null, reasoning_output_tokens: null, claims: 0,
          runner: "opencode", model: MODEL, cost_usd: null,
          session_id: null, pass1_rc: null, pass1_ms: null,
          pass2_rc: null, pass2_ms: null, pass2_attempted: false,
        });
      }
    }
  }),
);
console.log(`\nham kayıt: ${outPath}`);
