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
 * Pay neden bu kadar geniş: kilit TUTULURKEN tek bir Codex çağrısı 180 saniyeye
 * kadar sürebiliyor (adapters/codex.ts) ve git alt süreçleri 15 saniyeye kadar.
 * Node tek iş parçacıklı, yani senkron bir alt süreç beklemesi zamanlayıcıyı da
 * geciktirir. Bir-iki atışlık pay (60-90 sn) bu yüzden yetmez: SAĞLIKLI bir
 * denetim tek bir uzun çağrının arkasında bayat görünür ve kilidin var olma
 * sebebi olan mükerrer teslimat yarışı geri gelirdi. 10 dakika, en uzun tek
 * bloklama süresinin üç katından fazla.
 *
 * Ters yönde bedeli: gerçekten ölmüş bir sahibin kilidi en fazla 10 dakika
 * tutulu kalır. Ölçülen alternatifin (ölü sahibi `ps` ile TAHMİN etme) bedeli
 * canlı kilidin çalınmasıydı; 10 dakikalık gecikme bunun yanında ucuz.
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
 * Kilit iş sürerken elden gitti. YUTULMAZ: kilidini kaybetmiş bir koşumun
 * yazımları korumasızdır ve başarıyla dönmesi, kilidin engellemesi gereken
 * mükerrer teslimatı sessizce geri getirir.
 */
export class ScanLockStolen extends Error {
  constructor(holder: string) {
    super(`tarama kilidi koşum sırasında elden gitti (sahip: ${holder}) — sonuç güvenilmez, tekrar koşun`);
    this.name = "ScanLockStolen";
  }
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
function noteLongHeldLock(store: Store, holder: string, acquiredAt: string, age: number): void {
  const last = store.get<{ detail: string | null }>(
    "SELECT detail FROM events WHERE kind = 'scan_lock_held_long' ORDER BY id DESC LIMIT 1",
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
    "scan_lock_held_long",
    JSON.stringify({
      holder,
      acquiredAt,
      ageMs: age,
      thresholdMs: LONG_HELD_MS,
      // Devralınmadığı OLAYIN İÇİNDE yazılı: bu satırı okuyan, kilidin hâlâ
      // sahibinde olduğunu `scan_lock_stolen` yokluğundan çıkarmak zorunda
      // kalmasın. Meşru uzun denetim de bu satırı üretir; ayrımı insan yapar.
      stolen: false,
    }),
  );
}

type Busy = { holder: string; acquiredAt: string; longHeld: boolean; age: number };

export function acquireScanLock(store: Store, holder: string): void {
  let busy: Busy | null = null;
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
  if (busy) {
    const b: Busy = busy;
    if (b.longHeld) noteLongHeldLock(store, b.holder, b.acquiredAt, b.age);
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
    }
  }, opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  // Süreci ayakta tutmasın: kilit bir yan iş, işin kendisi değil.
  timer.unref?.();

  try {
    const out = await fn(handle);
    if (stolen) throw new ScanLockStolen(holder);
    return out;
  } finally {
    handle.release();
  }
}
