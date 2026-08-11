import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";

export interface Watermark {
  projectId: number;
  sessionId: string;
  /** Konumsal kimlik. Parti uuid taşımıyorsa null olabilir. */
  lastUuid: string | null;
  /** Zamansal kimlik (ISO-8601 UTC). uuid tutmadığında kesim buradan yapılır. */
  lastTs?: string | null;
}

/**
 * Filigran yazımının sonucu. Sessiz "yazıldı" varsayımı denetimde kırıldı:
 * setWatermark koşulsuz üzerine yazıyordu, dolayısıyla daha eski bir teslimat
 * filigranı GERİ SARABİLİYORDU (denetim: order-sensitive-watermark). Geri sarma
 * artık imkânsız — ama sessizce değil, çağıran olaya çevirebilsin diye
 * dönüş değeriyle.
 */
export interface WatermarkWrite {
  /** Satır yazıldı mı. Kimliksiz (iki alanı da null) filigran yazılmaz. */
  applied: boolean;
  /**
   * Gelen lastTs saklanandan ESKİYDİ: zamansal kimlik ilerletilmedi, saklanan
   * korundu. Konumsal kimlik (last_uuid) yine de ilerler — bu bilinçli bir sapma:
   * yazımı bütünüyle engellemek, işlenmiş bir partinin checkpoint'ini hiç
   * yazmamak demek olurdu ve aynı turn'ler her koşumda yeniden işlenirdi
   * (kapatmaya çalıştığımız sonsuz-yeniden-deneme arızasının ta kendisi).
   * "Geri gitme" kuralı zamansal kimlikte tam olarak korunuyor: max(saklanan, gelen).
   */
  rewindBlocked?: { storedTs: string; incomingTs: string };
}

export function getWatermark(store: Store, projectId: number, sessionId: string): Watermark | null {
  const row = store.get<{ last_uuid: string | null; last_ts: string | null }>(
    "SELECT last_uuid, last_ts FROM observer_watermarks WHERE project_id = ? AND session_id = ?",
    projectId,
    sessionId,
  );
  return row ? { projectId, sessionId, lastUuid: row.last_uuid, lastTs: row.last_ts } : null;
}

export function setWatermark(store: Store, wm: Watermark): WatermarkWrite {
  const lastUuid = wm.lastUuid ?? null;
  const lastTs = wm.lastTs ?? null;
  // Kimliksiz filigran hiçbir şey elemez, üstelik var olanı bozar.
  if (lastUuid === null && lastTs === null) return { applied: false };

  const storedTs = getWatermark(store, wm.projectId, wm.sessionId)?.lastTs ?? null;
  // Zamansal kimlik MONOTON: asla küçülmez. Transcript satır sırası zaman
  // sırasıyla birebir olmayabildiği için "gelen daha eski" normal bir olay,
  // ama filigranın geri sarması değil.
  const rewindBlocked =
    storedTs !== null && lastTs !== null && lastTs < storedTs
      ? { storedTs, incomingTs: lastTs }
      : undefined;
  const nextTs = storedTs === null ? lastTs : lastTs === null || lastTs < storedTs ? storedTs : lastTs;

  store.run(
    `INSERT INTO observer_watermarks (project_id, session_id, last_uuid, last_ts, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT (project_id, session_id) DO UPDATE SET
       last_uuid = excluded.last_uuid,
       last_ts = excluded.last_ts,
       updated_at = excluded.updated_at`,
    wm.projectId,
    wm.sessionId,
    // last_uuid ÜZERİNE yazılır, NULL'a bile: eski bir uuid saklı kalırsa
    // tekrar-teslimde konumsal kesim ONU bulup arada işlenmiş turn'leri yeniden
    // üretir — yani daha yeni olan zamansal kimliği etkisiz kılardı.
    lastUuid,
    nextTs,
    nowIso(),
  );
  return rewindBlocked ? { applied: true, rewindBlocked } : { applied: true };
}
