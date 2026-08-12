# M3 Denetim Raporu — codex-audit, session-audit modu

**Tarih:** 2026-08-12 · **Kapsam:** M3 sinyal motoru + tarama kilidi · **Taban:** `e50c5e8`
**Denetlenen commit'ler:** `5c7f7c7..e50c5e8` (M3'ün kendisi) · **Düzeltme commit'leri:** `e50c5e8..483f11b` (15 commit)
**Bugünkü toplam iş:** `5c7f7c7..483f11b` = 25 commit (10 M3 + 15 denetim düzeltmesi).
*Şerh:* bu iki sayı `git rev-list --count` ile ölçüldü; denetim brief'i 16 ve 20 diyordu — ölçüm kazandı.
**Defter:** `.delegate-runs/AUDIT/ledger.jsonl`
**Tüm probe verdiktleri ANA AĞACA karşı ölçüldü** (`AUDIT_ROOT` ile; lane worktree kopyasına
değil). Av turunun **16/16 probe'u** ilk koşumda ana ağaçta üredi — probe seviyesinde hayalet yok.

---

## 1. Hangi lensler koştu, hangileri koşmadı

Tehdit modeli önce çıkarıldı, lensler ondan türetildi. M3'ün getirdiği yeni yüzey üç
tane: (a) tarama kilidi PID kimliğinden kalp atışına geçti, (b) not metninden çıkarılan
çapa artık `git` alt süreçlerine argüman oluyor, (c) ürünün TEK çıktısı olan `suspect`
hükmü artık bir skor aritmetiğinden geliyor.

| Lens | Lane | Sonuç |
|---|---|---|
| `concurrency-lifecycle` | Codex | 5 bulgu, 5 probe |
| `version-migration` | Codex | 1 bulgu, 1 probe |
| `untrusted-input-to-subprocess` | Codex | 3 bulgu, 3 probe |
| `resource-exhaustion` | Codex | 4 bulgu, 4 probe |
| `decision-integrity` | Codex | 3 bulgu, 3 probe |

**5 lane dağıtıldı, 5'i de teslim etti.** Hiçbiri `cyberPolicy` ile reddedilmedi — M1'in
(iki red) ve M2'nin (bir tur reddi) aksine. Bu, M2 §8'de ölçülen kuralla tutarlı: brief'ler
"kır" değil "ölç" dilinde yazıldı.

**Koşmayan lensler ve gerekçeleri:**

- **Ağ / kimlik doğrulama / yetkilendirme.** Bu araç port dinlemiyor, kimlik bilgisi
  tutmuyor, tek kullanıcılı yerel bir CLI. Bu lensleri koşturmak lane bütçesini bilinen
  boş bir yüzeye harcamak olurdu. *Bu bir kapsam kararıdır, ölçüm değil* — koşulmadığı
  için "temiz" denemez.
- **Prompt enjeksiyonu.** Dün (M2) koştu ve `prompt-injection-supersede` guard'ıyla
  kapandı. Bugünkü diff prompt yüzeyini genişletmedi: `prompt.ts`'e giren tek değişiklik
  (`50d0598`) model çapalarını **daraltan** bir reddetme kapısı. Yeni yüzey olmadığı için
  lens tekrar koşturulmadı; guard M2 raporundaki varsayımıyla ayakta duruyor.

## 2. Sayılar

