import { randomUUID } from "node:crypto";
import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";

/**
 * Tek yazar kilidi. Denetimde ölçüldü: iki tarama aynı anda koşunca aynı bayt
 * aralığını okuyup gözlemciye İKİ KEZ teslim ediyorlardı — imleci okumak,
 * işlemek ve yazmak atomik bir birim değil.
 *
 * Kilit tavsiye niteliğinde değil, zorunlu: alınamıyorsa tarama hiç başlamaz.
 * Sahibi çökünce sistemin kilitli kalmaması için devralma kuralı var.
 */
/**
 * SAHİPLİK KANITI = KALP ATIŞI. Sahip hayattaysa satırı düzenli tazeler.
 *
 * Bu modül dört denetim turunda dört ayrı biçimde kanadı ve dördü de aynı kökten
 * çıktı: "sahip hâlâ çalışıyor mu" sorusu işletim sisteminden okunan bir kimlik
 * dizesiyle TAHMİN ediliyordu (`pid` + `ps -o lstart=`). Ölçülen arızalar:
 *
 *   - ölü sahibin numarasını devralan yabancı süreç sonsuza dek "canlı"
 *     görünüyordu (probe: pid-alias-keeps-stale-lock);
 *   - tahmin güvenilmez olduğu için yaşa düşülmüştü ve yaş TEK BAŞINA devralma
 *     yetkisi olunca SAĞLIKLI uzun denetimin kilidi çalınıyordu
 *     (probe: live-lock-stolen-after-hour);
 *   - `lstart` yerel saat diliminde basılıyor: damgayı yazan ile ölçen farklı
 *     `TZ` ile koşarsa aynı sürecin kimliği farklı çıkıyor ve CANLI kilit
 *     anında çalınıyordu (probe: tz-shift-steals-live-lock);
 *   - kimlikte MAKİNE yok: paylaşılan bir depoda B makinesi A'nın PID'sini
 *     kendi süreç tablosunda arıyor ve taptaze bir uzak kilidi "pid_reused"
 *     diye anında çalıyordu (probe: foreign-host-lock-stolen-immediately);
 *   - `ps` alt süreci zaman aşımısız ve AÇIK BİR İŞLEMİN İÇİNDE koşuyordu:
 *     asılı bir `ps` kilit alımını süresiz blokluyordu
 *     (probe: ps-hang-blocks-lock-forever).
 *
 * Beşinci yama yerine ölçüt değişti. Kalp atışı KESİN bir sinyal: kimseye
 * "yaşıyor musun" diye sorulmuyor, yaşayan kendi izini bırakıyor. Sonuçta `ps`,
 * locale, saat dilimi, makine kimliği ve PID kavramlarının tamamı bu modülden
 * kalktı — sahip kimliği artık yalnızca çakışmayan rastgele bir token.
 *
 * Karar ağacı tek soruya indi: son atış HEARTBEAT_STALE_MS'ten eski mi?
 */

/**
 * Atış aralığı. Tek UPDATE, saniyede binlercesi yapılabilir; 30 sn'nin maliyeti
 * ölçülemez, faydası bayatlık eşiğine bol paylı sığması.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Bu süre atış görülmezse sahip ölmüş sayılır (≈20 kaçırılmış atış).
 *
 * BURADA ÖNCE YANLIŞ BİR GEREKÇE YAZIYORDU (düzeltildi 12 Ağu 2026): "kilit
 * tutulurken tek bir Codex çağrısı 180 sn sürebiliyor ve senkron alt süreç
 * beklemesi zamanlayıcıyı geciktirir" deniyordu. Ölçülünce çöktü — `codex.ts`
 * `spawn`, `signals/git.ts` promisify'lı `execFile` kullanıyor; ikisi de
 * asenkron, hiçbiri olay döngüsünü tutmuyor. Yanlış gerekçeli bir eşik
 * gerekçesizden kötüdür: okuyan, çökmüş bir varsayıma dayanarak sayıyı
 * "güvenli" sanıyor.
 *
 * ÖLÇÜLEN gerçek senkron blok kaynağı depo yazımının kendisi: Node'un yerleşik
 * SQLite sürücüsü SENKRON, dolayısıyla çekişmeli bir yazımda busy timeout (5 sn)
 * boyunca olay döngüsü tümden durur. Ölçüm (12 Ağu 2026, node 24.10): rakip bir
 * yazıcı varken tek bir INSERT 5192 ms senkron blokladı ve 100 ms'lik bir
 * zamanlayıcı 5092 ms gecikmeyle ateşledi. Buna karşılık AYNI gün ölçülen
 * gerçek tarama yükü (416 MB / 24.971 turn, ~/.claude/projects tamamı) olay
 * döngüsünü en fazla 1 ms bekletti — yani ayrıştırma bu eşiğe hiç girmiyor.
 *
 * Yani kendi kodumuzun bloklaması en kötü bir atış turu yiyor, iki değil. 10
 * dakikalık payı HAKLI ÇIKARAN şey ölçemediklerimiz: süreç dondurulması
 * (kapak kapanması, VM duraklatma) sırasında duvar saati işlemeye devam eder ve
 * canlı bir sahip bayat görünür; üstüne tazeleme hataları yutuluyor (aşağıda),
 * yani üst üste gelen birkaç arıza sessizce atış kaybettirir.
 *
 * İki yöndeki bedel simetrik değil, tercih bilinçli: fazla cömert eşiğin bedeli
 * ÖLÇÜLÜ ve ucuz (gerçekten ölmüş bir sahibin kilidi en fazla 10 dk tutulu
 * kalır), fazla cimri eşiğin bedeli CANLI kilidin çalınmasıydı — bu modülün
 * dört turdur kanadığı sınıf. Eşiği düşürmek isteyen önce dondurma senaryosunu
 * ölçsün.
 */
