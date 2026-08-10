# M1 Denetim Raporu — codex-audit, session-audit modu

**Tarih:** 2026-08-11 · **Kapsam:** `core/` (M1 çekirdek) · **Taban:** `5256876` → `6e6e3c0`
**Defter:** `.delegate-runs/AUDIT/ledger.jsonl` (yerel, gitignore'da)

---

## 1. Hangi lensler koştu, hangileri koşmadı

| Lens | Lane | Sonuç |
|---|---|---|
| `secret-leakage` | Codex | 3 bulgu, 3 probe |
| `state-integrity` | Codex | 9 bulgu, 9 probe |
| `failure-resilience` | Codex | 3 bulgu, 3 probe |
| `verification` (düzeltme farkı) | Codex | 12 probe (bulgu dosyası yazılmadan reddedildi) |
| `parser-untrusted-input` | Codex | **KOŞMADI** — iki kez sağlayıcı reddi (`cyberPolicy`) |
| `hygiene` | mimar (sayaçlar) | temiz |

**Dış göz boşluğu, açıkça:** `parser-untrusted-input` lensi hiç çalışmadı. Brief'i
saldırgan dilden arındırıp yeniden dağıttım, ikinci kez de reddedildi. Bu lensi
"temiz" saymıyorum; yerine 10 dayanıklılık testi yazdım
(`core/test/parser-robustness.test.ts`) ama bunlar **mimarın kendi kodunu
denetlemesi** — bu skill'in tam olarak kaçınmak için var olduğu şey. Açık kalem.

**Doğrulama lane'i de reddedildi ama 12 probe'u diske yazdıktan sonra.** Bulgu
dosyası yok; probe'lar var ve hepsi koşturulabilir. Diske yazma kuralı burada
somut olarak kâr etti.

## 2. Sayılar

| | |
|---|---|
| Toplam bulgu / probe | 27 |
| İlk koşumda ana ağaçta üreyen | 27/27 (probe seviyesinde hayalet yok) |
| Kapatılan | 20 |
| Demote (yazılı gerekçe + varsayım) | 3 |
| Farklı çareyle kapanmış, probe eski çareyi ölçüyor | 4 |
| **Doğrulama turu sonrası blocker** | **0** |
| Test sayısı | 40 → **73** |
| Gerçek koşum | 35 silo, 192 oturum, 378 MB → 15,5 MB, 0,9 sn |

## 3. En pahalı ders: düzeltme de denetlenmemiş koddur

İlk tur 15 bulgu verdi, hepsini kapattım. Sonra düzeltme farkı üzerine bir
doğrulama lane'i koştu ve **12 yeni kusur** buldu — hepsi düzeltmelerin kendi
ürünüydü. En ciddisi tek başına M1'i işlevsiz bırakırdı:

> İmleç anahtarını `(proje, oturum)`'dan dosya yoluna taşıdım. Var olan
> depolarda tablo eski anahtarla kaldığı için `ON CONFLICT (file_path)` hiçbir
> kısıtla eşleşmedi ve **imleç hiç yazılamaz oldu** — yani her tarama her şeyi
> yeniden teslim ederdi. Gürültülü patlaması tesadüftü; sessiz de olabilirdi.

İkinci ders: bir dizeyi **biçimine bakarak** güvenli ilan etmek çalışmıyor.
Bilinmeyen satırların anahtar adlarını "zararsız biçimdeki kısa adlar" diye
süzmüştüm; doğrulama turu bir API anahtarının da `[A-Za-z0-9_-]{1,40}` desenine
uyduğunu gösterdi. Çare desen değil, **bizim tanıdığımız sabit kelime dağarcığı**.

## 4. Kapatılan sınıflar (özet)

**Veri bütünlüğü:** `null`/dizi/skaler JSON satırı taramayı kalıcı kilitliyordu ·
yerinde kısaltma ve aynı-boyut yeniden yazım sessiz veri kaybıydı (mtime imlecin
parçası oldu) · sabit bağ ile aynı akış iki kez teslim ediliyordu · eski depo
göçü imleci yazılamaz hâle getiriyordu · `INSERT OR REPLACE` ve `DROP TRIGGER`
append-only sözleşmesini deliyordu · iç içe işlem geri alınamıyordu.

**Dayanıklılık:** tek bozuk oturum tüm taramayı öldürüyordu · okunamayan tek
dosya tüm silonun keşfini öldürüyordu · depo yazma hatası oturum hatası gibi
yutuluyordu · eşzamanlı iki tarama aynı aralığı iki kez teslim ediyordu · bayat
kilit canlı taramadan çalınabiliyordu.

**Gizlilik:** bilinmeyen satır olayı ham transcript içeriği saklıyordu · gizli
değer anahtar adı olarak da sızabiliyordu · depo 0755/0644 ile yaratılıyordu ·
CLI kontrol ve bidi karakterlerini terminale ham basıyordu.

## 5. Demote edilenler — her biri varsayımıyla

1. **`untrusted-project-identity-collision`** — 35 siloda çakışan `cwd` yok,
   aynı dosya adı/sessionId tekrarı yok, silo adı `cwd`'den deterministik türüyor.
   *Varsayım:* üst aracın (Claude Code) adlandırma davranışı; bizim kodumuz
   zorlamıyor. *Yine de guard eklendi:* imleç kimliği fiziksel dosyaya taşındı,
   sınıf yapısal olarak kapandı.
2. **`mtime-preserving-rewrite`** — aynı inode + aynı boyut + aynı mtime ile
   yeniden yazım tespit edilemiyor; ucuz deterministik guard yok.
   *Varsayım:* Claude Code yalnız append ediyor — canlı ölçüldü (CLI 2.1.226):
   `--resume` sonrası inode sabit, önek byte-byte aynı; `/compact` ekliyor;
   retention siliyor, kısaltmıyor. **Format sürüm değişikliğiyle yeniden yazmaya
   geçerse bu demote geçersizdir.**
3. **`raw-transcript-terminal-disclosure`** — `status` kullanıcının kendi proje
   listesini kendi terminaline basıyor; özelliğin kendisi. Enjeksiyon sınıfı
   (C0/C1/DEL + bidi) kaçırılıyor ve testle sabit.

## 6. Probe'un teste terfisi

27 probe'un iddiası üç dosyada kalıcı test oldu:
`test/audit-regressions.test.ts`, `test/verification-regressions.test.ts`,
`test/parser-robustness.test.ts`. Probe script'leri repoya girmedi; iddiaları
girdi. Bir düzeltmenin geri alınması bu testleri kırar.

## 7. Kırmızı kalan probe'lar — neden kırmızı

Altı probe hâlâ `rc=1`, biri `rc=2`. Hiçbiri açık kusur değil; hepsinin yazılı
verdikti defterde:

- `concurrent-double-processing`, `stale-lock-steal`, `cursor-write-error-swallowed`,
  `rollback-error-masking` → **farklı çareyle kapandı.** Probe'lar "koordine
  olsun / yutulsun" bekliyordu; seçilen çare fail-fast. Doğru özellik testle sabit.
- `cwd-resolution-replays` → tekrar teslim bitti (testle sabit); kalan yetim
  proje satırı demote.
- `cli-transcript-metadata-output`, `mtime-collision` → demote (§5).
- `callback-crash-duplicates` (`rc=2`) → probe'un öncülü geçersizleşti; teslim
  en-az-bir-kez sözleşmesi testle sabit.

## 8. Sonraki denetim için açık kalemler

1. `parser-untrusted-input` lensi dış gözle hiç denetlenmedi — başka bir motorla
   (Claude lane, Gemini) tekrar denenmeli.
2. Süreçler arası eşzamanlılık (ayrı CLI süreçleri, SQLite busy davranışı) yalnız
   süreç içi ölçüldü.
3. `mtime-preserving-rewrite` demote'u CLI sürümüne bağlı; sürüm atlayınca
   yeniden ölçülmeli.
