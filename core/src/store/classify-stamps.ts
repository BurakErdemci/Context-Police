// Sınıflama aday rotasyonunun kalıcı durumu: ADAY KİMLİĞİ başına "en son ne
// zaman seçildi" damgası. Tasarımın gerekçesi ve adaletin ispatı
// signals/classify.ts'teki `selectCandidates` yorumunda; burada yalnız taşıma
// ve BUDAMA var.

import type { Store } from "./db.ts";
// Tip ve kimlik kodlaması TEK yerde: sözleşmenin sahibi seçimi yapan modül,
// depo yalnız taşıyor. İki ayrı kodlama, sessizce ayrışan iki kimlik demekti.
import { type CandidateStamps, parseCandidateIdentity, NO_SECOND_SIDE } from "../signals/classify.ts";

export type { CandidateStamps };

/**
 * Rotasyonun kalıcı durumu: iki harita. `selected` = en son seçim damgası,
 * `seen` = adayın İLK GÖRÜLDÜĞÜ koşum. İkincisi olmadan "hiç seçilmemiş" mutlak
 * öncelik taşıyordu ve yüzey içi sel, ölçülmüş adayları süresiz bekletiyordu
 * (gerekçe: signals/classify.ts `CandidateSelection.nextSeen`).
 */
export interface RotationState { selected: Record<string, number>; seen: Record<string, number> }

export function readRotationState(store: Store, projectId: number): RotationState {
  const rows = store.all<{ kind: string; a_id: number; b_id: number; selected_seq: number; first_seen_seq: number | null }>(
    "SELECT kind, a_id, b_id, selected_seq, first_seen_seq FROM classify_stamps WHERE project_id = ?",
    projectId,
  );
  const selected: Record<string, number> = {};
  const seen: Record<string, number> = {};
  // Tanınmayan bir `kind` sessizce atlanmıyor, çünkü atlanamaz: anahtar
  // doğrudan üç sütundan kuruluyor. Yüzey adı ileride değişirse eski satır bir
  // çöp anahtar olarak durur ve hiçbir adayla eşleşmez — seçimi bozmaz, budama
  // da onu bir sonraki koşumda temizler (tarafları er ya da geç ölür).
  for (const r of rows) {
    const key = `${r.kind}:${r.a_id}:${r.b_id}`;
    selected[key] = r.selected_seq;
    // Göçten gelen satırda 0/NULL: ilk-görülme bilinmiyor. Seçim damgası zaten
    // dolu olduğu için öncelik ondan okunur; uydurulmuş bir ilk-görülme, hiç
    // olmayandan kötü olurdu.
    if (r.first_seen_seq !== null && r.first_seen_seq > 0) seen[key] = r.first_seen_seq;
  }
  return { selected, seen };
}

/** Yalnız seçim damgaları (eski çağrı biçimi; rotasyonun tamamı için readRotationState). */
export function readClassifyStamps(store: Store, projectId: number): CandidateStamps {
  return readRotationState(store, projectId).selected;
}

/** Budamanın "canlı bulgu" ölçütü — `listActive` ile aynı küme (audit.ts girdisi). */
const LIVE_STATUSES = "('active','suspect','unanchored')";

/**
 * Bu koşumda SEÇİLEN adayların damgasını yazar ve tabloyu budar. Çağıran tx'ine
 * katılır (kendi tx'ini AÇMAZ): damga, o koşumun skorlarıyla aynı anda commit
 * edilmeli — arada bir ölümde damga ilerleyip ölçüm yazılmasaydı, rotasyon
 * sonucu hiç yazılmamış bir ölçümün üstünden atlardı.
 *
 * Yalnız `stamp` değerli satırlar yazılıyor: haritanın geri kalanı zaten
 * depodan okundu ve değişmedi, hepsini her koşum yeniden yazmak tablo boyunda
 * bedava olmayan bir iş olurdu.
 */
