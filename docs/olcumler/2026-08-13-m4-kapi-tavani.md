# M4 · Hakem kapısının tavanı — ve kapının kaldırılması kararı

**Tarih:** 13 Ağustos 2026
**Araç:** `tools/altin-set/gate-ceiling.ts`
**Girdi:** `docs/olcumler/altin-set/golden-v1.jsonl` (391 iddia) +
`docs/olcumler/altin-set/r3-note-scores.json` (28 notun r3 skoru)

## 0. Neden inşadan önce

M4'te mekanik skorun işi hüküm vermek değil, hakeme kapı açmak olacaktı. Ama
kapının altında kalan bir not hakemi **hiç görmez** — hakem kusursuz olsa bile
o nottaki hedef iddialar yakalanamaz. Yani hakemin doğruluğunu ölçmenin bir
anlamı olması için önce kapının önüne koyduğu tavanı bilmek gerekiyordu.

Ölçüm dakikalar sürdü ve milestone'un tasarımını değiştirdi. Pahalı katman
inşa edilmeden önce ucuz kontrol — CLAUDE.md §7.

## 1. Ölçüm

Hedef küme: `curuk` 33 + `dogustan-yanlis` 12 = **45 iddia**.
(`olculemez` ve `tarihsel` dışarıda: hakem kod olduğu sürece ulaşılamazlar.)

| eşik | hakeme giden not | erişilebilir hedef iddia | tavan |
|---|---|---|---|
| 0,7 | 6/28 | 15/45 | %33,3 |
| **0,6 — M3'ün eşiği** | 6/28 | 15/45 | **%33,3** |
| 0,5 | 9/28 | 19/45 | %42,2 |
| **0,4 — planlanan kapı** | 13/28 | 27/45 | **%60,0** |
| 0,2 | 17/28 | 33/45 | %73,3 |
| 0,0 | 28/28 | 45/45 | %100 |

İki eşik kararı veriyle doğrulandı: 0,6 → 0,4 tavanı %33'ten %60'a çıkarıyor.

## 2. Asıl bulgu — eşik ayarı yetmiyor

Kaçan 18 iddianın **10'u tek bir notta**: `unity-architect-mimari`, skor
**0,00**. Hedef kümenin **%22'si**, ve mekanik sinyal onu hiç görmüyor.

Sebebi aynı gün ölçüldü (`2026-08-13-m4-altin-set-iddia-duzeyi.md` §6.1):
o not **bayat bir kaynaktan kopyalanmış** — transcript'te tek yazımda
`2026-07-27T06:48:24`'te doğdu, anlattığı kod ise 2026-05'te değişmişti.

Sonuç: çapa kaymıyor, commit yoğunluğu yok, DURUM kalıbı yok.
**Çürüme sinyalleri doğuştan-yanlış içeriğe yapısal olarak kördür** — ortada
bir değişim yok ki yakalasınlar. CLAUDE.md §2.4'ün değişim-tetikli tasarımı
bu sınıf için tanımı gereği çalışmıyor.

Bu notu hiçbir eşik getirmiyor: ne 0,4, ne 0,2. Yalnız 0,0 getiriyor — yani
kapıyı kaldırmak.

## 3. KARAR — kapı kalkıyor, skor sıralıyor

**Karar: Burak, 13 Ağu 2026.**

Skorun işi **kapı açmak değil, sıraya dizmek**. Tüm notlar eninde sonunda
hakeme gider; skor yalnız hangisinin önce gideceğini belirler.

Gerekçeler:
1. **Tavan %100 olur.** Çıkış kapısı artık kapının değil hakemin doğruluğunu
   ölçer — ki M4'ün ölçmek istediği tam olarak budur.
2. **Doğuştan-yanlış sınıfı kendiliğinden kapsanır.** Ayrı bir sinyal icat
   etmeye gerek kalmaz; o sınıfın tek dedektörü zaten hakemin kendisi.
3. **Maliyet §2.4 ile sınırlanır.** Her koşumda 28 not değil, yalnız çapası
   oynayan notlar yeniden hükme girer. İlk tam tarama bir kereye mahsus.
4. **İki mekanizma yerine bir mekanizma.** Kapı + taban tarama melezi, "sıra
   ne zaman gelir" sorusuyla yeni bir açlık yüzeyi açardı — M3'te bu sınıf
   tek günde altı form üretti (`denetim-protokol-dersleri`).

### Neyi geçersiz kılıyor

12 Ağu'da onaylanan **iki eşik** tasarımının "hakem kapısı" yarısı düştü.
`suspect` hükmünün hakemin çıktısı olması yarısı **duruyor** — asıl karar oydu.
Skor artık öncelik sırası; eşik yalnız sıralama içinde bir kesme noktası
olarak kalırsa o da ayrıca gerekçelendirilmeli.

## 4. Bu kararı geçersiz kılabilecek ölçüm — HENÜZ YAPILMADI

Karar **bir varsayıma** dayanıyor: hakem çağrısının maliyeti 28 notluk bir tam
taramayı kaldırabilecek kadar düşük. Bu ölçülmedi.

Ölçülmesi gereken, inşadan önce:
- Not başına hakem çağrısının token maliyeti ve süresi
- 28 notluk tam taramanın toplam maliyeti
- Değişim-tetikli artımlı koşumda tipik not sayısı (kaç not gerçekten oynuyor)

Maliyet beklenenden yüksek çıkarsa kapı kararı yeniden açılır. Mevcut maliyet
kapısı proje başına en kötü 3 çağrı varsayıyor (`observe-cmd.ts:115`); tam
tarama bunu **on kat** aşar, yani kapı da yeniden tasarlanmalı.

## 5. Sınanmayanlar

- Skorlar r3 koşumundan alındı (r3/r4/r5 bit-aynı, 28 notta 0 fark), yani
  bugünkü davranışı temsil ediyor — ama **yeniden koşturularak doğrulanmadı**;
  ölçüm veritabanı (`/tmp/cp-m3-olcum/`) silinmiş, sayılar r3 raporunun
  tablosundan alındı.
- Tavan **tek bir denek** üzerinde ölçüldü (GaMachine, 28 not). Başka bir
  hafıza silosunda dağılımın nasıl olacağı bilinmiyor — özellikle "tek notun
  hedefin %22'sini taşıması" bu deneğe özgü olabilir.
- Altın setin kendisi eksik kapsamlı olabilir (Codex geçişinin eşleşmeyen 394
  iddiası dışarıda), yani 45'lik hedef küme bir alt sınır.
