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
-- `first_seen_seq` (M4.5): adayın sıraya GİRDİĞİ koşum. Damga 0 ("hiç
-- seçilmemiş") eskiden MUTLAK öncelik taşıyordu ve bir yüzeye her koşum
-- rezervinden çok taze aday girdiğinde o yüzeyin ölçülmüş adayları süresiz
-- bekliyordu — açlık sınıfının altıncı biçimi. Taze adayın da bir yaşı olunca
-- öncelik "hiç ölçülmemiş mi"den "ne zamandır bekliyor"a geçiyor.
-- Bu yüzden satır artık SEÇİLEN için değil GÖRÜLEN her aday için yazılıyor
-- (selected_seq = 0: görüldü, hiç ölçülmedi).
--
-- Var olan depoda sütun ALTER ile ekleniyor (db.ts: migrateClassifyStamps);
-- `CREATE TABLE IF NOT EXISTS` var olan tabloya sütun EKLEMEZ (CLAUDE.md §7).
-- Eski satırlarda 0 kalır: seçim damgası zaten dolu olduğu için öncelik ondan
-- okunur, uydurulmuş bir ilk-görülme hiç olmayandan kötü olurdu.
CREATE TABLE IF NOT EXISTS classify_stamps (
  project_id     INTEGER NOT NULL REFERENCES projects(id),
  kind           TEXT NOT NULL,
  a_id           INTEGER NOT NULL,
  b_id           INTEGER NOT NULL,
  selected_seq   INTEGER NOT NULL,
  first_seen_seq INTEGER NOT NULL DEFAULT 0,
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

-- Adjudication outcome, kept apart from `findings.status`/`suspicion`.
--
-- Why a table and not another events row: an events row answers "what happened",
-- while the user surface has to answer "what does the tool conclude about this
-- note, what did it measure, and what should the note say instead". The third
-- part (`correction`) has no home anywhere else in the store — and K9 forbids
-- writing it into the memory file before the user approves, so it has to wait
-- somewhere durable.
--
-- Verdict space is the project's existing five (tools/altin-set/validate.ts);
-- no new value is invented here, because a sixth label would make the M0 and
-- M4 measurements incomparable. `sub_reason` is the extension point instead:
-- it refines a verdict without splitting it (e.g. an `olculemez` that the user
-- could resolve vs one nobody can).
--
-- claim_ref '' = the verdict is about the whole note. Sentinel, not NULL, and
-- the reason is measured in this repo already (classify_stamps.b_id): NULL ≠ NULL
-- in SQLite, so a NULL key silently matches no row in `ON CONFLICT`/unique
-- indexes — here it would let two live verdicts exist for the same note.
--
-- SUPERSESSION IS THE ONLY WAY A VERDICT CHANGES (spec §3.2). A newer verdict on
-- the same claim points the older row's `superseded_by` at itself; the older row
-- keeps its verdict, evidence and correction and stays readable. `review` is a
-- SEPARATE axis: it records what the USER did (approve/reject), not what a later
-- measurement did. Merging the two into one status column would make "the user
-- rejected this" and "a newer measurement replaced this" indistinguishable —
-- and the first is the tool's own error-rate signal (spec §3.2), which must stay
-- countable.
CREATE TABLE IF NOT EXISTS verdicts (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  finding_id    INTEGER NOT NULL REFERENCES findings(id),
  claim_ref     TEXT NOT NULL DEFAULT '',
  verdict       TEXT NOT NULL
                CHECK (verdict IN ('gecerli','curuk','dogustan-yanlis','olculemez','tarihsel')),
  sub_reason    TEXT,
  decay_type    TEXT,
  -- What was measured, and with which command. Evidence is what lets the user
  -- check the tool instead of trusting it (spec §2.1).
  evidence      TEXT,
  method        TEXT,
  -- Replacement wording for the note. NULL = the verdict has no correction to
  -- offer (a measurement can prove a note wrong without knowing what is right).
  correction    TEXT,
  source        TEXT NOT NULL CHECK (source IN ('mechanical','adjudicator')),
  run_id        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  review        TEXT NOT NULL DEFAULT 'pending' CHECK (review IN ('pending','approved','rejected')),
  reviewed_at   TEXT,
  -- How many runs reached this same conclusion. Starts at 1 and rises when a
  -- later run measures the identical thing; no new row is written for a repeat
  -- (recordVerdict/sameConclusion), so without this the repetition left no trace
  -- at all. It carries real signal for the `olculemez` records the audit opens
  -- when a dimension could not be measured: once is noise, twelve runs in a row
  -- is a standing measurement fault the user can act on.
  --
  -- Deliberately OUTSIDE verdicts_measurement_immutable's column list. The
  -- trigger protects the measurement; this is bookkeeping about the measurement,
  -- and it is the one field that must be writable in place — a counter that can
  -- only grow by superseding rows is not a counter.
  repeat_count  INTEGER NOT NULL DEFAULT 1,
  -- Deterministic hash of the evidence this verdict was measured from
  -- (store/verdicts.ts computeEvidenceFingerprint). It exists so that a verdict
  -- the user REJECTED is not re-produced while nothing about the measurement
  -- changed: the next run compares its own fingerprint against the last rejected
  -- one for the same (finding, reason) and, on a match, writes no row at all.
  -- NULL is legitimate and means "written before this column existed" — a NULL
  -- never suppresses, because "same evidence" cannot be claimed without it.
  --
  -- Written once, at INSERT, and deliberately NOT in
  -- verdicts_measurement_immutable's column list: extending that trigger would
  -- only take effect on fresh stores (ensureGuards checks trigger NAMES, and
  -- CREATE TRIGGER IF NOT EXISTS does not rewrite an existing one), so migrated
  -- and fresh stores would enforce different rules on the same column.
  evidence_fingerprint TEXT,
  -- DEFERRED, and the reason is the unique index below: it is checked per
  -- statement, so the old row must stop being live BEFORE the new row is
  -- inserted — which means pointing it at an id that does not exist yet.
  -- An immediate FK rejects that write order and there is no other one.
  superseded_by INTEGER REFERENCES verdicts(id) DEFERRABLE INITIALLY DEFERRED
);

-- At most one live verdict per claim. Enforced by the schema rather than by the
-- writer, because "which verdict is current" is read by every UI query; a second
-- live row makes all of them silently pick one at random.
CREATE UNIQUE INDEX IF NOT EXISTS idx_verdicts_live
  ON verdicts(finding_id, claim_ref) WHERE superseded_by IS NULL;

-- The approval queue, which is the one query the user surface runs on every
-- render. Partial: superseded and already-reviewed rows are the bulk of the
-- table over time and never appear in it.
CREATE INDEX IF NOT EXISTS idx_verdicts_pending
  ON verdicts(project_id, id) WHERE review = 'pending' AND superseded_by IS NULL;

-- One claim's history, oldest first.
CREATE INDEX IF NOT EXISTS idx_verdicts_claim ON verdicts(finding_id, claim_ref, id);

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

-- A verdict is a measurement record: it may be superseded or reviewed, never
-- rewritten. Same contract as findings.content, same reason — a correction that
-- can be edited in place is a correction whose history cannot be audited.
CREATE TRIGGER IF NOT EXISTS verdicts_measurement_immutable
BEFORE UPDATE OF project_id, finding_id, claim_ref, verdict, sub_reason, decay_type,
                 evidence, method, correction, source, run_id, created_at ON verdicts
BEGIN
  SELECT RAISE(ABORT, 'verdicts append-only: yeni hukum acip supersede edin');
END;

CREATE TRIGGER IF NOT EXISTS verdicts_no_delete
BEFORE DELETE ON verdicts
BEGIN
  SELECT RAISE(ABORT, 'verdicts silinemez: yalnizca superseded isaretlenir');
END;

CREATE TRIGGER IF NOT EXISTS verdicts_no_replace
BEFORE INSERT ON verdicts
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM verdicts WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'verdicts append-only: var olan id uzerine INSERT OR REPLACE yasak');
END;

CREATE TRIGGER IF NOT EXISTS events_no_replace
BEFORE INSERT ON events
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'events denetim gunlugu: var olan id uzerine INSERT OR REPLACE yasak');
END;
