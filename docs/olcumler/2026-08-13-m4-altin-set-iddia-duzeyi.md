# M4 · Altın setin iddia düzeyine çıkarılması + Codex–Claude uyuşmazlık ölçümü

**Tarih:** 13 Ağustos 2026
**Durum:** **KAPANDI.** İki bağımsız geçiş + hakemlik turu + üç politika kararı.
Altın set v1: `docs/olcumler/altin-set/golden-v1.jsonl` — 391 iddia, 28 not.
**Protokol:** `docs/olcumler/altin-set/PROTOKOL.md`
**Araçlar:** `tools/altin-set/validate.ts`, `tools/altin-set/compare.ts`
**Veri:** `docs/olcumler/altin-set/{claims-claude,claims-codex,conflicts,adjudged}.jsonl`

## 0. Neden

M3'ün çıkış kapısı **not düzeyinde ikili** bir ölçüte dayanıyordu (17 çürük /
11 geçerli). İki sorun ölçüldü:

1. 17 "çürük" notun **16'sı `kısmen-çürümüş`** idi. İkili etiket, tam da
   çoğunlukta en kaba yerinde duruyordu. M0 tablosunun kendi gerekçe sütunu
   zaten "7 iddia ayakta / 7 çökmüş", "8/9 iddia ayakta" diyordu — bilgi elde
   vardı ve etikette kayboldu.
2. M4'ün hakemi **iddia düzeyinde** hüküm verecek. Ölçüt not düzeyinde kalırsa
   M4'ün doğruluk sayısı M3'ün 6/17'siyle karşılaştırılamaz.

Ayrıca M0 §5 **Codex–Claude uyuşmazlık oranını** şart koşmuştu ve hiç
ölçülmemişti; M4'ün çapraz kontrol varsayılanı bu sayıya bağlı. İki bağımsız
geçiş bu iki işi tek koşumda yapıyor.

## 1. Pinler

| | |
|---|---|
| Denek repo | `~/Documents/unityaiPython` (GaMachine) |
| Pin | `b4065f1` · origin ref `19c623f` |
| Hafıza anlık görüntüsü | `~/.context-police/golden/2026-08-11-gamachine/` |
| Denetlenen not | 28 (`MEMORY.md` indeks, hariç) |

İki geçiş **ayrı ağaçlarda** koştu; Codex tarafı kendi pinli worktree'sini aldı.
Sebep: aynı ağaçta olsalardı bağımsızlık yalnız talimata dayanırdı.

## 2. Sonuçlar — iki geçiş

| | Claude | Codex |
|---|---|---|
| iddia | **390** | **606** |
| geçerli | 237 (%60,8) | 258 (%42,6) |
| çürük | 39 (%10,0) | 33 (%5,4) |
| doğuştan-yanlış | 5 (%1,3) | 18 (%3,0) |
| **ölçülemez** | **109 (%27,9)** | **297 (%49,0)** |
| not düzeyine yuvarlama (çürük) | 12/28 | 12/28 |
| not düzeyine yuvarlama (yanlış) | 14/28 | 16/28 |

İkisi de `validate.ts`'ten temiz geçti: şema, kanıt zorunluluğu, mükerrer id,
satır aralığı, 28 notun tam kapsanması.

## 3. Ana bulgu — çürüme seyrek ve yoğun

Not düzeyinde %61 çürük görünüyordu. İddia düzeyinde çürük iddia oranı
**%10** (Claude) / **%5,4** (Codex).

Çürüme birkaç notta toplanmış. Claude geçişinde:
`teslim-yolu-denetim-2` 12'de 7 · `unity-architect-mimari` 24'te 7 ·
`onay-kapisi-kapsami` 31'de 7 · `teslim-yolu-denetimi` 11'de 5.
Buna karşılık `unity-mcp-yerel-auth` 22 iddia taşıyor ve **hiçbiri çürük değil**
— M0 bu notu "kısmen-çürümüş" saymıştı.

**Tasarım sonucu:** "bu not çürük mü" sorusu yanlış çözünürlükte. Bir notun
%3'ü öldüğünde tüm notu şüpheli işaretlemek, ajanı %97 doğru bilgiden
mahrum bırakır. M4'ün hakemi iddia düzeyinde hüküm verdiği için bu sorun
kendiliğinden çözülüyor — ama ancak ölçüt de iddia düzeyindeyse görülebilir.

## 4. Ölçülemez oranı — %27,9 ile %49 arası

Bu iddialar dış CLI davranışları, ağ, canlı backend, kullanıcı beyanları,
tarihsel anlatılar, upstream karşılaştırmaları. **Denetçi bunları hiçbir zaman
yakalayamaz**, çünkü hakem koddur (CLAUDE.md §2.1).

