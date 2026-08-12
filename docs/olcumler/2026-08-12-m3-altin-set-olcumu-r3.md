# M3 Çıkış Kapısı — Altın Set Ölçümü, 3. Tur (KAPANIŞ)

**Tarih:** 2026-08-12
**Ölçülen:** 2. turun (`ca5c370` raporu) üç aritmetik bulgusuna karşı yazılan tek
commit'ten (`4fa874d`) sonra altın setin ÜÇÜNCÜ kez koşulması. Aynı hakem, aynı
pin'ler, aynı eşik, aynı hafıza anlık görüntüsü.
**Pin'ler:** çalışma ağacı `b4065f1`, origin ref `19c623f` (`--no-fetch`).
**Denek:** GaMachine, salt-okunur worktree `/tmp/cp-m3-golden`; hafıza anlık görüntüsü
`~/.context-police/golden/2026-08-11-gamachine` (28 not, repo dışı — D-M3-8).
**Ölçüm deposu:** `/tmp/cp-m3-olcum-r3/olcum.db` + `sonuc.json`
(runId `2026-08-12T09:31:35.262Z-95222`).
**Karşılaştırma zemini:** `docs/olcumler/2026-08-11-m3-altin-set-olcumu.md` (1. tur),
`docs/olcumler/2026-08-12-m3-altin-set-olcumu-r2.md` (2. tur).
**Hakem:** `docs/olcumler/2026-08-10-m0-gamachine-retrospektif.md` §2 (17 çürük +
11 geçerli) ve §4 (başarı skaleri).

İki turun arasına giren **tek** commit:

| Commit | Düzeltme | 2. turdaki karşılığı |
|---|---|---|
| `4fa874d` | (1) `never_existed` toplamına 0,5 tavanı — per-anchor ağırlık 0,3 kalır | §8.2 |
| `4fa874d` | (2) `never_existed` artık "çapa hareketi" sayılır (sonek çözümlemesi sonrası ölçülmüş iddia) | §8.3 |
| `4fa874d` | (3) `born_invalid` zayıf sinyali: ≥2 sonekle çözülen çapa → +0,2 | §6.1 / M0-D2 |

Eşik yine **0,6**, değiştirilmedi. Ölçüm ve çıkarım katmanına hiç dokunulmadı —
aşağıda görüleceği gibi 260 çapanın hükümleri 2. turla **birebir aynı** çıktı, yani
bu tur saf bir **aritmetik farkı**dır.

Bu bir ÖLÇÜM raporudur. Hedef tutturma yok; sayılar yuvarlanmadı.

---

## 0. Koşum sağlığı

| Ölçü | 1. tur | 2. tur | 3. tur |
|---|---|---|---|
| `classifyCalls` | 1 | 1 | **1** |
| `classify_failed` olayı | yok | yok | **yok** |
| `classified` | `true` | `true` | **`true`** |
| `measurementFailures` | — | 0 | **0** |
| `fetchFailed` | — | — | **`false`** |
| İçe alınan dosya | 28 | 28 | **28** (1 atlandı: indeks) |

Model yine `--model` geçilmeden koşuldu; etkin model Codex'in kendi yapılandırma
varsayılanı (`~/.codex/config.toml` → `gpt-5.6-sol`). **Şerh 2. turdan aynen
geçerli:** depo koşumda kullanılan model adını kaydetmiyor, bu çıkarım koddan ve
config'ten — `sonuc.json`'dan değil.

---

## 1. Ana sayılar — üç tur

| Ölçü | 1. tur | 2. tur | **3. tur** | r2→r3 |
|---|---|---|---|---|
| **Yakalama** — 17 çürük nottan `suspect` | 3 / 17 (%17,6) | 5 / 17 (%29,4) | **6 / 17 (%35,3)** | **+1** |
| **Yanlış alarm** — 11 geçerli nottan `suspect` | 2 / 11 (%18,2) | 1 / 11 (%9,1) | **0 / 11 (%0)** | **−1** |
| Doğru temiz | 9 / 11 | 10 / 11 | **11 / 11** | +1 |
| Denetlenen not | 28 | 28 | 28 | — |
| Toplam `suspect` | 5 | 6 | **6** | — |
| Onaylanan çelişki | 0 | 1 | **1** | — |
| Toplam çapa | 260 | 260 | **260** | — |
| Çelişki adayı / atılan | 69 / 49 | 67 / 47 | **67 / 47** | — |

