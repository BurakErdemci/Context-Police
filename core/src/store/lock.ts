import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";

/**
 * Tek yazar kilidi. Denetimde ölçüldü: iki tarama aynı anda koşunca aynı bayt
 * aralığını okuyup gözlemciye İKİ KEZ teslim ediyorlardı — imleci okumak,
 * işlemek ve yazmak atomik bir birim değil.
 *
 * Kilit tavsiye niteliğinde değil, zorunlu: alınamıyorsa tarama hiç başlamaz.
 * Sahibi çökünce sistemin kilitli kalmaması için devralma kuralı var — koşulları
 * ve neden ikisinden BİRİNİN yettiği aşağıda, STALE_MS'in üstünde.
 */
/**
 * Devralma İKİ bağımsız gerekçeden BİRİYLE olur — ikisi birden aranmaz:
 *
 *   1) Sahip kanıtlanabilir şekilde ÖLÜ  → süre beklenmez, kilit hemen alınır.
 *   2) Kilit STALE_MS'ten eski           → sahip canlı görünse bile alınabilir.
 *
 * Neden (1): zaman aşımı tek başına yanlış ölçüttü — uzun ama SAĞLIKLI bir
 * tarama 10 dk'yı geçince kilidi çalınıyor ve iki tarama gerçekten çakışıyordu
 * (M2 doğrulama turu). Ama iki koşulu birden ZORUNLU kılmak da ölçülerek
 * kırıldı (probe: dead-lock-blocks-retry): Ctrl-C'de `finally` koşmuyor, kilit
 * satırı ölü bir PID ve YEPYENİ bir damgayla diskte kalıyor, ve yarım kalan
 * denetimi onarmak için gereken hemen-tekrar bir SAAT boyunca imkânsız oluyordu.
 *
 * Neden (2): sahip kimliği yalnız PID. İşletim sistemi ölen sahibin PID'sini
 * başka bir sürece verirse `holderAlive` sonsuza kadar "canlı" der ve kilit hiç
 * bayatlamaz (probe: pid-alias-keeps-stale-lock). Kimliği güçlendirmek
 * (PID + süreç başlangıç zamanı, ya da token + heartbeat) doğru çözüm olurdu
 * ama kilidi ALAN taraf (scan.ts / cli.ts) holder dizesini kendi üretiyor ve
 * heartbeat'i sürdürecek bir döngü yok; bu yüzden BASİT ve doğrulanabilir olan
 * seçildi: yaş kontrolü artık canlılıkla kısa devre edilmiyor. Kalan risk,
 * 60 dakikadan uzun süren SAĞLIKLI bir taramanın kilidini kaybetmesi — ölçülen
 * çakışma 10 dakikadaydı ve devralma olay günlüğüne sebebiyle yazılıyor, yani
 * gerçekleşirse görünür olur.
 */
const STALE_MS = 60 * 60 * 1000;

/** Sahip aynı makinede canlı bir süreç mi? Değilse kilit gerçekten sahipsizdir. */
function holderAlive(holder: string): boolean {
  const m = /^pid:(\d+)$/.exec(holder);
  if (!m) return true; // tanımadığımız sahip biçimi: ölü sayma, güvenli taraf
  try {
    process.kill(Number(m[1]), 0); // sinyal yok, yalnız varlık sorgusu
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // var ama bizim değil
  }
}

export class ScanLockBusy extends Error {
  constructor(holder: string) {
    super(`başka bir tarama sürüyor (sahip: ${holder})`);
    this.name = "ScanLockBusy";
  }
}

export function acquireScanLock(store: Store, holder: string): void {
  store.tx(() => {
    const cur = store.get<{ holder: string; acquired_at: string }>("SELECT holder, acquired_at FROM scan_lock WHERE id = 1");
    if (cur) {
      const age = Date.now() - Date.parse(cur.acquired_at);
      const alive = holderAlive(cur.holder);
      // Okunamayan damga tazelik KANITI sayılmaz: bizim yazdığımız her satırda
      // geçerli ISO damga var, dolayısıyla ayrıştırılamayan bir damga zaten
      // yabancı bir yazıcıdan gelmiştir ve süresiz tutma hakkı doğurmaz.
      const stale = !Number.isFinite(age) || age >= STALE_MS;
      if (alive && !stale) throw new ScanLockBusy(cur.holder);
      // Devralma sessiz değil ize düşerek: `reason` olmadan "canlı sahibin
      // kilidi mi çalındı" sorusu günlükten cevaplanamıyor.
      const reason = alive ? "stale_age" : "dead_holder";
      store.run("INSERT INTO events (project_id, at, kind, detail) VALUES (NULL,?,?,?)",
        nowIso(), "scan_lock_stolen",
        JSON.stringify({ previousHolder: cur.holder, ageMs: Number.isFinite(age) ? age : null, reason }));
      store.run("DELETE FROM scan_lock WHERE id = 1");
    }
    store.run("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)", holder, nowIso());
  });
}

export function releaseScanLock(store: Store, holder: string): void {
  store.run("DELETE FROM scan_lock WHERE id = 1 AND holder = ?", holder);
}
