import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";

/**
 * Tek yazar kilidi. Denetimde ölçüldü: iki tarama aynı anda koşunca aynı bayt
 * aralığını okuyup gözlemciye İKİ KEZ teslim ediyorlardı — imleci okumak,
 * işlemek ve yazmak atomik bir birim değil.
 *
 * Kilit tavsiye niteliğinde değil, zorunlu: alınamıyorsa tarama hiç başlamaz.
 * Sahibi çöktüğünde sistemin kilitli kalmaması için bayatlama süresi var.
 */
// Zaman aşımı tek başına yanlış ölçüttü: uzun ama SAĞLIKLI bir tarama 10 dk'yı
// geçince kilidi çalınıyor ve iki tarama gerçekten çakışıyordu (doğrulama turu).
// Doğru ölçüt sahibin hâlâ yaşayıp yaşamadığı; süre yalnız ikinci basamak.
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
      // Sahip yaşıyorsa süre ne olursa olsun kilit onundur.
      if (holderAlive(cur.holder)) throw new ScanLockBusy(cur.holder);
      if (Number.isFinite(age) && age < STALE_MS) throw new ScanLockBusy(cur.holder);
      // Bayat kilit devralınıyor; sessizce değil, ize düşerek.
      store.run("INSERT INTO events (project_id, at, kind, detail) VALUES (NULL,?,?,?)",
        nowIso(), "scan_lock_stolen", JSON.stringify({ previousHolder: cur.holder, ageMs: age }));
      store.run("DELETE FROM scan_lock WHERE id = 1");
    }
    store.run("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)", holder, nowIso());
  });
}

export function releaseScanLock(store: Store, holder: string): void {
  store.run("DELETE FROM scan_lock WHERE id = 1 AND holder = ?", holder);
}
