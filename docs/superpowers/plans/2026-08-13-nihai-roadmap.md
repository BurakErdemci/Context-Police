# Context Police — nihai roadmap

**Tarih:** 13 Ağustos 2026
**Temel:** bugünkü yedi ölçüm. Her madde bir sayıya dayanıyor; dayanmayanlar
"varsayım" diye işaretli.

---

## 0. Bugün nerede duruyoruz

M0–M3 kapandı. M4'ün ilk yarısı (ölçüt + hakem prototipi) bugün ölçüldü.

| ölçüm | sonuç |
|---|---|
| Altın set v1 | 391 iddia · 28 not · hedef küme **45** |
| Hakem, iddia düzeyi | yakalama **37/45 (%82,2)** · yanlış alarm **39** |
| Hakem, not düzeyi | yakalama **15/15** · yanlış alarm **7/13** |
| Mekanik skor (M3) | yakalama 6/17 (%35,3) · yanlış alarm 0/11 |
| Hakem maliyeti | not başına **482 sn / 1,96M ham girdi** |
| Çapa hareketi | haftada **3,1 not** (kötü hafta 9) |
| Tetiklenebilir not | **12/28** |
| Codex–Claude uyuşmazlığı | gerçek yargı ayrılığı **3/24** |

**Tek cümlelik durum:** ürün artık çürümeyi buluyor; sorun bulduğunun ne kadarının
doğru olduğu ve bunu ne pahasına yaptığı.

---

## 1. Darboğaz yer değiştirdi — roadmap'in eksenini bu belirliyor

M3'ün mekanik skoru **kesin ama kör**: %35 yakalama, sıfır yanlış alarm.
Hakem **kapsayıcı ama gürültülü**: %100 not yakalama, 13 temiz notun 7'si
işaretlenmiş.

Kapsama problemi çözüldü. **Kalan iş hassasiyet ve maliyet.**

Bu, kullanıcı için de doğru sıra: eksik yakalama sessiz bir zarardır, yanlış
alarm ise görünür ve güveni doğrudan yer. Onay kapısı arkasında duran bir
üründe (K9: onaysız yazma yok) 7/13 yanlış işaret, kullanıcının onay
yorgunluğuna düşmesi demektir — ve o noktada denetçi okunmayan bir uyarı
üreticisine dönüşür.

---

## M4 · Kalan iş — "hakem güvenilir ve ucuz"

### M4.1 · Maliyet tavanı — KODDA, istemde değil

**Neden:** not başına 1,96M ham girdi ve 482 sn. Bu bir ölçüm maliyeti değil
**ürün kusuru**; arka planda koşan bir denetçi kullanıcının kotasını böyle
yiyemez (Burak, 13 Ağu: "asıl uygulamada böyle bir şey olmaması gerek").

**Ölçülmüş gerekçe:** istemdeki "hiçbir komut 60 saniyeyi geçmesin" talimatı
**bağlamadı** — bir hakem 3 dakikalık iç içe git döngüsü koşturdu. Talimat
ricadır, yaptırım değildir.

- `ExecutorResult` token taşısın: adaptör `codex exec -o`'dan `--json`'a
  geçsin, `turn.completed.usage` alanı taşınsın. **Ürün bugün kendi maliyetini
  göremiyor** — her bütçe kararının ön koşulu bu.
- Not başına tavan: tur sayısı + token + süre. Aşılırsa çağrı **kesilir** ve o
  not `olculemez` işaretlenir. Ölçmemek asla suçlamaya dönmez — bu sözleşme
  `anchor-drift.ts`'te zaten var, hakeme de taşınmalı.
- Koşum başına toplam bütçe, mevcut `auditCostGate` ile aynı yerde.

**Çıkış ölçütü:** aynı 28 notluk koşum, not başına tavanla; yakalama kaybı
ölçülür. Bugünkü %82,2 referans.

### M4.2 · Hassasiyet — `dogustan-yanlis` yedek kova olmayı bıraksın

**Neden:** 39 yanlış alarmın **27'si** bu hükümden. Hakem, değişim kanıtı
bulamadığında buraya düşüyor.

**Kök sebep:** "doğuştan yanlış" demek, iddianın *yazıldığı gün de* yanlış
olduğunu kanıtlamayı gerektirir — notun damgasına karşı geçmiş ölçümü. İstemde
notun tarihi belirgin değil. (`parse.ts` damgayı zaten çıkarıyor: `modified` →
`created` → `date`.)

- Notun damgası isteme konsun, ve o tarihteki depo durumu erişilebilir olsun.
- `dogustan-yanlis` için şart: o tarihte ölçüm yapıldı mı? Yapılamadıysa doğru
  cevap `curuk` değil **`olculemez`**.
- Aynı şart `curuk` için de: "yazıldığında doğruydu" yarısı ölçülmediyse hüküm
  zayıftır.

