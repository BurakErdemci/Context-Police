# M2 — Gözlemci Çıkış Kapısı Ölçümü (prompt v1, ilk gerçek koşum)

**Tarih:** 2026-08-11
**Denek oturum:** `~/.claude/projects/-Users-burakemreerdemci-Documents-Context-Police/dfbcaaaf-3368-467c-a28b-15fce5e3e148.jsonl`
(3.587.509 bayt / 3,4 MB — bu projenin kendi M1+M2 geliştirme oturumu; içeriği bilindiği
için her bulgu elle denetlenebilir)
**Depo:** `/tmp/cp-m2-olcum/olcum.db` (izole; üretim deposuna dokunulmadı — koşum sonrası
göz kontrolü için diskte bırakıldı)
**Komut:** `node --disable-warning=ExperimentalWarning src/cli.ts observe --session <yukarıdaki> --store /tmp/cp-m2-olcum/olcum.db`
**Yürütücü:** `codex-cli 0.146.0`, model `gpt-5.6-sol` (kullanıcı `~/.codex/config.toml`
varsayılanı — D-M2-6 gereği dayatılmadı), `model_reasoning_effort="low"` (CLI varsayılanı;
config'teki `high` bilinçli olarak eziliyor), `--ephemeral -s read-only`
**Kod tabanı:** `9b8232f` + bu ölçümün doğurduğu şema düzeltmesi (bkz. §1)

**Şerh:** Denek oturum ölçüm sırasında **canlı**ydı (aynı oturum bu işi yürütüyordu).
Süzülmüş içerik koşum anındaki fotoğraftır; tekrar koşulursa turn sayısı büyür.

---

## 1. Ölçümden önce: ürün gerçek Codex'le hiç çalışmamıştı

İlk koşum **6 partinin 6'sında da** çöktü, sıfır bulgu üretti. Sebep tek ve yapısaldı:

```
invalid_json_schema (400): In context=('properties','findings','items'),
'required' is required to be supplied and to be an array including every key
in properties. Missing 'supersedes'.
```

OpenAI'ın strict structured-output modu `required`ın `properties`teki **her** anahtarı
içermesini şart koşuyor. `OBSERVER_OUTPUT_SCHEMA` `supersedes`i opsiyonel bırakmıştı
(`required: ["content","anchors"]`), dolayısıyla `--output-schema` ile yapılan **hiçbir
gözlemci çağrısı API'ye kabul edilmiyordu**. M2'nin 1–7. görevleri boyunca yürütücü
`FakeExecutor` olduğu için kusur hiçbir testte görünmedi: 122/122 test yeşil, tip denetimi
temiz, ürün çalışmıyor.

**Bu, M2'nin en pahalı bulgusudur ve ölçümün asıl kazancıdır.** Sahte yürütücüyle sabitlenen
sözleşme, gerçek sağlayıcının şema sözleşmesini hiç sınamıyor.

Düzeltme izole bir `codex exec` çağrısıyla önce kanıtlandı, sonra uygulandı:
`supersedes: {type: ["number","null"]}` + `required: ["content","anchors","supersedes"]`.
Model artık `"supersedes": null` döndürüyor; `parseObserverOutput` bunu zaten "geçersiz
kılınan yok" sayıyordu (`1dde44f`'in parser toleransı bu düzeltmeyi bedava karşıladı).
Değişiklik tek dosyada, 2 satır: `core/src/observer/prompt.ts`. Sonrası: 122/122 yeşil.

**Görev 5'e dönüldü mü?** Evet — prompt dosyasının şema bölümüne, prompt metnine değil.
Metin dokunulmadan kaldı; aşağıdaki oranlar **prompt v1 metninin** performansıdır.

---

## 2. Koşum sayıları

| | |
|---|---|
| Süzülmüş yeni turn | 474 |
| Parti | 6 |
| Codex çağrısı | 6 (retry yok, düzeltme turu yok) |
| İşlenemeyen parti | **0** |
| Yeni bulgu | 38 |
| Supersede | 2 (ikisi de doğru, bkz. §3.2) |
| Reddedilen supersede (`droppedSupersedes`) | 0 |
| Süre | 164 sn (parti başına ~27 sn) |
| Gözlemciye giden token (parti `estTokens` toplamı) | ~46.600 |

Parti başına: 59/43/153/104/47/68 turn → 9/4/9/7/5/4 bulgu. Kuyruk partisi (1.730 token,
eşiğin çok altında) D-M2-1 gereği gönderildi ve 4 bulgu verdi — eşik altı partiyi bekletmeme
kararı burada somut olarak kâr etti.

## 3. Dört oran

| # | Oran | Değer | Yorum |
|---|---|---|---|
| 1 | **Anlamlılık** (bulgu/parti) | **6,3** — 38/6 | Sıfır bulgulu parti yok. Elle denetimde 38/38 bulgu oturumda gerçekten geçen bir olguya karşılık geliyor; uydurulmuş **içerik** yok. |
| 2 | **Mükerrer** | **%0 tam / %8 kısmi** (3/38) | Aynı olguyu birebir tekrar eden bulgu yok. Üç bulgu bir öncekiyle kısmen örtüşüyor (§3.1). |
| 3 | **Çapasız** (`unanchored`) | **%5,3** (2/38) | Ama asıl sorun çapasızlık değil, **çapa geçerliliği** (§3.3). |
| 4 | **Kalıcılık isabeti** (akış-durumu sızıntısı) | **0 açık / 4 sınırda** (%11) | "Şu an X yapılıyor / sıradaki adım / todo" tipi tek bulgu bile yok. Sızan şey başka bir sınıf (§3.4). |

### 3.1 Mükerrerlik — tam metinle

Birebir mükerrer üretilmedi. Kısmi örtüşen üç bulgu:

- **#21 ↔ #23** — aynı denetim sürecinin iki farklı anındaki fotoğrafı. #21: *"M1
  doğrulamasında 40/40 test geçti ve tip denetimi temiz çıktı; … üç lensin ürettiği 15
  probe'un 15'i de ana ağaçta yeniden üretildi"*; #23: *"M1 denetiminde dört red-team
  lane'i ve bir doğrulama turu kullanıldı; 27 bulgunun 27'si ana ağaçta yeniden üretildi.
  … regresyon paketi 73/73 geçti."* İkincisi birincisini **supersede etmeliydi** (40/40 →
  73/73, 15 probe → 27). Etmedi. Bu bir mükerrerden çok **kaçırılmış supersede**: depoda
  artık aynı konuda iki farklı sayı yan yana duruyor — yani M3'ün çelişki dedektörünün
  ilk gerçek yemi, kendi gözlemcimizin ürünü.
