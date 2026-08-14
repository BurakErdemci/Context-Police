# M4.1 — Maliyet Tavanı Kodda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yürütücü kendi maliyetini (token/tur) görsün ve tavan aşımında çağrıyı KODLA kessin — istemdeki talimat bağlamıyor (ölçüldü, 13 Ağu: "60 sn" talimatına rağmen 3 dk'lık döngü koştu).

**Architecture:** `codex exec` adaptörü `-o` dosyasını KORUYARAK `--json` akışını da açar; `turn.completed.usage` toplanıp `ExecutorResult.usage?` olarak taşınır. Tavanlar (token + tur) akış izlenirken denetlenir; aşımda mevcut `killProcessGroup` ile süreç grubu kesilir ve sonuç, arızadan AYRI bir `capExceeded` alanıyla döner (anchor-drift'in `budgetExhausted` ≠ `measurementFailed` ayrımının aynısı: ölçmemek suçlamaya dönmez).

**Tech Stack:** Node 24, sıfır runtime bağımlılık, `node:test`, TS type-stripping. Yeni bağımlılık YASAK.

## Global Constraints

- Kod/identifier İngilizce, yorum Türkçe. Commit mesajları İngilizce.
- `Co-Authored-By` / "Generated with" / 🤖 commit mesajına GİRMEZ.
- Push YOK — yalnız commit.
- Yeni runtime bağımlılık eklenmez; `node:sqlite` yalnız `db.ts`'te kalır (K12 guard testi `core/test/db.test.ts:91-105` bunu zorluyor).
- `ok:false` iken `output` MUTLAKA boş dize (`core/src/adapters/executor.ts:23` sözleşmesi).
- "usage yok" ≠ "0 token": usage alanı hiç gelmemişse `undefined` kalır, asla 0 yazılmaz (anchor-drift.ts:22-23'teki `commits?` kalıbı).
- Testler `core/test/*.test.ts`; koşum `cd core && npm test`. Her görev sonunda TÜM suite yeşil (dün 411 test).
- Yorum yazma ölçütü: kodun söyleyemediğini taşıyan yorum (gerekçe, ölçüm, kısıt) yazılır; kodu tekrar eden yazılmaz.

---

### Task 1: `ExecutorResult.usage` — yürütücü kendi maliyetini görsün

**Files:**
- Modify: `core/src/adapters/executor.ts` (ExecutorResult'a alan)
- Modify: `core/src/adapters/codex.ts` (`buildExecArgs`, spawn stdio, akış parse)
- Test: `core/test/executor.test.ts` (args sözleşmesi + usage parse), `core/test/audit-m2-exec.test.ts` (fakeCodexBinary güncellenirse)

**Interfaces:**
- Produces:
  ```ts
  export interface ExecutorUsage {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    turns?: number;
  }
  export interface ExecutorResult {
    ok: boolean;
    output: string;        // ok=false iken boş dize (mevcut sözleşme)
    error?: string;
    durationMs: number;
    usage?: ExecutorUsage; // --json akışından; akış gelmezse undefined — ASLA 0 uydurulmaz
  }
  ```

**Adımlar:**

- [ ] **Step 1: Başarısız testleri yaz.** `core/test/executor.test.ts`:
  - `buildExecArgs` deepEqual testlerini yeni sözleşmeye güncelle: mevcut dizinin `-o <outPath>`'ten önce `--json` içermesi beklenir (tam dizi eşitliği korunur, sadece beklenen dizi değişir).
  - Yeni test: `fakeCodexBinary("ok")` stdout'una şu satırları basacak şekilde genişletilir (jsonl):
    `{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":800,"output_tokens":90,"reasoning_output_tokens":40}}` ve iki adet `{"type":"item.completed"}` satırı. Beklenti: `result.usage` = `{inputTokens:1200, cachedInputTokens:800, outputTokens:90, reasoningOutputTokens:40, turns:2}`.
  - Yeni test: sahte binary hiç JSON satırı basmazsa `result.usage === undefined` (0 uydurulmaz).
  - Yeni test: birden çok `turn.completed` gelirse usage alanları TOPLANIR (her tur kendi maliyetini raporlar; prototip son turu alıyordu, ürün toplamı taşımalı — toplam, tavan denetiminin girdisi).
- [ ] **Step 2: Testleri koştur, kırmızıyı gör.** `cd core && npm test`
- [ ] **Step 3: Implementasyon.**
  - `buildExecArgs`: `args.push("--json", "-o", outPath, "-")` biçiminde `--json` ekle (`-o` DURUYOR: son-mesaj dosyası ve "boş dosya = arıza" sözleşmesi `codex.ts:288-291` aynen korunur).
  - `codex.ts` spawn: `stdio: ["pipe", "pipe", "pipe"]` (stdout artık "ignore" değil). stdout satır satır biriktirilir; her satır `JSON.parse` denenir (akışta JSON olmayan satır olabilir — prototipteki gibi try/catch ile atlanır, `tools/altin-set/adjudicate-cost.ts:147-155` referans).
  - `turn.completed.usage` alanları snake_case'ten camelCase'e çevrilip TOPLANIR; `item.completed` sayısı `turns` olur. Hiç `turn.completed` görülmediyse `usage` undefined.
  - stdout backpressure: satır tamponu sınırsız büyümesin — yalnız parse edilen değerler tutulur, ham akış biriktirilmez (bir hakem koşumu ~1,9M token girdi raporluyor; ham akışı RAM'de tutmak gereksiz).
- [ ] **Step 4: Testler yeşil.** `cd core && npm test` — TÜM suite.
- [ ] **Step 5: Commit.** `git add -A core && git commit -m "Carry token usage in ExecutorResult via codex --json stream"`

### Task 2: Tavan — token + tur, aşımda süreç grubu kesilir

**Files:**
- Modify: `core/src/adapters/executor.ts` (istek + sonuç alanları)
- Modify: `core/src/adapters/codex.ts` (akış izlerken denetim + kesme)
- Test: `core/test/executor.test.ts`

**Interfaces:**
- Consumes: Task 1'in `ExecutorUsage` toplama mantığı ve `--json` akış parse'ı.
- Produces:
  ```ts
  export interface ExecutorCaps {
    maxTotalTokens?: number; // input+cached+output+reasoning toplamı üstünden
    maxTurns?: number;
  }
  // ExecutorRequest'e: caps?: ExecutorCaps
  // ExecutorResult'a:
  //   capExceeded?: { kind: "tokens" | "turns"; limit: number; observed: number };
  ```
  Sözleşme: tavan aşımı `ok:false` + `output:""` + `capExceeded` dolu + `error` kısa açıklama; süre aşımı (mevcut `timeoutMs`) İSE eskisi gibi `capExceeded` OLMADAN döner — üç eksen (süre/token/tur) ayrık kalır ki çağıran taraf anchor-drift'in `budgetExhausted`/`measurementFailed` ayrımına eşleyebilsin. usage alanı kesmede de taşınır (o ana kadar toplanan).

**Adımlar:**

- [ ] **Step 1: Başarısız testleri yaz.**
  - Sahte binary "drip" modu: her 50 ms'de bir `turn.completed` satırı basar (usage'lı), toplam 10 tur, aralarda uyur. Test: `caps: { maxTurns: 3 }` → süreç 10 turu bitirmeden ölür, `ok:false`, `capExceeded.kind === "turns"`, `capExceeded.observed >= 3`, `output === ""`, `usage.turns >= 3`.
  - Test: `caps: { maxTotalTokens: 1000 }` ve her tur 600 token raporlar → 2. turda kesilir, `capExceeded.kind === "tokens"`.
  - Test: caps verilmezse davranış Task 1 ile birebir aynı (kesme yok).
  - Test: mevcut timeout testi (`executor.test.ts:119-186` civarı) hâlâ geçer ve timeout sonucu `capExceeded` TAŞIMAZ.
- [ ] **Step 2: Kırmızıyı gör.**
- [ ] **Step 3: Implementasyon.** Akış parse döngüsünde her `turn.completed`/`item.completed` sonrası toplamlar caps ile karşılaştırılır; aşımda mevcut `killProcessGroup` (`codex.ts:56-68`) çağrılır — YENİ öldürme yolu açılmaz, sinyal temizliğiyle (codex.ts:86-151) aynı mekanizma. Kesme bayrağı, `close` handler'ında timeout'la karışmasın diye ayrı tutulur.
- [ ] **Step 4: Tüm suite yeşil.**
- [ ] **Step 5: Commit.** `git commit -m "Enforce per-call token and turn caps in the codex executor"`

### Task 3: Ölçüm aracı tavanı kullansın — 28 notluk yeniden koşum hazır olsun

**Files:**
- Modify: `tools/altin-set/adjudicate-cost.ts`

**Interfaces:**
- Consumes: kavramsal olarak Task 2'nin kesme sözleşmesi (araç `core`'dan import ETMEZ — K12 ve araç/ürün ayrımı korunur; aynı kalıp araca kopyalanır ve bunun bilinçli bir kopya olduğu yorumla belirtilir).

**Adımlar:**

- [ ] **Step 1: `runCodex`'e zaman aşımı + tavan ekle.** Devir borcu kapanıyor (roadmap "Devredilen borçlar" tablosu: "runCodex zaman aşımı yok"). Varsayılanlar CLI bayrağıyla ezilebilir: `--timeout-sec` (varsayılan 600), `--max-turns` (varsayılan 40), `--max-tokens` (varsayılan 2_000_000 toplam). Aşımda süreç grubu öldürülür (spawn `detached:true` + negatif PID kill — üründeki `killProcessGroup` kalıbının kopyası), sonuç satırına `cap: {kind, limit, observed}` yazılır ve o not `olculemez` sayılır.
- [ ] **Step 2: Kuru test.** Ölçüm koşulmaz (kota kararı Burak'ın); bunun yerine araç `node --experimental-strip-types tools/altin-set/adjudicate-cost.ts --help` benzeri argüman-parse yoluyla ve sahte `codex` binary'siyle (PATH önüne konan script) tek notluk kuru koşumla doğrulanır.
- [ ] **Step 3: Commit.** `git commit -m "Add wall-clock, turn and token caps to the adjudication harness"`

---

## Kapsam DIŞI (bilinçli)

- 28 notluk yeniden ölçüm koşumu: Codex kotası dün %28'e düşmüştü; koşum kararı Burak'a sorulacak. (Çıkış ölçütü — yakalama kaybı, %82,2 referans — bu koşumu bekliyor.)
- `auditCostGate`/`SpendBudget`'in token'a genişletilmesi: token en-kötüsü koşum ÖNCESİ bilinemez (keşif raporu madde 3) — token tavanı ön kapı değil kesme olarak yaşar; koşum-toplamı bütçesi hakem ürün koduna girerken (M4.7 sonrası) ele alınır.
- Hakemin ürün koduna taşınması ve `olculemez` hükmünün depoya yazımı (M4.7'nin migration işiyle birlikte).
