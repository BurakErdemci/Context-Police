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
  migrateCursors(db);
  migrateWatermarks(db);
}

/**
 * Tablo yeniden kurularak yapılan göçün geçici tablo son eki. TEK yerde tanımlı,
 * çünkü kurtarma kodu yetim ara tabloyu tam olarak bu ekten tanıyor.
 */
const MIGRATION_SUFFIX = "_migrated";

/** DDL dahil her şeyi tek işleme sarar; hata hâlinde geri alır. */
function inTransaction(db: DatabaseSync, fn: () => void): void {
  // IMMEDIATE: yazma kilidini hemen alır. Gecikmeli kilit, göçün ortasında
  // SQLITE_BUSY ile yarıda kalabilir — atomiklik istediğimiz yerde en istemediğimiz şey.
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErr) {
      (err as { rollbackError?: unknown }).rollbackError = rollbackErr;
    }
    throw err;
  }
}

/**
 * "Yarat → kopyala → düşür → yeniden adlandır" göçünün TEK ve GÜVENLİ kalıbı.
 *
 * NEDEN TEK YERDE: bu SINIF projede ÜÇ kez çıktı — M1'de imleç tablosunun
 * anahtarı değişti, M2 doğrulama turunda filigran tablosuna sütun eklendi, 2.
 * doğrulama turunda ise göç ADIMLARININ atomik olmadığı ölçüldü. İlk iki kez
 * kalıp kopyalandığı için kusur da kopyalandı. Yeni bir tablo şeması
 * değişecekse yazılacak yer bu fonksiyonun ÇAĞRISI, kalıbın kendisi değil.
 *
 * Ölçülen kırılma (probes/interrupted-watermark-migration.sh): dört DDL
 * ifadesi ayrı ayrı otomatik commit ediliyordu; `CREATE TABLE` ile `DROP TABLE`
 * arasında öldürülen bir süreç kalıcı bir `..._migrated` tablosu bırakıyor ve
 * sonraki açılış `table observer_watermarks_migrated already exists` ile
 * ÖLÜYORDU — depo bir daha açılamıyor. Tek işlem bunu imkânsız kılar: ya hepsi
 * ya hiçbiri.
 */
function rebuildTable(db: DatabaseSync, table: string, sql: (tmp: string) => string): void {
  const tmp = `${table}${MIGRATION_SUFFIX}`;
  inTransaction(db, () => {
    // Eski bir sürümün bıraktığı yetim ara tabloya karşı: kurtarma zaten
    // temizliyor ama kalıp kendi başına da yeniden koşulabilir olmalı.
    db.exec(`DROP TABLE IF EXISTS "${tmp}"`);
    db.exec(sql(tmp)); // tmp'yi yaratır ve eskiden kopyalar
    db.exec(`DROP TABLE "${table}"`);
    db.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
  });
}

/**
 * Yarıda kesilmiş bir göçün bıraktığı ara tabloyu temizler ya da yerine oturtur.
 * Tek işlem sözleşmesi bugünden sonrasını kurtarır; ESKİ sürümle bozulmuş bir
 * depo hâlâ diskte duruyor ve kendiliğinden açılabilmeli.
 *
 * ŞEMADAN ÖNCE ÇALIŞMAK ZORUNDA: schema.sql'in `CREATE TABLE IF NOT EXISTS`i,
 * göç "düşür" ile "yeniden adlandır" arasında kesilmişse hedefi BOŞ olarak
 * yeniden yaratır; o andan sonra veri yetim tabloda kalır ve ayırt edilemez.
 * Satır sayısı ölçütü tam da bu durumu ayırıyor — hiçbir dalda satır kaybolmaz.
 */
function recoverInterruptedMigrations(db: DatabaseSync): void {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((t) => t.name);
  const orphans = tables.filter((n) => n.endsWith(MIGRATION_SUFFIX) && n.length > MIGRATION_SUFFIX.length);
  if (orphans.length === 0) return;

  const rowCount = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n);

  inTransaction(db, () => {
    for (const tmp of orphans) {
      const target = tmp.slice(0, -MIGRATION_SUFFIX.length);
      if (!tables.includes(target)) {
        // "DROP TABLE eski" ile "RENAME" arasında kesilmiş: veri yalnız tmp'de.
        db.exec(`ALTER TABLE "${tmp}" RENAME TO "${target}"`);
      } else if (rowCount(target) === 0 && rowCount(tmp) > 0) {
        // Hedef sonradan schema.sql tarafından BOŞ yaratılmış; gerçek veri tmp'de.
        db.exec(`DROP TABLE "${target}"`);
        db.exec(`ALTER TABLE "${tmp}" RENAME TO "${target}"`);
      } else {
        // Kopyalama yarıda kalmış: hedef hâlâ tam, tmp eksik bir kopya. Atılır ve
        // göç aşağıda baştan koşar.
        db.exec(`DROP TABLE "${tmp}"`);
      }
    }
  });
}

