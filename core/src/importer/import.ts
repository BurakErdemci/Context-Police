// Import eşlemedir, senkron değil (spec §3.2): kaynak dosya her zaman gerçek,
// depo onun gölgesi + denetim üst-verisi. Değişen dosya = eski temsil superseded
// + yeni kayıt; dosya UPDATE edilmez (append-only tetikleyicisi zaten engeller).

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Store } from "../store/db.ts";
import { nowIso } from "../store/db.ts";
import { appendFinding, supersede } from "../store/findings.ts";
import { logEvent } from "../store/events.ts";
import { parseNote, extractAnchors, noteTimestamp } from "./parse.ts";

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
        if (!inMemoryTree(base, target)) {
          sum.rejected++;
          logEvent(store, {
            projectId, kind: "import_entry_rejected",
            detail: { file: path, target, reason: "symlink_outside_memory_dir" },
          });
          // currentRefs'e girmez: bugün o yolda duran şey kayda aldığımız not
          // değil. Eski temsil süpürmede superseded olur — silme değil işaretleme
          // olduğu için yanlışsa tek adımda geri alınır (spec §3.2).
          continue;
        }
      }
      raw = await readFile(path, "utf8");
    } catch (err) {
      sum.errors++;
      logEvent(store, { projectId, kind: "import_read_failed", detail: { file: path, error: String(err) } });
      // ENOENT DIŞI hata dosyanın yokluğunu KANITLAMAZ (EACCES geçici olabilir,
      // EISDIR/EIO yolun dolu olduğunu söyler): yolu güncel say, yoksa tek bir
      // okuma hatası kaydı "silinmiş" diye superseded ederdi. ENOENT ise dosya
      // listeleme ile okuma arasında gerçekten kayboldu → süpürme görsün.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") currentRefs.add(path);
      continue;
    }
    // Okuma başarılı olduktan SONRA: "diskte hâlâ var" iddiası ancak burada doğru.
    currentRefs.add(path);

    // En son canlı temsil: aynı dosyanın superseded olmayan en yeni kaydı.
    const existing = store.get<{ id: number; content: string }>(
      `SELECT id, content FROM findings
       WHERE project_id = ? AND source = 'imported' AND source_ref = ? AND status != 'superseded'
       ORDER BY id DESC LIMIT 1`,
      projectId, path,
    );
    if (existing && existing.content === raw) { sum.unchanged++; continue; }

    const { frontmatter } = parseNote(raw);
    const { anchors, dropped } = extractAnchors(raw);
    // Yeni kayıt ve eskisinin supersede'i TEK işlemde: arada çökme, aynı dosyanın
    // iki canlı temsilini bırakırdı (yukarıdaki "en yeni" sorgusu sessizce
    // eskisini gözden kaçırır).
    const newId = store.tx(() => {
      const id = appendFinding(store, {
        projectId, source: "imported", content: raw, sourceRef: path, anchors,
        // Not tarihi frontmatter'dan: churn penceresi (Görev 7) import gününden
        // değil notun yazıldığı günden başlamalı, yoksa her not "bugün doğmuş" olur.
        createdAt: noteTimestamp(frontmatter, nowIso()),
      });
      if (existing) supersede(store, existing.id, id);
      return id;
    });
    if (dropped > 0)
      logEvent(store, { projectId, kind: "import_anchor_overflow", detail: { file: name, kept: anchors.length, dropped } });
    if (existing) {
      sum.replaced++;
      logEvent(store, {
        projectId, kind: "finding_superseded",
        detail: { oldId: existing.id, newId, reason: "memory_file_changed", file: name },
      });
    } else sum.added++;
  }

  // Diskte artık olmayan dosyaların temsilleri: superseded (yerine geçen yok).
  const gone = store.all<{ id: number; source_ref: string }>(
    `SELECT id, source_ref FROM findings
     WHERE project_id = ? AND source = 'imported' AND status != 'superseded'`,
    projectId,
  ).filter((r) => !currentRefs.has(r.source_ref));
  for (const g of gone) {
    supersede(store, g.id);
    sum.deleted++;
    logEvent(store, { projectId, kind: "import_file_deleted", detail: { findingId: g.id, file: g.source_ref } });
  }

  return sum;
}
