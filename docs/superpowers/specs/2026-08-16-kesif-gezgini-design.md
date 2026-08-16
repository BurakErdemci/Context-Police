# Keşif Gezgini (M5 v1) — tasarım

**Tarih:** 16 Ağu 2026 · **Karar sahibi:** Burak
**Statü:** onaylandı (bu oturumda, soru-cevapla)

## 1. Amaç ve rol

Bu arayüz teslim edilecek bir özellik değil, **karar aleti**. Üç açık mimari
karar (born-wrong `olculemez` mi `curuk` mu; mükerrer tarih çıkarıcı; skor
kapısının kaldırılması) uygulama kullanılmadan verilemiyor (Burak, 16 Ağu).
V1'in işi: depodaki hükümleri, kanıtları ve koşum davranışını görünür kılmak —
"nerede patlıyor"u göstermek.

**V1 SALT-OKUNURDUR.** Onay akışı, restore, hafıza dosyasına yazma — hiçbiri
yok. Onay UX'i keşif turunun gözlemleriyle sonra tasarlanacak. "Onaysız hiçbir
yazma yok" kuralı v1'de kodla garanti: SQLite bağlantısı **readonly modda**
açılır, yazım fiziken imkânsız.

## 2. Kararlar (soru-cevapla verildi, 16 Ağu)

| Karar | Seçim | Gerekçe |
|---|---|---|
| V1 kapsamı | Salt-okunur gezgin | Kararları beslemek için görmek yetiyor; onay UX'i gözlemle şekillensin |
| Kabuk | `context-police serve` + tarayıcı | Sıfır yeni bağımlılık (node:http); Tauri sonradan aynı API'ye takılabilir |
| Veri kaynağı | `--store <yol>` parametreli, varsayılan `~/.context-police/store.db` | Gerçek veriyle keşif + fixture depoyla test, tek bayrak |
| Sayfa yığını | Vanilla ES modules, build yok | Sıfır-bağımlılık ilkesi; salt-okunur tablo+detay için framework getirisi düşük |

## 3. Ekranlar — her biri bir açık kararı besliyor

### 3.1 Kuyruk (ana ekran)

Canlı hükümler listesi (`superseded_by IS NULL`). Sütunlar: not (finding
özeti) · `claim_ref` · hüküm rozeti · `sub_reason` · şüphe skoru
(`findings.suspicion`) · `repeat_count` · `source` · tarih. Filtre: hüküm,
`sub_reason`, `source`, `review`. Varsayılan sıralama **skor azalan** —
"skor kapısı kalktı, sıralama yetiyor mu" kararının test alanı.

Üstte 5 hükmün sayaç şeridi (tıklanınca filtreler). `olculemez` ayrı ve
görünür: "bakıldı ve ölçülemedi" ≠ "temiz" (roadmap M5 kuralı).

### 3.2 Not detayı

Bir finding'in tam sicili, **iddia düzeyinde** (not düzeyi uyarı %97 doğruyu
gömer — roadmap M5 kuralı):

- Not içeriği (`findings.content`) + durum + şüphe skoru
- Çapalar (`anchors`: kind + value + taken_at_commit)
- İddia başına canlı hüküm + kanıt (`evidence`) + yöntem (`method`) +
  varsa düzeltme önerisi (`correction`)
- **Supersession zinciri**: eski hükümler üstü çizili ve soluk, yenisinin
  altında, kronolojik. Hiçbir kayıt gizlenmez.

Born-wrong ve tarih-çıkarıcı kararlarının verisi bu ekranda.

### 3.3 Koşumlar

`events` tablosundan audit koşumları, yeniden eskiye: `audit_completed`
detayları (kaç hüküm yazıldı, `starvedFindings`, süre vb. — detail JSON'u
tablo halinde) + diğer olay türleri filtrelenebilir ham liste.
"Uygulama nerede patlıyor"un zaman ekseni.

## 4. Mimari

```
core/src/serve/
  api.ts      depodan okuyan saf sorgu fonksiyonları (sunucudan bağımsız, doğrudan testli)
  serve.ts    node:http sunucu: /api/* JSON + core/web/ statik servisi
core/web/
  index.html + app.js + birkaç modül + style.css   (ES modules, build yok)
```

- CLI: `context-police serve [--store <yol>] [--port <n>]` — varsayılan port
  **4870**; doluysa sunucu açılmaz ve hata portu ve `--port` çözümünü söyler.
