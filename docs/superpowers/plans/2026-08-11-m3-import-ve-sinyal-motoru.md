# M3 — Import + Sinyal Motoru Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `memory/*.md` notlarını depoya eşlemek ve çürümeyi LLM'siz sinyallerle (çapa kayması, DURUM-kalıbı, çelişki adaylığı) yakalayıp altın set üzerinde ilk başarı skalerini ölçmek.

**Architecture:** `importer/` hafıza dosyalarını `findings` tablosuna `imported` kaynaklı kayıtlar olarak eşler (dosya değişti → eski temsil superseded + yeni kayıt). `signals/` katmanı her aktif bulgunun çapalarını git'e karşı doğrular (çalışma ağacı **ve** origin — M0-D7), DURUM-kalıbını arar, çelişki adaylarını mekanik üretir; adaylar TEK toplu Codex çağrısıyla sınıflanır. `audit.ts` bunları orkestre eder, şüphe skorunu **sıfırdan** hesaplar ve `active↔suspect` geçişini yapar. Hiçbir hafıza dosyasına yazım yok (K9) — çıktı yalnız depo + olay günlüğü. Çıkış kapısı: GaMachine altın seti (17 çürük + 11 geçerli not, `b4065f1`/`19c623f` pin'li) üzerinde yakalama ve yanlış alarm oranı.

**Tech Stack:** Node 24 + TypeScript tip-soyma, `node:sqlite`, `node:test`, `node:child_process` (git + codex) — sıfır çalışma-zamanı bağımlılığı (K12). Codex yalnız çelişki sınıflamasında (koşum başına en fazla 2 çağrı).

## Global Constraints

- **K12:** Sıfır çalışma-zamanı bağımlılığı; yalnız devDependencies (`typescript`, `@types/node`).
- **K2:** Codex sert bağımlılık — `audit` komutu da detect kapısından geçer; yoksa kurulum yönlendirmesi, rc=2.
- **K9:** `audit` **hiçbir** `memory/*.md` dosyasına yazmaz; disk yazımı yalnız depo (`~/.context-police/`). Onay akışı M5'in işi.
- **Spec §3.2:** `findings.content` UPDATE edilmez; düzeltme = yeni kayıt + `superseded_by` (şema tetikleyicisi zorluyor). Silme yok.
- **CLAUDE.md §7 (üç denetimde üç kez ölçülen sınıf):** şema değişen her görevde `migrate()` aynı commit'te yazılır ve **var olan bir depo dosyası** üzerinde test edilir — taze depoda çalışması kanıt değildir.
- **M0-D4:** çapa önceliği sembol > dosya yolu > satır no; satır numarası çapası **hiç çıkarılmaz**, skor üretmez.
- **M0-D5:** `unanchored` nötrdür — şüphe skoru almaz.
- **cyberPolicy dersi:** Codex brief'leri ÖLÇÜM görevi olarak yazılır ("bu iddialar çelişiyor mu?"); "kır/saldır" kipi kullanılmaz.
- **Dil:** kod ve identifier İngilizce, yorum/doküman/test adları Türkçe.
- **Git:** commit mesajlarında `Co-Authored-By` / "Generated with" / 🤖 YOK. Commit serbest, push yalnız Burak isteyince.
- **Doğrulama:** her görev sonunda `cd core && npm run typecheck && npm test` yeşil olmadan commit yok.
- **Temizlik birinci sınıf:** ölçümün açtığı worktree/geçici dizin, ölçüm raporu yazılmadan kapanmaz (Görev 11'in zorunlu adımı).

---

## M3 tasarım kararları

Her karar gerekçesiyle; gerekçesi çökerse karar yeniden tartışılır (sessizce değil).

| # | Karar | Gerekçe |
|---|---|---|
| D-M3-1 | **Import birimi = dosya; kimlik = mutlak yol; değişim tespiti = içerik eşitliği.** Hash sütunu YOK. `MEMORY.md` içe alınmaz | `content` zaten tam metin olarak depoda; string karşılaştırma aynı işi görür, yeni sütun ise bir göç demek (§7 sınıfı — bedava değil). `MEMORY.md` not değil indeks; indeks↔gövde çelişki yüzeyi (M0-D3c) frontmatter `description` ile temsil ediliyor. MEMORY.md satırlarının ayrıca denetimi **sınanmadı**, v1 sonrası |
| D-M3-2 | **Çapa çıkarımı mekanik ve aşırı-üretime toleranslı:** SHA (7-40 hex), yol (slash + uzantı; `~/` veya `/` ile başlayan → `external_path`), backtick'li identifier → `symbol`. Not başına tavan 16, taşan sayı olaya yazılır | LLM'siz katman ucuz kalmalı. Yanlış çıkarılan çapa zarar vermez çünkü skor yalnız **kanıtlı** durumlarda üretilir: geçmişte hiç var olmamış sembol/yol `unverifiable` sayılır (skor 0) — "hiç izi yok" aşırı-üretimle ayırt edilemez, suçlamaya yetmez. Geçmişte VAR OLUP şimdi kaybolan ise en güçlü sinyaldir |
| D-M3-3 | **Skor her denetimde SIFIRDAN hesaplanır** (idempotent); `suspicion` birikimli toplam değil, o anki sinyallerin toplamı | `+=` birikimi çift koşumda skoru şişirir ve denetim tekrar-koşulamaz hâle gelir. "Birikim" spec'te sinyallerin toplamı olarak yorumlanıyor; olay günlüğü zaten tarihçeyi taşıyor |
| D-M3-4 | **Ağırlıklar (M0 kalibrasyonu):** `missing_now` 0.5 · `symbol_lost` 0.4 · `never_existed` 0.3 · churn ≥3 commit 0.2, ≥10 commit 0.3 · DURUM-kalıbı tek başına 0.2, **+ herhangi çapa hareketi → toplam en az 0.7** · çelişki onayı → iki taraf da en az 0.7 · eşik 0.6, cap 1.0 | M0-D1: DURUM + hareket bileşimi tek başına eşiği aşmalı (17 çürüğün 9'u bu sınıf). Satır no yok (M0-D4). Yaş ayrı sinyal değil — churn sayısı zaten zamanı içeriyor (spec: yaş tek başına asla). `never_existed` orta: fabrikasyon adayı ama kesin hüküm hakemin (M4) |
| D-M3-5 | **İki ref birlikte:** çalışma ağacı (HEAD) + `origin/<default>`; `git fetch` best-effort (zaman aşımlı, `--no-fetch` ile kapalı). Uyuşmazlıkta iki hüküm de verdict'e yazılır, skor **kötüsünden** hesaplanır | M0-D7: bozan commit'lerin önemli kısmı yalnız origin'deydi. Fetch başarısızlığı (offline) denetimi durdurmaz — eldeki origin ref kullanılır, olaya yazılır |
| D-M3-6 | **Çelişki adaylığı mekanik, üç yüzey (M0-D3):** (a) çapa değeri kesişen bulgu çiftleri (4'ten çok notta geçen çapa ayırt edici değil, çift üretmez); (b) not içi: DURUM-kalıbı taşıyan notlar; (c) frontmatter `description` ↔ gövde. Adaylar **tek** Codex çağrısında toplu sınıflanır; tavan 20 aday/koşum, taşan sayı olaya yazılır | Ön eleme LLM'siz (spec §3.4). Tek toplu çağrı + bir düzeltme turu = koşum başına en fazla 2 Codex çağrısı — `observe`'un maliyet kapısına gerek kalmayacak kadar sınırlı, bilinçli tasarım. Gözlemlenen bulgular da adaylığa katılır (spec §4 kapsam notu) |
| D-M3-7 | **Git yoksa** anchor sinyali kapalı, yalnız çelişki koşar; olay + çıktıda açık uyarı. `external_path` ve doğrulanamayan `commit_sha` çapaları `unverifiable`, skor 0 | Spec §3.7. Repo-dışı çapa denetimi (M0-D6) v1 sonrası — şema izin veriyor, sinyal kapsamıyor |
| D-M3-8 | **Altın set ölçümü pin'li ve repo-dışı:** GaMachine worktree `b4065f1` (geçici; ölçüm sonunda `git worktree remove`), origin `--origin-ref 19c623f` ile sabit, hafıza silosunun snapshot'ı `~/.context-police/golden/` altına (repoya kişisel içerik girmez, rapor sayıları girer) | Altın set kaymasın (M0 raporu §4). Silo canlı — M0 fotoğrafından sapmış notlar rapora şerh düşülür |
| D-M3-9 | **`active↔suspect` geçişi sinyal motorunun tekelinde:** skor ≥0.6 → `suspect`; yeniden hesap <0.6 → `active`. `superseded`/`born_invalid`/`unanchored`'a sinyal katmanı DOKUNMAZ | `born_invalid` hakem hükmü (M4); `unanchored` nötr (M0-D5). Geri dönüş otomatik — sinyal kaynaklı `suspect` işareti onay gerektirmez çünkü hiçbir dosyaya inmiyor (K9) |
| D-M3-10 | **M2 borçları bu milestone'da kapanır:** (1) uydurma çapa → Görev 7'nin `never_existed`/`unverifiable` ayrımı + Görev 11 ölçümü; (2) `--session` tazeliği → Görev 1; (3) kısmi örtüşme sıklığı → Görev 2 olayı + Görev 11'de sayım; (4) bütçe durdurma gürültüsü → Görev 2 | m2-durum kaydı: "M3 planı bu borcu kapatmalı, yoksa sessiz açık kalem olur" |

---

## Dosya yapısı

```
core/src/
  importer/
    parse.ts            # YENİ — not ayrıştırma (frontmatter/gövde) + mekanik çapa çıkarımı (saf)
    import.ts           # YENİ — memory/*.md ↔ depo eşleme (değişen dosya → supersede + yeni kayıt)
  signals/
    git.ts              # YENİ — salt-okunur git yardımcısı (varlık, geçmiş, churn, sembol, fetch)
    status-pattern.ts   # YENİ — DURUM-kalıbı dedektörü (saf regex, M0-D1)
    anchor-drift.ts     # YENİ — çapa verdict'leri + saf skor fonksiyonu (M2 borç 1 burada kapanır)
    contradiction.ts    # YENİ — mekanik aday üretimi, üç yüzey (saf)
    classify.ts         # YENİ — Codex sınıflama: prompt + çıktı şeması + ayrıştırma
  audit.ts              # YENİ — orkestrasyon: import → sinyaller → skor/status → olaylar
  cli.ts                # DEĞİŞİR — audit komutu; --session tazelik kablosu
  observe-cmd.ts        # DEĞİŞİR — readSessionIncremental/recordSessionFreshness (Görev 1)
  scan.ts               # DEĞİŞİR — BudgetHalt erken durdurma (Görev 2)
  observer/batch.ts     # DEĞİŞİR — "overlap-resent" eşleşme türü (Görev 2)
  observer/observer.ts  # DEĞİŞİR — kısmi örtüşme olayı (Görev 2)
  store/
    schema.sql          # DEĞİŞİR — observer_watermarks inode/mtime_ms (Görev 1)
    db.ts               # DEĞİŞİR — göç (Görev 1)
    watermarks.ts       # DEĞİŞİR — inode/mtime oku/yaz (Görev 1)
    events.ts           # DEĞİŞİR — yeni olay türleri
    findings.ts         # DEĞİŞİR — markSuspect/clearSuspect + listActiveWithAnchors
core/test/
  watermark-freshness.test.ts   # YENİ (Görev 1)
  budget-halt-scan.test.ts      # YENİ (Görev 2)
  importer-parse.test.ts        # YENİ (Görev 3)
  importer.test.ts              # YENİ (Görev 4)
  git-signals.test.ts           # YENİ (Görev 5 — gerçek geçici git reposuyla)
  status-pattern.test.ts        # YENİ (Görev 6)
  anchor-drift.test.ts          # YENİ (Görev 7)
  contradiction.test.ts         # YENİ (Görev 8)
  classify.test.ts              # YENİ (Görev 9)
  audit.test.ts                 # YENİ (Görev 10 — fakeExecutor ile uçtan uca)
docs/olcumler/
  2026-08-XX-m3-altin-set-olcumu.md  # YENİ — çıkış kapısı (Görev 11)
```

---

### Görev 1: Filigran tazeliği — `--session` yerinde-yazım açığı (M2 borcu 2)

`cli.ts:307` bugün `readIncremental(sessionPath, from, null, null)` çağırıyor: filigran inode/mtime taşımadığı için aynı boyutta yerinde yeniden yazılan dosya görünmüyor ve ofset başka bir dosyanın baytlarını "işlenmiş" sayıyor. `readIncremental` tespit politikasını ZATEN içeriyor (`claude-code.ts:196-219`, `replacedInPlace` dalı) — eksik olan yalnız filigranın bu iki alanı taşıması ve `--session` yolunun onları geçirmesi.

**Files:**
- Modify: `core/src/store/schema.sql` (observer_watermarks)
- Modify: `core/src/store/db.ts` (migrateWatermarks)
- Modify: `core/src/store/watermarks.ts`
- Modify: `core/src/observe-cmd.ts` (iki yeni fonksiyon)
- Modify: `core/src/cli.ts` (observeSingleSession kablosu)
- Test: `core/test/watermark-freshness.test.ts`

**Interfaces:**
- Consumes: `readIncremental(path, from, inode, mtimeMs)` (claude-code.ts), `getWatermark`/`setWatermark` (watermarks.ts), `Observer.handleTurns` (observer.ts).
- Produces: `Watermark`/`WatermarkInput` alanları `inode: string | null`, `mtimeMs: number | null`; `readSessionIncremental(store, projectId, sessionId, sessionPath)` → `{ wm, res, range }`; `recordSessionFreshness(store, projectId, sessionId, res)`.

- [ ] **Adım 1: Kırmızı test — göç var olan depo üzerinde + tazelik alanları**

`core/test/watermark-freshness.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { getWatermark, setWatermark } from "../src/store/watermarks.ts";
import { readSessionIncremental, recordSessionFreshness } from "../src/observe-cmd.ts";
import { Observer } from "../src/observer/observer.ts";
import { fakeExecutor } from "./helpers.ts";

// §7 kuralı: göç VAR OLAN depo dosyası üzerinde doğrulanır — taze depo kanıt değil.
test("göç: M2-sonu (konumsal ama tazeliksiz) depo açılır, satır korunur, yeni alanlar yazılabilir", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-wm-"));
  const path = join(dir, "eski.db");

  // M2 sonundaki gerçek şema: byte_offset var, inode/mtime_ms yok.
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
      adapter_id TEXT NOT NULL, transcript_dir TEXT NOT NULL, memory_dir TEXT, last_scanned_at TEXT);
    CREATE TABLE observer_watermarks (
      project_id INTEGER NOT NULL, session_id TEXT NOT NULL,
      byte_offset INTEGER, delivery_key TEXT, delivery_turns INTEGER,
      last_uuid TEXT, last_ts TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id));
    INSERT INTO projects (id, path, adapter_id, transcript_dir) VALUES (1, '/p', 'claude-code', '/t');
    INSERT INTO observer_watermarks VALUES (1, 's1', 4200, 'b:0:4200:7', 7, 'u-7', '2026-08-11T00:00:00Z', '2026-08-11T00:00:01Z');
  `);
  old.close();

  const store = openStore(path);
  const wm = getWatermark(store, 1, "s1");
  assert.equal(wm?.byteOffset, 4200);          // veri korunmuş
  assert.equal(wm?.inode, null);               // yeni alan var ve boş
  setWatermark(store, { projectId: 1, sessionId: "s1", inode: "12345", mtimeMs: 111.5 });
  const wm2 = getWatermark(store, 1, "s1");
  assert.equal(wm2?.inode, "12345");
  assert.equal(wm2?.mtimeMs, 111.5);
  assert.equal(wm2?.byteOffset, 4200);         // kısmi yazım ofseti silmedi
  store.close();
});

