import { execFileSync } from "node:child_process";
import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";

/**
 * Tek yazar kilidi. Denetimde ölçüldü: iki tarama aynı anda koşunca aynı bayt
 * aralığını okuyup gözlemciye İKİ KEZ teslim ediyorlardı — imleci okumak,
 * işlemek ve yazmak atomik bir birim değil.
 *
 * Kilit tavsiye niteliğinde değil, zorunlu: alınamıyorsa tarama hiç başlamaz.
 * Sahibi çökünce sistemin kilitli kalmaması için devralma kuralı var; koşulları
 * aşağıda.
 */
/**
 * SAHİP KİMLİĞİ = PID + SÜRECİN BAŞLANGIÇ ZAMANI.
 *
 * Üç ayrı kilit bulgusu tek eksiklikten doğdu: kimlik yalnız PID'ydi. PID hem
 * yalan söylüyordu (ölen sahibin numarasını devralan yabancı süreç sonsuza dek
 * "canlı" görünüyordu — probe: pid-alias-keeps-stale-lock) hem de yetersizdi:
 * "canlı mı ölü mü" sorusuna güvenilir cevap veremeyince YAŞA başvuruldu ve yaş
 * TEK BAŞINA devralma yetkisi hâline geldi. Sonuç ölçüldü
 * (probe: live-lock-stolen-after-hour): SAĞLIKLI ama uzun süren bir denetimin
 * kilidi 60 dakikayı geçince çalınıyor ve kilidin var olma sebebi olan mükerrer
 * teslimat yarışı geri geliyordu.
 *
 * Başlangıç zamanı eklenince canlılık güvenilir bir ölçüt olur ve karar
 * ağacındaki yaş yalnız SON ÇARE kalır:
 *
 *   1) Kimlik doğrulandı + süreç YAŞIYOR  → kilit ASLA çalınmaz, yaşı ne olursa
 *      olsun. Uzun denetim meşrudur.
 *   2) Süreç ÖLÜ                          → hemen devralınır (`dead_holder`).
 *      Yaş beklenmez: Ctrl-C'de `finally` koşmuyor, kilit satırı ölü bir PID ve
 *      YEPYENİ bir damgayla diskte kalıyor; hemen-tekrar mümkün olmalı
 *      (probe: dead-lock-blocks-retry).
 *   3) Kayıttaki başlangıç zamanı o PID'nin BUGÜNKÜ başlangıç zamanıyla
 *      uyuşmuyor → eski sahip ölmüş, numarası yeniden kullanılmış → hemen
 *      devralınır (`pid_reused`).
 *   4) Başlangıç zamanı hiç ÖLÇÜLEMİYOR (kayıtta yok: yabancı/eski bir yazıcı;
 *      ya da `ps` yok, farklı makine, paylaşılan depo) → kimlik doğrulanamıyor
 *      demektir; ancak O ZAMAN yaşa düşülür ve düşüş olayın gerekçesine yazılır
 *      (`identity_unverifiable_stale_age`).
 *
 * Damgayı kilidi ALAN taraf değil bu modül basıyor: çağıranlar (scan.ts,
 * cli.ts) holder dizesini kendileri üretiyor ve kimliğin doğrulanabilirliği
 * çağırana bırakılırsa bir çağıranın unutması sessizce (4)'e düşürür.
 */
const STALE_MS = 60 * 60 * 1000;

/** `pid:<n>` ya da kimlik damgalı `pid:<n>@started:<lstart>`. */
const HOLDER_RE = /^pid:(\d+)(?:@started:(.+))?$/;

/**
 * Sürecin başlangıç zamanı. `ps -p <pid> -o lstart=` macOS ve Linux'ta çalışıyor;
 * yeni bağımlılık değil, alt süreç. Maliyeti önemsiz: kilit alımı komut başına
 * bir kez oluyor.
 *
 * Ölçülemezse `null` — bu bir hata değil, "kimlik doğrulanamıyor" bilgisidir ve
 * yukarıdaki (4) dalını tetikler. Boşluklar tekilleştiriliyor: aynı sürecin iki
 * ayrı `ps` çağrısı hizalama boşluğunda farklılık gösterebiliyor ve kimlik
 * karşılaştırması bundan etkilenmemeli.
 */
function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // LC_ALL=C ŞART: `lstart` yerelleştirilmiş bir tarih ("Çar 12 Ağu ...").
      // Damgayı yazan ile ölçen AYRI süreçler ve yerelleri farklı olabilir;
      // sabitlenmezse aynı sürecin iki ölçümü farklı dizeler verir, bu da
      // `pid_reused` sanılıp CANLI bir sahibin kilidinin çalınmasına yol açardı
      // — düzeltmeye çalıştığımız arızanın ta kendisi.
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const t = out.trim().replace(/\s+/g, " ");
    return t.length > 0 ? t : null;
  } catch {
    return null; // ps yok, PID yok, ya da izin yok
  }
}

