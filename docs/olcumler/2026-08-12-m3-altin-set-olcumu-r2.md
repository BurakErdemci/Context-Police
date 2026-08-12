# M3 Çıkış Kapısı — Altın Set Ölçümü, 2. Tur

**Tarih:** 2026-08-12
**Ölçülen:** 1. turun (2026-08-11) dört yapısal bulgusuna karşı yazılan düzeltmelerden
sonra altın setin YENİDEN koşulması. Aynı hakem, aynı pin'ler, aynı eşik.
**Pin'ler:** çalışma ağacı `b4065f1`, origin ref `19c623f` (`--no-fetch`).
**Denek:** GaMachine, salt-okunur worktree `/tmp/cp-m3-golden`; hafıza anlık görüntüsü
`~/.context-police/golden/2026-08-11-gamachine` (28 not, repo dışı — D-M3-8).
**Ölçüm deposu:** `/tmp/cp-m3-olcum-r2/olcum.db` + `sonuc.json`.
**Karşılaştırma zemini:** `docs/olcumler/2026-08-11-m3-altin-set-olcumu.md` (1. tur).
**Hakem:** `docs/olcumler/2026-08-10-m0-gamachine-retrospektif.md` §2 (17 çürük + 11 geçerli)
ve §4 (başarı skaleri).

İki turun arasına giren dört commit:

| Commit | Düzeltme | 1. turdaki karşılığı |
|---|---|---|
| `4370c49` | Çapa tavanına tür başına kota (`PER_KIND_QUOTA = 6`) | §7 öneri 1 |
| `d0d87f8` | Girintili frontmatter (`metadata:` altındaki `modified`) okunuyor | §7 öneri 6 |
| `58f7d97` | `never_existed` demeden önce sonek çözümlemesi (`git ls-files`) | §7 öneri 3 |
| `b339054` | Sınıflama bütçesine yüzey kotası (`cross 8 / intra 6 / frontmatter 6`) | §7 öneri 5 |

Uygulanmayan iki öneri: `SYMBOL_RE`'nin daraltılması (öneri 2) ve `never_existed`
ağırlığının düşürülmesi (öneri 4). Eşik yine **0,6**, değiştirilmedi (öneri 7).

Bu bir ÖLÇÜM raporudur. Hedef tutturma yok; sayılar yuvarlanmadı.

---

## 0. Canlı Codex koşumu doğrulandı

| Ölçü | 1. tur | 2. tur |
|---|---|---|
| `classifyCalls` | 1 | **1** |
| `classify_failed` olayı | yok | **yok** |
| `classified` | `true` | **`true`** |
| `measurementFailures` | — | **0** |

**Model:** `core/src/adapters/codex.ts` içinde **sabit kodlanmış varsayılan model yok** —
`-m` bayrağı yalnız `CodexOptions.model` verilirse ekleniyor (`codex.ts:162`), ve
`cli.ts:246-256` bunu yalnız `--model` geçilirse dolduruyor. Bu koşumda `--model`
geçilmediği için etkin model **Codex'in kendi yapılandırma varsayılanı**:
`~/.codex/config.toml` → `model = "gpt-5.6-sol"`, `model_reasoning_effort = "high"`.

**Şerh:** depo, koşumda kullanılan model adını kaydetmiyor; yukarıdaki çıkarım kod
yolundan + config'ten, `sonuc.json`'dan değil. Etkin modelin doğrudan izi ölçülemedi.

Bunun ikinci anlamı: **dünkü `serverOverloaded` bugün üremedi.** Sol yapılandırma
varsayılanıyken tek sınıflama çağrısı hatasız döndü, `classify_failed` yok.

---

## 1. Ana sayılar — 1. tur / 2. tur

| Ölçü | 1. tur | 2. tur | Fark |
|---|---|---|---|
| **Yakalama** — 17 çürük nottan `suspect` | 3 / 17 (%17,6) | **5 / 17 (%29,4)** | **+2** |
| **Yanlış alarm** — 11 geçerli nottan `suspect` | 2 / 11 (%18,2) | **1 / 11 (%9,1)** | **−1** |
| Doğru temiz | 9 / 11 | **10 / 11** | +1 |
| Denetlenen not | 28 | 28 | — |
| Toplam `suspect` | 5 | 6 | +1 |
| **Onaylanan çelişki** | 0 | **1** | **+1** |
| Toplam çapa | 260 | 260 | — |
| Çelişki adayı / atılan | 69 / 49 | 67 / 47 | −2 / −2 |

