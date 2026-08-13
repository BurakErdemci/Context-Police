# M4 · Hakem çağrısının maliyeti — kapı kararını sınayan ölçüm

**Tarih:** 13 Ağustos 2026
**Araç:** `tools/altin-set/adjudicate-cost.ts`
**Yürütücü:** Codex (`codex exec --ephemeral -s read-only -C <worktree> --json`)

## 0. Neden

`2026-08-13-m4-kapi-tavani.md` §3'te kapı kaldırıldı ("skor sıralar, tüm
notlar eninde sonunda hakeme gider"). O kararın §4'ünde açıkça yazılıydı:
karar **ölçülmemiş bir varsayıma** dayanıyor — 28 notluk tam tarama
kaldırılabilir mi? Bu rapor o ölçüm.

**Neden Codex, Claude değil:** ürünün tek yürütücüsü Codex (`cli.ts:264` →
`createCodexExecutor`). Claude üzerinden ölçmek, ürünün hiç koşmayacağı bir
şeyi ölçmek olurdu.

## 1. Ölçümden önce bulunan iki boşluk

**`ExecutorResult` token taşımıyor** (`ok/output/error/durationMs`). Adaptör
`codex exec -o` kullanıyor, o da yalnız son mesajı yazıyor. Token sayacı
**yalnız `--json` akışındaki `turn.completed.usage`** alanında. Yani ürün şu
an kendi maliyetini göremiyor — maliyet kapısı yeniden tasarlanırken
kapatılması gereken bir boşluk.

**Bugünkü sınıflama çağrısı hakemi temsil etmiyor:** `-s read-only`, cwd yok,
model dosya okumuyor. Hakem araçlı olacak. `read-only` kum havuzu okumaya ve
komut koşturmaya izin verdiği için **K9 (diske yazma yok) korunarak araçlı
hakem mümkün** — `executor.ts:20` bunu zaten öngörmüş.

## 2. Ölçüm — 4 not, pin `b4065f1`

| not | satır | süre | taze girdi | çıktı | akıl y. | iddia |
|---|---|---|---|---|---|---|
| worktree-kullanimi | 14 | 295 sn | 55.729 | 9.901 | 5.831 | ?* |
| masaustu-guven-modeli | 46 | 299 sn | 106.658 | 11.056 | 5.823 | 26 |
| onay-kapisi-kapsami | 513 | 619 sn | 201.708 | 26.836 | 10.848 | 82 |
| bekleyen-isler | 687 | 583 sn | 333.197 | 23.019 | 7.288 | 84 |

"Taze girdi" = `input_tokens − cached_input_tokens`. Önbellek oranı yüksek
(%85–95); ham `input_tokens` küçük notta bile 559k, çünkü araçlı ajan her
turda bağlamı yeniden gönderiyor.

\* İlk koşumda iddia sayacı 0 döndü. Sonraki koşumlar ayrıştırıcı düzeltmesiyle
26/82/84 verdi, yani 0 büyük olasılıkla ayrıştırma hatası — **ama ham akış o
koşumda saklanmıyordu, kanıtlanamıyor.** Kayıt böyle duruyor.

**Çağrılar gerçekten hüküm üretiyor**: şemaya uygun, kanıtlı, iddia düzeyinde
çıktı geldi (örn. `bekleyen-isler` için `curuk`, kanıt olarak
`refs/remotes/origin/main=19c623f`).

## 3. 28 notluk tam tarama tahmini

28 notun 17'si küçük (<100 satır), 11'i büyük. İki kova ortalamasıyla
(4 nokta ile eğri uydurmak ölçümden çok varsayım üretirdi):

| | değer |
|---|---|
| süre (seri) | **3,2 saat** — 4 paralel ≈ 0,8 saat |
| taze girdi | **4,3M token** |
| çıktı | **452k token** |
| çağrı | **28** |

Mevcut maliyet kapısı proje başına **en kötü 3 çağrı** varsayıyor
(`observe-cmd.ts:115`). Tam tarama bunu ~10× aşıyor, ve çağrı başına maliyet
de sınıflama çağrısından kat kat yüksek (araçlı, çok turlu).

## 4. Karar üzerindeki etkisi

**"Her koşumda 28 notu araçlı hakemden geçir" ölçümle ÇÜRÜTÜLDÜ.** Bu haliyle
arka planda sessizce çalışan bir denetçi olamaz.

