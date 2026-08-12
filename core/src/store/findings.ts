import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";
import type { Anchor, Finding, FindingSource, FindingStatus } from "../types.ts";

export interface AppendInput {
  projectId: number;
  source: FindingSource;
  content: string;
  sourceRef?: string | null;
  anchors?: Anchor[];
  /** Verilmezse çapa varlığına göre belirlenir: çapasız → unanchored (M0-D5). */
  status?: FindingStatus;
  createdAt?: string;
}

/**
 * Tek yazma yolu. Güncelleme yok, silme yok: düzeltme demek yeni kayıt açıp
 * eskisini supersede etmek demek (spec §2.3). Şema da bunu tetikleyiciyle
 * zorluyor; bu modül yalnız o kuralı kullanışlı hale getiriyor.
 */
export function appendFinding(store: Store, input: AppendInput): number {
  const anchors = input.anchors ?? [];
  // Çapasız not denetlenemez ama şüpheli DEĞİL — M0'da en dayanıklı notların bir
  // kısmı (tercih kayıtları, dersler) hiç kod çapası taşımıyordu.
  const status: FindingStatus = input.status ?? (anchors.length === 0 ? "unanchored" : "active");

  return store.tx(() => {
    const id = store.run(
      "INSERT INTO findings (project_id, source, content, source_ref, created_at, status) VALUES (?,?,?,?,?,?)",
      input.projectId,
      input.source,
      input.content,
      input.sourceRef ?? null,
      input.createdAt ?? nowIso(),
      status,
    ).lastInsertRowid;

    for (const a of anchors) {
      store.run(
        "INSERT INTO anchors (finding_id, kind, value, taken_at_commit) VALUES (?,?,?,?)",
        id,
        a.kind,
        a.value,
        a.takenAtCommit ?? null,
      );
    }
    return id;
  });
}

/** Eskiyi superseded işaretler ve yeniye bağlar. Geri alınabilir: restore() var. */
export function supersede(store: Store, oldId: number, newId: number | null = null): void {
  store.run("UPDATE findings SET status = 'superseded', superseded_by = ? WHERE id = ?", newId, oldId);
}

/** Yanlış işaretlemenin bedeli sıfır olsun diye (spec §3.2): tek adımda geri dönüş. */
export function restore(store: Store, id: number): void {
  store.run("UPDATE findings SET status = 'active', superseded_by = NULL WHERE id = ?", id);
}

export function setSuspicion(store: Store, id: number, suspicion: number): void {
  const clamped = Math.max(0, Math.min(1, suspicion));
  store.run("UPDATE findings SET suspicion = ? WHERE id = ?", clamped, id);
}

export function getFinding(store: Store, id: number): Finding | undefined {
  const r = store.get<{
    id: number; project_id: number; source: FindingSource; content: string;
    source_ref: string | null; created_at: string; status: FindingStatus;
    superseded_by: number | null; suspicion: number;
  }>("SELECT * FROM findings WHERE id = ?", id);
  if (!r) return undefined;
  return {
    id: r.id, projectId: r.project_id, source: r.source, content: r.content,
    sourceRef: r.source_ref, createdAt: r.created_at, status: r.status,
    supersededBy: r.superseded_by, suspicion: r.suspicion,
  };
}

export function getAnchors(store: Store, findingId: number): Anchor[] {
  return store
    .all<{ kind: Anchor["kind"]; value: string; taken_at_commit: string | null }>(
      "SELECT kind, value, taken_at_commit FROM anchors WHERE finding_id = ?",
      findingId,
    )
    .map((a) => ({ kind: a.kind, value: a.value, takenAtCommit: a.taken_at_commit }));
}

/**
 * Sinyal motorunun tekelinde (D-M3-9): active VE unanchored → suspect. Koşul
 * SQL'de, çağıranda değil — superseded ya da born_invalid bir kaydı yanlışlıkla
 * şüpheliye itmek imkânsız olsun.
 *
 * `unanchored`ın da geçmesi bilinçli (mimar kararı, Görev 10 düzeltme turu):
 * M0-D5'in nötrlüğü "çapasız not KOD HAREKETİYLE çürüyemez, çapa sinyali ona
 * dokunmasın" demektir. Çelişki ise çapadan bağımsız, tamamen İÇSEL bir sinyal
 * ve spec §3.4 "iki taraftan en az biri yanlış" diyor — yani çelişki,
 * denetlenemez sayılan notu denetlenebilir kılar.
 */
export function markSuspect(store: Store, id: number): void {
  store.run("UPDATE findings SET status = 'suspect' WHERE id = ? AND status IN ('active','unanchored')", id);
}

/**
 * Skor eşik altına düştüyse geri dönüş — otomatik, çünkü hiçbir dosyaya inmedi (K9).
 *
 * Hedef durum ÇAPA VARLIĞINA bakılarak seçilir: çapasız not `unanchored`'a
 * döner, `active`'e değil. Aksi hâlde çelişkisi çözülen çapasız bir not
 * `active`te sıkışır ve M0-D5 sınıflaması KALICI olarak kaybolurdu — o notu
 * hiçbir çapa sinyali denetleyemeyecek olmasına rağmen denetleniyor görünürdü.
 *
 * Çapa bilgisi parametreyle DEĞİL depodan alınıyor: tek doğru kaynak depo, ve
 * çağıranın yanlış bir bayrağı burada sessizce yanlış bir sınıflama yazardı.
 */
export function clearSuspect(store: Store, id: number): void {
  const n = store.get<{ n: number }>("SELECT COUNT(*) n FROM anchors WHERE finding_id = ?", id)?.n ?? 0;
  store.run(
    "UPDATE findings SET status = ? WHERE id = ? AND status = 'suspect'",
    n > 0 ? "active" : "unanchored",
    id,
  );
}

/** Ajanın "gerçek" saydığı küme: superseded ve born_invalid buraya girmez. */
export function listActive(store: Store, projectId: number): Finding[] {
  return store
    .all<{ id: number }>(
      "SELECT id FROM findings WHERE project_id = ? AND status IN ('active','suspect','unanchored') ORDER BY id",
      projectId,
    )
    .map((r) => getFinding(store, r.id)!)
}
