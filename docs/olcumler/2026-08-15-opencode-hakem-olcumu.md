# opencode + bedava DeepSeek hakem olarak — ölçüm

**15 Ağu 2026.** 28 notluk altın set koşumu, `golden-v2.jsonl`'e karşı.
Model: `opencode/deepseek-v4-flash-free`, opencode 1.18.16.
Depo pin'i `b4065f1`, izole klon üzerinde.

**Bu ölçüm M4'ün çıkış kapısını KAPATMAZ.** Kapının taban sayıları Codex'in
`gpt-5.6-sol`'uyla üretildi; burada ölçülen şey "M4 geçti mi" değil, *bedava
bir modelin hakem olarak ne kadar iyi olduğu*. Maliyet ölçütü de bedava
modelle anlamsız biçimde geçer.

> **DÜZELTME (15 Ağu 2026 akşam, denetim turu).** Bu raporun ilk sürümü opencode
> yakalamasını **%29,3** diye verdi. Sayı yanlıştı ve sebebi ölçme aletiydi:
> `score.ts` kapsamı hakemin KENDİ çıktısından türetiyordu, dolayısıyla hakemin
> `parse_failed` ile çuvalladığı 6 not paydadan tamamen düştü ve onlardaki 19
> hedef "kaçırılmış" sayılmadı. Yani alet bozuldukça skor yükseliyordu. Kapsam
> artık maliyet günlüğündeki DENENMİŞ not listesinden geliyor; doğru sayı
> **%20,0**. Aşağıdaki tablo düzeltilmiş hâliyle duruyor.
> Codex sayıları ETKİLENMEDİ (o koşum 28/28 notu kapsıyor), yani M4'ün kapı
> tabanı değişmedi.

## Sonuç

| | Codex (gpt-5.6-sol) | **opencode (deepseek-v4-flash-free)** |
|---|---|---|
| kapsanan not | 28/28 | 28/28 denendi, **22'si iddia üretebildi** |
| çıkarılan iddia | 1210 | **397** |
| yakalama | 53/60 = %88,3 | **12/60 = %20,0** |
| not düzeyi yakalama | 18/18 = %100 | **8/18 = %44,4** |
| yanlış alarm | 24 | **2** |
| maliyet | kotalı | **$0,00** |

Hüküm dağılımı (opencode, 397 iddia): `gecerli` 211 · `olculemez` 156 ·
`curuk` 20 · `dogustan-yanlis` 10.

Kaynak tüketimi: 1.676.356 token, 102 dakika toplam süre (3 paralel ile duvar
saatinde ~35 dk), **maliyet sıfır** — 28 koşumun hepsinde `cost: 0`.

## Okuma: aşırı temkinli bir hakem

Profil Codex'in tam tersi. Yanlış alarm 24'ten **2'ye** düşüyor, ama yakalama
%88'den **%20'ye** iniyor. Model yanlış bir şey söylemekten kaçınıyor ve
bedeli hedeflerin beşte dördünü kaçırmak oluyor.

**Kaçırmanın birinci sebebi yargı değil, BÖLME.** opencode not başına ortalama
**18 iddia** çıkarıyor, Codex **43**. Etiketlenmeyen bir iddia hiç
yargılanmıyor — yani kaçan hedeflerin bir kısmı "yanlış hüküm" değil "hiç
hüküm yok". Bu, aynı sınıfın üçüncü görünüşü: 13 Ağu'da iki tarafın iddiaları
farklı bölmesi ölçülmüştü (bölme uyuşması %9,2), M4.3'te altın setin kendi
hatalarının 13'ü tek bir bölme kusuruydu.

Sonuç olarak bu model **hakem olarak yetersiz, ama ÇAPRAZ KONTROL için ilgi
çekici**: "yanlış" dediğinde nadiren yanılıyor (2 yanlış alarm / 30 olumsuz
hüküm). M4.8'in ikinci-model kolu için doğal aday — ve bedava.

## %21 dönüşüm kaybı — asıl darboğaz

28 notun **6'sı** (`kabuk-olcum-tuzaklari`, `kimi-provider-dogrulanmadi`,
`masaustu-guven-modeli`, `onay-kapisi-kapsami`, `teslim-yolu-denetimi`,
`unity-mcp-yerel-auth`) skor hattına hiç ulaşmadı. Hiçbiri zaman aşımı ya da
hata değil (`rc=0`, `cap: 0`): **ikinci geçiş kendi cevabını sözleşmeye
çeviremedi.**

Sebep yapısal: opencode'da **şema zorlama yok**. Codex `adjudicatorSchema`'yı
zorunlu çıktı şeması olarak dayatabiliyor; opencode'da modeli biçime bağlayan
tek şey istem metni. Birinci geçişte model sözleşmeyi tamamen yok sayıp
Markdown tablosu üretiyor (ölçüldü, tek not probe'unda), ikinci geçiş bunu
%79 oranında kurtarıyor.

Kapatılırsa kapsama 22'den 28'e çıkar; yakalamanın ne olacağı **ölçülmedi**.

## Yöntem notları

- **`--format json` stdin'i bekliyor.** Yönlendirmesiz çağrı 5+ dakika askıda
  kalıyor, sıfır bayt. `< /dev/null` şart. Bkz. hafıza: `opencode-olcumu`.
- **`--pure` zorunlu.** Aksi hâlde opencode kullanıcının global skill'lerini
  yüklüyor (bir probe'da kişisel hafıza skill'i ateşledi) ve sabit istem yükü
  ~11.600'den ~4.200 tokene düşüyor.
- **İzole klon.** opencode izin sormadan dosya yazıyor, o yüzden hakem gerçek
  `unityaıPython` deposunda değil pin'den çıkarılmış sert-bağlantısız bir
  klonda koşturuldu. Kaynak depo değişmedi (doğrulandı).
- İki geçiş: ölçüm (~240 sn) + aynı oturumda sözleşmeye çevirme (~12 sn).

## Ölçülmeyenler

- Dönüşüm kaybı kapatılırsa yakalama ne olur
- `opencode-go/deepseek-v4-pro` (ücretli) aynı notlarda ne yapar
- Bölme farkının yakalamaya katkısı ne kadar (kaçan 29 iddianın kaçı
  "etiketlenmemiş", kaçı "yanlış etiketlenmiş")
- Red davranışı — bu koşumda hiç red görülmedi