Eşik `0,6` (M0 §5 kalibrasyonu), değiştirilmedi.

Skaler ilk kez **iki yönde birden** iyileşti: yakalama %17,6 → %29,4, yanlış alarm
%18,2 → %9,1. Ama hareket net değil — aşağıda görüleceği gibi 4 yeni yakalama
kazanıldı, 2 eski yakalama kaybedildi.

---

## 2. Sinyal kırılımı

| Sinyal (çapa durumu) | 1. tur | 2. tur | Not |
|---|---|---|---|
| `ok` | 207 | 207 | — |
| `unverifiable` | 34 | 35 | nötr (D-M3-7) |
| `never_existed` | 15 | **12** | sonek çözümlemesi 11 çapayı kurtardı |
| `symbol_lost` | 4 | **3** | — |
| `churned` | **0** | **3** | not tarihi düzeltilince ilk kez ateşledi |
| `missing_now` | 0 | **0** | yine hiç ateşlenmedi |
| DURUM-kalıbı | 10 notta | 10 notta | 2'sinde D1 bileşimi açıldı (1. turda 1) |
| Çelişki (onaylanan) | 0 | **1** | ilk kez ateşledi |

Çapa türü dağılımı (tür-başına kotanın doğrudan ölçümü):

| Tür | 1. tur | 2. tur |
|---|---|---|
| `symbol` | 210 (%81) | **177 (%68)** |
| `file_path` | 27 (%10) | **42 (%16)** |
| `commit_sha` | 14 (%5) | **30 (%12)** |
| `external_path` | 9 (%3) | 11 (%4) |
| **0 file_path çapası olan not** | **18 / 28 (%64)** | **14 / 28 (%50)** |

