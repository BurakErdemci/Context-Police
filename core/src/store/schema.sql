-- Context Police deposu. Spec §3.2 + M0 geri beslemeleri.
-- Bu dosya idempotent uygulanır: her açılışta koşar, var olanı bozmaz.

-- journal_mode BURADA DEĞİL, db.ts'te (enableWal): WAL'a geçiş busy_timeout'u
-- dinlemiyor, başka bir bağlantı bağlıyken anında SQLITE_BUSY dönüyor (ölçüldü).
-- Bu dosyanın içinde kalsaydı tek bir eşzamanlı yazıcı, şemanın TAMAMININ
-- uygulanmasını engellerdi.
PRAGMA foreign_keys = ON;
-- SQLite, REPLACE'in yaptığı örtük silmede DELETE tetikleyicilerini YALNIZ
-- recursive_triggers açıkken çalıştırıyor. Denetimde ölçüldü — bu satır olmadan
-- `INSERT OR REPLACE` ile hem findings.content hem bir events satırı sessizce
-- değiştirilebiliyordu.
--
-- KAPSAM UYARISI (ölçüldü: external-replace-bypasses-append-only): pragma
-- BAĞLANTI-YERELDİR. Buradaki satır yalnız bu dosyayı çalıştıran bağlantıyı,
-- yani openStore()'un açtığı bağlantıyı bağlar. Depoyu varsayılanlarla açan
-- BAŞKA bir süreç (sqlite3 CLI dahil) bu pragmayı görmez. O yüzden asıl koruma
-- aşağıdaki ..._no_replace tetikleyicileridir: onlar bağlantı ayarından
-- bağımsız çalışır. Pragma yine de duruyor, çünkü DELETE tetikleyicisinin
-- REPLACE yolunda çalışması hâlâ istenen davranış.
PRAGMA recursive_triggers = ON;

CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  adapter_id      TEXT NOT NULL,
  transcript_dir  TEXT NOT NULL,
  memory_dir      TEXT,
  last_scanned_at TEXT
);

-- Transcript dosyası başına artımlı okuma imleci. Dosyanın tamamı asla yeniden
-- okunmaz (spec §3.3). inode ve mtime saklanıyor çünkü dosyanın yerine yenisi
-- konursa ya da yerinde yeniden yazılırsa offset anlamını yitirir.
--
-- Anahtar FİZİKSEL DOSYA YOLU, (proje, oturum) değil. Sebep denetimde çıktı:
-- proje kimliği transcript'ten okunan cwd'ye bağlı ve sonradan değişebiliyor;
-- kimlik değişince imleç yetim kalıp aynı bayt aralığı yeniden teslim ediliyordu.
-- Bayt akışının kimliği dosyanın kendisidir; proje o akışın üst-verisi.
CREATE TABLE IF NOT EXISTS cursors (
  file_path    TEXT PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  session_id   TEXT NOT NULL,
  byte_offset  INTEGER NOT NULL DEFAULT 0,
  inode        TEXT,
  mtime_ms     REAL,
  last_seen_at TEXT
);

-- Gözlemci filigranı: oturum başına "nereye kadar gözlemlendi" (D-M2-2).
-- İmleçten AYRI, çünkü işleri farklı: imleç "nereden okunacak"ı, filigran
-- "nereye kadar gözlemlendi"yi tutar. Teslim en-az-bir-kez olduğu için ikisi
-- ayrışabilir; filigran bulgularla aynı tx'te ilerleyerek mükerrer üretimi keser.
-- Turn içeriği burada YOK — transcript zaten diskte, depoda turn tablosu olmaz.
--
-- KİMLİK KONUMSAL (kök tasarım değişikliği, 11 Ağu 2026). Üç doğrulama turu
-- "işlendi mi" sorusunu turn'ün İÇERİĞİNDEN (uuid + damga) cevaplamanın her
-- seferinde yeni bir kayıp ürettiğini ölçtü. Oysa okuma hangi bayt aralığını
-- getirdiğini KESİN biliyor:
--   byte_offset     bu ofsete kadarki her bayt işlendi (monoton; kısalmada NULL'lanır)
--   delivery_key    yarım kalmış teslimatın kimliği ([from,to,turn sayısı] ya da içerik özeti)
--   delivery_turns  o teslimatın kaç turn'lük ön eki işlendi (bütçe/çökme sonrası devam noktası)
-- last_uuid ve last_ts KARAR ALANI DEĞİL, yalnız teşhis: hangi turn'e kadar
-- gidildiği olay günlüğünde okunabilsin diye duruyor. Bu yüzden eski
-- "biri dolu olmalı" CHECK kısıtı da kaldırıldı — kimliği artık ofset taşıyor.
CREATE TABLE IF NOT EXISTS observer_watermarks (
  project_id     INTEGER NOT NULL REFERENCES projects(id),
  session_id     TEXT NOT NULL,
  byte_offset    INTEGER,
  delivery_key   TEXT,
  delivery_turns INTEGER,
  last_uuid      TEXT,
  last_ts        TEXT,
  -- --session yolu için tazelik: readIncremental'ın yerinde-yazım tespiti
  -- (claude-code.ts replacedInPlace) bu ikisi olmadan çalışamıyor — M2'de null
  -- geçiliyordu ve aynı boyutta yeniden yazılan dosya görünmüyordu (M3 borç 2).
  -- Tarama yolunun karşılığı cursors tablosunda; filigran ayrı tutuyor, çünkü
  -- --session imleçlere hiç dokunmuyor.
  inode          TEXT,
  mtime_ms       REAL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id)
);

