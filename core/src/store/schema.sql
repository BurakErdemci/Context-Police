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

-- Sınıflama bütçesinin (MAX_CLASSIFY_ITEMS) YÜZEY BAŞINA rotasyon imleci:
-- "bu yüzeyin kararlı aday sırasında bir sonraki koşum nereden başlayacak".
--
-- Neden konum, neden not damgası DEĞİL (denetim: `classification-candidate-
-- starvation`, 12 Ağu 2026): rotasyon durumu bir gün önce NOT başına tutuluyordu
-- (findings.last_classified_at), oysa tavanlanan iş birimi ÇİFT. Yedi notun her
-- ikilisi bir çapa paylaştığında 21 aday çıkıyor; tavan 20'yi alıyor ama o 20
-- kenar yedi notun HEPSİNE dokunuyor, dolayısıyla ölçüm damgası bütün notlara
-- yazılıyordu. Ölçülmemiş 21. çift, ölçülmüşlerle aynı anahtarı alıyor ve
-- kararlı sıralama onu her koşumda yeniden dışarıda bırakıyordu — 8 koşum
-- boyunca ölçüldü, hep atlandı. Durum çift bazında olmalıydı ya da hiç
-- olmamalıydı; imleç ikincisini seçiyor.
--
-- İmlecin ispatı YAPICI: her koşum imleci SEÇİLEN aday sayısı kadar ilerletiyor
-- ve pencere listede dönüyor, dolayısıyla N aday ve M<N tavanla ⌈N/M⌉ koşumda
-- her aday en az bir kez seçiliyor. İlerleme ölçümün SONUCUNA bağlı değil
-- (seçildi mi, ilerledi): sürekli hüküm döndürmeyen zehirli bir parti, geri
-- kalan adayların sırasını kilitleyemesin.
--
-- Satır sayısı sınırlı: proje başına en çok yüzey sayısı kadar (3). Budama
-- sorusu yok — çift başına durum tutan alternatifin (aday tablosu) getirdiği
-- kareli büyüme ve "bulgu süpersede olunca satır ne olacak" sorusu da yok.
CREATE TABLE IF NOT EXISTS classify_cursors (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind       TEXT NOT NULL,
  next_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, kind)
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