export const HEARTBEAT_STALE_MS = 10 * 60_000;

/**
 * "Bu artık normal değil" eşiği — BAYATLIKLA İLGİSİ YOK, görünürlük için.
 * Ölçüsü `acquired_at`: sahibi düzenli atıyor olsa bile altı saattir kilidi
 * tutuyorsa ya asılmış ya da gerçekten çok uzun bir denetim koşuyor. Kilit
 * ÇALINMIYOR (atışı süren sahip meşrudur), yalnız "birine bak" deniyor.
 */
const LONG_HELD_MS = 6 * 60 * 60 * 1000;

/**
 * Sahip kimliği: çakışmayan rastgele token. Anlamı YOK ve olmamalı — kimliğin
 * yorumlanabilir olması (PID, host, başlangıç zamanı) yukarıdaki beş arızanın
 * tamamının ön koşuluydu. Tek gereksinimi eşsizlik.
 */
export function newLockHolder(): string {
  return randomUUID();
}

export class ScanLockBusy extends Error {
  constructor(holder: string) {
    super(`başka bir tarama sürüyor (sahip: ${holder})`);
    this.name = "ScanLockBusy";
  }
}

/**
 * Sahipliğin bittiğinde neden kanıtlanamadığı. Üç ayrı yol, tek sınıf: çağıranın
 * tepkisi hepsinde aynı (sonucu atıp tekrar koş), ama teşhis farklı.
 */
export type LockLostReason =
  /** Atış turu satırın başkasına geçtiğini gördü. */
  | "heartbeat_lost"
  /** İş bitti, satır okundu, sahip başkasıydı — atış hiç ateşlememiş olabilir. */
  | "holder_changed"
  /** Satır okunamadı: sahiplik ne doğrulanabildi ne çürütülebildi. */
  | "unverifiable";

/**
 * Kilit iş sürerken elden gitti. YUTULMAZ: kilidini kaybetmiş bir koşumun
 * yazımları korumasızdır ve başarıyla dönmesi, kilidin engellemesi gereken
 * mükerrer teslimatı sessizce geri getirir.
 */
export class ScanLockStolen extends Error {
  readonly reason: LockLostReason;
  constructor(holder: string, reason: LockLostReason = "heartbeat_lost", options?: { cause?: unknown }) {
    const nasil = {
      heartbeat_lost: "tazeleme turu satırı başkasında buldu",
      holder_changed: "iş bittiğinde satır başkasınaydı",
      unverifiable: "iş bittiğinde sahiplik doğrulanamadı (kilit satırı okunamadı)",
    }[reason];
    super(`tarama kilidi koşum sırasında elden gitti (sahip: ${holder}; ${nasil}) — sonuç güvenilmez, tekrar koşun`, options);
    this.name = "ScanLockStolen";
    this.reason = reason;
  }
}