**Çıkış ölçütü:** yanlış alarm 39'dan düşsün, yakalama %82,2'nin altına
inmesin. İkisi birlikte raporlanır — biri diğerine feda edilemez.

### M4.3 · Altın setin yanlış alarmları gözden geçirilsin

**Neden:** ilk turda 5 yanlış alarmın 1'i **altın setin hatasıydı** (hakem
`origin/main=19c623f` ölçüp haklı çıktı). Aynı oran geçerliyse gerçek yanlış
alarm sayısı bugün raporlanandan düşük.

39 yanlış alarm tek tek incelenip altın set düzeltilir. **Altın set ölçüttür,
kutsal değildir** — ve düzeltmesi ürünü düzeltmekten ucuzdur.

Bu turda ayrıca: kaçan 8 iddianın bir kısmı gerçekten `olculemez` olabilir
(`~/.codex-worker` depo dışı). Onlar da yeniden hükme bağlanır.

### M4.4 · Güvenlik sınırı — hakem sırra uzanmasın

**Neden (canlı vaka, 13 Ağu):** bir hakem, kimlik depolamayla ilgili bir notu
ölçerken **keychain erişimi için izin istedi**. Bugünkü istemde bunu yasaklayan
satır yok.

Bir not "API anahtarlarını Keychain'de tutuyoruz" diyorsa bu **doğrulanabilir
bir iddiadır** ve hakem doğal olarak oraya uzanır.

- İstemde açık yasak: keychain, `security`, `.env` içeriği, `~/.ssh`, token
  dosyaları → `olculemez`.
