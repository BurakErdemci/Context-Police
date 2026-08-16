// Deponun TEK SQLite teması. Başka hiçbir dosya "node:sqlite" import etmez —
// node:sqlite deneysel olduğu için takasın tek dosyalık iş kalması gerekiyor
// (spec K12). Diğer modüller yalnız aşağıdaki Store arayüzünü görür.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, chmodSync, existsSync, statSync } from "node:fs";
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

/**
 * Depoyu kapat: kapatma hatası İŞİN SONUCUNU EZMESİN, ama sessizce de
 * kaybolmasın.
 *
 * Neden var (varyant taraması, 14 Ağu 2026): cli.ts'te dört yerde
 * `try { … return R } finally { store.close() }` kalıbı vardı. Kapanmış bir
 * `DatabaseSync` üzerinde `close()` FIRLATIYOR (mekanizma kanıtlandı), ve
 * `finally` içinden fırlayan hata `try` bloğunun sonucunu/hatasını yerinden
 * ediyor — yani gerçek teşhis, ikincil bir kapanış hatasıyla değiştiriliyor.
 * Bugün bu yolu tetikleyen bir akış BULUNAMADI (sinyal kancası süreçten hemen
 * çıkıyor); bu yüzden düzeltme değil KORUMA olarak yazıldı: ucuz, deterministik,
 * ve `lock.ts`teki `releaseError` ile `inTransaction`daki `rollbackError` ile
 * aynı sözleşme — ikincil hata AYRI bir kanaldan görünür, birincil hata ezilmez.
 *
 * @param report ikincil hatayı bildiren kanal; testler için enjekte edilebilir.
 * @returns temiz kapandıysa true.
 */