/**
 * Eşzamanlı devralmada kaybeden tarafın aldığı depo hatası mı?
 *
 * `Store.tx` derinlik 0'da DEFERRED `BEGIN` açıyor: iki devralıcı aynı anlık
 * görüntüyü okuyup ikisi de devralmaya karar verebiliyor, sonra biri yazıyor ve
 * diğeri yazmaya kalkınca SQLITE_BUSY_SNAPSHOT alıyor. Node'un yerleşik SQLite
 * sürücüsüyle ölçüldü: `errcode = 517`, `errstr = "database is locked"`.
 *
 * NEDEN DAR YAKALAMA, NEDEN `BEGIN IMMEDIATE` DEĞİL: IMMEDIATE'e geçmek TÜM
 * işlemlerin davranışını değiştirir (her tarama/denetim/import tx'i baştan yazma
 * kilidi alır ve okuyucular birbirini beklemeye başlar) — kilit alımındaki bir
 * hata sunumu için ödenecek bedel değil. Serileşme zaten DOĞRU çalışıyor: tam
 * olarak bir devralıcı kazanıyor, kaybeden hiçbir şey yazamıyor. Kusur yalnız
 * SUNUMDU — kaybeden ham yığın izi + rc=1 (yani "argümanın yanlış") alıyordu,
 * oysa doğru tepki "başkası tarıyor, bekle ve tekrar dene" (rc=5).
 *
 * Düşük bayt maskesi: SQLite genişletilmiş kodları alt bayta birincil kodu
 * koyuyor (517 & 0xff == 5 == SQLITE_BUSY). Metin kontrolü yalnız yedek.
 */
function isBusyError(err: unknown): boolean {
  const e = err as { errcode?: unknown; message?: unknown };
  if (typeof e?.errcode === "number" && (e.errcode & 0xff) === 5) return true;
  return typeof e?.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message);
}

/**
 * Uzun tutulan kilidi görünür kılar. ÇALMAZ — yalnız yazar.
 *
 * Gürültü engeli: aynı kilit satırı (sahip + alınma zamanı) için EN FAZLA bir
 * kayıt. Sebep ölçülebilirlik: takılı bir kilide her dakika bir tarama çarparsa
 * tekrar yazmak aynı olguyu yüzlerce satıra çoğaltır, `events` silinemez olduğu
 * için şişme geri alınamaz, ve olay sayısı "kaç kez takıldık" değil "kaç kez
 * denedik" ölçmeye başlar. Tekilleştirme anahtarı sahip+alınma zamanı: kilit
 * bırakılıp yeniden alınırsa `acquired_at` değişir ve YENİ bir takılma yazılır.
 *
 * Tek satır bakmak yetiyor çünkü kilit tablosunda tek satır var (id=1): bu
 * türdeki en son olay, mümkün olan tek "hâlâ süren" takılmayı temsil eder.
 */
function noteLockRow(
  store: Store,
  kind: string,
  holder: string,
  acquiredAt: string,
  extra: Record<string, unknown>,
): void {
  const last = store.get<{ detail: string | null }>(
    "SELECT detail FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1",
    kind,
  );
  if (last?.detail) {
    try {
      const prev = JSON.parse(last.detail) as { holder?: unknown; acquiredAt?: unknown };
      if (prev.holder === holder && prev.acquiredAt === acquiredAt) return;
    } catch {
      // Okunamayan detay tekilleştirmeyi engellemez: yazmak, susmaktan iyi.
    }
  }
  store.run(
    "INSERT INTO events (project_id, at, kind, detail) VALUES (NULL,?,?,?)",
    nowIso(),
    kind,
    JSON.stringify({ holder, acquiredAt, ...extra }),
  );
}

/**
 * Damganın "gelecekte" sayılması için gereken pay. Meşru bir gelecek damga
 * MÜMKÜN DEĞİL: satır yazıldıktan sonra okunuyor, yani aynı saatte fark daima
 * ≥0. Pay yalnız saat kaymasının (NTP slew) ve damga çözünürlüğünün altındaki
 * gürültüyü yutuyor; bunun üstü artık iki farklı saat demektir.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

type Busy = {
  holder: string;
  acquiredAt: string;
  longHeld: boolean;
  age: number;
  /** Damga bizim şimdimizin ne kadar ötesinde; 0 = tutarsızlık yok. */
  skewMs: number;
};

