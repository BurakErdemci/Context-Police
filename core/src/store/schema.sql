-- Context Police deposu. Spec §3.2 + M0 geri beslemeleri.
-- Bu dosya idempotent uygulanır: her açılışta koşar, var olanı bozmaz.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  adapter_id      TEXT NOT NULL,
  transcript_dir  TEXT NOT NULL,
  memory_dir      TEXT,
  last_scanned_at TEXT
);

-- Transcript dosyası başına artımlı okuma imleci. Dosyanın tamamı asla yeniden
-- okunmaz (spec §3.3). inode saklanıyor çünkü dosyanın yerine yenisi konursa
-- offset anlamını yitirir — kısalma tespiti buna dayanıyor.
CREATE TABLE IF NOT EXISTS cursors (
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  session_id   TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  byte_offset  INTEGER NOT NULL DEFAULT 0,
  inode        TEXT,
  last_seen_at TEXT,
  PRIMARY KEY (project_id, session_id)
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