// Gerçek akış reprosu (m2-denetim-dersleri §3): aynı boyutta yerinde yeniden
// yazım. Düzeltme geri alınırsa (null, null geçilirse) bu test KIRMIZI kalır.
test("--session yolu: aynı boyutta yerinde yeniden yazılan dosya yeniden gözlemlenir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-sess-"));
  const sessionPath = join(dir, "abc.jsonl");
  const line = (uuid: string, text: string) =>
    JSON.stringify({ type: "user", uuid, timestamp: "2026-08-11T10:00:00Z",
      message: { role: "user", content: [{ type: "text", text }] }, cwd: "/p" }) + "\n";
  // İKİ sürüm aynı bayt uzunluğunda: yalnız metin harfleri değişiyor.
  writeFileSync(sessionPath, line("u1", "AAAA") + line("u2", "BBBB"));

  const store = openStore(join(dir, "store.db"));
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES ('/p','claude-code',?)", dir,
  ).lastInsertRowid);
  const observer = new Observer({ store, executor: fakeExecutor([
    { output: '{"findings":[]}' }, { output: '{"findings":[]}' },
  ]) });

  // 1. koşum: her şey taze; sonunda tazelik kaydı düşer.
  const r1 = await readSessionIncremental(store, projectId, "abc", sessionPath);
  await observer.handleTurns({ projectId, sessionId: "abc", turns: r1.res.turns, range: r1.range });
  recordSessionFreshness(store, projectId, "abc", r1.res);
  assert.equal(getWatermark(store, projectId, "abc")?.inode, r1.res.inode);

  // Yerinde yeniden yazım: aynı uzunluk, farklı içerik → mtime değişir, boyut değişmez.
  await new Promise((r) => setTimeout(r, 20)); // mtime çözünürlüğü
  await writeFile(sessionPath, line("u1", "CCCC") + line("u2", "DDDD"));

  const r2 = await readSessionIncremental(store, projectId, "abc", sessionPath);
  assert.equal(r2.res.truncated, true);        // yeniden yazım GÖRÜLDÜ
  assert.equal(r2.range.truncated, true);
  assert.equal(r2.res.turns.length, 2);        // dosyanın tamamı yeniden okundu
  store.close();
});
```

- [ ] **Adım 2: Kırmızıyı doğrula**

Run: `cd core && node --test --disable-warning=ExperimentalWarning --experimental-strip-types test/watermark-freshness.test.ts`
Expected: FAIL — `readSessionIncremental` export edilmemiş; `inode` alanı yok.

- [ ] **Adım 3: Şema + göç**

`schema.sql` observer_watermarks tablosuna (`updated_at`'ten önce):

```sql
  -- --session yolu için tazelik: readIncremental'ın yerinde-yazım tespiti
  -- (claude-code.ts replacedInPlace) bu ikisi olmadan çalışamıyor — M2'de null
  -- geçiliyordu ve aynı boyutta yeniden yazılan dosya görünmüyordu (M3 borç 2).
  inode          TEXT,
  mtime_ms       REAL,
```

`db.ts` `migrateWatermarks` — konumsal kuşağa iki sütun ekleyen dal + eski kuşak rebuild'inin güncel şemaya çıkması:

```ts
function migrateWatermarks(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(observer_watermarks)").all() as { name: string }[];
  if (cols.length === 0) return; // yeni depo: şema zaten güncel

  if (!cols.some((c) => c.name === "byte_offset")) {
    // İçerik-kimlikli eski kuşak: yeniden kurulur ve DOĞRUDAN güncel şemaya
    // çıkar (inode/mtime_ms dahil) — iki aşamalı göç, iki kesilme noktası demek.
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
    // Sütun EKLEME ALTER ile güvenli (kaldırılan CHECK yok — filigran rebuild'inin
    // aksine). İki ifade tek işlemde: yarıda kesilirse yarım şema kalmasın
    // (2. doğrulama turunun atomiklik dersi).
    inTransaction(db, () => {
      db.exec("ALTER TABLE observer_watermarks ADD COLUMN inode TEXT");
      db.exec("ALTER TABLE observer_watermarks ADD COLUMN mtime_ms REAL");
    });
  }
}
```

- [ ] **Adım 4: watermarks.ts alanları**

`Watermark`'a `inode: string | null; mtimeMs: number | null`; `WatermarkInput`'a `inode?: string | null; mtimeMs?: number | null`. `getWatermark` SELECT'ine `inode, mtime_ms` eklenir ve döndürülür. `setWatermark`:
- `hasValue` listesine `wm.inode, wm.mtimeMs` eklenir.
- Birleştirme `lastUuid` kalıbıyla aynı: `const inode = wm.inode === undefined ? stored?.inode ?? null : wm.inode;` (mtimeMs aynı). INSERT/UPDATE sütun listelerine eklenir.
- `resetWatermarkOffset` bu iki alana DOKUNMAZ — tazelik, konum değil; sonraki okumada zaten yeniden yazılıyor.

- [ ] **Adım 5: observe-cmd.ts yeni fonksiyonlar + cli.ts kablosu**

`observe-cmd.ts` sonuna (import'lara `getWatermark, setWatermark`, `readIncremental` tipi `IncrementalRead`, `DeliveryRange` eklenir):

```ts
/**
 * --session okuma kararının test edilebilir hâli (M2 borcu 2). Filigranın
 * inode/mtime'ı readIncremental'a GEÇİRİLİR: yerinde-yazım tespiti oradadır,
 * null geçmek onu kapatıyordu.
 */
export async function readSessionIncremental(
  store: Store, projectId: number, sessionId: string, sessionPath: string,
): Promise<{ wm: Watermark | null; res: IncrementalRead; range: DeliveryRange }> {
  const wm = getWatermark(store, projectId, sessionId);
  const from = wm?.byteOffset ?? 0;
  const res = await readIncremental(sessionPath, from, wm?.inode ?? null, wm?.mtimeMs ?? null);
  return { wm, res, range: { from: res.truncated ? 0 : from, to: res.byteOffset, truncated: res.truncated } };
}

/** Okunan dosyanın tazeliğini filigrana işler; karar alanlarına dokunmaz. */
export function recordSessionFreshness(
  store: Store, projectId: number, sessionId: string, res: { inode: string; mtimeMs: number },
): void {
  setWatermark(store, { projectId, sessionId, inode: res.inode, mtimeMs: res.mtimeMs });
}
```

`cli.ts` `observeSingleSession` içindeki `getWatermark`/`readIncremental`/`range` üçlüsü bu çağrıyla değiştirilir; `observer.handleTurns(...)` başarıyla döndükten sonra `recordSessionFreshness(store, projectId, sessionId, res)` çağrılır.

- [ ] **Adım 6: Yeşili doğrula** — `cd core && npm run typecheck && npm test` → tümü PASS.
- [ ] **Adım 7: Commit** — `git add -A && git commit -m "M3: filigran tazeliği — --session yerinde-yazım açığı kapandı"`

---

### Görev 2: Bütçe durdurması erken-durdurma + kısmi örtüşme ölçümü (M2 borçları 3-4)

Bugün bütçe dolunca kalan HER oturum `observer_failed` olayı üretiyor (gürültü) ve kısmi örtüşmede tam-parti tekrarının sıklığı ölçülemiyor.

**Files:**
- Modify: `core/src/observer/batch.ts` (DeliveryMatch + tespit)
- Modify: `core/src/observer/observer.ts` (olay)
- Modify: `core/src/scan.ts` (erken durdurma)
- Modify: `core/src/store/events.ts` (iki tür)
- Test: `core/test/budget-halt-scan.test.ts`

**Interfaces:**
- Consumes: `BudgetHalt` (observe-cmd.ts), `ObserverError` (scan.ts), `dropThroughWatermarkDetailed` (batch.ts).
- Produces: `DeliveryMatch` birliğine `"overlap-resent"`; `ScanSummary.budgetHalted: boolean`; olay türleri `observer_partial_overlap`, `observer_budget_halt`.

- [ ] **Adım 1: Kırmızı test**

`core/test/budget-halt-scan.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropThroughWatermarkDetailed } from "../src/observer/batch.ts";
import { scanOnce } from "../src/scan.ts";
import { BudgetHalt } from "../src/observe-cmd.ts";
import { countEvents } from "../src/store/events.ts";
import { openStore } from "../src/store/db.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const turn = (uuid: string) => ({ role: "user" as const, text: "x", uuid, timestamp: "2026-08-11T10:00:00Z" });

test("kısmi örtüşme ayrı eşleşme türü olarak raporlanır (borç 3 ölçümü)", () => {
  // Saklanan ofset aralığın İÇİNDE, kimlik tutmuyor → tamamı yeniden gönderilir
  // ama artık görünür bir 'overlap-resent' olarak.
  const wm = { byteOffset: 500, deliveryKey: "b:0:500:5", deliveryTurns: 5 };
  const d = dropThroughWatermarkDetailed([turn("a"), turn("b")], wm, { from: 200, to: 900, truncated: false });
  assert.equal(d.match, "overlap-resent");
  assert.equal(d.fresh.length, 2); // tekrar tercih ediliyor — davranış değişmedi, yalnız görünürlük eklendi
});

