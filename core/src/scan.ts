// Tarama döngüsü: keşif → artımlı okuma → depoya durum + olaylar.
//
// Turn'lerin NE OLACAĞINA burası karar vermez; onTurns eline verir. M1'de CLI
// yalnız sayıyor, M2'de gözlemci partileyip Codex'e gönderecek. Bu ayrım
// bilinçli: tarama ile yorumlama farklı sorumluluklar.

import type { Store } from "./store/db.ts";
import type { DiscoveredProject, DiscoveredSession, TranscriptAdapter, Turn } from "./types.ts";
import type { DeliveryRange } from "./observer/batch.ts";
import { upsertProject, getCursor, getCursorByInode, setCursor, markScanned } from "./store/projects.ts";
import { logEvent } from "./store/events.ts";
import { readIncremental } from "./adapters/claude-code.ts";
import { BudgetHalt } from "./observe-cmd.ts";
import { withScanLock, type ScanLockHandle } from "./store/lock.ts";
import { realpath, stat } from "node:fs/promises";

/**
 * Gözlemcinin fırlattığı hata. Ayrı SINIF, çünkü önceki hâli hatanın üstüne
 * bir alan yazmaktı ve ilkel değer fırlatan bir gözlemci (throw "x") o alanı
 * taşıyamıyordu — okuma hatasıyla aynı kefeye giriyordu (doğrulama turu).
 */
export class ObserverError extends Error {
  readonly reason: unknown;
  constructor(reason: unknown) {
    super(`gözlemci hata verdi: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "ObserverError";
    this.reason = reason;
  }
}

/** Deponun kendisi yazamıyorsa tarama devam etmemeli — sessiz sonsuz tekrar olur. */
export class StoreFailure extends Error {
  readonly reason: unknown;
  constructor(reason: unknown) {
    super(`depo yazılamadı: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "StoreFailure";
    this.reason = reason;
  }
}

/** Bir taramada proje başına kaydedilecek en fazla farklı bilinmeyen tip. */
const MAX_UNKNOWN_TYPES_PER_SCAN = 20;

export interface ScanSummary {
  projects: number;
  sessionsTouched: number;
  turns: number;
  bytesRead: number;
  filteredBytes: number;
  skipped: number;
  unknown: number;
  malformed: number;
  truncations: number;
  unresolvedProjects: number;
  /** Okunamayan oturum sayısı — tarama devam eder, iz events'te kalır. */
  sessionErrors: number;
  /**
   * Maliyet bütçesi tarama ortasında doldu ve tarama ERKEN DURDU. Tarama bitti
   * DEĞİL yarım kaldı demek: kalan oturumlar hiç okunmadı, imleçleri
   * ilerlemedi. Çağıran bunu bir hata sayacıyla karıştırmasın diye ayrı alan.
   */
  budgetHalted: boolean;
}

export interface ScanOptions {
  adapter: TranscriptAdapter;
  /** ~/.claude/projects yerine başka bir kök (testler ve --dir için). */
  root?: string;
  /** Yalnız bu proje yollarını tara. */
  only?: string[];
  /**
   * Süzülmüş turn'ler buraya akar. M1'de sayaç, M2'de gözlemci.
   *
   * `range` TESLİMATIN KENDİ KİMLİĞİ: bu turn'ler dosyanın [from, to) bayt
   * aralığından çıktı. Tüketici "bunları daha önce işledim mi" sorusunu
   * turn'lerin içeriğinden TAHMİN etmek zorunda kalmasın diye taşınıyor —
   * tarama o cevabı zaten kesin biliyor (kök tasarım değişikliği 11 Ağu 2026;
   * ölçümler observer/batch.ts'te).
   */
  onTurns?: (ctx: {
    projectId: number;
    sessionId: string;
    turns: Turn[];
    range: DeliveryRange;
  }) => void | Promise<void>;
  /** Kilit sahibi kimliği; testlerde iki taramayı ayırt etmek için. */
  lockHolder?: string;
  /**
   * Kilit ALINDIKTAN sonra, iş başlamadan önce çağrılır; dönen fonksiyon iş
   * bitince (hata dâhil) koşar.
   *
   * Var olma sebebi ölçüldü (probe: scan-sigterm-leaves-lock): kilit taramanın
   * İÇİNDE alınıyor, dolayısıyla CLI onu kendi SIGINT/SIGTERM kancasına
   * bağlayamıyordu — `observe --session` ve `audit` bağlayabildiği için yalnız
   * `scan` yolu sinyalde kilidi asılı bırakıyordu. Kancanın KENDİSİ burada
   * kurulmuyor: sinyal makinesi CLI'ın işi, tarama yalnız tutamağı uzatıyor.
   */
  onLock?: (lock: ScanLockHandle) => () => void;
  /**
   * Dosya KİMLİĞİ ölçümü (gerçek yol + inode). Yalnız HATA YOLUNU sınamak için
   * ayrılmış dikiş.
   *
   * Neden dikiş gerekti: "keşif başardı ama realpath arızalandı" durumu gerçek
   * dosya sisteminde ancak bir YARIŞLA üretilebiliyor — deterministik olarak
   * realpath'i bozan her kurulum (asılı sembolik bağ, ELOOP döngüsü, kapalı
   * izinli dizin) `discover()` içindeki `stat`'ı da bozuyor, dolayısıyla oturum
   * scanSession'a hiç ulaşmıyor. Dikişsiz bu dal test edilemez, ve test
   * edilemeyen bir hata yolu bugün olduğu gibi sessizce yanlış davranır.
   */
  identityProbe?: IdentityProbe;
}

/** Oturum dosyasının kimliğini ölçen iki çağrı. Varsayılanı `node:fs/promises`. */
export interface IdentityProbe {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ ino: number | bigint }>;
}

