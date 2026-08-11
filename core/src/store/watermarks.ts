import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";
import type { WatermarkPosition } from "../observer/batch.ts";

/**
 * Gözlemci filigranı. KARAR ALANLARI konumsal (byteOffset + deliveryKey/Turns);
 * lastUuid ve lastTs yalnız TEŞHİS — hangi turn'e kadar gidildiği olay
 * günlüğünde okunabilsin diye duruyor, eleme kararına girmiyor (kök tasarım
 * değişikliği 11 Ağu 2026, gerekçe observer/batch.ts'te ölçümleriyle yazılı).
 */
export interface Watermark extends WatermarkPosition {
  projectId: number;
  sessionId: string;
  lastUuid: string | null;
  lastTs: string | null;
  /**
   * Ofsetin hangi FİZİKSEL dosyaya ait olduğu. Karar alanı değil ama karar
   * alanının geçerlilik koşulu: bu ikisi olmadan `readIncremental` aynı boyutta
   * yerinde yeniden yazılmış bir dosyayı "hiç değişmemiş" görüyor ve ofset
   * başka baytları işlenmiş sayıyor (M3 borç 2).
   */
  inode: string | null;
  mtimeMs: number | null;
}

/**
 * setWatermark girdisi. Verilmeyen (undefined) alan DEĞİŞTİRİLMEZ: filigran tek
 * bir yazımla değil parça parça ilerliyor (parti checkpoint'i kimliği yazar,
 * teslimat sonu ofseti yazar) ve bir yazımın diğerinin ilerlemesini silmesi
 * sessiz veri tekrarı demek olurdu.
 */
export interface WatermarkInput {
  projectId: number;
  sessionId: string;
  byteOffset?: number | null;
  deliveryKey?: string | null;
  deliveryTurns?: number | null;
  lastUuid?: string | null;
  lastTs?: string | null;
  inode?: string | null;
  mtimeMs?: number | null;
}

/**
 * Filigran yazımının sonucu. Sessiz "yazıldı" varsayımı denetimde kırıldı:
 * setWatermark koşulsuz üzerine yazıyordu, dolayısıyla daha eski bir teslimat
 * filigranı GERİ SARABİLİYORDU (denetim: order-sensitive-watermark). Geri sarma
 * artık imkânsız — ama sessizce değil, çağıran olaya çevirebilsin diye
 * dönüş değeriyle.
 */
export interface WatermarkWrite {
  /** Satır yazıldı mı. Hiçbir alan taşımayan filigran yazılmaz. */
  applied: boolean;
  /**
   * Gelen lastTs saklanandan ESKİYDİ: teşhis damgası ilerletilmedi, saklanan
   * korundu. Karar yolunu etkilemez (damga artık eleme ölçütü değil); yine de
   * raporlanıyor, çünkü teslimat sırasının bozulduğunu gösteren tek ucuz sinyal
   * bu ve sessiz kalırsa anomali hiç görülmez.
   */
  rewindBlocked?: { storedTs: string; incomingTs: string };
}

interface WatermarkRow {
  byte_offset: number | null;
  delivery_key: string | null;
  delivery_turns: number | null;
  last_uuid: string | null;
  last_ts: string | null;
  inode: string | null;
  mtime_ms: number | null;
}

export function getWatermark(store: Store, projectId: number, sessionId: string): Watermark | null {
  const row = store.get<WatermarkRow>(
    `SELECT byte_offset, delivery_key, delivery_turns, last_uuid, last_ts, inode, mtime_ms
     FROM observer_watermarks WHERE project_id = ? AND session_id = ?`,
    projectId,
    sessionId,
  );
  if (!row) return null;
  return {
    projectId,
    sessionId,
    byteOffset: row.byte_offset,
    deliveryKey: row.delivery_key,
    deliveryTurns: row.delivery_turns,
    lastUuid: row.last_uuid,
    lastTs: row.last_ts,
    inode: row.inode,
    mtimeMs: row.mtime_ms,
  };
}