test("BudgetHalt taramayı erken durdurur: tek olay, sıfır observer_failed, imleç ilerlemez", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-halt-"));
  const projDir = join(root, "-p1");
  mkdirSync(projDir);
  const line = (uuid: string) =>
    JSON.stringify({ type: "user", uuid, timestamp: "2026-08-11T10:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "merhaba" }] }, cwd: "/p1" }) + "\n";
  writeFileSync(join(projDir, "s1.jsonl"), line("u1"));
  writeFileSync(join(projDir, "s2.jsonl"), line("u2"));

  const store = openStore(":memory:");
  const sum = await scanOnce(store, {
    adapter: claudeCodeAdapter,
    root,
    onTurns: () => { throw new BudgetHalt(); }, // bütçe ilk teslimatta dolu
  });

  assert.equal(sum.budgetHalted, true);
  assert.equal(countEvents(store, "observer_budget_halt"), 1);   // tek kayıt, oturum başına değil
  assert.equal(countEvents(store, "observer_failed"), 0);        // gürültü yok
  assert.equal(sum.sessionErrors, 0);                            // bütçe bir HATA değil
  const cursors = store.get<{ n: number }>("SELECT COUNT(*) n FROM cursors")?.n ?? 0;
  assert.equal(cursors, 0);                                      // hiçbir imleç ilerlemedi
  store.close();
});
```

- [ ] **Adım 2: Kırmızıyı doğrula** — Run: `node --test ... test/budget-halt-scan.test.ts` → FAIL (`match` "fresh" dönüyor; `budgetHalted` alanı yok).

- [ ] **Adım 3: Uygulama**

`batch.ts` — `DeliveryMatch` birliğine ekle: `| "overlap-resent"` (yorum: *saklanan ofset aralığın içinde, kimlik tutmuyor: turn'lerin tek tek ofsetleri elimizde yok, tamamı yeniden işlenir — kayıp yerine tekrar. Ayrı tür, çünkü sıklığı M2'de ölçülemedi (borç 3) ve olaya çevrilebilmesi için görünür olmalı*). `dropThroughWatermarkDetailed` son `return`'den önce:

```ts
  if (r !== null && offset !== null && offset > r.from && offset < r.to)
    return { fresh: turns, match: "overlap-resent", key, dropped: 0 };
```

`observer.ts` `handleTurns` — `decision` alındıktan sonra:

```ts
    if (decision.match === "overlap-resent") {
      logEvent(this.store, {
        projectId: ctx.projectId,
        kind: "observer_partial_overlap",
        detail: {
          sessionId: ctx.sessionId, from: range!.from, to: range!.to,
          watermarkOffset: wm?.byteOffset ?? null, turnCount: ctx.turns.length,
        },
      });
    }
```

`events.ts` `EventKind`'a: `"observer_partial_overlap"` (kısmi örtüşme: teslimatın tamamı yeniden Codex'e gitti — sıklık ölçümü, borç 3) ve `"observer_budget_halt"` (bütçe taramayı erken durdurdu; kalan oturumlar İŞLENMEDİ, imleçleri ilerlemedi).

`scan.ts` — `ScanSummary`'ye `budgetHalted: boolean` (başlangıç `false`); import: `import { BudgetHalt } from "./observe-cmd.ts";`. Oturum döngüsündeki catch'in başına:

```ts
        // Bütçe bitişi hata değil erken durdurma: oturum başına observer_failed
        // üretmek yerine TEK olay yazılır ve tarama durur — kalan oturumların
        // imleçleri ilerlemediği için veri kaybı yok (en-az-bir-kez).
        if (err instanceof ObserverError && err.reason instanceof BudgetHalt) {
          sum.budgetHalted = true;
          logEvent(store, {
            projectId,
            kind: "observer_budget_halt",
            detail: { sessionId: session.sessionId },
          });
          break;
        }
```

ve proje döngüsünde iç döngüden sonra: `if (sum.budgetHalted) break;` (`markScanned` bu dalda ÇAĞRILMAZ — proje yarım tarandı).

- [ ] **Adım 4: Yeşili doğrula** — `npm run typecheck && npm test` (mevcut scan/observer testleri de yeşil kalmalı).
- [ ] **Adım 5: Commit** — `git commit -m "M3: bütçe durdurması tek olaya indi, kısmi örtüşme ölçülür oldu"`

---

### Görev 3: Not ayrıştırma + mekanik çapa çıkarımı

**Files:**
- Create: `core/src/importer/parse.ts`
- Test: `core/test/importer-parse.test.ts`

**Interfaces:**
- Consumes: `Anchor` (types.ts).
- Produces: `parseNote(raw): ParsedNote { frontmatter: Record<string,string>; body: string }`; `extractAnchors(text): { anchors: Anchor[]; dropped: number }`; `noteTimestamp(fm, fallbackIso): string`; `MAX_ANCHORS_PER_NOTE = 16`.

- [ ] **Adım 1: Kırmızı test**

`core/test/importer-parse.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, extractAnchors, noteTimestamp, MAX_ANCHORS_PER_NOTE } from "../src/importer/parse.ts";

test("parseNote: frontmatter düz alanları okur, gövdeyi ayırır; frontmatter'sız dosya tamamen gövde", () => {
  const raw = `---\nname: test-notu\ndescription: "kısa özet"\nmetadata:\n  type: project\n---\n\ngövde metni`;
  const p = parseNote(raw);
  assert.equal(p.frontmatter.name, "test-notu");
  assert.equal(p.frontmatter.description, "kısa özet");
  assert.equal(p.frontmatter.metadata, undefined); // iç içe alan bilerek atlanır
  assert.match(p.body, /^\s*gövde metni$/);
  assert.equal(parseNote("düz metin").body, "düz metin");
});

test("extractAnchors: sha / göreli yol / dış yol / backtick sembol ayrımı, mükerrersiz", () => {
  const text =
    "Düzeltme `fdfd4fe` commit'inde. `core/src/scan.ts` içindeki `scanOnce` fonksiyonu; " +
    "ayar ~/.gemini/settings.json dosyasında. Tekrar: core/src/scan.ts ve `scanOnce`.";
  const { anchors, dropped } = extractAnchors(text);
  const byKind = (k: string) => anchors.filter((a) => a.kind === k).map((a) => a.value);
  assert.deepEqual(byKind("commit_sha"), ["fdfd4fe"]);
  assert.deepEqual(byKind("file_path"), ["core/src/scan.ts"]);
  assert.deepEqual(byKind("external_path"), ["~/.gemini/settings.json"]);
  assert.deepEqual(byKind("symbol"), ["scanOnce"]);
  assert.equal(dropped, 0);
});

test("extractAnchors: tavan aşımı sessiz kırpılmaz, dropped sayılır", () => {
  const text = Array.from({ length: 30 }, (_, i) => `dosya src/mod${i}/dosya${i}.ts burada`).join(" ");
  const { anchors, dropped } = extractAnchors(text);
  assert.equal(anchors.length, MAX_ANCHORS_PER_NOTE);
  assert.equal(dropped, 30 - MAX_ANCHORS_PER_NOTE);
});

test("noteTimestamp: frontmatter modified > created > geri düşüş", () => {
  assert.equal(noteTimestamp({ modified: "2026-08-01T10:00:00.000Z" }, "2026-08-11T00:00:00Z"), "2026-08-01T10:00:00.000Z");
  assert.equal(noteTimestamp({}, "2026-08-11T00:00:00Z"), "2026-08-11T00:00:00Z");
  assert.equal(noteTimestamp({ modified: "bozuk-tarih" }, "F"), "F"); // ayrıştırılamayan → geri düşüş
});
```

- [ ] **Adım 2: Kırmızıyı doğrula** — FAIL: modül yok.

- [ ] **Adım 3: Uygulama**

`core/src/importer/parse.ts`:

```ts
// Not ayrıştırma + mekanik çapa çıkarımı. Saf: I/O yok, depo yok, LLM yok.
// Aşırı-üretim bilinçli tolere edilir (D-M3-2): yanlış çıkan çapa skor üretmez,
// çünkü anchor-drift yalnız "geçmişte VAR OLUP kaybolmuş" durumu suçlar.

import type { Anchor } from "../types.ts";

export interface ParsedNote {
  /** Yalnız düz (girintisiz) string alanlar — description bunların içinde. */
  frontmatter: Record<string, string>;
  body: string;
}

export function parseNote(raw: string): ParsedNote {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    // Girintili satırlar (iç içe yaml) atlanır: tam yaml ayrıştırıcı bağımlılık
    // demek (K12) ve tek ihtiyacımız düz description/modified alanları.
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2] !== "") fm[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { frontmatter: fm, body: raw.slice(m[0].length) };
}

/** Frontmatter'daki not tarihini seçer; churn penceresi buradan başlar (Görev 7). */
export function noteTimestamp(fm: Record<string, string>, fallbackIso: string): string {
  for (const key of ["modified", "created", "date"]) {
    const v = fm[key];
    if (v !== undefined && !Number.isNaN(Date.parse(v))) return v;
  }
  return fallbackIso;
}

export const MAX_ANCHORS_PER_NOTE = 16;

// Satır numarası deseni BİLEREK yok (M0-D4): kırılgan ve içerik göstergesi değil.
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const PATH_RE = /(?:~\/|\/)?[\w.-]+(?:\/[\w.-]+)+\.\w{1,8}\b/g;
const SYMBOL_RE = /`([A-Za-z_$][A-Za-z0-9_$]{3,})(?:\(\))?`/g;

export function extractAnchors(text: string): { anchors: Anchor[]; dropped: number } {
  const seen = new Set<string>();
  const all: Anchor[] = [];
  const push = (kind: Anchor["kind"], value: string) => {
    const key = `${kind}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push({ kind, value });
  };

  for (const m of text.matchAll(PATH_RE)) {
    const v = m[0];
    push(v.startsWith("~/") || v.startsWith("/") ? "external_path" : "file_path", v);
  }
  const pathText = text.replace(PATH_RE, " "); // yolun içindeki hex parçası sha sanılmasın
  for (const m of pathText.matchAll(SHA_RE)) push("commit_sha", m[0]);
  for (const m of text.matchAll(SYMBOL_RE)) {
    const v = m[1]!;
    if (/^[0-9a-f]{7,40}$/.test(v)) continue; // backtick'li sha zaten commit_sha
    push("symbol", v);
  }

  // Tavan: sessiz kırpma yok — çağıran dropped'ı olaya yazar (Görev 4).
  return { anchors: all.slice(0, MAX_ANCHORS_PER_NOTE), dropped: Math.max(0, all.length - MAX_ANCHORS_PER_NOTE) };
}
```

- [ ] **Adım 4: Yeşili doğrula**, **Adım 5: Commit** — `git commit -m "M3: not ayrıştırma ve mekanik çapa çıkarımı"`

---

### Görev 4: Import eşleme — `memory/*.md` ↔ depo

**Files:**
- Create: `core/src/importer/import.ts`
- Modify: `core/src/store/events.ts` (üç tür)
- Test: `core/test/importer.test.ts`

**Interfaces:**
- Consumes: `parseNote/extractAnchors/noteTimestamp` (Görev 3), `appendFinding/supersede` (findings.ts), `logEvent`.
- Produces: `importMemoryDir(store, projectId, memoryDir): Promise<ImportSummary>` — `ImportSummary { files; added; unchanged; replaced; deleted; skipped; errors }`.

- [ ] **Adım 1: Kırmızı test**

`core/test/importer.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { importMemoryDir } from "../src/importer/import.ts";
import { listActive, getFinding, getAnchors } from "../src/store/findings.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cp-imp-"));
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES ('/p','claude-code','/t')",
  ).lastInsertRowid);
  return { dir, store, projectId };
}

test("ilk import: not eklenir, çapaları çıkar, MEMORY.md atlanır, tarih frontmatter'dan", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "MEMORY.md"), "- [x](a.md) — indeks");
  writeFileSync(join(dir, "a.md"),
    `---\nname: a\ndescription: d\nmodified: 2026-08-01T10:00:00.000Z\n---\n\`scanOnce\` core/src/scan.ts içinde`);
  const sum = await importMemoryDir(store, projectId, dir);
  assert.deepEqual({ ...sum }, { files: 1, added: 1, unchanged: 0, replaced: 0, deleted: 0, skipped: 1, errors: 0 });
  const [f] = listActive(store, projectId);
  assert.equal(f!.source, "imported");
  assert.equal(f!.createdAt, "2026-08-01T10:00:00.000Z");
  const kinds = getAnchors(store, f!.id).map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["file_path", "symbol"]);
});

test("değişmeyen dosya ikinci koşumda hiçbir kayıt üretmez (idempotent)", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "a.md"), "içerik");
  await importMemoryDir(store, projectId, dir);
  const sum2 = await importMemoryDir(store, projectId, dir);
  assert.equal(sum2.unchanged, 1);
  assert.equal(sum2.added + sum2.replaced, 0);
  assert.equal(listActive(store, projectId).length, 1);
});

