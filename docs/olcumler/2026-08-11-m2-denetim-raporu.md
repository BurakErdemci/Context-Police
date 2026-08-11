# M2 Denetim Raporu — codex-audit, session-audit modu

**Tarih:** 2026-08-11 · **Kapsam:** M2 gözlemci döngüsü · **Taban:** `d6cc6c0`
**Denetlenen commit'ler:** `ee4dafe..d6cc6c0` (8 görev) · **Defter:** `.delegate-runs/AUDIT/ledger.jsonl`
**Tüm probe verdiktleri ANA AĞACA karşı ölçüldü** (`AUDIT_ROOT` ile; lane kopyasına değil).

---

## 1. Hangi lensler koştu

Tehdit modeli önce çıkarıldı, lensler ondan türetildi. M2'nin getirdiği yeni yüzey:
model çıktısı artık güvenilmeyen girdi, ve araç alt süreç çalıştırıp kullanıcının
parasını harcıyor.

| Lens | Lane | Sonuç |
|---|---|---|
| `model-output-trust` | Codex | 4 bulgu, 4 probe |
| `exec-boundary` | Codex | 4 bulgu, 4 probe |
| `state-integrity` | Codex | 2 bulgu, 2 probe |
| `cost-availability` | Codex | 5 bulgu, 5 probe |
| `hygiene` | mimar (sayaçlar) | temiz (typecheck + 182 test) |

**Dört lane de koştu, hiçbiri reddedilmedi** — M1'in aksine (orada
`parser-untrusted-input` iki kez `cyberPolicy` ile reddedilmişti). Sıfır bulgu
"temiz lens" sayılmadı: her lane'in log kuyruğunda `cyberPolicy` arandı.

## 2. Sayılar

| | |
|---|---|
| Bulgu (avcı turu) | 15 |
| İlk koşumda ana ağaçta üreyen | **15/15** (probe seviyesinde hayalet yok) |
| Doğrulama turu 1 → bulgu | 5 (hepsi düzeltmelerin kendisinde) |
| Doğrulama turu 2 → bulgu | 6 (2'si high) |
| Toplam kapatılan | 24 sınıf |
| Guard | 1 |
| Demote (yazılı gerekçe + varsayım) | 4 |
| Test | 122 → **182** |
| Düzeltme dalgası | 5 (3 grup + 2 doğrulama turu) |

## 3. En pahalı ders: doğrulama turu ikinci kez kazandı

M1'in dersi ("düzeltme de denetlenmemiş koddur") M2'de **iki kez** tekrarlandı:

- **1. tur** düzeltmelerde 5 kusur buldu. En ciddisi tek başına veri kaybettiriyordu:
  filigrana eklenen zaman damgası kimliği *düşürme ölçütü* olarak kullanılıyordu.
  Ölçtüm: gerçek turn'lerin **%11,55'i** aynı damgayı paylaşıyor, **%0,70'i** bir
  öncekinden geri gidiyor — yani zaman damgası bu veri için sıralama anahtarı değil.
  Üstelik normal ileri teslimatta uuid araması zaten tutmadığı için o dal istisna
  değil kural olarak çalışıyordu.
- **2. tur**, 1. turun düzeltmelerinde 6 kusur buldu; ikisi high. Biri, benim
  düzeltme brief'imde "aşırı düzeltme veri kaybettirir, iki yönü de test et" diye
  yazdığım şeyin ta kendisiydi: çapa filtresi **meşru emoji dosya adlarını**
  (`docs/❤️.md`) reddeder olmuştu.

## 4. Denetimin en değerli bulgusu

**`watermark-duplicate-uuid-loss`** — gerçek akışta kalıcı turn kaybı.

Codex'in yazdığı senaryo yanlıştı (transcript'in yeniden sıralanmasını gerektiriyordu;
bağımsız çürütücü onu çürüttü: hiçbir yolda yeniden sıralama yok). Ama **sınıf
ayaktaydı** ve çürütücü onu gerçek veriyle ispatladı:

> Aynı uuid transcript'te ikinci kez geçebiliyor — `--resume`/fork geçmiş bloğunu
> dosyanın sonuna yeniden append ediyor. Ölçüm: 209 oturum / 49.693 uuid'li satırda
> **3.426 mükerrer uuid satırı**. Filigran elemesi `findIndex` (ilk oluşum) +
> `slice(i+1)` yaptığı için, ilk eşleşme yeni append edilmiş kopyaya düşüyor ve
> ondan önceki **gerçekten yeni** turn'ler sessizce atılıyor.
>
> Gerçek akış reprosu (yalnız append, sıra bozulmadan): `observe` → kullanıcı
> `--resume` yapar → sonraki `observe` **20 turn'ü kalıcı olarak atıyor**, ve
> `match: "uuid"` olduğu için uyarı olayı bile yazılmıyor.

Çare: eleme yalnız eşleşme **tek anlamlı** iken uygulanıyor — (a) tam bir eşleşme,
(b) eşleşenden önce daha yeni damgalı turn yok. Aksi hâlde eleme yok +
`watermark_ambiguous_match` olayı. Sonuç: **20 kayıp → 0**, bedeli %1 ek çağrı.

**İçindeki ders:** arızayı kesen koşul (b) çıktı, (a) değil. Tarama bayt imlecinden
ileri okuduğu için mükerrerin ilk kopyası imlecin gerisinde kalıyor ve teslimatta
**tek** eşleşme görünüyor — sezgisel çare ("uuid birden çok geçiyorsa dikkat et") bu
gerçek arızayı kaçırırdı. Gerçek akış reprosu istemek tam da bunun içindir.

## 5. Kapatılan sınıflar (özet)

**Model çıktısı güveni:** gösterilmeyen id'ler supersede edilebiliyordu (kod kendi
yorumuyla çelişiyordu — plan kusuru) · tek yanıt 512 kalıcı kayıt yazabiliyordu ·
kontrol/görünmez karakterli çapa kabul ediliyordu, sonra da meşru emoji reddedilir
olmuştu (iki yön de kapandı).

**Alt süreç sınırı:** yarım teslim edilen prompt başarı sayılıyordu · zaman aşımında
torun süreçler yaşıyordu · `detect()` timeout'suzdu (iki lane bağımsız buldu) ·
tek dev satır karesel okuma maliyeti üretiyordu (ölçülen en büyük gerçek satır
1,54 MiB; sınır 8 MiB, yani 5,2 kat pay).

**Durum bütünlüğü:** filigran geri sarabiliyordu · uuid'siz parti hiç checkpoint
yazamıyordu (sonsuz yeniden deneme) · zaman damgası yanlışlıkla düşürme ölçütü
olmuştu · mükerrer uuid kalıcı kayıp üretiyordu · şema göçü filigranı bozuyordu ·
göç kesintiye karşı atomik değildi.

**Maliyet:** scan modunda çağrı bütçesi yoktu (ölçüldü: onaysız 21 çağrı) · tahmin
kurtarma çağrılarını saymıyordu (20 sanılan iş 40 çağrı yapıyordu; en kötü çarpan
3 olarak hesaplandı) · `--batch-tokens 1e308` tahmini sıfıra indiriyordu ·
geçersiz `--effort` kalıcı gözlem boşluğu üretiyordu.

## 6. Guard ve demote'lar — her biri varsayımıyla

1. **`prompt-injection-supersede` → guard.** Transcript metni prompt'a ham giriyor;
   bir turn "gösterilen bulguyu geçersiz kıl" diyebilir ve model uyabilir. Tam
   savunma prototip kapsamı değil. *Enforcement:* her supersede `finding_superseded`
   olayına yazılıyor. *Varsayım:* K8 (silme yok) + K9 (onaysız disk yazımı yok) —
   yanlış supersede görünür ve tek tık geri alınabilir, hafıza dosyasına inmez.
2. **`unbounded-watermark-redelivery` → demote.** Bağımsız çürütücü (Claude, çapraz
   model) gerçek çağıranların o teslimat dizisini üretemediğini uçtan uca ölçtü
   (dönüşümlü koşumda çağrı dizisi 1,0,0,0,0). *Varsayım:* transcript normalde yalnız
   append ile büyür — **ölçülmedi**, M1'in append-only ölçümüne dayanıyor. Varsayım
   çökerse kalıntı canlanır (yeniden yazım başına sabit maliyet, koşum başına 20
   çağrı tavanıyla sınırlı).