| | |
|---|---|
| Bulgu (avcı turu) | 16 |
| İlk koşumda ana ağaçta üreyen | **16/16** |
| Doğrulama turu 1 → bulgu | 4 |
| Doğrulama turu 2 → bulgu | 1 |
| Doğrulama turu 3 → bulgu | 2 |
| Doğrulama turu 4 → bulgu | 1 (low, CLI'dan ulaşılamaz) |
| Doğrulama turu 5 → bulgu | 1 (med, `recurring-surface-starvation`) |
| Doğrulama turu 6 → bulgu | **0** |
| **Toplam bulgu** | **25** |
| Kapatılan | 23 |
| Demote (yazılı gerekçe + varsayım) | 2 |
| Probe: yeşil / kırmızı / rc=2 | 20 / 3 / 2 *(20 çıkarımdır: 25 − 3 − 2)* |
| Düzeltme commit'i | 15 |
| Test | 335 → **411** (denetimden doğan 76 kalıcı test) |
| Altın set skaleri (r3/r4/r5) | yakalama **6/17**, yanlış alarm **0/11** |
| **Son turun blocker sayısı** | **0** |

**Aritmetik şerhi:** 23 + 2 = 25. "Açık 3" ayrı bir kova değil — kırmızı kalan 3 probe'un
üçü de yazılı verdiktli olarak kapatılanların içinde (biri guard, biri tek yön, biri
kuşatılmış-ama-kök-çaresi-ertelenmiş). §9'da tek tek.

**Defter satırı ≠ bulgu sayısı.** `ledger.jsonl`'de 28 `finding` satırı var, 25'i sayılıyor.
Sayılmayan üçü: `suffix-index-double-count` (aynı iddianın probe-durumu kaydı,
`correlated-signal-double-count` ile tek bulgu), `intra-surface-flood-starvation` (§3.3,
bilinerek açık — bir turun raporladığı bulgu değil) ve
`classify-stamp-overflow-repeats-selection` (tur 6'nın `out of scope` kalemi, ölçülmedi).
Üçü de `counted_in_findings_total: false` ile işaretli.

**Probe sayımının şerhi:** yukarıdaki yeşil/kırmızı dağılımı her probe'un **kapatıldığı
andaki** verdiktidir. Bugün yeniden koşturulduğunda iki probe farklı davranıyor ve ikisi de
adalet regresyonu değil — §8.1'de gerekçesiyle.

**Test sayısı ölçüldü, rapor edilmedi:** `npm test` ana ağaçta koşturuldu — `tests 411 ·
pass 411 · fail 0`. Taban 335 sayısı M3 kapanışından devralındı.

## 3. En pahalı ders: bir sınıfın kapandığını probe'un yeşile dönmesi göstermiyor

M1'in dersi "düzeltme de denetlenmemiş koddur" idi. M2'nin dersi "doğrulama turu ikinci
kez kazandı" idi. M3'ünki bir basamak daha derin ve bu denetimin **en pahalı** kalemi:
tek bir sınıf — **açlık (starvation)** — **beş kez** kapatıldı, beşinde de probe kırmızıdan
yeşile döndü, ve beşinde de sınıfın başka bir biçimi ayakta kaldı. **Altıncı biçim bugün
bilinerek açık bırakıldı** (§3.3).

| Tur | Kapatılan biçim | Commit | Probe | Bir sonraki tur ne buldu |
|---|---|---|---|---|
| Doğrulama 1 | Sabit ilk-20 kırpması notu sonsuza dek `suspect` tutuyor | `383dee0` | rc=1 → rc=0 | Rotasyon anahtarı **not** düzeyinde, kırpılan iş birimi ise **çift** |
| Doğrulama 2 | Rotasyon not damgasından **konumsal imlece** taşındı | `64725c6` | rc=1 → rc=0 | İmleç bir **konum** tutuyor; aday listesi ise sabit değil |
| Doğrulama 3 | Rotasyon konumdan **kimliğe** (`classify_stamps`) taşındı | `723aa80` | rc=1 → rc=0 | Damga sınıfı içindeki tie-break **yüzey adıyla** başlıyor |
| Doğrulama 4 | Tie-break `finding` id'leriyle başlıyor | `cf59a84` | rc=1 → rc=0 | Damga sınıfı **tümüyle tüketiliyor**: bir yüzeyin taze adayları bütçenin tamamını yiyor |
| Doğrulama 5 | Yüzey başına slot **rezerve ediliyor** (sırala-sonra-kes → rezerve-et-sonra-doldur) | `483f11b` | rc=1 → rc=0 | **0 bulgu** — tur 6 blocker'sız kapandı |

Her satırda ölçüm var, hiçbiri hisle kapanmadı: K7'nin 21 kenarında 8 koşum boyunca hep
atlanan çift (tur 2); 6 koşumluk churn döngüsünde sonsuza dek pencere arkasında kalan
kararlı çift (tur 3); bütçe 1 iken 20 koşumun 20'sinde de seçilmeyen `frontmatter` adayı
(tur 4); 12 koşumun 12'sinde de `cross=20, intra=0, frontmatter=0` (tur 5). Yani probe'lar
yanlış değildi — **eksikti.** Her biri sınıfın o anda bilinen tek örneğini ölçüyordu.

**Mekanizma, ve asıl ders bu:** dördünün kökü aynı tek cümleydi — *türetilmiş ve değişen
bir küme üzerinde KONUM tutmak.* `723aa80`'in gövdesi bunu açıkça yazıyor: "Rotation state
has bled three times, and the root cause was the same each time: holding a POSITION over a
derived, changing set." Doğru soyutlama kimlik, yani "bu aday en son hangi koşumda
SEÇİLDİ" — ve bu, listedeki yerinden bağımsız olduğu için churn'e karşı yapısal.

**Şerh — tur 5'in kökü aynı cümle DEĞİL.** İlk dört biçim "türetilmiş küme üzerinde konum
tutmak" cümlesine indirgeniyordu; beşincisi indirgenmiyor. Orada konum tutulmuyor, kimlik
tutuluyor ve tie-break doğru. Kusur **tüketim sırasındaydı**: `selectCandidates` her damga
sınıfını (artık turu dahil) tümüyle tüketip sonrakine geçiyordu; taze adayların damgası 0
olduğu için tek bir yüzeyden gelen bütçe dolusu taze aday koşumu tek başına yiyordu.
Ölçüldü: 12 koşumun hepsinde `cross=20, intra=0, frontmatter=0` — yani belgelenen 8/6/6
koşum-içi tabanı tutmuyordu. Bu, kökün "konum" değil, **bir kaynağın önceliğe göre
paylaştırılmasında taban garantisinin olmaması** olduğunu gösteriyor; sınıf tek cümleyle
kapanmıyor.

**Bunun pahası ölçülebilir:** protokol tavanı 3 turdu; sınıf tavanda kapanmadığı için
Burak açıkça 3 tur daha yetkilendirdi. Bir sınıf 5 commit, 6 doğrulama turu ve iki kez
"yanlış yazılmış bir iddianın" düzeltilmesini yedi — ve altıncı biçimi hâlâ açık (§3.3).

**Alt-ders (§11'de kural adayı):** dördüncü, beşinci ve altıncı turun asıl tetikleyicisi
kodun kendisi değil, koda **yazılmış iddia** oldu. Adalet sınırı **dört** sürüm gördü —
küresel ⌈N/M⌉ → yüzey başına ⌈N_yüzey/kota_yüzey⌉ → ölçülmüş ⌈N/bütçe⌉ → rezervasyonla
`max(⌈N/bütçe⌉, max_yüzey ⌈N_yüzey/rezerv_yüzey⌉)` — ve **üçü** ölçümle yanlışlandı
(ilk ikisi 30 yapılandırmada, üçüncüsü §3.2'deki 501 yapılandırmada). `723aa80`
bunu şöyle yazıyor: "A wrongly written claim is worse here than no claim." Aynı sınıfın
üçüncü örneği kilitte: `HEARTBEAT_STALE_MS`'in yorumdaki gerekçesi yanlıştı ve ölçümle
değiştirildi (`a513424`: tam 416 MB tarama olay döngüsünü **1 ms** geciktirdi, çekişmeli
bir `node:sqlite` yazımı ise **5192 ms** blokladı).

### 3.1 Dalga H — sırala-sonra-kes yerine rezerve-et-sonra-doldur

`483f11b` *"Reserve classification slots per surface before ranking, not after"*. Yapısal
değişiklik, yama değil:

1. Her yüzey `min(kota, aday sayısı)` slot **rezerve eder** — sıralamadan önce.
2. Her rezerv **yalnız kendi yüzeyinin** öncelik kuyruğundan dolar; başka yüzey oraya
   giremez, dolayısıyla damga 0'lı bir sel bir başkasının tabanını yiyemez.
3. Kullanılmayan rezerv ve artan bütçe **küresel öncelikle** dağıtılır — yani rezervasyon
   kapasiteyi boşa harcamıyor.

Rezervler küresel öncelik sırasında dağıtıldığı için `Σrezerv > bütçe` durumu kendiliğinden
düz küresel sıraya iniyor; dalga G'nin tie-break düzeltmesi **özel durum gerektirmeden**
korunuyor. Ölçüm: probe rc=1 → **rc=0**, 12/12 koşumda `cross=8 intra=6 frontmatter=6`.
Test 405 → **411**.

Kotanın **ölçülmüş** gerekçesi artık kod yorumunda duruyor, tahmin olarak değil: altın
setin 1. turunda 20 slotun 20'si `cross`'a gitti ve onaylanan çelişki **0** çıktı.

### 3.2 Kapsama sınırı ölçüldü ve DEĞİŞTİ

501 yapılandırma, bütçe 1–25 aralığında ölçüldü. Sonuç, dalga G'nin yazılı iddiasını
çürütüyor:

- **`⌈N/bütçe⌉` artık ÜST sınır değil, ALT sınır.** 450 yapılandırmanın **346**'sında
  aşıldı. Somut: 20/20/20 dağılımı ve bütçe 20 ile kapanma 3 değil **4** koşumda oluyor.
- `Σrezerv ≤ bütçe` ön koşulu altında `max(⌈N/bütçe⌉, max_yüzey ⌈N_yüzey/rezerv_yüzey⌉)`
  ifadesi **402/402** yapılandırmada tuttu.
- `Σrezerv > bütçe` hâli için **kapalı form ÖLÇÜLMEDİ.** 51 yapılandırmada sonlu kaldığı
  görüldü; bu bir gözlem, **ispatlanmış sınır değil.** Bir sonraki denetim bu ifadeyi
  doğrulanmış sanıp üzerine inşa etmemeli (§11.3 tam olarak bu sınıf).

**Bu bilinçli bir bedel.** Karşı tasarım — rezervi yalnız hiç ölçülmemiş adaylara
kısıtlamak — denendi ve probe'un ölçtüğü açlığı **geri açtı**. İki istek birbiriyle
uyumsuz: *koşum-içi yüzey tabanı* ile *"ölçülmemiş aday varken hiçbir şeyi yeniden
ölçme"*. Kotanın ölçülmüş gerekçesi (yukarıdaki 20/20 → 0 çelişki) tabandan yana karar
veriyor, ve seçim yazılı.

### 3.3 Açlık sınıfının ALTINCI biçimi — bilinen, açık, M4'e bırakıldı

**Yüzey-içi sel.** Rezervasyon yüzeyler **arası** tekeli kapatıyor, yüzey **içi** tekeli
değil. Damga 0 ("hiç ölçülmemiş") mutlak önceliğe sahip ve yeni adaylar sürekli damga 0'la
girdiği için, rezervinden fazla taze aday alan bir yüzey **kendi eski adaylarını** süresiz
aç bırakabilir.

- Bu biçim **eski algoritmada da vardı** — dalga H onu yaratmadı, daralttı.
- Dalga F'nin churn testi bunu **yakalamıyor**, çünkü testin kalıcı adayları en küçük
  id'lere sahip ve zaten ilk koşumu kazanıyor. Yani yeşil bir churn testi bu biçim
  hakkında hiçbir şey söylemiyor.
- Çaresi rezervasyon **değil**: damga 0'ın mutlak önceliğini **yaşlandırmak**.
- `core/src/signals/classify.ts`'te "Bilinen ve KAPANMAMIŞ biçim: yüzey İÇİ sel" başlığı
  altında gerekçesiyle yazılı.

**Tur 6'nın sıfır bulgusu bunu KAPSAMIYOR.** Bu biçim tur 6'nın brief'inde "bilinen, rapor
etme" olarak listelendi; dolayısıyla "son tur 0 bulgu verdi" cümlesi bu kalemin ölçülüp
temiz çıktığı anlamına gelmez. Açık kalem olarak §12'de.

## 4. Denetimin en değerli bulgusu

**`measurement-failure-treated-clean`** ve onun ikiz yüzeyi
**`budget-exhaustion-acquits-existing-suspect`** — birlikte, ürünün tek işini
sessizce bozan sınıf.

Bu araç bir tek şey üretiyor: bir notun `suspect` olup olmadığı. `decision` lane'i şunu
uçtan uca ölçtü: ilk denetim çelişkiyi onaylıyor ve `suspect/0.7` yazıyor; ikinci
denetimde sınıflandırıcı **ölemiyor değil, sadece çalışamıyor** (iki deneme de başarısız)
— ve not `active/0`'a düşüyor. Yani "ölçemedim", "temiz çıktı" diye kaydediliyor. Bir
model kesintisi, denetçinin daha önce doğru bulduğu her şüpheyi siliyor.

Çare (`4a04c47`) çelişki boyutunu aday başına **tutuyor**: hükmü olmayan adayların
tarafları önceki yargılarını koruyor, ve tutulan yargı görünür oluyor (`signal_scored`
→ `heldUnmeasured`). Hiç aday olmamış bulgular normal temizleniyor — aşırı koruma da
yanlış hükümdür.

**Ve asıl değeri şurada:** aynı sınıfın **ikinci yüzeyi** doğrulama turu 1'de çıktı. Çare
sınıflama yoluna yazılmıştı; çapa yolunda karşılığı yoktu. Git bütçesi tükendiğinde hiç
ölçülmemiş çapalar `unverifiable`/sıfır ağırlık oluyor, ve o düşük skor ayakta duran bir
`suspect`'i temizleyebiliyordu — yani **çapa sırası** hangi kanıtın hayatta kalacağını
belirliyordu. Ölçüm: 15 hiç var olmamış yol + son sırada geçmişte silinmiş bir `victim.ts`;
varsayılan bütçe son çapaları ölçemeden kesilince 0,9'luk suspect temizlendi, geniş
bütçeli aynı kontrol onu tuttu. `0cce6c2` bütçe tükenmesini ve ölçüm hatasını ayrı
sayaçlarda tutuyor (maliyet sınırı ≠ arıza) ama hükme etkisini eşitliyor: ikisi de
"bilmiyoruz" diyor, ikisi de önceki hükmü koruyor.

**İçindeki ders:** bir kural tek bir yüzeyde uygulanınca kapanmış sayılıyor. "Ölçemedim ≠
temiz" cümlesi sınıflama yolunda doğru yazılmıştı; aynı cümlenin çapa yolundaki karşılığı
kimse aramadığı için orada yoktu.

## 5. Kapatılan sınıflar (özet)

**Kilit ömrü (`a513424`, `94236fe`, `7c95515`, `219c7ea`).** Bitiş kontrolü yalnız
`stolen` bayrağını okuyordu, o bayrağı da bir kalp atışı tik'i yazmak zorundaydı —
ölçüldü: 300 ms'lik senkron gövde **sıfır** tik koşuyor, ve `await fn()` sonrası devam bir
mikro-görev iken bekleyen tik makro-görev; yani kontrol, bayrağı yazacak tik'ten **önce**
koşuyordu. Her koşum bir tam aralık (30 sn) genişliğinde kör pencereyle bitiyordu. Bitişte
satır senkron okunuyor artık; bu aynı zamanda "her tazeleme atışı hata veriyor" kardeş
vakasını yapısal olarak nötrleştiriyor (→ §6.1) · `scan` SIGTERM'de kilit satırını
bırakıyordu, sonraki koşum 10 dakikalık bayat penceresi boyunca `ScanLockBusy` alıyordu ·
release hatası işin kendi hatasını değiştiriyordu (artık `releaseError` olarak takılıyor,
`db.ts`'in `rollbackError` sözleşmesiyle aynı) · yutulan tazeleme hataları sayılıp bitişte
tek olay olarak yazılıyor · kendini bırakan gövdenin de reddedildiği teste bağlandı.

**Sürüm karışımı (`7c95515`).** Şema kuşağı `PRAGMA user_version`'a yazıldı ve daha yeni
kuşaklı depo reddediliyor. Göç **var olan bir depo dosyasına karşı** doğrulandı (CLAUDE.md
§7): dosya oluşturulup dolduruldu, sonra kuşak 0'a çekildi. Damga `migrate()` başarılı
olduktan sonra yazılıyor, böylece yarım göçmüş dosya "güncel" ilan edilmeden yeniden
deneniyor. Tek yön kapanıyor (→ §6.2).

**Güvenilmez girdi (`50d0598`, `c6142c2`).** Çapa değerleri git'e **pathspec** olarak
gidiyordu ve git varsayılan olarak glob uyguluyor: `core/src/signals/g?t.ts` `ls-tree`'de
bulunmuyor ama `log`'da eşleşiyor → `missing_now`, `DURUM:` deseniyle birleşince 0,7
suspect. Var olmayan bir yol, gerçek bir notu şüpheliye çeviriyordu. İki katman: git
tarafında `--literal-pathspecs` (git 2.50.1'de ölçüldü), model tarafında glob
metakarakteri / baştaki `:` / `..` / mutlak yol taşıyan `file_path` reddi ·
`noteTimestamp` notun kendi `modified`/`created`/`date` alanını denetlemeden kabul edip
git'in `--since` sınırına veriyordu — yani **denetlenen not kendi denetim penceresini
kapatıyordu** (ölçüldü: aynı çapa geri düşüşle `churned/0.2`, `modified: 2099` ile
`ok/0`); damga artık içe alma anına kelepçeli · girintili frontmatter alanları ebeveyn
başlığa bakılmadan tek düz haritaya toplanıyordu, yani `presentation:` altındaki
`modified:` gerçek denetim damgası sayılıyordu; artık yalnız `metadata:` altı kabul
ediliyor · not boyutu 256 KiB'a kelepçelendi (gerçek korpustan: 86 notta p50 2,4 KB, p99
31 KB, maks 45 KB; geniş 131 notluk ölçümde p99 75 KB, maks 109 KB → en büyük gerçek notun
~2,4 katı pay).

**Hüküm bütünlüğü (`4a04c47`).** Dört yol ölçümün desteklemediği hüküm üretiyordu:
başarısız sınıflama önceki çelişki hükmünü siliyordu (§4) · tek bir olgu iki "bağımsız"
sinyal sınıfını besliyordu (`filesMatchingSuffix` **indeksi** okuyor, hüküm ise **ağacı**
— staged-ama-ağaçta-yok bir dosya hem `never_existed` 0,5 tavanına hem `born_invalid`
0,2'ye sayılıp 0,7 üretiyordu) · eksik sınıflama temiz sayılıyordu (şema-geçerli **boş**
`verdicts` dizisi `ok:true` dönüyordu, yani "sınıflanmadı" ile "sınıflandı, çelişki yok"
ayırt edilemiyordu) · git alt süreç yayılımının koşum çapında tavanı yoktu.

**Kaynak (`4a04c47`, `c6142c2`).** Tek notluk bir denetim **147 sıralı git süreci**
doğuruyordu (uçtan uca ölçüldü: 3 kurulum + 64 `ls-tree` + 32 `log` + 16 `ls-files` + 32
`rev-list`); bütçe gerçek bir koşumdan türetildi — 28 notluk altın silo, 260 çapa, 548 git
süreci / 8,4 sn = çapa başına 2,11 — ve çapa başına 3 + sabit tabana ayarlandı, böylece
gerçek koşum tavanı hiç görmüyor ama patolojik tek not koşumun tamamını yiyemiyor · 100 MB
tek `.md` dosyası 100 MB'lık satır olarak saklanıyordu ve bu depoda hiçbir şey silinmiyor
→ 256 KiB tavanı (yukarıda).

**Görünürlük ve sıra (`1c4fe02`, `9c8aa33`).** Kuşak kapısı `enableWal`'dan **sonra**
koşuyordu, yani reddedilen daha yeni depo yine de kalıcı `journal_mode`'unu DELETE→WAL
değiştiriyordu; "dosyaya dokunmadan reddediyoruz" iddiası yanlıştı. Etki hafif, iddia
opsiyonel değil · tavanı aşan not her içe alımda kırpılıyor ama "unchanged" erken dönüşü
`import_note_truncated` olayını atlıyordu: kullanıcı kırpmayı bir kez görüp bir daha
görmüyor, denetçi ise her koşumda hiç tam okumadığı bir gövdeye hüküm veriyordu.

**Açlık (`383dee0` → `64725c6` → `723aa80` → `cf59a84` → `483f11b`).** §3'te tablo hâlinde;
altıncı biçim bilinerek açık (§3.3).

## 6. Guard ve demote'lar — her biri varsayımıyla

### Guard'lar (kök çözüm DEĞİL, varsayımı adlandırılmış)

1. **`wall-clock-lease-theft` → guard.** Bayatlık `Date.now() − Date.parse(heartbeat_at)`
   ile ölçülüyor; ileri bir saat sıçraması taze bir canlı sahibin satırını anında
   silinebilir yapıyor. *Neden kök çare yok:* **süreçler arası monotonik saat yok** —
   iki ayrı süreç ortak bir monotonik referansı paylaşamıyor, dolayısıyla sıçrama
   *engellenemez*, yalnız *görünür* kılınabilir. *Enforcement:* gelecekteki bir kalp atışı
   damgası artık saat uyuşmazlığı kanıtı sayılıp `scan_lock_clock_skew` olayına yazılıyor;
   ayrıca bitişteki senkron sahiplik okuması (`a513424`) sessiz bir bozulmayı gürültülü
   bir hataya çeviriyor. *Varsayım:* operatör olayları okuyor ya da en azından koşum
   başarısızlığını fark ediyor. *Sınanmayan:* OS düzeyinde NTP düzeltmesi ve
   suspend/resume zamanlaması — probe kararı enjekte edilen saatle ölçtü.

2. **`mixed-version-lock-takeover` → guard, tek yön.** Kalp atışı öncesi bir binary
   `heartbeat_at`'i hiç yazmıyor; yeni okuyucu NULL atışı `acquired_at`'e düşürdüğü için
   **hâlâ çalışan** eski bir yazarın kilidini yalnızca işi uzun sürdüğü için çalıyor.
   `PRAGMA user_version` kuşak damgası bu yönü kapatmıyor — kapattığı yön "yeni kod +
   daha yeni depo". *Neden ters yön kapanamaz:* damgayı hiç okumayan bir sürüme onu
   okumak öğretilemez; ters yön ancak **damgayı okuyan bir sürüm yayınlandıktan sonra**
   yayınlanan sürümler arasında kapanır. *Varsayım:* aynı merkezi depoya kalp atışı
   öncesi bir binary ile 10 dakikadan uzun koşum yapılmıyor. *Sınanmayan:* tarihsel
   `5c7f7c7` binary'sinin kendisi çalıştırılmadı (worker'ın git yasağı; ağaçta tarihsel
   kaynak anlık görüntüsü yok) — probe yalnız güncel okuyucunun legacy-satır yolunu ölçtü.

### Demote'lar

3. **`heartbeat-renewal-error-ignored` (high → demote).** İddia: tazeleme UPDATE'leri
   sürekli hata verirken rakip bir bağlantı satırı yazabiliyor, sahip bunu fark etmiyor.
   *Demote gerekçesi — varsayım KOD davranışı, operatör alışkanlığı değil:* probe'un
   enjekte ettiği hâl ("benim atışım yazamıyor ama rakip yazabiliyor") doğada oluşmuyor,
   çünkü `SQLITE_BUSY` **bağlantı düzeyinde** vuruyor, tek bir ifadeye değil. Ölçüldü:
   çekişme altında kalp atışı 5268 ms, iş yazımı 5256 ms bloklandı — **asimetri yok**.
   Yani atış yazamıyorsa iş de yazamıyor. *Ayrıca yapısal olarak nötrleşti:* `a513424`
   sonrası hüküm bayrağa değil bitişte okunan satıra dayanıyor, dolayısıyla tik'in hiç
   koşmaması sonucu değiştirmiyor. *Guard olarak kalan:* yutulan tazeleme hataları
   sayılıp bitişte tek olay olarak yazılıyor. *Varsayım çökerse:* `node:sqlite`'ın
   bağlantı düzeyinde değil ifade düzeyinde meşgul döndüğü bir sürüm/derleme çıkarsa
   bulgu canlanır. *Sınanmayan:* fiziksel disk-dolu / salt-okunur dosya sistemi.

4. **`unbounded-append-only-retention` (med → demote, sonra ÜCRETSİZ KAPANDI).** İddia:
   aynı notun her değişimi tam gövdeyi yeni satır olarak ekliyor, eskisi yalnız
   `superseded` işaretleniyor; 1 MiB'lık 20 sürüm = 20 MiB + 19 silinemez olay.
   *Demote gerekçesi:* append-only bu ürünün **değişmezi**, bir kusur değil — CLAUDE.md
   §3.2: "There is no delete operation... Archive and restore. Never delete." Yanlış
   pozitifin maliyetinin sıfır olması tam da bu tasarıma bağlı. *Sonra ücretsiz kapandı:*
   `c6142c2`'nin 256 KiB tavanı revizyon başına maliyeti sınırladığı için probe
   kendiliğinden yeşile döndü — 1 MiB'lık sürümler artık 256 KiB olarak saklanıyor.
   *Varsayım:* 256 KiB × revizyon sayısı, tek kullanıcılı yerel bir depo için kabul
   edilebilir. *Sınanmayan:* çok uzun koşumda disk sayfalaması ve WAL büyümesi.

## 7. Doğrulama satırı

- **Doğrulama turu sayısı: 6 koştu.** Protokol tavanı **3**'tü; tavan sıfır blocker ile
  kapanmadığı ve desen (§3) net olduğu için **Burak açıkça 3 tur daha yetkilendirdi**.
  M2'de aynı noktada karar "dördüncü yama turu değil, kök tasarım değişikliği" olmuştu;
  M3'te karar "kök tasarım değişikliğini yap **ve** ardından doğrulamaya devam et" oldu —
  ve 4. tur haklı çıktı: kök çare olan kimlik damgasının içinde de bir açlık yolu vardı.
- **Tur 1 → 4 bulgu.** Dördü de düzeltmelerin kendisinde. En ciddisi §4'teki çapa-yolu
  yüzeyi. 4/4 probe kırmızıdan yeşile.
- **Tur 2 → 1 bulgu.** `classification-candidate-starvation`; K7'nin 21 kenarında 8 koşum
  boyunca ölçüldü. rc=2 (§8).
- **Tur 3 → 2 bulgu.** Biri low (yazılı sınır iddiasının ihlali), biri med (churn altında
  konumsal imlecin çökmesi; 6 koşum, iki tam döngü).
- **Tur 4 → 1 bulgu, low.** `candidate-starvation`: bütçe < aktif yüzey sayısı iken
  tie-break'in yüzey adıyla başlaması. **CLI bu bütçe geçersiz kılmasını dışarı
  açmıyor** — yani süreç-içi bir çağıran gerekiyor; low sınıflandırması buradan.
- **Tur 5 → 1 bulgu, med.** `recurring-surface-starvation`
  (`core/src/signals/classify.ts:235`, probe ana ağaçta rc=1). Damga sınıflarının tümüyle
  tüketilmesi; 12 koşumda `cross=20, intra=0, frontmatter=0` ölçüldü. Dalga H ile kapandı
  (§3.1).
- **Tur 6 → 0 bulgu. SON TUR.** Bu **boş bir teslimat değil**; turun kapsama tablosu:
  - rezervasyon ve artık turu için **439.375 yapılandırma**;
  - kapsama sınırı iddiası için **2.906.545 yüzey/kimlik dağılımı** — iddia edilen üst
    sınırı aşan tek örnek çıkmadı;
  - determinizm **dört farklı girdi sırasında**;
  - churn ve üçüncü eksenler: yüzeyin sıfırlanıp geri gelmesi, proje başına damga
    izolasyonu, `kind` birliği;
  - terfi ettirilen testlerin **eski davranışı gerçekten reddettiği**.

  *`not examined`:* geçmiş bir commit geri alınarak **gerçek rollback koşumu yapılmadı**
  (worker'ın mutlak git yasağı).

  *`out of scope` — SONRAKİ DENETİMİN KAPSAMI:* `core/src/signals/classify.ts:312` ve
  `core/src/store/classify-stamps.ts:43`. Kalıcı damga tam `Number.MAX_SAFE_INTEGER`
  olduğunda sonraki damga güvensiz sayıya çıkıyor, depo yazımı reddediyor ve **aynı aday
  seçimi tekrarlanabiliyor**. Bugün ölçülmedi, kapsam dışı bırakıldı, kaydedildi.
- **Son turun blocker sayısı: 0** → döngü mekanik olarak sonlandı; tur 7 tetiklenmedi.
  *Şerh:* sıfır blocker "hiçbir şey kalmadı" demek değil — §3.3'teki altıncı biçim tur 6'nın
  brief'inde "bilinen, rapor etme" olarak listeliydi ve bu sıfırın kapsamında değil.
- **Ölçüm ağacı:** av turunun 16/16 probe'u ve doğrulama turlarının probe'ları
  **ana ağaca** karşı (`AUDIT_ROOT`) üretildi ve doğrulandı; lane worktree'leri tek
  kullanımlıktı ve hiçbiri entegre edilmedi. İki istisna doğrulama turu 1'de: iki probe
  worker'ın mutlak git yasağı nedeniyle **worker tarafından koşturulmadı**
  (`confidence: unverified`) — ikisini de mimar ana ağaçta koşturdu ve ikisi de üredi.

## 8. Probe'un teste terfisi — rc=2 olan iki probe

İki probe ne yeşil ne kırmızı döndü; ikisinde de iddia ayaktaydı ve **kalıcı teste terfi
ettirilerek** kapatıldı.

1. **`suffix-index-double-count` → rc=2.** Sebep bulgunun kendisi değil: `50d0598`'in
   eklediği `--literal-pathspecs` bayrağı, probe'un sahte-git ayrıştırıcısını bozdu —
   ayrıştırıcı alt komutu argv'de **sabit bir konumdan** okuyordu. (Aynı kırılganlık
   ürünün kendi test koşumunda da vardı ve `50d0598` içinde düzeltildi: harness artık
   komut öncesi seçenekleri atlıyor, yerleşim varsaymıyor.) İddia kalıcı teste terfi etti
   ve ana oturum testi doğruladı.

2. **`classification-shared-note-starvation` → rc=2.** Sebep: seçicinin sözleşmesi
   probe'un yazıldığı andan sonra değişti (`selectCandidates` imzası ve dönüşü). İddia
   teste terfi etti, ve **düzeltme öncesi kodda kırmızı olduğu geçici bir worktree'de
   ayrıca ölçüldü** — yani terfi, iddiayı ölçmeden emekliye ayırma değil.

**Kural olarak kalan:** bir probe'un rc=2 dönmesi "bulgu geçersiz" demek değil, "probe'un
ölçüm aparatı bayatladı" demek. İkisi de kalıcı teste dönüştürülmeden kapatılsaydı iddia
ölçülmemiş olarak kaybolurdu.

### 8.1 Bugün YANILTICI hâle gelen iki probe — sonraki denetim için kayıt

Bu iki dosya bugün yeniden koşturulduğunda kapatıldıkları andaki verdikti vermiyor. İkisi
de **adalet regresyonu değil**; ikisi de bir sonraki denetimi yanlış yöne sürer.

1. **`surface-quota-coverage-bound.sh` — `cf59a84`'te rc=0 idi, bugün rc=1.** Sebep: probe,
   dalga G'nin **artık çürütülmüş** 3-koşum kapsama iddiasını kodluyor; dalga H o sınırı
   4'e taşıdı (§3.2). Yani kırmızılık kodun bozulduğunu değil, **probe'un ölçtüğü sınırın
   değiştiğini** gösteriyor. *Karar gerekiyor:* emekliye ayrılmalı ya da yeni `max(...)`
   ifadesine göre güncellenmeli. Bugün ikisi de yapılmadı.
2. **`classification-shared-note-starvation.sh` — rc=2, ve `cf59a84`'te DE rc=2'ymiş.**
   Yani bir süredir sessizce **hiçbir şey ölçmüyor**; bugün fark edildi. İddiası kalıcı
   teste terfi ettiği için kayıp yok (yukarıda, madde 2), ama dosyanın kendisi yeşil/kırmızı sinyali
   üretmiyor.

**Ders:** bir probe'un verdikti, ölçtüğü iddia değiştiğinde sessizce anlamını yitiriyor.
rc=0 kalan bir probe'a güvenmek ile rc=1'e bakıp regresyon ilan etmek aynı hatanın iki
yüzü — probe'un **hangi sürüm iddiayı** kodladığı yazılı olmalı.

## 9. Kırmızı kalan probe'lar — neden kırmızı

1. **`clock-jump-steals-live-lock`** — guard, kök çare yok. Süreçler arası monotonik saat
   yok (§6.1). Probe *önlemeyi* ölçüyor; kod *görünürlüğü* sağlıyor. Probe'un ölçtüğü şey
   ile ürünün vaat ettiği şey artık farklı, ve bu bilinçli.
2. **`mixed-version-null-heartbeat`** — tek yön kapandı (§6.2). Probe eski kodun canlı
   kilidinin çalınabildiğini ölçüyor; kuşak damgası ters yönü kapatıyor. Damgayı okuyan
   bir sürüm yayınlanana kadar kırmızı kalacak, ve bu **beklenen** bir kırmızı.
3. **`path-regex-quadratic`** — **M4'e ertelendi, gerekçesiyle.** `PATH_RE`, eşleşmeyen
   uzun bir `[\w.-]` dizisinde her başlangıç konumundan yeniden tarıyor ve `extractAnchors`
   regex'i iki kez (önce `matchAll`, sonra `replace`) çalıştırıyor. Ölçüm net karesel:
   4 KiB 15,7 ms · 8 KiB 59,3 ms · 16 KiB 242 ms · 32 KiB 1016 ms — **her katlamada tam 4×**.
   Lane'in bağımsız ölçümü aynı eğriyi verdi (8→16→32 KiB oranları 4,28× / 3,77× / 3,81×;
   100 KiB'da 22,77 sn).
   - *Çare ölçüldü:* lookbehind ile doğrusal hâle geliyor, **18.180 ms → 0,63 ms**.
   - *Neden bugün uygulanmadı:* çare **çapa çıktısını değiştiriyor** (99 gerçek dosyanın
     1'inde), yani altın sette yeniden ölçüm istiyor. Skalerin bozulmadığını kanıtlamadan
     karar yoluna dokunulmuyor.
   - *Bugün ne yapıldı:* 256 KiB tavanıyla **kuşatıldı** — maliyet sınırsızdan sınırlıya
     geçti. Tavandaki en kötü hâl not başına ~65 sn; bu iki bağımsız ölçümle sabitlendi
     (ekstrapolasyon ~65 sn, patolojik fixture 64,3 sn). Tavanı düşürmek kurtarmıyor
     (128 KiB hâlâ ~16 sn) ve meşru notları kırpmaya başlar.
   - *Şerh:* `c6142c2`'nin gövdesi bunu açıkça yazıyor — "The cap is not a fix for the
     quadratic path regex and does not pretend to be."

## 10. Karar kalitesi bozuldu mu — altın set kontrolü

Bu denetimin risk profili M1/M2'den farklı: 23 bulgunun büyük kısmı **karar yolunun
kendisine** dokundu (skor aritmetiği, çapa ölçümü, aday seçimi). Dolayısıyla "kusur
kapandı" yetmiyor; **skalerin bozulmadığı** da gösterilmeliydi.

| Ölçüm | Yakalama | Yanlış alarm | Rapor |
|---|---|---|---|
| r2 | 5/17 | 1/11 | `docs/olcumler/2026-08-12-m3-altin-set-olcumu-r2.md` |
| r3 | **6/17** | **0/11** | `docs/olcumler/2026-08-12-m3-altin-set-olcumu-r3.md` |
| r4 | 6/17 | 0/11 | **yazılmadı — yalnız ölçüldü** |
| r5 | 6/17 | 0/11 | **yazılmadı — yalnız ölçüldü** |

**r3, r4 ve r5 arasında 28 notta 0 fark.** Yani 23 bulgu düzeltilirken karar kalitesi
ne iyileşti ne bozuldu — ve bozulmadığı ölçülerek biliniyor, varsayılarak değil.

**Şerh:** r4 ve r5 için rapor yazılmadı. Koşumlar yapıldı ve karşılaştırıldı, fakat
r1/r2/r3 gibi belgelenmiş bir ölçüm dosyası yok. Bir sonraki turda bu sayılara
dayanılacaksa önce koşum çıktıları doğrulanmalı (CLAUDE.md §1).

**Ayrıca duran gerçek:** M3'ün çıkış kapısı (yakalama ≥ hedefe ulaşma) **kapanmadı** —
6/17 hâlâ hedefin altında. Bu denetim o kapıyı kapatmayı hedeflemedi; hedefi kapının
altındaki kodun doğru olduğunu göstermekti.

## 11. Tekrarlayan sınıflar — CLAUDE.md kural adayları

**Kural YAZILMADI.** Aşağıdakiler defterin `rule_candidate` satırlarına
`pending-user-approval` verdiktiyle kaydedildi; CLAUDE.md'ye ekleme Burak'ın onayıyla olur.

1. **`unbounded-subprocess-fanout` — 2 kez.** M2'nin `audit-anchor-subprocess-budget`
   bulgusu (dün, `unverified` kaldı) ve bugün `resource` lane'inin uçtan uca ölçtüğü
   **147 çağrı**. İki ayrı denetim, aynı sınıf, ikincisinde ölçümle.
   *Aday kural:* alt süreç doğuran her yola koşum çapında bir bütçe yazılır ve bütçe
   **gerçek bir koşumdan** türetilir (burada: 548 süreç / 260 çapa = 2,11 → 3 seçildi),
   tahminden değil.

2. **Açlık (starvation) — bugün 6 biçim.** Not damgası → konumsal imleç → kimlik damgası →
   tie-break sırası → yüzeyler-arası kota tabanı → **yüzey-içi sel (açık)** (§3, §3.3).
   *Aday kural:* türetilmiş ve koşumlar arasında değişen bir küme üzerinde **konum**
   tutulmaz; adalet iddiası ancak **kimliğe** bağlanınca churn'e dayanır. Ve bir adalet
   düzeltmesinin probe'u **churn altında** koşulmadıysa sınıf kapanmış sayılmaz.
   *Bu maddenin asıl ağırlığı:* altı biçim, **sonlanma kuralının tur sayısına değil aynı
   sınıfın tekrarına bakması gerektiği** tezinin kanıtı. Protokol 3 turda dursaydı bugün
   4., 5. ve 6. biçim ölçülmemiş olacaktı; buna karşılık sınıf altı biçimden sonra da
   kapanmadı — yani "sınıf tekrar ediyorsa devam et" kuralı da tek başına sonlanma
   garantisi vermiyor, yalnızca duruşu **bilinçli** kılıyor.

3. **"Yazılı iddia ölçülmeden doğru sayıldı" — 4 kez.** Kapsama sınırının **dört** sürümü
   (küresel ⌈N/M⌉ → yüzey başına → ölçülmüş ⌈N/bütçe⌉ → rezervasyonla
   `max(⌈N/bütçe⌉, max_yüzey ⌈N_yüzey/rezerv_yüzey⌉)`; **üçü** ölçümle yanlışlandı — ilk
   ikisi 30 yapılandırmada, üçüncüsü 501 yapılandırmada, §3.2), artı
   `HEARTBEAT_STALE_MS`'in yanlış gerekçesi.
   *Aday kural:* yorumda ya da commit gövdesinde yazılan **niceliksel bir garanti**
   (sınır, tavan, "en fazla N koşumda") aynı commit'te bir testle ölçülür. Yanlış
   yazılmış bir iddia, hiç iddia olmamasından kötüdür — çünkü sonraki denetim onu
   *doğrulanmış* sanıp üzerine inşa ediyor.

*Not:* M2'nin şema göçü kuralı (3 kez, onaylandı, CLAUDE.md §7) bu denetimde **kâr etti**:
`7c95515` ve `383dee0` göçlerini var olan depo dosyalarına karşı doğruladı, `723aa80` ise
yalnız yeni TABLO eklediği için `CREATE TABLE IF NOT EXISTS`'in yettiğini yazılı olarak
gerekçelendirdi. Kural sınıfı bu turda **tekrarlamadı** — kuralın kendisi bir ölçüm.

## 12. Açık kalemler

1. **`path-regex-quadratic`'in kök çaresi M4'e borçlu.** Lookbehind ölçüldü (18.180 ms →
   0,63 ms) ama çapa çıktısını 99 dosyanın 1'inde değiştiriyor. M4'te: çareyi uygula →
   altın seti yeniden koş → skaler bozulmadıysa sabitle. Sayılar `parse.ts`'te sabitin
   yanında kayıtlı.
2. **`mixed-version-lock-takeover`'ın ters yönü** ancak kuşak damgasını okuyan bir sürüm
   yayınlandıktan sonra kapanır. Sürüm atlandığında bu kalem yeniden değerlendirilmeli.
3. **`wall-clock-lease-theft`** OS düzeyinde NTP/suspend ile hiç ölçülmedi; guard'ın
   gerçek sahada gürültü mü sessizlik mi ürettiği bilinmiyor. `scan_lock_clock_skew`
   sayacı izlenmeli.
4. **r4/r5 ölçüm raporları yazılmadı** (§10). Bu sayılara dayanmadan önce doğrulanmalı.
5. **M3 çıkış kapısı kapanmadı** — yakalama 6/17. Hafızadaki `m3-durum.md` üç yapısal
   sebep kaydediyor; bu denetim onlara dokunmadı.
6. **Ertelenen üç kalem ve prompt enjeksiyonu guard'ı** M3 denetim bulguları
   dosyasından devrediyor; bugünkü diff prompt yüzeyini genişletmediği için yeniden
   ölçülmediler.
7. **Kilidin heartbeat kök değişikliği** (karar verildi, uygulanmadı) hâlâ açık —
   bugünkü guard'lar (§6.1, §6.2) o kararın yerine geçmiyor, onu **erteliyor**.
8. **Süreçler arası eşzamanlılık** hâlâ enjekte edilmiş saatle ve sahte git'le ölçülüyor;
   gerçek çok süreçli koşum (M1'den devreden kalem) hâlâ ölçülmedi.
9. **Açlık sınıfının altıncı biçimi — yüzey-içi sel — AÇIK ve bilinerek bırakıldı** (§3.3).
   Çaresi rezervasyon değil, damga 0'ın mutlak önceliğini yaşlandırmak. Tur 6'nın sıfır
   bulgusu bu kalemi kapsamıyor: brief'te "bilinen, rapor etme" olarak listeliydi.
   Dalga F'nin churn testi bunu yakalayamaz — testin kalıcı adayları zaten ilk koşumu
   kazanıyor, yani yeni bir test gerekiyor.
10. **`Σrezerv > bütçe` için kapsama sınırının kapalı formu ÖLÇÜLMEDİ** (§3.2). 51
    yapılandırmada sonlu kaldığı gözlendi; **ispat değil.** Bir sonraki denetim bu ifadeyi
    doğrulanmış varsayarsa §11.3'ün kendi sınıfını tekrarlamış olur.
11. **Damga taşması kapsam dışı bırakıldı, ölçülmedi** — `core/src/signals/classify.ts:312`
    ve `core/src/store/classify-stamps.ts:43`. Kalıcı damga tam `Number.MAX_SAFE_INTEGER`
    olduğunda sonraki damga güvensiz sayıya çıkıyor, depo yazımı reddediyor ve aynı aday
    seçimi tekrarlanabiliyor. **Sonraki denetimin kapsamı.**
12. **İki probe yanıltıcı hâle geldi** (§8.1): `surface-quota-coverage-bound.sh` (rc=0 →
    rc=1, çürütülmüş iddiayı kodluyor — emekliye ayrılmalı ya da güncellenmeli) ve
    `classification-shared-note-starvation.sh` (rc=2, `cf59a84`'te de rc=2'ymiş, bir
    süredir hiçbir şey ölçmüyor). İkisi için de bugün karar verilmedi.
13. **Gerçek rollback koşumu yapılmadı** — tur 6'da `not examined` olarak işaretlendi;
    geçmiş bir commit geri alınıp koşturulamadı (worker'ın git yasağı).