`import_anchor_overflow` yine 7 notta ateşledi; `bekleyen-isler`de 138,
`onay-kapisi-kapsami`nde 83 çapa atıldı — ama bu iki notta artık **6'şar `file_path`
çapası tutuluyor** (1. turda 0'dı).

Not tarihi (girintili frontmatter düzeltmesi): **28 notun 24'ünde gerçek `modified`
tarihi okundu.** Kalan 4 not (`agy-print-mcp-koprusu`, `jarvan-asistan`,
`mcp-derleme-kisir-dongu`, `worktree-kullanimi`) frontmatter'ında **`modified` alanı
hiç taşımıyor** — dosyalar okunarak doğrulandı; bunlarda `created_at` hâlâ import anı.

---

## 3. Not-not eşleşme (M0 §2 tablosuna karşı)

`suspect` olanlar kalın. Skor = `suspicion`, eşik 0,6. "r1" = 1. tur skoru.

| Not | M0 hükmü | r1 | r2 | Sonuç | Tetikleyen sinyal (r2 gerekçe satırlarından) |
|---|---|---|---|---|---|
| **bekleyen-isler** | **çürümüş (tam)** | 0,20 | **1,00** | **YAKALANDI (yeni)** | `never_existed` ×4 + sonek→`churned` + churn 4 commit + DURUM+hareket (M0-D1) |
| **codex-delegate-niyet** | kısmen-çürümüş | 0,20 | **0,80** | **YAKALANDI (yeni)** | `never_existed` ×2 + DURUM (hareketsiz) |
| **masaustu-guven-modeli** | kısmen-çürümüş | 1,00 | **0,70** | **YAKALANDI** | `symbol_lost` (`adoptLegacyRoot`) + `never_existed` ×1 |
| **teslim-yolu-denetim-2** | kısmen-çürümüş | 0,20 | **0,70** | **YAKALANDI (yeni)** | **onaylanan `intra` çelişki** (akış-durumu kalıbı) + DURUM |
| **test-standardi** | kısmen-çürümüş | 0,20 | **0,70** | **YAKALANDI (yeni)** | DURUM + çapa hareketi (M0-D1) — churn penceresi 1–2 commit |
| **indirme-butunlugu-kutugu** | geçerli | 0,60 | **0,60** | **YANLIŞ ALARM** | `never_existed` ×2 (`util/prunetags.sh`, `release-metadata/…/release.json`) |
| unity-mcp-yerel-auth | kısmen-çürümüş | 0,30 | 0,50 | kaçtı | `never_existed` + churn 3 commit |
| windows-acikleri | kısmen-çürümüş | 0,50 | 0,50 | kaçtı | `never_existed` + DURUM (hareketsiz) |
| kritik-acik-tanimi | kısmen-çürümüş | 0,40 | 0,40 | kaçtı | `symbol_lost` (`test_local_token_file`) |
| unity-mcp-fork-atif | geçerli | 0,40 | 0,40 | doğru temiz | `symbol_lost` (`_socketKeepAliveInterval`) |
| custom-tools-cs-eksik | kısmen-çürümüş | **1,00** | **0,30** | **kaçtı (kayıp)** | `never_existed` ×1; 4 çapa sonekle `ok`'a çözüldü |
| kabuk-olcum-tuzaklari | geçerli | 0,20 | 0,20 | doğru temiz | DURUM (hareketsiz) |
| kimi-provider-dogrulanmadi | kısmen-çürümüş | 0,20 | 0,20 | kaçtı | DURUM (hareketsiz) |
| macos-build-mekanigi | geçerli | **0,60** | **0,20** | **doğru temiz (kazanç)** | churn 6 commit; 2 yol sonekle `ok`'a çözüldü |
| onay-kapisi-kapsami | kısmen-çürümüş | 0,20 | 0,20 | kaçtı | 2 yol sonekle `ok`; DURUM (hareketsiz) |
| teslim-yolu-denetimi | kısmen-çürümüş | **0,70** | **0,20** | **kaçtı (kayıp)** | yalnız DURUM (hareketsiz) — r1'in `symbol_lost`'u yok |
| windows-gecisi-tasima | kısmen-çürümüş | 0,20 | 0,20 | kaçtı | DURUM (hareketsiz) |
| agy-print-mcp-koprusu | kısmen-çürümüş | 0,00 | 0,00 | kaçtı | — |
| jarvan-asistan | kısmen-çürümüş | 0,00 | 0,00 | kaçtı | — (tek çapa `external_path` → `unverifiable`) |
| unity-architect-mimari | kısmen-çürümüş | 0,30 | **0,00** | kaçtı | tek `never_existed` sonekle `ok`'a çözüldü |
| unity-mcp-toggle-internet-bagimli | kısmen-çürümüş | 0,30 | **0,00** | kaçtı (**doğru davranış**) | — (M0-D4: satır kayması şüphe üretmemeli) |
| agy-model-secimi | geçerli | 0,00 | 0,00 | doğru temiz | — |
| csharp-zekasi-zinciri | geçerli | 0,00 | 0,00 | doğru temiz | — |
| denetim-kapatma-dersi | geçerli | 0,00 | 0,00 | doğru temiz | — |
| lisans-karari | geçerli | 0,00 | 0,00 | doğru temiz | — |
| mcp-derleme-kisir-dongu | geçerli | 0,00 | 0,00 | doğru temiz | — |
| olcum-subagent-kod-ana-dongu | geçerli | 0,00 | 0,00 | doğru temiz | — |
| worktree-kullanimi | geçerli | 0,00 | 0,00 | doğru temiz | — |

**Yakalanan: 5/17. Kaçan: 12/17. Doğru temiz: 10/11. Yanlış alarm: 1/11.**

Sınırda kalan/eşleşmeyen not yok: anlık görüntüdeki 28 dosya adı M0 §2'nin 28 adıyla
birebir eşleşti, hüküm ataması belirsiz kalan not olmadı.

---

## 4. Onaylanan çelişki — ilk kez ateşledi

`contradiction_confirmed` olayı: `{"kind":"intra","aId":19,"bId":null,"reason":"akış-durumu kalıbı"}`
→ **`teslim-yolu-denetim-2`, not-içi çelişki.**

Altın sete göre **GERÇEK.** Notun kendi metninde:

- Satır 11–13 (DURUM bloğu): *"Denetim KOŞTU ve bulgular doğrulandı; **hiçbir düzeltme
  yapılmadı.**"*
- Satır 37 (aynı notun gövdesi): *"### ✅ KAPATILDI (29 Tem, commit edilmedi) —
  `stale-decision-latch`, (b) maddesi"* — ardından kapatma kanıtı, test sayıları,
  değişen kod anlatılıyor.

İki beyan aynı nottan aynı anda okunamaz. M0 §2 bu notu `kısmen-çürümüş /
durum-bayatladı` sayıyor ve bozan kanıt olarak `728b63e`: *"pushlanmadı/arşivlenmedi"
ölü* diyor — yani çelişkinin oturduğu eksen, hakemin çürük dediği eksenin ta kendisi.

Bu, M0-D3(b)'nin ("not-içi çelişki gerçek bir denetim yüzeyi") sahada ilk mekanik
doğrulaması. 1. turda bu yüzey sınıflamaya **hiç girmiyordu** (`slice(0,20)` hepsini
`cross`'a harcıyordu); yüzey kotası (`intra: 6`) tam bunu açtı.

---

## 5. Yeni yakalananlar — hangi düzeltme sayesinde

| Not | r1 → r2 | Sorumlu düzeltme | Kanıt (gerekçe satırı) |
|---|---|---|---|
| `bekleyen-isler` | 0,20 → 1,00 | **tür-başına çapa kotası** (`4370c49`) + sonek (`58f7d97`) + not tarihi (`d0d87f8`) — üçü birlikte | 1. turda 0 `file_path` çapası vardı, şimdi 6. `providers/workspace_config.py: sonek çözümlendi → Backend/app/providers/workspace_config.py (durum: churned)` + `churn: not tarihinden beri 4 commit` |
| `codex-delegate-niyet` | 0,20 → 0,80 | **tür-başına çapa kotası** | 1. turda 0 `file_path`, şimdi 2 — ikisi de `never_existed` (`skills/codex-delegate/scripts/doctor.py`, `references/lenses.md`) |
| `teslim-yolu-denetim-2` | 0,20 → 0,70 | **sınıflama yüzey kotası** (`b339054`) | tek gerekçe: `çelişki onaylandı (intra: akış-durumu kalıbı)` |
| `test-standardi` | 0,20 → 0,70 | **girintili frontmatter** (`d0d87f8`) | `created_at` artık 2026-07-29 (import anı değil) → churn penceresi açıldı → `DURUM-kalıbı + çapa hareketi (M0-D1)` |

**`bekleyen-isler` 1. turun en keskin kaçağıydı** (tek "tam çürük" not, skor 0,20) ve
şimdi 1,00. 1. tur §5.1'in ismen işaret ettiği çapa — `providers/workspace_config.py`,
"churn'ün yakalayacağı ama `HEAD`/`grep` sembollerine yer açmak için atılan çapa" —
bu turda tutuldu, sonekle çözüldü ve **gerçekten `churned` döndü.** Öngörü ölçümle
doğrulandı.

**Şerh — `codex-delegate-niyet` doğru hüküm, kırılgan sebep.** İki `never_existed`
yolu GaMachine deposunun kapsamı dışında (codex-delegate skill dosyaları). Bu iki yol
`~/.claude` altında da bulunamadı (`find` ile ölçüldü, sonuç boş) — yani dosyalar
gerçekten yok; ama notu suçlayan sinyal **depo yüzeyinden gelen bir kanıt değil**,
kapsam-dışı bir yolun repoda bulunamaması. M0'ın bu nota verdiği çürüme sebebi
(`9c51f71+a6adb04`: "yazılmadı" denen 5 madde SKILL.md'de) bambaşka bir eksen.
Yakalama sayılır, ama sağlam bir yakalama değil.

---

## 6. Kaybedilen iki yakalama

### 6.1 `custom-tools-cs-eksik`: 1,00 → 0,30 — sonek çözümlemesi doğuştan-yanlış yüzeyi sildi

1. turda bu notun skorunu 5 `never_existed` üretmişti. 2. turda 4'ü sonekle çözüldü:

```
services/tools/execute_custom_tool.py → unity-mcp/Server/src/services/tools/execute_custom_tool.py (ok)
services/resources/custom_tools.py    → unity-mcp/Server/src/services/resources/custom_tools.py (ok)
Editor/Constants/EditorPrefKeys.cs    → unity-mcp/MCPForUnity/Editor/Constants/EditorPrefKeys.cs (ok)
Editor/Windows/EditorPrefs/EditorPrefsWindow.cs → unity-mcp/MCPForUnity/…/EditorPrefsWindow.cs (ok)
```

Kalan tek `never_existed` (`unity-mcp/Server/services/custom_tool_service.py`) → 0,30.

**Bu bir gerileme değil, sinyalin doğru yerine oturması.** 1. tur §5.2 tam bu dört
yolun "yol-yazım artefaktı, çürüme kanıtı değil" olduğunu ölçmüştü. M0'ın bu nota
verdiği çürüme tipi ise `(doğuştan-yanlış yol)` — yani notu çürüten şey, sonek
çözümlemesinin bilerek sildiği yüzeyin **kendisi**. Sonuç: `born_invalid` sınıfı
(M0-D2) `never_existed` üzerinden vekâleten yakalanamıyor; kendi tespitini istiyor.

### 6.2 `teslim-yolu-denetimi`: 0,70 → 0,20 — r1'in `symbol_lost`'u kayboldu

2. turdaki tek gerekçe satırı `DURUM-kalıbı (hareketsiz: tek başına eşik altı)`.
1. turda skoru açan `symbol_lost` bu turda **yok**. Notun 16 çapası: 13 `symbol` +
3 `commit_sha`, **0 `file_path`** — tür-başına kota `file_path` üretemedi çünkü notta
çıkarılabilir yol yok; kota ise `commit_sha` payını 3'e çıkarıp sembol havuzunu
daralttı. `symbol_lost` toplamı da 4 → 3'e düştü.

Kaybın ikinci yüzü daha ağır: M0-D3(c)'nin ismen örnek verdiği **frontmatter↔gövde
çelişkisi tam bu not** (description "düzeltme YAPILMADI" derken gövde "12'si de
KAPATILDI"). Yüzey kotası `frontmatter: 6` tanımlandı ama bu çelişki **yine
onaylanmadı** — 67 adayın 47'si hâlâ atılıyor.

---

## 7. Hâlâ kaçan 12 notun tek tek durumu

| Not | M0 çürüme tipi | r2 | Neden hâlâ eşik altı (gerekçe satırlarından) |
|---|---|---|---|
| unity-mcp-yerel-auth | durum-bayatladı | 0,50 | `never_existed`(0,3) + churn 3 commit(0,2) = 0,50 — **eşiğin 0,1 altı**. DURUM kalıbı eşleşmedi. |
| windows-acikleri | durum-bayatladı | 0,50 | `never_existed`(0,3) + DURUM hareketsiz(0,2). `never_existed` "hareket" sayılmadığı için (`anchor-drift.ts:178`) D1 bileşimi açılmıyor — **1. turla birebir aynı, düzeltilmedi.** |
| kritik-acik-tanimi | durum-bayatladı | 0,40 | Tek `symbol_lost`. M0-D3(b)'nin not-içi çelişkisi (üst vs alt blok) `intra` kotasına rağmen onaylanmadı. |
| custom-tools-cs-eksik | doğuştan-yanlış yol | 0,30 | §6.1 — çürüten yüzey sonekle silindi. |
| onay-kapisi-kapsami | durum-bayatladı | 0,20 | Artık 6 `file_path` çapası var (1. turda 0) ama **hepsi `ok`, churn 0**. Not 30 Tem, pin'ler 30 Tem — pencere boş. |
| teslim-yolu-denetimi | durum-bayatladı | 0,20 | §6.2 — 0 `file_path`, `symbol_lost` yok, frontmatter çelişkisi onaylanmadı. |
| kimi-provider-dogrulanmadi | ölçüm-geçersizleşti | 0,20 | Sayısal iddia ("82 test" → 824) hiçbir mekanik sinyalin yüzeyi değil. Yalnız hakem yakalayabilir. |
| windows-gecisi-tasima | durum-bayatladı | 0,20 | 0 `file_path` (2 sembol + 1 sha). DURUM tek başına. |
| agy-print-mcp-koprusu | karar-tersine-döndü | 0,00 | Gerekçe satırı boş. Notun frontmatter'ında `modified` yok → `created_at` import anı → churn penceresi ölü. Ayrıca bozan commit `e061846` notun yazımından önce. |
| jarvan-asistan | dosya-silindi | 0,00 | Tek çapa `external_path` → `unverifiable`, D-M3-7 gereği nötr. Repo-dışı çapa v1 kapsamı dışı (M0-D6). |
| unity-architect-mimari | dosya-silindi + karar | 0,00 | 1. turdaki tek `never_existed` sonekle `ok`'a çözüldü → 0,30'dan düştü. M0'ın saydığı 7 çökmüş iddianın silinen dosyaları çapa olarak hiç çıkmamış. |
| unity-mcp-toggle-internet-bagimli | ölçüm-geçersizleşti | 0,00 | **Doğru davranış** — M0 "3/3 satır çapası kaymış ama İÇERİK ayakta" diyor; M0-D4'ün teyidi. |

**Örüntü değişti.** 1. turda 14 kaçağın 7'si "hiç `file_path` çapası yok" sınıfındaydı;
2. turda 12 kaçağın **3'ü** bu sınıfta (`teslim-yolu-denetimi`, `windows-gecisi-tasima`,
ve kısmen `kritik-acik-tanimi`). Çapa girdisi düzeldi; darboğaz **kayan** yerlere geçti:
churn penceresinin dar olması (2), eşiğin 0,1 altında takılma (2), sınıflama bütçesi (2),
kapsam dışı yüzey (2), yalnız-anlamsal (1), doğru davranış (1).

---

## 8. Kalan yapısal sebepler

### 8.1 Sınıflama bütçesi hâlâ adayların %70'ini atıyor

`candidates = 67`, `classifyDropped = 47` (%70,1). Yüzey kotası
(`CLASSIFY_SURFACE_QUOTA = {cross: 8, intra: 6, frontmatter: 6}`, `MAX_CLASSIFY_ITEMS = 20`)
`intra` yüzeyini açtı ve **1 gerçek çelişki üretti** — ama M0-D3'ün ismen saydığı üç
saha örneğinden ikisi (`kritik-acik-tanimi` not-içi, `teslim-yolu-denetimi`
frontmatter↔gövde) hâlâ onaylanmadı. Bütçe 20'de sabit kaldığı için kota, yüzeyler
arası **dağılımı** düzeltti, **kapsamı** değil.

### 8.2 `never_existed` tek başına hâlâ eşiği deliyor

Kalan tek yanlış alarm (`indirme-butunlugu-kutugu`) tam olarak 0,3 + 0,3 = 0,60 ile
eşiğe oturuyor, başka hiçbir sinyal yok. Sonek çözümlemesi bu sınıfın çoğunu temizledi
(15 → 12 `never_existed`, ve `macos-build-mekanigi` yanlış alarmı düştü) ama ağırlık
düşürülmediği için mekanizma ayakta. Aynı mekanizma bir yakalamayı da (`codex-delegate-niyet`,
§5 şerhi) tek başına taşıyor — yani kural hem kalan yanlış alarmın hem kırılgan bir
yakalamanın kaynağı.

### 8.3 `never_existed` "hareket" sayılmıyor → D1 bileşimi açılmıyor

`anchor-drift.ts:178` gereği `never_existed` `anchorMoved` üretmiyor. `windows-acikleri`
bu yüzden 1. turdaki gibi tam 0,50'de takılı. Karar gerekçeli (hiç var olmamış çapa
gerçekten hareket etmedi) ama sonucu iki turdur aynı notu kaçırmak.

### 8.4 Churn penceresi yapısal olarak dar

Not tarihi düzeltmesi churn'ü **ilk kez çalıştırdı** (`churned` 0 → 3, gözlenen en yüksek
churn 6 commit). Ama pin'ler notların yazılmasından yalnız 0–3 gün sonrasına denk
geliyor: `onay-kapisi-kapsami` 6 `file_path` çapasıyla bile churn 0 aldı çünkü not
30 Tem, depo 30 Tem. Bu **altın setin bir özelliği**, kodun kusuru değil — ama
"churn güçlü sinyal" iddiası bu sette yapısal olarak sınanamıyor.

Yan bulgu: 4 not frontmatter'ında `modified` alanı taşımıyor (dosyalar okunarak
doğrulandı), onlarda `created_at` hâlâ import anı → churn erişilemez.