3. **`uuidless-checkpoint-residual` → demote.** Yalnız hem uuid hem damga taşımayan
   turn'lerde geçerli. *Varsayım:* Claude Code her user/assistant satırına ikisini de
   yazıyor — ölçüldü, 19.416/19.416 (ve bağımsız ikinci sayım: 65.756 satırda eksik 0).
   Format değişirse geçersizdir. *Guard:* `observer_batch_no_checkpoint` olayı.
4. **Bayat probe'lar (2 adet) → demote.** `detect` probe'ları 6 sn/500 ms eşiği
   ölçüyor, seçilen ürün sınırı 10 sn; `scan-mode-call-budget` yeni çıkış kodu 4'ü
   bilmiyor. İkisi de elle doğrulandı (10,0 sn'de `found:false`; 20 çağrıda `rc=4`).

## 7. Doğrulama satırı

- **Doğrulama turu sayısı:** 2 koştu (+1 son tur), tavan 3.
- **1. tur:** 5 bulgu → hepsi düzeltildi, 5/5 probe kırmızıdan yeşile döndü.
- **2. tur:** 6 bulgu → 4'ü düzeltildi, 1'i çürütüldü (demote), 1'i **çürütülemedi
  ve düzeltildi** (§4). **2. turun turu `cyberPolicy` ile reddedildi** — ama 6 bulgu
  ve 6 probe diske yazıldıktan sonra. Bu tur "tamamlanmış" değil **kurtarılmış**
  sayılmalı; diske-yazım kuralı M1'de olduğu gibi burada da kâr etti.
- **High bulgular bağımsız çürütmeye gönderildi** (Codex bulduğu için Codex'in
  çürütmesi aynı kör noktayı paylaşırdı): 1 çürütüldü, 1 çürütülemedi.
- **3. tur (tavan) 5 bulgu döndürdü, 5/5 ana ağaçta üredi, 1'i high.** Tur sıfır
  blocker ile kapanmadı. Skill'in kuralı gereği bu dördüncü tur talebi değil:
  düzeltme yaklaşımının yanlış olduğunun kanıtı ve mimara/kullanıcıya taşınır (§11).

## 7.1 Üç turun deseni — asıl bulgu bu

| Tur | Filigran | Çapa filtresi |
|---|---|---|
| 1 | ts düşürme ölçütü olmuş → kayıp | — |
| 2 | mükerrer uuid → 20 turn kalıcı kayıp | meşru emoji reddediliyor (aşırı düzeltme) |
| 3 | eşit damga + geri damgalı uuid'siz → kayıp; mükerrer terminal uuid → sabit nokta yok | emoji-tag/CJK varyant reddediliyor **ve** piktograf-ZWJ dizisi geçiyor |

İki alt sistem üç turdur aynı şekilde kanıyor ve her düzeltme yeni bir belirsizlik
açığa çıkarıyor. Bu, tek tek bulguların değil **yaklaşımın** kusuru:

- **Filigran:** "bu turn işlendi mi" sorusu içerik kimliğinden (uuid + zaman damgası)
  çıkarılmaya çalışılıyor. Oysa gerçek olgu konumsal ve `scan.ts` onu zaten kesin
  biliyor: hangi bayt aralığını teslim ettiğini. Kimlikten çıkarım her seferinde
  yeni bir belirsizlik üretiyor (mükerrer uuid, eşit damga, geri damga, uuid'sizlik).
- **Çapa filtresi:** Unicode elle sınıflandırılmaya çalışılıyor; her düzeltme ya
  meşru içeriği reddediyor ya zararlıyı geçiriyor — salınım.

## 8. Sağlayıcı reddi hakkında ölçülmüş yeni bilgi

M1'de çıkarım "güvenlik dilli brief'ler reddediliyor, yeniden ifadelendirme işe
yaramıyor" idi. M2 bunu inceltti:

- Güvenlik dilli **4 avcı lane'i sorunsuz koştu** (prompt enjeksiyonu, argüman
  enjeksiyonu, TOCTOU, DoS). Yani konu tek başına reddettirmiyor.
- Reddedilen brief 11 kez "**kır / kırmaya çalış**" diyordu. Aynı kapsam, aynı
  dosyalar, aynı model ile brief "bu iddiaların bugün geçerli olup olmadığını
  **ÖLÇ**" diye yeniden yazıldı → koştu ve 5 gerçek kusur buldu.
- **Tetikleyici konu değil görevin şekli.** Bu zaten bu projenin kendi spec'inin
  §2.1 nüansı: teyit/saldırı sorusu değil, ölçüm görevi.
- Sınanmayan: eşiğin tam yeri (kaç "kır", hangi bağlam). İki uçtan birer ölçüm var.

## 9. Tekrarlayan sınıf — CLAUDE.md kuralı adayı

**Şema göçü sınıfı bu projede üçüncü kez çıktı:** M1'de imleç tablosu (o turun en
ciddi bulgusuydu — imleç yazılamaz olmuştu), M2 1. turda filigran tablosu, 2. turda
göçün atomikliği. Üç ayrı denetimde üç kez = örüntü.