export function closeQuietly(store: Pick<Store, "close">, report: (msg: string) => void = console.error): boolean {
  try {
    store.close();
    return true;
  } catch (err) {
    report(`uyarı: depo kapatılamadı: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return false;
  }
}

/** Varsayılan depo yolu — merkezi, proje yoluyla anahtarlı (spec K4). */
export function defaultStorePath(): string {
  return join(homedir(), ".context-police", "store.db");
}

/**
 * Deponun ŞEMA KUŞAĞI. `PRAGMA user_version` ile dosyanın içine yazılır.
 *
 * 1 = kalp atışlı kilit kuşağı (lock.ts). Neden gerekti: kilit sahipliği
 * PID tahmininden atışa geçti ve iki kuşak AYNI depoya yazabiliyor. Eski
 * (atışsız) kod satıra `heartbeat_at` yazmıyor, yeni kod NULL atışı
 * `acquired_at`'e düşürüyor — sonuç, iki sürümün birbirinin CANLI kilidini
 * çalması (probe: mixed-version-null-heartbeat).
 *
 * Damganın KAPATTIĞI yön tek: yeni kodun, kendisinden daha yeni bir kuşak
 * tarafından yazılmış bir depoya göç koşturması. Ters yön (eski kod, yeni
 * depo) buradan kapatılamaz — damgayı hiç okumayan bir sürüme okuma
 * öğretilemez. Bir kuşak eklerken bu sayı artırılır ve karşılığı `migrate()`
 * içinde AYNI commit'te ele alınır (CLAUDE.md §7).
 */
export const SCHEMA_GENERATION = 1;

/** Depo bizden yeni bir kod tarafından yazılmış: göçümüz onu bozabilir. */
export class StoreGenerationTooNew extends Error {
  constructor(path: string, found: number) {
    super(
      `depo şema kuşağı ${found}, bu sürüm en fazla ${SCHEMA_GENERATION} biliyor (${path}) — ` +
        "daha yeni bir context-police bu depoya yazmış; sürümü güncelleyin",
    );
    this.name = "StoreGenerationTooNew";
  }
}

function readGeneration(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
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
  migrateScanLock(db);
  migrateClassifyStamps(db);
  migrateVerdictRepeatCount(db);
}

/**
 * `verdicts.repeat_count` eklendi (schema.sql'de gerekçe). ALTER şart: sütunsuz
 * bir depoda `recordVerdict`in tekrar dalı "no such column" ile patlar — ve o
 * dal AYNI SONUCU ölçen her koşumda işliyor, yani denetim ikinci koşumda tümden
 * durur.
 *
 * `DEFAULT 1` doğru varsayılan: var olan her satır en az bir kez ölçülmüş
 * demektir. Geriye dönük gerçek sayı bilinmiyor (tekrar hiçbir yerde
 * yazılmıyordu) ve 0 yazmak, hiç ölçülmemiş gibi okunurdu.
 *
 * SCHEMA_GENERATION bilerek ARTIRILMADI, `first_seen_seq` ile aynı gerekçe:
 * sütun `NOT NULL DEFAULT 1` ve onu hiç anmayan eski kod bu depoya yazmaya
 * devam edebiliyor, dolayısıyla ileri yönlü bir kırılma yok.
 */
function migrateVerdictRepeatCount(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(verdicts)").all() as { name: string }[];
  if (cols.length === 0) return; // tablo yok: schema.sql onu güncel hâliyle yarattı
  if (!cols.some((c) => c.name === "repeat_count")) {
    db.exec("ALTER TABLE verdicts ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1");
  }
}

/**
 * Rotasyon durumuna ilk-görülme damgası eklendi (M4.5, schema.sql'de gerekçe).
 * `CREATE TABLE IF NOT EXISTS` var olan tabloya sütun eklemediği için ALTER
 * şart: sütunsuz bir depoda hem `SELECT ... first_seen_seq` hem
 * `INSERT (… first_seen_seq)` "no such column" ile patlar — yani rotasyon
 * TÜMDEN durur ve her koşum aynı adayları seçer. Kuşak damgası (SCHEMA_GENERATION)
 * bilerek ARTIRILMADI: sütun `NOT NULL DEFAULT 0` ve onu hiç anmayan eski kod
 * bu depoya yazmaya devam edebiliyor, dolayısıyla ileri yönlü bir kırılma yok —
 * kuşağı artırmak eski sürüme depoyu gereksiz yere reddettirirdi.
 *
 * Tek ifade, sarmalayıcı gerekmiyor: ALTER ya olur ya olmaz.
 */
function migrateClassifyStamps(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(classify_stamps)").all() as { name: string }[];
  if (cols.length === 0) return; // tablo yok: schema.sql onu güncel hâliyle yarattı
  if (!cols.some((c) => c.name === "first_seen_seq")) {
    db.exec("ALTER TABLE classify_stamps ADD COLUMN first_seen_seq INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * BURADA `migrateFindings` YOK — bilerek. Aday rotasyonu bir gün
 * `findings.last_classified_at` sütununu kullanıyordu ve o sütun bu göç
 * listesindeydi; rotasyon önce yüzey başına bir imlece, sonra aday kimliği
 * başına bir damgaya taşınınca (schema.sql: `classify_stamps`, gerekçe orada)
 * sütunu okuyan/yazan kod kalmadı.
 *
 * Var olan bir depoda sütun ARTIK DA DURUYOR ve kaldırılmıyor: kimse okumuyor,
 * INSERT'ler onu hiç anmıyor (NULL kalır), ve `findings` tablosunu yeniden
 * kurmadan sütun düşürmek append-only tetikleyicilerini göç süresince devre
 * dışı bırakmak demekti — sıfır kazanç için gerçek bir risk. Yeni depolarda
 * sütun hiç yaratılmıyor. İki kuşak da açılıyor, çünkü hiçbir sorgu sütunu ADIYLA
 * anmıyor (`getFinding` SELECT * kullanıyor).
 *
 * Aynı gerekçe kaldırılan `classify_cursors` TABLOSU için de geçerli: var olan
 * depolarda duruyor, düşürülmüyor, hiçbir sorgu onu anmıyor.
 *
 * Yeni tablo için ayrı bir göç adımına gerek yok: `schema.sql` HER açılışta
 * koşuyor ve `CREATE TABLE IF NOT EXISTS` var olan depoda eksik TABLOYU yaratır
 * — yapamadığı şey var olan bir tabloya SÜTUN eklemek (CLAUDE.md §7'nin vakası).
 * Yine de var olan bir depo dosyasına karşı testle doğrulandı.
 *
 * `verdicts` (M5) is that case, and there is no `migrateVerdicts` on purpose.
 * Everything it needs — the table, its two partial indexes and its three
 * append-only triggers — is created by an `IF NOT EXISTS` statement that runs on
 * every open, and no EXISTING table gains a column. The one thing that would not
 * self-heal is a missing trigger on a store that already has the table; that is
 * why the three verdict guards are in `ensureGuards`'s required list rather than
 * left to schema.sql alone. Both paths (store predating the table, store already
 * carrying it and its rows) are tested against a real store file copy, because
 * CLAUDE.md §7 says a fresh store proves nothing.
 */

/**
 * Kilit kimliği PID'den kalp atışına geçti (lock.ts). Var olan depolarda
 * `scan_lock` sütunu eksik ve `CREATE TABLE IF NOT EXISTS` onu eklemiyor —
 * sütunsuz bir depoda her `INSERT INTO scan_lock (... heartbeat_at ...)` "no
 * such column" ile patlar, yani kilit HİÇ alınamaz ve tarama da denetim de
 * tümden durur.
 *
 * Tek ifade: `inTransaction` sarmalayıcısına gerek yok, ALTER ya olur ya olmaz;
 * yarım kalabilecek ikinci bir adım yok.
 */
function migrateScanLock(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(scan_lock)").all() as { name: string }[];
  if (cols.length === 0) return; // tablo yok: şema henüz koşmamış
  if (!cols.some((c) => c.name === "heartbeat_at")) {
    db.exec("ALTER TABLE scan_lock ADD COLUMN heartbeat_at TEXT");
  }
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
 *
 * M3'te BEŞİNCİ kez değişti (inode/mtime_ms tazelik alanları). Bu sefer
 * kaldırılacak kısıt yok, o yüzden iki kuşak iki ayrı dalda: eski kuşak zaten
 * yeniden kuruluyor (güncel şemaya doğrudan çıkar), M2-sonu kuşağa yalnız iki
 * sütun ekleniyor.
 */
function migrateWatermarks(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(observer_watermarks)").all() as {
    name: string;
    notnull: number;
  }[];
  if (cols.length === 0) return; // yeni depo: şema zaten güncel

  if (!cols.some((c) => c.name === "byte_offset")) {
    // Eski depolar iki kuşak olabilir: last_ts'li ve last_ts'siz. Eksik sütunu
    // SELECT'te NULL ile dolduruyoruz, yoksa kopyalama SQL hatasıyla düşer.
    const hasLastTs = cols.some((c) => c.name === "last_ts");

    // İçerik-kimlikli eski kuşak DOĞRUDAN güncel şemaya çıkar (inode/mtime_ms
    // dahil): iki aşamalı göç, iki kesilme noktası demek olurdu.
    rebuildTable(db, "observer_watermarks", (tmp) => `
      CREATE TABLE ${tmp} (
        project_id     INTEGER NOT NULL REFERENCES projects(id),
        session_id     TEXT NOT NULL,
        byte_offset    INTEGER,
        delivery_key   TEXT,
        delivery_turns INTEGER,
        last_uuid      TEXT,
        last_ts        TEXT,
        inode          TEXT,
        mtime_ms       REAL,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id)
      );
      INSERT INTO ${tmp} (project_id, session_id, byte_offset, delivery_key, delivery_turns, last_uuid, last_ts, inode, mtime_ms, updated_at)
      SELECT project_id, session_id, NULL, NULL, NULL, last_uuid, ${hasLastTs ? "last_ts" : "NULL"}, NULL, NULL, updated_at
      FROM observer_watermarks;
    `);
    return;
  }

  if (!cols.some((c) => c.name === "inode")) {
    // Konumsal kuşak (M2 sonu): yalnız tazelik alanları eksik. Sütun EKLEMEK
    // ALTER ile güvenli — kaldırılacak bir CHECK kısıtı yok, dolayısıyla tabloyu
    // yeniden kurmaya gerek de yok. İki ifade TEK işlemde: yarıda kesilirse
    // yarım şema kalmasın (2. doğrulama turunun atomiklik dersi).
    inTransaction(db, () => {
      db.exec("ALTER TABLE observer_watermarks ADD COLUMN inode TEXT");
      db.exec("ALTER TABLE observer_watermarks ADD COLUMN mtime_ms REAL");
    });
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
  const required = [
    "findings_content_immutable",
    "findings_no_delete",
    "events_no_delete",
    // REPLACE korumaları da bu listede: eksiklikleri, DELETE korumaları yerinde
    // olduğu hâlde dışarıdan yerinde yeniden yazmayı mümkün kılıyor (schema.sql).
    "findings_no_replace",
    "events_no_replace",
    // Verdict guards are in the SAME list, not a softer one: a verdict carries
    // the correction text the user is about to approve into a memory file, so an
    // in-place rewrite of one is worse than an in-place rewrite of a finding.
    "verdicts_measurement_immutable",
    "verdicts_no_delete",
    "verdicts_no_replace",
  ];
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

/**
 * Yazma kilidi için bekleme bütçesi. Denetimde ölçüldü
 * (probes/startup-does-not-wait-for-writer.sh): busy timeout olmadan, 300 ms
 * süren başka bir yazıcı varken `status` bile `database is locked` ile ANINDA
 * düşüyordu — oysa kilit çok kısa sürede bırakılıyor.
 *
 * 5 sn seçildi çünkü bizim tuttuğumuz yazma işlemleri (şema, göç, bir tarama
 * turunun tx'i) milisaniyeler mertebesinde; 5 sn bunların iki üç katı pay
 * bırakıyor ama gerçekten asılmış bir yazıcıda komutu süresiz bekletmiyor.
 * Sonsuz bekleme bilerek seçilmedi: kilit sahibi çökmüşse kullanıcı hatayı
 * görmeli, sessizce asılmamalı.
 */
const BUSY_TIMEOUT_MS = 5_000;

/** SQLITE_BUSY. Yalnız bu kod yeniden denemeyi hak ediyor; gerisi gerçek hata. */
const SQLITE_BUSY = 5;

/** WAL yeniden deneme adımı: kilit ortalama milisaniyeler sürüyor, sık yoklamak ucuz. */
const WAL_RETRY_MS = 25;

/** Aynı gevşek dizin için süreç başına tek uyarı; tekrar gürültü olur. */
const warnedDirs = new Set<string>();

/**
 * Depo dizinini hazırlar. İzin sıkılaştırması YALNIZ bizim yarattığımız dizine
 * uygulanır.
 *
 * Denetim bulgusu (probes/store-parent-chmod.sh): koşulsuz
 * `chmodSync(dirname(path), 0o700)` var olan ve bize ait olmayan bir dizini de
 * 0700'e çekiyordu — `--store store.db` yazan biri çalışma dizininin izinlerini
 * değiştiriyordu ve her komut (status dahil) bu yoldan geçiyor. Bir aracın
 * kendi deposunu korumaya hakkı var, kullanıcının dizinini yeniden yapılandırmaya yok.
 */
function prepareStoreDir(path: string): void {
  const dir = dirname(path);
  // recursive mkdir, yarattığı EN ÜST dizini döndürür; hiçbir şey yaratmadıysa
  // undefined — "bu dizin bizim mi" sorusunun ek bir stat gerektirmeyen cevabı.
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined) {
    // Depo transcript'lerden türetilmiş içerik barındırıyor; çok kullanıcılı bir
    // makinede varsayılan umask (022) bunu 0755 bırakabiliyordu (denetim bulgusu).
    // mkdir modu umask ile kırpıldığı için yaratılan dizinde chmod şart.
    chmodSync(dir, 0o700);
    return;
  }
  // Var olan dizin: değiştirmiyoruz ama sessiz de kalmıyoruz — kullanıcı
  // deponun başkalarınca okunabilir bir yerde durduğunu bilmeli. Deponun kendi
  // dosyaları yine 0600.
  if (warnedDirs.has(dir)) return;
  const mode = statSync(dir).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    warnedDirs.add(dir);
    console.warn(
      `uyarı: depo dizini ${dir} başkalarına açık (mod ${mode.toString(8)}); ` +
        "izinleri değiştirilmedi — depo dosyaları yine de 0600.",
    );
  }
}

/** Bağımlılıksız senkron uyku. Açılış yolu senkron; zamanlayıcı kullanamıyoruz. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * WAL'a geçiş. AYRI ele alınıyor çünkü `PRAGMA journal_mode` busy_timeout'u
 * DİNLEMİYOR: ölçüldü — başka bir bağlantı yazma kilidi tutarken journal_mode
 * değişimi 0 ms'de SQLITE_BUSY dönerken, aynı anda bir CREATE TABLE 574 ms
 * bekleyip başarıyla tamamlanıyor. Bekleme bu yüzden elle yapılıyor.
 *
 * Başarısızlık ÖLÜMCÜL DEĞİL: WAL bir eşzamanlılık tercihi, veri sözleşmesi
 * değil — rollback journal ile de doğru çalışıyoruz ve sonraki açılış modu
 * yine yükseltmeyi dener. Depoyu bu yüzden açamamak, düzeltmeye çalıştığımız
 * "eşzamanlı yazıcı varken komut düşüyor" arızasının aynısı olurdu.
 */
function enableWal(db: DatabaseSync): boolean {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return true;
    } catch (err) {
      const busy = (err as { errcode?: number }).errcode === SQLITE_BUSY;
      if (!busy || Date.now() >= deadline) return false;
      sleepSync(WAL_RETRY_MS);
    }
  }
}

/**
 * `PRAGMA recursive_triggers` gerçekten açık mı? Pragma BAĞLANTI-YEREL olduğu
 * için schema.sql'deki satır yalnız BU bağlantıyı bağlıyor; sessizce varsaymak
 * append-only sözleşmesinin dayandığı zemini ölçülmemiş bırakırdı (denetim
 * bulgusu: external-replace-bypasses-append-only). Kapalıysa açmayı dener,
 * yine kapalıysa depoyu açmayı reddeder — koruması olmayan bir depoya yazmak,
 * korunduğunu sanarak yazmaktan iyidir.
 */
function assertRecursiveTriggers(db: DatabaseSync): void {
  const read = () => Number((db.prepare("PRAGMA recursive_triggers").get() as { recursive_triggers: number } | undefined)?.recursive_triggers);
  if (read() === 1) return;
  db.exec("PRAGMA recursive_triggers = ON");
  if (read() !== 1) {
    throw new Error("PRAGMA recursive_triggers açılamadı: append-only koruması bu bağlantıda garanti edilemez");
  }
}

export function openStore(path: string): Store {
  if (path !== ":memory:") prepareStoreDir(path);
  const db = new DatabaseSync(path);
  // İLK ifade: bundan sonraki her şey (şema, göç, kurtarma) yazma kilidi
  // isteyebilir ve eşzamanlı bir yazıcıya takılabilir. Pragma'nın kendisi kilit
  // almaz, dolayısıyla burada güvenle koşar. Yapıcının `timeout` seçeneği yerine
  // pragma: ölçülen sürümde (node 24.10) ikisi de çalışıyor, pragma sürümden
  // bağımsız.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  // KUŞAK KONTROLÜ, DOSYAYI DEĞİŞTİREN HER ŞEYDEN ÖNCE. Sıra kritik ve ölçüldü
  // (doğrulama turu, `future-schema-mutated-before-rejection`): kontrol
  // `enableWal`den SONRA koşarken, reddedilen deponun KALICI `journal_mode`
  // ayarı DELETE→WAL oluyordu. Yani "daha yeni depoyu dosyaya dokunmadan
  // reddediyoruz" iddiası yanlıştı. Sonucu hafif — ama tanımadığımız bir şemaya
  // dokunmama sözü, hafif dokunuşlar için de geçerli olmak zorunda; yanlış
  // gerekçe, gerekçesizlikten kötüdür.
  //
  // `busy_timeout` ve `PRAGMA user_version` okuması bu kuralın DIŞINDA değil:
  // ikisi de bağlantı-yerel/salt-okuma, dosyaya tek bayt yazmıyorlar.
  const generation = readGeneration(db);
  if (generation > SCHEMA_GENERATION) {
    db.close();
    throw new StoreGenerationTooNew(path, generation);
  }

  if (!enableWal(db)) {
    // Sessiz düşüş yok: WAL'sız çalışmak doğru ama daha az eşzamanlı.
    console.warn(`uyarı: ${path} WAL kipine alınamadı (başka bir yazıcı bağlı); rollback journal ile devam ediliyor.`);
  }

  // Şemadan ÖNCE: yarıda kesilmiş bir göçün ara tablosu ortadaysa schema.sql
  // hedefi boş yeniden yaratıp veriyi yetim bırakıyor (gerekçe: fonksiyonun
  // kendi yorumunda).
  recoverInterruptedMigrations(db);

  const schema = readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
  db.exec(schema);

  migrate(db);
  // Damga göçten SONRA: kuşak damgası "bu dosya şu şemaya taşındı" demek, "şu
  // sürüm dosyaya baktı" değil. Göç yarıda patlarsa damga da yazılmaz ve
  // sonraki açılış göçü baştan dener.
  // Değer bağlanamıyor (PRAGMA parametre almaz); enterpole edilen şey bizim
  // sabitimiz, dışarıdan gelen bir veri değil.
  if (generation !== SCHEMA_GENERATION) db.exec(`PRAGMA user_version = ${SCHEMA_GENERATION}`);
  ensureGuards(db, schema);
  assertRecursiveTriggers(db);

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