Sonuç: yakalama oranının paydası `curuk + dogustan-yanlis` olmalı, tüm iddialar
değil. Aksi halde tavan yapay olarak düşer ve denetçi ölçülemeyen şeyi
kaçırdığı için cezalandırılır.

İki geçişin bu kovada bu kadar ayrışması (%27,9 vs %49) tek başına bir bulgu:
"ölçülebilir" tanımı sanıldığı kadar nesnel değil.

## 5. Codex–Claude uyuşmazlığı — M0'ın istediği sayı

`compare.ts`, satır aralığı örtüşmesiyle açgözlü bire-bir eşleme yapıyor.

**Üç ayrı sayı, karıştırılmamalı:**

| Ölçü | Değer |
|---|---|
| **Bölme uyuşması** (aynı iddiaları mı çıkardılar) | 212 eşleşme / 784 → **%27,0** |
| **Hüküm uyuşması** (eşleşenlerde aynı hüküm) | 169/212 → **%79,7** |
| **Sert çatışma** (biri geçerli, öteki yanlış diyor) | 13/212 → **%6,1** |
| **Not düzeyinde "çürük mü"** (bölmeye dayanıklı) | 24/28 → **%85,7** |

Karışıklık tablosunun tepesi (Claude → Codex):

| | sayı |
|---|---|
| gecerli → gecerli | 93 |
| olculemez → olculemez | 60 |
| **gecerli → olculemez** | **24** |
| curuk → curuk | 14 |
| gecerli → dogustan-yanlis | 6 |
| curuk → gecerli | 4 |

**Yorum.** Uyuşmazlığın büyük kısmı **ölçülebilirlik** tartışması, hüküm
tartışması değil: tek başına `gecerli → olculemez` hücresi 24 iddia. Codex
belirgin biçimde daha muhafazakâr — aynı kanıtla "ölçemedim" diyor.

Asıl hikâye bölme uyuşmasının düşüklüğü (%27): iki geçiş aynı notlardan
**farklı iddia kümeleri** çıkarıyor (606'ya karşı 390). Yani "iddia nedir"
sorusu, "bu iddia doğru mu" sorusundan daha az uzlaşılmış.

Not düzeyinde ayrışan 4 not: `codex-delegate-niyet`, `kabuk-olcum-tuzaklari`
(Claude çürük, Codex temiz); `lisans-karari`, `macos-build-mekanigi`
(Codex çürük, Claude temiz).

### 5.1 ALETİN KENDİ HATASI — ölçüldü ve düzeltildi

İlk ölçümde eşleme **yalnız satır aralığı örtüşmesine** dayanıyordu ve
**24 sert çatışma / %7,2** raporlandı. Hakemlik turu (§6) bu 24 kalemi bağımsız
olarak yeniden ölçtü ve **14'ünün (%58) hiç çatışma olmadığını** gösterdi:
iki geçiş **aynı satırdan farklı iddialar** çıkarmıştı ve ikisi de kendi
iddiasında haklıydı. Yoğun bir not tek satırda 5-6 iddia taşıyabiliyor.

Yani ilk raporlanan uyuşmazlığın çoğunluğu **modellerin değil aletin** ürünüydü.

Düzeltme: `compare.ts`'e metin benzerliği kapısı eklendi (örtüşme katsayısı,
eşik 0,40). Kapı, hakemliğin bağımsız verdiği sebebe karşı **doğrulandı** —
eşiği o cevaba uyacak biçimde ayarlamak aleti cevaba uydurmak olurdu, o yüzden
yapılmadı:

| hakemin verdiği sebep | n | ortalama benzerlik | kapıdan geçen |
|---|---|---|---|
| gercek-yargi | 3 | 0,72 | **3/3** |
| method-hatali | 6 | 0,55 | 5/6 |
| kapsam-farki (yapaylık) | 14 | 0,18 | **2/14** |
| olculemez-olmaliydi | 1 | 0,30 | 0/1 |

Kapı gerçek çatışmaların 8/9'unu koruyor, yapaylıkların 12/14'ünü eliyor.
Kusursuz değil: 2 yapaylık hâlâ geçiyor, 1 gerçek çatışma eleniyor.
**Eşik 0,40 bir varsayımdır, ölçüm değil.**

**Ders (genel):** bir uyuşmazlık ölçümünde ölçme aleti, ölçtüğü şeyle aynı
büyüklükte hata üretebiliyor — burada aletin hatası (%58) gerçek sinyalden
(%12,5) büyüktü. Bunu yakalayan şey **üçüncü bir ölçüm turu** oldu; iki geçişi
karşılaştırmak tek başına yetmedi.