export function acquireScanLock(store: Store, holder: string): void {
  let busy: Busy | null = null;
  try {
    store.tx(() => {
      const cur = store.get<{ holder: string; acquired_at: string; heartbeat_at: string | null }>(
        "SELECT holder, acquired_at, heartbeat_at FROM scan_lock WHERE id = 1",
      );
      if (cur) {
        // Atış yoksa `acquired_at`'e düşülür. NULL iki durumdan gelir: satırı bu
        // kuşaktan ÖNCEKİ bir yazıcı bıraktı (göç), ya da sahip aldıktan hemen
        // sonra ilk atışa varmadan bakıldı — ikisinde de alınma zamanı doğru
        // alt sınır. Okunamayan damga tazelik KANITI sayılmaz: bizim yazdığımız
        // her satırda geçerli ISO damga var, dolayısıyla ayrıştırılamayan bir
        // damga yabancı bir yazıcıdandır ve süresiz tutma hakkı doğurmaz.
        const sinceBeat = Date.now() - Date.parse(cur.heartbeat_at ?? cur.acquired_at);
        const age = Date.now() - Date.parse(cur.acquired_at);
        const stale = !Number.isFinite(sinceBeat) || sinceBeat >= HEARTBEAT_STALE_MS;
        if (!stale) {
          // MEŞGUL: burada FIRLATILMIYOR. Fırlatmak tx'i ROLLBACK'e sürükler ve
          // aynı tx içinde yazılacak uzun-tutma olayını da geri alırdı — olayın
          // yazıldığını görüp diskte bulamamak, tam olarak önlemeye çalıştığımız
          // sessiz kayıp. Meşgul hâli veri olarak dışarı çıkar, kayıt ve
          // fırlatma tx kapandıktan sonra yapılır.
          busy = {
            holder: cur.holder,
            acquiredAt: cur.acquired_at,
            longHeld: Number.isFinite(age) && age >= LONG_HELD_MS,
            age,
            // GELECEKTEKİ damga = saat uyuşmazlığının kanıtı (GUARD, kök çözüm
            // değil). Bayatlık ölçüsü duvar saati ve süreçler arası monotonik
            // saat YOK; ileri sıçrayan bir saat (NTP, VM restore) taptaze bir
            // kilidi anında bayat gösterebiliyor ve bunu engellemenin yolu yok.
            // Engelleyemediğimizi hiç değilse GÖRÜNÜR kılıyoruz: bu satırı
            // yazan saat bizimkiyle aynı değilse, o depodaki her bayatlık
            // ölçümü şüphelidir. Ters yön (damga geçmişte) ayırt edilemez —
            // bayat bir kilitle bire bir aynı görünür.
            skewMs: Number.isFinite(sinceBeat) && sinceBeat < -CLOCK_SKEW_TOLERANCE_MS ? -sinceBeat : 0,
          };
          return;
        }
        // Devralma sessiz değil ize düşerek: `reason` olmadan "canlı sahibin
        // kilidi mi çalındı" sorusu günlükten cevaplanamıyor.
        store.run(
          "INSERT INTO events (project_id, at, kind, detail) VALUES (NULL,?,?,?)",
          nowIso(),
          "scan_lock_stolen",
          JSON.stringify({
            previousHolder: cur.holder,
            ageMs: Number.isFinite(age) ? age : null,
            reason: "heartbeat_stale",
          }),
        );
        store.run("DELETE FROM scan_lock WHERE id = 1");
      }
      const now = nowIso();
      // İlk atış alımla birlikte yazılıyor: aksi hâlde alım ile ilk zamanlayıcı
      // turu arasındaki pencerede satır NULL kalır ve tazelik `acquired_at`'e
      // düşerdi — doğru ama gereksiz bir dolaylılık.
      store.run("INSERT INTO scan_lock (id, holder, acquired_at, heartbeat_at) VALUES (1,?,?,?)", holder, now, now);
    });
  } catch (err) {
    if (!isBusyError(err)) throw err;
    // Kaybeden taraf hiçbir şey yazamadı; kazananın kim olduğunu en iyi çabayla
    // okuyup mesaja koyuyoruz. Okuma da patlarsa mesaj sahipsiz kalır ama
    // SINIF doğru kalır — çağıranın kararı (bekle ve tekrar dene) buna bağlı.
    let winner = "bilinmiyor";
    try {
      winner = store.get<{ holder: string }>("SELECT holder FROM scan_lock WHERE id = 1")?.holder ?? winner;
    } catch {
      // yut: sınıflandırma zaten yapıldı
    }
    throw new ScanLockBusy(winner);
  }
  if (busy) {
    const b: Busy = busy;
    if (b.longHeld) {
      noteLockRow(store, "scan_lock_held_long", b.holder, b.acquiredAt, {
        ageMs: b.age,
        thresholdMs: LONG_HELD_MS,
        // Devralınmadığı OLAYIN İÇİNDE yazılı: bu satırı okuyan, kilidin hâlâ
        // sahibinde olduğunu `scan_lock_stolen` yokluğundan çıkarmak zorunda
        // kalmasın. Meşru uzun denetim de bu satırı üretir; ayrımı insan yapar.
        stolen: false,
      });
    }
    // Kilit ÇALINMIYOR: gelecekteki damga zaten "bayat değil" demek, yani bu dal
    // devralma kararını hiç etkilemiyor. Yazılan tek şey teşhis.
    if (b.skewMs > 0) {
      noteLockRow(store, "scan_lock_clock_skew", b.holder, b.acquiredAt, {
        skewMs: b.skewMs,
        toleranceMs: CLOCK_SKEW_TOLERANCE_MS,
        staleThresholdMs: HEARTBEAT_STALE_MS,
      });
    }
    throw new ScanLockBusy(b.holder);
  }
}

