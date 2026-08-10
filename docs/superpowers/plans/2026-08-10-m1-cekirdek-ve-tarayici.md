# M1 — Çekirdek İskelet + Transcript Tarayıcı: Uygulama Planı

> **Kaynak:** `docs/superpowers/specs/2026-08-10-context-police-design.md` (onaylı spec)
> ve `docs/olcumler/2026-08-10-m0-gamachine-retrospektif.md` (M0 ölçümü).
> **Kapsam:** roadmap M1. LLM çağrısı YOK — bu milestone tamamen mekanik.

**Hedef:** Claude Code oturumlarını güvenilir ve artımlı okuyup, süzülmüş turn'leri
ve denetim kayıtlarını kalıcı bir depoya yazan, UI'sız çalışan bir çekirdek.

**Mimari:** Tek Node paketi (`core/`). Depo `node:sqlite`, testler `node:test`,
TypeScript yerel tip-soymayla doğrudan koşuyor — sıfır çalışma-zamanı bağımlılığı
(spec K12). `TranscriptAdapter` seam'i gün birden tanımlı, tek implementasyon:
Claude Code jsonl (spec K10).

## Ölçülmüş gerçekler (bu plan bunlara dayanıyor)

Denek: `~/.claude/projects/-Users-burakemreerdemci-Documents-unitya-Python/` — 64
transcript, en büyüğü **245 MB / 42.688 satır** (10 Ağu 2026 ölçümü).

- **Satır tipleri (11):** `user` 10.921, `assistant` 18.013, `file-history-snapshot`
  2.521, `queue-operation` 2.487, `last-prompt` 2.287, `attachment` 2.177, `ai-title`
  1.447, `mode` 1.209, `permission-mode` 805, `system` 638, `file-history-delta` 183.
  Bulgu taşıyan yalnız `user` + `assistant`.
- **Hacim dağılımı:** `user` 178,6 MB — bunun büyük kısmı 8.418 adet `tool_result`
  (araç çıktısı). `assistant` 45,8 MB, içinde 4.423 `thinking` bloğu.
- **İçerik şekilleri:** `content` ya `string` ya blok dizisi; blok tipleri
  `text`, `tool_use`, `tool_result`, `thinking`, `image`, `document`, `fallback`.
- **Süzmenin kazancı ölçüldü:** yalnız `text` blokları + `tool_use` **başlıkları**
  tutulunca 243,8 MB → **7,8 MB (31,4×)**, 42.688 satır → 16.092 turn.

**Bu ölçümün doğurduğu uyarı:** en büyük oturum süzüldükten sonra bile ~2M token.
8k'lık partilerle ~250 gözlemci çağrısı eder. M1 bunu çözmez (LLM yok) ama M2'nin
parti eşiği bu sayıyla yüzleşmek zorunda — plan M2'ye bu notu bırakıyor.

## Global kısıtlar

- Node **24+** zorunlu (`node:sqlite`, tip-soyma). `package.json` → `"engines"`.
- Çalışma-zamanı bağımlılığı **yok**. Yeni bağımlılık eklemek Burak'ın onayına tabi.
- `node:sqlite` deneysel: **tüm SQLite teması yalnız `src/store/db.ts`'de.** Başka
  hiçbir dosya `node:sqlite` import etmez — takas tek dosyalık iş kalsın.
- Kod ve identifier İngilizce, yorum ve doküman Türkçe.
- Depo yolu: `~/.context-police/store.db` (spec K4). Testler geçici dizin kullanır,
  gerçek depoya asla dokunmaz.
- Salt-okunur ilke: çekirdek transcript'lere ve `memory/` dosyalarına M1'de **yazmaz**.

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `core/package.json` | `type: module`, engines, `npm test` → `node --test` |
| `core/tsconfig.json` | Yalnız tip denetimi (`--noEmit`); çalıştırma tip-soymayla |
| `core/src/types.ts` | Ortak tipler: `Turn`, `SessionRef`, `Finding`, `Anchor`, `EventRecord` |
| `core/src/store/schema.sql` | DDL — dört tablo + indeksler |
| `core/src/store/db.ts` | **Tek SQLite teması.** Açma, şema uygulama, `withTx` |
| `core/src/store/projects.ts` | Proje kaydı + tarama imleci (dosya başına bayt offset) |
| `core/src/store/findings.ts` | findings + anchors; append-only invariantlar burada zorlanır |
| `core/src/store/events.ts` | Denetim günlüğü append + sorgu |
| `core/src/adapters/transcript.ts` | `TranscriptAdapter` arayüzü — seam |
| `core/src/adapters/claude-code.ts` | Claude Code jsonl: satır süzme, içerik süzme, keşif |
| `core/src/scan.ts` | Tarama döngüsü: keşif → artımlı okuma → depoya yazım |
| `core/src/cli.ts` | `context-police scan [--once]` |
| `core/test/fixtures/` | Küçük, elle yazılmış jsonl fixture'ları (gerçek veriden türetilmiş şekiller) |

