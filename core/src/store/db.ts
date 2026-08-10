// Deponun TEK SQLite teması. Başka hiçbir dosya "node:sqlite" import etmez —
// node:sqlite deneysel olduğu için takasın tek dosyalık iş kalması gerekiyor
// (spec K12). Diğer modüller yalnız aşağıdaki Store arayüzünü görür.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type SqlValue = string | number | null | bigint | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface Store {
  /** Satır döndürmeyen ifade. */
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  /** Tek satır ya da undefined. */
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  /** Tüm satırlar. */
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  /** İşlem: fn atarsa geri alınır. */
  tx<T>(fn: () => T): T;
  /** Silme korumaları yerinde mi; eksikse geri kurar. Tarama başında çağrılır. */
  verifyGuards(): void;
  close(): void;
}

/** Varsayılan depo yolu — merkezi, proje yoluyla anahtarlı (spec K4). */
export function defaultStorePath(): string {
  return join(homedir(), ".context-police", "store.db");
}

/**
 * Var olan depoyu güncel şemaya taşır. `CREATE TABLE IF NOT EXISTS` var olan
 * tabloya ne sütun ekler ne birincil anahtarını değiştirir; bu yüzden şema
 * değişimi ayrıca ele alınmak zorunda.
 *
 * Doğrulama turunda ölçüldü ve pahalıya mal oldu: imleç anahtarı
 * (proje, oturum)'dan dosya yoluna geçtiğinde eski depolar tabloyu eski
 * anahtarla taşımaya devam etti, `ON CONFLICT (file_path)` hiçbir kısıtla
 * eşleşmedi ve imleç YAZILAMAZ oldu — yani her tarama her şeyi yeniden teslim
 * ederdi. Sessiz değil gürültülü bir arıza olması bile tesadüftü.
 */
function migrate(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(cursors)").all() as { name: string; pk: number }[];
  if (cols.length === 0) return; // yeni depo: şema zaten güncel

  const hasMtime = cols.some((c) => c.name === "mtime_ms");
  const keyedByFilePath = cols.some((c) => c.name === "file_path" && c.pk === 1);

  if (!hasMtime) db.exec("ALTER TABLE cursors ADD COLUMN mtime_ms REAL");

  if (!keyedByFilePath) {
    // Aynı dosya yolu eski şemada birden çok satırda olabilir (kimlik değişimi
    // yetim satır bırakıyordu); en ileri imleci koruyoruz — geri gitmek veri
    // tekrarı demek.
    db.exec(`
      CREATE TABLE cursors_migrated (
        file_path    TEXT PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id),
        session_id   TEXT NOT NULL,
        byte_offset  INTEGER NOT NULL DEFAULT 0,
        inode        TEXT,
        mtime_ms     REAL,
        last_seen_at TEXT
      );
      INSERT INTO cursors_migrated (file_path, project_id, session_id, byte_offset, inode, mtime_ms, last_seen_at)
      SELECT file_path, project_id, session_id, MAX(byte_offset), inode, mtime_ms, last_seen_at
      FROM cursors GROUP BY file_path;
      DROP TABLE cursors;
      ALTER TABLE cursors_migrated RENAME TO cursors;
    `);
  }
}

/**
 * Append-only tetikleyicileri yerinde mi? Bir düzeltmenin açtığı delik:
 * `Store.run` üzerinden `DROP TRIGGER` çalıştırılabiliyor ve o andan sonra
 * silme koruması yok oluyor. Tetikleyiciyi yeniden kurmak ucuz; kaybını fark
 * etmemek pahalı.
 */
function ensureGuards(db: DatabaseSync, schema: string): void {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[])
      .map((t) => t.name),
  );
  const required = ["findings_content_immutable", "findings_no_delete", "events_no_delete"];
  if (required.every((t) => present.has(t))) return;
  db.exec(schema); // CREATE TRIGGER IF NOT EXISTS — eksikleri geri koyar
}

