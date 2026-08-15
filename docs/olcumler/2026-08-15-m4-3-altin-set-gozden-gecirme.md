# M4.3 — Altın setin gözden geçirilmesi: 39 yanlış alarmın hakemliği

**Tarih:** 15 Ağu 2026 · **Pin:** `b4065f1` (GaMachine, `~/Documents/unityaiPython`)
**Girdi:** `docs/olcumler/altin-set/golden-v1.jsonl` (391 iddia / 28 not),
`docs/olcumler/altin-set/hakem-full28-ciktisi.jsonl` (1210 iddia)
**Çıktı:** `docs/olcumler/altin-set/golden-v1-duzeltme-onerisi.jsonl` (uygulanmadı)

---

## 0. Sonuç önce

| Ölçüt | Önce | Düzeltmeden sonra |
|---|---|---|
| Yakalama (iddia düzeyi) | **37/45 · %82,2** | **53/60 · %88,3** |
| Yanlış alarm | **39** | **24** (4'ü belirsiz → doğrulanmış bant **20–24**) |
| Kaçan hedef | 8 | 7 |

39 yanlış alarmın **15'i altın setin kendi hatası** (%38,5), **20'si hakemin
hatası** (%51,3), **4'ü belirsiz** (%10,3).

İlk turda ölçülen alet hatası 1/5 = %20 idi. Tam kümede oran **iki katına
çıktı**: %38,5. Yani 39, hakemin hata sayısı olarak okunamaz — içindeki her üç
kayıttan biri aletin kendi kusuru.

Düzeltilmiş sayılar elle değil, **düzeltmeler uygulanmış bir altın set kopyası
scratchpad'de kurulup `score.ts` yeniden koşturularak** alındı. Koşum sırasında
skorlayıcı başka bir ajan tarafından değiştirildiği fark edildi; karşılaştırma
zemini kaymasın diye taban çizgisi (37/45 · 39) **aynı yeni sürümle** yeniden
ölçüldü ve değişmediği doğrulandı.

---

## 1. Yöntem

1. `score.ts` okundu. "Yanlış alarm" tanımı oradan geliyor: hakemin `curuk`/
   `dogustan-yanlis` dediği bir iddia, **satır aralığı örtüşen** en az bir
   `gecerli` altın iddiaya biniyorsa ve örtüşen hiçbir altın iddia "yanlış"
   değilse. Örtüşme ölçütü **satır**, metin değil.
2. 39 yanlış alarm ve 8 kaçan iddia, örtüştükleri altın iddialarla birlikte
   döküldü (yerleşik skorlayıcı yalnız ilk 10'unu basıyor).
3. Her kayıt için notun ilgili satırları okundu ve iddia **pin'e karşı** ölçüldü:
   `git -C ~/Documents/unityaiPython show b4065f1:<yol>` ve `git grep`. Depoya
   hiç yazılmadı, worktree kurulmadı.
4. Hüküm ekseni: iddia hakkında **kim yanlış** — hakem mi, altın set mi.

**GaMachine erişilebilirdi.** `b4065f1` yerinde, `feat(kapi): 8080'in kimliği
canlılıktan ayrıldı — YARIM`. Hiçbir iddia "ağaca ulaşılamadı" diye
`olculemez`e düşmedi.

### 1.1 Ölçüt hatası — bulguların hâkim şekli

39'un çoğunda hakem ile altın set **aynı iddia hakkında** anlaşmazlığa düşmüş
değil. Aynı **satırdaki farklı iki cümle parçası** hakkında konuşuyorlar.

`unity-architect-mimari:21` örnektir. Not tek satırda iki şey söylüyor:
`unity_ai_mcp/` (a) bizim iç MCP sunucumuz, (b) Antigravity ile ilgisi yok.
Altın set (a)'yı etiketlemiş, (b)'yi hiç etiketlememiş. Hakem (b)'ye hüküm
vermiş. Skorlayıcı satır örtüşmesi gördüğü için bunu çelişki sayıyor — oysa
ortada çelişki yok, **etiketlenmemiş bir iddia** var.

PROTOKOL §2 zaten "bir cümle iki doğrulanabilir ifade taşıyorsa ikiye bölünür"
diyor. 39 yanlış alarmın **13'ü** tam olarak bu kuralın uygulanmadığı yerler.
Bu, hafızadaki *ölçme aletinin hatası* dersinin üçüncü tekrarı: iki kaynağı
karşılaştıran her ölçümde **eşleme ölçütünün kendisi ayrıca doğrulanmalı.**

İkinci bir şekil: **çapa kayması.** Hem hakem hem altın set satır numarasını
yanlış yazıyor (hakem 3 kez, altın set 1 kez) ve skorlayıcı iddiaları yanlış
eşleştiriyor. `unity-architect-mimari#17` bunun en pahalı örneği — aşağıda.

---

## 2. 39 yanlış alarmın tablosu

`H` = hakem hatalı · `A` = altın set hatalı · `?` = belirsiz

| # | Not:satır | İddia (kim ne diyor) | Ölçüm | Hüküm |
|---|---|---|---|---|
| 1 | codex-delegate-niyet:27 | Hakem: `doctor.py` b4065f1'de yok | Dosya **GaMachine'de değil**, `~/Documents/codex-delegate/skills/codex-delegate/scripts/doctor.py`'de — ve orada duruyor. Hakem yanlış ağaca bakmış. | **H** |
| 2 | teslim-yolu-denetim-2:201 | Hakem: "ölçülmemiş tek konu" iddiası çürük | Hakemin metni notun 204-206. satırlarına ait, 201-203'e değil (çapa hatası). İçerik olarak da not "ölç" diyor; hakemin ölçmüş olması notu çürütmez. | **H** |
| 3 | unity-architect-mimari:21 | Hakem: "Antigravity ile ilgisiz" yanlış, çünkü `agy_provider.py:165` `unity_ai_mcp`'yi import ediyor | İmport doğru (ölçüldü). Ama notun 17-21. satırları bir **sözlük**: Antigravity=kullanıcının IDE'si, `unity_ai_mcp/`=bizim sunucumuz. İddia kimlik hakkında, kod bağımlılığı hakkında değil. | **H** |
| 4 | unity-architect-mimari:29 | Hakem: auth mantığı `auth_routes.py`'de de var | Altın setin ölçümü daha güçlü ve hakemin `def login\|def logout` grep'ini birebir çürütüyor: `auth_routes.py` pin'de **29 satır**, hepsi sabit dönen stub. | **H** |
| 5 | mcp-derleme-kisir-dongu:12 | Hakem: "TÜM araçlar" yanlış | 45 aracın en az 5'i `unity_target=None`; `tool_actions.json:761` "never reaches Unity". **Altın set bu nicelemeyi hiç etiketlememiş.** | **A** |
| 6 | mcp-derleme-kisir-dongu:17 | Hakem: "Mac'te .NET 6 gerekir" artık yanlış | `fetch_omnisharp.py:68 DOTNET_VERSION="10.0.100"`, :35 "TÜM platformlarda gömülü .NET SDK". Altın set satırın yalnız diğer yarısını etiketlemiş. | **A** |
| 7 | test-standardi:26 | Hakem: "eski testler belgeli değil" yanlış | Pin'de 38 test dosyasının **25'i** modül docstring'li. Altın set yalnız "üç yeni dosya belgeli" yarısını etiketlemiş. | **A** |
| 8 | test-standardi:142 | Hakem: erken dönüşe `&& !hasMcpCard` eklendi | Altın set haklı ve daha derin ölçmüş: muafiyet MCP kartına ait, notun anlattığı `FileCreationApproval` mesaj döngüsünün içinde → tuzak pin'de duruyor. | **H** |
| 9 | unity-mcp-toggle:29 | Hakem: koddaki `--no-cache` bloğu koşulsuz değil | Doğru (:380, `_server_source_changed()` dalında). **Altın setin kendi `evidence` alanı bunu yazıyor**, sonra "not kendi bloğunu düzeltiyor" *politikasıyla* `gecerli` etiketliyor. Politika not düzeyine ait; iddia etiketine karışınca doğru ölçen hakem cezalandırılıyor. | **A** |
| 10 | unity-mcp-toggle:38 | Hakem: çapa `:354-356` kaymış | Pin'de `:380`. Altın setin `#5` evidence'ı "çapa kaymış" diyor ama ayrı iddia olarak etiketlememiş. | **A** |
| 11 | unity-mcp-toggle:45 | Hakem: `:53`/`:358` kaymış | Pin'de `:62`/`:383`. Aynı sınıf. | **A** |
| 12 | unity-mcp-toggle:49 | Hakem: `:142` kaymış | Pin'de `:151`. Aynı sınıf. | **A** |
| 13 | indirme-butunlugu:11 | Hakem: "tek kaynak" yanlış, roslyn sürümleri `RoslynInstaller.cs`'te de var | İkinci tablo gerçekten var (sürüm+sha256, `:34-37`) — ama iki tabloyu bağlayan bir test de var. "Tek kaynak" veri tekrarı mı yoksa tek mantıksal doğruluk kaynağı mı demek, protokol söylemiyor. | **?** |
| 14 | indirme-butunlugu:29 | Hakem: `check` 200 değil 2xx/3xx kabul ediyor | İki taraf **aynı olguyu ölçmüş**; altın set kendi evidence'ında "küçük bir imprecision" deyip affetmiş. Protokolde "yanlış değil ama kesin değil" için kural yok. | **?** |
| 15 | indirme-butunlugu:64 | Hakem: `test.yml` tag'leri dışlıyor | Doğru ama eksik: `release.yml` bu workflow'u `workflow_call` ile **kapı olarak çağırıyor** ve build ona `needs` ile bağlı. Yani not ("tag'den ÖNCE yakalanıyor") pin'de doğru. | **H** |
| 16 | indirme-butunlugu:75 | Hakem: `release-metadata/.../release.json` depoda hiç olmamış | Depoda yok, çünkü **Microsoft'un URL'i**: `pinned_assets.py:412`. Hakem dış adresi depo yolu sanmış. | **H** |
| 17 | agy-print-mcp-koprusu:20 | Hakem: yazma araçlarını kapatmak agy'yi teknik olarak zorlamaz | Notun **bir sonraki satırı** (21) tam bunu söylüyor: "`run_command` KAPATILAMAZ … bypass edebilir". Satır penceresi bağlamı kesmiş. | **H** |
| 18 | macos-build-mekanigi:19 | Hakem: x64 dmg de yükleniyor | `release.yml:101` `build/*.dmg` glob'u, `:126` `dist-artifacts/**/*`. İkisi de yükleniyor → not yanlış, üstelik tuzak sandığından büyük. Altın set bu yarıyı etiketlememiş. | **A** |
| 19 | windows-acikleri:55 | Hakem: `ledger.jsonl` hiç commit edilmemiş | Dosya **diskte var**, git'te izlenmiyor. Hakem yanlış mecrayı ölçmüş. | **H** |
| 20 | bekleyen-isler:11 | Hakem: `origin/main` artık `19c623f`, 12 önde | Bugün doğru, **pin anında değil**. PROTOKOL §1 "b4065f1 anındaki gerçek" diyor; o an b4065f1 push'lanmıştı. Not §3'e bak. | **H** |
| 21 | masaustu-guven-modeli:28 | Hakem: kütük bozulursa native diyalog gerekmiyor | `load()` parse hatasını yutup `[]` dönüyor → `confirmLegacyRoot`'un `length > 0` kapısı açılıyor → `showMessageBoxSync` yetiyor. Altın set yalnız "kütük DOLUYSA" dalını etiketlemiş. | **A** |
| 22 | masaustu-guven-modeli:29 | Hakem: log yalnız `!isOwnFrame` dalında | Doğru: `background.ts:76` tek yer ve hemen ardından "gönderen çerçeve uygulamaya ait değil" fırlatıyor; ilk sürümde (`c6ab542`) de aynı. Altın set **dizenin varlığını** ölçmüş, **dalını** ölçmemiş. | **A** |
| 23 | masaustu-guven-modeli:42 | Hakem: probe dizini hiç var olmamış | Diskte **12 dosya** var, git'te izlenmiyor. #19 ile aynı sınıf. | **H** |
| 24 | csharp-zekasi-zinciri:34 | Hakem: `stderr` pin'de `PIPE`, `DEVNULL` değil | Doğru. Ama paragraf "## Katman 2 — teşhisi 3 gün engelleyen tek satır" başlığı altında ve sonraki cümlesi geçmiş zamanlı. Protokolde **geçmiş anlatısı içindeki geniş zamanlı cümle** için kural yok. | **?** |
| 25 | csharp-zekasi-zinciri:113 | Hakem: dış `success` kontrolü hiç commit edilmemiş | Pin'deki `_unwrap_unity_result` docstring'i notun cümlesini **birebir** taşıyor. Not deponun kendi kaydını tekrarlıyor. | **H** |
| 26 | csharp-zekasi-zinciri:113 | Hakem: "o dal yalnız Unity bağlıyken" yanlış | Hakem **çağıranı** ölçmüş (`_maybe_sync_csproj`), notun kastettiği **hatalı dalı** değil. Docstring yine birebir doğruluyor. | **H** |
| 27 | worktree-kullanimi:11 | Hakem: 70 TS dosyasından yalnız 45'inde tanı var | Bu ölçüm **diskten koşturulamaz** (canlı dil sunucusu ister) ve vekil metrik. Hakem `olculemez` bir şeye hüküm vermiş. | **H** |
| 28 | kabuk-olcum-tuzaklari:77 | Hakem: kod hiçbir zaman korumasız büyümedi | Notun cümlesi **karşıolgusal**: "eklenirdi… olurdu". Hakem şart kipini olgu sanmış. | **H** |
| 29 | kabuk-olcum-tuzaklari:92 | Hakem: betik 64 KB değil ~220 KB | Fixture `"A" * 220_000`. Notun kendi fiziği de reddediyor: aynı paragraf sınırı 128 KB diyor. Yanlış rakamın kaynağı **deponun kendi yorumu**. Altın set etiketlememiş. | **A** |
| 30 | lisans-karari:20 | Hakem: "yalnızca uygulamanın satılması" yanlış, Sell tanımı geniş | LICENSE'ın **kendi özet cümlesi** notla aynı: "The restriction above applies only to selling the Software itself". Not lisansın kendi ifadesini aktarıyor. | **H** |
| 31 | lisans-karari:36 | Hakem: `THIRD-PARTY-NOTICES.md` tüm atıfları tutmuyor | Dosya npm ve Python için "See package.json / requirements.txt for the authoritative list" diyor. Altın set satırın yalnız diğer yarısını etiketlemiş. | **A** |
| 32 | teslim-yolu-denetimi:61 | Hakem: 8 değil 10 sağlayıcı dışlanıyor | `PROVIDER_TILES` 11 kayıt (1'i `subscription`). Ama notun evreni **9 sağlayıcı** (bkz `onay-kapisi-kapsami:188`). Hangi kütüğün "sağlayıcı" saydığı tanımlı değil. | **?** |
| 33 | unity-mcp-yerel-auth:25 | Hakem: sırsızken 6 uç yine kayıtlı | Probe **kurulmuş bir app nesnesini** ölçmüş; gerçek açılış yolunda `main.py` `SystemExit(1)` atıyor ("no unauthenticated transport is ever left listening"). | **H** |
| 34 | unity-mcp-yerel-auth:92 | Hakem: dönen sır elle yapıştırma istemez | Notun cümlesi karşıolgusal ("isterdi"). #28 ile aynı sınıf. | **H** |
| 35 | kimi-provider:3 | Hakem: 3 varsayımın en az biri ölçülmüş | `c69f3eb` (b4065f1 **atası**, not yazıldıktan ~10 saat sonra) canlı kanarya ölçümünü kaydediyor: "kimi → headers gönderiyor". Altın set kanıt olarak dosyanın kendi docstring'ini kullanmış — yani notun iddiasını notla doğrulamış. | **A** |
| 36 | kimi-provider:11 | Hakem: "canlı test edilmedi" çürük | Aynı `c69f3eb` kanıtı; altın set satırın yalnız "origin/main'de" yarısını etiketlemiş. | **A** |
| 37 | kimi-provider:36 | Hakem: `_is_kimi()` eskiden de üç koşula bakıyordu | `514653d^:api_providers.py:155` üç disjunct taşıyor. Altın set cümlenin yalnız "artık kimi-k" yarısını etiketlemiş. | **A** |
| 38 | onay-kapisi-kapsami:491 | Hakem: Server'da `approval_bridge` deseni yok | Hakemin metni 491-494'e ait değil (o paragraf `execute_code.safety_checks`). Konu notun **503-505**. satırlarında ve orada "Eski üç seçenek (**tarihsel**)" başlığı altında. Çapa + saman adam. | **H** |
| 39 | onay-kapisi-kapsami:491 | Hakem: boğaz seçimi doğrulanmamış eğilim | Aynı çapa hatası; üstelik hakemin kendi kanıtı ("karar uygulanmış, yalnız middleware kodu yok") notu **destekliyor**. | **H** |

**Toplam:** H = 20 · A = 15 · ? = 4

---

## 3. #20 hakkında ayrı bir uyarı — pin ölçütünün kör noktası

`bekleyen-isler:11` bugün yanlış: `origin/main` `19c623f` ve 12 commit ileride.
Hakem bunu ölçmüş. Protokol hükmü b4065f1 anına sabitlediği için ölçüm
**yanlış alarm** sayılıyor ve hakem doğru ölçtüğü için ceza alıyor.

Bu, ürünün var oluş sebebine dokunuyor: `DURUM:` satırları tam olarak sessizce
bayatlayan sınıf. Pin sözleşmesi r1–r5 ile karşılaştırma zeminini koruyor,
**ama bu sınıfı ölçülemez kılıyor.** Etiket değişikliği önermiyorum — pin
sözleşmesini ölçüm ortasında değiştirmek zemini kaydırır. Mimarın kararına
bırakılan soru: `DURUM:` satırları için pin'den bağımsız ikinci bir ölçüt mü
gerekiyor, yoksa bu sınıf ölçüm dışı mı kalacak?

---

## 4. Kaçan 8 iddianın yeniden hakemliği

| # | Not:satır | Karar | Gerekçe |
|---|---|---|---|
| 1 | codex-delegate-niyet:32 | **Kaçırma geçerli** | Hakem `olculemez` demiş ("`~/.codex-worker` depo dışı"). Ama iddia **hafıza anlık görüntüsünün içinden** çözülüyor: `bekleyen-isler.md:117` "Worker'ın `unityMCP` kaydı KALDIRILDI, geri konmadı". Bu bir **not-içi çelişki**, CLAUDE.md §3'ün en güçlü ve en ucuz sinyali. Protokol, anlık görüntünün kendisinin kabul edilebilir kanıt olduğunu açıkça yazmalı. |
| 2 | bekleyen-isler:616 | **Kaçırma geçerli** | Pin'de `agent_runner.py` = **1722** satır, not 1682 diyor. Hakemin o aralıktaki iddiası tamamen başka bir konu (`fetch_omnisharp`) — sayıya hiç bakmamış. |
| 3 | bekleyen-isler:624 | **Kaçırma geçerli** | Ölçüldü: `providers/` **6357** (not 5713), `routes/` **1858** (not 1830). Üçü de düşük. |
| 4 | kabuk-olcum-tuzaklari:3 | **Kaçırma geçerli** | Hakem "depoda probe günlüğü yok" diyerek `olculemez` demiş. Oysa çelişki **notun kendi gövdesiyle**: description "iki tuzak, 5 vaka" derken gövde altı sınıf (A–F) ve 12 vaka taşıyor, E ve D sınıfları 29 Tem tarihli. Depoya hiç bakmadan çözülür. |
| 5 | onay-kapisi-kapsami:186 | **Kaçırma geçerli** | `40b0cbd` (b4065f1 atası) koşulu kaldırmış; `home.tsx:93-97` yorumu bunu birebir yazıyor. |
| 6 | onay-kapisi-kapsami:194 | **Kaçırma geçerli** | `tool_actions.json`: 45 araç doğru, **karışık olan 17** — not 25 diyor. |
| 7 | onay-kapisi-kapsami:373 | **Kaçırma geçerli** | `_is_server_running` sembolü pin'de yok; yerine `is_running` (:188) ve kimlik probe'u. Pin commit'inin başlığı zaten bu. |
| 8 | unity-architect-mimari:40 | **Kaçırma DEĞİL — altın set çapa hatası** | Hakem aynı iddiayı `:38-39`'da `curuk` işaretlemiş ("dört alan döndürür"). Altın set çapayı `:40-41`'e (export sandbox satırları) koyduğu için skorlayıcı eşleştirememiş. |

Yani 8 kaçırmanın **7'si gerçek**, 1'i aletin kendi çapa hatası.

Kaçan 7'nin şekli tek bir yerde toplanıyor: **6'sı sayısal iddia** (1682 satır,
5713/9390/1830 satır, 25 karışık araç, "5 vaka / iki tuzak"). Hakem bu sınıfta
komutu kuruyor ama **sonucu okumuyor** — altın setin `bekleyen-isler#…` kaydı
bunu daha önce not etmiş: "komut kurulmuş ama sonuç okunmamış". Bu, M4.4 için
tek ve somut bir hedef.

---

## 5. Hataların dağılımı — kümeleniyorlar mı?

**Evet, ikisi de tek bir eksende.**

**Altın setin 15 hatasının 13'ü tek sınıf:** *bir satırda iki iddia var, biri
etiketlenmiş, diğeri etiketlenmemiş.* PROTOKOL §2 bunu zaten yasaklıyor; kural
var, uygulanmamış. Kalan 2'si etiket hatası (#9 politika sızıntısı, #22 eksik
ölçüm). Notlara göre dağılım da yoğun: `unity-mcp-toggle` 4, `kimi-provider` 3,
`mcp-derleme` 2, `masaustu-guven-modeli` 2.

**Hakemin 20 hatasının 17'si dört sınıf:**

| Sınıf | Adet | Örnek |
|---|---|---|
| Yanlış mecra/ağaç ölçmek (git ↔ disk, GaMachine ↔ başka repo, dış URL ↔ depo yolu) | 5 | #1, #16, #19, #23, #33 |
| Bağlamı satır penceresiyle kesmek (bir sonraki satır iddiayı zaten nitelendiriyor) | 4 | #3, #17, #38, #39 |
| Kip körlüğü: karşıolgusal/geçmiş anlatısını olgu sanmak | 4 | #25, #26, #28, #34 |
| Çapa yanlış yazmak (hakemin kendi satır numarası tutmuyor) | 4 | #2, #38, #39 ve #24 sınırda |

Bunların hiçbiri "model iyi ölçemedi" değil — hepsi **hakemin ne ölçeceğini
tarif eden brief'in boşluğu**. Beşi tek cümlelik bir kuralla kapanır:
*"depo dışı bir yol gördüğünde önce diskte ara, sonra git'te; not satırını tek
başına değil komşu satırlarla oku; şart kipi (-irdi/-erdi) bir iddia değildir."*

---

## 6. Çözülemeyen 4 kayıt ve neyin çözeceği

Hiçbiri "bilgi yok" değil; dördü de **protokolde eksik olan bir kural** yüzünden
askıda. Karar mimara ait.

| # | Askıda kalan soru | Neyin çözeceği |
|---|---|---|
| 13 | `indirme-butunlugu:11` — "tek kaynak", veri tekrarını mı yoksa tek mantıksal doğruluk kaynağını mı yasaklıyor? İki tablo var ama onları bağlayan bir test de var. | PROTOKOL'de "çapraz kontrol edilen ikinci kopya tekrar sayılır mı" kuralı. |
| 14 | `indirme-butunlugu:29` — "200 dönüyor" derken kod 2xx/3xx kabul ediyor. İki taraf da aynı şeyi ölçmüş, biri affetmiş. | Beşinci bir hüküm ya da açık bir tolerans kuralı: "yanlış değil ama kesin değil" için kova yok. |
| 24 | `csharp-zekasi-zinciri:34` — geçmiş-anlatısı bölümünde geniş zamanlı cümle. Okuyucu bağlamdan anlar; harfiyen okunursa pin'de yanlış. | PROTOKOL §3'e "bölüm başlığı anlatıyı geçmişe sabitliyorsa gövde cümleleri `olculemez`/`tarihsel`" kuralı. |
| 32 | `teslim-yolu-denetimi:61` — "8 sağlayıcı" hangi kütükten sayılıyor? UI kartları 11, notun evreni 9. | "Sağlayıcı" sayımının tek bir kütüğe (`PROVIDER_TILES` mi, backend registry mi) bağlanması. |

Dördü **belirsiz olarak bırakıldı**; hiçbiri sayıya çevrilmedi. Bu yüzden
düzeltilmiş yanlış alarm sayısı tek bir rakam değil bir bant:
**doğrulanmış 20, üst sınır 24.** Tabloda 24 kullanıldı — hakemin aleyhine olan
uç, çünkü kanıtlanmamış lehte sayım tam da bu raporun düzeltmeye çalıştığı hata.

---

## 7. Öneri dosyası

`docs/olcumler/altin-set/golden-v1-duzeltme-onerisi.jsonl` — 16 kayıt:

- **1 çapa düzeltmesi** (`unity-architect-mimari#17`, `:40-41` → `:38-39`)
- **2 etiket değişikliği** (`unity-mcp-toggle#3`, `masaustu-guven-modeli#9`)
- **13 yeni iddia** (altın setin hiç etiketlemediği, ölçülüp yanlış çıkanlar)

`golden-v1.jsonl` **değiştirilmedi.** Yukarıdaki 53/60 · 24 sayıları, öneriler
uygulanmış bir kopya üzerinde `score.ts` koşturularak üretildi.

Uygulamadan önce mimarın karara bağlaması gereken iki şey:

1. **Çapa satır numaraları iddia mıdır?** #10/#11/#12 bu üçünü hedef kümesine
   ekliyor. Lehte: CLAUDE.md §2.4'ün çapa-kayması sinyali etiketlenmezse
   ölçülemez. Aleyhte: hedef kümesi konum trivyasıyla şişer ve yakalama oranı
   kolaylaşır. Üçü de çıkarılırsa sayılar **50/57 = %87,7 · 26 yanlış alarm**
   olur (ölçüldü) — yani karar sonucu anlamlı biçimde değiştirmiyor, ama neyin
   ölçüldüğünü değiştiriyor.
2. **#9'daki politika.** "Not kendi bloğunu birkaç satır sonra düzeltiyor"
   gerçek ve değerli bir gözlem — ama iddia etiketine değil, **not düzeyi
   puanlamaya** ait. Politika iddia etiketine karışırsa doğru ölçen hakem
   cezalandırılıyor.