export function setWatermark(store: Store, wm: WatermarkInput): WatermarkWrite {
  const stored = getWatermark(store, wm.projectId, wm.sessionId);
  // Hiçbir değer taşımayan ilk yazım satırı boş yere yaratırdı: ne eler ne
  // ilerletir. Var olan satırda ise kısmi güncelleme meşru (aşağıdaki alan
  // birleştirme kuralları), o yüzden ölçüt "yeni satır mı" ile birlikte.
  const hasValue = [wm.byteOffset, wm.deliveryKey, wm.deliveryTurns, wm.lastUuid, wm.lastTs, wm.inode, wm.mtimeMs]
    .some((v) => v != null);
  if (!hasValue && stored === null) return { applied: false };

  // Ofset MONOTON ve NULL'la silinemez: geri gitmek işlenmiş baytları yeniden
  // teslim etmek, silmek ise "hiç işlenmedi" demektir. Kısalmada anlamını
  // yitiren ofsetin sıfırlanması ayrı ve AÇIK bir işlem (resetWatermarkOffset),
  // çünkü örtük sıfırlama sessiz tam-tekrar üretir.
  const incomingOffset = wm.byteOffset ?? null;
  const nextOffset =
    incomingOffset === null
      ? stored?.byteOffset ?? null
      : stored?.byteOffset == null
        ? incomingOffset
        : Math.max(stored.byteOffset, incomingOffset);

  // Kimlik: yeni teslimat kimliği eskisinin üstüne yazılır (yarım kalan eski
  // teslimat artık geri gelmeyecek). AYNI kimlikte ilerleme yalnız artar.
  const nextKey = wm.deliveryKey === undefined ? stored?.deliveryKey ?? null : wm.deliveryKey;
  const incomingTurns = wm.deliveryTurns === undefined ? null : wm.deliveryTurns;
  const nextTurns =
    incomingTurns === null
      ? nextKey === (stored?.deliveryKey ?? null) ? stored?.deliveryTurns ?? null : null
      : nextKey === (stored?.deliveryKey ?? null) && stored?.deliveryTurns != null
        ? Math.max(stored.deliveryTurns, incomingTurns)
        : incomingTurns;

  const lastUuid = wm.lastUuid === undefined ? stored?.lastUuid ?? null : wm.lastUuid;
  const incomingTs = wm.lastTs === undefined ? null : wm.lastTs;
  const storedTs = stored?.lastTs ?? null;
  const rewindBlocked =
    storedTs !== null && incomingTs !== null && incomingTs < storedTs
      ? { storedTs, incomingTs }
      : undefined;
  const nextTs =
    storedTs === null ? incomingTs : incomingTs === null || incomingTs < storedTs ? storedTs : incomingTs;

  // Tazelik alanları lastUuid kalıbıyla birleşiyor: verilmeyen saklananı korur.
  // Monotonluk aranmıyor — bunlar bir ilerleme değil, okunan dosyanın kimliği.
  const inode = wm.inode === undefined ? stored?.inode ?? null : wm.inode;
  const mtimeMs = wm.mtimeMs === undefined ? stored?.mtimeMs ?? null : wm.mtimeMs;

  store.run(
    `INSERT INTO observer_watermarks
       (project_id, session_id, byte_offset, delivery_key, delivery_turns, last_uuid, last_ts, inode, mtime_ms, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (project_id, session_id) DO UPDATE SET
       byte_offset = excluded.byte_offset,
       delivery_key = excluded.delivery_key,
       delivery_turns = excluded.delivery_turns,
       last_uuid = excluded.last_uuid,
       last_ts = excluded.last_ts,
       inode = excluded.inode,
       mtime_ms = excluded.mtime_ms,
       updated_at = excluded.updated_at`,
    wm.projectId,
    wm.sessionId,
    nextOffset,
    nextKey,
    nextTurns,
    lastUuid,
    nextTs,
    inode,
    mtimeMs,
    nowIso(),
  );
  return rewindBlocked ? { applied: true, rewindBlocked } : { applied: true };
}

/**
 * Kısalma/yerine koyma sonrası konumsal durumu siler. Ofset uzayı sıfırlandığı
 * için saklanan ofset artık BAŞKA bir baytı gösteriyor; monoton ilerleme kuralı
 * onu koruduğu sürece yeni dosyanın tamamı "işlenmiş" sayılır — sessiz ve kalıcı
 * turn kaybı. Teşhis alanları (uuid, damga) korunuyor: kısalmadan önce nereye
 * gelindiği olay günlüğünden okunabilmeli. Tazelik alanlarına (inode, mtime) da
 * DOKUNULMUYOR: onlar konum değil kimlik ve okumanın sonunda zaten yeniden
 * yazılıyor; burada null'lamak yalnız bir sonraki tespiti körleştirirdi.
 *
 * Dönüş: sıfırlanacak bir konumsal durum var mıydı (çağıran olayı ancak o zaman
 * yazsın; her kısalma için olay yazmak gürültü olurdu).
 */
export function resetWatermarkOffset(store: Store, projectId: number, sessionId: string): boolean {
  const stored = getWatermark(store, projectId, sessionId);
  if (stored === null || (stored.byteOffset === null && stored.deliveryKey === null)) return false;
  store.run(
    `UPDATE observer_watermarks
     SET byte_offset = NULL, delivery_key = NULL, delivery_turns = NULL, updated_at = ?
     WHERE project_id = ? AND session_id = ?`,
    nowIso(),
    projectId,
    sessionId,
  );
  return true;
}