- Depo `openStore`'dan DEĞİL ayrı bir readonly açılıştan gelir: `new
  DatabaseSync(path, {readOnly: true})`. Şema uygulama/migrate yolu HİÇ
  koşmaz — gezgin depoyu olduğu gibi okur, eski şemalı depoda eksik
  sütun/tablo hatası kullanıcıya "depo eski, bir kez audit koştur" olarak
  gösterilir.
- Sunucu yalnız `127.0.0.1`'e bağlanır.
- API uçları: `/api/summary` (hüküm sayaçları) · `/api/verdicts?<filtreler>`
  · `/api/findings/:id` (not + çapalar + hüküm zinciri) · `/api/runs` ·
  `/api/version` (canlılık için: max verdict id + max event id).

## 5. Canlılık

WebSocket/SSE yok. İstemci **3 sn'de bir** `/api/version` sorgular; değer
değiştiyse açık görünümü yeniden çeker. Audit koşarken ekranın dolması
izlenebilir — keşif turunun görmek istediği davranış. WS gerekirse sonra,
API değişmeden eklenir.

## 6. Görsel yön (frontend-design + ui-ux-pro-max skill'leriyle)

**Konu dünyası:** denetim defteri — hükümler, kanıtlar, silinmeyen sicil.

- **İmza öğesi — silinmeyen sicil:** supersession zinciri görsel merkez.
  Eski hükümler üstü çizili + soluk, altında "neden değişti". §3.2'nin
  ekrandaki bedeni. Cesaret bütçesi burada; gerisi sessiz.
- **Renk — hüküm renk sistemi:** 5 hükmün kendisi palet: `gecerli` yeşil ·
  `curuk` pas turuncusu · `dogustan-yanlis` mor · `olculemez` çelik
  mavisi-gri · `tarihsel` nötr. Zemin koyu mürekkep mavisi (#0B1020
  ailesi). Renk asla tek başına anlam taşımaz: rozet = renk + metin.
- **Tipografi:** veri alanları `ui-monospace` sistem yığını; başlık/gövde
  sistem sans'ı. **Web fontu ve hiçbir dış istek yok** — sayfa çevrimdışı
  çalışır. Kişilik işleyişten: geniş aralıklı küçük-büyük-harf eyebrow
  etiketler, tabular rakamlar, sıkı satır yüksekliği.
- **Yoğunluk 9/10:** 8–32px aralık skalası. Kuyruk: sayaç şeridi + geniş
  tablo + satıra tıklayınca sağdan detay paneli.
- **Hareket ~sıfır:** yalnız panel açılışı (~200ms), `prefers-reduced-motion`
  destekli.
- **UX kuralları (skill veritabanından):** boş durum yönlendirici metinle
  ("Depo boş — `context-police audit` koştur") · tablo `overflow-x: auto` ·
  klavye odağı görünür · kontrast 4.5:1 · ikon olarak emoji yok.
- **Varsayılan-görünüm sapması bilinçli:** aletin önerdiği "slate + tek
  yeşil vurgu" paleti AI-varsayılan görünüm #2'ye düşüyordu; çok-renkli
  anlam sistemi ve sicil imzasıyla değiştirildi.

## 7. Hata yönetimi

- Depo dosyası yok → sunucu açılır, sayfa "depo bulunamadı: <yol>" der
  (boş ekran değil, yönlendirme).
- Depo eski şemalı (sorguda eksik sütun/tablo) → API 200 + yapılandırılmış
  uyarı; sayfa "depo eski, `context-police audit` bir kez koşunca güncellenir"
  gösterir. Sessiz çökme yok.
- Depo başka süreççe yazılırken okuma: readonly bağlantı WAL'da okumaya
  devam eder; `SQLITE_BUSY` görülürse istemci bir sonraki poll'da toparlar.

## 8. Test

- `api.ts`: `node:test` + fixture depo (mevcut test yardımcıları) — boş
  depo, dolu depo, supersession zinciri, filtre kombinasyonları, eski-şema
  deposu (readonly açılışta migrate koşmadığının kanıtı dahil).
- `serve.ts`: birkaç uçtan uca HTTP testi (`fetch`): JSON uçları + statik
  servis + 404 + yol kaçışı (path traversal) reddi.
- Tarayıcı tarafına otomatik test yok (v1 salt-okunur; el keşfi işin
  kendisi). Playwright duman testi istenirse sonra.

## 9. Kapsam dışı (bilinçli)

Onay/restore akışı ve her türlü yazma · WebSocket/SSE · Tauri paketleme ·
onboarding/proje seçimi · kullanım-sıklığı görünümleri · DURUM-sınıfı
ölçümü (M5'in açık işi ama gezginin v1'ine değil, ölçüm hattına ait).
