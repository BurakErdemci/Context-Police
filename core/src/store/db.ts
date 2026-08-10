// Deponun TEK SQLite teması. Başka hiçbir dosya "node:sqlite" import etmez —
// node:sqlite deneysel olduğu için takasın tek dosyalık iş kalması gerekiyor
// (spec K12). Diğer modüller yalnız aşağıdaki Store arayüzünü görür.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
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
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  const schema = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
  db.exec(schema);

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
      // İç içe çağrılar tek işlem sayılır; SAVEPOINT yerine sayaç yeterli
      // çünkü çekirdek tek iş parçacıklı ve iç içe geri alma senaryosu yok.
      if (txDepth++ > 0) {
        try {
          return fn();
        } finally {
          txDepth--;
        }
      }
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
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