---

## Task 1: İskelet ve test altyapısı

**Files:** `core/package.json`, `core/tsconfig.json`, `core/test/smoke.test.ts`

- [ ] `package.json`: `"type": "module"`, `"engines": {"node": ">=24"}`,
      `"scripts": {"test": "node --test --experimental-strip-types test/*.test.ts",
      "typecheck": "tsc --noEmit"}`
- [ ] `tsconfig.json`: `strict`, `noEmit`, `module: nodenext`, `allowImportingTsExtensions`
- [ ] Smoke testi: Node sürümü ≥24 ve `node:sqlite` import edilebiliyor mu
- [ ] `npm test` yeşil → commit

## Task 2: Depo çekirdeği (şema + db.ts)

**Files:** `core/src/store/schema.sql`, `core/src/store/db.ts`, `core/test/db.test.ts`

Şema (spec §3.2 + M0 geri beslemeleri):

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL,
  transcript_dir TEXT NOT NULL, memory_dir TEXT, last_scanned_at TEXT);

CREATE TABLE cursors (            -- transcript dosyası başına artımlı imleç
  project_id INTEGER NOT NULL REFERENCES projects(id),
  session_id TEXT NOT NULL, file_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  inode TEXT, last_seen_at TEXT,
  PRIMARY KEY (project_id, session_id));

CREATE TABLE findings (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL CHECK (source IN ('observed','imported')),
  content TEXT NOT NULL, source_ref TEXT, created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspect','superseded','born_invalid','unanchored')),
  superseded_by INTEGER REFERENCES findings(id),
  suspicion REAL NOT NULL DEFAULT 0);

CREATE TABLE anchors (
  id INTEGER PRIMARY KEY, finding_id INTEGER NOT NULL REFERENCES findings(id),
  kind TEXT NOT NULL CHECK (kind IN ('file_path','symbol','commit_sha','external_path')),
  value TEXT NOT NULL, taken_at_commit TEXT);

CREATE TABLE events (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id),
  at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT);