export function writeClassifyStamps(
  store: Store, projectId: number, stamps: CandidateStamps, stamp: number,
  /**
   * `seen`: ilk-görülme haritası; yalnız DEĞERİ `stamp` olanlar (bu koşumda ilk
   * kez görülenler) yazılır. `rewriteAll`: damgalar sıkıştırıldı, tüm satırlar
   * yeniden yazılır (signals/classify.ts `compressStamps`).
   */
  opts: { seen?: CandidateStamps; rewriteAll?: boolean } = {},
): void {
  if (!Number.isSafeInteger(stamp) || stamp <= 0) return;
  const seen = opts.seen ?? {};
  const write = (key: string, selectedSeq: number, seenSeq: number, overwriteSeen: boolean) => {
    const id = parseCandidateIdentity(key);
    if (id === null) return; // elle düzenlenmiş depo / gelecekteki bir yüzey
    store.run(
      "INSERT INTO classify_stamps (project_id, kind, a_id, b_id, selected_seq, first_seen_seq) VALUES (?,?,?,?,?,?) " +
        "ON CONFLICT (project_id, kind, a_id, b_id) DO UPDATE SET selected_seq = excluded.selected_seq" +
        // İlk-görülme normalde DOKUNULMAZ: tazelenmesi adayı kuyruğun sonuna
        // atardı, yani kapatılan açlığı geri açardı. Tek istisna sıkıştırma.
        (overwriteSeen ? ", first_seen_seq = excluded.first_seen_seq" : ""),
      projectId, id.kind, id.aId, id.bId, selectedSeq, seenSeq,
    );
  };

  if (opts.rewriteAll) {
    for (const key of new Set([...Object.keys(stamps), ...Object.keys(seen)]))
      write(key, stamps[key] ?? 0, seen[key] ?? 0, true);
  } else {
    for (const [key, value] of Object.entries(stamps)) {
      if (value !== stamp) continue;
      write(key, stamp, seen[key] ?? stamp, false);
    }
    // Seçilmeyen ama İLK KEZ görülen adaylar: sıraya girdikleri koşum kaydedilir,
    // seçim damgası 0 kalır ("hiç ölçülmedi").
    for (const [key, value] of Object.entries(seen)) {
      if (value !== stamp || stamps[key] === stamp) continue;
      write(key, stamps[key] ?? 0, stamp, false);
    }
  }
  pruneClassifyStamps(store, projectId);
}

/**
 * BUDAMA POLİTİKASI: tarafı artık CANLI olmayan (silinmiş ya da `superseded` /
 * `born_invalid` olmuş) bir bulguya ait damga satırı silinir.
 *
 * Gerekçe: aday üretimi (`findCandidates`) girdisini `listActive`ten alır, yani
 * canlı olmayan bir bulgu bir daha ASLA aday üretmez — o kimliğin damgası ölü
 * durumdur. M4.5'ten beri satır yalnız SEÇİLEN için değil GÖRÜLEN her aday için
 * yazılıyor (ilk-görülme damgası), yani budama daha da gerekli: tablo artık
 * "canlı bulgular arasında en az bir kez GÖRÜLMÜŞ çiftler" ile sınırlı — bu,
 * her koşum zaten bellekte kurulan aday listesiyle aynı mertebe.
 * Budama olmadan tablo, projenin ömrü boyunca seçilmiş her çiftin
 * kaydını tutardı ve çift sayısı not sayısında kareli; sınırsız büyüme kabul
 * edilemez. Budamayla tablo, "şu an canlı bulgular arasında en az bir kez
 * seçilmiş çiftler" ile sınırlı.
 *
 * `restore()` bir satırı `superseded`ten `active`e geri alabiliyor, yani budama
 * TERSİNİR bir durumu da temizleyebilir. Kabul edilmesinin sebebi maliyetin
 * yönü: damgasını kaybeden aday "hiç seçilmemiş" sayılır, yani en yüksek
 * ÖNCELİĞE düşer. Budama bir adayı geciktiremez, yalnız öne alabilir —
 * adaleti bozmaz, en fazla bir kez fazladan ölçüm yaptırır.
 *
 * Not: `audit.ts` bu yazımı, bulgu durumlarını güncelleyen döngüden ÖNCE aynı
 * tx'te çağırıyor, dolayısıyla budama o koşumda süpersede edilen çiftleri bir
 * koşum gecikmeyle görür. Zararsız — gecikme bir koşum.
 */
function pruneClassifyStamps(store: Store, projectId: number): number {
  // Canlı bulgu kimlikleri TEK alt sorguda; `a_id` ve `b_id` ikisi de aynı
  // kümeye bakıyor. `b_id = NO_SECOND_SIDE` tek notluk yüzeylerin sentinel'i,
  // bir bulgu id'si değil — kontrolden muaf.
  return store.run(
    "DELETE FROM classify_stamps WHERE project_id = ? AND (" +
      `  a_id NOT IN (SELECT id FROM findings WHERE project_id = ? AND status IN ${LIVE_STATUSES})` +
      `  OR (b_id <> ${NO_SECOND_SIDE}` +
      `      AND b_id NOT IN (SELECT id FROM findings WHERE project_id = ? AND status IN ${LIVE_STATUSES}))` +
      ")",
    projectId, projectId, projectId,
  ).changes;
}
