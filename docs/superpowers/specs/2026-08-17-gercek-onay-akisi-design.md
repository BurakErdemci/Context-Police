# Gerçek onay akışı V1 — tasarım (17 Ağu 2026)

Onaylayan: Burak, 17 Ağu. Kararlar AskUserQuestion turunda tek tek verildi;
tek değişiklik sözlü geldi: **ürünün ana formu Tauri masaüstü uygulaması** —
web serve geçici önizleme kabuğu. Mimari buna göre bağlandı (§2).

## 1. Kapsam

**V1 = sadece depo-review.** Onayla/Reddet kararı depoya yazılır
(`verdicts.review`), kuyruk gerçekten boşalır, sicil kararı gösterir.

Kapsam DIŞI (bilerek):
- Hafıza dosyasına yazım (V2). Gerekçe: core'da bugün hiçbir dosya yazımı yok
  ve mekanik yolda `correction` hep NULL — yazılacak metin çoğu vakada yok.
- Toplu onay. Yanlış-pozitif oranı ölçülmeden blanket approval yok
  (task-observer dersi); karar hüküm başına.
- Auth. localhost bağlama + özel başlık yeter.

## 2. Yazma seam'i — gevşeme tek modüle hapsedilir

Readonly garantisinin bilinçli gevşetilmesi budur; sınırı şu:

- Yeni modül `core/src/serve/review-write.ts`. POST başına
  `openStore(path)` → `reviewVerdict()` → `close()`. **İstek başına aç/kapa**;
  kalıcı yazılabilir handle tutulmaz (onay nadir, açık handle audit'le yarış
  penceresini büyütür).
- `api.ts` ve tüm sorgu katmanı `ReadStore` tipinde KALIR. Garanti artık
  "serve yazamaz" değil, "serve'in tek yazma kapısı review-write.ts'tir".
- **Kabuk bağımsızlığı (Burak, 17 Ağu):** karar mantığının tamamı
  `reviewVerdict` + review-write çekirdeğinde; HTTP ucu ince adaptör.
  Tauri'de aynı çekirdek sidecar HTTP'den ya da IPC'den çağrılır. Tarayıcıya
  özgü varsayım (çerez, origin, oturum) tasarıma girmez.

## 3. HTTP sözleşmesi

`route()`'a metot ayrımı girer (bugün yok; POST'lar GET dalına düşüyor).

- `POST /api/verdicts/:id/review`, gövde `{"decision":"approved"|"rejected"}`.
- Cevaplar: **200** yazıldı (güncel satırı döner) · **404** id yok ·
  **409** superseded ya da zaten kararlı (`reviewVerdict`'in reddi HTTP'ye
  taşınır) · **400** bozuk gövde/decision · **403** başlık eksik.
- **CSRF kapısı:** istek `X-CP-Review: 1` başlığı taşımak zorunda.
  Cross-origin bir sayfa bu başlığı preflight'sız gönderemez; OPTIONS'a
  cevap verilmez. Web-önizleme döneminin tedbiri; Tauri'de zararsız kalıntı.
- GET dışı metotlar diğer yollarda **405** alır (bugünkü sessiz GET-düşmesi
  kapanır).
- Depo dosyası yokken POST → **409** `{storeMissing:true}` (200 değil;
  yazma yolunda "yok"un sessiz başarıya benzemesi tehlikeli).

## 4. Kuyruk semantiği

- Bekleyen = `review IS NULL AND superseded = 0` — pozitif status filtresi
  DEĞİL, dışlama. (task-observer dersi: opsiyonel alana grep, alanı olmayan
  satırı sessizce düşürür.)
- **Sayım mutabakatı:** `toplam = bekleyen + kararlı + superseded` her kuyruk
  cevabında doğrulanır; tutmuyorsa API hata döner, sessizce ilerlemez.
- Kararlı hüküm ekrandan anında kaybolmaz: mevcut render'da
  "onaylandı/reddedildi" rozetiyle kalır, sonraki gezinmede kuyruktan düşer.

## 5. Red bastırması (audit tarafı)

Reddedilen `(finding, sebep)` çifti, kanıtı değişmedikçe kuyruğa dönmez:

- Hüküm yaratılırken satıra **kanıt parmak izi** yazılır: hükmü doğuran
  kanıtın deterministik hash'i (çapa durumu / karşı-iddia metni — hangi
  alanların girdiği uygulama planında sabitlenir ve teste bağlanır).
- Audit aynı `(finding, sebep)` için yeni hüküm üretirken son REDDEDİLMİŞ
  hükmün parmak izine bakar. Aynıysa yeni bekleyen hüküm **yaratılmaz**,
  `verdict_suppressed` event'i düşülür (sicilde izlenir, görünmezlik yok).
  Kanıt değiştiyse normal akış.
- Append-only bozulmaz: hiçbir kayıt silinmez/değişmez; yalnız mükerrer
  üretim engellenir. Bastırma yalnız `rejected` için — `approved` supersede
  akışını zaten izler.

## 6. Frontend

- `reviewControls` sessionStorage (`cp-mock-review`) yerine POST atar;
  başarı event ürettiği için `/api/version` oynar, 3 sn poll ekranı tazeler.
- "Önizleme — kararlar henüz kaydedilmiyor" notu kalkar.
- Hata halleri kullanıcı dilinde: 409'da "bu hüküm zaten kararlı /
  geçersiz kılınmış", ağ hatasında karar DÜŞMEZ, buton eski halinde kalır
  ve tek satır açıklama görünür.

## 7. Test hattı

- POST ucu: mutlu yol · 404/409/400/403/405 · başlıksız istek reddi ·
  storeMissing 409.
- Eşzamanlılık: audit koşarken (scan kilidi altında, açık yazar handle
  varken) review yazımı — WAL + busy_timeout ile tamamlanmalı; test gerçek
  iki bağlantıyla kurulur.
- Bastırma: aynı parmak izi → üretilmez + event düşer; değişen kanıt →
  üretilir; `approved` bastırılmaz.
- Sayım mutabakatı: kasıtlı bozuk durumda API'nin hata döndüğü gösterilir.
- Mevcut migration disiplinini izler: şema değişikliği varsa (parmak izi
  kolonu) `migrate()` aynı commit'te ve VAR OLAN depo kopyasına karşı test
  edilir (CLAUDE.md §7).

## 8. Riskler / açık uçlar

- Parmak izinin girdi kümesi yanlış seçilirse bastırma ya hiç ısırmaz ya
  fazla ısırır; ilk gerçek audit'te `verdict_suppressed` sayısı ölçülür ve
  rapor edilir (kalibre edilmemiş eşik sınıfına düşmemesi için sayı izlenir).
- Serve yazımı ile audit yazımı arasındaki yarış SQLite düzeyinde çözülür
  (WAL + busy_timeout); uygulama düzeyinde kuyruk kilidi V1'de yok — onay
  tekil ve idempotent olduğu için kabul edilen risk.