### 8.5 `SYMBOL_RE` daraltılmadı

Sembol payı %81 → %68'e indi, ama bu kotanın ürünü; `SYMBOL_RE` aynı. 177 sembol
çapası hâlâ `HEAD`, `grep`, `const` sınıfı jenerik tokenları içeriyor ve bunlar
`git grep -F` ile daima `ok` dönüyor — 207 `ok` hükmünün büyük kısmı hâlâ boş teminat.

### 8.6 `missing_now` iki turdur hiç ateşlenmedi

Altın sette **saha doğrulaması yapılmamış** tek çapa durumu. `churned` bu turda
ateşlediği için o borç kapandı; `missing_now` açık.

---

## 9. Şerhler ve sınanmayanlar

- **Karşılaştırma zemini temiz.** Hafıza anlık görüntüsü 1. turla aynı dizin
  (`~/.context-police/golden/2026-08-11-gamachine`), pin'ler aynı (`b4065f1`/`19c623f`),
  eşik aynı (0,6). Değişen tek şey kod.
- **M0 hükümleri hakem sayılıyor.** M0'ın kendi hata payı bu turda da sınanmadı.
- **"Kısmen-çürümüş" ikili sayıldı.** İddia düzeyinde ölçüm yine yapılmadı; bir notun
  kaç iddiasının öldüğü ağırlıklandırılmıyor.