**Aday kural (onay bekliyor, otomatik eklenmedi):**
> Şemaya sütun/tablo eklerken `CREATE TABLE IF NOT EXISTS` yetmez — var olan depo
> için `migrate()` yolu aynı commit'te yazılır ve **var olan bir depo dosyası
> üzerinde** doğrulanır. Yeni depoda çalışması kanıt değildir.

## 10. Açık kalemler

1. `unbounded-watermark-redelivery` demote'u append-only varsayımına bağlı; CLI
   sürümü atlayınca yeniden ölçülmeli (M1'in `mtime-preserving-rewrite` demote'uyla
   aynı şekil, aynı kırılganlık).
2. Süreçler arası eşzamanlılık hâlâ yalnız süreç içi ölçüldü (M1'den devreden kalem).
3. Windows süreç topolojisi ölçülmedi (`detached`/negatif PID POSIX davranışı).
4. Belirsiz eşleşme kuralı muhafazakâr: damgası geri giden %0,70'lik turn'lerde
   gereksiz mükerrer bulgu üretebilir. Bilinçli tercih (mükerrer geri alınabilir,
   kayıp alınamaz) ama sahada `watermark_ambiguous_match` sayacı izlenmeli.
5. `observer_failed` gürültüsü: bütçe durdurma oturum başına bir olay yazıyor ve
   `events` silinemez. Temiz çözüm `scan.ts`'in bütçe bitişini erken durdurma
   sinyali sayması — M3'e devredildi.

## 11. Tavan aşıldı — mimar kararı bekleyen iki tasarım değişikliği

3. tur sıfır blocker vermedi. Dördüncü bir yama turu yerine iki kök çare öneriliyor;
karar Burak'ın (bu rapor onun önüne bu haliyle gidiyor).

**A. Filigranı kimlikten çıkarma, teslimatın kendisine sor.**
`scan.ts` her teslimatta hangi bayt aralığını okuduğunu kesin biliyor (imleç zaten
orada ve yalnız ileri gidiyor). Gözlemciye turn'lerle birlikte o aralık verilir,
gözlemci "şu bayt ofsetine kadar işledim" kaydeder. Tekrar teslim = aynı aralık →
kesin eşleşme; ileri teslimat = yeni aralık → eleme yok. Belirsizlik kalmaz:
mükerrer uuid, eşit damga, geri damga, uuid'sizlik — dördü de konuyla ilgisiz hale
gelir. Maliyet: `onTurns` sözleşmesine bir alan + filigran tablosunda bir sütun.
*Not:* M1 defteri "M2 tekrarı `source_ref` ile elemek zorunda" diye yazmıştı; bu
öneri o reçetenin yerine geçer, çünkü sorun tekrarın tespiti değil kimliğin
belirsizliğiymiş.

**B. Çapa filtresini basitleştir.**
Unicode'u elle sınıflandırmayı bırak: yalnız tartışmasız zararlı ve dar küme
reddedilsin (C0/C1, DEL, satır sonu, bidi kontrolleri, satır/paragraf ayırıcı);
geri kalan her şey kabul edilsin. Gerekçe: çapa bir **veri**, ve M3'ün sinyal
motoru zaten her çapayı git'e karşı doğrulayacak — var olmayan bir çapa orada
kendiliğinden düşer. Emoji/CJK/ZWJ inceliklerini burada çözmeye çalışmak salınım
üretiyor ve meşru dosya adlarını kaybettiriyor.

Bu iki değişiklik yapılana kadar kalan risk, raporun §7.1'indeki üçüncü satırı:
dar ama gerçek kayıp yolları (eşit damga + yeniden append edilmiş mükerrer uuid)
ve dar ama gerçek çapa reddi (emoji-tag / CJK varyant dizili dosya adları).