test("değişen dosya: eski temsil superseded + yenisine bağlı; silinen dosya: temsil superseded", async () => {
  const { dir, store, projectId } = setup();
  writeFileSync(join(dir, "a.md"), "v1");
  writeFileSync(join(dir, "b.md"), "kalıcı");
  await importMemoryDir(store, projectId, dir);
  const oldId = listActive(store, projectId).find((f) => f.content === "v1")!.id;

  writeFileSync(join(dir, "a.md"), "v2");
  rmSync(join(dir, "b.md"));
  const sum = await importMemoryDir(store, projectId, dir);
  assert.equal(sum.replaced, 1);
  assert.equal(sum.deleted, 1);

  const old = getFinding(store, oldId)!;
  assert.equal(old.status, "superseded");
  const next = getFinding(store, old.supersededBy!)!;
  assert.equal(next.content, "v2");
  // silinen dosyanın temsili superseded ama superseded_by YOK (yerine geçen kayıt yok)
  const alive = listActive(store, projectId).map((f) => f.content).sort();
  assert.deepEqual(alive, ["v2"]);
});
```

- [ ] **Adım 2: Kırmızıyı doğrula** — FAIL: modül yok.

- [ ] **Adım 3: Uygulama**

`events.ts` `EventKind`'a: `"import_read_failed"`, `"import_file_deleted"`, `"import_anchor_overflow"` (üçü de sessiz yutma yasağının import yüzü — spec §3.7).

`core/src/importer/import.ts`:

```ts
// Import eşlemedir, senkron değil (spec §3.2): kaynak dosya her zaman gerçek,
// depo onun gölgesi + denetim üst-verisi. Değişen dosya = eski temsil superseded
// + yeni kayıt; dosya UPDATE edilmez (append-only tetikleyicisi zaten engeller).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "../store/db.ts";
import { nowIso } from "../store/db.ts";
import { appendFinding, supersede } from "../store/findings.ts";
import { logEvent } from "../store/events.ts";
import { parseNote, extractAnchors, noteTimestamp } from "./parse.ts";

export interface ImportSummary {
  files: number; added: number; unchanged: number; replaced: number;
  deleted: number; skipped: number; errors: number;
}

export async function importMemoryDir(
  store: Store, projectId: number, memoryDir: string,
): Promise<ImportSummary> {
  const sum: ImportSummary = { files: 0, added: 0, unchanged: 0, replaced: 0, deleted: 0, skipped: 0, errors: 0 };

  let names: string[];
  try {
    names = await readdir(memoryDir);
  } catch (err) {
    sum.errors++;
    logEvent(store, { projectId, kind: "import_read_failed", detail: { dir: memoryDir, error: String(err) } });
    return sum;
  }

  const currentRefs = new Set<string>();
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    if (name === "MEMORY.md") { sum.skipped++; continue; } // indeks, not değil (D-M3-1)
    sum.files++;
    const path = join(memoryDir, name);
    currentRefs.add(path);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      sum.errors++;
      logEvent(store, { projectId, kind: "import_read_failed", detail: { file: path, error: String(err) } });
      continue;
    }

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
      logEvent(store, { projectId, kind: "finding_superseded",
        detail: { oldId: existing.id, newId, reason: "memory_file_changed", file: name } });
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
```

- [ ] **Adım 4: Yeşili doğrula**, **Adım 5: Commit** — `git commit -m "M3: memory import eşlemesi — değişim supersede, silme görünür"`

---

### Görev 5: Git yardımcısı

**Files:**
- Create: `core/src/signals/git.ts`
- Test: `core/test/git-signals.test.ts` (gerçek geçici git reposu kurar — sahte yok; ders 3: sentezde yeşil, gerçekte kırmızı olabiliyor)

**Interfaces:**
- Consumes: `node:child_process` yalnız burada (git için).
- Produces: `openGit(dir, {fetch?, originRef?}): Promise<GitContext | null>` — `GitContext { repoRoot; head; originRef: string | null }`; `fileExistsAt(ctx, ref, path)`; `fileEverExisted(ctx, path)`; `commitsTouching(ctx, ref, path, sinceIso)`; `symbolExists(ctx, ref | null, symbol)`; `symbolEverExisted(ctx, symbol)`; `commitExists(ctx, sha)`.

- [ ] **Adım 1: Kırmızı test**

`core/test/git-signals.test.ts`:

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openGit, fileExistsAt, fileEverExisted, commitsTouching, symbolExists, symbolEverExisted, commitExists,
} from "../src/signals/git.ts";

let repo: string;
let firstSha: string;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "cp-git-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export function eskiSembol() {}\n");
  git("add", "-A"); git("commit", "-qm", "ilk"); firstSha = git("rev-parse", "HEAD");
  // İkinci commit: sembol yeniden adlandı, dosya silinip yenisi geldi.
  writeFileSync(join(repo, "src", "a.ts"), "export function yeniSembol() {}\n");
  writeFileSync(join(repo, "src", "b.ts"), "export const x = 1;\n");
  git("add", "-A"); git("commit", "-qm", "ikinci");
  rmSync(join(repo, "src", "b.ts"));
  git("add", "-A"); git("commit", "-qm", "b silindi");
});

test("openGit: repo tanınır, git olmayan dizinde null", async () => {
  const ctx = await openGit(repo, { fetch: false });
  assert.ok(ctx);
  assert.equal(ctx!.repoRoot, repo);
  assert.equal(ctx!.originRef, null); // origin'siz repo: yalnız çalışma ağacı
  assert.equal(await openGit(mkdtempSync(join(tmpdir(), "cp-nogit-")), { fetch: false }), null);
});

test("dosya sinyalleri: var / silinmiş-ama-geçmişte-var / hiç-var-olmamış üçlüsü ayrışır", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  assert.equal(await fileExistsAt(ctx, "HEAD", "src/a.ts"), true);
  assert.equal(await fileExistsAt(ctx, "HEAD", "src/b.ts"), false);
  assert.equal(await fileEverExisted(ctx, "src/b.ts"), true);   // silinmiş → missing_now hammaddesi
  assert.equal(await fileEverExisted(ctx, "src/hayalet.ts"), false); // → never_existed hammaddesi
  assert.equal(await commitsTouching(ctx, "HEAD", "src/a.ts", "1970-01-01T00:00:00Z"), 2);
});

test("sembol sinyalleri: kayıp sembol geçmişte aranır; sha varlığı", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  assert.equal(await symbolExists(ctx, null, "yeniSembol"), true);   // null ref = çalışma ağacı
  assert.equal(await symbolExists(ctx, null, "eskiSembol"), false);
  assert.equal(await symbolEverExisted(ctx, "eskiSembol"), true);    // → symbol_lost hammaddesi
  assert.equal(await symbolEverExisted(ctx, "hayaletSembol"), false); // → unverifiable
  assert.equal(await commitExists(ctx, firstSha), true);
  assert.equal(await commitExists(ctx, "deadbeef"), false);
});
```

- [ ] **Adım 2: Kırmızıyı doğrula** — FAIL: modül yok.

- [ ] **Adım 3: Uygulama**

`core/src/signals/git.ts`:

```ts
// Salt-okunur git yardımcısı. Tek yan etkisi best-effort fetch (D-M3-5) — o da
// çalışma ağacına değil .git'e dokunur ve --no-fetch ile kapatılabilir.
// Her çağrı zaman aşımlı: asılı bir git süreci arka plan denetçisini asamaz.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;

export interface GitContext {
  repoRoot: string;
  head: string;
  /** origin/<default> çözümü; null = origin yok, yalnız çalışma ağacı denetlenir. */
  originRef: string | null;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, out: stdout.trim() };
  } catch {
    // ok=false "hata" değil çoğu zaman "hayır" (cat-file -e, grep). Ayrım
    // çağıranın sorusunda: varlık soruları için ikisi aynı cevap.
    return { ok: false, out: "" };
  }
}

export async function openGit(
  dir: string, opts: { fetch?: boolean; originRef?: string } = {},
): Promise<GitContext | null> {
  const root = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return null;
  const head = await git(root.out, ["rev-parse", "HEAD"]);
  if (!head.ok) return null; // commit'siz repo: denetlenecek geçmiş yok

  if (opts.fetch !== false) await git(root.out, ["fetch", "--quiet", "origin"]); // best-effort

  let originRef: string | null = null;
  // Ölçüm pin'i (D-M3-8) her adaydan önce gelir: altın set origin'in BUGÜNKÜ
  // ucuna değil ölçüm günkü ucuna (19c623f) karşı denetlenir.
  const candidates = opts.originRef !== undefined
    ? [opts.originRef]
    : ["origin/HEAD", "origin/main", "origin/master"];
  for (const cand of candidates) {
    if ((await git(root.out, ["rev-parse", "--verify", "--quiet", `${cand}^{commit}`])).ok) {
      originRef = cand;
      break;
    }
  }
  return { repoRoot: root.out, head: head.out, originRef };
}

/** ref:path var mı. */
export async function fileExistsAt(ctx: GitContext, ref: string, path: string): Promise<boolean> {
  return (await git(ctx.repoRoot, ["cat-file", "-e", `${ref}:${path}`])).ok;
}

/** Yol geçmişin HERHANGİ bir noktasında eklendi mi — never_existed'ı missing_now'dan ayıran soru. */
export async function fileEverExisted(ctx: GitContext, path: string): Promise<boolean> {
  const r = await git(ctx.repoRoot, ["log", "--all", "--diff-filter=A", "-1", "--format=%H", "--", path]);
  return r.ok && r.out !== "";
}

/** sinceIso'dan beri yola dokunan commit sayısı (churn — D-M3-4). */
export async function commitsTouching(ctx: GitContext, ref: string, path: string, sinceIso: string): Promise<number> {
  const r = await git(ctx.repoRoot, ["rev-list", "--count", `--since=${sinceIso}`, ref, "--", path]);
  const n = Number(r.out);
  return r.ok && Number.isFinite(n) ? n : 0;
}

/** ref null → çalışma ağacında ara (izlenen dosyalar). */
export async function symbolExists(ctx: GitContext, ref: string | null, symbol: string): Promise<boolean> {
  const args = ["grep", "-F", "-l", "-e", symbol];
  if (ref !== null) args.push(ref);
  const r = await git(ctx.repoRoot, args);
  return r.ok && r.out !== "";
}

/** Sembol geçmişte hiç geçti mi (-S: ekleyen/silen commit arar). Aşırı-üretilmiş
 *  çapayı gerçek kayıptan ayıran soru: hiç izi yoksa suçlama yok (D-M3-2). */
export async function symbolEverExisted(ctx: GitContext, symbol: string): Promise<boolean> {
  const r = await git(ctx.repoRoot, ["log", "--all", "-1", "--format=%H", `-S${symbol}`]);
  return r.ok && r.out !== "";
}

export async function commitExists(ctx: GitContext, sha: string): Promise<boolean> {
  return (await git(ctx.repoRoot, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`])).ok;
}
```

- [ ] **Adım 4: Yeşili doğrula**, **Adım 5: Commit** — `git commit -m "M3: salt-okunur git yardımcısı"`

---

### Görev 6: DURUM-kalıbı dedektörü

**Files:**
- Create: `core/src/signals/status-pattern.ts`
- Test: `core/test/status-pattern.test.ts`

**Interfaces:**
- Produces: `hasStatusPattern(text): boolean`; `matchedStatusPatterns(text): string[]`.

- [ ] **Adım 1: Kırmızı test**

`core/test/status-pattern.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasStatusPattern, matchedStatusPatterns } from "../src/signals/status-pattern.ts";

test("M0-D1 kalıpları yakalanır", () => {
  for (const t of [
    "DURUM: 11 Ağu · iş sürüyor",
    "değişiklikler henüz pushlanmadı",
    "şu an refactor ortasındayız",
    "sıradaki iş: adapter",
    "commit edilmedi, bekliyor",
  ]) assert.equal(hasStatusPattern(t), true, t);
});

test("kalıcı ders/karar metni tetiklemez", () => {
  for (const t of [
    "Karar: adapter seam'i gün birden tanımlı. Gerekçe: sonradan seam açmak pahalı.",
    "Ölçüm: 3 denendi, 1'i döndü.",
    "durum makinesi deseni kullanıldı", // 'durum' kelimesi tek başına yetmez
  ]) assert.equal(hasStatusPattern(t), false, t);
});

test("hangi kalıbın tetiklediği raporlanabilir (olay detayı için)", () => {
  const m = matchedStatusPatterns("DURUM: sürüyor, henüz bitmedi");
  assert.equal(m.length, 2);
});
```

- [ ] **Adım 2: Kırmızıyı doğrula** — FAIL.

- [ ] **Adım 3: Uygulama**

`core/src/signals/status-pattern.ts`:

```ts
// DURUM-kalıbı dedektörü — en güçlü ucuz sinyal (M0-D1: çürüyen 17 notun 9'u bu
// sınıf). Kalıplar M0 raporunun ölçtüğü listeden; genişletme ancak yeni ölçümle.
// Türkçe: prototipin tüm notları Türkçe (D-M2-7 ile aynı gerekçe).

