import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";

/**
 * Denetim günlüğü. İki işi var: (1) sessiz yutmayı imkânsız kılmak — bilinmeyen
 * satır tipi, bozuk JSON, kısalma hepsi buraya düşer (spec §3.7); (2) aracın
 * kendi hata oranını ölçülebilir kılmak — onay/ret kayıtları da burada (§3.2).
 */
export type EventKind =
  | "unknown_line_type"
  | "observer_failed"
  | "session_read_failed"
  | "scan_lock_stolen"
  | "discovery_failed"
  | "unknown_type_overflow"
  | "malformed_line"
  | "truncation_detected"
  | "unresolved_project_key"
  | "scan_completed"
  | "observer_batch_ok"
  | "observer_batch_unprocessed"
  /**
   * Her supersede için bir kayıt. Gerekçe (denetim: prompt-injection-supersede):
   * transcript metni prompt'a ham giriyor ve bir turn "gösterilen bulguyu
   * geçersiz kıl" diyebilir. Tam savunma M2 kapsamı değil; ölçülebilirlik ve
   * geri alınabilirlik ise kapsam — yanlış supersede burada görünür, restore()
   * ile tek adımda döner (spec §3.2: aracın kendi hata oranı bedava birikir).
   */
  | "finding_superseded"
  /** Filigran geri sarma denemesi engellendi (order-sensitive-watermark). */
  | "watermark_rewind_blocked"
  /** Parti ne uuid ne timestamp taşıyor: ilerleme kaydedilemedi, kayıp görünür. */
  | "observer_batch_no_checkpoint"
  /** Saklı filigran akışta hiçbir kimlikle eşleşmedi: mükerrer bulgu riski. */
  | "watermark_match_failed"
  /** maxCalls bütçesi doldu: kalan partiler İŞLENMEDİ, filigran ilerlemedi. */
  | "observer_budget_exhausted";

export function logEvent(
  store: Store,
  e: { projectId?: number | null; kind: EventKind | string; detail?: unknown },
): void {
  store.run(
    "INSERT INTO events (project_id, at, kind, detail) VALUES (?,?,?,?)",
    e.projectId ?? null,
    nowIso(),
    e.kind,
    e.detail === undefined ? null : typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail),
  );
}

export function listEvents(
  store: Store,
  opts: { projectId?: number; kind?: string; limit?: number } = {},
) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(opts.projectId);
  }
  if (opts.kind !== undefined) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  const sql =
    "SELECT id, project_id, at, kind, detail FROM events" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY id DESC LIMIT ?";
  params.push(opts.limit ?? 100);
  return store.all<{ id: number; project_id: number | null; at: string; kind: string; detail: string | null }>(
    sql,
    ...params,
  );
}

export function countEvents(store: Store, kind: string, projectId?: number): number {
  const row = projectId
    ? store.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE kind = ? AND project_id = ?", kind, projectId)
    : store.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE kind = ?", kind);
  return row?.n ?? 0;
}