**M4 için sonuç:** çapraz kontrol kendini ödüyor ama sanıldığından dar bir
yerde. Hakemliğin sınıflandırmasına göre 24 çatışmanın yalnız **3'ü gerçek
yargı ayrılığı** (334 ham eşleşmede %0,9); 6'sı bir tarafın komutu yanlış
kurmasıydı — ve bunlar çapraz kontrolle değil, **kanıtı yeniden koşturarak**
kapanıyor, çok daha ucuza. Sıra önemli: önce aynı modele kanıtı yeniden
koşturt, ikinci modele ancak ondan sonra sor.

## 6. Hakemlik turu — üçüncü, bağımsız ölçüm

24 sert çatışmanın her biri üçüncü bir turda **yeniden ölçüldü**. Çerçeve
CLAUDE.md §2.1'e göre kuruldu: hakeme iki tarafın iddiası yalnız *nereye
bakacağını* söyledi, *hangisinin haklı olduğunu* değil — hüküm hakemin kendi
koşumundan geldi.

Girdi `docs/olcumler/altin-set/conflicts.jsonl`, çıktı `adjudged.jsonl`.

**Çatışma neden doğmuş:**

| sebep | sayı | oran |
|---|---|---|
| `kapsam-farki` — eşleme yapaylığı, gerçek çatışma değil | 14 | %58,3 |
| `method-hatali` — bir taraf komutu yanlış kurmuş | 6 | %25,0 |
| **`gercek-yargi`** | **3** | **%12,5** |
| `olculemez-olmaliydi` | 1 | %4,2 |

**Kazanan:** Claude 11 · Codex 9 · both-partly 2 · neither 2. İki geçiş
arasında sistematik bir üstünlük yok; hata biçimleri farklı (Claude daha çok
kapsamı genişletiyor, Codex daha çok "ölçemedim" diyor).

**Hakem hükümleri:** geçerli 8 · çürük 8 · doğuştan-yanlış 7 · ölçülemez 1.

### 6.1 İki nota dair keskin bulgu

**`custom-tools-cs-eksik` — çekirdek iddia doğuştan yanlış.** Notun "sıfırdan
yazılmalı" dediği akış (attribute → reflection → köprüye bildirim) pin'de
birebir var: `ToolDiscoveryService.cs:26`, `McpForUnityToolAttribute.cs`,
`WebSocketTransportClient.cs:557`, `EditorPrefKeys.cs:56`. Hepsi `9ff9007`
(12 May 2026) — nottan **2,5 ay önce**. Üstelik notun "çeldirici, ilgisi yok"
diye uyardığı dosyanın XML dokümanı zaten "custom-tool registration payloads"
diyor; yani uyarı tam ters. M0 bu notu "kısmen-çürümüş" saymıştı.

**`unity-architect-mimari` — not bayat bir kaynaktan kopyalanmış.** Transcript
ölçümü: not **tek yazımda** `2026-07-27T06:48:24`'te doğdu (öncesinde sıfır
geçiş). Anlattığı kod ise 2026-05'te değişmişti. Yani 6 çatışmalı iddianın
4'ü çürüme değil **doğuştan-yanlış**. M0'ın bu not için "7 ayakta / 7 çökmüş"
okuması, değişim-tetikli tasarımın (CLAUDE.md §2.4) ölçüsü olarak
kullanılamaz — burada kod değişmedi, not yanlış doğdu.

**Bu ikisi birlikte bir tasarım uyarısı:** doğuştan-yanlış notlar, çürüme
sinyalleriyle (çapa kayması, commit yoğunluğu) **yakalanamaz** — çünkü ortada
bir değişim yok. Onları yakalayan tek şey içeriğin diske karşı ölçülmesi, yani
hakemin ta kendisi. M4'ün hakemi bu yüzden yalnız bir doğrulama katmanı değil,
mekanik sinyallerin kör olduğu bir sınıfın **tek** dedektörü.

## 7. Protokol sapmaları — kayıt altına alınıyor

Etiketleyiciler kendileri bildirdi:

1. **`bekleyen-isler` örneklendi.** 686 satırlık akış kaydından Claude geçişi
   "en değerli 24" iddiayı seçti; kaç iddianın dışarıda kaldığı bilinmiyor.
   Bu kayıt **eksik kapsamlı** sayılıyor. Protokol §2'ye sessiz örnekleme
   yasağı bu vakadan sonra eklendi.