const STATUS_PATTERNS: readonly RegExp[] = [
  /^DURUM\s*:/im,
  /\bşu an\b/i,
  /\bhenüz\b/i,
  /sıradaki iş/i,
  /commit edilmedi/i,
  /push(?:lanmadı|lanmamış| edilmedi)/i,
];

export function hasStatusPattern(text: string): boolean {
  return STATUS_PATTERNS.some((re) => re.test(text));
}

export function matchedStatusPatterns(text: string): string[] {
  return STATUS_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}
```

- [ ] **Adım 4: Yeşili doğrula**, **Adım 5: Commit** — `git commit -m "M3: DURUM-kalıbı dedektörü"`

---

### Görev 7: Çapa doğrulama + kayma skoru (M2 borcu 1 burada kapanır)

**Files:**
- Create: `core/src/signals/anchor-drift.ts`
- Test: `core/test/anchor-drift.test.ts`

**Interfaces:**
- Consumes: Görev 5'in tüm git fonksiyonları; `hasStatusPattern` (Görev 6); `Anchor` (types.ts).
- Produces: `checkAnchors(ctx, anchors, sinceIso): Promise<AnchorVerdict[]>`; `scoreDrift(verdicts, statusPattern): DriftScore { score; reasons }`; `SUSPICION_THRESHOLD = 0.6`; tipler `AnchorState`, `AnchorVerdict`.

- [ ] **Adım 1: Kırmızı test — saf skor fonksiyonu (git'siz)**

`core/test/anchor-drift.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreDrift, SUSPICION_THRESHOLD, type AnchorVerdict } from "../src/signals/anchor-drift.ts";

const v = (state: AnchorVerdict["state"], extra: Partial<AnchorVerdict> = {}): AnchorVerdict =>
  ({ anchor: { kind: "file_path", value: "x.ts" }, state, ...extra });

test("ağırlıklar D-M3-4: tekil durumlar", () => {
  assert.equal(scoreDrift([v("missing_now")], false).score, 0.5);
  assert.equal(scoreDrift([v("symbol_lost")], false).score, 0.4);
  assert.equal(scoreDrift([v("never_existed")], false).score, 0.3);
  assert.equal(scoreDrift([v("churned", { commits: 3 })], false).score, 0.2);
  assert.equal(scoreDrift([v("churned", { commits: 12 })], false).score, 0.3);
  assert.equal(scoreDrift([v("ok", { commits: 1 })], false).score, 0);
  assert.equal(scoreDrift([v("unverifiable")], false).score, 0); // aşırı-üretim suçlanmaz (D-M3-2)
});

test("DURUM-kalıbı: tek başına eşik ALTINDA, çapa hareketiyle eşiğin ÜSTÜNDE (M0-D1)", () => {
  const alone = scoreDrift([v("ok", { commits: 0 })], true);
  assert.ok(alone.score < SUSPICION_THRESHOLD);
  const withMove = scoreDrift([v("churned", { commits: 3 })], true);
  assert.ok(withMove.score >= 0.7, `beklenen ≥0.7, gelen ${withMove.score}`);
  const withLoss = scoreDrift([v("missing_now")], true);
  assert.ok(withLoss.score >= 0.7);
});

test("skor 1.0'da kapaklanır ve reasons her katkıyı sayar", () => {
  const r = scoreDrift([v("missing_now"), v("missing_now"), v("symbol_lost")], true);
  assert.equal(r.score, 1);
  assert.ok(r.reasons.length >= 3);
});

test("ref uyuşmazlığında kötü hüküm skoru belirler (M0-D7)", () => {
  // Çalışma ağacında ok, origin'de silinmiş: skor missing_now'dan.
  const d = scoreDrift([v("missing_now", { refDisagreement: { head: "ok", origin: "missing_now" } })], false);
  assert.equal(d.score, 0.5);
  assert.ok(d.reasons[0]!.includes("origin"));
});
```

- [ ] **Adım 2: Kırmızıyı doğrula** — FAIL.

- [ ] **Adım 3: Uygulama**

`core/src/signals/anchor-drift.ts`:

```ts
// Çapa doğrulama + kayma skoru. M2'nin %10 uydurma çapa borcu burada kapanır:
// "geçmişte hiç izi yok" (never_existed / unverifiable) ile "var olup kaybolmuş"
// (missing_now / symbol_lost) yapısal olarak ayrışır — suçlama yalnız kanıtlıya.

import type { Anchor } from "../types.ts";
import {
  type GitContext, fileExistsAt, fileEverExisted, commitsTouching,
  symbolExists, symbolEverExisted, commitExists,
} from "./git.ts";

export const SUSPICION_THRESHOLD = 0.6; // M0 kalibrasyonu (rapor §5)

export type AnchorState = "ok" | "missing_now" | "never_existed" | "symbol_lost" | "churned" | "unverifiable";

export interface AnchorVerdict {
  anchor: Anchor;
  state: AnchorState;
  /** Not tarihinden beri çapa dosyasına dokunan commit sayısı. */
  commits?: number;
  /** Çalışma ağacı ile origin farklı hüküm verdi (M0-D7) — ikisi de raporlanır. */
  refDisagreement?: { head: AnchorState; origin: AnchorState };
}

export interface DriftScore { score: number; reasons: string[] }

// D-M3-4 ağırlıkları. Değişiklik ancak altın set ölçümüyle — sayılar M0'dan.
const WEIGHT: Partial<Record<AnchorState, number>> = {
  missing_now: 0.5,
  symbol_lost: 0.4,
  never_existed: 0.3,
};
const SEVERITY: Record<AnchorState, number> = {
  missing_now: 3, symbol_lost: 3, never_existed: 2, churned: 1, ok: 0, unverifiable: 0,
};

async function fileStateAt(ctx: GitContext, ref: string, path: string, sinceIso: string): Promise<{ state: AnchorState; commits: number }> {
  if (await fileExistsAt(ctx, ref, path)) {
    const commits = await commitsTouching(ctx, ref, path, sinceIso);
    return { state: commits >= 3 ? "churned" : "ok", commits };
  }
  return { state: (await fileEverExisted(ctx, path)) ? "missing_now" : "never_existed", commits: 0 };
}

export async function checkAnchors(ctx: GitContext, anchors: Anchor[], sinceIso: string): Promise<AnchorVerdict[]> {
  const out: AnchorVerdict[] = [];
  for (const anchor of anchors) {
    if (anchor.kind === "external_path") { out.push({ anchor, state: "unverifiable" }); continue; } // D-M3-7
    if (anchor.kind === "commit_sha") {
      out.push({ anchor, state: (await commitExists(ctx, anchor.value)) ? "ok" : "unverifiable" });
      continue;
    }
    if (anchor.kind === "symbol") {
      if (await symbolExists(ctx, null, anchor.value)) { out.push({ anchor, state: "ok" }); continue; }
      out.push({ anchor, state: (await symbolEverExisted(ctx, anchor.value)) ? "symbol_lost" : "unverifiable" });
      continue;
    }
    // file_path: iki ref birden (M0-D7), skor kötüsünden (D-M3-5).
    const head = await fileStateAt(ctx, "HEAD", anchor.value, sinceIso);
    const origin = ctx.originRef !== null ? await fileStateAt(ctx, ctx.originRef, anchor.value, sinceIso) : null;
    const worse = origin !== null && SEVERITY[origin.state] > SEVERITY[head.state] ? origin : head;
    out.push({
      anchor,
      state: worse.state,
      commits: Math.max(head.commits, origin?.commits ?? 0),
      ...(origin !== null && origin.state !== head.state
        ? { refDisagreement: { head: head.state, origin: origin.state } }
        : {}),
    });
  }
  return out;
}

export function scoreDrift(verdicts: AnchorVerdict[], statusPattern: boolean): DriftScore {
  let score = 0;
  const reasons: string[] = [];
  let maxCommits = 0;
  let anchorMoved = false;

  for (const v of verdicts) {
    const w = WEIGHT[v.state];
    if (w !== undefined) {
      score += w;
      anchorMoved = anchorMoved || v.state !== "never_existed"; // hiç var olmamış çapa "hareket" değil
      const refNote = v.refDisagreement !== undefined
        ? ` (çalışma ağacı: ${v.refDisagreement.head}, origin: ${v.refDisagreement.origin})`
        : "";
      reasons.push(`${v.anchor.kind} ${v.anchor.value}: ${v.state}${refNote}`);
    }
    if (v.commits !== undefined) maxCommits = Math.max(maxCommits, v.commits);
  }

  if (maxCommits >= 3) {
    score += maxCommits >= 10 ? 0.3 : 0.2;
    anchorMoved = true;
    reasons.push(`churn: not tarihinden beri ${maxCommits} commit`);
  } else if (maxCommits >= 1) anchorMoved = true;

  if (statusPattern) {
    // M0-D1: DURUM + hareket bileşimi tek başına eşiği aşar; kalıp tek başına aşmaz.
    if (anchorMoved) {
      score = Math.max(score, 0.7);
      reasons.push("DURUM-kalıbı + çapa hareketi (M0-D1)");
    } else {
      score += 0.2;
      reasons.push("DURUM-kalıbı (hareketsiz: tek başına eşik altı)");
    }
  }

  return { score: Math.min(1, Number(score.toFixed(4))), reasons };
}
```

- [ ] **Adım 4: İkinci test turu — checkAnchors gerçek repoyla** (Görev 5'in `before` fixture'ı aynen kopyalanır, aynı repo kurulumu):

```ts
test("checkAnchors: silinen dosya missing_now, hayalet yol never_existed, kayıp sembol symbol_lost", async () => {
  const ctx = (await openGit(repo, { fetch: false }))!;
  const verdicts = await checkAnchors(ctx, [
    { kind: "file_path", value: "src/b.ts" },
    { kind: "file_path", value: "src/hayalet.ts" },
    { kind: "symbol", value: "eskiSembol" },
    { kind: "symbol", value: "hayaletSembol" },
    { kind: "external_path", value: "~/.x/y.json" },
  ], "1970-01-01T00:00:00Z");
  assert.deepEqual(verdicts.map((x) => x.state),
    ["missing_now", "never_existed", "symbol_lost", "unverifiable", "unverifiable"]);
});
```

(`anchor-drift.test.ts` içine, Görev 5 testindeki repo kurulum bloğu `before` ile birlikte eklenir; `openGit` import edilir.)

- [ ] **Adım 5: Yeşili doğrula**, **Adım 6: Commit** — `git commit -m "M3: çapa doğrulama ve kayma skoru — uydurma çapa borcu kapandı"`

---

### Görev 8: Çelişki adaylığı — mekanik ön eleme

**Files:**
- Create: `core/src/signals/contradiction.ts`
- Test: `core/test/contradiction.test.ts`

**Interfaces:**
- Consumes: `Anchor` (types.ts).
- Produces: `findCandidates(notes: NoteView[]): { candidates: Candidate[]; skippedAnchors: number }` — `NoteView { findingId; content; anchors; description: string | null; hasStatus: boolean }`, `Candidate { kind: "cross"|"intra"|"frontmatter"; aId; bId: number | null; reason }`; `MAX_NOTES_PER_ANCHOR = 4`.

- [ ] **Adım 1: Kırmızı test**

`core/test/contradiction.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { findCandidates, MAX_NOTES_PER_ANCHOR } from "../src/signals/contradiction.ts";

const note = (findingId: number, over: Partial<Parameters<typeof findCandidates>[0][0]> = {}) => ({
  findingId, content: "içerik", anchors: [], description: null, hasStatus: false, ...over,
});

test("çapraz yüzey: aynı çapayı paylaşan çift aday olur, çift yönde tek kayıt", () => {
  const a = { kind: "file_path" as const, value: "src/x.ts" };
  const { candidates } = findCandidates([
    note(1, { anchors: [a] }), note(2, { anchors: [a] }), note(3),
  ]);
  const cross = candidates.filter((c) => c.kind === "cross");
  assert.equal(cross.length, 1);
  assert.deepEqual([cross[0]!.aId, cross[0]!.bId], [1, 2]);
  assert.ok(cross[0]!.reason.includes("src/x.ts"));
});

test("4'ten çok notta geçen çapa ayırt edici değil: çift üretmez, sayılır (sessiz kırpma yok)", () => {
  const a = { kind: "file_path" as const, value: "README.md" };
  const many = Array.from({ length: MAX_NOTES_PER_ANCHOR + 1 }, (_, i) => note(i + 1, { anchors: [a] }));
  const { candidates, skippedAnchors } = findCandidates(many);
  assert.equal(candidates.filter((c) => c.kind === "cross").length, 0);
  assert.equal(skippedAnchors, 1);
});

