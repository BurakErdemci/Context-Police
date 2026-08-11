import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";

export interface Watermark {
  projectId: number;
  sessionId: string;
  lastUuid: string;
}

export function getWatermark(store: Store, projectId: number, sessionId: string): Watermark | null {
  const row = store.get<{ last_uuid: string }>(
    "SELECT last_uuid FROM observer_watermarks WHERE project_id = ? AND session_id = ?",
    projectId,
    sessionId,
  );
  return row ? { projectId, sessionId, lastUuid: row.last_uuid } : null;
}

export function setWatermark(store: Store, wm: Watermark): void {
  store.run(
    `INSERT INTO observer_watermarks (project_id, session_id, last_uuid, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT (project_id, session_id) DO UPDATE SET
       last_uuid = excluded.last_uuid,
       updated_at = excluded.updated_at`,
    wm.projectId,
    wm.sessionId,
    wm.lastUuid,
    nowIso(),
  );
}