2. **15 iddia "tavanı" iki notta aşıldı** (`onay-kapisi-kapsami` 31,
   `unity-architect-mimari` 24). Doğru davranış — protokol §2 bu sayının tavan
   değil sağlama olduğunu söyleyecek şekilde düzeltildi.
3. **`jarvan-asistan`'ın iki `curuk` hükmü pin yerine bugünkü diske
   dayanıyordu** (`~/.gemini/settings.json`). Protokol §1 ihlali; ikisi
   `olculemez`e çevrildi ve `evidence` alanına düzeltme notu düşüldü.
   Ölçülemeyen şey suçlamaya dönmez.

## 8. Doğrulama izi

- Her iki JSONL `validate.ts`'ten rc=0.
- `validate.ts` **on yönde** sınandı: geçmesi gereken 2 durumda geçti, kalması
  gereken 8 durumda kaldı (bilinmeyen hüküm, kanıtsız hüküm, yanlış sözlük,
  eksik kapsam, ters satır aralığı, mükerrer id, bozuk bayrak). Hiç geçemeyen
  bir kabul komutu, doğru işi "başarısız" diye döndürür — bu yüzden iki yön de
  sınandı.
- Dört Codex lane'inin her biri bağımsız denetlendi: changelog dolu, ayak izi
  yalnız teslimat dosyası, pinli worktree `git status` **boş**, kabul komutu
  mimar tarafından yeniden koşuldu (4/4 rc=0).
- **Bağımsızlık kanıtı:** her lane'in `RAW_OUTPUT.log`'undaki komutlar tarandı;
  yasak yollara (`claims-claude*`, Context Police deposu, scratchpad) giden
  **sıfır** komut.
- Kaçak süreç yok (`pgrep 'codex app-server'` boş).

## 9. Politika kararları ve altın setin kapanması

24 çatışmanın 15'i hakemlik turunda mekanik olarak kapandı. Kalan **9 kalem**
gerçekten insan kararı istiyor ve bunların çoğu tek bir kalemle ilgili değil,
**altın setin politikasıyla** ilgili. Üç politika sorusu altında toplanıyorlar:

**(a) "Tarihsel" bloklar iddia sayılacak mı?** — C14, C23
Notlar sık sık geçmiş bir arızayı şimdiki zamanda anlatıyor, hatta bazıları
bloğu "aşağısı arızanın kaydı, tarihsel" diye etiketliyor. Sayılırsa denetçi
orayı işaretlediğinde yanlış alarm üretmiş olur; sayılmazsa gerçekten bayat
beyanlar ölçüm dışı kalır.

**(b) Notun kendi içindeki düzeltme kazanır mı?** — C24
`unity-mcp-toggle-internet-bagimli` notu 37-43. satırlarda kendi bloğunu
açıkça düzeltiyor ("DÜZELTME 29 Tem 2026 … artık doğru değil"). Denetçi
düzeltilmiş bloğu işaretlerse haklı mı, gereksiz mi?

**(c) Ölçülemeyen sınıflar paydadan çıkarılacak mı?** — C13, C06, C07
Toplanan test sayıları (pytest kurulu değil), depoda çelişen iki sürüm dizgisi,
lisans yargısı gerektiren nupkg kapsamı. Bunlar "yanlış" değil, "bu ortamda
ölçülemez".

**Kalan tekil kalemler:** C12 (iddia bir kod yolunda doğru, notta genel gibi
okunuyor — kapsam etiketi eksik), C17 (kısmi kayma: uyarı artık yalnız bir alt
küme için geçerli), C22 (tek satır iki ayrı iddiaya bölünmeli).

Ayrıntı ve kanıtlar: `docs/olcumler/altin-set/adjudged.jsonl`, `note_for_human`
alanı.

Hakemlik bitene kadar duran kaynak:

```bash
# Claude tarafının pinli worktree'si — kanıt yeniden koşumu için tutuluyor
git -C ~/Documents/unityaiPython worktree remove \
  /private/tmp/claude-501/-Users-burakemreerdemci-Documents-Context-Police/dfbcaaaf-3368-467c-a28b-15fce5e3e148/scratchpad/gm-b4065f1
git -C ~/Documents/unityaiPython worktree prune
```

## 10. Sınanmayanlar

- Uyuşmazlık oranı **tek koşumda, tek modelde** (`gpt-5.6-sol`) ölçüldü.
  Aynı modelin iki koşumu arasındaki oynaklık bilinmiyor — yani ölçülen farkın
  ne kadarı model farkı, ne kadarı koşum gürültüsü **ayrıştırılmadı**. Bu,
  raporun en zayıf noktası: "Claude ile Codex ayrışıyor" ile "aynı model iki
  kez ayrışıyor" bu veriyle ayırt edilemez.