test("not içi (DURUM'lu) ve frontmatter (description'lı) yüzeyleri", () => {
  const { candidates } = findCandidates([
    note(1, { hasStatus: true }),
    note(2, { description: "özet satırı" }),
    note(3),
  ]);
  assert.deepEqual(
    candidates.map((c) => [c.kind, c.aId]),
    [["intra", 1], ["frontmatter", 2]],
  );
});
```

- [ ] **Adım 2: Kırmızıyı doğrula** — FAIL.

- [ ] **Adım 3: Uygulama**

`core/src/signals/contradiction.ts`:

```ts
// Çelişki adaylığının mekanik ön elemesi — üç yüzey (M0-D3), üçünde de saha
// örneği var. Saf fonksiyon: pahalı katman (Codex sınıflaması) yalnız buradan
// çıkan adayları görür (spec §3.4: LLM'siz olan her şey LLM'siz).

import type { Anchor } from "../types.ts";

export interface NoteView {
  findingId: number;
  content: string;
  anchors: Anchor[];
  /** İmported notun frontmatter description'ı; observed bulguda null. */
  description: string | null;
  hasStatus: boolean;
}

export type CandidateKind = "cross" | "intra" | "frontmatter";

export interface Candidate {
  kind: CandidateKind;
  aId: number;
  /** intra/frontmatter tek notluk: bId null. */
  bId: number | null;
  reason: string;
}

/** Bundan çok notta geçen çapa ayırt edici değil (ör. herkesin andığı README) —
 *  çift patlaması hem maliyet hem gürültü olur. Atlanan çapa SAYILIR. */
export const MAX_NOTES_PER_ANCHOR = 4;

export function findCandidates(notes: NoteView[]): { candidates: Candidate[]; skippedAnchors: number } {
  const candidates: Candidate[] = [];
  let skippedAnchors = 0;

  // (a) çapraz: aynı (kind,value) çapayı paylaşan çiftler.
  const byAnchor = new Map<string, { label: string; ids: number[] }>();
  for (const n of notes) {
    for (const a of n.anchors) {
      const key = `${a.kind}\u0000${a.value}`;
      const e = byAnchor.get(key) ?? { label: a.value, ids: [] };
      if (!e.ids.includes(n.findingId)) e.ids.push(n.findingId);
      byAnchor.set(key, e);
    }
  }
  const seenPair = new Set<string>();
  for (const { label, ids } of byAnchor.values()) {
    if (ids.length < 2) continue;
    if (ids.length > MAX_NOTES_PER_ANCHOR) { skippedAnchors++; continue; }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pk = `${ids[i]}:${ids[j]}`;
        if (seenPair.has(pk)) continue;
        seenPair.add(pk);
        candidates.push({ kind: "cross", aId: ids[i]!, bId: ids[j]!, reason: `ortak çapa: ${label}` });
      }
    }
  }

  // (b) not içi: akış-durumu kalıbı taşıyan not kendi içinde çelişmeye aday
  //     (M0: bekleyen-isler satır 117 vs 156; kritik-acik üst vs alt blok).
  // (c) frontmatter ↔ gövde: en sinsi yüzey — indeksten okuyan ajan yalnız
  //     description'ı görür (M0: teslim-yolu-denetimi).
  for (const n of notes) {
    if (n.hasStatus) candidates.push({ kind: "intra", aId: n.findingId, bId: null, reason: "akış-durumu kalıbı" });
    if (n.description !== null && n.description !== "")
      candidates.push({ kind: "frontmatter", aId: n.findingId, bId: null, reason: "description ↔ gövde" });
  }

  return { candidates, skippedAnchors };
}
```

- [ ] **Adım 4: Yeşili doğrula**, **Adım 5: Commit** — `git commit -m "M3: çelişki adaylığı — üç yüzeyli mekanik ön eleme"`

---

### Görev 9: Çelişki sınıflaması — tek toplu Codex çağrısı

**Files:**
- Create: `core/src/signals/classify.ts`
- Test: `core/test/classify.test.ts`

**Interfaces:**
- Consumes: `ExecutorAdapter` (executor.ts), `Candidate`/`NoteView` (Görev 8), `parseNote` (Görev 3).
- Produces: `CLASSIFY_OUTPUT_SCHEMA`; `buildClassifyPrompt(items): string`; `parseClassifyOutput(raw, count)`; `classifyCandidates(executor, candidates, notesById, opts?): Promise<ClassifyResult>` — `ClassifyResult { ok: boolean; confirmed: Candidate[]; kararsiz: number; calls: number; dropped: number; error?: string }`; `MAX_CLASSIFY_ITEMS = 20`.

- [ ] **Adım 1: Kırmızı test**

`core/test/classify.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClassifyPrompt, parseClassifyOutput, classifyCandidates, MAX_CLASSIFY_ITEMS, CLASSIFY_OUTPUT_SCHEMA,
} from "../src/signals/classify.ts";
import { fakeExecutor } from "./helpers.ts";
import type { Candidate, NoteView } from "../src/signals/contradiction.ts";

const note = (findingId: number, content: string, description: string | null = null): NoteView =>
  ({ findingId, content, anchors: [], description, hasStatus: false });
const cand = (aId: number, bId: number | null, kind: Candidate["kind"] = "cross"): Candidate =>
  ({ kind, aId, bId, reason: "test" });

test("şema strict-mode uyumlu: her property required listesinde (M2 dersi)", () => {
  const item = (CLASSIFY_OUTPUT_SCHEMA as any).properties.verdicts.items;
  assert.deepEqual(Object.keys(item.properties).sort(), [...item.required].sort());
});

test("prompt ölçüm çerçevesi taşır ve alıntıları sınırlar (cyberPolicy dersi + §2.2)", () => {
  const long = "x".repeat(9000);
  const p = buildClassifyPrompt([{ index: 0, kind: "cross", aText: long, bText: "kısa", reason: "ortak çapa" }]);
  assert.ok(p.includes("ÇELİŞİYOR MU"));
  assert.ok(!/\bkır\b|saldır/i.test(p));
  assert.ok(p.length < 5000); // alıntı kırpıldı
});

test("parseClassifyOutput: düzyazıya sarılı JSON kurtarılır, aralık dışı index atılır", () => {
  const raw = 'Sonuç:\n{"verdicts":[{"index":0,"verdict":"celiski","evidence":"e"},{"index":9,"verdict":"uyumlu","evidence":"e"}]}\nbitti';
  const r = parseClassifyOutput(raw, 1);
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.verdicts.length, 1); assert.equal(r.verdicts[0]!.verdict, "celiski"); }
});

test("classifyCandidates: onaylanan çift döner, tavan üstü aday sayılır, tek çağrı", async () => {
  const notes = new Map([[1, note(1, "A doğru")], [2, note(2, "A yanlış")], [3, note(3, "ilgisiz")]]);
  const many = [cand(1, 2), ...Array.from({ length: MAX_CLASSIFY_ITEMS + 2 }, () => cand(1, 3))];
  const fake = fakeExecutor([
    { output: '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"zıt ifadeler"}]}' },
  ]);
  const r = await classifyCandidates(fake, many, notes);
  assert.equal(r.ok, true);
  assert.equal(r.confirmed.length, 1);
  assert.deepEqual([r.confirmed[0]!.aId, r.confirmed[0]!.bId], [1, 2]);
  assert.equal(r.dropped, 3); // tavan üstü — sessiz değil
  assert.equal(fake.calls.length, 1);
});

test("bozuk JSON'da bir düzeltme turu, yine bozuksa ok=false (spec §3.7)", async () => {
  const notes = new Map([[1, note(1, "a")], [2, note(2, "b")]]);
  const fake = fakeExecutor([{ output: "bozuk" }, { output: "yine bozuk" }]);
  const r = await classifyCandidates(fake, [cand(1, 2)], notes);
  assert.equal(r.ok, false);
  assert.equal(r.calls, 2);
});
```

- [ ] **Adım 2: Kırmızıyı doğrula** — FAIL.

- [ ] **Adım 3: Uygulama**

`core/src/signals/classify.ts`:

```ts
// Aday çiftlerin TEK toplu Codex çağrısıyla sınıflanması (D-M3-6). Çerçeve
// ölçümdür, teyit ya da saldırı değil: "bu iki ifade çelişiyor mu" (spec §3.4;
// cyberPolicy ölçümü: "kır" kipi reddediliyor, "ölç" geçiyor).

import type { ExecutorAdapter } from "../adapters/executor.ts";
import type { Candidate, NoteView } from "./contradiction.ts";
import { parseNote } from "../importer/parse.ts";

export const MAX_CLASSIFY_ITEMS = 20; // koşum başına; taşan sayı raporlanır
const EXCERPT_CHARS = 1500;

export interface ClassifyItem {
  index: number;
  kind: Candidate["kind"];
  aText: string;
  bText: string | null;
  reason: string;
}

export interface ClassifyVerdict { index: number; verdict: "celiski" | "uyumlu" | "kararsiz"; evidence: string }

export interface ClassifyResult {
  ok: boolean;
  confirmed: Candidate[];
  kararsiz: number;
  calls: number;
  dropped: number;
  error?: string;
}

// OpenAI strict mode: required, properties'in HER anahtarını listeler (M2 dersi
// invalid_json_schema — FakeExecutor'ın gizlediği gerçek-koşum arızası).
export const CLASSIFY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          verdict: { type: "string", enum: ["celiski", "uyumlu", "kararsiz"] },
          evidence: { type: "string" },
        },
        required: ["index", "verdict", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

const clip = (s: string) => (s.length > EXCERPT_CHARS ? s.slice(0, EXCERPT_CHARS) + "…[kırpıldı]" : s);

export function buildClassifyPrompt(items: ClassifyItem[]): string {
  const rendered = items.map((it) => {
    if (it.kind === "cross")
      return `#${it.index} [notlar-arası, ${it.reason}]\nA: «${clip(it.aText)}»\nB: «${clip(it.bText ?? "")}»`;
    if (it.kind === "frontmatter")
      return `#${it.index} [özet-satırı ↔ gövde]\nÖzet: «${clip(it.bText ?? "")}»\nGövde: «${clip(it.aText)}»`;
    return `#${it.index} [not-içi]\nMetin: «${clip(it.aText)}»`;
  }).join("\n\n");

  return `Aşağıda numaralı adaylar var. Her aday için görev bir ÖLÇÜM: verilen iki metin
(ya da tek metnin parçaları) aynı konu hakkında birbiriyle ÇELİŞİYOR MU?

- "celiski": iki ifade aynı anda doğru olamaz.
- "uyumlu": çelişki yok ya da farklı şeylerden bahsediyorlar.
- "kararsiz": metinden karar verilemiyor.

evidence: kararın dayanağı TEK cümle. Yalnız istenen şemada JSON döndür.

${rendered}`;
}

export function parseClassifyOutput(
  raw: string, itemCount: number,
): { ok: true; verdicts: ClassifyVerdict[] } | { ok: false; error: string } {
  // Düzyazıya sarılı JSON kurtarma — gözlemcide ölçülen aynı sınıf (prompt.ts).
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, error: "çıktıda JSON nesnesi yok" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `JSON ayrıştırılamadı: ${(e as Error).message}` };
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) return { ok: false, error: "verdicts dizisi yok" };
  const seen = new Set<number>();
  const out: ClassifyVerdict[] = [];
  for (const v of verdicts) {
    const c = v as ClassifyVerdict;
    if (typeof c?.index !== "number" || c.index < 0 || c.index >= itemCount || seen.has(c.index)) continue;
    if (c.verdict !== "celiski" && c.verdict !== "uyumlu" && c.verdict !== "kararsiz") continue;
    seen.add(c.index);
    out.push({ index: c.index, verdict: c.verdict, evidence: typeof c.evidence === "string" ? c.evidence : "" });
  }
  return { ok: true, verdicts: out };
}

function renderItems(candidates: Candidate[], notes: Map<number, NoteView>): ClassifyItem[] {
  const items: ClassifyItem[] = [];
  for (const [i, c] of candidates.entries()) {
    const a = notes.get(c.aId);
    if (a === undefined) continue;
    if (c.kind === "cross") {
      const b = c.bId !== null ? notes.get(c.bId) : undefined;
      if (b === undefined) continue;
      items.push({ index: i, kind: c.kind, aText: a.content, bText: b.content, reason: c.reason });
    } else if (c.kind === "frontmatter") {
      items.push({ index: i, kind: c.kind, aText: parseNote(a.content).body, bText: a.description, reason: c.reason });
    } else {
      items.push({ index: i, kind: c.kind, aText: a.content, bText: null, reason: c.reason });
    }
  }
  return items;
}