Eşik `0,6` (M0 §5 kalibrasyonu), üç turda da değiştirilmedi.

**Skaler ikinci kez iki yönde birden iyileşti** ve bu turda hareket net: kazanılan
bir yakalama var, kaybedilen yakalama **yok**, ve yanlış alarm sıfırlandı. 2. turun
"4 kazanç / 2 kayıp" kompozit hareketinin aksine, bu turda kimse düşmedi.

Üç turun toplam yörüngesi: yakalama %17,6 → %29,4 → **%35,3**;
yanlış alarm %18,2 → %9,1 → **%0**.

---

## 2. Sinyal kırılımı

| Sinyal (çapa durumu) | 1. tur | 2. tur | **3. tur** |
|---|---|---|---|
| `ok` | 207 | 207 | **207** |
| `unverifiable` | 34 | 35 | **35** |
| `never_existed` | 15 | 12 | **12** |
| `symbol_lost` | 4 | 3 | **3** |
| `churned` | 0 | 3 | **3** |
| `missing_now` | 0 | 0 | **0** |
| DURUM-kalıbı | 10 notta | 10 notta | **10 notta** |
| → D1 bileşimi (DURUM + hareket) açılan not | 1 | 2 | **4** |
| Çelişki (onaylanan) | 0 | 1 | **1** |
| `never_existed` tavanı kırpıldı (not) | — | — | **3** |
| `born_invalid` ateşleyen not | — | — | **3** |

Çapa türü dağılımı — 2. turla **aynı**:

| Tür | 1. tur | 2. tur | 3. tur |
|---|---|---|---|
| `symbol` | 210 (%81) | 177 (%68) | **177 (%68)** |
| `file_path` | 27 (%10) | 42 (%16) | **42 (%16)** |
| `commit_sha` | 14 (%5) | 30 (%12) | **30 (%12)** |
| `external_path` | 9 (%3) | 11 (%4) | **11 (%4)** |
| 0 `file_path` çapası olan not | 18 / 28 | 14 / 28 | **14 / 28** |

**Ölçümün en temiz yanı bu:** altı çapa durumu, dört çapa türü, çelişki adayı sayısı,
atılan aday sayısı — hepsi 2. turla bit-bit aynı. Değişen tek şey `scoreDrift`'in
aritmetiği. Dolayısıyla aşağıdaki her skor farkının sebebi tek bir yerde, ve
karıştırıcı değişken yok.

Tek gerçek hareket **D1 bileşiminin 2'den 4 nota çıkması** (Düzeltme 2): artık
`never_existed` de `anchorMoved` üretiyor, yani DURUM kalıbı taşıyan ve tek bir
`never_existed` çapası olan not, eşiği bileşimle aşabiliyor.

---

## 3. Not-not eşleşme (M0 §2 tablosuna karşı)

`suspect` olanlar kalın. Skor = `suspicion`, eşik 0,6.

