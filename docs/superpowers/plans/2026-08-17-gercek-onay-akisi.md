# Gerçek Onay Akışı V1 — Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Controller (ana oturum) denetmen; kod Opus lane'lerinde (Burak'ın 17 Ağu talimatı).

**Goal:** Onayla/Reddet kararının depoya gerçekten yazılması; mock sessionStorage akışının sökülmesi.

**Architecture:** Yazma tek modüle hapsedilir (`serve/review-write.ts`, istek başına aç/kapa); sorgu katmanı `ReadStore`'da kalır; HTTP ince adaptördür (Tauri'ye taşınabilir çekirdek). Red bastırması audit tarafında kanıt parmak iziyle.

**Tech Stack:** Node ≥24, sıfır runtime bağımlılık, node:sqlite, vanilla ES modules, node --test.

**Spec:** docs/superpowers/specs/2026-08-17-gercek-onay-akisi-design.md

## Global Constraints

- Subagent'lar ASLA git yazma komutu koşmaz (add/commit/checkout/stash/reset/push); controller commit'ler.
- `~/.context-police/`'e ve var olan `docs/olcumler/altin-set/golden-*.jsonl`'e dokunulmaz.
- Kod/identifier/yorum İngilizce; UI ve CLI kullanıcı metinleri Türkçe. Yorum yalnız kodun söyleyemediğini taşır.
- Şema değişikliği = `migrate()` aynı commit'te + VAR OLAN depo kopyasına karşı test (CLAUDE.md §7; canlı depoya dokunmadan `core/test`teki mevcut migration-fixture kalıbıyla).
- Her görev sonunda `cd core && npm test` + `npm run typecheck` yeşil; sayılar rapor edilir.
- Yeni test en az bir kez çürütülerek doğrulanır (kod geri alınıp kırmızı görülür).

---

### Task 1: Kanıt parmak izi + red bastırması (store/audit tarafı)

**Files:**
- Modify: `core/src/store/schema.sql` (verdicts'e `evidence_fingerprint TEXT` kolonu)
- Modify: `core/src/store/db.ts` (`migrate()` yolu: kolon yoksa ALTER TABLE)
- Modify: `core/src/store/verdicts.ts` (yaratmada fingerprint parametresi; `findLastRejected(store, findingId, reason)` sorgusu)
- Modify: hüküm YARATAN audit yolu (`core/src/audit.ts` ya da `signals/classify.ts` çıkışı — yaratma noktasını bul, tek yerden geçir)
- Test: `core/test/verdicts.test.ts`, yeni `core/test/review-suppression.test.ts`

**Interfaces:**
- Produces: `computeEvidenceFingerprint(input: {reason: string; claimText?: string; anchorStates?: string[]}): string` — sha256 hex, girdi alanları alfabetik ve ayraçlı serileştirilir (kararlılık testli). Yaratma API'si fingerprint'i zorunlu almaz (NULL geçmiş satırlar meşru).
- Produces: yaratma noktasında kural — aynı `(finding_id, reason)` için son REDDEDİLMİŞ hükmün fingerprint'i yeni hesaplananla eşitse: hüküm yaratılmaz, `verdict_suppressed` event'i (payload: finding_id, reason, fingerprint) aynı tx'te düşülür. `approved` asla bastırmaz. Fingerprint NULL (eski satır) ise bastırma uygulanmaz.

**Steps:** failing test (aynı parmak izi → yaratılmaz + event; değişen kanıt → yaratılır; approved bastırmaz; NULL-fingerprint eski satır bastırmaz) → kırmızı gör → uygula → yeşil → migration testi VAR OLAN depo kopyasıyla (verdicts tablolu eski kopya; `DROP TABLE` hilesi değil, kolon-yokken-aç senaryosu) → yeşil → rapor.

### Task 2: HTTP metot ayrımı + POST /review + kuyruk semantiği (serve tarafı)

**Files:**
- Create: `core/src/serve/review-write.ts`
- Modify: `core/src/serve/serve.ts` (metot dispatch; 405; OPTIONS'a cevap yok)
- Modify: `core/src/serve/api.ts` (bekleyen = `review IS NULL AND superseded = 0` dışlaması; sayım mutabakatı)
- Test: `core/test/serve-http.test.ts`, `core/test/serve-api.test.ts`, yeni `core/test/review-write.test.ts`

**Interfaces:**
- Produces: `applyReview(storePath: string, verdictId: number, decision: "approved"|"rejected"): ReviewResult` — içeride `openStore` aç/kapa; `ReviewResult = {ok:true, row} | {ok:false, code:"not_found"|"already_decided"|"superseded"|"store_missing"}`. HTTP'den bağımsız, Tauri IPC'nin çağıracağı çekirdek bu.
- Produces: `POST /api/verdicts/:id/review` gövde `{"decision":...}`; 200/400/403(başlıksız)/404/405/409; `X-CP-Review: 1` zorunlu; storeMissing → 409.
- Consumes: Task 1'in şeması (fingerprint kolonu) — ama çalışması ona bağlı değil; yalnız SELECT'ler kolonu görmezden gelir.
- Sayım mutabakatı: kuyruk cevabında `total === pending + decided + superseded` doğrulanmadan dönmez; tutmazsa 500 + açıklayıcı gövde.

**Steps:** failing testler (mutlu yol; her hata kodu; audit benzeri ikinci yazar bağlantı açıkken review'un WAL/busy_timeout ile tamamlanması; mutabakat kasıtlı bozukta 500) → uygula → yeşil → çürütme notu → rapor.

### Task 3: Frontend — mock söküm, gerçek POST (Task 2 + sembol-C commit'inden SONRA)

**Files:**
- Modify: `core/web/js/ui.js` (`reviewControls` POST'a döner; `MOCK_REVIEW_KEY`/`mockReviewGet/Set` silinir)
- Modify: `core/web/js/project.js`, `core/web/js/detail.js` (çağıran taraf; rozet: kararlı hüküm mevcut render'da kalır)
- Modify: `core/web/js/api.js` (POST yardımcısı, `X-CP-Review` başlığı)
- Test: `core/test/serve-http.test.ts`e uçtan uca bir POST-üzerinden-statik-app senaryosu değil — web JS test altyapısı yok; kabul, elle duman + endpoint testleri (Task 2) üzerinden.

**Interfaces:**
- Consumes: Task 2'nin endpoint sözleşmesi birebir.
- Hata UX'i: ağ/409 halinde karar düşmez, buton eski halinde, tek satır Türkçe açıklama. "Önizleme — kararlar henüz kaydedilmiyor" notu kalkar.

**Steps:** uygula → `npm test`+typecheck yeşil → controller elle duman turu (serve aç, gerçek onay, ekran tazelenmesi, sicil rozeti) → rapor.

---

**Sıralama/paralellik:** Task 1 ∥ Task 2 (dosya kümeleri ayrık; ikisi de HEAD'den başlar). Task 3 ikisi ve sembol-C commit'lendikten sonra (ui.js kesişimi).
**Final:** bütün-dal incelemesi (en yetkin model) → düzeltme turu → controller commit'leri → Burak'a duman turu.