/** Kendi başlangıç zamanımız süreç ömrü boyunca sabit: bir kez ölçülür. */
let ownStart: string | null | undefined;
function ownStartTime(): string | null {
  if (ownStart === undefined) ownStart = processStartTime(process.pid);
  return ownStart;
}

/**
 * Kendi PID'mizi gösteren bir holder dizesine kimlik damgasını basar. Damga
 * DETERMİNİSTİK: `releaseScanLock` aynı dizeyi yeniden üretebilsin diye (kilit
 * satırı sahip eşleşmesiyle siliniyor).
 *
 * Başkasının PID'sini taşıyan ya da tanımadığımız biçimdeki holder olduğu gibi
 * kalır: onun adına başlangıç zamanı damgalamak, ölçmediğimiz bir kimliği
 * doğrulanmış göstermek olurdu.
 */
export function stampHolderIdentity(holder: string): string {
  const m = HOLDER_RE.exec(holder);
  if (!m || m[2] !== undefined || Number(m[1]) !== process.pid) return holder;
  const start = ownStartTime();
  return start === null ? holder : `${holder}@started:${start}`;
}

/** Sahip aynı makinede canlı bir süreç mi? */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // sinyal yok, yalnız varlık sorgusu
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // var ama bizim değil
  }
}

type Verdict = { steal: false } | { steal: true; reason: string };

/**
 * Var olan kilit devralınabilir mi? Karar ağacı modül başındaki (1)–(4).
 * `age` yalnız (4) dalında okunuyor — yaşın devralma tetikleyicisi OLMAMASI bu
 * düzeltmenin bütün konusu.
 */
function judge(holder: string, age: number): Verdict {
  const m = HOLDER_RE.exec(holder);
  // Tanımadığımız sahip biçimi: canlılık da kimlik de ölçülemez → (4).
  if (!m) return ageVerdict(age);

  const pid = Number(m[1]);
  const recordedStart = m[2];
  if (!pidAlive(pid)) return { steal: true, reason: "dead_holder" };
  if (recordedStart === undefined) return ageVerdict(age); // damgasız kayıt → (4)

  const currentStart = processStartTime(pid);
  if (currentStart === null) return ageVerdict(age); // `ps` konuşamadı → (4)
  if (currentStart !== recordedStart) return { steal: true, reason: "pid_reused" };
  // (1): kimlik doğrulandı ve süreç yaşıyor. Yaş SORULMUYOR.
  return { steal: false };
}

/**
 * Kimlik doğrulanamadığında kalan tek ölçüt. Okunamayan damga tazelik KANITI
 * sayılmaz: bizim yazdığımız her satırda geçerli ISO damga var, dolayısıyla
 * ayrıştırılamayan bir damga yabancı bir yazıcıdan gelmiştir ve süresiz tutma
 * hakkı doğurmaz.
 */
function ageVerdict(age: number): Verdict {
  const stale = !Number.isFinite(age) || age >= STALE_MS;
  return stale ? { steal: true, reason: "identity_unverifiable_stale_age" } : { steal: false };
}

export class ScanLockBusy extends Error {
  constructor(holder: string) {
    super(`başka bir tarama sürüyor (sahip: ${holder})`);
    this.name = "ScanLockBusy";
  }
}

export function acquireScanLock(store: Store, holder: string): void {
  const stamped = stampHolderIdentity(holder);
  store.tx(() => {
    const cur = store.get<{ holder: string; acquired_at: string }>("SELECT holder, acquired_at FROM scan_lock WHERE id = 1");
    if (cur) {
      const age = Date.now() - Date.parse(cur.acquired_at);
      const verdict = judge(cur.holder, age);
      if (!verdict.steal) throw new ScanLockBusy(cur.holder);
      // Devralma sessiz değil ize düşerek: `reason` olmadan "canlı sahibin
      // kilidi mi çalındı" sorusu günlükten cevaplanamıyor. Ayrık sebepler
      // aynı zamanda (4) dalına — kimliği doğrulanamayan devralmaya — kaç kez
      // düşüldüğünü ÖLÇÜLEBİLİR kılıyor.
      store.run("INSERT INTO events (project_id, at, kind, detail) VALUES (NULL,?,?,?)",
        nowIso(), "scan_lock_stolen",
        JSON.stringify({ previousHolder: cur.holder, ageMs: Number.isFinite(age) ? age : null, reason: verdict.reason }));
      store.run("DELETE FROM scan_lock WHERE id = 1");
    }
    store.run("INSERT INTO scan_lock (id, holder, acquired_at) VALUES (1,?,?)", stamped, nowIso());
  });
}

export function releaseScanLock(store: Store, holder: string): void {
  // İki biçim de kabul: damgalama `ps`'e bağlı ve alım ile bırakma arasında
  // ölçüm başarısız olabilir. Eşleşmeyen bir DELETE sessizce hiçbir şey yapar,
  // yani kilit sahibi öldüğü hâlde diskte kalırdı — kendi kilidimizi bırakamamak
  // en pahalı sessiz arıza olurdu.
  store.run("DELETE FROM scan_lock WHERE id = 1 AND holder IN (?,?)", stampHolderIdentity(holder), holder);
}