- Her iki geçiş de **aynı protokolü** okudu. Protokolün kendisi ortak bir
  yanlılık kaynağı olabilir; bu ölçülmedi.
- **Hakemlik turu doğrulanmadı.** Çatışmaları üçüncü bir ölçüm karara bağladı,
  ama o ölçümün kendisi dördüncü bir tarafça sınanmadı. §5.1 tam olarak bunun
  neden önemli olduğunu gösteriyor: aletin hatası ölçülen sinyalden büyük
  çıkabiliyor.
- **`compare.ts` eşiği (0,40) kalibre edilmedi, seçildi.** 24 çatışmalık tek
  bir örnekleme karşı doğrulandı; başka bir veri kümesinde nasıl davranacağı
  bilinmiyor.
- Yalnız iki geçişin **uyuştuğu** iddialar hiç sınanmadı. İki model aynı hatayı
  yapıyorsa bu ölçüm onu göremez — ortak yanlılık, uyuşma olarak okunur.

---

## 11. ALTIN SET v1 — kapanış

`docs/olcumler/altin-set/golden-v1.jsonl` · **391 iddia · 28 not** ·
`validate.ts` rc=0.

Nasıl kuruldu: taban Claude geçişinin bölmesi (390 iddia) → 24 hakem hükmü
uygulandı → üç politika işlendi → C22 iki iddiaya bölündü (391).

| hüküm | sayı | oran |
|---|---|---|
| gecerli | 232 | %59,3 |
| **curuk** | **33** | %8,4 |
| **dogustan-yanlis** | **12** | %3,1 |
| olculemez | 112 | %28,6 |
| tarihsel | 2 | %0,5 |

**Denetçinin hedef kümesi: 45 iddia** (`curuk` 33 + `dogustan-yanlis` 12).
Yakalama oranının paydası budur — `olculemez` ve `tarihsel` düşer, çünkü
hakem kod olduğu sürece o iddialar ölçülemez.

Not düzeyine yuvarlama (M3 ile karşılaştırma zemini):
**çürük 13/28 · yanlış 15/28** (M0: 17/28).

### Uygulanan politikalar (karar: Burak, 13 Ağu 2026)

1. **Tarihsel bloklar sayılmaz, ayrı işaretlenir** (`tarihsel`, C14 · C23).
   Gerekçe: denetçinin ölçtüğü şey "bu not BUGÜN yanıltıyor mu"; tarihsel bir
   kayıt yanıltmıyor, arşivliyor. **Bilinen açık:** "tarihsel" etiketi notun
   kendi beyanı — bir yazar etiketleyerek denetimden kaçabilir. Ölçülmedi.
2. **Notun kendi düzeltmesi kazanır** (C24). Not bloğunu açıkça düzeltmişse
   blok çürük sayılmaz. Gerekçe: çürüme tanımı "ajan yanlış bilgiyle hareket
   eder" — düzeltme okunuyorsa etmiyor. **Bilinen açık:** düzeltmenin
   okunacağını varsayar; blok bağlamdan koparılırsa varsayım çöker.
3. **Bu ortamda ölçülemeyenler `olculemez`** (C13 · C06 · C07): toplanan test
   sayıları (pytest kurulu değil), depoda çelişen iki sürüm dizgisi, lisans
   yargısı gerektiren kapsam.

### Bilinen kapsama açığı — kayıt altında

Altın set **tek bir bölmeye** (Claude geçişi) dayanıyor. Codex geçişinin
eşleşmeyen **394 iddiası dışarıda**. Sebep: iki farklı bölme granülerliğini
birleştirmek iç içe geçen, mükerrer iddialar üretirdi ve küme kendi içinde
tutarsız olurdu.

Bunun bedeli ölçülü: Codex 606, Claude 390 iddia çıkardı — yani altın set
muhtemelen **eksik kapsamlı**. Veri duruyor (`claims-codex.jsonl`); birleştirme
ayrı bir iş ve ayrı bir bölme politikası gerektiriyor.

Ayrıca `bekleyen-isler` kaydı **eksik kapsamlı** (§7.1): 686 satırdan 24 iddia
seçildi, dışarıda kalanın sayısı bilinmiyor.

### Sıradaki

M4'ün geri kalanı bu ölçüt üzerine kurulabilir: iki eşik ayrımı, hakem, çıktı
sözleşmesi, çapraz kontrol. Çapraz kontrolün varsayılanı için §5.1'in sonucu
geçerli: önce kanıtı yeniden koşturt, ikinci modele ancak ondan sonra sor.
