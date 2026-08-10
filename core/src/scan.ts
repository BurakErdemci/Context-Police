// Tarama döngüsü: keşif → artımlı okuma → depoya durum + olaylar.
//
// Turn'lerin NE OLACAĞINA burası karar vermez; onTurns eline verir. M1'de CLI
// yalnız sayıyor, M2'de gözlemci partileyip Codex'e gönderecek. Bu ayrım
// bilinçli: tarama ile yorumlama farklı sorumluluklar.

import type { Store } from "./store/db.ts";
import type { DiscoveredProject, DiscoveredSession, TranscriptAdapter, Turn } from "./types.ts";
import { upsertProject, getCursor, setCursor, markScanned } from "./store/projects.ts";
import { logEvent } from "./store/events.ts";
import { readIncremental } from "./adapters/claude-code.ts";
import { acquireScanLock, releaseScanLock } from "./store/lock.ts";

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
}

export interface ScanOptions {
  adapter: TranscriptAdapter;
  /** ~/.claude/projects yerine başka bir kök (testler ve --dir için). */
  root?: string;
  /** Yalnız bu proje yollarını tara. */
  only?: string[];
  /** Süzülmüş turn'ler buraya akar. M1'de sayaç, M2'de gözlemci. */
  onTurns?: (ctx: { projectId: number; sessionId: string; turns: Turn[] }) => void | Promise<void>;
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
  const found: DiscoveredProject[] = await adapter.discover(opts.root);

  const sum: ScanSummary = {
    projects: 0, sessionsTouched: 0, turns: 0, bytesRead: 0, filteredBytes: 0,
    skipped: 0, unknown: 0, malformed: 0, truncations: 0, unresolvedProjects: 0,
    sessionErrors: 0,
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
        // Tek bir bozuk oturum tüm taramayı öldürmemeli. Denetimde ölçüldü:
        // keşif ile okuma arasında silinen bir dosya ENOENT atıyor, sonraki
        // sağlam projeler hiç işlenmiyor ve depoda hiçbir iz kalmıyordu —
        // arka planda koşan bir araç için sessiz ölüm en kötü davranış.
        sum.sessionErrors++;
        // Gözlemci hatası ile okuma hatası ayrı sınıflar: biri girdi
        // problemi, diğeri tüketici problemi. Karıştırılırsa M2'de hangi
        // tarafın bozulduğu görünmez olur.
        logEvent(store, {
          projectId,
          kind: (err as { cpObserver?: boolean })?.cpObserver ? "observer_failed" : "session_read_failed",
          detail: {
            sessionId: session.sessionId,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          },
        });
      }
    }

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
  const cursor = getCursor(store, session.filePath);
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

  // Tip başına tek olay: hem içerik taşımaz hem hiçbir tip sayı sınırına kurban gitmez.
  for (const [lineType, info] of res.unknownTypes) {
    logEvent(store, {
      projectId,
      kind: "unknown_line_type",
      detail: { sessionId: session.sessionId, lineType, count: info.count, shape: info.shape },
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
    // bedel bu; ters sıra ise turn'ü kalıcı olarak kaybederdi. M2 tekrarı
    // source_ref (oturum + uuid) ile elemek zorunda.
    if (opts.onTurns && res.turns.length > 0) {
      try {
        await opts.onTurns({ projectId, sessionId: session.sessionId, turns: res.turns });
      } catch (err) {
        // İmleç yazılmadan yeniden fırlatılıyor: turn kaybolmaz, sonraki
        // taramada yeniden teslim edilir (en-az-bir-kez).
        Object.assign(err as object, { cpObserver: true });
        throw err;
      }
    }

    setCursor(store, projectId, session.sessionId, {
      filePath: session.filePath,
      byteOffset: res.byteOffset,
      inode: res.inode,
      mtimeMs: res.mtimeMs,
    });
  }
}
