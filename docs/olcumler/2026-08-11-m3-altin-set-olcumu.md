# M3 Çıkış Kapısı — Altın Set Ölçümü

**Tarih:** 2026-08-11
**Ölçülen:** M0 altın setinin (28 not) sinyal katmanından geçirilmesi — projenin
başarı skalerinin İLK ölçümü.
**Pin'ler:** çalışma ağacı `b4065f1`, origin ref `19c623f` (`--no-fetch`).
**Denek:** GaMachine (`~/Documents/unityaıPython`), salt-okunur worktree
`/tmp/cp-m3-golden`; hafıza anlık görüntüsü
`~/.context-police/golden/2026-08-11-gamachine` (repo dışı, D-M3-8).
**Ölçüm deposu:** `/tmp/cp-m3-olcum/olcum.db` + `sonuc.json` (göz kontrolü için duruyor).

Bu bir ÖLÇÜM raporudur. Hedef tutturma yok; sayılar yuvarlanmadı.

---

## 0. Canlı Codex koşumu doğrulandı

Mimar şartı: sınıflama gerçekten koşmuş olmalı (M2'de strict-şema hatası yalnız
gerçek koşumda görünmüştü, FakeExecutor gizlemişti).

| Ölçü | Değer |
|---|---|
| `classifyCalls` | **1** (tekrar/düzeltme turu gerekmedi) |
| `classify_failed` olayı | **yok** |
| `classified` | `true` |

Süreçle de teyit edildi: koşum sırasında `codex exec --ephemeral -s read-only
--output-schema …` süreci canlıydı. **Strict şema bu koşumda hata vermedi** —
M2'nin `invalid_json_schema` sınıfı tekrarlamadı. İkincil ölçümde de
`classifyCalls = 1`. Toplam 2 Codex koşumu (bütçe: en kötü 3+3).

---

## 1. Ana sayılar

| Ölçü | Sonuç |
|---|---|
| **Yakalama** — 17 çürük nottan `suspect` olan | **3 / 17 (%17,6)** |
| **Yanlış alarm** — 11 geçerli nottan `suspect` olan | **2 / 11 (%18,2)** |
| Denetlenen not | 28 / 28 (import: +28, hata 0) |
| Toplam `suspect` | 5 |
| Onaylanan çelişki | **0** |
| Toplam çapa | 260 |

Eşik `0.6` (M0 §5 kalibrasyonu), değiştirilmedi.

**Bu düşük yakalama oranı bir başarısızlık değil, M4 için veridir** — ve aşağıdaki
§5'te görüleceği gibi üç yapısal nedeni var, hiçbiri "hakem eksik" değil.

---

## 2. Not-not eşleşme (M0 §2 tablosuna karşı)

`suspect` olanlar kalın. Skor = `suspicion`, eşik 0,6.