- **Etkin model adı doğrudan ölçülemedi** (§0 şerhi): depo model adını kaydetmiyor,
  çıkarım kod yolu + `~/.codex/config.toml` üzerinden.
- **Worktree temizlenmiş.** `/tmp/cp-m3-golden` rapor yazılırken artık yok
  (`ls` ile ölçüldü) — bu yüzden §5'teki kapsam-dışı yol şerhi depo içinden
  yeniden doğrulanamadı, yalnız `~/.claude` altında arandı.
- **Sınanmayan:** hakem (M4) katmanı; Codex-Claude uyuşmazlık oranı (M0 §5) hâlâ
  ölçülmedi; `missing_now` hâlâ hiç ateşlenmedi.

---

## 10. Kapanış

Dört yapısal düzeltmeden sonra skaler: **yakalama 5/17 (%29,4), yanlış alarm 1/11 (%9,1).**
Bir tur önce 3/17 ve 2/11'di.

Kazanç kompozit: 4 yeni yakalama (çapa kotası 2, sınıflama kotası 1, not tarihi 1) ve
1 yanlış alarm düşüşü (sonek çözümlemesi), karşılığında 2 yakalama kaybı. Kayıpların
ikisi de öğretici: biri (`custom-tools-cs-eksik`) `never_existed`'ın yanlışlıkla
üstlendiği **doğuştan-yanlış** işini geri veriyor — bu iş artık kendi sınıfını
(`born_invalid`, M0-D2) istiyor; diğeri (`teslim-yolu-denetimi`) frontmatter çelişkisinin
hâlâ sınıflamaya girmediğini gösteriyor.

Çelişki sinyali iki turdur ilk kez ateşledi ve **onaylanan tek çelişki gerçek çıktı**
— yanlış onay yok. Churn de ilk kez altın sette çalıştı. Yani 1. turda "yapısal olarak
ölü" denen iki sinyal artık canlı; sıradaki darboğaz çapa çıkarımı değil, **sınıflama
kapsamı ve `never_existed`'ın ağırlığı**.