-- Aynı anda iki tarama aynı imleci okuyup aynı aralığı iki kez teslim
-- edebiliyordu (denetim bulgusu). Tek satırlık kilit; sahibi kalp atışını
-- tazelemeyi bırakırsa devralınır (bkz. lock.ts).
--
-- `heartbeat_at` NULLABLE, çünkü göç yolunda eski satırlarda yok. NULL =
-- "hiç atış görmedik" ve tazelik ölçümü `acquired_at`'e düşer; kilidi bu
-- kuşaktan bir yazıcı yazmışsa zaten çoktan bayatlamıştır.
CREATE TABLE IF NOT EXISTS scan_lock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  holder       TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  heartbeat_at TEXT
);

CREATE TABLE IF NOT EXISTS findings (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  source        TEXT NOT NULL CHECK (source IN ('observed','imported')),
  content       TEXT NOT NULL,
  source_ref    TEXT,
  created_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspect','superseded','born_invalid','unanchored')),
  superseded_by INTEGER REFERENCES findings(id),
  suspicion     REAL NOT NULL DEFAULT 0 CHECK (suspicion >= 0 AND suspicion <= 1)
);

CREATE INDEX IF NOT EXISTS idx_findings_project_status ON findings(project_id, status);

-- Sınıflama bütçesinin (MAX_CLASSIFY_ITEMS) rotasyon durumu: ADAY KİMLİĞİ
-- başına "en son hangi koşumda SEÇİLDİ". Tasarımın tam gerekçesi ve adaletin
-- ispatı signals/classify.ts'te (`selectCandidates`); özeti:
--
-- Rotasyon durumu üç kuşak geçirdi ve ilk ikisi aynı kök sebepten kanadı —
-- TÜRETİLMİŞ ve DEĞİŞEN bir küme üzerinde KONUM tutmak:
--   1) NOT başına damga (findings.last_classified_at): tavanlanan iş birimi
--      ÇİFT olduğu için yanlış granülarite. K7'de seçilen 20 kenar yedi notun
--      hepsine dokunuyor, 21. çift ölçülmediği hâlde "ölçülmüş" sayılıyordu.
--   2) Yüzeyin aday listesinde KONUMSAL imleç (classify_cursors): sabit listede
--      adil, ama aday listesi sabit değil. Ölçüldü (probe
--      candidate-churn-coverage-bound, 6 koşum): diğer adaylar her koşumda
--      değişince sabit bir çift pencerenin arkasına düşüp sonsuza aç kaldı.
--   3) Bu tablo: damga adayın KİMLİĞİNE yazılıyor, listedeki yerine değil.
--      Seçilmeyen aday her zaman seçilenden daha eski damga taşır, dolayısıyla
--      sonraki koşumda kesinlikle öne gelir — ve bu churn'den bağımsız.
--
-- Damga SEÇİM anında yazılır, hükmün dönüp dönmediğine bakılmadan: sonuca
-- bağlansaydı hiç hüküm döndürmeyen zehirli bir parti seçimi kilitlerdi.
--
-- `selected_seq` bir SAAT DEĞİL, proje başına artan bir koşum sayacı: sıralama
-- deterministik olsun ve testler saate bağlanmasın diye.
--
-- b_id NULL DEĞİL, -1 sentinel (intra/frontmatter tek notluk). SQLite'ta
-- birincil anahtar sütunu NULL olabiliyor ve NULL ≠ NULL — ON CONFLICT hiçbir
-- satırla eşleşmez, yani her koşum yeni satır yazar ve damga hiç güncellenmezdi.
--
-- BUDAMA: tarafı artık canlı olmayan bulguya ait satır silinir
-- (store/classify-stamps.ts: pruneClassifyStamps, gerekçe orada). Onsuz tablo
-- not sayısında KARELİ büyürdü.
--
-- ESKİ `classify_cursors` TABLOSU BU DOSYADAN KALKTI ve var olan depolarda
-- DÜŞÜRÜLMÜYOR: hiçbir kod onu okumuyor (ölü durum kodda kalmadı), satır sayısı
-- proje başına en çok 3, ve tablo düşürmek geri dönüşü olmayan bir göç.
-- Sıfır kazanç için gerçek bir risk — aynı gerekçe `findings.last_classified_at`
-- sütunu için de yazılı (db.ts).
CREATE TABLE IF NOT EXISTS classify_stamps (
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  kind         TEXT NOT NULL,
  a_id         INTEGER NOT NULL,
  b_id         INTEGER NOT NULL,
  selected_seq INTEGER NOT NULL,
  PRIMARY KEY (project_id, kind, a_id, b_id)
);