**Ama kapı kararının tamamı çürütülmedi**, çünkü ölçülen şey **sınırsız**
bir hakemdi. Ajan serbestçe depoyu gezdi; ona ne bir keşif bütçesi verildi ne
de elde hazır olan kanıt sunuldu. Maliyet not boyutundan çok **keşif
turlarından** geliyor: 14 satırlık not 295 saniye sürdü.

İki büyük kaldıraç henüz denenmedi:

1. **Kanıtı önden ver.** Mekanik katman zaten hangi çapanın kaydığını, hangi
   dosyanın var olmadığını, `git log`'un ne dediğini biliyor
   (`anchor-drift.ts` bunları ölçüyor ve atıyor). Bunları isteme koymak
   keşfin çoğunu gereksiz kılar.
2. **Keşfi sınırla.** Tur/komut tavanı; ya da hakeme yalnız notu ve önceden
   toplanmış kanıtı ver, depoyu hiç açtırma (araçsız hakem).

## 5. Sıradaki ölçüm — kapı kararını kapatacak olan

**Değişim-tetikli koşumda tipik olarak kaç not oynuyor?** (CLAUDE.md §2.4)
Ölçülmedi. Tam tarama bir kereye mahsus bir maliyetse ve haftalık artımlı
koşum 3-5 not içeriyorsa karar ayakta kalır; her koşum 20 not oynatıyorsa
kalmaz.

GaMachine'in git geçmişinden ucuza ölçülebilir: bir zaman penceresinde kaç
notun çapası hareket etti.

## 6. Sınanmayanlar

- **4 not** ölçüldü, 28'in tamamı değil. Kova ortalaması bir tahmin;
  varyans bilinmiyor (küçük kovada 2 nokta, büyük kovada 2 nokta).
- Tek koşum, tek model (`gpt-5.6-sol`). Koşumlar arası oynaklık ölçülmedi.
- Sınırlı/kanıt-önden-verilen hakemin maliyeti **hiç** ölçülmedi — §4'ün iki
  kaldıracı varsayım olarak duruyor.
- Hakemin **doğruluğu** bu turda ölçülmedi; yalnız maliyet. Üretilen hükümler
  altın setle karşılaştırılmadı.

---

## 7. İkinci tur — üç ölçüm daha (aynı gün)