| Not | M0 hükmü | r1 | r2 | **r3** | Sonuç | Tetikleyen sinyal (r3 gerekçe satırlarından) |
|---|---|---|---|---|---|---|
| **bekleyen-isler** | **çürümüş (tam)** | 0,20 | 1,00 | **0,70** | **YAKALANDI** | `never_existed` ×4 (0,5'te kırpıldı) + sonek→`churned` + churn 4 commit + DURUM+hareket (M0-D1) |
| **codex-delegate-niyet** | kısmen-çürümüş | 0,20 | 0,80 | **0,70** | **YAKALANDI** | `never_existed` ×2 (0,5'te kırpıldı) + **DURUM+hareket (M0-D1)** |
| **masaustu-guven-modeli** | kısmen-çürümüş | 1,00 | 0,70 | **0,70** | **YAKALANDI** | `symbol_lost` (`adoptLegacyRoot`) 0,4 + `never_existed` 0,3 |
| **teslim-yolu-denetim-2** | kısmen-çürümüş | 0,20 | 0,70 | **0,70** | **YAKALANDI** | onaylanan `intra` çelişki (akış-durumu kalıbı) + DURUM (hareketsiz) |
| **test-standardi** | kısmen-çürümüş | 0,20 | 0,70 | **0,70** | **YAKALANDI** | DURUM + çapa hareketi (M0-D1) |
| **windows-acikleri** | kısmen-çürümüş | 0,50 | 0,50 | **0,70** | **YAKALANDI (yeni)** | `never_existed` ×1 + **DURUM+hareket (M0-D1)** — Düzeltme 2 |
| indirme-butunlugu-kutugu | **geçerli** | 0,60 | **0,60** | **0,50** | **doğru temiz (kazanç)** | `never_existed` ×2, **0,5 tavanında kırpıldı** — Düzeltme 1 |
| custom-tools-cs-eksik | kısmen-çürümüş (doğuştan-yanlış yol) | 1,00 | 0,30 | **0,50** | kaçtı | `never_existed` 0,3 + **`born_invalid` 0,2 (4 çapa)** — Düzeltme 3, eşiğin 0,1 altı |
| unity-mcp-yerel-auth | kısmen-çürümüş | 0,30 | 0,50 | **0,50** | kaçtı | `never_existed` 0,3 + churn 3 commit 0,2 |
| kritik-acik-tanimi | kısmen-çürümüş | 0,40 | 0,40 | **0,40** | kaçtı | `symbol_lost` (`test_local_token_file`) |
| macos-build-mekanigi | **geçerli** | 0,60 | 0,20 | **0,40** | doğru temiz | churn 6 commit 0,2 + **`born_invalid` 0,2 (2 çapa)** |
| onay-kapisi-kapsami | kısmen-çürümüş | 0,20 | 0,20 | **0,40** | kaçtı | **`born_invalid` 0,2 (2 çapa)** + DURUM (hareketsiz) 0,2 |
| unity-mcp-fork-atif | **geçerli** | 0,40 | 0,40 | **0,40** | doğru temiz | `symbol_lost` (`_socketKeepAliveInterval`) |
| kabuk-olcum-tuzaklari | **geçerli** | 0,20 | 0,20 | **0,20** | doğru temiz | DURUM (hareketsiz) |
| kimi-provider-dogrulanmadi | kısmen-çürümüş | 0,20 | 0,20 | **0,20** | kaçtı | DURUM (hareketsiz) |
| teslim-yolu-denetimi | kısmen-çürümüş | 0,70 | 0,20 | **0,20** | kaçtı | DURUM (hareketsiz) |
| windows-gecisi-tasima | kısmen-çürümüş | 0,20 | 0,20 | **0,20** | kaçtı | DURUM (hareketsiz) |
| agy-print-mcp-koprusu | kısmen-çürümüş | 0,00 | 0,00 | **0,00** | kaçtı | — (gerekçe satırı boş) |
| jarvan-asistan | kısmen-çürümüş | 0,00 | 0,00 | **0,00** | kaçtı | — (tek çapa `external_path` → `unverifiable`) |
| unity-architect-mimari | kısmen-çürümüş | 0,30 | 0,00 | **0,00** | kaçtı | — (1 sonek çözümlemesi; `born_invalid` eşiği 2) |
| unity-mcp-toggle-internet-bagimli | kısmen-çürümüş | 0,30 | 0,00 | **0,00** | kaçtı (**doğru davranış**) | — (M0-D4) |
| agy-model-secimi | **geçerli** | 0,00 | 0,00 | **0,00** | doğru temiz | — |
| csharp-zekasi-zinciri | **geçerli** | 0,00 | 0,00 | **0,00** | doğru temiz | — |
| denetim-kapatma-dersi | **geçerli** | 0,00 | 0,00 | **0,00** | doğru temiz | — |
| lisans-karari | **geçerli** | 0,00 | 0,00 | **0,00** | doğru temiz | — |
| mcp-derleme-kisir-dongu | **geçerli** | 0,00 | 0,00 | **0,00** | doğru temiz | — |
| olcum-subagent-kod-ana-dongu | **geçerli** | 0,00 | 0,00 | **0,00** | doğru temiz | — |
| worktree-kullanimi | **geçerli** | 0,00 | 0,00 | **0,00** | doğru temiz | — |

**Yakalanan: 6/17. Kaçan: 11/17. Doğru temiz: 11/11. Yanlış alarm: 0/11.**

Sınırda kalan/eşleşmeyen not yok: depodaki 28 `source_ref` dosya adı M0 §2'nin 28
adıyla birebir eşleşti; hüküm ataması belirsiz kalan not olmadı.

---

## 4. r2 → r3 farkları, not bazında

Skoru değişen **beş** not var; hepsi üç düzeltmeden birine izlenebiliyor. Diğer 23
not birebir aynı skoru aldı.

### 4.1 `windows-acikleri`: 0,50 → 0,70 — **yeni yakalama** (Düzeltme 2)

İki turdur tam 0,50'de takılıydı (r2 §8.3 bunu ismen borç yazmıştı). r3 gerekçe
satırları:

```
file_path .delegate-runs/AUDIT/ledger.jsonl: never_existed
DURUM-kalıbı + çapa hareketi (M0-D1)
```

`never_existed` artık `anchorMoved` ürettiği için D1 bileşimi ilk kez açıldı; D1
skoru 0,7 tabanına oturtuyor. **Sinyal girdisi değişmedi** — aynı tek `never_existed`
çapası, aynı DURUM kalıbı. Değişen yalnız bunların birleşme kuralı. Bu, ölçülmüş bir
borcun tek commit'le kapanmasının temiz örneği.

### 4.2 `indirme-butunlugu-kutugu`: 0,60 → 0,50 — **tek yanlış alarm düştü** (Düzeltme 1)

r2'nin tek yanlış alarmıydı ve tam 0,3 + 0,3 = 0,60 ile eşiğe oturuyordu. r3:

```
file_path util/prunetags.sh: never_existed
file_path release-metadata/10.0/10.0.0/release.json: never_existed
never_existed katkısı 0.5 tavanında kırpıldı (2 çapa)
```

Tavan devreye girdi, skor 0,50 → eşik altı. Notta başka hiçbir sinyal sınıfı yok
(DURUM kalıbı yok, churn yok, sembol kaybı yok), yani "tek sinyal sınıfı tek başına
mahkûm edemez" ilkesi tam da hedeflediği vakayı temizledi. **Yanlış alarm 1 → 0.**

### 4.3 `custom-tools-cs-eksik`: 0,30 → 0,50 — doğru sinyal, yetersiz ağırlık (Düzeltme 3)

Beklenti tutuyor: `born_invalid` bu notta ateşledi ve skoru 0,2 yükseltti, ama
**eşiğin 0,1 altında kaldı**.

```
file_path unity-mcp/Server/services/custom_tool_service.py: never_existed
… 4 çapa sonekle çözüldü (hepsi ok) …
4 çapa yazıldığı yolda değil — not yolları yanlış yazıyor (born_invalid)
```

Bu, üç turun en öğretici tek vakası. M0 §2 bu nota verdiği çürüme tipini
`(doğuştan-yanlış yol)` diye yazmıştı; r1'de not yanlış sebeple (5 `never_existed`)
1,00 almış, r2'de sonek çözümlemesi o sahte sebebi silince 0,30'a düşmüştü. r3'te
**doğru sebep ilk kez kendi adıyla ateşliyor** — ama 0,2'lik zayıf sinyal olarak
tasarlandığı için tek başına yetmiyor. Yani sinyalin *yönü* doğrulandı, *kalibrasyonu*
sınanmadı.

### 4.4 `bekleyen-isler`: 1,00 → 0,70 ve `codex-delegate-niyet`: 0,80 → 0,70

İkisi de `suspect` kalmaya devam ediyor — **hüküm değişmedi, yalnız skor düştü.**

- `bekleyen-isler`: 4 `never_existed` çapasının ham katkısı 1,2 idi; tavan 0,5'e
  kırptı. Kalan sinyaller (sonek→`churned`, churn 4 commit, D1 bileşimi) skoru 0,7
  tabanında tutuyor.
- `codex-delegate-niyet`: 2 `never_existed` → 0,6 ham, 0,5'e kırpıldı. Buna karşılık
  Düzeltme 2 sayesinde gerekçe satırı r2'deki `DURUM (hareketsiz)`'den
  `DURUM + çapa hareketi (M0-D1)`'e döndü ve skor 0,7 tabanına oturdu.

**Not:** `codex-delegate-niyet` için r2 §5'te yazılan şerh geçerliliğini koruyor —
notu suçlayan iki `never_existed` yolu GaMachine deposunun kapsamı dışında
(codex-delegate skill dosyaları). Yakalama sayılıyor ama sağlam bir yakalama değil,
ve bu turda Düzeltme 2 onu **daha da** kırılganlaştırmadı: aynı iki çapa, artık
DURUM'la bileşim yapıyor.

### 4.5 Düzeltme 2 yeni yanlış alarm üretti mi? **Hayır.**

Aranan şekil: DURUM kalıbı + tek `never_existed` (başka sinyal yok) taşıyan
**geçerli** bir not. Depoda D1 bileşimi (`DURUM-kalıbı + çapa hareketi`) ateşleyen
4 not var — `bekleyen-isler`, `codex-delegate-niyet`, `test-standardi`,
`windows-acikleri` — ve **dördü de M0 §2'ye göre çürük.** Geçerli 11 nottan hiçbiri
DURUM + `never_existed` birleşimi taşımıyor:

- `indirme-butunlugu-kutugu` iki `never_existed` taşıyor ama **DURUM kalıbı yok**
  (gerekçe satırlarında DURUM satırı hiç geçmiyor) → Düzeltme 2 ona dokunmadı, ve
  Düzeltme 1 onu eşiğin altına indirdi.
- `kabuk-olcum-tuzaklari` DURUM taşıyor ama hiç `never_existed` çapası yok
  (`ok:3, unverifiable:4`) → `DURUM (hareketsiz)` 0,20'de kaldı.

### 4.6 Düzeltme 3'ün yan etkisi: iki notu daha yükseltti

`born_invalid` üç notta ateşledi. Biri yukarıda (§4.3). Diğer ikisi eşiği aşmadı ama
kaydedilmeli:

| Not | M0 hükmü | r2 → r3 | Sebep |
|---|---|---|---|
| `macos-build-mekanigi` | **geçerli** | 0,20 → **0,40** | 2 çapa sonekle çözüldü (`./fetch_video_bins.sh`, `./build_backend.sh`) + churn 6 commit |
| `onay-kapisi-kapsami` | kısmen-çürümüş | 0,20 → **0,40** | 2 çapa sonekle çözüldü + DURUM (hareketsiz) |

`macos-build-mekanigi`, `born_invalid` yüzünden yükselen **tek geçerli not** ve
eşiğin 0,2 altında. Şerh: M0 §2 bu nota "geçerli" derken parantez içinde
*"xattr'ın konum beyanı doğuştan hatalı"* diyor — yani sinyalin işaret ettiği şey
notta gerçekten var; hakem bunu çürüme saymamış. `born_invalid` ağırlığı ileride
artırılırsa **ilk kırılacak yer burasıdır**, ve bu ölçülmüş bir tampon: 0,2.

`unity-architect-mimari` yalnız 1 çapa çözümlemesi taşıdığı için
`BORN_INVALID_MIN_RESOLVED = 2` eşiğine takıldı ve 0,00'da kaldı; `bekleyen-isler`
ve `masaustu-guven-modeli` de birer çözümlemeye sahip, ikisinde de sinyal ateşlemedi.

---

## 5. Üç turun karşılaştırma tablosu

| | 1. tur (2026-08-11) | 2. tur (2026-08-12) | **3. tur (2026-08-12)** |
|---|---|---|---|
| Araya giren kod | — | `4370c49`, `d0d87f8`, `58f7d97`, `b339054` | **`4fa874d`** |
| Değişen katman | — | çapa çıkarımı + ölçüm + sınıflama bütçesi | **yalnız skor aritmetiği** |
| **Yakalama** | 3 / 17 (%17,6) | 5 / 17 (%29,4) | **6 / 17 (%35,3)** |
| **Yanlış alarm** | 2 / 11 (%18,2) | 1 / 11 (%9,1) | **0 / 11 (%0)** |
| Toplam `suspect` | 5 | 6 | 6 |
| Yeni yakalama | — | +4 | **+1** |
| Kaybedilen yakalama | — | −2 | **0** |
| `never_existed` | 15 | 12 | 12 |
| `symbol_lost` | 4 | 3 | 3 |
| `churned` | 0 | 3 | 3 |
| `missing_now` | 0 | 0 | **0** |
| `unverifiable` | 34 | 35 | 35 |
| `ok` | 207 | 207 | 207 |
| D1 bileşimi açılan not | 1 | 2 | **4** |
| Onaylanan çelişki | 0 | 1 | 1 |
| Atılan çelişki adayı | 49 / 69 (%71,0) | 47 / 67 (%70,1) | 47 / 67 (%70,1) |
| `born_invalid` ateşleyen not | — | — | **3** |
| Çapa türü: `symbol` payı | %81 | %68 | %68 |

Yanlış alarm eğrisi 2 → 1 → 0; yakalama eğrisi 3 → 5 → 6. **İki eğri üç turda da
ters yönde hareket etmedi** — yani kazançlar birbirinin bedeliyle alınmadı.

---

## 6. Kalan kaçaklar ve sebepleri

11 çürük not hâlâ eşik altında. Her satırdaki sebep **koşumun kendi gerekçe
satırlarından ve çapa durumlarından** okundu; tahmin yok. "Eksik sinyal sınıfı",
notu yakalamak için gereken ama bu boru hattında ya var olmayan ya da ateşlemeyen
sınıftır.

| Not | M0 çürüme tipi | r3 | Gerekçe satırlarından okunan sebep | Eksik sinyal sınıfı |
|---|---|---|---|---|
| `custom-tools-cs-eksik` | doğuştan-yanlış yol | **0,50** | `born_invalid` ateşledi (4 çapa) ama 0,2 zayıf sinyal; tek `never_existed` ile toplam 0,5 | **kalibrasyon** — doğru sınıf ateşliyor, ağırlığı yetmiyor |
| `unity-mcp-yerel-auth` | durum-bayatladı | **0,50** | `never_existed`(0,3) + churn 3 commit(0,2); **DURUM kalıbı gerekçelerde yok**, o yüzden D1 tabanı açılmıyor | DURUM dedektörünün kapsamı (kalıp bu notta eşleşmiyor) |
| `kritik-acik-tanimi` | durum-bayatladı | **0,40** | Tek gerekçe `symbol_lost (test_local_token_file)` = 0,4. M0-D3(b)'nin ismen saydığı not-içi çelişki (üst vs alt blok) **onaylanmadı** | çelişki sınıflaması — 67 adayın 47'si atılıyor |
| `onay-kapisi-kapsami` | durum-bayatladı | **0,40** | `born_invalid` 0,2 + `DURUM (hareketsiz)` 0,2. 16 çapanın **hepsi `ok`**, churn 0 | churn penceresi (not 30 Tem, pin 30 Tem) + `born_invalid` kalibrasyonu |
| `teslim-yolu-denetimi` | durum-bayatladı | **0,20** | Tek gerekçe `DURUM (hareketsiz)`. 0 `file_path` çapası, `symbol_lost` yok. M0-D3(c)'nin ismen saydığı frontmatter↔gövde çelişkisi **üç turdur onaylanmadı** | çelişki sınıflaması (frontmatter yüzeyi) |
| `kimi-provider-dogrulanmadi` | ölçüm-geçersizleşti | **0,20** | Tek gerekçe `DURUM (hareketsiz)`; 10 çapanın hepsi `ok`. Çürüme sayısal bir iddiada ("82 test" → 824) | **yalnız-anlamsal** — hiçbir mekanik sinyalin yüzeyi değil; hakem (M4) işi |
| `windows-gecisi-tasima` | durum-bayatladı | **0,20** | Tek gerekçe `DURUM (hareketsiz)`; çapalar `ok:2, unverifiable:1`, **0 `file_path`** | çapa çıkarımı (nottan yol çıkmıyor) → hareket ölçülemiyor |
| `agy-print-mcp-koprusu` | karar-tersine-döndü | **0,00** | **Gerekçe satırı tamamen boş**; 14 çapa `ok`, 2 `unverifiable`. Not frontmatter'ında `modified` yok (r2 §2, dosya okunarak ölçüldü) → churn penceresi ölü | not tarihi + anlamsal karar-tersine-dönme; mekanik yüzey yok |
| `jarvan-asistan` | dosya-silindi | **0,00** | Tek çapa `external_path` → `unverifiable` (D-M3-7 gereği nötr) | **repo-dışı çapa ölçümü** (M0-D6, v1 kapsamı dışı) |
| `unity-architect-mimari` | dosya-silindi + karar | **0,00** | Tek gerekçe bir sonek çözümlemesi (`routes/conversation_routes.py` → `ok`); `born_invalid` eşiği 2, bu notta 1. Çapa durumları `ok:4` | çapa çıkarımı — M0'ın saydığı 7 çökmüş iddianın silinen dosyaları **çapa olarak hiç çıkmamış** |
| `unity-mcp-toggle-internet-bagimli` | ölçüm-geçersizleşti | **0,00** | Gerekçe boş; `ok:5, unverifiable:1` | — **doğru davranış** (M0-D4: satır kayması şüphe üretmemeli; içerik ayakta) |

### 6.1 Kaçakların sınıf dağılımı

11 kaçağın sebebi dört kümede toplanıyor:

| Sınıf | Adet | Notlar |
|---|---|---|
| Yalnız-anlamsal (mekanik yüzey yok) | 3 | `kimi-provider-dogrulanmadi`, `agy-print-mcp-koprusu`, kısmen `custom-tools` |
| Çelişki sınıflama kapsamı | 2 | `kritik-acik-tanimi`, `teslim-yolu-denetimi` |
| Çapa çıkarımı / kapsam | 3 | `windows-gecisi-tasima`, `unity-architect-mimari`, `jarvan-asistan` |
| Eşiğin 0,1–0,2 altında takılma | 3 | `custom-tools-cs-eksik` (0,50), `unity-mcp-yerel-auth` (0,50), `onay-kapisi-kapsami` (0,40) |
| Doğru davranış (kaçak sayılmamalı) | 1 | `unity-mcp-toggle-internet-bagimli` |

*(`custom-tools` iki sınıfta birden sayıldı: doğru sınıf ateşliyor ama ağırlık yetmiyor.)*

**Ölçülmüş eşik gözlemi.** 0,50'de tam **üç** not duruyor: iki çürük
(`custom-tools-cs-eksik`, `unity-mcp-yerel-auth`) ve **hiçbir geçerli not**. Eşik
0,6 → 0,5'e indirilseydi bu koşumda yakalama 8/17'ye (%47,1) çıkar, yanlış alarm
**0/11'de kalırdı** — çünkü Düzeltme 1 tek geçerli 0,50'lik notu
(`indirme-butunlugu-kutugu`) oraya kendisi indirdi. Bu **tek koşumluk bir gözlemdir**,
eşik değiştirilmedi ve bu rapor bir öneri değil ölçüm kaydıdır; üstelik eşiği
0,5'e indirmek `indirme-butunlugu-kutugu`'nu doğrudan sınıra oturtur (tampon sıfır).

---

## 7. Kalan yapısal sebepler (r2 §8'in durumu)

| r2 borcu | Durum |
|---|---|
| §8.1 Sınıflama bütçesi adayların %70'ini atıyor | **AÇIK** — 67/47 aynen duruyor; bu commit sınıflamaya dokunmadı. M0-D3'ün üç saha örneğinden ikisi hâlâ onaylanmıyor. |
| §8.2 `never_existed` tek başına eşiği deliyor | **KAPANDI** — 0,5 tavanı; tek yanlış alarm düştü, yakalama kaybı olmadı. |
| §8.3 `never_existed` "hareket" sayılmıyor | **KAPANDI** — `windows-acikleri` iki turluk takılmadan çıktı; yeni yanlış alarm üretmedi (§4.5). |
| §8.4 Churn penceresi yapısal olarak dar | **AÇIK** — altın setin özelliği, kodun kusuru değil. `onay-kapisi-kapsami` hâlâ churn 0. |
| §8.5 `SYMBOL_RE` daraltılmadı | **AÇIK** — 177 sembol çapası, 207 `ok`'un büyük kısmı hâlâ jenerik token teminatı. |
| §8.6 `missing_now` hiç ateşlenmedi | **AÇIK** — üç turdur saha doğrulaması yok. |
| M0-D2 `born_invalid` kendi sınıfını istiyor (r2 §6.1) | **KISMEN** — sınıf eklendi ve doğru notta ateşledi; ama 0,2 ağırlıkla hüküm değiştirmedi. |

---

## 8. Şerhler ve sınanmayanlar

- **Karşılaştırma zemini temiz.** Hafıza anlık görüntüsü, pin'ler ve eşik üç turda
  aynı. Bu turda ölçüm katmanı da aynı: 260 çapanın durum dağılımı r2 ile birebir.
  Değişen tek şey `scoreDrift` aritmetiği (`4fa874d`).
- **M0 hükümleri hakem sayılıyor.** M0'ın kendi hata payı üç turda da sınanmadı.
- **"Kısmen-çürümüş" ikili sayıldı.** İddia düzeyinde ölçüm yapılmadı; bir notun kaç
  iddiasının öldüğü ağırlıklandırılmıyor. Bu, 6/17'lik skalerin en büyük bilinen
  kabalığı.
- **Etkin model adı doğrudan ölçülemedi.** Depo model adını kaydetmiyor.
- **`born_invalid` kalibrasyonu sınanmadı.** 0,2 ağırlığı ve ≥2 eşiği bu koşumda
  hiçbir hükmü değiştirmedi; yalnız üç notun skorunu yükseltti. Ağırlığın doğru
  değeri ölçülmedi — sadece "0,2 ile yetmiyor, ve tek geçerli notta 0,2 tampon var"
  ölçüldü.
- **Yanlış alarm 0/11, tek koşumluk bir sayıdır.** 11 not küçük bir örneklem; %0
  "yanlış alarm üretmiyor" demek değil, "bu 11 notta üretmedi" demektir.
- **Sınanmayan:** hakem (M4) katmanı; Codex-Claude uyuşmazlık oranı (M0 §5);
  `missing_now`; eşik duyarlılığı (yalnız 0,6 koşuldu).

---

## 9. Kapanış

Üç aritmetik düzeltmeden sonra skaler: **yakalama 6/17 (%35,3), yanlış alarm
0/11 (%0).** Tur başlangıcında 5/17 ve 1/11'di.

Bu turun ayırt edici yanı **hareketin saf olması**: çapa çıkarımı, ölçüm ve
sınıflama katmanları hiç değişmedi, 260 çapanın hükümleri r2 ile birebir aynı çıktı,
ve tüm fark tek bir fonksiyonun aritmetiğinden geldi. Kazanç da bedelsiz: bir
yakalama eklendi, bir yanlış alarm silindi, **hiçbir yakalama kaybedilmedi**.

Üç turun toplamı: yakalama %17,6 → %29,4 → %35,3; yanlış alarm %18,2 → %9,1 → %0.
Darboğaz artık ne çapa çıkarımı (r1) ne `never_existed` ağırlığı (r2) — kalan 11
kaçağın 3'ü **yalnız-anlamsal** (mekanik yüzeyi yok, M4 hakeminin işi), 2'si
**çelişki sınıflama kapsamı**, 3'ü **çapa çıkarımı/kapsam**, 3'ü ise eşiğin
0,1–0,2 altında takılı. Yani M3'ün mekanik sinyal katmanı kendi tavanına yaklaşıyor;
sonraki kazanç ya sınıflama bütçesinden ya da M4'ten gelecek.

Ve bir cümle daha, üç turun ortak dersi olarak: **her turda skoru değiştiren şey yeni
bir sinyal değil, mevcut sinyallerin birleşme kuralıydı.** r1'de çapa kotası,
r2'de yüzey kotası, r3'te tavan + bileşim + doğuştan-yanlış sınıfı. Sinyal
üretmekten çok, üretilen sinyali doğru bileştirmek kazandırdı.