- **Sırrın varlığı ölçülebilir, değeri ölçülmez.**
- Yaptırım istemde kalmasın (M4.1'in dersi): çalışma kökü depoyla sınırlansın,
  dışarı çıkan komutlar reddedilsin. `-s read-only` yazmayı engelliyor ama
  **okumayı engellemiyor**.

### M4.5 · Sıralama — kapı yok, öncelik var

**Karar (13 Ağu, ölçümle doğrulandı):** skor kapı açmaz, sıraya dizer.

**Doğrulayan iki ölçüm:** (a) tavan ölçümü — 0,6 eşiğinde hakem hedefin ancak
%33'ünü görebiliyordu; (b) tam koşum — kapının hiç göremediği notlarda hakem
%100 yakaladı, `unity-architect-mimari` dahil (hedefin %22'si, skor 0,00).

- Çapası oynayan not öne alınır (haftada ~3, kötü hafta 9 — bütçeye sığıyor).
- **Tetiklenemeyen 16 not için rotasyon şart.** 28 notun 14'ünde hiç
  `file_path` çapası yok, 2'si yolunu kaybediyor; yalnız 12/28 hareket sinyali
  üretebiliyor. Rotasyon olmazsa o notlar hiç denetlenmez.
- Rotasyon **açlık üretmeyecek** biçimde: M3'te bu sınıf tek günde altı form
  üretti; damga kimliğe göre yazılır, konuma göre değil.

### M4.6 · Sembol çapası — kusur, düzeltilecek

`parse.ts`'in backtick içi sembol regex'i jenerik kelimeleri sembol sayıyor:
`return` **100 commit'e** vuruyor; `type`, `true`, `null`, `main`, `check` de
öyle. Sembol tetikleyici olarak kullanılsaydı haftada 16 not oynuyor
görünürdü — sinyal değil gürültü.

Not: bu düzeltme çapa çıktısını değiştirir → altın setin yeniden ölçümünü
gerektirir. **Lookbehind düzeltmesiyle aynı koşuma bindirilmeli**
(`parse.ts:176`, "M4'e ERTELENDİ", ölçüldü: 18.180 ms → 0,63 ms).

### M4.7 · Çıktı sözleşmesi — M5'in girdisi

Hüküm + kanıt + **önerilen düzeltme metni**. Disk yazımı yok (K9); hüküm
depoda bekler, kullanıcı onaylar.

Depoda bugün **kalıcı hüküm tablosu yok** — sınıflama hükmü yalnız `events`
satırı ve `findings.status/suspicion` mutasyonu olarak yaşıyor. Hakemin çıktısı
için yer açılmalı. **Şema değişikliği → `migrate()` aynı commit'te ve VAR OLAN
depoya karşı doğrulanmalı** (CLAUDE.md §7; bu sınıf üç denetimde üst üste çıktı).

### M4.8 · Çapraz kontrol — dar ve sonda

**Ölçüldü:** 24 çatışmanın yalnız **3'ü** gerçek yargı ayrılığı; 6'sı bir
tarafın komutu yanlış kurmasıydı, 14'ü ölçme aletinin yapaylığıydı.

- **Sıra: önce kanıtı yeniden koşturt, sonra ikinci modele sor.** Çatışmaların
  dörtte biri yeniden ölçümle kapanıyor ve bu çok daha ucuz.
- Çapraz kontrol hakemin **çıktısı** üzerinde, girdisinde değil.
- Varsayılan **kapalı**; yalnız hakem "kararsız" döndüğünde ya da hüküm bir
  eşiğin üstünde etkiliyse açılır.

**M4 çıkış kapısı:** aynı 28 notluk koşum, maliyet tavanı açık —
yakalama ≥ %80 · yanlış alarm bugünkünün yarısından az · not başına maliyet
bugünkünün onda biri. Üçü birlikte raporlanır.

---

## M5 · Kullanıcı yüzeyi

Backend güvenilir olmadan başlamaz (Burak, 12 Ağu: "önce yapısal backend
bitsin, UI işi kolay").

- **Onay akışı.** Onaysız hiçbir yazma yok — bu projenin en sert kuralı.
  Kullanıcı hükmü + kanıtı + önerilen düzeltmeyi görür, onaylarsa **hafıza
  dosyasına** yazılır (ajan bir sonraki okumada alır).
- **Silme yok.** `superseded` + `superseded_by`. Yanlış işaretlemenin bedeli
  sıfır, geri alma tek tık — ve **geri alma oranı denetçinin kendi hata oranıdır**,
  bedavaya birikir. Bu skaler M5'in ilk gününden itibaren gösterilmeli.
- **İddia düzeyinde gösterim.** Ölçüldü: bir notun %3'ü ölmüş olabiliyor
  (`unity-mcp-yerel-auth` 22 iddia, sıfır çürük). Not düzeyinde uyarmak
  kullanıcıyı %97 doğru bilgiden mahrum bırakır.
- **Ölçülemez ayrı gösterilir.** Hakemin çıktısının %41'i bu kovada; "bakıldı
  ve ölçülemedi" ile "temiz" aynı şey değil.

---

## M6 · Yayılma (kapsam dışı sayılmıştı, artık sıraya girebilir)

- Hook tabanlı ingestion (bugün transcript/pull).
- Codex / agy adaptörleri (seam var, tek implementasyon).
- Otonom arka plan zamanlaması.
- Kullanım sıklığı takibi → **yüksek kullanım × yüksek çürüme riski** önceliği.

---

## Devredilen borçlar — kaybolmasın

| borç | yer | not |
|---|---|---|
| lookbehind regex | `parse.ts:176` | 18.180 ms → 0,63 ms; çapa çıktısını değiştirir |
| sembol regex gürültüsü | `parse.ts` | M4.6; aynı yeniden ölçüme bindirilmeli |
| yüzey-içi sel (açlığın 6. formu) | `classify.ts:228` | damga 0'ın mutlak önceliği yaşlandırılmalı |
| damga taşması | `classify.ts:312`, `classify-stamps.ts:43` | `MAX_SAFE_INTEGER` sınırı |
| iki yanıltıcı probe | `.delegate-runs/AUDIT/2026-08-12/probes/` | biri çürütülmüş iddiayı kodluyor, biri rc=2 |
| sınıflama bütçesi | `classify.ts:14` | koşum başına adayların bir kısmı hâlâ kırpılıyor |
| `runCodex` zaman aşımı yok | `tools/altin-set/adjudicate-cost.ts` | üründe var, ölçüm aracında yok |

---

## Onay bekleyen kural adayları (CLAUDE.md'ye YAZILMADI)

1. **Alt süreç bütçesi** — 2 denetimde çıktı.
2. **Açlık sınıfı** — bir günde 6 form; sonlanma kuralı tur sayısına değil
   **sınıf tekrarına** bakmalı.
3. **Ölçülmemiş yazılı iddia** — 4 kez; kapsama sınırı dört sürüm gördü, üçü
   ölçümle yanlışlandı.
4. **YENİ: ölçme aletinin kendi hatası** — iki kaynağı karşılaştıran bir
   ölçümde eşleme ölçütü ayrıca doğrulanmalı. Ölçüldü: aletin hatası (%58)
   gerçek sinyalden (%12,5) büyüktü, ve bunu ancak üçüncü bir tur yakaladı.

---

## Bugünün ölçümlerinin sınırları — roadmap bunlara dayanıyor

- Hepsi **tek denek** (GaMachine, 28 not) ve **tek koşum**. Oynaklık ölçülmedi.
- Altın set **tek bölmeye** dayanıyor; Codex geçişinin eşleşmeyen 394 iddiası
  dışarıda. Hedef küme 45 bir **alt sınır**.
- İki geçişin **uyuştuğu** iddialar hiç sınanmadı — ortak yanlılık uyuşma
  olarak okunur.
- Hakemin doğruluğu **altın sete karşı** ölçüldü; altın setin kendisinin hata
  oranı bilinmiyor (M4.3 bunu daraltacak).
