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
  /**
   * Kimliği DOĞRULANMIŞ canlı bir sahip kilidi eşiği aşacak kadar uzun süredir
   * tutuyor (lock.ts LONG_HELD_MS). Kilit ÇALINMADI — uzun denetim meşrudur ve
   * çalmak, kilidin var olma sebebi olan mükerrer teslimat yarışını geri
   * getirirdi. Bu satır bir arıza bildirimi değil GÖRÜNÜRLÜK: sahip kimliği
   * `ps lstart`'a dayanıyor, çözünürlüğü 1 saniye ölçüldü, ve aynı-saniye PID
   * yeniden kullanımı kimliği aldatıp kilidi süresiz takılı bırakabiliyor
   * (lock.ts'teki "KABUL EDİLEN KALINTI"). Meşru uzun denetimle o kalıntı
   * diskte AYNI görünüyor; ayrımı insan yapar, ama ancak olay yazılırsa.
   * Aynı kilit satırı (sahip + alınma zamanı) için en fazla bir kayıt.
   */
  | "scan_lock_held_long"
  | "discovery_failed"
  | "unknown_type_overflow"
  | "malformed_line"
  | "truncation_detected"
  | "unresolved_project_key"
  /**
   * Oturum dosyasının KİMLİĞİ (gerçek yol / inode) ölçülemedi; oturum bu turda
   * atlandı, imleci ilerlemedi. `detail.probe` hangi çağrının düştüğünü,
   * `detail.missing` ise "dosya gerçekten yok" (ENOENT) ile ölçüm arızasını
   * ayırır. Var olma sebebi: eski hâl arızada sessizce HAM yola düşüyordu ve
   * aynı akış ikinci bir anahtarla yeniden teslim edilebiliyordu (scan.ts).
   */
  | "cursor_identity_failed"
  /**
   * Proje yolunu transcript'in `cwd` alanından çözme denemesi arızalandı.
   * "cwd yok" ile "dosyayı okuyamadım" AYRI: ilki normal (eski format, saf
   * üst-veri), ikincisi düzeltilebilir bir kurulum hatası (izin, bozuk dosya).
   * Eski hâlinde ikisi de tek bir `null`'a düşüyor, proje tahmini yolla
   * kaydediliyor ve errno hiçbir yerde görünmüyordu (claude-code.ts).
   */
  | "cwd_probe_failed"
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
  /**
   * Teşhis damgasının geri sarma denemesi engellendi (order-sensitive-watermark).
   * Kök tasarım değişikliğinden sonra kararı ETKİLEMEZ (eleme konumsal); teslimat
   * sırasının bozulduğunu gösteren tek ucuz sinyal olduğu için yazılmaya devam.
   */
  | "watermark_rewind_blocked"
  /**
   * Transcript kısaldı/yerine yenisi kondu: saklanan bayt ofseti başka bir
   * dosyanın ofseti olduğu için sıfırlandı. Bu teslimatta eleme yapılmaz —
   * mükerrer bulgu mümkün, ve sebebi burada yazılı.
   */
  | "watermark_offset_reset"
  /** maxCalls bütçesi doldu: kalan partiler İŞLENMEDİ, filigran ilerlemedi. */
  | "observer_budget_exhausted"
  /**
   * Kısmi örtüşme: saklanan ofset teslimatın ortasına düştü, kesme noktası
   * bilinemediği için teslimatın TAMAMI yeniden Codex'e gitti (batch.ts
   * `overlap-resent`). Kayıp değil tekrar — ama tekrar para demek ve M2'de bu
   * yolun ne sıklıkta işlediği ölçülemedi (borç 3). Olay tam o ölçüm.
   */
  | "observer_partial_overlap"
  /**
   * Bütçe taramayı ERKEN DURDURDU: kalan oturumlar hiç İŞLENMEDİ, imleçleri
   * ilerlemedi. Tarama başına TEK kayıt — oturum başına observer_failed yazmak
   * maliyet sınırını arıza gibi gösteriyordu (M2 borç 4).
   */
  | "observer_budget_halt"
  /**
   * Import sessiz yutma yasağının üç yüzü (spec §3.7). Import'ta özellikle
   * gerekli, çünkü çıktısı bir ÖZET sayısı: "errors: 1" hangi dosyanın neden
   * okunamadığını söylemez, olay söyler.
   */
  /** memory dizini ya da içindeki bir dosya okunamadı — o not import edilmedi. */
  | "import_read_failed"
  /**
   * Diskteki not silinmiş: temsili superseded, ama yerine geçen kayıt YOK.
   * Silme değil işaretleme olduğu için geri alınabilir (spec §3.2) — dosyanın
   * yanlışlıkla taşınmış olması restore() ile tek adımda düzeliyor.
   */
  | "import_file_deleted"
  /**
   * Not MAX_ANCHORS_PER_NOTE tavanını aştı: kırpılan çapalar denetlenmeyecek.
   * Kırpma sessiz olursa "çapası yok sanılan" bir not denetim dışı kalır.
   */
  | "import_anchor_overflow"
  /**
   * Denetim olayları (Görev 10). Ortak gerekçe: `audit` özet SAYILAR döndürüyor
   * ("şüpheli: 3"), ve bir sayı hangi notun neden şüphelendiğini söylemiyor.
   * Görev 11'in altın set ölçümü not-not eşleştirmeyi bu günlükten yapıyor.
   */
  /** Proje git deposu değil (ya da commit'siz): çapa sinyali KAPALI koştu. */
  | "anchor_signal_disabled"
  /**
   * `--fetch` İSTENDİ ama fetch arızalandı: denetim BAYAT bir origin ref'ine
   * karşı koştu. Sinyal kapanmıyor (çalışma ağacı ve yerel geçmiş hâlâ geçerli)
   * ama tazelik iddiası düşüyor — ve bayat bir ölçümü taze sanmak, ölçümü
   * sessizce yanlış yapar. Eskiden fetch dönüşü hiç okunmuyordu; arıza ne
   * günlükte ne ekranda görünüyordu. Detay: sınıflandırılmış sebep.
   */
  | "git_fetch_failed"
  /**
   * Denetimin yaşam döngüsü — proje başına, `detail.runId` ile. Gerekçe ölçüm:
   * import bir transaction'da, skorlar çok sonra BAŞKASINDA commit ediliyor;
   * arada süreç ölürse not `active`/skor 0 kalıyor ve bu "ölçüldü, temiz çıktı"
   * ile bayt bayt aynı görünüyordu. Node varsayılanı SIGINT/SIGTERM'de `finally`
   * bloklarını koşturmuyor (rc=130/143), yani Ctrl-C tam bu durumu üretiyor.
   * `audit_started` var + `audit_completed` yok = yarım denetim, depodan okunur.
   */
  | "audit_started"
  | "audit_completed"
  /** Denetim istisnayla ya da sinyalle kesildi; `detail.reason` sebebi taşır. */
  | "audit_failed"
  /**
   * Ölçüm arızası olayı tavanı aştı. Bozuk bir repoda not × çapa başına satır
   * yazılıyor; `events` silinemez olduğu için şişme geri alınamaz (scan.ts
   * `unknown_type_overflow` ile aynı gerekçe). Taşan sayı burada tek satırda.
   */
  | "anchor_measurement_overflow"
  /**
   * TEK bir çapanın git ölçümü arızalandı (bozuk repo, erişilemez promisor
   * remote, git binary'si yok, zaman aşımı, maxBuffer taşması). Çapa
   * `unverifiable` sayılır, skora katkı vermez.
   * Gerekçe (denetim 2026-08-11, error-path turu): arıza eskiden `missing_now`
   * hükmüne dönüşüyordu; artık dönüşmüyor, ama SESSİZ kalması da kabul değil —
   * "git söyleyemedi" ile "dosya gitti" kullanıcı için aynı şey değil, ve
   * arızanın kendisi (yanlış yapılandırılmış klon, kısmi klon) düzeltilebilir
   * bir durum. Detay: çapa + hangi komut + sınıflandırılmış sebep.
   */
  | "anchor_measurement_failed"
  /**
   * Bir bulgunun skoru hesaplandı. `reasons` skoru ÜRETEN çapaları taşır;
   * `states` ise çapaların TAMAMININ durum sayımını. İkisi ayrı, çünkü
   * `unverifiable` ve `never_existed` skor üretmediği için reasons'ta hiç
   * görünmüyor — oysa M2'nin "%10 uydurma çapa" borcunun ölçümü tam olarak o
   * iki sayı (Görev 11 tablosu). Sıfır olan durumlar yazılmaz.
   */
  | "signal_scored"
  /** active → suspect geçişi (eşik üstü skor). */
  | "finding_suspect"
  /** suspect → active geçişi: skor eşik altına düştü, işaret geri alındı. */
  | "finding_cleared"
  /** Sınıflama iki ifadenin çeliştiğini söyledi; İKİ taraf da yükselir (spec §3.4). */
  | "contradiction_confirmed"
  /**
   * Sınıflama sonuç üretemedi (yürütücü hatası ya da iki denemede de geçersiz
   * JSON). Çelişki sinyali o koşumda YOK sayılır — çapa sinyali koşmaya devam
   * eder, ama "çelişki bulunmadı" ile "bakılamadı" karışmasın diye kayıt şart.
   */
  | "classify_failed"
  /**
   * Aday kümesinden bir şeyin ELENDİĞİ iki hâl, tek kind altında ama ayrı
   * detay anahtarlarıyla: (a) `skippedAnchors` — bir çapa çok fazla notta geçtiği
   * için çift üretmedi (contradiction.ts MAX_NOTES_PER_ANCHOR), (b) `droppedCandidates`
   * — aday sayısı sınıflama tavanını aştı (classify.ts MAX_CLASSIFY_ITEMS).
   * İkisi de "bakılmadı" demek; sessiz kalırsa "çelişki yok" sanılır.
   */
  | "classify_overflow"
  /**
   * Hafıza dizinindeki bir girdi tipi yüzünden OKUNMADI: symlink hafıza ağacının
   * dışını gösteriyordu. Gerekçe doğruluk — source_ref dizin içi bir yol
   * gösterirken içerik başka bir ağaçtan gelseydi, o notun çapaları yanlış
   * repoya karşı ölçülürdü. "errors" değil ayrı sayaç: arıza değil karar.
   */
  | "import_entry_rejected"
  /**
   * A verdict was written for a claim (store/verdicts.ts), in the SAME
   * transaction as the row itself. `detail.supersededId` names the verdict it
   * replaced — the tool's own reversal rate (spec §3.2) is counted from that
   * chain. An unchanged conclusion writes no row, so it writes no event either.
   */
  | "verdict_recorded"
  /** The user approved or rejected a verdict; the rejected share is the tool's error rate. */
  | "verdict_reviewed";

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
