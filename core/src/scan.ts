// Tarama döngüsü: keşif → artımlı okuma → depoya durum + olaylar.
//
// Turn'lerin NE OLACAĞINA burası karar vermez; onTurns eline verir. M1'de CLI
// yalnız sayıyor, M2'de gözlemci partileyip Codex'e gönderecek. Bu ayrım
// bilinçli: tarama ile yorumlama farklı sorumluluklar.

import type { Store } from "./store/db.ts";
import type { DiscoveredProject, TranscriptAdapter, Turn } from "./types.ts";
import { upsertProject, getCursor, setCursor, markScanned } from "./store/projects.ts";
import { logEvent } from "./store/events.ts";
import { readIncremental } from "./adapters/claude-code.ts";

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
}

export interface ScanOptions {
  adapter: TranscriptAdapter;
  /** ~/.claude/projects yerine başka bir kök (testler ve --dir için). */
  root?: string;
  /** Yalnız bu proje yollarını tara. */
  only?: string[];
  /** Süzülmüş turn'ler buraya akar. M1'de sayaç, M2'de gözlemci. */
  onTurns?: (ctx: { projectId: number; sessionId: string; turns: Turn[] }) => void | Promise<void>;
}

export async function scanOnce(store: Store, opts: ScanOptions): Promise<ScanSummary> {
  const adapter = opts.adapter;
  const found: DiscoveredProject[] = await adapter.discover(opts.root);

  const sum: ScanSummary = {
    projects: 0, sessionsTouched: 0, turns: 0, bytesRead: 0, filteredBytes: 0,
    skipped: 0, unknown: 0, malformed: 0, truncations: 0, unresolvedProjects: 0,
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
      const cursor = getCursor(store, projectId, session.sessionId);
      const from = cursor?.byteOffset ?? 0;

      // Dosya büyümediyse dokunma — 64 transcript'lik siloda çoğu tur bu daldan döner.
      if (cursor && from >= session.sizeBytes && cursor.inode !== null) continue;

      const res = await readIncremental(session.filePath, from, cursor?.inode ?? null);

      if (res.truncated) {
        sum.truncations++;
        logEvent(store, {
          projectId,
          kind: "truncation_detected",
          detail: { sessionId: session.sessionId, previousOffset: from },
        });
      }

      for (const u of res.unknownSamples) {
        logEvent(store, {
          projectId,
          kind: "unknown_line_type",
          detail: { sessionId: session.sessionId, lineType: u.lineType, sample: u.sample },
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

        if (opts.onTurns && res.turns.length > 0) {
          await opts.onTurns({ projectId, sessionId: session.sessionId, turns: res.turns });
        }

        setCursor(store, projectId, session.sessionId, {
          filePath: session.filePath,
          byteOffset: res.byteOffset,
          inode: res.inode,
        });
      }
    }

    markScanned(store, projectId);
  }

  logEvent(store, { kind: "scan_completed", detail: sum });
  return sum;
}
