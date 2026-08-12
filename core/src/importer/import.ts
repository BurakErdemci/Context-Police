// Import eşlemedir, senkron değil (spec §3.2): kaynak dosya her zaman gerçek,
// depo onun gölgesi + denetim üst-verisi. Değişen dosya = eski temsil superseded
// + yeni kayıt; dosya UPDATE edilmez (append-only tetikleyicisi zaten engeller).

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Store } from "../store/db.ts";
import { nowIso } from "../store/db.ts";
import { appendFinding, supersede } from "../store/findings.ts";
import { logEvent } from "../store/events.ts";
import { parseNote, extractAnchors, noteTimestamp, capNoteContent, MAX_NOTE_CHARS } from "./parse.ts";

/**
 * Bu modülün yazdığı YENİ olay tipleri. `logEvent` kind'ı `EventKind | string`
 * kabul ettiği için burada tanımlanmaları yeterli; `store/events.ts`'teki
 * belgeleyici birleşime eklenmeleri eşzamanlı dalga o dosyada çalıştığı için
 * ertelendi (dalgalar birleştiğinde eklenecek).
 *
 * - `import_note_truncated`   : not MAX_NOTE_CHARS tavanına kırpıldı. Kırpılan
 *   baytlar ne çapa çıkarımına ne depoya girdi — sessiz kalırsa denetim
 *   görmediği bir gövdeyi görmüş gibi raporlar.
 * - `import_timestamp_clamped`: notun verdiği damga gelecekteydi, içe aktarma
 *   anına kelepçelendi. Kelepçe denetim penceresini DEĞİŞTİRİR; gizli kalırsa
 *   "bu not neden churned çıktı" sorusunun cevabı kaybolur.
 * - `import_timestamp_unparsable`: `Date.parse` alanı çözemedi, alan atlandı.
 */
const _NEW_EVENT_KINDS = ["import_note_truncated", "import_timestamp_clamped", "import_timestamp_unparsable"] as const;
void _NEW_EVENT_KINDS;

export interface ImportSummary {
  files: number;
  added: number;
  unchanged: number;
  replaced: number;
  deleted: number;
  skipped: number;
  /** Girdi hafıza ağacının dışını gösterdiği için okunmadı (bkz. inMemoryTree). */
  rejected: number;
  errors: number;
}

/**
 * Çözülmüş hedef hafıza ağacının içinde mi? Karşılaştırma tabanı da ÇÖZÜLMÜŞ yol
 * olmalı: memoryDir'in kendisi symlink bileşeni içerebiliyor (macOS'ta
 * /var → /private/var) ve çözülmemiş yolla kıyas dizin içi symlink'leri de
 * reddederdi. Ayraçlı önek: ".../memory-eski" ".../memory"nin içi sayılmasın.
 */
const inMemoryTree = (base: string, target: string) =>
  target === base || target.startsWith(base + sep);