export async function classifyCandidates(
  executor: ExecutorAdapter,
  candidates: Candidate[],
  notes: Map<number, NoteView>,
  opts: { maxItems?: number } = {},
): Promise<ClassifyResult> {
  const max = opts.maxItems ?? MAX_CLASSIFY_ITEMS;
  const taken = candidates.slice(0, max);
  const dropped = candidates.length - taken.length;
  if (taken.length === 0) return { ok: true, confirmed: [], kararsiz: 0, calls: 0, dropped };

  // item.index = adayın taken içindeki konumu (renderItems entries() index'i
  // kullanır); nota erişilemeyen aday atlanmış olsa da index'ler taken'a işaret
  // eder — verdict eşlemesi bu yüzden doğrudan taken[v.index].
  const items = renderItems(taken, notes);
  const prompt = buildClassifyPrompt(items);
  let calls = 0;

  const runOnce = async (p: string) => {
    calls++;
    return executor.run({ prompt: p, outputSchema: CLASSIFY_OUTPUT_SCHEMA });
  };

  let res = await runOnce(prompt);
  if (!res.ok) { res = await runOnce(prompt); } // geçici hata tekrarı (spec §3.3)
  if (!res.ok) return { ok: false, confirmed: [], kararsiz: 0, calls, dropped, error: `yürütücü: ${res.error}` };

  let parsed = parseClassifyOutput(res.output, taken.length);
  if (!parsed.ok) {
    const retry = await runOnce(
      `${prompt}\n\nÖNCEKİ ÇIKTIN GEÇERSİZDİ: ${parsed.error}. Yalnız şemaya uyan JSON döndür.`,
    );
    if (!retry.ok) return { ok: false, confirmed: [], kararsiz: 0, calls, dropped, error: `yürütücü: ${retry.error}` };
    parsed = parseClassifyOutput(retry.output, taken.length);
    if (!parsed.ok) return { ok: false, confirmed: [], kararsiz: 0, calls, dropped, error: `geçersiz JSON (iki deneme): ${parsed.error}` };
  }

  const confirmed: Candidate[] = [];
  let kararsiz = 0;
  for (const v of parsed.verdicts) {
    if (v.verdict === "celiski") confirmed.push(taken[v.index]!);
    else if (v.verdict === "kararsiz") kararsiz++;
  }
  return { ok: true, confirmed, kararsiz, calls, dropped };
}
```

- [ ] **Adım 4: Yeşili doğrula**, **Adım 5: Commit** — `git commit -m "M3: çelişki sınıflaması — tek toplu ölçüm çağrısı"`

---

### Görev 10: `audit` orkestrasyonu + CLI komutu

**Files:**
- Create: `core/src/audit.ts`
- Modify: `core/src/store/findings.ts` (`markSuspect`, `clearSuspect`)
- Modify: `core/src/store/events.ts` (türler)
- Modify: `core/src/cli.ts` (`audit` komutu)
- Test: `core/test/audit.test.ts`

**Interfaces:**
- Consumes: Görev 4-9'un tüm API'leri; `listActive/getAnchors/setSuspicion` (findings.ts); `createCodexExecutor` (codex.ts).
- Produces: `auditProject(store, project: { id; path; memoryDir: string | null }, opts: AuditOptions): Promise<AuditSummary>`; `AuditOptions { executor: ExecutorAdapter | null; fetch?: boolean; originRef?: string; maxClassifyItems?: number }`; `AuditSummary { import: ImportSummary | null; gitAvailable: boolean; checked; suspects; cleared; candidates; classified: boolean; contradictions; classifyDropped; classifyCalls }`.

- [ ] **Adım 1: Kırmızı test — uçtan uca, fakeExecutor + gerçek geçici git reposu**

`core/test/audit.test.ts` (git repo kurulumu Görev 5 fixture'ıyla aynı kalıp):

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { auditProject } from "../src/audit.ts";
import { getFinding, listActive } from "../src/store/findings.ts";
import { countEvents } from "../src/store/events.ts";
import { fakeExecutor } from "./helpers.ts";

let repo: string;
before(() => {
  repo = mkdtempSync(join(tmpdir(), "cp-audit-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "silinecek.ts"), "export const a = 1;\n");
  git("add", "-A"); git("commit", "-qm", "ilk");
  rmSync(join(repo, "src", "silinecek.ts"));
  git("add", "-A"); git("commit", "-qm", "silindi");
});

function setup(memory: Record<string, string>) {
  const memoryDir = mkdtempSync(join(tmpdir(), "cp-mem-"));
  for (const [name, content] of Object.entries(memory)) writeFileSync(join(memoryDir, name), content);
  const store = openStore(":memory:");
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    repo, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  return { store, project: { id, path: repo, memoryDir } };
}

test("uçtan uca: DURUM'lu + silinmiş-çapalı not suspect olur, temiz not olmaz, dosyaya yazılmaz (K9)", async () => {
  const { store, project } = setup({
    "curuk.md": "---\nname: curuk\nmodified: 2020-01-01T00:00:00.000Z\n---\nDURUM: iş sürüyor. `src/silinecek.ts` üzerinde çalışılıyor, henüz bitmedi.",
    "temiz.md": "---\nname: temiz\n---\nKarar: adapter seam'i gün birden. Gerekçe: sonradan pahalı.",
  });
  const sum = await auditProject(store, project, { executor: fakeExecutor([
    { output: '{"verdicts":[]}' },
  ]), fetch: false });

  assert.equal(sum.gitAvailable, true);
  assert.equal(sum.import!.added, 2);
  const all = listActive(store, project.id);
  const curuk = all.find((f) => f.content.includes("DURUM"))!;
  const temiz = all.find((f) => f.content.includes("Karar"))!;
  assert.equal(curuk.status, "suspect");
  assert.ok(curuk.suspicion >= 0.6);
  // Çapasız not unanchored'a düşer ve NÖTRDÜR (M0-D5): suspect olmaz, skor almaz.
  assert.equal(temiz.status, "unanchored");
  assert.equal(temiz.suspicion, 0);
  assert.equal(countEvents(store, "signal_scored"), 1); // yalnız curuk skorlandı; unanchored döngüye girmez
});

test("çelişki onayı iki tarafı da eşik üstüne çıkarır", async () => {
  const { store, project } = setup({
    "a.md": "`ortakBirSembolYok` hakkında: ölçüm X der.",
    "b.md": "`ortakBirSembolYok` hakkında: ölçüm X demez.",
  });
  const sum = await auditProject(store, project, { executor: fakeExecutor([
    { output: '{"verdicts":[{"index":0,"verdict":"celiski","evidence":"zıt ölçüm"}]}' },
  ]), fetch: false });
  assert.equal(sum.contradictions, 1);
  for (const f of listActive(store, project.id)) {
    assert.equal(f.status, "suspect");
    assert.ok(f.suspicion >= 0.6);
  }
  assert.equal(countEvents(store, "contradiction_confirmed"), 1);
});

test("yeniden hesap: skor düşen suspect active'e döner (D-M3-9); koşum idempotent (D-M3-3)", async () => {
  const { store, project } = setup({ "n.md": "sade kalıcı not, çapasız değil: `birSembol` anılıyor." });
  const exec = () => fakeExecutor([{ output: '{"verdicts":[]}' }]);
  await auditProject(store, project, { executor: exec(), fetch: false });
  const [f1] = listActive(store, project.id);
  // elle suspect'e it (sanki önceki koşum şüphelenmişti)
  store.run("UPDATE findings SET status = 'suspect', suspicion = 0.9 WHERE id = ?", f1!.id);
  await auditProject(store, project, { executor: exec(), fetch: false });
  const f2 = getFinding(store, f1!.id)!;
  assert.equal(f2.status, "active");        // sinyal yok → temize döndü
  assert.ok(f2.suspicion < 0.6);            // skor sıfırdan hesaplandı, birikmedi
});

test("git olmayan proje: anchor kapalı, çelişki koşar, olay düşer (D-M3-7)", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "cp-mem-"));
  writeFileSync(join(memoryDir, "n.md"), "---\ndescription: özet\n---\ngövde");
  const store = openStore(":memory:");
  const nogit = mkdtempSync(join(tmpdir(), "cp-nogit-"));
  const id = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir, memory_dir) VALUES (?,?,?,?)",
    nogit, "claude-code", "/t", memoryDir,
  ).lastInsertRowid);
  const sum = await auditProject(store, { id, path: nogit, memoryDir }, {
    executor: fakeExecutor([{ output: '{"verdicts":[]}' }]), fetch: false,
  });
  assert.equal(sum.gitAvailable, false);
  assert.equal(countEvents(store, "anchor_signal_disabled"), 1);
  assert.equal(sum.candidates, 1); // frontmatter yüzeyi yine de adaydı
});
```

- [ ] **Adım 2: Kırmızıyı doğrula** — FAIL: `audit.ts` yok.

- [ ] **Adım 3: Uygulama**

`findings.ts` sonuna:

```ts
/** Sinyal motorunun tekelinde (D-M3-9): yalnız active→suspect. */
export function markSuspect(store: Store, id: number): void {
  store.run("UPDATE findings SET status = 'suspect' WHERE id = ? AND status = 'active'", id);
}

/** Skor eşik altına düştüyse geri dönüş — otomatik, çünkü hiçbir dosyaya inmedi (K9). */
export function clearSuspect(store: Store, id: number): void {
  store.run("UPDATE findings SET status = 'active' WHERE id = ? AND status = 'suspect'", id);
}
```

`events.ts` `EventKind`'a: `"anchor_signal_disabled"`, `"signal_scored"`, `"finding_suspect"`, `"finding_cleared"`, `"contradiction_confirmed"`, `"classify_failed"`, `"classify_overflow"`.

`core/src/audit.ts`:

```ts
// Denetim orkestrasyonu: import → sinyaller → skor/status → olaylar.
// K9: hiçbir memory dosyasına yazım yok — çıktı yalnız depo + olay günlüğü.
// LLM yalnız çelişki sınıflamasında; koşum başına en fazla 2 çağrı (D-M3-6).

import type { Store } from "./store/db.ts";
import type { ExecutorAdapter } from "./adapters/executor.ts";
import { importMemoryDir, type ImportSummary } from "./importer/import.ts";
import { openGit } from "./signals/git.ts";
import { checkAnchors, scoreDrift, SUSPICION_THRESHOLD } from "./signals/anchor-drift.ts";
import { hasStatusPattern } from "./signals/status-pattern.ts";
import { findCandidates, type NoteView } from "./signals/contradiction.ts";
import { classifyCandidates, MAX_CLASSIFY_ITEMS } from "./signals/classify.ts";
import { listActive, getAnchors, setSuspicion, markSuspect, clearSuspect } from "./store/findings.ts";
import { parseNote } from "./importer/parse.ts";
import { logEvent } from "./store/events.ts";

export { SUSPICION_THRESHOLD };

export interface AuditOptions {
  /** null: sınıflama atlanır (yalnız testte anlamlı — CLI, K2 gereği detect'ten geçirir). */
  executor: ExecutorAdapter | null;
  fetch?: boolean;
  /** Ölçüm pin'i (D-M3-8): origin/<default> yerine bu ref. */
  originRef?: string;
  maxClassifyItems?: number;
}

export interface AuditSummary {
  import: ImportSummary | null;
  gitAvailable: boolean;
  checked: number;
  suspects: number;
  cleared: number;
  candidates: number;
  classified: boolean;
  contradictions: number;
  classifyDropped: number;
  classifyCalls: number;
}

export async function auditProject(
  store: Store,
  project: { id: number; path: string; memoryDir: string | null },
  opts: AuditOptions,
): Promise<AuditSummary> {
  const sum: AuditSummary = {
    import: null, gitAvailable: false, checked: 0, suspects: 0, cleared: 0,
    candidates: 0, classified: false, contradictions: 0, classifyDropped: 0, classifyCalls: 0,
  };

  if (project.memoryDir !== null) sum.import = await importMemoryDir(store, project.id, project.memoryDir);

  const ctx = await openGit(project.path, { fetch: opts.fetch, originRef: opts.originRef });
  sum.gitAvailable = ctx !== null;
  if (ctx === null)
    logEvent(store, { projectId: project.id, kind: "anchor_signal_disabled", detail: { path: project.path } });

  // Skorlar: active + suspect. unanchored NÖTR (M0-D5) — döngüye girmez ama
  // çelişki adaylığına aşağıda katılır (çapasız not da çelişebilir).
  const all = listActive(store, project.id);
  const scores = new Map<number, { score: number; reasons: string[] }>();

  for (const f of all) {
    if (f.status === "unanchored") continue;
    const anchors = getAnchors(store, f.id);
    const statusPattern = hasStatusPattern(f.content);
    const verdicts = ctx !== null ? await checkAnchors(ctx, anchors, f.createdAt) : [];
    const drift = scoreDrift(verdicts, statusPattern);
    scores.set(f.id, drift);
    sum.checked++;
  }

  // Çelişki: mekanik adaylar → tek toplu sınıflama.
  const views: NoteView[] = all.map((f) => ({
    findingId: f.id,
    content: f.content,
    anchors: getAnchors(store, f.id),
    description: f.source === "imported" ? (parseNote(f.content).frontmatter["description"] ?? null) : null,
    hasStatus: hasStatusPattern(f.content),
  }));
  const { candidates, skippedAnchors } = findCandidates(views);
  sum.candidates = candidates.length;
  if (skippedAnchors > 0)
    logEvent(store, { projectId: project.id, kind: "classify_overflow",
      detail: { skippedAnchors, note: "ayırt edici olmayan ortak çapalar çift üretmedi" } });

  if (candidates.length > 0 && opts.executor !== null) {
    const notesById = new Map(views.map((v) => [v.findingId, v]));
    const res = await classifyCandidates(opts.executor, candidates, notesById,
      { maxItems: opts.maxClassifyItems ?? MAX_CLASSIFY_ITEMS });
    sum.classifyCalls = res.calls;
    sum.classifyDropped = res.dropped;
    if (res.dropped > 0)
      logEvent(store, { projectId: project.id, kind: "classify_overflow", detail: { droppedCandidates: res.dropped } });
    if (!res.ok) {
      logEvent(store, { projectId: project.id, kind: "classify_failed", detail: { error: res.error } });
    } else {
      sum.classified = true;
      sum.contradictions = res.confirmed.length;
      for (const c of res.confirmed) {
        // Çelişki onaylanırsa İKİ taraf da yükselir (spec §3.4) — en az 0.7.
        for (const id of [c.aId, c.bId]) {
          if (id === null) continue;
          const cur = scores.get(id) ?? { score: 0, reasons: [] };
          scores.set(id, { score: Math.max(cur.score, 0.7), reasons: [...cur.reasons, `çelişki onaylandı (${c.kind}: ${c.reason})`] });
        }
        logEvent(store, { projectId: project.id, kind: "contradiction_confirmed",
          detail: { kind: c.kind, aId: c.aId, bId: c.bId, reason: c.reason } });
      }
    }
  }

  // Yazım: skor SIFIRDAN (D-M3-3), geçiş active↔suspect (D-M3-9), her şey olaylı.
  store.tx(() => {
    for (const f of all) {
      if (f.status === "unanchored") continue;
      const s = scores.get(f.id) ?? { score: 0, reasons: [] };
      setSuspicion(store, f.id, s.score);
      logEvent(store, { projectId: project.id, kind: "signal_scored",
        detail: { findingId: f.id, score: s.score, reasons: s.reasons } });
      if (s.score >= SUSPICION_THRESHOLD && f.status === "active") {
        markSuspect(store, f.id);
        sum.suspects++;
        logEvent(store, { projectId: project.id, kind: "finding_suspect", detail: { findingId: f.id, score: s.score } });
      } else if (s.score < SUSPICION_THRESHOLD && f.status === "suspect") {
        clearSuspect(store, f.id);
        sum.cleared++;
        logEvent(store, { projectId: project.id, kind: "finding_cleared", detail: { findingId: f.id, score: s.score } });
      } else if (s.score >= SUSPICION_THRESHOLD) sum.suspects++;
    }
  });

  return sum;
}
```

- [ ] **Adım 4: CLI**

`cli.ts` `COMMANDS`'a:

```ts
  audit: {
    values: ["project", "path", "memory-dir", "store", "origin-ref"],
    flags: ["no-fetch", "json"],
  },
```

`cmdAudit` (cmdObserve kalıbında):

```ts
async function cmdAudit(): Promise<void> {
  // K2: Codex sert bağımlılık — audit'in tek LLM kullanımı sınıflama olsa da kapı aynı.
  const executor = createCodexExecutor({});
  const det = await executor.detect();
  if (!det.found) {
    console.error(`codex bulunamadı: ${det.error ?? "PATH'te yok"}`);
    console.error("kurulum: npm install -g @openai/codex");
    process.exit(2);
  }

  const store = openStore(arg("store") ?? defaultStorePath());
  try {
    // İki mod: depodaki projeler (--project süzer) ya da elle kayıt (--path [+ --memory-dir],
    // altın set ölçümü pin'li worktree'yi böyle denetliyor — D-M3-8).
    let targets: { id: number; path: string; memoryDir: string | null }[];
    const manualPath = arg("path");
    if (manualPath !== undefined) {
      const id = upsertProject(store, {
        path: manualPath, adapterId: claudeCodeAdapter.id,
        transcriptDir: manualPath, memoryDir: arg("memory-dir") ?? null,
      });
      targets = [{ id, path: manualPath, memoryDir: arg("memory-dir") ?? null }];
    } else {
      targets = listProjects(store)
        .filter((p) => arg("project") === undefined || p.path === arg("project"))
        .map((p) => ({ id: p.id, path: p.path, memoryDir: p.memory_dir }));
      if (targets.length === 0) throw new UsageError("denetlenecek proje yok: önce `scan` koşun ya da --path verin");
    }

    const results: { path: string; summary: Awaited<ReturnType<typeof auditProject>> }[] = [];
    for (const t of targets) {
      const summary = await auditProject(store, t, {
        executor, fetch: !flag("no-fetch"), originRef: arg("origin-ref"),
      });
      results.push({ path: t.path, summary });
    }

    if (flag("json")) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const { path, summary: s } of results) {
        console.log(`\n${safe(path)}`);
        if (s.import) console.log(`  import: +${s.import.added} ~${s.import.replaced} -${s.import.deleted} (değişmeyen ${s.import.unchanged})`);
        if (!s.gitAvailable) console.log("  ⚠ git yok: çapa sinyali KAPALI, yalnız çelişki koşuyor");
        console.log(`  denetlenen: ${s.checked}  şüpheli: ${s.suspects}  temize dönen: ${s.cleared}`);
        console.log(`  çelişki adayı: ${s.candidates}  onaylanan: ${s.contradictions}  codex çağrısı: ${s.classifyCalls}`);
        if (s.classifyDropped > 0) console.log(`  ⚠ tavan üstü sınıflanmayan aday: ${s.classifyDropped}`);
        for (const f of listActive(store, targets.find((t) => t.path === path)!.id).filter((f) => f.status === "suspect"))
          console.log(`  🔶 #${f.id} (${f.suspicion.toFixed(2)}) ${safe(f.content.slice(0, 80))}`);
      }
    }
  } finally {
    store.close();
  }
}
```

Komut dağıtımına `else if (cmd === "audit") await cmdAudit();`; `usage()`'a satır: `context-police audit [--project <yol>] [--path <repo> [--memory-dir <dizin>]] [--origin-ref <ref>] [--no-fetch] [--json] [--store <db>]`.

- [ ] **Adım 5: Yeşili doğrula** — `npm run typecheck && npm test` (tüm takım).
- [ ] **Adım 6: Commit** — `git commit -m "M3: audit orkestrasyonu ve CLI komutu"`

---

### Görev 11: Çıkış kapısı — altın set ölçümü

Kod değil ölçüm görevi. Başarı skaleri İLK KEZ ölçülüyor (roadmap): *altın setteki 17 çürük nottan kaçı sinyal katmanında yakalanıyor + 11 geçerli nottan kaçı yanlış alarm alıyor.*

**Files:**
- Create: `docs/olcumler/2026-08-XX-m3-altin-set-olcumu.md`

- [ ] **Adım 1: Pin'li zemin kur (temizlik adımı 6'da ZORUNLU)**

```bash
git -C ~/Documents/unityaiPython worktree add /tmp/cp-m3-golden b4065f1
mkdir -p ~/.context-police/golden
cp -R ~/.claude/projects/-Users-burakemreerdemci-Documents-unitya-Python/memory \
      ~/.context-police/golden/$(date +%F)-gamachine   # repo DIŞI snapshot (D-M3-8)
mkdir -p /tmp/cp-m3-olcum
```

Şerh kontrolü: snapshot'taki not listesi M0 raporundaki 28 adla karşılaştırılır (`ls | wc -l` + ad diff'i). Silo M0'dan beri değiştiyse sapan notlar rapora şerh yazılır — altın set M0 tablosudur, bugünkü silo değil.

- [ ] **Adım 2: Denetimi pin'li koştur**

```bash
node --experimental-strip-types core/src/cli.ts audit \
  --path /tmp/cp-m3-golden \
  --memory-dir ~/.context-police/golden/<tarih>-gamachine \
  --origin-ref 19c623f --no-fetch \
  --store /tmp/cp-m3-olcum/olcum.db --json > /tmp/cp-m3-olcum/sonuc.json
```

(`19c623f` yerel repoda mevcut — M0 sırasında origin/main oydu; `--no-fetch` bugünkü origin'in altın seti kaydırmasını engeller.)

- [ ] **Adım 3: Sayıları çıkar**

`sonuc.json` + `olcum.db`'deki `signal_scored`/`contradiction_confirmed` olayları, M0 raporunun §2 tablosuyla not-not eşleştirilir:

| Ölçü | Hedef değil, ÖLÇÜM — sayı neyse o |
|---|---|
| Yakalama: 17 çürük nottan suspect olan | ? / 17 |
| Yanlış alarm: 11 geçerli nottan suspect olan | ? / 11 |
| Sinyal kırılımı: yakalananları hangi sinyal yakaladı (DURUM / çapa / çelişki) | dağılım |
| Kaçanlar: hangi çürüme tipi kaçtı (M0 tip sütunuyla çapraz) | liste |
| `never_existed`/`unverifiable` dağılımı (M2'nin %10 uydurma çapa borcunun ölçümü) | sayı |
| `observer_partial_overlap` sayısı (borç 3 sıklık ölçümü — varsa `/tmp/cp-m2-olcum/olcum.db` üstünden de) | sayı |

- [ ] **Adım 4: İkincil ölçüm (opsiyonel ama ucuz):** `/tmp/cp-m2-olcum/olcum.db` hâlâ diskteyse, M2'nin 38 gözlemlenmiş bulgusu üzerinde `audit --project` koşulur — uydurma çapaların kaçı `never_existed`/`unverifiable`'a düşüyor? (Dosya /tmp'de; silinmişse rapora şerh, ölçüm atlanır.)

- [ ] **Adım 5: Raporu yaz** — `docs/olcumler/2026-08-XX-m3-altin-set-olcumu.md`: yöntem, pin ref'leri, tablolar, kaçanların TEK TEK analizi (hangi sinyal eksikti), yanlış alarmların analizi (hangi kural aşırıydı), eşik/ağırlık değişikliği önerisi VARSA ölçüme dayalı olarak. Şerhler: silo sapması, Windows tazeliği (M0 şerhi devam), sınanmayanlar.

- [ ] **Adım 6: Temizlik (zorunlu)**

```bash
git -C ~/Documents/unityaiPython worktree remove /tmp/cp-m3-golden
git -C ~/Documents/unityaiPython worktree prune
```

- [ ] **Adım 7: Commit** — `git add docs/olcumler && git commit -m "M3 çıkış kapısı: altın set ölçümü"`

**Çıkış kapısı:** rapor + Burak'ın göz kontrolü. Yakalama oranı düşükse bu bir BAŞARISIZLIK değil ölçümdür — eksik sinyaller M4 hakem tasarımına veri olur (roadmap: "hakem yalnız eşik üstünde koşuyor").

---

## Görev sırası ve bağımlılıklar

1-2 (M2 borçları) bağımsız, önce; 3→4 (parse→import), 5→7 (git→drift), 6 küçük ve 7'den önce; 8→9 (adaylar→sınıflama); 10 hepsini tüketir; 11 en son. 3-6 arası birbirinden bağımsız — paralel yürütülebilir.

## Plan öz-denetimi (yazım sonrası)

- **Spec kapsaması:** roadmap M3 maddeleri — import+eşleme (G4), anchor kayması (G5+G7), çelişki adaylığı+sınıflama (G8+G9), şüphe birikimi+git'siz kapama (G10), çıkış kapısı (G11). M2 borçları 4/4 (G1, G2, G7, G11). ✓
- **Tip tutarlılığı:** `ImportSummary`, `NoteView`, `Candidate`, `AnchorVerdict`, `AuditSummary` alanları görevler arası birebir aynı adlarla geçiyor. ✓
- **Placeholder taraması:** "TBD/sonra doldurulur" yok; Görev 9'daki index-eşleme notu implementere açık talimat. ✓