- **#22 ↔ #31** — ikisi de "8k parti ≈ 250 çağrı" ölçümünü taşıyor; #31 üzerine sel
  koruması kararını ekliyor, dolayısıyla tam mükerrer değil.

Prompt'un "aynı olguyu TEKRAR yazma" kuralı **başlık listesi üzerinden** çalışıyor ve
işini büyük ölçüde görüyor; kaçırdığı yer, aynı olgunun **güncellenmiş sayıyla** geri
geldiği durum.

### 3.2 Supersede kalitesi (2/2 doğru)

- **#19 → #28**: *"35 silo ve 190 oturumdaki 376,6 MB … 23.110 turn"* → *"35 silo ve 192
  oturumdaki 378,2 MB'ı 15,5 MB ve 23.290 turn'e 0,9 saniyede süzdü"*. Aynı ölçümün
  denetim sonrası tekrarı; eskisi doğru biçimde kapatıldı.
- **#34 → #35**: *"M2 uygulaması görev başına Opus 5 alt ajanlarla yürütülecek; ana ajan
  her görevden gelen işi gözden geçirecek."* → *"M2 çalışma düzeni değiştirildi: görev
  başına ayrı reviewer ve düzeltme döngüsü yapılmayacak…"*. Oturum içinde gerçekten
  verilmiş bir karar değişikliği, doğru yakalanmış.

Yabancı/uydurma id ile supersede denemesi olmadı (`droppedSupersedes: 0`) — id koruması
bu koşumda sınanmadı, yani "çalışıyor" değil "tetiklenmedi".

### 3.3 Çapa geçerliliği — oranın gizlediği asıl kusur

Çapasız yalnız 2 bulgu (%5,3). Ama 21 benzersiz çapa diske karşı ölçüldüğünde:

| Çapa | Hüküm |
|---|---|
| `file_path:core/__tests__` (#21) | **UYDURMA** — böyle bir dizin hiç olmadı, doğrusu `core/test` |
| `file_path:core/docs` (#22) | **UYDURMA** — böyle bir dizin yok |
| `external_path:task-5-report.md` (#37) | **ÇÖZÜLEMEZ** — dosya gerçek ama yol köksüz (`.superpowers/sdd/2026-08-11-m2-gozlemci-dongusu/task-5-report.md`) |
| `external_path:~/.context-police/store.db` (#3) | **HENÜZ YOK** — tasarım hedefi, meşru |
| Kalan 17 çapa (`core/src/store/db.ts`, `docs/olcumler/…`, `symbol:fakeExecutor` dahil) | **VAR** |

Yani **çapaların %10'u (2/21) uydurma**, biri çözülemez. Prompt açıkça *"çapa uyduramıyorsan
boş bırak, uydurma"* diyor ve gözlemci yine de uydurdu. Ayrıca `core/src` gibi **kaba dizin
çapaları** (3 bulguda) teknik olarak geçerli ama drift tespitine yaramaz: `core/src` hiçbir
zaman kaymayacak. Çapa dağılımı: 36 `file_path`, 7 `external_path`, **1 `symbol`**, 0
`commit_sha` — yani M3'ün en güçlü sinyali olan sembol/SHA çapası neredeyse hiç üretilmiyor.

### 3.4 Kalıcılık isabeti — beklenen sızıntı gelmedi, başkası geldi

"Şu an X yapılıyor", "sıradaki adım", "todo" tipi tek bulgu yok. Prompt'un ALMA listesi
bu sınıfta **temiz** çalışıyor. Sızan dört bulgu farklı bir sınıf: **saatler içinde
bayatlayan sayılar**, hepsi prompt'un "ölçüm sonuçlarını al" emrinin doğal ürünü.

- #21: *"M1 doğrulamasında **40/40** test geçti"* — bugün 122.
- #37: *"Görev 5 düzeltmeleri sonrasında tip denetimi temiz ve test paketi **110/110**
  başarılıydı."* — bugün 122.
- #38: *"…düzeltme sonrasında toplam **75/75** başarı verdi."* — aynı sınıf.
- #10: *"…**ilk push için bu oturumda açık izin verildi**."* — oturuma özgü izin, kalıcı
  kural değil; kalıcı olan kısmı (`push yalnız istendiğinde`) aynı bulgunun içinde doğru
  yakalanmış.

Bu, M0'ın `durum-bayatladı` sınıfının canlı üremesidir: not yazıldığı gün doğru, ertesi
gün yanlış. **M3'ün DURUM dedektörünün girdisi tam olarak bu dört bulgudur** — akış durumu
değil, çapası olmayan/hareketli bir sayıya yaslanan ölçüm beyanı.

## 4. İyi bulgu örnekleri (tam metin)

> **#18** — *"Transcript proje kimliği, kayıplı dizin anahtarını tersine çevirmek yerine
> transcript içindeki `cwd` alanından okunacak. Bu karar, noktasız `ı` içeren
> `/Users/burakemreerdemci/Documents/unityaıPython` yolunun yalnız `cwd` ile eksiksiz
> korunabildiğinin ölçülmesine dayanıyor."*
> Karar + gerekçe + gerekçenin dayandığı ölçüm, üçü bir arada; çapa gerçek. Hafızaya
> elle yazılsa bundan iyisi yazılmazdı.

> **#26** — *"Canlı Claude Code ölçümünde transcript yazımı append-only çıktı: `--resume`
> sonrasında inode değişmedi ve mevcut önek byte-byte aynı kaldı; `/compact` ekleme
> yapıyor, retention ise dosyayı kısaltmak yerine siliyor. … bu karar CLI 2.1.226'nın
> append-only davranışına bağlıdır ve sürüm değişiminde yeniden ölçülmelidir."*
> Ölçüm + demote gerekçesi + **geçerliliğin bağlı olduğu varsayım**. Gözlemci "bu ne zaman
> çürür"ü kendiliğinden yazmış.

> **#25** — *"`parser-untrusted-input` dış denetim lensi Codex tarafından `cyberPolicy`
> gerekçesiyle iki kez reddedildi; saldırgan dili yumuşatarak yeniden ifade etmek reddi
> aşmadı. Bu alan 10 geliştirici dayanıklılık testiyle kısmen kapatıldı ancak bağımsız
> dış-göz denetimi yapılmış sayılmıyor…"*
> "Denendi, olmadı" + **neyin sınanmadığı**. Hafıza rehberinin istediği yazım biçimi.

## 5. Kötü bulgu örnekleri (tam metin)

> **#21** — *"M1 doğrulamasında 40/40 test geçti ve tip denetimi temiz çıktı; test kapsamı
> daha sonraki denetimde satır bazında %97,2, dal bazında %86,8 ölçüldü. Güvenlik
> denetimindeki üç lensin ürettiği 15 probe'un 15'i de ana ağaçta yeniden üretildi…"*
> Üç kusur bir arada: bayat sayı (40/40), uydurma çapa (`core/__tests__`), ve #23
> tarafından supersede edilmesi gerekirken edilmemiş olması.

> **#22** — *"M2 parti boyutu, en büyük oturumun süzme sonrasında bile yaklaşık 2 milyon
> token olduğu gerçeğine göre seçilmeli; 8 bin tokenlık partiler yaklaşık 250 gözlemci
> çağrısı doğurur. Bu nedenle parti eşiği sabitlenmeden önce çağrı maliyeti ve bağlam
> sınırı birlikte değerlendirilmelidir."*
> Ölçüm doğru ama bulgu **tavsiye kipinde** ("değerlendirilmelidir") — karar değil,
> müzakere anı dondurulmuş. Üstelik çapa (`core/docs`) uydurma ve karar (#31) zaten
> verilmiş: #22 doğduğu anda eskimiş.

> **#35** — *"M2 çalışma düzeni değiştirildi: görev başına ayrı reviewer ve düzeltme
> döngüsü yapılmayacak…"* — içerik doğru ve #34'ü doğru supersede ediyor, ama **çapasız**.
> Çalışma düzeni kararının çapası `.superpowers/sdd/…/global-constraints.md` olabilirdi;
> gözlemci uydurmak yerine boş bırakmayı seçti — prompt'a uygun davranış, kötü sonuç.

## 6. Prompt'a geri besleme (v2 adayları)

Sıralama, ölçülen hasara göre:

1. **Çapa uydurma yasağı yetersiz** (§3.3, 2 uydurma / 21 çapa). Prompt "uydurma" diyor
   ama gözlemcinin çapayı doğrulama imkânı yok (D-M2-8: araçsız, `-C` verilmiyor). İki
   seçenek: (a) prompt'a "**yalnız bu parçada metin olarak GEÇEN yolu çapa yap**" kısıtı;
   (b) çapaları yazım anında diske karşı doğrulayıp tutmayanları düşürmek (kod tarafı,
   M3 anchor-drift altyapısıyla bedava gelir). (a) ucuz, önce o denenmeli.
2. **Kaba dizin çapası işe yaramıyor** (`core/src`, 3 bulgu). Prompt "dosya yolu" diyor,
   "dizin olmaz" demiyor. Tek cümle ekleme: *dizin değil dosya; mümkünse sembol adı.*
3. **`symbol`/`commit_sha` neredeyse hiç üretilmiyor** (1 ve 0). M3'ün en güçlü drift
   sinyali bunlar. Prompt çapa türlerini eşit sıralıyor; **öncelik sırası yazılmalı**:
   sembol > dosya > dizin, SHA geçiyorsa mutlaka.
4. **Bayat sayı sınıfı** (§3.4, 4 bulgu). Prompt "ölçüm sonuçları al" diyor, ölçümün
   **neye bağlı** olduğunu yazmasını istemiyor. #26 bunu kendiliğinden yaptı ("CLI
   2.1.226'ya bağlıdır") — yani model yapabiliyor, istenmediği için yapmıyor. Öneri:
   *bir ölçüm yazıyorsan neyin değişmesi onu geçersiz kılar, onu da yaz.*
5. **Güncellenmiş sayı supersede'i kaçıyor** (#21↔#23). Prompt supersede'i "geçersiz
   kılıyorsa" diye tarif ediyor; "aynı olgunun yeni ölçümü" bunun altına girmiyor gibi
   okunuyor. Açık örnek eklenmeli: *aynı şeyin yeni sayısı da supersede'dir.*
6. **Tavsiye kipi** (#22). ALMA listesine bir madde: *henüz karara bağlanmamış tartışma
   ve öneri.*

Ayrıca kod tarafı, prompt değil: **§1'deki şema kusuru bir teste dönüşmeli.** `FakeExecutor`
gerçek sağlayıcının şema sözleşmesini sınamıyor; `OBSERVER_OUTPUT_SCHEMA`nın strict-mode
kuralına (her `properties` anahtarı `required`ta) uyduğunu ölçen saf bir test bedava ve bu
sınıfı kalıcı kapatır.

## 7. Yan bulgu: `openStore` kendisine ait olmayan dizinde çöküyor

Ölçüm `--store /tmp/cp-m2-olcum.db` ile başlatıldı ve şuraya çarptı:

```
Error: EPERM: operation not permitted, chmod '/tmp'
    at openStore (core/src/store/db.ts:114)
```

`openStore` depo dosyasının **üst dizinine** koşulsuz `chmod 0700` atıyor (M1 denetiminin
izin sıkılaştırma düzeltmesi). Üst dizin kullanıcıya ait değilse (`/tmp`, ortak bir
paylaşım dizini, salt-okunur bağlanmış bir yol) süreç açılışta ölüyor. Kendi yarattığı
dizinde sorun yok; ölçüm `/tmp/cp-m2-olcum/olcum.db` ile koştu. Düzeltme önerisi: `chmod`u
`mkdir`in gerçekten yeni dizin yarattığı duruma bağlamak, ya da hatayı yutup uyarmak.
M2 kapsamı dışı, kayda geçti.

## 8. Hüküm

Çıkış kapısının ölçülebilir kısmı geçti: **gerçek bir oturumdan depoya anlamlı bulgular
düşüyor** (6,3 bulgu/parti, 0 işlenemeyen parti, 0 birebir mükerrer, %5 çapasız, 0 akış-durumu
sızıntısı). Kalitenin zayıf yeri oran tablosunda değil, **çapa geçerliliğinde**: %10 uydurma
çapa ve sembol/SHA çapasının yokluğu, M3'ün drift tespitini doğrudan zayıflatır.

Ölçümün asıl kazancı sayı değil §1: ürün 122 yeşil testle birlikte **gerçek sağlayıcıya
karşı hiç çalışmıyordu**.

---

**Göz kontrolü: Burak onayı bekliyor.**

---

## Ek A — 38 bulgunun tam dökümü

Biçim: `#id [status] içerik → çapalar`. Parti sınırları: P1 `#1-9`, P2 `#10-13`,
P3 `#14-22`, P4 `#23-29`, P5 `#30-34`, P6 `#35-38`.

**#1** [active] Prototip için yalnız hafıza dosyalarının desteklenmesi yeterli; asıl uygulamada ise tüm ilgili hafıza kaynaklarının desteklenmesi gerekiyor. → `file_path:docs/superpowers/specs/2026-08-10-context-police-design.md`

**#2** [active] Mimari, bağımsız Node/TypeScript çekirdeği ile ince bir Tauri dashboard kabuğundan oluşacak. Çekirdek UI olmadan çalışabilecek ve UI ile localhost HTTP/WebSocket üzerinden haberleşecek; bu sınır test edilebilirlik, headless kullanım ve ileride kabuk/adapter değiştirebilmek için seçildi. → `file_path:docs/superpowers/specs/2026-08-10-context-police-design.md`

**#3** [active] Kalıcı depo `~/.context-police/store.db` konumunda SQLite olacak; bulgular append-only tutulacak ve düzeltmeler eski kaydı değiştirmek yerine yeni kayıt ile `superseded_by` ilişkisi oluşturacak. `memory/*.md` dosyaları ajanların gördüğü gerçek kaynak olmaya devam edecek, SQLite ise denetim ve sorgu üst-verisini tutacak. → `external_path:~/.context-police/store.db` | `file_path:docs/superpowers/specs/2026-08-10-context-police-design.md`

**#4** [active] Codex uygulamanın sert bağımlılığıdır; kurulu değilse uygulama kullanıma açılmayacak ve onboarding kurulum yönlendirmesi gösterecek. Codex bulunmadığında transcriptleri kuyrukta biriktiren çalışma modu tasarımdan çıkarıldı; geçici çağrı hatalarında yalnız aynı tur içinde yeniden deneme yapılacak. → `file_path:docs/superpowers/specs/2026-08-10-context-police-design.md`

**#5** [active] Denetimde Codex hakeminin ardından temiz bağlamlı ve araç erişimli `claude -p` ile çapraz-model ikinci görüş alınacak; canlı geliştirme oturumuna mesaj gönderilmeyecek. Doğrulama sorusu yönlendirici olmayacak, iddiaların dosya ve git kanıtlarıyla ölçülmesini isteyecek; model uzlaşısı veya anlaşmazlığı dashboard'da açıkça gösterilecek. → `file_path:docs/superpowers/specs/2026-08-10-context-police-design.md`

**#6** [active] Kullanıcı onayı olmadan `memory/` dosyalarına hiçbir yazım yapılmayacak; buna superseded işaretleri de dahil. Onaylanan her düzeltme hafıza dosyasında tespit sebebini, dosya/commit kanıtını, Codex ve Claude doğrulama sonucunu, kullanıcı onayını ve eski metnin arşivlendiğini açıklayan bir denetim izi taşıyacak. → `file_path:docs/superpowers/specs/2026-08-10-context-police-design.md`

**#7** [active] Tarama varsayılan olarak 90 saniyede bir ve JSONL dosyalarında bayt imleciyle artımlı yapılacak; yarım satırlarda imleç ilerletilmeyecek. Gözlemci çağrısı yaklaşık 8 bin token biriktiğinde veya oturum kapandığında yapılacak; gözlemci mevcut aktif bulgu başlıklarını mükerrerleri önlemek için görecek fakat yalnız yeni kayıt veya supersede ilişkisi üretebilecek. → `file_path:docs/superpowers/specs/2026-08-10-context-police-design.md`

**#8** [active] Şüphe sinyallerinde yaş tek başına kullanılmayacak; anchor kayması, sembol/dosya değişimi ve mekanik olarak ön elenmiş çelişki adayları esas alınacak. Hakem için başlangıç şüphe eşiği 0,6 olacak ve daha sonra retrospektif ölçümlerle kalibre edilecek. → `file_path:docs/superpowers/specs/2026-08-10-context-police-design.md`

**#9** [active] Prototipin uçtan uca altın seti Context Police projesi ve GaMachine üzerindeki elle belirlenmiş çürümüş notlardan oluşacak. Temel başarı ölçütü, otomatik boru hattının bu altın setteki çürümüş notların kaçını kendiliğinden yakaladığıdır; reddedilen hükümlerin toplam hükümlere oranı da yanlış alarm metriği olarak tutulacak. → `file_path:docs/superpowers/specs/2026-08-10-context-police-design.md`

**#10** [active] GitHub CLI (`gh`) makinede bulunmalı; asistan repo oluşturabilir/bağlayabilir ve yerel commit atabilir. Push ise yalnız kullanıcı açıkça istediğinde yapılacak; ilk push için bu oturumda açık izin verildi. → `file_path:CLAUDE.md` | `external_path:https://github.com/BurakErdemci/Context-Police.git`

**#11** [active] Uygulama roadmap'i takvim veya 15 günlük plan yerine milestone bazlı yürütülecek. Her milestone ölçülebilir bir çıkış kapısına sahip olacak ve ayrıntılı uygulama planı milestone başında ayrıca hazırlanıp kullanıcı onayına sunulacak. → `file_path:docs/superpowers/plans/2026-08-10-context-police-roadmap.md`

**#12** [active] M0, uygulama kodundan önce retrospektif çürüme ölçümü ve go/no-go kapısı olarak konumlandırıldı; gerekçesi projeyi düşük maliyetle durdurabilmesi ve sonraki sinyal/hakem aşamalarına doğrulama zemini sağlamasıdır. → `file_path:docs/superpowers/plans/2026-08-10-context-police-roadmap.md`

**#13** [active] GaMachine projesinin diskteki eski adı ve yerel yolu `/Users/burakemreerdemci/Documents/unityaiPython` olarak belirlendi. Windows makinede daha güncel proje ve hafızalar kaldığından M0 sonuçları yalnız bu Mac diskindeki repo ve hafızaların tarihsel fotoğrafı olarak yorumlanacak; güncel küresel durum iddiası taşımayacak. → `external_path:/Users/burakemreerdemci/Documents/unityaiPython`

**#14** [active] M0 retrospektif kapısı GO ile sonuçlandı: 28 notun 11'i geçerli, 16'sı kısmen çürümüş, 1'i tamamen çürümüş bulundu; notların %61'i en az bir ölü iddia taşıyordu. Düşük çürüme halinde projeyi durdurma ölçütü sağlanmadığından proje hipotezi doğrulandı. → `file_path:docs/olcumler/2026-08-10-m0-gamachine-retrospektif.md`

**#15** [active] M0 ölçümünde baskın çürüme türü 17 çürüyen notun 9'unda görülen `durum-bayatladı` oldu; iki nottaki ilk ölü iddia yazımdan yaklaşık 7 saat sonra oluştu. Bu sonuç, yaşa dayalı tarama yerine değişimle tetikleme ve `DURUM` kalıbı + hareket eden çapa birleşimini yüksek şüphe sinyali sayma kararını destekliyor. → `file_path:docs/olcumler/2026-08-10-m0-gamachine-retrospektif.md`

**#16** [active] Yazıldığı gün de yanlış olan yaklaşık 6 iddia tespit edildi; bunlar çürüme değil `born_invalid` olarak ayrı sınıflandırılacak. Çelişki denetimi notlar arası, not içi ve frontmatter–gövde yüzeylerinin üçünü de kapsayacak; çapa önceliği sembol > yol > satır olacak ve çapasız iddialar nötr kabul edilecek. → `file_path:docs/olcumler/2026-08-10-m0-gamachine-retrospektif.md`

**#17** [active] M1 çekirdeği Node 24'ün yerleşik `node:sqlite`, `node:test` ve TypeScript tip-soyma özellikleriyle sıfır çalışma zamanı bağımlılığı kullanacak. `typescript` ve `@types/node` yalnız geliştirme zamanı tip denetimi bağımlılıklarıdır; deneysel SQLite API'si depo katmanının arkasında tutulacak. → `file_path:core/package.json`

**#18** [active] Transcript proje kimliği, kayıplı dizin anahtarını tersine çevirmek yerine transcript içindeki `cwd` alanından okunacak. Bu karar, noktasız `ı` içeren `/Users/burakemreerdemci/Documents/unityaıPython` yolunun yalnız `cwd` ile eksiksiz korunabildiğinin ölçülmesine dayanıyor. → `external_path:/Users/burakemreerdemci/Documents/unityaıPython`

**#19** [superseded→#28] M1 gerçek veri kapısında 35 silo ve 190 oturumdaki 376,6 MB transcript 15,4 MB'a indirildi (24,5×); 23.110 turn yaklaşık 1,0 saniyede tarandı. 245 MB'lık en büyük dosya 128 MB heap sınırı altında işlendi ve tepe heap kullanımı 39 MB ölçüldü. → `file_path:core/src`

**#20** [active] En büyük transcript için bağımsız ölçüm ile parser sonucu birebir 16.092 turn çıktı. İlk saha taramasında daha önce görülmeyen `custom-title` ve `frame-link` satır tipleri görünür uyarı üretti; inceleme bunların bulgu taşımayan üst-veri olduğunu gösterdi ve bilinen-atla listesine alınmalarına karar verildi. → `file_path:core/src`

**#21** [active] M1 doğrulamasında 40/40 test geçti ve tip denetimi temiz çıktı; test kapsamı daha sonraki denetimde satır bazında %97,2, dal bazında %86,8 ölçüldü. Güvenlik denetimindeki üç lensin ürettiği 15 probe'un 15'i de ana ağaçta yeniden üretildi; parser lensinin ilk koşusu sağlayıcının `cyberPolicy` reddi nedeniyle geçerli bir temiz sonuç sayılmadı. → `file_path:core/src` | `file_path:core/__tests__`

**#22** [active] M2 parti boyutu, en büyük oturumun süzme sonrasında bile yaklaşık 2 milyon token olduğu gerçeğine göre seçilmeli; 8 bin tokenlık partiler yaklaşık 250 gözlemci çağrısı doğurur. Bu nedenle parti eşiği sabitlenmeden önce çağrı maliyeti ve bağlam sınırı birlikte değerlendirilmelidir. → `file_path:core/docs`

**#23** [active] M1 denetiminde dört red-team lane'i ve bir doğrulama turu kullanıldı; 27 bulgunun 27'si ana ağaçta yeniden üretildi. Sonuçta 20 bulgu kapatıldı, 3 bulgu adlandırılmış varsayımlarla demote edildi ve blocker kalmadı; regresyon paketi 73/73 geçti. → `file_path:docs/olcumler/2026-08-11-m1-denetim-raporu.md`

**#24** [active] İlk denetim düzeltmelerinin üzerine yapılan bağımsız doğrulama turu 12 yeni kusur buldu; bunların tamamı düzeltmeler sırasında üretilmişti. En ciddi kusur, eski depo şemasından yükseltmede yeni imleç anahtarının hiçbir benzersiz kısıtla eşleşmemesi nedeniyle imlecin hiç yazılamaması ve her taramada tüm verinin yeniden teslim edilmesiydi. → `file_path:docs/olcumler/2026-08-11-m1-denetim-raporu.md` | `file_path:core/src/store/db.ts`

**#25** [active] `parser-untrusted-input` dış denetim lensi Codex tarafından `cyberPolicy` gerekçesiyle iki kez reddedildi; saldırgan dili yumuşatarak yeniden ifade etmek reddi aşmadı. Bu alan 10 geliştirici dayanıklılık testiyle kısmen kapatıldı ancak bağımsız dış-göz denetimi yapılmış sayılmıyor ve başka bir motorla tekrar denenmeli. → `file_path:docs/olcumler/2026-08-11-m1-denetim-raporu.md` | `external_path:~/.claude/projects/-Users-burakemreerdemci-Documents-Context-Police/memory/codex-cyberpolicy-reddi.md`

**#26** [active] Canlı Claude Code ölçümünde transcript yazımı append-only çıktı: `--resume` sonrasında inode değişmedi ve mevcut önek byte-byte aynı kaldı; `/compact` ekleme yapıyor, retention ise dosyayı kısaltmak yerine siliyor. Aynı inode, aynı boyut ve aynı mtime korunarak yapılan yerinde yeniden yazım ucuz ve deterministik biçimde algılanamadığından demote edildi; bu karar CLI 2.1.226'nın append-only davranışına bağlıdır ve sürüm değişiminde yeniden ölçülmelidir. → `file_path:docs/olcumler/2026-08-11-m1-denetim-raporu.md`

**#27** [active] Transcript kimliğiyle ilgili ölçümde 35 siloda çakışan `cwd` bulunmadı; 192/192 dosyada `cwd` ilk dört satırdaydı ve hiçbir turn `cwd` çözülmeden teslim edilmiyordu. Buna rağmen imleç kimliği değişebilen proje kimliğine değil fiziksel transcript dosyasına bağlandı; aynı boyut ve inode ile yerinde yeniden yazımı yakalamak için mtime da imleç durumuna eklendi. → `file_path:docs/olcumler/2026-08-11-m1-denetim-raporu.md` | `file_path:core/src/adapters/claude-code.ts` | `file_path:core/src/store/schema.sql`

**#28** [active] Denetim sonrasındaki gerçek veri koşumu 35 silo ve 192 oturumdaki 378,2 MB transcript'i 15,5 MB ve 23.290 turn'e 0,9 saniyede süzdü; hemen ardından yapılan ikinci tarama sıfır iş yaptı. → `file_path:docs/olcumler/2026-08-11-m1-denetim-raporu.md`

**#29** [active] Tarama teslim sözleşmesi en-az-bir-kez olarak sabitlendi: imleç yalnız tüketici tesliminden sonra yazılıyor. Bu nedenle M2, olası tekrarları `source_ref` üzerinden tekilleştirmeli; ayrıca ham turn'ler kalıcı depoda tutulmayacak. → `file_path:core/src/scan.ts` | `external_path:~/.claude/projects/-Users-burakemreerdemci-Documents-Context-Police/memory/m1-durum.md`

**#30** [active] M2'de zehirli bir parti sonsuza kadar yeniden denenmeyecek: iki başarısız denemeden sonra `işlenemedi` olayı kaydedilecek ve filigran ilerletilecek. Kayıp; olaylar ve durum üzerinden görünür, transcript diskte ve olay UUID aralığını taşıdığı için geri kazanılabilir kalacak. → `file_path:docs/superpowers/plans/2026-08-11-m2-gozlemci-dongusu.md`

**#31** [active] M2 maliyet seli koruması olarak hiç taranmamış depoda `observe` çalıştırılmayacak ve kullanıcıya önce `scan` çalıştırması söylenecek; `--session` modunda tahmini çağrı sayısı 20'yi aşarsa `--yes` zorunlu olacak. Ölçüm tahmini tüm geçmiş için yaklaşık 500, en büyük tek oturum için yaklaşık 250 Codex çağrısıdır. → `file_path:docs/superpowers/plans/2026-08-11-m2-gozlemci-dongusu.md`

**#32** [active] M2 gözlemci çağrılarında varsayılan Codex modeli kullanılırken muhakeme seviyesi `low` olacak; ikisi de sırasıyla `--model` ve `--effort` ile değiştirilebilir. Çağrılar Codex oturum geçmişini kirletmemek için `--ephemeral` çalıştırılacak; komut sözleşmesi yerel `codex exec 0.146.0` ile doğrulandı. → `file_path:docs/superpowers/plans/2026-08-11-m2-gozlemci-dongusu.md`

**#33** [active] M2 çıkış kapısı, Context Police'in kendi M1 oturumu üzerinde gerçek koşumla anlamlılık, mükerrerlik, çapasızlık ve akış-durumu sızıntısı oranlarını ölçüp raporlayacak. Kapı yalnız otomatik ölçümlerle kapanmayacak; kullanıcıyla göz kontrolü zorunlu olacak. → `file_path:docs/superpowers/plans/2026-08-11-m2-gozlemci-dongusu.md`

**#34** [superseded→#35] M2 uygulaması görev başına Opus 5 alt ajanlarla yürütülecek; ana ajan her görevden gelen işi gözden geçirecek. → `file_path:docs/superpowers/plans/2026-08-11-m2-gozlemci-dongusu.md`

**#35** [unanchored] M2 çalışma düzeni değiştirildi: görev başına ayrı reviewer ve düzeltme döngüsü yapılmayacak; işçi ajan sonrasında yalnız hızlı mimari/sözleşme kontrolü uygulanacak, bulgular sonda Codex audit ve doğrulama turunda topluca ele alınacak. Yalnız sonraki görevlerin üzerine kurulacağı temel bir kusur görülürse hemen düzeltilecek. → (çapa yok)

**#36** [unanchored] Gözlemci yanıt ayrıştırıcısı `supersedes: null` değerini alan yokmuş gibi kabul edecek ve çıktıya taşımayacak. Doğrudan JSON ve çit-soyma başarısız olduğunda ilk `{` ile son `}` arasını aynı şema doğrulamasıyla yalnız bir kez deneyecek; kurtarma da başarısızsa teşhis için özgün hata korunacak. → (çapa yok)

**#37** [active] Görev 5 düzeltmeleri sonrasında tip denetimi temiz ve test paketi 110/110 başarılıydı. TDD doğrulamasında yeni testler düzeltme öncesi iki hata üretip düzeltme sonrasında tamamen geçti. → `external_path:task-5-report.md`

**#38** [active] Test yardımcısındaki sahte yürütücü sözleşmesi, başarısız sonuçta açıkça verilmedikçe boş çıktı üretmeyecek şekilde sabitlendi; açık `output` verilirse ihlal senaryosu kurabilmek için değer korunuyor. Koruyucu test eski davranışta özellikle 1 geçiş/1 hata, düzeltme sonrasında toplam 75/75 başarı verdi. → `symbol:fakeExecutor`