-- Çapa öncelik sırası sembol > dosya yolu > satır no (M0-D4). Satır numarası
-- bilerek bir çapa TİPİ değil: kaydı kayınca içerik hâlâ doğru olabiliyor,
-- dolayısıyla şüphe üretmemeli.
CREATE TABLE IF NOT EXISTS anchors (
  id              INTEGER PRIMARY KEY,
  finding_id      INTEGER NOT NULL REFERENCES findings(id),
  kind            TEXT NOT NULL CHECK (kind IN ('file_path','symbol','commit_sha','external_path')),
  value           TEXT NOT NULL,
  taken_at_commit TEXT
);

CREATE INDEX IF NOT EXISTS idx_anchors_finding ON anchors(finding_id);
CREATE INDEX IF NOT EXISTS idx_anchors_value ON anchors(kind, value);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_project_kind ON events(project_id, kind);

-- Append-only, şemayla zorlanıyor (spec K8/§2.3). Kural yorumda kalırsa
-- delinir; burada delinemez: düzeltme yeni kayıt + superseded_by demektir.
CREATE TRIGGER IF NOT EXISTS findings_content_immutable
BEFORE UPDATE OF content ON findings
BEGIN
  SELECT RAISE(ABORT, 'findings.content append-only: yeni kayit acip supersede edin');
END;

-- Silme operasyonu yok — yanlış işaretin maliyetini sıfırda tutan şey bu.
CREATE TRIGGER IF NOT EXISTS findings_no_delete
BEFORE DELETE ON findings
BEGIN
  SELECT RAISE(ABORT, 'findings silinemez: yalnizca superseded isaretlenir');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events denetim gunlugu: silinemez');
END;

-- Yukarıdaki DELETE korumaları REPLACE yolunda yalnız recursive_triggers AÇIKKEN
-- ateşleniyor ve o pragma bağlantı-yerel; depoyu dışarıdan varsayılanlarla açan
-- bir yazıcı `INSERT OR REPLACE` ile satırı yerinde yeniden yazabiliyordu
-- (ölçüldü). Aşağıdaki iki tetikleyici aynı deliği bağlantı ayarından BAĞIMSIZ
-- kapatıyor: REPLACE'in örtük silmesi BEFORE INSERT'ten SONRA olduğu için, o an
-- eski satır hâlâ oradadır ve çakışma görülebilir.
--
-- Ölçüldü (node 24.10 / SQLite): rowid verilMEYEN bir INSERT'te NEW.id BEFORE
-- INSERT tetikleyicisinde -1 oluyor (NULL değil). id'ler daima pozitif
-- atandığından koşul yalnız GERÇEK bir çakışmada ateşlenir; normal ekleme
-- etkilenmez (testle sabitlendi).
CREATE TRIGGER IF NOT EXISTS findings_no_replace
BEFORE INSERT ON findings
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM findings WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'findings append-only: var olan id uzerine INSERT OR REPLACE yasak');
END;

CREATE TRIGGER IF NOT EXISTS events_no_replace
BEFORE INSERT ON events
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'events denetim gunlugu: var olan id uzerine INSERT OR REPLACE yasak');
END;
