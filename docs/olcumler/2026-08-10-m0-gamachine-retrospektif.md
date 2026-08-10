# M0 — GaMachine Retrospektif Çürüme Ölçümü

**Tarih:** 2026-08-10
**Denek:** GaMachine (eski adı Unity Architect AI) — repo `~/Documents/unityaiPython`
(çalışma ağacı `b4065f1`, `origin/main` `19c623f` = 12 commit ileri), hafıza silosu
`~/.claude/projects/-Users-burakemreerdemci-Documents-unitya-Python/memory/` (28 not).
**Yöntem:** 4 paralel Opus 5 denetçi ajanı, not başına iddia çıkarımı + diske/git'e
karşı ölçüm (grep, `git log`, `git grep`, dosya okuma). Kanıtsız hüküm yasak;
ölçülemeyen iddialar "sınanmayan" olarak ayrıldı. Toplam ~204 araç çağrısı, ~494k
subagent token'ı, repo salt-okunur kullanıldı.

**Şerh:** Windows makinesinde daha taze hafızalar var; bu ölçüm yalnız bu diskin
fotoğrafıdır. Bozan commit'lerin bir kısmı yalnız `origin/main`'de (yerel main 12
commit geride) — "hangi ref'e karşı denetim" bulgusu buradan doğdu (bkz. D7).

---

## 1. Sonuç: GO

| Hüküm | Adet | Oran |
|---|---|---|
| geçerli | 11 | %39 |
| kısmen-çürümüş | 16 | %57 |
| çürümüş | 1 | %4 |
| kararsız | 0 | — |

**28 notun 17'si (%61) en az bir ölü iddia taşıyor** ve bunların tamamı ajana hâlâ
"aktif hafıza" olarak sunuluyor. Tek tam-çürümüş not (`bekleyen-isler`) bir yapılacaklar
listesi — üç maddesi de haftalar önce kapanmış, ajan hâlâ "sıradaki iş" diye okuyor.
Çürüme oranı proje hipotezini doğruluyor: **GO.**

İkinci bulgu çürüme **hızı**: iki notta (`masaustu-guven-modeli`, `test-standardi`)
ilk ölü iddia, notun yazılmasından **~7 saat sonra** atılan commit'le oluştu. Çürüme
gün değil saat mertebesinde başlayabiliyor — "değişimle tetiklen, zamanla değil"
kararının (spec K/CLAUDE.md §2.4) sahadaki kanıtı.

## 2. Not başına hükümler