| Not | M0 hükmü | Skor | Sonuç | Tetikleyen sinyal |
|---|---|---|---|---|
| **custom-tools-cs-eksik** | kısmen-çürümüş | 1,00 | **YAKALANDI** | `never_existed` ×5 |
| **masaustu-guven-modeli** | kısmen-çürümüş | 1,00 | **YAKALANDI** | `symbol_lost` + `never_existed` ×2 |
| **teslim-yolu-denetimi** | kısmen-çürümüş | 0,70 | **YAKALANDI** | DURUM-kalıbı + `symbol_lost` (M0-D1) |
| **indirme-butunlugu-kutugu** | geçerli | 0,60 | **YANLIŞ ALARM** | `never_existed` ×2 |
| **macos-build-mekanigi** | geçerli | 0,60 | **YANLIŞ ALARM** | `never_existed` ×2 |
| windows-acikleri | kısmen-çürümüş | 0,50 | kaçtı | — |
| kritik-acik-tanimi | kısmen-çürümüş | 0,40 | kaçtı | — |
| unity-mcp-fork-atif | geçerli | 0,40 | doğru temiz | — |
| unity-architect-mimari | kısmen-çürümüş | 0,30 | kaçtı | — |
| unity-mcp-toggle-internet-bagimli | kısmen-çürümüş | 0,30 | kaçtı | — |
| unity-mcp-yerel-auth | kısmen-çürümüş | 0,30 | kaçtı | — |
| bekleyen-isler | **çürümüş (tam)** | 0,20 | kaçtı | — |
| codex-delegate-niyet | kısmen-çürümüş | 0,20 | kaçtı | — |
| kimi-provider-dogrulanmadi | kısmen-çürümüş | 0,20 | kaçtı | — |
| onay-kapisi-kapsami | kısmen-çürümüş | 0,20 | kaçtı | — |
| teslim-yolu-denetim-2 | kısmen-çürümüş | 0,20 | kaçtı | — |
| test-standardi | kısmen-çürümüş | 0,20 | kaçtı | — |
| windows-gecisi-tasima | kısmen-çürümüş | 0,20 | kaçtı | — |
| kabuk-olcum-tuzaklari | geçerli | 0,20 | doğru temiz | — |
| agy-print-mcp-koprusu | kısmen-çürümüş | 0,00 | kaçtı | — |
| jarvan-asistan | kısmen-çürümüş | 0,00 | kaçtı | — |
| agy-model-secimi | geçerli | 0,00 | doğru temiz | — |
| csharp-zekasi-zinciri | geçerli | 0,00 | doğru temiz | — |
| denetim-kapatma-dersi | geçerli | 0,00 | doğru temiz | — |
| lisans-karari | geçerli | 0,00 | doğru temiz | — |
| mcp-derleme-kisir-dongu | geçerli | 0,00 | doğru temiz | — |
| olcum-subagent-kod-ana-dongu | geçerli | 0,00 | doğru temiz | — |
| worktree-kullanimi | geçerli | 0,00 | doğru temiz | — |

Doğru temiz: 9/11. Yakalanan: 3/17. Kaçan: 14/17.

---

## 3. Sinyal kırılımı — hangi sinyal ne üretti

| Sinyal (çapa durumu) | Adet | Skora katkısı | Yakalamaya katkısı |
|---|---|---|---|
| `ok` | 207 | — | — |
| `unverifiable` | 34 | 0 (nötr, D-M3-7) | — |
| `never_existed` | 15 | 0,3 / çapa | 2 yakalama + **2 yanlış alarmın tamamı** |
| `symbol_lost` | 4 | 0,4 / çapa | 2 yakalama |
| `missing_now` | **0** | 0,5 / çapa | **hiç ateşlenmedi** |
| `churned` | **0** | 0,2–0,3 | **hiç ateşlenmedi** |
| DURUM-kalıbı (10 notta) | 10 | +0,2 ya da 0,7 | 1 yakalama |
| Çelişki (onaylanan) | **0** | 0,7 | **hiç ateşlenmedi** |