function migrateCursors(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(cursors)").all() as { name: string; pk: number }[];
  if (cols.length === 0) return; // yeni depo: şema zaten güncel

  const hasMtime = cols.some((c) => c.name === "mtime_ms");
  const keyedByFilePath = cols.some((c) => c.name === "file_path" && c.pk === 1);

  if (!hasMtime) db.exec("ALTER TABLE cursors ADD COLUMN mtime_ms REAL");

  if (!keyedByFilePath) {
    // Aynı dosya yolu eski şemada birden çok satırda olabilir (kimlik değişimi
    // yetim satır bırakıyordu); en ileri imleci koruyoruz — geri gitmek veri
    // tekrarı demek.
    rebuildTable(db, "cursors", (tmp) => `
      CREATE TABLE ${tmp} (
        file_path    TEXT PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id),
        session_id   TEXT NOT NULL,
        byte_offset  INTEGER NOT NULL DEFAULT 0,
        inode        TEXT,
        mtime_ms     REAL,
        last_seen_at TEXT
      );
      INSERT INTO ${tmp} (file_path, project_id, session_id, byte_offset, inode, mtime_ms, last_seen_at)
      SELECT file_path, project_id, session_id, MAX(byte_offset), inode, mtime_ms, last_seen_at
      FROM cursors GROUP BY file_path;
    `);
  }
}

/**
 * observer_watermarks M2'de ÜÇ kez değişti: `last_ts` eklendi, `last_uuid`
 * NOT NULL'dan nullable'a döndü, ve nihayet kimlik bütünüyle konumsala geçti
 * (byte_offset / delivery_key / delivery_turns eklendi, "biri dolu olmalı"
 * CHECK kısıtı kalktı).
 *
 * AYNI SINIF DÖRDÜNCÜ KEZ: M1 denetiminde imleç tablosu için çıktı
 * (schema-migration-breaks-cursor, o turun en ciddi bulgusuydu), M2 doğrulama
 * turunda filigran tablosu için, 2. doğrulama turunda göç adımlarının atomik
 * olmaması olarak, şimdi de kök tasarım değişikliğiyle. Kalıcı örüntü:
 * `CREATE TABLE IF NOT EXISTS` var olan tabloya DOKUNMAZ, dolayısıyla her tablo
 * değişimi burada ayrıca ele alınmak zorunda ve YENİ depoda çalışması kanıt
 * değildir — doğrulama var olan bir depo dosyası üzerinde yapılır.
 *
 * Sütun eklemek tek başına ALTER ile mümkün olurdu, ama CHECK kısıtı SQLite'ta
 * ALTER ile KALDIRILAMAZ: eski kısıt uuid'siz ve damgasız (yalnız ofsetli)
 * checkpoint'i reddeder, yani göç "başarılı" görünürken filigran yazılamaz
 * hâle gelirdi. O yüzden tablo yeniden kuruluyor — kalıp kopyalanmaz,
 * `rebuildTable` çağrılır.
 */
function migrateWatermarks(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(observer_watermarks)").all() as {
    name: string;
    notnull: number;
  }[];
  if (cols.length === 0) return; // yeni depo: şema zaten güncel
  if (cols.some((c) => c.name === "byte_offset")) return; // güncel

  // Eski depolar iki kuşak olabilir: last_ts'li ve last_ts'siz. Eksik sütunu
  // SELECT'te NULL ile dolduruyoruz, yoksa kopyalama SQL hatasıyla düşer.
  const hasLastTs = cols.some((c) => c.name === "last_ts");

  rebuildTable(db, "observer_watermarks", (tmp) => `
    CREATE TABLE ${tmp} (
      project_id     INTEGER NOT NULL REFERENCES projects(id),
      session_id     TEXT NOT NULL,
      byte_offset    INTEGER,
      delivery_key   TEXT,
      delivery_turns INTEGER,
      last_uuid      TEXT,
      last_ts        TEXT,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    INSERT INTO ${tmp} (project_id, session_id, byte_offset, delivery_key, delivery_turns, last_uuid, last_ts, updated_at)
    SELECT project_id, session_id, NULL, NULL, NULL, last_uuid, ${hasLastTs ? "last_ts" : "NULL"}, updated_at
    FROM observer_watermarks;
  `);
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

  // Şemadan ÖNCE: yarıda kesilmiş bir göçün ara tablosu ortadaysa schema.sql
  // hedefi boş yeniden yaratıp veriyi yetim bırakıyor (gerekçe: fonksiyonun
  // kendi yorumunda).
  recoverInterruptedMigrations(db);

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