| Not | Hüküm | Birincil çürüme tipi | Bozan kanıt (özet) |
|---|---|---|---|
| agy-model-secimi | geçerli | — | — |
| csharp-zekasi-zinciri | geçerli | — | — |
| denetim-kapatma-dersi | geçerli | — | — |
| indirme-butunlugu-kutugu | geçerli | — | — ("üç .ps1" doğuştan hatalı: 2 var) |
| kabuk-olcum-tuzaklari | geçerli | — | — |
| lisans-karari | geçerli | — | — (sınanmayan: yok — tam doğrulama) |
| macos-build-mekanigi | geçerli | — | — (xattr'ın konum beyanı doğuştan hatalı) |
| mcp-derleme-kisir-dongu | geçerli | — | — |
| olcum-subagent-kod-ana-dongu | geçerli | — | — (kod çapasız tercih kaydı) |
| unity-mcp-fork-atif | geçerli | — | — (upstream karşılaştırmaları ölçülemedi) |
| worktree-kullanimi | geçerli | — | — (çapasız, kayacak yüzeyi yok) |
| agy-print-mcp-koprusu | kısmen-çürümüş | karar-tersine-döndü | e061846: toolPermission pop→yaz |
| codex-delegate-niyet | kısmen-çürümüş | durum-bayatladı | 9c51f71+a6adb04: "yazılmadı" denen 5 madde SKILL.md'de |
| custom-tools-cs-eksik | kısmen-çürümüş | (doğuştan-yanlış yol) | nottaki yol hiç var olmamış; çekirdek iddia ayakta |
| jarvan-asistan | kısmen-çürümüş | dosya-silindi | ~/Documents/JARVAN yok → Spotify MCP ölü yol |
| kimi-provider-dogrulanmadi | kısmen-çürümüş | ölçüm-geçersizleşti | "82 test" → bugün 824; çekirdek iddia ayakta |
| kritik-acik-tanimi | kısmen-çürümüş | durum-bayatladı | 77d3182 vd.: "(b)/(d) hiç bakılmadı" çökmüş; not içi çelişki |
| masaustu-guven-modeli | kısmen-çürümüş | sembol-kayboldu | 463a18d (~7 saat sonra): adoptLegacyRoot→confirmLegacyRoot, davranış tersine |
| onay-kapisi-kapsami | kısmen-çürümüş | durum-bayatladı | 40b0cbd: home.tsx koşulu kalkmış; satır çıpaları toplu kaymış |
| teslim-yolu-denetimi | kısmen-çürümüş | durum-bayatladı | DURUM bloğunun 4 beyanı da ölü; frontmatter description vs gövde çelişkisi |
| teslim-yolu-denetim-2 | kısmen-çürümüş | durum-bayatladı | 728b63e: "pushlanmadı/arşivlenmedi" ölü; 2 açık-bulgu iddiası hâlâ doğru |
| test-standardi | kısmen-çürümüş | karar-tersine-döndü | c72bf1d+95ab9eb (~7 saat sonra): ☠️ ToastContainer bulgusu tersine dönmüş |
| unity-architect-mimari | kısmen-çürümüş | dosya-silindi + karar-tersine-döndü | ca64a69/5f16e16/c649401/fe993c2: 7 iddia ayakta / 7 çökmüş |
| unity-mcp-toggle-internet-bagimli | kısmen-çürümüş | ölçüm-geçersizleşti | b4065f1: 3/3 satır çıpası kaymış; İÇERİK tamamen ayakta |
| unity-mcp-yerel-auth | kısmen-çürümüş | durum-bayatladı | MatchDayOfficial manifest ölçümü tersine dönmüş; 8/9 iddia ayakta |
| windows-acikleri | kısmen-çürümüş | durum-bayatladı | 95ab9eb+b1204f1: "Windows erişimi yok / kalan iş optimizasyon" çökmüş |
| windows-gecisi-tasima | kısmen-çürümüş | durum-bayatladı | 12 commit: "taşımayı ŞİMDİ yapıyor" 11 gün bayat; envanter sayıları kaymış |
| bekleyen-isler | çürümüş | durum-bayatladı | 19c623f: "SIRADAKİ İŞ" 3 maddesi de kapanmış; not içi çelişki (satır 117 vs 156) |

Çürüme tipi dağılımı (17 çürüyen not, birincil tip): **durum-bayatladı 9**,
karar-tersine-döndü 2, dosya-silindi 2, ölçüm-geçersizleşti 2, sembol-kayboldu 1,
doğuştan-yanlış 1.

## 3. Desenler — tasarımın doğruladıkları ve düzeltmesi gerekenler

**D1 — "DURUM satırı" en güçlü ucuz sinyal.** Çürüyen 17 notun 9'u akış-durumu
beyanı yüzünden çürüdü; kalıcı ders/karar/ölçüm notları (11 geçerli notun tamamına
yakını) neredeyse hiç çürümüyor. CLAUDE.md hipotezi ("kalıcı olguyla akıştaki işi
karıştırma") sahada doğrulandı. → Sinyal motoruna LLM'siz kural: gövdede
`DURUM:`/"şu an"/"henüz"/"sıradaki iş" kalıbı + çapalarda commit hareketi = yüksek şüphe.

**D2 — "Doğuştan-yanlış" çürümeden ayrı bir sınıf.** ~6 iddia yazıldığı gün de
yanlıştı (var olmayan yol, yanlış sayı, yanlış konum beyanı). Bunlara "bozan commit"
aranmaz — arayan sinyal motoru boşa döner. → `findings` şemasına çürümeden bağımsız
`born_invalid` hüküm sınıfı; hakem prompt'una "bu iddia hiç doğru muydu?" ölçüsü.

**D3 — Çelişki sinyali üç yüzeyde gerçek örnek verdi:** (a) notlar arası:
`unity-mcp-yerel-auth` vs `unity-mcp-toggle` aynı manifest hakkında zıt ölçüm;
(b) not içi: `bekleyen-isler` satır 117 vs 156, `kritik-acik-tanimi` üst vs alt blok;
(c) **frontmatter vs gövde:** `teslim-yolu-denetimi` description'ı "düzeltme YAPILMADI"
derken gövde "12'si de KAPATILDI" diyor — indeksten okuyan ajan yalnız yalanı görür.
→ Çelişki tespiti yalnız çapraz-not değil; not-içi ve indeks-gövde tutarlılığı da
denetim yüzeyi.

**D4 — Satır numarası çıpası kırılgan, içerik göstergesi değil.** `unity-mcp-toggle`
notunda 3/3 satır çıpası kaymışken içerik %100 ayaktaydı; `onay-kapisi`nde onlarca
satır referansı kaydı, iddialar yerinde. → Anchor önceliği: sembol > dosya yolu >
satır numarası; satır kayması tek başına şüphe skorunu YÜKSELTMEMELİ.

**D5 — Çapasız not ≠ şüpheli not.** En dayanıklı notların bir kısmı hiç kod çapası
taşımıyor (tercih kayıtları, dersler) — kod hareketiyle çürüyemezler. → "Denetlenemez"
etiketi nötr olmalı; dashboard bunları ayrı gösterir ama şüphe skoru vermez.

**D6 — Repo-dışı çapalar gerçek.** `~/.gemini/settings.json`, `~/Documents/JARVAN`,
başka projenin `manifest.json`'ı — hepsi ölçülebilir çıktı ve ikisi çürüme yakaladı.
→ Anchor tipleri repo içi dosya/sembol/SHA ile sınırlı kalmamalı (v1'de kapsam
dışı tutulabilir ama şema izin vermeli).

**D7 — Denetim ref'i ürün kararı.** Bozan commit'lerin önemli kısmı yalnız
`origin/main`'deydi; yalnız çalışma ağacına bakan bir denetçi bunları göremezdi.
→ Prototipte varsayılan: çalışma ağacı + fetch edilmiş `origin/<default>` birlikte;
uyuşmazlıkta ikisi de rapor edilir.

**D8 — Çürüme hızı saat mertebesinde başlayabiliyor** (iki notta ~7 saat). "Her 2-3
günde tara" yaklaşımı ilk günden yanlıştı; commit-tetikli tarama doğru eksen (spec
zaten böyle — teyit).

## 4. Altın test seti

Yukarıdaki tabloda kısmen-çürümüş/çürümüş 17 not + bozan kanıtları, M3'ten itibaren
boru hattının başarı ölçütüdür:

> **Başarı skaleri:** sinyal katmanı (M3) ve hakem (M4), bu 17 nottan kaçını insan
> eli değmeden yakalıyor + 11 geçerli nottan kaçını yanlış alarmla suçluyor.

Denek repo bu ölçüm sırasındaki ref'leriyle sabitlenmeli (b4065f1 / 19c623f) —
GaMachine ilerledikçe altın set kaymasın diye M3 testlerinde bu SHA'lara pin'lenir.

## 5. Kalibrasyon çıkarımları

- **Şüphe eşiği:** D1 gereği sinyaller eşit ağırlıklı olmamalı. Başlangıç önerisi
  korunur (0.6) ama DURUM-kalıbı + çapa hareketi bileşimi tek başına eşiği aşmalı;
  satır-kayması tek başına asla aşmamalı (D4).
- **Claude çapraz kontrolü:** Bu ölçüm Claude ajanlarıyla yapıldı; Codex-Claude
  uyuşmazlık oranı henüz ölçülmedi. Öneri: prototipte varsayılan **açık** başlasın,
  M4'te altın set üzerinde uyuşmazlık oranı ölçülüp karar verilsin (spec §3.4'teki
  veri kapısı M4'e taşındı).
- **Hakem yükü tahmini:** 28 notluk siloda eşik üstü ~17 aday ≈ %61. İlk tam
  taramada yük yüksek, sonrası artımlı (yalnız yeni commit hareketi). Kabul edilebilir.

## 6. Spec'e geri beslenecek değişiklikler

1. `findings` hüküm kümesine `born_invalid` eklenir (D2).
2. Çelişki tespiti üç yüzey: notlar-arası, not-içi, frontmatter/indeks-gövde (D3).
3. Anchor şemasında öncelik sırası ve satır-numarası-çıpasının skor etkisizliği (D4).
4. "Denetlenemez (çapasız)" durumu nötrdür, şüphe üretmez (D5).
5. Denetim ref'i: çalışma ağacı + `origin/<default>` birlikte (D7).
6. Sinyal motoruna DURUM-kalıbı dedektörü (LLM'siz regex sınıfı) eklenir (D1).
