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
import { acquireScanLock, releaseScanLock } from "./store/lock.ts";
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
}

export async function scanOnce(store: Store, opts: ScanOptions): Promise<ScanSummary> {
  // Kilit taramanın TAMAMINI kapsar: imleci okuyup işleyip yazmak tek bir
  // mantıksal birim ve iki tarama arasında bölünmemeli.
  const holder = opts.lockHolder ?? `pid:${process.pid}`;
  acquireScanLock(store, holder);
  try {
    return await scanAll(store, opts);
  } finally {
    releaseScanLock(store, holder);
  }
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

    if (proj.unresolved) {
      sum.unresolvedProjects++;
      // Atlanmıyor, raporlanıyor: sessiz düşen proje hiç görünmeyen projedir.
      logEvent(store, {
        projectId,
        kind: "unresolved_project_key",
        detail: { transcriptDir: proj.transcriptDir },
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
  const cursorKey = await realpath(session.filePath).catch(() => session.filePath);
  let cursor = getCursor(store, cursorKey);
  if (!cursor) {
    // Yol bilinmiyor: aynı akış başka bir adla (sabit bağ) kayıtlı olabilir.
    const ino = await stat(session.filePath).then((st) => String(st.ino)).catch(() => null);
    if (ino) cursor = getCursorByInode(store, ino);
  }
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