export function releaseScanLock(store: Store, holder: string): void {
  store.run("DELETE FROM scan_lock WHERE id = 1 AND holder = ?", holder);
}

/**
 * Kalp atışını tazeler. Dönüş: kilit HÂLÂ bizde mi.
 *
 * `WHERE holder = ?` şart: satır devralınmışsa hiçbir şey yazılmamalı. Koşulsuz
 * bir UPDATE, kilidini çoktan kaybetmiş bir sürecin BAŞKASININ satırını
 * tazelemesi demek olurdu — iki yazar birden kendini sahip sanardı.
 */
export function renewScanLock(store: Store, holder: string): boolean {
  return store.run("UPDATE scan_lock SET heartbeat_at = ? WHERE id = 1 AND holder = ?", nowIso(), holder).changes > 0;
}

/**
 * Kilit HÂLÂ bizde mi — satırı okuyarak. Bayrak yerine SATIR, çünkü bayrak
 * yalnız "bir atış turu koştu ve satırı başkasında buldu" diyebiliyor.
 *
 * Bağımsız çürütücü ölçtü (probe: completion-misses-takeover): 300 ms süren
 * senkron bir iş boyunca SIFIR atış koşuyor, ve `await fn()` sonrası devam bir
 * MİKRO görev iken bekleyen atış MAKRO görev — yani bayrak kontrolü bekleyen
 * atıştan önce çalışır. Bayrağa güvenen bir bitiş, her koşumun sonunda bir tam
 * aralık (30 sn) genişliğinde kör pencere bırakıyordu.
 *
 * Bu tek okuma, atışın hiç koşmamış ya da her turda fırlamış olmasını da
 * yapısal olarak zararsız kılıyor: sonuç atışın çalışmasına DEĞİL satırın
 * kendisine dayanıyor.
 */
function assertStillOwner(store: Store, holder: string): void {
  let row: { holder: string } | undefined;
  try {
    row = store.get<{ holder: string }>("SELECT holder FROM scan_lock WHERE id = 1");
  } catch (err) {
    // "Doğrulayamadım" ile "sahibim" aynı şey değil: kanıtı olmayan sahiplik
    // iddiası koruma değil. Sebep zincire konur, sınıf çağıran için aynı kalır.
    throw new ScanLockStolen(holder, "unverifiable", { cause: err });
  }
  if (row?.holder !== holder) throw new ScanLockStolen(holder, "holder_changed");
}

export type ScanLockHandle = {
  readonly holder: string;
  /** Zamanlayıcıyı durdurur ve kilidi bırakır. Yeniden çağrılabilir. */
  release(): void;
};

/**
 * Kilidi alır, iş boyunca kalp atışını sürdürür, her çıkışta bırakır.
 *
 * Üç çağıran (scan, observe, audit) bunu daha önce elle yazıyordu ve elle
 * yazılan her kopya atışı unutabilirdi — sarmalayıcı, unutulamayacak yer.
 *
 * `intervalMs` yalnız testler için: gerçek aralık 30 sn ve bir testin bunu
 * beklemesi mümkün değil.
 */
