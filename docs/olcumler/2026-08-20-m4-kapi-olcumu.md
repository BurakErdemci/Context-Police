# M4 kapı ölçümü — 20 Ağu 2026 (yeni taban)

Hakem: Codex `gpt-5.6-sol` (CODEX_HOME=~/.codex-worker) · pin `b4065f1` ·
ölçüt `golden-v2.jsonl` (404 iddia, 28 not) · `--evidence --parallel 4
--timeout-sec 1800 --max-items 400 --max-tokens 16M`.

**Bu koşum ESKİ TABANLA (13 Ağu 53/60 · 24) KARŞILAŞTIRILAMAZ ve onun yerine
geçer:** arada M4.6 çapa çıktısını değiştirdi (29 dosyanın 20'si), sembol
çapaları görüntü-only'ye indi (kanıt bloğuna "ölçülemedi" satırı olarak
giriyorlar), parmak izi türetimi değişti. 12 Ağu kararı gereği koşum yeniden
yapıldı; bugünkü sayılar bundan sonraki karşılaştırmaların tabanıdır.

## Sonuç

| | iddia düzeyi | not düzeyi |
|---|---|---|
| yakalama | **43/60 = %71,7** | **18/18 = %100** |
| yanlış alarm | **33** (230 geçerli iddia içinde) | 4/10 |
| KULLANICIYA | 0 (28 notun hepsi tarihli — kapı hep açıktı) | 0/28 |

Kapı ifadesi (yakalama ≥ %80 · yanlış alarm < 12 · not başına maliyet 1/10):
**üç kalem de kırmızı.** Ama not düzeyinde tablo tam tersi: çürük notların
HEPSİ işaretlendi — hakem hangi notun çürük olduğunu buluyor, hangi İDDİANIN
çürük olduğunda hassasiyeti düşüyor.

## Maliyet

28 not · seri toplam 15.007 sn (parallel 4 ile duvar saati ~85 dk) ·
ham girdi 61,2M (önbellek 57,1M = %93) · **taze girdi 4,09M** · çıktı 544k
(269k akıl yürütme) · 1.261 iddia. Not başına ort. 536 sn / 146k taze girdi.
Operatör gözlemi: koşum sırasında (17/28 bitmişken) kota göstergesi %66'daydı —
"tam tarama = haftalık kotanın yarısı" beklentisinin altında.

`bekleyen-isler` (687 satır, korpustaki en büyük not) 16M ham-girdi tavanına
takıldı (17,9M, rc=-1) → `incomplete/`, skorda "denetlenmeyen"; tek hedef
iddiası kaçırılmış sayıldı (payda korundu, skor şişmedi).

## Koşumdan önce kapanan iki alet kusuru (bugün, duman koşumu yakaladı)

1. **Sağlayıcı strict-schema:** `required` artık her property'yi listelemek
   zorunda; `unmeasurable_reason` opsiyonelliği `null` enum'una taşındı
   (`497d7f4`). İlk duman koşumu 5 sn'de `invalid_json_schema` ile düşmüştü.
2. **flatten olay akışını hiç ayrıştıramıyordu:** testleri sentetik düz JSON'la
   yazılmıştı, gerçek `--json` akışına karşı hiç koşmamıştı; koşucunun aday
   kuralı lib'e taşındı (`3ffbc91`, `streamMessageCandidates`).

## Bilinen pürüz

- Her satırda "ŞEMA KAYMASI (tanınmayan olay N)": codex-cli akışına yeni olay
  türleri eklenmiş; iddialar eksiksiz geldiği için zararsız ama
  `KNOWN_EVENT_TYPES` bir sonraki turda güncellenmeli (gürültü gerçek kaymayı
  maskeleyebilir).

## Sıradaki (karar Burak'ta)

- Maliyet kısıcılar (keşif-turu tavanı, sembol satırlarını kanıt bloğundan
  düşürme) **5-6 notluk alt kümede** ölçülecek — tam 28'lik ancak yeni
  konfigürasyon taban olurken.
- Sade-dil katmanı: hüküm/kanıt metni kullanıcı diline (B yolu: geriye dönük
  ucuz çeviri geçişi; A yolu: hakem şemasına `user_summary` alanı — A, taban
  kirletmemek için sonraki konfigürasyon turuna).
- Kaçan 17 iddianın 6'sı sayım/DURUM sınıfında görünüyor (":3 description",
  "172 test fonksiyonu", "1682 satır") — 13 Ağu'daki "sayım iddiaları kaçıyor"
  bulgusuyla aynı aile; istem düzeltmesi adayı.
