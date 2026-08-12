// Sınıflama aday rotasyonunun kalıcı durumu: ADAY KİMLİĞİ başına "en son ne
// zaman seçildi" damgası. Tasarımın gerekçesi ve adaletin ispatı
// signals/classify.ts'teki `selectCandidates` yorumunda; burada yalnız taşıma
// ve BUDAMA var.

import type { Store } from "./db.ts";
// Tip ve kimlik kodlaması TEK yerde: sözleşmenin sahibi seçimi yapan modül,
// depo yalnız taşıyor. İki ayrı kodlama, sessizce ayrışan iki kimlik demekti.
import { type CandidateStamps, parseCandidateIdentity, NO_SECOND_SIDE } from "../signals/classify.ts";

export type { CandidateStamps };

export function readClassifyStamps(store: Store, projectId: number): CandidateStamps {
  const rows = store.all<{ kind: string; a_id: number; b_id: number; selected_seq: number }>(
    "SELECT kind, a_id, b_id, selected_seq FROM classify_stamps WHERE project_id = ?",
    projectId,
  );
  const out: Record<string, number> = {};
  // Tanınmayan bir `kind` sessizce atlanmıyor, çünkü atlanamaz: anahtar
  // doğrudan üç sütundan kuruluyor. Yüzey adı ileride değişirse eski satır bir
  // çöp anahtar olarak durur ve hiçbir adayla eşleşmez — seçimi bozmaz, budama
  // da onu bir sonraki koşumda temizler (tarafları er ya da geç ölür).
  for (const r of rows) out[`${r.kind}:${r.a_id}:${r.b_id}`] = r.selected_seq;
  return out;
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
): void {
  if (!Number.isSafeInteger(stamp) || stamp <= 0) return;
  for (const [key, value] of Object.entries(stamps)) {
    if (value !== stamp) continue;
    const id = parseCandidateIdentity(key);
    if (id === null) continue; // elle düzenlenmiş depo / gelecekteki bir yüzey
    store.run(
      "INSERT INTO classify_stamps (project_id, kind, a_id, b_id, selected_seq) VALUES (?,?,?,?,?) " +
        "ON CONFLICT (project_id, kind, a_id, b_id) DO UPDATE SET selected_seq = excluded.selected_seq",
      projectId, id.kind, id.aId, id.bId, stamp,
    );
  }
  pruneClassifyStamps(store, projectId);
}

/**
 * BUDAMA POLİTİKASI: tarafı artık CANLI olmayan (silinmiş ya da `superseded` /
 * `born_invalid` olmuş) bir bulguya ait damga satırı silinir.
 *
 * Gerekçe: aday üretimi (`findCandidates`) girdisini `listActive`ten alır, yani
 * canlı olmayan bir bulgu bir daha ASLA aday üretmez — o kimliğin damgası ölü
 * durumdur. Budama olmadan tablo, projenin ömrü boyunca seçilmiş her çiftin
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