/**
 * `run` yalnız VERİ ifadesi kabul eder. Şema ve işlem denetimi buradan geçmez.
 *
 * Doğrulama turunda iki ayrı bulgu aynı köke çıktı: `Store.run` keyfi SQL
 * alıyordu, dolayısıyla in-process bir çağıran `DROP TRIGGER` ile silme
 * korumasını kaldırabiliyor ya da `RELEASE cp_sp_1` ile bizim geri alma
 * noktamızı sabote edip özgün hatayı maskeleyebiliyordu. Depo API'sinin
 * sözleşmesi "veri yaz/oku"; şema değişimi yalnız göç kodunun işi.
 */
const DATA_STATEMENT = /^\s*(?:WITH|SELECT|INSERT|UPDATE|DELETE)\b/i;

function assertDataStatement(sql: string): void {
  if (!DATA_STATEMENT.test(sql)) {
    throw new Error(`Store.run yalnız veri ifadesi alır (şema/işlem denetimi yasak): ${sql.trim().slice(0, 60)}`);
  }
}

export function openStore(path: string): Store {
  if (path !== ":memory:") {
    // Depo transcript'lerden türetilmiş içerik barındırıyor; çok kullanıcılı bir
    // makinede varsayılan umask (022) bunu 0755/0644 bırakıyordu — başka bir
    // yerel hesap okuyabiliyordu. Denetim bulgusu, ölçülerek doğrulandı.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
  }
  const db = new DatabaseSync(path);

  const schema = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
  db.exec(schema);

  migrate(db);
  ensureGuards(db, schema);

  // WAL ve SHM yan dosyaları SQLite tarafından şema uygulanırken yaratılıyor;
  // izinleri ancak var olduktan sonra sıkılaştırılabilir.
  if (path !== ":memory:") {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(p)) chmodSync(p, 0o600);
    }
  }

  let txDepth = 0;
  let savepointSeq = 0;

  return {
    run(sql, ...params) {
      assertDataStatement(sql);
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    tx<T>(fn: () => T): T {
      // İç içe çağrı SAVEPOINT alır. Önceki hâli yalnız derinlik sayacıydı ve
      // denetimde kırıldı: dış işlem iç hatayı yakalarsa iç yazımlar commit
      // ediliyordu (yarım bulgu diske kalıyordu). Sayaç bir işlemi temsil
      // edebilir ama geri alamaz — geri alma noktası gerekiyor.
      const depth = txDepth++;
      // Ad derinlikten türetiliyordu; aynı derinlik iki kez kullanılınca
      // "no such savepoint" hatası ÖZGÜN hatayı maskeliyordu (doğrulama turu).
      const savepoint = `cp_sp_${++savepointSeq}`;
      db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
      try {
        const out = fn();
        // Async geri çağırım sessizce erken commit edilirdi: Promise beklenmeden
        // COMMIT çalışıp sonra reject olurdu. tx senkron sözleşmelidir; ihlali
        // sessiz veri bütünlüğü hatası yerine gürültülü hata olmalı.
        if (out !== null && typeof (out as { then?: unknown })?.then === "function") {
          // Sahipsiz reddi burada yutuyoruz: aksi hâlde bizim fırlattığımız
          // TypeError'ın yanında bir de unhandledRejection süreci öldürüyordu.
          void (out as Promise<unknown>).catch(() => {});
          throw new TypeError("tx() senkron geri çağırım bekler; async fonksiyon veri bütünlüğünü bozar");
        }
        db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
        return out;
      } catch (err) {
        // Geri alma başarısız olursa bunu YENİ bir hata olarak fırlatmak
        // özgün sebebi gizler; sebep zincire eklenir, üste hep özgün hata çıkar.
        try {
          if (depth === 0) db.exec("ROLLBACK");
          else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        } catch (rollbackErr) {
          (err as { rollbackError?: unknown }).rollbackError = rollbackErr;
        }
        throw err;
      } finally {
        txDepth--;
      }
    },
    verifyGuards() {
      ensureGuards(db, schema);
    },
    close() {
      db.close();
    },
  };
}

/** ISO-8601 UTC — depodaki her zaman damgasının tek biçimi. */
export function nowIso(): string {
  return new Date().toISOString();
}
