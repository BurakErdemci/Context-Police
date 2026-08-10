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
  close(): void;
}

/** Varsayılan depo yolu — merkezi, proje yoluyla anahtarlı (spec K4). */
export function defaultStorePath(): string {
  return join(homedir(), ".context-police", "store.db");
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

  // CREATE TABLE IF NOT EXISTS var olan tabloya sütun eklemez; şema büyüdükçe
  // eski depolar sessizce eksik kalırdı. Eklenen her sütun buraya bir satır.
  const cursorCols = new Set(
    (db.prepare("PRAGMA table_info(cursors)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!cursorCols.has("mtime_ms")) db.exec("ALTER TABLE cursors ADD COLUMN mtime_ms REAL");

  // WAL ve SHM yan dosyaları SQLite tarafından şema uygulanırken yaratılıyor;
  // izinleri ancak var olduktan sonra sıkılaştırılabilir.
  if (path !== ":memory:") {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(p)) chmodSync(p, 0o600);
    }
  }

  let txDepth = 0;

  return {
    run(sql, ...params) {
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
      const savepoint = `cp_sp_${depth}`;
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
        if (depth === 0) db.exec("ROLLBACK");
        else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw err;
      } finally {
        txDepth--;
      }
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
