# Context Police — Uygulama Roadmap'i

> **Not:** Bu bir milestone roadmap'i, takvim değil. Her milestone başlarken o
> milestone'un ayrıntılı uygulama planı (adım adım, test-önce,
> `docs/superpowers/plans/` altına) ayrıca yazılır ve onaya sunulur. Kod, M0
> tamamlanıp go kararı çıkmadan başlamaz.

**Hedef:** Onaylı spec'i (`docs/superpowers/specs/2026-08-10-context-police-design.md`)
çalışan, dağıtılabilir bir prototipe dönüştürmek.

**Projenin başarı skaleri** (ilk commit'ten önce yazılması gereken tek sayı):
*altın setteki çürümüş notların boru hattı tarafından kendiliğinden yakalanma
oranı.* Altın set M0'da doğar; her milestone bu sayıyı ya üretir ya iyileştirir.

---

## M0 — Retrospektif çürüme ölçümü (kod yok)

**Soru:** Bu ürün gerçek bir problemi mi çözüyor? Sayıyla cevap.

- GaMachine'in mevcut `memory/*.md` notları tek tek git geçmişine ve bugünkü kod
  durumuna karşı elle (Claude + araçlar) denetlenir.
- Her not için hüküm: geçerli / çürümüş / kararsız + çürümüşse *hangi commit bozdu*.
- Çıktılar:
  1. **Ölçüm raporu** — çürüme oranı, çürüme biçimlerinin dağılımı (dosya silindi /
     imza değişti / karar tersine döndü / durum bayatladı).
  2. **Altın test seti** — çürümüş notlar + bozan commit'ler; sonraki her
     milestone'un doğrulama zemini.
  3. **Kalibrasyon verisi** — şüphe eşiği (başlangıç 0.6) ve Claude çapraz
     kontrolünün varsayılanı (yanlış-pozitif oranı düşükse kapalı) buradan.
- **Çıkış kapısı (go/no-go):** Çürüme oranı anlamlıysa devam; değilse proje ucuza
  ölür — bu da başarılı bir sonuçtur (spec K11).

## M1 — Çekirdek iskelet + transcript tarayıcı

**Soru:** Claude Code oturumlarını güvenilir ve artımlı okuyabiliyor muyuz?

- Monorepo kurulumu: `core` paketi (Node/TS), test altyapısı.
- SQLite şeması: `projects / findings / anchors / events` (spec §3.2 birebir).
- `TranscriptAdapter` seam'i + Claude Code jsonl implementasyonu: proje keşfi,
  bayt imleci, yarım-satır dayanıklılığı, LLM'siz turn süzme.
- Bilinmeyen satır tipi → atla + `events`'e logla (spec §3.7).
- **Çıkış kapısı:** `context-police scan` gerçek transcript'lerde koşar; imleç
  kalıcı; gerçek transcript fixture'larıyla testler yeşil.

## M2 — Gözlemci döngüsü

**Soru:** Transcript'ten kaliteli, çapalı, append-only bulgu çıkıyor mu?

- `ExecutorAdapter` seam'i + Codex headless implementasyonu; Codex tespiti
  (sert bağımlılık — spec K2).
- Gözlemci prompt'u: durum = bulgu başlık listesi; çıktı JSON; çapa zorunlu;
  yalnız ekleme/supersede. Geçersiz JSON → bir tekrar → "işlenemedi" işareti.
- Testlerde sahte executor (seam'in ilk kârı).
- **Çıkış kapısı:** Gerçek bir oturumdan depoya anlamlı bulgular düşüyor;
  mükerrer üretim ve çapasız bulgu oranı göz kontrolünden geçiyor.

## M3 — Import + sinyal motoru

**Soru:** Çürümeyi LLM'siz sinyallerle yakalayabiliyor muyuz? (Altın setle ilk yüzleşme)

- `memory/*.md` import + eşleme (dosya değişti → eski temsil superseded).
- Anchor kayması: git'e karşı (dosya silindi / N+ commit / sembol kayıp).
- Çelişki adaylığı: mekanik ön eleme + tek ucuz Codex sınıflaması.
- Şüphe skoru birikimi; git olmayan projede anchor sinyali kapalı.
- **Çıkış kapısı:** **Başarı skaleri ilk kez ölçülür** — altın setteki çürümüş
  notların sinyal katmanında yakalanma oranı raporlanır.

## M4 — Hakem + çapraz kontrol

**Soru:** Eşik üstü şüphede güvenilir hüküm ve düzeltme önerisi üretiliyor mu?

- Hakem: temiz bağlam, araçlı `codex exec`, ölçüm çerçevesi (asla teyit sorusu —
  spec §3.4); çıktı: hüküm + kanıt + önerilen düzeltme.
- Claude çapraz kontrolü (`claude -p`): ayarlanabilir; varsayılanı M0 verisi
  belirler; hemfikirlik rozeti üretimi.
- Hüküm ne olursa olsun disk yazımı yok — sonuçlar depoda bekler (spec K9).
- **Çıkış kapısı:** Altın set üzerinde hakem doğruluğu raporlanır (yakalama +
  yanlış alarm oranı).

## M5 — Dashboard + onay akışı (Tauri)

**Soru:** Kullanıcı neyi neden onayladığını tam görerek, güvenle düzeltebiliyor mu?

- Çekirdeğe HTTP + WebSocket API (UI↔çekirdek seam'i resmileşir).
- Tauri kabuk + dört görünüm: Projeler / Onay kuyruğu / Bulgu deposu / Denetim
  günlüğü (hata oranı metriği canlı).
- Onboarding: Codex tespiti (geçilmez kapı) → proje seçimi (varsayılan hepsi).
- Onay akışı: diff + kanıt + rozet kartları; Onayla → `memory/*.md`'ye iz
  bloğuyla yazım; Reddet → yanlış alarm kaydı; Restore da onaylı yazımdır.
- **Çıkış kapısı:** Uçtan uca akış: tespit → hüküm → onay → dosyada şeffaf
  düzeltme; onaysız hiçbir yazım olmadığı testle gösterilir.

## M6 — Dogfood + paketleme

**Soru:** Ürün kendi üstünde çalışıyor ve dağıtılabiliyor mu?

- Context Police kendi projesini + GaMachine'i izler (dogfood); bir hafta
  birikimli hata oranı metriği.
- Sidecar paketleme kararı (bun compile / pkg) ve Tauri build; temiz makinede
  onboarding provası.
- İsim kararı (açık kalanlar listesinden — dağıtımdan önce çözülmeli).
- **Çıkış kapısı:** Temiz bir makinede kurulup onboarding'den geçen build;
  başarı skalerinin son değeri raporlanır.

---

## Sıralama gerekçesi

- **M0 en önde** çünkü hem go/no-go kapısı hem de M3/M4'ün doğrulama zeminini
  (altın set) üretiyor — o olmadan sonraki milestone'ların çıkış kapıları ölçülemez.
- **Tarayıcı (M1) gözlemciden (M2) önce** çünkü gözlemcinin girdisi tarayıcının
  çıktısı; M1'in fixture'ları M2'nin testlerini besliyor.
- **Sinyaller (M3) hakemden (M4) önce** çünkü hakem yalnız eşik üstünde koşuyor —
  eşiği üreten katman olmadan hakemi doğrulamak mümkün değil.
- **UI en sonda (M5)** çünkü onay akışının gösterdiği her şey (kanıt, rozet, diff)
  ancak M4 sonunda var oluyor; daha erken UI, sahte veriyle UI olurdu.
- Her milestone bir öncekinin çıktısını tüketiyor; hiçbirinin çıkış kapısı bir
  sonrakine ertelenmiş değil.
