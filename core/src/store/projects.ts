import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";

export interface ProjectInput {
  path: string;
  adapterId: string;
  transcriptDir: string;
  memoryDir?: string | null;
}

export interface CursorState {
  filePath: string;
  byteOffset: number;
  inode: string | null;
}

/** Aynı yol iki kez kaydedilmez; memory_dir sonradan bulunursa güncellenir. */
export function upsertProject(store: Store, p: ProjectInput): number {
  const existing = store.get<{ id: number }>("SELECT id FROM projects WHERE path = ?", p.path);
  if (existing) {
    store.run(
      "UPDATE projects SET adapter_id = ?, transcript_dir = ?, memory_dir = COALESCE(?, memory_dir) WHERE id = ?",
      p.adapterId,
      p.transcriptDir,
      p.memoryDir ?? null,
      existing.id,
    );
    return existing.id;
  }
  return store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    p.path,
    p.adapterId,
    p.transcriptDir,
    p.memoryDir ?? null,
  ).lastInsertRowid;
}

export function getCursor(store: Store, projectId: number, sessionId: string): CursorState | null {
  const row = store.get<{ file_path: string; byte_offset: number; inode: string | null }>(
    "SELECT file_path, byte_offset, inode FROM cursors WHERE project_id = ? AND session_id = ?",
    projectId,
    sessionId,
  );
  return row ? { filePath: row.file_path, byteOffset: row.byte_offset, inode: row.inode } : null;
}

/**
 * İmleç yalnız ileri gider. Geriye yazım ancak inode değiştiyse (dosyanın yerine
 * yenisi kondu) kabul edilir — aksi hâlde sessiz veri tekrarına yol açardı.
 * Çağıran kısalmayı tespit edip inode'u değiştirerek bilinçli sıfırlar.
 */
export function setCursor(
  store: Store,
  projectId: number,
  sessionId: string,
  next: CursorState,
): void {
  const prev = getCursor(store, projectId, sessionId);
  if (prev && next.byteOffset < prev.byteOffset && prev.inode === next.inode) {
    throw new Error(
      `imleç geri alınamaz (session=${sessionId}): ${prev.byteOffset} → ${next.byteOffset}, inode aynı`,
    );
  }
  store.run(
    `INSERT INTO cursors (project_id, session_id, file_path, byte_offset, inode, last_seen_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (project_id, session_id) DO UPDATE SET
       file_path = excluded.file_path,
       byte_offset = excluded.byte_offset,
       inode = excluded.inode,
       last_seen_at = excluded.last_seen_at`,
    projectId,
    sessionId,
    next.filePath,
    next.byteOffset,
    next.inode,
    nowIso(),
  );
}

export function markScanned(store: Store, projectId: number): void {
  store.run("UPDATE projects SET last_scanned_at = ? WHERE id = ?", nowIso(), projectId);
}

export function listProjects(store: Store) {
  return store.all<{ id: number; path: string; memory_dir: string | null }>(
    "SELECT id, path, memory_dir FROM projects ORDER BY path",
  );
}