export async function withScanLock<T>(
  store: Store,
  fn: (lock: ScanLockHandle) => T | Promise<T>,
  opts: { holder?: string; intervalMs?: number } = {},
): Promise<T> {
  const holder = opts.holder ?? newLockHolder();
  acquireScanLock(store, holder);

  let timer: ReturnType<typeof setInterval> | null = null;
  let stolen = false;
  let released = false;
  /** Yutulan tazeleme hatası sayısı — bitişte olaya dönüşür (aşağıdaki gerekçe). */
  let renewFailures = 0;

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const handle: ScanLockHandle = {
    holder,
    release() {
      // SIRA KRİTİK: zamanlayıcı SİLMEDEN ÖNCE durur. Ters sırada, satır
      // silindikten sonra ateşleyen bir atış boş bir UPDATE yapar (zararsız),
      // ama araya girip kilidi alan BİR SONRAKİ sahip varsa onun satırını
      // bulur — `WHERE holder = ?` bunu da tutuyor, yani iki savunma üst üste.
      // Yine de sıra doğru olmalı: ikinci savunmaya güvenerek yazılan kod,
      // birinci savunma kaldırıldığında sessizce bozulur.
      stopTimer();
      if (released) return;
      released = true;
      releaseScanLock(store, holder);
    },
  };

  timer = setInterval(() => {
    try {
      if (!renewScanLock(store, holder)) {
        // Kilit elden gitmiş: tazelemeye devam etmek başkasının satırını
        // yazmaya çalışmak olurdu. Zamanlayıcı kendini durdurur, durum
        // bayrakla dışarı taşınır ve fn dönüşünde fırlatılır.
        stolen = true;
        stopTimer();
      }
    } catch {
      // Geçici bir depo hatası (SQLITE_BUSY, kapanmış bağlantı) atışı
      // öldürmemeli: bir sonraki tur yeniden dener. Burada fırlatmak zamanlayıcı
      // geri çağırımında yakalanamayan bir istisna demek — süreci öldürürdü.
      //
      // Yutmak sürüyor ama SESSİZLİK bitti: sayaç bitişte olaya dönüyor.
      // Ayrım önemli — bu hatayı burada FIRLATMAK süreci öldürür, GÖRÜNMEZ
      // bırakmak ise sonraki koşumun "neden devralındım" sorusunu cevapsız
      // bırakır. Sayacın kendisi de yazma denemesi değil, bellekte bir sayı:
      // depo yazılamıyorken depoya yazmaya çalışmıyor.
      renewFailures++;
    }
  }, opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  // Süreci ayakta tutmasın: kilit bir yan iş, işin kendisi değil.
  timer.unref?.();

  let out: T;
  try {
    out = await fn(handle);
    if (stolen) throw new ScanLockStolen(holder, "heartbeat_lost");
    // SATIR OKUMASI BIRAKMADAN ÖNCE: ters sırada kendi sildiğimiz satırı
    // "başkası aldı" diye okurduk.
    assertStillOwner(store, holder);
    if (renewFailures > 0) {
      try {
        noteLockRow(store, "scan_lock_renew_failed", holder, nowIso(), { failures: renewFailures });
      } catch {
        // Teşhis kaydı işin sonucunu geçersiz kılmaz: kilit doğrulandı, iş
        // bitti. Burada fırlatmak, sağlam bir koşumu bir günlük satırı yüzünden
        // çöpe atmak olurdu.
      }
    }
  } catch (err) {
    // TEMİZLİK HATASI ÖZGÜN HATAYI EZMEZ. Eski hâlinde bırakma `finally`
    // içindeydi ve fırlarsa işin gerçek hatasını yerinden ediyordu — teşhis
    // kaybı, üstelik `cause` zinciri de kurulmadan.
    try {
      handle.release();
    } catch (releaseErr) {
      // db.ts'teki `rollbackError` ile aynı sözleşme: ikincil hata AYRI bir
      // alana konur, `cause` ezilmez (özgün hatanın kendi `cause`'u olabilir).
      // İlkel bir değer fırlatılmışsa (throw "x") alan yazılamaz; kayıp bilinçli,
      // alternatifi özgün hatayı bir TypeError ile değiştirmek olurdu.
      if (err !== null && typeof err === "object") (err as { releaseError?: unknown }).releaseError = releaseErr;
    }
    throw err;
  }
  // BAŞARI yolunda bırakma hatası GÖRÜNÜR: maskeleyeceği bir özgün hata yok ve
  // kilit satırının diskte kalması sonraki koşumu bayatlama süresi (10 dk)
  // boyunca bekletir — susmak bunu bir gizemli gecikmeye çevirirdi.
  handle.release();
  return out;
}