Burak maliyet kısıtını kaldırdı ("20 dolarlık paket, o kadar da büyük maliyet
yok"), ölçümler serbest bırakıldı. Üç şey ölçüldü.

**Ayrım korunuyor:** token maliyeti bu projede kısıt değil, ama **duvar saati**
ürün tasarımının kısıtı ve fiyattan bağımsız. Not başına 5-10 dakika, arka
planda sessizce koşan bir denetçi için token bedava olsa da yavaştır.

### 7.1 Değişim-tetikli koşumda kaç not oynuyor — KAPI KARARINI KURTARAN SAYI

GaMachine, 8 hafta, 131 commit. Çapa çıkarımı `parse.ts`'in kurallarıyla.

| | değer |
|---|---|
| haftalık oynayan not (yol çapası) | **ortalama 3,1 (%11)** |
| kötü hafta | 9 (%32) |
| 8 haftada en az bir kez oynayan | 10/28 |

**Sonuç: tam tarama bir kereye mahsus.** Sürekli koşumda haftada 3-9 not →
kabaca 20-60 dakika/hafta. Kapı kaldırma kararı (`2026-08-13-m4-kapi-tavani.md`
§3) bu sayıyla **ayakta kalıyor**.

### 7.2 İki kusur — ölçümün yan ürünü

**(a) Notların yarısından fazlası tetiklenemez.** 28 notun **14'ünde hiç
`file_path` çapası yok**; 2'si de yolunu `never_existed`/belirsiz diye
kaybediyor. Hareket sinyali üretebilen yalnız **12/28**.

Değişim-tetikleme tek başına kullanılırsa **16 not hiçbir zaman denetlenmez.**
Bu, doğuştan-yanlış körlüğünün ikinci yüzü: orada "sinyal göremiyor" idi,
burada "sinyal bakamıyor bile". Ve kapı kaldırma kararını bağımsız olarak
destekliyor — kapı olsaydı o 16 not kalıcı olarak görünmez kalırdı.

**(b) Sembol çapaları gürültü — ürün kusuru.** 162 sembol çapasının en çok
vuranları: `return` (100 commit), `type`, `true`, `null`, `main`, `check`.
`parse.ts`'in backtick içi sembol regex'i (`[A-Za-z_$][A-Za-z0-9_$]{3,}`)
jenerik kelimeleri sembol sayıyor. Sembol tetikleyici olarak kullanılsaydı
**haftada 16 not** oynuyor görünürdü — sinyal değil gürültü.
Çapa dağılımı: symbol 177 · file_path 42 · commit_sha 30 · external_path 11
(260 tutulan, 248 kotaya takılıp atılmış).

### 7.3 Kanıtı önden vermek — kaldıraç GERÇEK ama KÜÇÜK

Hipotez: mekanik katmanın çapa bulgularını isteme koymak keşfin çoğunu
gereksiz kılar. Aynı 4 not, `--evidence` bayrağıyla:

| not | süre A→B | taze girdi A→B |
|---|---|---|
| worktree-kullanimi | 295→259 sn | 55.729→57.913 (+%4) |
| masaustu-guven-modeli | 299→354 sn | 106.658→120.070 (+%13) |
| onay-kapisi-kapsami | 619→561 sn | 201.708→176.774 (−%12) |
| bekleyen-isler | 583→524 sn | 333.197→182.902 (**−%45**) |
| **toplam** | **1795→1698 sn (−%5)** | **697.292→537.659 (−%23)** |

**Hipotez kısmen çürütüldü.** Girdi %23 azalıyor, süre yalnız %5. Kazanç
büyük ve çapa yoğun notlarda toplanmış; küçük notlarda maliyet ARTIYOR (kanıt
bloğu isteme ekleniyor ama keşfi azaltmıyor).

Sebep: hakem zamanının çoğu çapaların hiç kapsamadığı iddiaları ölçmekle
geçiyor — sayımlar, davranışlar, mantık. Çapa kanıtı o işi kısaltmıyor.

### 7.4 Hakemin İLK DOĞRULUK SİNYALİ

Maliyet koşumunun ürettiği hükümler altın setle karşılaştırıldı (3 not,
`compare.ts` benzerlik kapısıyla).

| | değer |
|---|---|
| hakem iddiası | 192 (altın set aynı 3 notta 68) |
| bölme uyuşması | %9,2 — hakem çok daha ince bölüyor |
| hüküm uyuşması (eşleşenlerde) | 17/22 → %77,3 |
| **yakalama** (hedef iddia, örtüşen hüküm de "yanlış") | **6/10 → %60** |
| yanlış alarm | 5 (192 iddia içinde) |

Kaçanların **hepsi sayım iddiası**: "agent_runner.py 1682 satır",
"providers/ 5713", "45 kayıtlı araç, 25'i karışık", "8080 canlılık sınaması".
Bunlar dosya okumakla değil sayı üretmekle doğrulanıyor; hakem o yolu seçmedi.

**Altın setin kendisi de sınandı:** yanlış alarmlardan biri
(`bekleyen-isler:11`) muhtemelen hakemin haklı olduğu bir vaka — not
"origin/main de b4065f1 ve 0 geride" diyor, hakem `origin/main=19c623f`
ölçüp `curuk` demiş. Altın set orada `gecerli`. **Altın set ölçüttür,
kutsal değildir.**

**Uyarı:** 3 not, 10 hedef iddia. Ve üçü de mekanik katmanın zaten yakaladığı
notlar (skor 0,70 / 0,40 / 0,70). M3'ün 6/17'siyle **doğrudan
karşılaştırılamaz**.

## 8. Bu turun bıraktığı iş kalemleri

1. **`ExecutorResult` token taşımalı** — adaptör `-o`'dan `--json`'a geçmeli,
   `turn.completed.usage` alanı taşınmalı. Maliyet kapısı yeniden
   tasarlanacaksa ön koşul.
2. **Sembol çapası regex'i ayırt etmiyor** (§7.2b). Tetikleyici olarak
   kullanılamaz durumda.
3. **16 notun tetikleyicisi yok** (§7.2a) — sıra/rotasyon mekanizması şart.
4. **Sayım iddiaları kaçıyor** (§7.4) — hakemin istemi sayım ölçmeyi açıkça
   istemiyor.

## 9. Bu turda sınanmayanlar

- Kanıt-önden karşılaştırması **4 notta, tek koşumda**. Küçük notlardaki
  artış (+%4, +%13) gürültü de olabilir; koşumlar arası oynaklık ölçülmedi.
- Churn ölçümü **tek depoda** (GaMachine) ve 8 haftada. Başka bir projede
  haftalık oynama oranı bilinmiyor.
- Sınırlı keşif (tur/komut tavanı) hiç denenmedi — §4'ün ikinci kaldıracı
  hâlâ varsayım.
- Hakemin doğruluğu **3 notta** ölçüldü, hepsi mekanik katmanın yakaladığı
  notlar. Yakalanamayan notlarda hakem nasıl davranıyor bilinmiyor.

---

## 10. TAM ÖLÇÜM — 28 notun hepsi, M4'ün çıkış kapısı sayısı

İstem iki noktada düzeltildi (sayım iddialarını koştur; her doğrulanabilir
ifadeyi kapsa), kanıt-önden açık, 5 paralel.

**Maliyet:** 28 not · 54,9M ham girdi · 3,40M taze girdi · 484k çıktı ·
not başına ortalama **482 sn / 1,96M ham girdi** · duvar saati 0,7 saat.
Hakem 1210 iddia üretti (altın set 391).

### 10.1 Çıkış kapısı

| | hakem (M4) | mekanik skor (M3) |
|---|---|---|
| **iddia düzeyi yakalama** | **37/45 · %82,2** | — (M3'te iddia düzeyi yoktu) |
| iddia düzeyi yanlış alarm | **39** (232 geçerli iddia içinde, %16,8) | — |
| **not düzeyi yakalama** | **15/15 · %100** | 6/17 · %35,3 |
| not düzeyi yanlış alarm | **7/13** | 0/11 |

**Darboğaz yer değiştirdi.** M3'ün sorunu kapsamdı (%35 yakalama, sıfır gürültü);
hakemin sorunu kesinlik (%100 not yakalama, ama 13 temiz notun 7'si işaretlendi).
M4'ün kalan işi kapsama değil **hassasiyet**.

### 10.2 Yanlış alarmların anatomisi — tek bir sınıf

39 yanlış alarmın **27'si `dogustan-yanlis`** (12'si `curuk`).

Hakem bu hükmü **yedek kova** gibi kullanıyor. "Doğuştan yanlış" demek,
iddianın *yazıldığı gün de* yanlış olduğunu kanıtlamayı gerektirir — yani notun
damgasına karşı geçmiş ölçümü. İstemde notun tarihi belirgin biçimde
verilmedi, hakem de değişim kanıtı bulamadığında bu kovaya düşüyor.

**Düzeltme (ölçülmedi, hipotez):** notun `modified` damgasını isteme koy ve
`dogustan-yanlis` için "o tarihteki durumu ölçtün mü" şartı getir. Ölçülemiyorsa
`curuk` değil `olculemez` doğru cevap.

### 10.3 Kaçan 8 iddia — hâlâ aynı sınıf

`45 kayıtlı araç var, 25'i karışık` · `agent_runner.py 1682 satır` ·
`providers/ 5713, renderer/ 9390` · `/get-ai-config'in döndüğü alanlar` ·
`~/.codex-worker'da unityMCP kayıtlı`.

Sayım talimatı yakalamayı 6/10'dan (3 notluk ilk ölçüm) 37/45'e çıkardı ama
sınıfı kapatmadı. Kalanlar ya depo dışını (`~/.codex-worker`) ya da çalışan
sistemi gerektiriyor — bir kısmı gerçekten `olculemez` olabilir; altın setin
o kayıtları yeniden gözden geçirilmeli.

### 10.4 Hakem hüküm dağılımı (1210 iddia)

`gecerli` 564 · **`olculemez` 498 (%41)** · `curuk` 83 · `dogustan-yanlis` 65.

Hakemin de %41'i "ölçemedim" diyor — altın setteki %28,6 ile aynı yönde, daha
yüksek. Bu kova hem ölçütte hem üründe büyük; "ölçülebilir nedir" sorusu
projenin merkezinde duruyor.

### 10.5 Bu turda sınanmayanlar

- Tek koşum. Hakemin koşumlar arası oynaklığı ölçülmedi — %82,2'nin ne kadarı
  kararlı bilinmiyor.
- Yanlış alarmların **kaçının altın set hatası** olduğu incelenmedi. İlk turda
  1/5'i öyleydi; aynı oran geçerliyse gerçek yanlış alarm sayısı daha düşük.
- Maliyet tavanının doğruluğa etkisi ölçülmedi: bütçe konursa %82,2 ne olur?