```

- [ ] Test: şema uygulanınca beş tablo da var; ikinci açılış idempotent
- [ ] Test: `status` CHECK'i geçersiz değeri reddediyor (born_invalid/unanchored kabul)
- [ ] `db.ts`: `openStore(path)` → `{db, withTx}`; `node:sqlite` yalnız burada
- [ ] `npm test` yeşil → commit

## Task 3: Projeler ve imleç API'si

**Files:** `core/src/store/projects.ts`, `core/test/projects.test.ts`

**Interfaces — Produces:**
`upsertProject(store, {path, transcriptDir, memoryDir}) → projectId`,
`getCursor(store, projectId, sessionId) → {byteOffset, inode} | null`,
`setCursor(store, projectId, sessionId, {filePath, byteOffset, inode})`

- [ ] Test: aynı yol iki kez upsert → tek satır, aynı id
- [ ] Test: imleç yazılıp okunuyor; yoksa `null`
- [ ] Test: imleç monoton — daha küçük offset yazımı reddedilir (dosya kısaldıysa
      `inode` değişimi gerekir; testte ikisi de kanıtlanır)
- [ ] Commit

## Task 4: findings + anchors, append-only invariantlarıyla

**Files:** `core/src/store/findings.ts`, `core/test/findings.test.ts`

**Interfaces — Produces:**
`appendFinding(store, {projectId, source, content, sourceRef, anchors[]}) → id`,
`supersede(store, oldId, newId)`, `listActive(store, projectId) → Finding[]`

- [ ] Test: **`content` UPDATE edilemiyor** — `updateContent` diye bir API yok ve
      SQL tetikleyicisi doğrudan UPDATE'i reddediyor (invariant testle sabitleniyor)
- [ ] Test: `supersede` eskiyi `superseded` yapıp `superseded_by`'ı bağlıyor;
      `listActive` artık onu döndürmüyor
- [ ] Test: silme API'si yok — `store` yüzeyinde `delete` içeren isim bulunmuyor
- [ ] Test: çapasız bulgu `unanchored` statüsüyle giriyor ve `suspicion` 0 kalıyor (M0-D5)
- [ ] Commit

## Task 5: Denetim günlüğü

**Files:** `core/src/store/events.ts`, `core/test/events.test.ts`

**Interfaces — Produces:** `logEvent(store, {projectId, kind, detail})`,
`listEvents(store, {projectId, kind?, limit?})`

- [ ] Test: olay yazılıyor, `at` ISO-8601 UTC
- [ ] Test: `unknown_line_type` olayı örnek satır parçasıyla loglanabiliyor (spec §3.7)
- [ ] Commit

## Task 6: TranscriptAdapter seam'i + Claude Code süzücüsü

**Files:** `core/src/adapters/transcript.ts`, `core/src/adapters/claude-code.ts`,
`core/test/claude-code-parse.test.ts`, `core/test/fixtures/*.jsonl`

**Interfaces — Produces:**
```ts
interface TranscriptAdapter {
  readonly id: string;                       // "claude-code"
  discover(): Promise<DiscoveredProject[]>;  // proje + oturum listesi
  parseLine(line: string): ParseResult;      // turn | skip | unknown
}
type ParseResult =
  | {kind: "turn"; turn: Turn}
  | {kind: "skip"}                            // bilinen ama bulgusuz tip
  | {kind: "unknown"; lineType: string}       // events'e loglanır
  | {kind: "malformed"; sample: string};
```

Süzme kuralı (ölçüme dayalı): yalnız `type` ∈ {`user`,`assistant`}; içerikte
`text` blokları tam, `tool_use` yalnız `[araç: <ad>]` başlığı; `thinking`,
`tool_result`, `image`, `document`, `fallback` atılır. `content` string ise aynen alınır.

- [ ] Test: her blok tipi için bir fixture satırı — çıktı beklenen metni veriyor
- [ ] Test: `tool_result` satırı `skip` dönüyor (gövde ASLA çıktıda değil)
- [ ] Test: 11 gerçek satır tipinden 9'u `skip`, `user`/`assistant` `turn`
- [ ] Test: uydurma `type` → `unknown` + lineType raporlanıyor
- [ ] Test: bozuk JSON → `malformed`, çağıran çökmüyor
- [ ] Test: boş çıktı veren turn (yalnız thinking içeren assistant) turn üretmiyor
- [ ] Commit

## Task 7: Artımlı okuyucu (bayt imleci, yarım satır)

**Files:** `core/src/adapters/claude-code.ts` (readIncremental), `core/test/incremental.test.ts`

- [ ] Test: dosyaya 3 satır yaz → oku → imleç sonda; 2 satır daha ekle → yalnız yeni 2'si
- [ ] Test: **yarım satır** — son satır `\n` ile bitmiyorsa o satır işlenmez ve
      imleç onun başında kalır; `\n` gelince tam işlenir (spec §3.3)
- [ ] Test: dosya küçüldü/yerine yenisi kondu (inode değişimi) → imleç sıfırlanır ve
      `truncation_detected` olayı loglanır
- [ ] Test: 245 MB'lık dosya senaryosu için bellek sınırı — akış okuması, tam dosya
      belleğe alınmıyor (fixture: 50k satırlık üretilmiş dosya, `--max-old-space-size` düşük)
- [ ] Commit

## Task 8: Proje keşfi

**Files:** `core/src/adapters/claude-code.ts` (discover), `core/test/discover.test.ts`

- [ ] Test: sahte bir `projects/` ağacından proje listesi çıkıyor; her projede
      oturum dosyaları listeleniyor
- [ ] Test: dizin-anahtarı → gerçek yol çözümü (`-Users-x-Documents-y` → `/Users/x/Documents/y`)
      ve **çözülemeyen anahtar** (ör. `ı` bozulması, M0'da gerçek vaka) `unresolved`
      olarak işaretlenip atlanmıyor, olayla raporlanıyor
- [ ] Test: `memory/` dizini varsa yakalanıyor, yoksa `null`
- [ ] Commit

## Task 9: Tarama döngüsü + CLI + gerçek veri doğrulaması

**Files:** `core/src/scan.ts`, `core/src/cli.ts`, `core/test/scan.test.ts`

- [ ] Test: uçtan uca sahte ağaç — `scanOnce()` projeleri kaydediyor, turn'leri
      süzüyor, imleçleri ilerletiyor, olayları yazıyor
- [ ] Test: ikinci `scanOnce()` sıfır yeni turn döndürüyor (idempotent)
- [ ] `cli.ts`: `context-police scan --once [--dir <path>]`, özet basıyor
- [ ] **Çıkış kapısı (gerçek veri):** GaMachine silosunda `--once` koşulur; beklenen
      ~16.092 turn ve ~31× küçülme raporlanır, `git status` temiz kalır, depoya
      yazılan satır sayıları basılır
- [ ] Commit

---

## M1 tamamlanma ölçütü

1. `npm test` ve `npm run typecheck` yeşil.
2. Gerçek 64 transcript'lik silo tek komutla taranıyor, çökme yok.
3. İkinci tarama sıfır iş yapıyor (imleç kalıcılığı kanıtlı).
4. Bilinmeyen satır tipleri sessizce yutulmuyor — `events`'te sayılabiliyor.
5. `node:sqlite` importu tek dosyada (`grep -rl "node:sqlite" src/` → 1 sonuç).