export async function importMemoryDir(
  store: Store,
  projectId: number,
  memoryDir: string,
): Promise<ImportSummary> {
  const sum: ImportSummary = {
    files: 0, added: 0, unchanged: 0, replaced: 0, deleted: 0, skipped: 0, rejected: 0, errors: 0,
  };

  let names: string[];
  let base: string;
  try {
    names = await readdir(memoryDir);
    base = await realpath(memoryDir);
  } catch (err) {
    // Dizin yoksa/okunamıyorsa ATMA yerine raporla: tek bir projenin hafıza
    // dizininin eksikliği taramanın tamamını düşürmemeli. Sessiz de değil.
    // Yukarıdaki değişmez kuralın DIŞINDA değil, kapsamı dışında: bu olayın
    // depoda bir sonucu yok (hiçbir kayıt supersede edilmiyor, hiçbir kayıt
    // doğmuyor) — anlattığı şeyin kendisi tek başına olayın içeriği.
    sum.errors++;
    logEvent(store, { projectId, kind: "import_read_failed", detail: { dir: memoryDir, error: String(err) } });
    return sum;
  }

  const currentRefs = new Set<string>();
  // sort(): silinen dosya tespiti ve olay sırası koşuma göre değişmesin —
  // readdir'in sırası dosya sistemine bağlı, deterministik değil.
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    if (name === "MEMORY.md") { sum.skipped++; continue; } // indeks, not değil (D-M3-1)
    sum.files++;
    const path = join(memoryDir, name);

    let raw: string;
    /** Ağaç dışını gösteren symlink'in çözülmüş hedefi; null = reddedilmedi. */
    let rejectedTarget: string | null = null;
    try {
      // Girdi tipi okumadan ÖNCE: readFile symlink'i sessizce takip eder.
      // Gerekçe güvenlik değil DOĞRULUK — symlink koyabilen aktör aynı baytları
      // düz bir .md olarak da yazabilirdi, yeni bir yetenek yok. Kusur şu:
      // source_ref hafıza dizini içindeki bir yolu gösterirken içerik başka bir
      // ağaçtan geliyor, ve o notun çapaları YANLIŞ repoya karşı ölçülüyor.
      // Politika "symlink'i atla" değil "ağaç dışına çıkanı reddet": dizin içinde
      // kalan bir symlink'in baytları gerçekten o hafızanın içeriği.
      const st = await lstat(path);
      if (st.isSymbolicLink()) {
        const target = await realpath(path);
        if (!inMemoryTree(base, target)) rejectedTarget = target;
      }
      // Reddedilen girdi okunmaz: depoya yazılması yasak olan baytları belleğe
      // almanın da bir faydası yok.
      raw = rejectedTarget === null ? await readFile(path, "utf8") : "";
    } catch (err) {
      sum.errors++;
      logEvent(store, { projectId, kind: "import_read_failed", detail: { file: path, error: String(err) } });
      // Tek başına commit ediliyor ve kural bunu KAPSAMIYOR: olayın burada
      // depoya yazdığı bir sonuç yok. Reddetmeden farkı, reddetmenin KALICI bir
      // durum olması (symlink orada durdukça her koşumda aynı) — okuma hatası
      // ise geçici olabilir, o yüzden aşağıdaki ENOENT ayrımıyla yol GÜNCEL
      // sayılıp hiçbir kayda dokunulmuyor. Dokunulmayan kayıt "aynı tx" borcu
      // da doğurmaz.
      // ENOENT DIŞI hata dosyanın yokluğunu KANITLAMAZ (EACCES geçici olabilir,
      // EISDIR/EIO yolun dolu olduğunu söyler): yolu güncel say, yoksa tek bir
      // okuma hatası kaydı "silinmiş" diye superseded ederdi. ENOENT ise dosya
      // listeleme ile okuma arasında gerçekten kayboldu → süpürme görsün.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") currentRefs.add(path);
      continue;
    }

    if (rejectedTarget !== null) {
      // DEĞİŞMEZ KURAL: bir SONUCU anlatan olay, o sonuçla AYNI transaction'da
      // commit edilir ya da hiç commit edilmez.
      //
      // Ölçüldü (probe: rejected-import-event-not-atomic): olay girdi döngüsünde
      // tek başına autocommit ediliyordu, reddedilen yolun eski kaydının
      // superseded edilmesi ise ÇOK SONRA, süpürmenin ayrı tx'inde oluyordu.
      // Arada bir hata/ölüm: append-only günlükte "bu girdi reddedildi" yazıyor
      // ama reddedilen yolun eski içeriği hâlâ `active` ve denetleniyor — yani
      // günlük depoyu yanlış anlatıyor.
      //
      // İki tasarım vardı; ERTELEME değil HEMEN seçildi: olayı süpürmeye
      // ertelemek, hiç kaydı olmayan (ilk kez görülen) reddedilmiş bir girdi
      // için olayı bütünüyle kaybederdi — süpürme yalnız var olan kayıtlar
      // üzerinde dönüyor. Hemen supersede etmenin sonucu süpürmeninkiyle aynı
      // (yol currentRefs'e girmiyor, orada da superseded olurdu), ama burada
      // gerekçesiyle birlikte ve tek parça.
      //
      // OKUMA try'ının DIŞINDA olmak ZORUNDA: içerideyken enjekte edilen bir
      // depo hatası yukarıdaki catch'e düşüp `import_read_failed`'a dönüşüyordu
      // (bu düzeltmenin ilk hâlinde ölçüldü) — yani depo arızası okuma arızası
      // gibi raporlanıyor, üstelik yol "güncel" sayılıp yutuluyordu.
      const stale = store.get<{ id: number }>(
        `SELECT id FROM findings
         WHERE project_id = ? AND source = 'imported' AND source_ref = ? AND status != 'superseded'
         ORDER BY id DESC LIMIT 1`,
        projectId, path,
      );
      store.tx(() => {
        logEvent(store, {
          projectId, kind: "import_entry_rejected",
          detail: { file: path, target: rejectedTarget, reason: "symlink_outside_memory_dir" },
        });
        if (stale) {
          // Yerine geçen yok: içerik reddedildi, yeni bir temsil doğmadı. Silme
          // değil işaretleme olduğu için yanlışsa tek adımda geri alınır (§3.2).
          supersede(store, stale.id);
          logEvent(store, {
            projectId, kind: "finding_superseded",
            detail: { oldId: stale.id, newId: null, reason: "entry_rejected", file: name },
          });
        }
      });
      // Sayaç tx'ten SONRA (aşağıdaki added/replaced ile aynı gerekçe): geri
      // alınan bir işlem özet sayısına yansımamalı.
      sum.rejected++;
      // currentRefs'e girmez: bugün o yolda duran şey kayda aldığımız not değil.
      continue;
    }
    // Okuma başarılı olduktan SONRA: "diskte hâlâ var" iddiası ancak burada doğru.
    currentRefs.add(path);

    // Tavan HER ŞEYDEN önce (denetim: unbounded-note-size). Kırpılmış metin
    // hem taranan hem SAKLANAN gövde olur; üç gerekçe:
    //   1. Depo denetimin zemini — saklanan gövde ölçülenden fazlasını
    //      iddia etmemeli (çapa çıkarımı ve çelişki tespiti yalnız kırpılmışı
    //      görüyor).
    //   2. Kaynak dosya diskte duruyor ve gerçeğin sahibi o; import eşlemedir,
    //      senkron değil (dosya başı).
    //   3. Hiçbir kayıt silinmiyor (spec §3.2): sınırsız gövde kalıcı şişme.
    // Bedeli: tavanın ÖTESİNDE değişen bir not "unchanged" görünür. Kabul —
    // denetim o baytları zaten hiç okumuyor, yani görünmeyen bir değişiklik
    // görünmeyen bir hükümle eşleşiyor; ve kırpma olayı her koşumda yazılıyor.
    const { content, truncated } = capNoteContent(raw);

    // En son canlı temsil: aynı dosyanın superseded olmayan en yeni kaydı.
    const existing = store.get<{ id: number; content: string }>(
      `SELECT id, content FROM findings
       WHERE project_id = ? AND source = 'imported' AND source_ref = ? AND status != 'superseded'
       ORDER BY id DESC LIMIT 1`,
      projectId, path,
    );
    if (existing && existing.content === content) { sum.unchanged++; continue; }

    const { frontmatter } = parseNote(content);
    const { anchors, dropped } = extractAnchors(content);
    const stamp = noteTimestamp(frontmatter, nowIso());
    // Yeni kayıt, eskisinin supersede'i VE bunları açıklayan olaylar TEK işlemde.
    // İki ayrı gerekçe, ikisi de "arada çökme":
    //   - kayıt/supersede ayrı olsaydı aynı dosyanın iki canlı temsili kalırdı
    //     (yukarıdaki "en yeni" sorgusu sessizce eskisini gözden kaçırır);
    //   - olay tx'in DIŞINDA yazılıyordu (denetim: import-event-outside-transaction):
    //     olay yazımı patlarsa ya da süreç arada ölürse append-only tablo ile
    //     denetim günlüğü çelişiyordu — kayıt superseded ama sebebini açıklayan
    //     olay yok, yani §3.2'nin "geri alınabilirlik" iddiası kanıtsız kalıyordu.
    store.tx(() => {
      const newId = appendFinding(store, {
        projectId, source: "imported", content, sourceRef: path, anchors,
        // Not tarihi frontmatter'dan: churn penceresi (Görev 7) import gününden
        // değil notun yazıldığı günden başlamalı, yoksa her not "bugün doğmuş" olur.
        createdAt: stamp.iso,
      });
      if (dropped > 0)
        logEvent(store, { projectId, kind: "import_anchor_overflow", detail: { file: name, kept: anchors.length, dropped } });
      // Kırpma ve kelepçe olayları kaydın KENDİ tx'inde: ikisi de bu kaydın
      // içeriğini/penceresini anlatıyor, ayrı commit edilirse günlük depoyu
      // yanlış anlatır (yukarıdaki değişmez kural).
      if (truncated > 0)
        logEvent(store, {
          projectId, kind: "import_note_truncated",
          detail: { file: name, kept: MAX_NOTE_CHARS, truncated, originalChars: raw.length },
        });
      if (stamp.clamped !== undefined)
        logEvent(store, {
          projectId, kind: "import_timestamp_clamped",
          detail: { file: name, field: stamp.clamped.field, given: stamp.clamped.value, usedIso: stamp.iso },
        });
      if (stamp.unparsable !== undefined)
        logEvent(store, {
          projectId, kind: "import_timestamp_unparsable",
          detail: { file: name, fields: stamp.unparsable, usedIso: stamp.iso },
        });
      if (existing) {
        supersede(store, existing.id, newId);
        logEvent(store, {
          projectId, kind: "finding_superseded",
          detail: { oldId: existing.id, newId, reason: "memory_file_changed", file: name },
        });
      }
    });
    // Sayaçlar tx'ten SONRA: geri alınan bir işlem özet sayısına yansımamalı
    // (tx atarsa buraya hiç gelinmez).
    if (existing) sum.replaced++;
    else sum.added++;
  }

  // Diskte artık olmayan dosyaların temsilleri: superseded (yerine geçen yok).
  const gone = store.all<{ id: number; source_ref: string }>(
    `SELECT id, source_ref FROM findings
     WHERE project_id = ? AND source = 'imported' AND status != 'superseded'`,
    projectId,
  ).filter((r) => !currentRefs.has(r.source_ref));
  for (const g of gone) {
    // Yukarıdakiyle aynı gerekçe: supersede ile onu açıklayan olay ayrılamaz.
    // Burada tek satır bile olsa tx şart — olay yazımı patlarsa kayıt sebepsiz
    // superseded kalırdı, ve "yanlışsa tek tıkla geri al" iddiası günlükten
    // okunamaz hâle gelirdi.
    store.tx(() => {
      supersede(store, g.id);
      logEvent(store, { projectId, kind: "import_file_deleted", detail: { findingId: g.id, file: g.source_ref } });
    });
    sum.deleted++;
  }

  return sum;
}