**Altı çapa durumundan yalnız ikisi (`never_existed`, `symbol_lost`) skor üretti.**
Tasarımın en güçlü sayılan iki sinyali — churn ve çelişki — bu koşumda sıfır
katkı verdi. DURUM-kalıbı 10 notta eşleşti ama 9'unda "hareketsiz" sayıldığı için
yalnız +0,2 verdi; M0-D1'in "DURUM + hareket = 0,7" bileşimi **tek notta** açıldı
(o da churn'den değil, tesadüfi bir `symbol_lost` sayesinde).

---

## 4. Kaçanların tek tek analizi (14 not)

| Not | M0 çürüme tipi | Skor | Hangi sinyal eksikti |
|---|---|---|---|
| bekleyen-isler | durum-bayatladı (TAM) | 0,20 | **0 file_path çapası.** 154 çapa çıkarıldı, 138'i atıldı; kalan 16'sı jenerik sembol (`HEAD`, `grep`, `const`, `detail`, `reason`, `blocked`). Churn yüzeyi yok → DURUM tek başına 0,2. |
| onay-kapisi-kapsami | durum-bayatladı | 0,20 | Aynı sınıf: 83 çapa atıldı, 0 file_path kaldı. |
| codex-delegate-niyet | durum-bayatladı | 0,20 | 0 file_path (7 çapa atıldı). |
| teslim-yolu-denetim-2 | durum-bayatladı | 0,20 | 0 file_path (9 çapa atıldı). |
| test-standardi | karar-tersine-döndü | 0,20 | 0 file_path (4 çapa atıldı). |
| windows-gecisi-tasima | durum-bayatladı | 0,20 | 0 file_path (3 çapanın 2'si sembol). |
| kimi-provider-dogrulanmadi | ölçüm-geçersizleşti | 0,20 | Sayısal iddia ("82 test" → 824) hiçbir mekanik sinyalin yüzeyi değil. Yalnız hakem yakalayabilir. |
| windows-acikleri | durum-bayatladı | 0,50 | `never_existed`(0,3) + DURUM(0,2) = 0,50 — **eşiğin 0,1 altında.** `never_existed` "hareket" sayılmadığı için D1 bileşimi açılmadı. |
| kritik-acik-tanimi | durum-bayatladı | 0,40 | `symbol_lost` tek başına. DURUM kalıbı EŞLEŞMEDİ; M0-D3b'nin not-içi çelişkisi (üst vs alt blok) sınıflamaya hiç girmedi (§5.3). |
| unity-architect-mimari | dosya-silindi + karar | 0,30 | Tek `never_existed`. M0'ın saydığı 7 çökmüş iddianın silinen dosyaları çapa olarak çıkmamış. |
| unity-mcp-yerel-auth | durum-bayatladı | 0,30 | `never_existed`(0,3). Gerçek not tarihiyle churn=3 olsa 0,50 — yine eşik altı. |
| unity-mcp-toggle-internet-bagimli | ölçüm-geçersizleşti | 0,30 | M0 zaten "3/3 satır çapası kaymış ama İÇERİK tamamen ayakta" diyor. **Düşük skor burada DOĞRU davranış** — M0-D4'ün (satır kayması şüphe üretmemeli) teyidi. |
| jarvan-asistan | dosya-silindi | 0,00 | Tek çapası `external_path` (`~/Documents/JARVAN`) → `unverifiable`, D-M3-7 gereği nötr. M0-D6'nın "repo-dışı çapa gerçek" uyarısı v1'de kapsam dışı; bu notun çürümesi tam olarak orada. |
| agy-print-mcp-koprusu | karar-tersine-döndü | 0,00 | Bozan commit `e061846` (11 Tem) not tarihinden ÖNCE → churn penceresi dışı. Kararın tersine dönmesi kod yüzeyinde çapa hareketi bırakmıyor. |

**Örüntü:** 14 kaçağın **7'si** doğrudan "notun hiç file_path çapası yok" sınıfında;
2'si eşiğin 0,1–0,2 altında; 2'si yalnız anlamsal (hakem işi); 1'i doğru davranış;
2'si kapsam dışı yüzey (repo-dışı çapa, pencere öncesi commit).

---

## 5. Kök nedenler — üç yapısal bulgu

### 5.1 Çapa tavanı file_path'leri sembollere kurban ediyor

`ANCHOR_PRIORITY = ["symbol", "file_path", "commit_sha", "external_path"]` ve
`MAX_ANCHORS_PER_NOTE = 16`. M0-D4 sembolü *skor gücünde* öne koymuştu; bu sıra
bir **tavana** uygulanınca semboller file_path'leri kuyruktan atıyor.

Ölçüm:

| | Adet | Oran |
|---|---|---|
| `symbol` çapa | 210 | %81 |
| `file_path` çapa | 27 | %10 |
| `commit_sha` | 14 | %5 |
| `external_path` | 9 | %3 |
| **0 file_path çapası olan not** | **18 / 28** | **%64** |

`import_anchor_overflow` 7 notta ateşlendi; `bekleyen-isler`de **138 çapa atıldı**,
`onay-kapisi-kapsami`nde 83. `bekleyen-isler`in atılan çapaları arasında
`providers/workspace_config.py` var — ve o notun 12 commit'lik penceresinde
`Backend/app/providers/workspace_config.py` **gerçekten değişmiş**. Yani churn'ün
yakalayacağı çapa, `HEAD` ve `grep` sembollerine yer açmak için atılmış.

`SYMBOL_RE` (`` `[A-Za-z_$][\w$]{3,}` ``) her backtick'li 4+ karakterli sözcüğü
sembol sayıyor: `HEAD`, `grep`, `const`, `detail`, `reason`, `blocked`, `unityMCP`.
Bunlar `git grep -F` ile her zaman eşleşiyor → `ok` → sıfır şüphe. 210 sembolün
184'ü `ok`; bu "ok"ların büyük kısmı **boş teminat**.

### 5.2 `never_existed` çoğunlukla yol-yazım artefaktı, çürüme kanıtı değil

15 `never_existed` hükmünün **10'u**, repoda **gerçekten var olan** dosyaları
gösteriyor — not yolu kısa/göreli yazdığı için:

| Nottaki yol | Repodaki gerçek yol |
|---|---|
| `services/tools/execute_custom_tool.py` | `unity-mcp/Server/src/services/tools/execute_custom_tool.py` |
| `services/resources/custom_tools.py` | `unity-mcp/Server/src/services/resources/custom_tools.py` |
| `unity-mcp/Server/services/custom_tool_service.py` | `unity-mcp/Server/src/services/custom_tool_service.py` |
| `Editor/Constants/EditorPrefKeys.cs` | `unity-mcp/MCPForUnity/Editor/Constants/EditorPrefKeys.cs` |
| `Editor/Windows/EditorPrefs/EditorPrefsWindow.cs` | `unity-mcp/MCPForUnity/Editor/Windows/EditorPrefs/EditorPrefsWindow.cs` |
| `helpers/ipc-trust.ts` | `Frontend/frontend/main/helpers/ipc-trust.ts` |
| `./fetch_video_bins.sh` | `Backend/vendor/fetch_video_bins.sh` |
| `./build_backend.sh` | `Backend/build_backend.sh` |
| `routes/conversation_routes.py` | `Backend/app/routes/conversation_routes.py` |
| `Packages/manifest.json` | `unity-mcp/TestProjects/*/Packages/manifest.json` |

Kalan 5'i gerçekten repoda yok (`userData/trusted-workspaces.json`,
`util/prunetags.sh`, `release-metadata/10.0/10.0.0/release.json`,
`.delegate-runs/AUDIT/ledger.jsonl`, `workspace/.mcp.json`) — hepsi çalışma-anı,
gitignore'lu ya da upstream dosyası; hiçbiri çürüme kanıtı değil.

Yani **15 `never_existed` hükmünün 15'i de çürümeye dair kanıt taşımıyor**, ama
ikisi bir araya gelince (0,3 + 0,3 = 0,6) eşiği tam olarak deliyor. Her iki yanlış
alarm da tam bu mekanizma.

### 5.3 Sınıflama bütçesi çelişkinin en değerli iki yüzeyini hiç görmüyor

`findCandidates` 69 aday üretti; `classifyCandidates` `candidates.slice(0, 20)`
uyguladı → **49 aday (%71) atıldı.**

Aday üretim sırası: önce tüm `cross` (31), sonra `intra` (10), sonra `frontmatter`
(28). Dilim ilk 20'yi aldığı için **hepsi `cross`**. Sonuç: M0-D3'ün saha örneği
verdiği iki yüzey — not-içi (`bekleyen-isler` satır 117 vs 156;
`kritik-acik-tanimi` üst vs alt blok) ve frontmatter↔gövde
(`teslim-yolu-denetimi` description'ı "YAPILMADI" derken gövde "KAPATILDI") —
**sınıflamaya hiç girmedi.** Onaylanan çelişki: 0.

### 5.4 (İkincil) Not tarihi frontmatter'dan okunamıyor

`parseNote` girintili satırları atlıyor; gerçek Claude Code not biçiminde
`modified:` alanı `metadata:` altında **girintili** duruyor. Sonuç: 28 notun
28'inde `noteTimestamp` geri düşüp `created_at`'i **import anı** (2026-08-11)
yazdı. Repo'nun en yeni commit'i 2026-07-30 → `--since=2026-08-11` her çapa için
0 commit → `churned` durumu **erişilemez**.

**Ancak:** karşı-olgu ölçümü yapıldı (gerçek `modified` tarihleriyle churn yeniden
hesaplandı, kod değiştirilmeden). Sonuç **yakalama ve yanlış alarmı değiştirmiyor**
— aynı 5 not `suspect` kalıyor; yalnız `macos-build-mekanigi` 0,60 → 0,80 ve
`unity-mcp-yerel-auth` 0,30 → 0,50 (yine eşik altı) oluyor. Sebep: pin'ler notların
yazılmasından yalnız 0–3 gün sonrasına denk geliyor **ve** notların %64'ünde churn
sayılacak file_path çapası zaten yok (§5.1). Yani bu kusur gerçek ama **bu ölçümdeki
düşük yakalamanın açıklaması değil** — asıl neden §5.1.

Churn mekanizmasının kendisi sağlam: ikincil ölçümde (§6) `churned = 4` ateşlendi.

---

## 6. İkincil ölçüm — M2'nin 38 gözlemlenmiş bulgusu

`/tmp/cp-m2-olcum/olcum.db` diskteydi; `audit --project "…/Context Police"
--no-fetch` koşuldu. `classifyCalls = 1`, `classify_failed` yok.

| Ölçü | Değer |
|---|---|
| Denetlenen bulgu | 34 (+2 superseded, +2 unanchored) |
| `suspect` | 1 |
| Çapa: `ok` / `churned` / `never_existed` / `unverifiable` | 29 / 4 / 2 / 7 |
| Çelişki adayı / atılan / onaylanan | 11 / 0 / 0 |

**Uydurma çapa borcunun ölçümü:** 36 `file_path` çapasının **2'si** (%5,6)
`never_existed` — `core/__tests__` ve `core/docs`. İkisi de repoda **gerçekten yok**
(gözlemcinin uydurduğu dizin yolları). Yani burada `never_existed` **doğru
çalışıyor**. 7 `external_path` → `unverifiable` (nötr, doğru); içlerinde
`https://github.com/…` URL'i ve çıplak `task-5-report.md` gibi çıkarım gürültüsü var
ama skora dokunmuyorlar.

**Karşıtlık öğretici:** aynı `never_existed` kuralı, gözlemcinin ürettiği
repo-köküne-göreli yollarda %100 isabetli, elle yazılmış hafıza notlarının kısa
yollarında %67 hatalı (§5.2). Sorun kuralda değil, **yolun kaynağında.**

---

## 7. Ölçüme dayalı öneriler

Sırayla, beklenen etkisiyle:

1. **Çapa tavanı sırasını ters çevir (en yüksek etkili).** `file_path` tavanda
   `symbol`'den önce gelmeli, ya da tavan tür başına ayrılmalı (ör. 8 sembol +
   8 yol). Ölçüm: 18/28 notta file_path çapası yok, ve en az bir notta atılan
   çapa penceresinde gerçekten değişmiş. Bu düzeltilmeden churn ve `missing_now`
   sinyalleri notların çoğunda **yapısal olarak ölü.**
2. **`SYMBOL_RE`'yi dar alt.** 4+ karakterli her backtick'li sözcük sembol
   sayılmamalı; `HEAD`, `grep`, `const`, `detail`, `reason` gibi jenerik tokenlar
   210 sembolün büyük kısmını üretip tavanı dolduruyor ve her zaman `ok` veriyor.
3. **Yolu literal aramadan önce sonek eşle.** `never_existed` demeden önce
   `git ls-files "*<yol>"` denenmeli. Ölçüm: 15 `never_existed`'in 10'u böyle
   çözülür. Çözülenler `ok` olur, yanlış alarmların ikisi de düşer.
4. **`never_existed` tek başına eşiği delmemeli.** Ağırlık 0,3 → ~0,15, ya da
   toplam `never_existed` katkısına 0,5 tavanı. Ölçüm: iki yanlış alarmın
   **ikisi de** tam 0,3+0,3 = 0,60 ile eşiğe oturuyor; başka hiçbir sinyal yok.
   (Not: bu, 1 yakalamayı da — `custom-tools-cs-eksik` — düşürür. Ama o yakalama
   yanlış alarmlarla **aynı kuralın** ürünü, yani sağlam bir yakalama değil.)
5. **Sınıflama bütçesini yüzeye göre paylaştır.** `slice(0,20)` yerine `cross` /
   `intra` / `frontmatter` arasında kota. Ölçüm: 49/69 aday atıldı ve atılanların
   tamamı `intra` + `frontmatter` — M0-D3'ün saha örneği verdiği iki yüzey.
6. **`parseNote` girintili `metadata:` alt alanlarını okusun** (en azından
   `modified`/`created`). Tek başına sayıları değiştirmiyor (§5.4) ama 1 ve 3
   düzeltildikten sonra churn'ün çalışabilmesi buna bağlı.
7. **Eşiği ŞİMDİLİK değiştirme.** 0,6 eşiği bu ölçümde ne yakalamayı ne yanlış
   alarmı belirledi — belirleyen çapa katmanının girdisi. Eşik ayarı 1–3
   düzeltildikten sonra yeniden ölçülmeli, yoksa gürültüye kalibre edilir.

---

## 8. Şerhler ve sınanmayanlar

- **Silo sapması yok.** Anlık görüntüdeki 28 not + `MEMORY.md`, M0 §2 tablosundaki
  28 adla birebir aynı. Tüm not `mtime`'ları ≤ 30 Tem 2026, M0 ölçümü 10 Ağu —
  yani silo M0'dan beri değişmemiş. Karşılaştırma zemini temiz.
- **Windows tazeliği — M0 şerhi devam ediyor.** Windows makinesinde daha taze
  hafızalar olabilir; bu ölçüm yalnız bu diskin fotoğrafı.
- **M0 hükümleri hakem sayılıyor.** Yakalama/yanlış alarm, M0'ın 4 Opus ajanıyla
  ürettiği hükümlere göre. M0'ın kendi hata payı bu ölçümde yeniden sınanmadı.
- **"Kısmen-çürümüş" ikili sayıldı.** 16 not kısmen çürük; bir notun kaç iddiasının
  öldüğü ağırlıklandırılmadı — `suspect` ya da değil. İddia düzeyinde ölçüm
  yapılmadı.
- **Karşı-olgu (§5.4) yeniden koşum değil.** `scoreDrift` aritmetiği ayrı bir
  betikte tekrar uygulandı; kod değiştirilip audit yeniden koşulmadı.
- **Sınanmayan:** hakem (M4) katmanı — bu ölçüm yalnız sinyal katmanı.
  Codex-Claude uyuşmazlık oranı (M0 §5) hâlâ ölçülmedi. `missing_now` ve
  `churned` durumları altın sette hiç ateşlenmediği için **saha doğrulaması
  yapılmamış durumdalar** (ikincil ölçümde `churned` ateşlendi, `missing_now`
  hiç ateşlenmedi).
- **`feedbac` gözlemi:** `SHA_RE` "feedback" sözcüğünün ilk 7 harfini (hepsi hex
  basamağı) commit SHA'sı sanıp 3 sahte `commit_sha` çapası üretti. Zararsız
  (`unverifiable` → nötr) ama çıkarım gürültüsünün bir örneği.

---

## 9. Kapanış

Skaler ilk kez ölçüldü: **yakalama 3/17, yanlış alarm 2/11.** Yakalamanın düşüklüğü
hakem eksikliğinden değil, sinyal katmanının **girdisinden** kaynaklanıyor — notların
%64'ünde denetlenebilir dosya çapası yok, ve skor üreten tek baskın durum
(`never_existed`) örneklerin üçte ikisinde yol-yazım artefaktı. Çelişki ve churn
sinyalleri bu koşumda hiç ateşlenmedi.

Bu, M4'ün hakem tasarımından ÖNCE çapa çıkarımının düzeltilmesi gerektiği anlamına
geliyor: hakem yalnız eşik üstünde koşuyor, ve şu an eşiğin üstüne yanlış sebeplerle
çıkılıyor.
