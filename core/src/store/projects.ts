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
  /** Yerinde yeniden yazımı görmek için: boyut ve inode aynı kalabiliyor. */
  mtimeMs: number | null;
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

export function getCursor(store: Store, filePath: string): CursorState | null {
  const row = store.get<{ file_path: string; byte_offset: number; inode: string | null; mtime_ms: number | null }>(
    "SELECT file_path, byte_offset, inode, mtime_ms FROM cursors WHERE file_path = ?",
    filePath,
  );
  return row
    ? { filePath: row.file_path, byteOffset: row.byte_offset, inode: row.inode, mtimeMs: row.mtime_ms }
    : null;
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
  const prev = getCursor(store, next.filePath);
  // Geri gitmek yalnız dosya gerçekten değiştiyse meşru: inode ya da mtime
  // farklıysa eski offset zaten anlamsızdır.
  const fileChanged = prev !== null && (prev.inode !== next.inode || prev.mtimeMs !== next.mtimeMs);
  if (prev && next.byteOffset < prev.byteOffset && !fileChanged) {
    throw new Error(
      `imleç geri alınamaz (${next.filePath}): ${prev.byteOffset} → ${next.byteOffset}, dosya değişmemiş`,
    );
  }
  store.run(
    `INSERT INTO cursors (file_path, project_id, session_id, byte_offset, inode, mtime_ms, last_seen_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (file_path) DO UPDATE SET
       project_id = excluded.project_id,
       session_id = excluded.session_id,
       byte_offset = excluded.byte_offset,
       inode = excluded.inode,
       mtime_ms = excluded.mtime_ms,
       last_seen_at = excluded.last_seen_at`,
    next.filePath,
    projectId,
    sessionId,
    next.byteOffset,
    next.inode,
    next.mtimeMs,
    nowIso(),
  );
}

/**
 * Aynı fiziksel dosyaya farklı yollardan ulaşılabiliyor: sembolik bağ realpath
 * ile çözülüyor ama SABİT BAĞ çözülemiyor — iki gerçek yol, tek inode. Yol
 * eşleşmezse akışın kimliği olan inode'a bakılıyor (doğrulama turu bulgusu).
 */
export function getCursorByInode(store: Store, inode: string): CursorState | null {
  const row = store.get<{ file_path: string; byte_offset: number; inode: string | null; mtime_ms: number | null }>(
    "SELECT file_path, byte_offset, inode, mtime_ms FROM cursors WHERE inode = ? ORDER BY byte_offset DESC LIMIT 1",
    inode,
  );
  return row
    ? { filePath: row.file_path, byteOffset: row.byte_offset, inode: row.inode, mtimeMs: row.mtime_ms }
    : null;
}

export function markScanned(store: Store, projectId: number): void {
  store.run("UPDATE projects SET last_scanned_at = ? WHERE id = ?", nowIso(), projectId);
}

export function listProjects(store: Store) {
  return store.all<{ id: number; path: string; memory_dir: string | null }>(
    "SELECT id, path, memory_dir FROM projects ORDER BY path",
  );
}
