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