const defaultIdentityProbe: IdentityProbe = { realpath, stat };

/** errno varsa sınıflandırılabilir sebep; yoksa undefined (ilkel değer fırlatılmış olabilir). */
function errnoOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function describeErr(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export async function scanOnce(store: Store, opts: ScanOptions): Promise<ScanSummary> {
  // Kilit taramanın TAMAMINI kapsar: imleci okuyup işleyip yazmak tek bir
  // mantıksal birim ve iki tarama arasında bölünmemeli. Kalp atışı da bu süre
  // boyunca sürer — sarmalayıcının işi.
  return await withScanLock(
    store,
    async (lock) => {
      // Sökme `finally`de: kanca listesi süreç ömrü boyunca yaşıyor, bırakılan
      // her giriş kapanmış bir kilide dokunmaya çalışan ölü bir kayıt olurdu.
      const off = opts.onLock?.(lock);
      try {
        return await scanAll(store, opts);
      } finally {
        off?.();
      }
    },
    { holder: opts.lockHolder },
  );
}

async function scanAll(store: Store, opts: ScanOptions): Promise<ScanSummary> {
  const adapter = opts.adapter;

  // Silme korumaları hâlâ yerinde mi? Ucuz; kaybını fark etmemek pahalı.
  store.verifyGuards();

  // Keşif de I/O ve o da patlayabiliyor. Oturum başına sınır keşfi kapsamıyordu:
  // discover() içindeki tek bir ENOENT tüm taramayı iz bırakmadan öldürüyordu.
  let found: DiscoveredProject[];
  try {
    found = await adapter.discover(opts.root);
  } catch (err) {
    logEvent(store, {
      kind: "discovery_failed",
      detail: { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
    });
    throw err;
  }

  const sum: ScanSummary = {
    projects: 0, sessionsTouched: 0, turns: 0, bytesRead: 0, filteredBytes: 0,
    skipped: 0, unknown: 0, malformed: 0, truncations: 0, unresolvedProjects: 0,
    sessionErrors: 0, budgetHalted: false,
  };

  for (const proj of found) {
    if (opts.only && !opts.only.includes(proj.path)) continue;
    sum.projects++;

    const projectId = upsertProject(store, {
      path: proj.path,
      adapterId: adapter.id,
      transcriptDir: proj.transcriptDir,
      memoryDir: proj.memoryDir,
    });

    if (proj.error) {
      sum.sessionErrors++;
      logEvent(store, { projectId, kind: "discovery_failed", detail: { transcriptDir: proj.transcriptDir, error: proj.error } });
    }

    // Okuma ARIZASI yüzünden cwd bulunamadıysa bu, projenin yolu tahminle
    // kaydedilmiş olabileceği anlamına gelir ve düzeltilebilir bir durumdur —
    // "cwd yok"tan ayrı kayıt. Proje `unresolved` olmasa bile yazılır: tahmin
    // TUTMUŞ olabilir ve o zaman hiçbir yerde iz kalmazdı.
    const failedProbes = (proj.cwdProbes ?? []).filter((p) => p.outcome !== "no_cwd");
    if (failedProbes.length > 0) {
      logEvent(store, {
        projectId,
        kind: "cwd_probe_failed",
        detail: { transcriptDir: proj.transcriptDir, probes: failedProbes },
      });
    }

    if (proj.unresolved) {
      sum.unresolvedProjects++;
      // Atlanmıyor, raporlanıyor: sessiz düşen proje hiç görünmeyen projedir.
      // `probes` burada: "anahtar çözülemedi" satırı tek başına SEBEBİ
      // söylemiyordu — dosyalar okunamadı mı, yoksa gerçekten cwd'siz mi.
      logEvent(store, {
        projectId,
        kind: "unresolved_project_key",
        detail: { transcriptDir: proj.transcriptDir, probes: proj.cwdProbes ?? [] },
      });
    }

    for (const session of proj.sessions) {
      try {
        await scanSession(store, opts, projectId, session, sum);
      } catch (err) {
        // Bütçe bitişi hata değil erken durdurma: oturum başına observer_failed
        // üretmek yerine TEK olay yazılır ve tarama durur — kalan oturumların
        // imleçleri ilerlemediği için veri kaybı yok (en-az-bir-kez). Kontrol
        // StoreFailure'dan da ÖNCE, çünkü sınıflandırma sırası burada anlam
        // taşıyor: bütçe bir arıza sınıfı değil.
        if (err instanceof ObserverError && err.reason instanceof BudgetHalt) {
          sum.budgetHalted = true;
          logEvent(store, {
            projectId,
            kind: "observer_budget_halt",
            detail: { sessionId: session.sessionId },
          });
          break;
        }

        // Depo yazamıyorsa devam etmek anlamsız: imleç ilerlemeyeceği için her
        // tarama aynı veriyi yeniden teslim eder. Yutulmaz, yukarı fırlar.
        if (err instanceof StoreFailure) throw err;

        // Tek bir bozuk oturum ise tüm taramayı öldürmemeli. Ölçüldü: keşif ile
        // okuma arasında silinen bir dosya ENOENT atıyor, sonraki sağlam
        // projeler hiç işlenmiyordu — arka plan aracı için sessiz ölüm en kötüsü.
        sum.sessionErrors++;
        // Gözlemci hatası ile okuma hatası ayrı sınıflar: biri tüketici, diğeri
        // girdi problemi. Karışırsa M2'de hangi tarafın bozulduğu görünmez olur.
        const isObserver = err instanceof ObserverError;
        logEvent(store, {
          projectId,
          kind: isObserver ? "observer_failed" : "session_read_failed",
          detail: {
            sessionId: session.sessionId,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          },
        });
      }
    }

    // markScanned bu dalda ÇAĞRILMAZ: proje yarım tarandı ve "en son şu an
    // tarandı" damgası, hiç okunmamış oturumları taranmış gibi gösterirdi —
    // tetikleyici mantığı (spec §2.4) o damgaya bakıyor.
    if (sum.budgetHalted) break;

    markScanned(store, projectId);
  }

  logEvent(store, { kind: "scan_completed", detail: sum });
  return sum;
}

async function scanSession(
  store: Store,
  opts: ScanOptions,
  projectId: number,
  session: DiscoveredSession,
  sum: ScanSummary,
): Promise<void> {
  // Anahtar GERÇEK yol: aynı fiziksel dosyaya iki yoldan ulaşılabiliyordu
  // (sembolik bağ, sabit bağ) ve aynı akış iki kez teslim ediliyordu.
  //
  // HİÇBİR ÖLÇÜM KİMLİĞİ KURAMAZSA oturum bu turda ATLANIR — sessizce ham yola
  // DÜŞÜLMEZ. Eski hâl `realpath(...).catch(() => session.filePath)` idi ve arızayı
  // errno'ya bakmadan yutuyordu: anahtar "gerçek yol" olmaktan çıkıyor, aynı
  // fiziksel akış bir sembolik bağ üzerinden İKİNCİ bir anahtarla kaydediliyor
  // ve İKİ KEZ teslim ediliyordu — yani bir satır yukarıdaki gerekçenin tam
  // tersi. `stat` dalında bedel daha da somut: inode araması düşünce imleç
  // bulunamıyor, `from` 0 oluyor ve akışın TAMAMI yeniden teslim ediliyordu.
  //
  // Atlamanın imleç sözleşmesine etkisi: YOK, çünkü imleç yazılmıyor. M1'de
  // kurulan "en az bir kez teslim" korunuyor (sonraki tarama aynı baytları
  // baştan okur); zayıflayan taraf yok, yalnız bir teslimat ERTELENİYOR.
  // Sözleşmenin diğer yüzü — "aynı akış tek anahtar altında" — ise ancak
  // böyle korunuyor: ölçemediğimiz bir kimliği uydurmak onu kırıyordu.
  //
  // Ayrım detayda: `missing` (ENOENT) "dosya gerçekten yok" demek — keşifle
  // okuma arasında silinmiş, atlanması zaten doğru; ENOENT dışı her errno bir
  // ÖLÇÜM ARIZASI (izin, ELOOP, EIO) ve düzeltilebilir bir durumu işaret eder.
  const probe = opts.identityProbe ?? defaultIdentityProbe;
  // Denenen ölçümlerin dökümü olayın detayına giriyor: "kimlik kurulamadı"
  // tek başına teşhis değil, HANGİ ölçümün neden düştüğü teşhis.
  const tried: { probe: "realpath" | "stat"; code: string | null; error: string }[] = [];
  const noteFailure = (which: "realpath" | "stat", err: unknown): void => {
    tried.push({ probe: which, code: errnoOf(err) ?? null, error: describeErr(err) });
  };
  /**
   * Ölçüm arızasını olaya çevirir. `resolved`, kimliğin arızaya RAĞMEN
   * kurulup kurulmadığını söyler — ikisi ayrı sorular ve ayrı raporlanıyor.
   *
   * `probe`/`code`/`missing` alanları İLK arızayı anlatır (geriye dönük uyumlu;
   * denenenlerin tamamı `tried`'da). İlk arıza seçildi çünkü sonraki ölçüm
   * çoğu zaman ilkinin sebebini tekrar ediyor (silinmiş dosya: iki kez ENOENT).
   */
  const logIdentityFailure = (resolved: boolean, recoveredBy: string | null): void => {
    if (tried.length === 0) return;
    sum.sessionErrors++;
    const first = tried[0]!;
    logEvent(store, {
      projectId,
      kind: "cursor_identity_failed",
      detail: {
        sessionId: session.sessionId,
        filePath: session.filePath,
        probe: first.probe,
        code: first.code,
        missing: first.code === "ENOENT",
        error: first.error,
        tried,
        resolved,
        recoveredBy,
      },
    });
  };

  // Kimliğin İKİ ölçümü var ve ikisi de tek başına yeterli: gerçek yol
  // (realpath) ve inode (stat). Doğrulama turu ölçtü (14 Ağu): realpath
  // arızasında doğrudan dönmek, sürekli EIO veren ama dosyası okunabilen bir
  // oturumu HER taramada atlıyor — imleç ilerlemediği için mükerrer teslimat
  // yerine SÜREKLİ TESLİMATSIZLIK oluyor, yani takas yanlış tarafa kayıyor.
  // Atlama artık son çare: ancak İKİ ölçüm de kimliği kuramazsa.
  let realPath: string | null = null;
  try {
    realPath = await probe.realpath(session.filePath);
  } catch (err) {
    noteFailure("realpath", err);
  }

  // realpath düşse de ham yol bir ANAHTAR ADAYI. Mükerrer teslimatı önleyen şey
  // anahtarın "gerçek yol" olması DEĞİL, inode indeksinin aynı fiziksel akışı
  // tek kayıtta buluşturması: aşağıda kayıt bulunamazsa inode aranıyor, ve
  // yazılan imleç `res.inode`'u taşıdığı için sonraki taramalar (realpath
  // çalışsın ya da çalışmasın) aynı kaydı buluyor.
  const cursorKey = realPath ?? session.filePath;
  let cursor = getCursor(store, cursorKey);
  let recoveredBy: string | null = realPath === null && cursor ? "cursor-path" : null;
  if (!cursor) {
    // Yol bilinmiyor: aynı akış başka bir adla (sabit bağ) kayıtlı olabilir.
    // Bu sorunun cevabı ALINAMIYORSA "kayıtlı değil" varsayılamaz — o varsayım
    // tam olarak mükerrer teslimat demek.
    let ino: string | null = null;
    try {
      ino = String((await probe.stat(session.filePath)).ino);
    } catch (err) {
      noteFailure("stat", err);
    }
    if (ino === null) {
      // Burada gerçekten kimlik YOK: ne kayıtlı bir yol eşleşmesi ne inode.
      // (realpath başarılı olsa bile: kayıt başka bir adla duruyor olabilir ve
      // bunu eleyecek ölçüm inode'du.) Atlanıyor — imleç yazılmadığı için
      // "en az bir kez teslim" sözleşmesi korunuyor, teslimat yalnız erteleniyor.
      logIdentityFailure(false, null);
      return;
    }
    cursor = getCursorByInode(store, ino);
    if (realPath === null) recoveredBy = cursor ? "inode" : "stat";
  }
  logIdentityFailure(true, recoveredBy);
  const from = cursor?.byteOffset ?? 0;

  // Burada "dosya büyümemişse atla" kısayolu YOK, bilerek. Önceki hâlinde
  // vardı ve kısalma tespitini ulaşılamaz kılıyordu: yerinde kısaltılan ya da
  // aynı boyutta değiştirilen bir dosya, imleç EOF'un ötesinde kaldığı için
  // hiç açılmıyordu. readIncremental zaten stat sonrası erken dönüyor —
  // kısayolun kazancı bir stat, bedeli sessiz veri kaybıydı.
  const res = await readIncremental(session.filePath, from, cursor?.inode ?? null, cursor?.mtimeMs ?? null);

  if (res.truncated) {
    sum.truncations++;
    logEvent(store, {
      projectId,
      kind: "truncation_detected",
      detail: { sessionId: session.sessionId, previousOffset: from },
    });
  }

  // Tip başına tek olay — ama sınırsız değil. Denetimde ölçüldü: 2048 farklı
  // uydurma tip 2048 kalıcı satır üretiyordu ve events silinemez olduğu için
  // şişme geri alınamıyordu. Sınır üstü tipler sayı olarak tek satırda özetlenir.
  let logged = 0;
  let overflow = 0;
  for (const [lineType, info] of res.unknownTypes) {
    if (logged >= MAX_UNKNOWN_TYPES_PER_SCAN) { overflow++; continue; }
    logged++;
    logEvent(store, {
      projectId,
      kind: "unknown_line_type",
      detail: { sessionId: session.sessionId, lineType, count: info.count, shape: info.shape },
    });
  }
  if (overflow > 0) {
    logEvent(store, {
      projectId,
      kind: "unknown_type_overflow",
      detail: { sessionId: session.sessionId, suppressedTypes: overflow, loggedTypes: logged },
    });
  }
  if (res.counts.malformed > 0) {
    logEvent(store, {
      projectId,
      kind: "malformed_line",
      detail: { sessionId: session.sessionId, count: res.counts.malformed },
    });
  }

  if (res.turns.length > 0 || res.byteOffset !== from) {
    sum.sessionsTouched++;
    sum.turns += res.turns.length;
    sum.bytesRead += res.byteOffset - (res.truncated ? 0 : from);
    for (const t of res.turns) sum.filteredBytes += Buffer.byteLength(t.text, "utf8");
    sum.skipped += res.counts.skipped;
    sum.unknown += res.counts.unknown;
    sum.malformed += res.counts.malformed;

    // onTurns ÖNCE, imleç SONRA: teslim en-az-bir-kez sözleşmesidir. Gözlemci
    // yazıp da imleç yazılmadan çökerse aynı turn tekrar gelir — kabul edilen
    // bedel bu; ters sıra ise turn'ü kalıcı olarak kaybederdi. Tekrarı tüketici
    // teslimatın bayt aralığıyla eler (aşağıdaki `range`).
    if (opts.onTurns && res.turns.length > 0) {
      // Kısalmada okuma 0'dan başladı: aralığın başı da 0'dır. Eski `from`
      // değeri artık başka bir dosyanın ofseti — taşınırsa tüketici işlenmiş
      // sayıp yeni dosyanın başını atlar.
      const range: DeliveryRange = {
        from: res.truncated ? 0 : from,
        to: res.byteOffset,
        truncated: res.truncated,
      };
      try {
        await opts.onTurns({ projectId, sessionId: session.sessionId, turns: res.turns, range });
      } catch (err) {
        // İmleç yazılmadan yeniden fırlatılıyor: turn kaybolmaz, sonraki
        // taramada yeniden teslim edilir (en-az-bir-kez).
        throw new ObserverError(err);
      }
    }

    try {
      setCursor(store, projectId, session.sessionId, {
        filePath: cursor?.filePath ?? cursorKey,
        byteOffset: res.byteOffset,
        inode: res.inode,
        mtimeMs: res.mtimeMs,
      });
    } catch (err) {
      throw new StoreFailure(err);
    }
  }
}
