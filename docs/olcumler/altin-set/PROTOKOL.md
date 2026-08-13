# Altın set — iddia düzeyi etiketleme protokolü

**Amaç:** M0'ın not düzeyi ikili etiketini (17 çürük / 11 geçerli) iddia düzeyine
çıkarmak. Sebep ölçülmüş: 17 "çürük" notun **16'sı `kısmen-çürümüş`** — yani
ikili etiket tam da çoğunlukta en kaba yerinde duruyor. M0 tablosunun kendisi
"7 iddia ayakta / 7 çökmüş", "8/9 iddia ayakta" diyor; bilgi elde vardı ve
ikili etikette kayboldu.

**Neden M4'ün ilk işi:** M4'ün hakemi iddia düzeyinde hüküm verecek. Ölçüt not
düzeyinde kalırsa M4'ün doğruluk sayısı M3'ün 6/17'siyle karşılaştırılamaz.

---

## 1. Pinler — değiştirilemez

| | Değer |
|---|---|
| Denek repo | `~/Documents/unityaiPython` (GaMachine) |
| Pin (HEAD) | `b4065f1` |
| origin ref | `19c623f` |
| Hafıza anlık görüntüsü | `~/.context-police/golden/2026-08-11-gamachine/` |
| Denetlenen not | 28 (`MEMORY.md` indeks, hariç) |

Etiketleme **b4065f1 anındaki gerçeğe** göre yapılır. "Bugün doğru mu" değil,
"pin anında doğru muydu" sorusu sorulur — yoksa r1–r5 ölçümleriyle karşılaştırma
zemini kayar.

## 2. İddia birimi: doğrulanabilir cümle

Bir **iddia**, diske ya da git geçmişine karşı **tek başına** doğrulanabilen
ifadedir. Ölçüt: "bunu yanlışlamak için tek bir kanıt yeter mi?" Evet ise iddia.

Bölme kuralları:
- Bir cümle iki ayrı doğrulanabilir ifade taşıyorsa **ikiye bölünür**
  ("X dosyası Y'yi yapıyor **ve** 3 test geçiyor" → iki iddia).
- Retorik, gerekçe, bağlam cümleleri iddia **değildir** — atlanır.
- Frontmatter `description` alanı **bir iddiadır** (gövdeyle çelişebilir; M3'te
  ölçülmüş bir çürüme yüzeyi).
- Başlıklar iddia değildir, ama altındaki maddeler olabilir.

Not başına beklenen: 3–8 iddia. Bu bir **tavan değil**, bir sağlama: 1'de
kalıyorsa muhtemelen az bölünmüştür. Yüksek çıkması normaldir — ölçüldü
(13 Ağu): `onay-kapisi-kapsami` 513 satırda 31 iddia, `unity-architect-mimari`
24 iddia taşıyor. Not gerçekten iddia yoğunsa bölme kısılmaz.

**Sessiz örnekleme yasak.** Bir notun tüm iddiaları etiketlenir. Not çok
uzunsa ve tamamı çıkarılamıyorsa, **kaç iddianın dışarıda kaldığı yazılır** —
aksi halde eksik kapsama tam kapsama gibi okunur. (Ölçüldü, 13 Ağu:
`bekleyen-isler` 686 satırdan "en değerli 24" seçilerek etiketlendi; kalanın
sayısı bilinmiyor, bu kayıt eksik kapsamlı sayılıyor.)

## 3. Hüküm kümesi — dört değer

| Hüküm | Anlamı |
|---|---|
| `gecerli` | Pin anında doğru. |
| `curuk` | Yazıldığında doğruydu, pin anında yanlış. Kanıt **zorunlu**. |
| `dogustan-yanlis` | Yazıldığı anda da yanlıştı. Çürüme **değil**. Kanıt zorunlu. |
| `olculemez` | Diske/git'e karşı doğrulanamaz (tercih beyanı, dış kaynak, canlı servis, ölçüm anına özgü gözlem, tarihsel anlatı). |

**`olculemez` neden var:** M0'ın ikili şeması her şeyi iki kovaya zorluyordu.
Kodun kendi `unverifiable` çapa durumuyla aynı felsefe — ölçüm arızası
suçlamaya dönmez. Ölçüldü (Claude geçişi, 13 Ağu): iddiaların **%27,4**'ü bu
kovaya düşüyor. Bunlar denetçinin **hiçbir zaman** yakalayamayacağı iddialar,
çünkü hakem koddur; yakalama oranının paydasına konurlarsa tavan yapay
olarak düşer.

**`dogustan-yanlis` neden ayrı hüküm** (karar: Burak, 13 Ağu 2026): çürük
sayılırsa "kod değiştiği için bozuldu" ile "hiç doğru değildi" aynı kovaya
düşer ve CLAUDE.md §2.4'ün *değişim-tetikli* tasarımının ölçümü bulanıklaşır.
Altın setten çıkarılması da yanlış olurdu: denetçi bu notu işaretlerse
**haklıdır**, yanlış alarm sayılmamalı. Ölçüldü: 7 iddia; not düzeyine
yuvarlamada dahil 15/28, hariç 12/28 — yani karar skaleri gerçekten kaydırıyor.

Çürük iddialarda `decay_type`, M0'ın sözlüğünden (yeni tip icat etme):
`durum-bayatladi` · `karar-tersine-dondu` · `dosya-silindi` · `sembol-kayboldu`
· `olcum-gecersizlesti`

(`dogustan-yanlis` artık bir `decay_type` değil, hükmün kendisi.)

## 4. Kanıt zorunluluğu

`curuk` ve `gecerli` hükümlerinin ikisi de **koşturulmuş bir komuta** dayanır.
`method` alanına o komut yazılır. Hafızadan, sezgiden, notun kendi iddiasından
hüküm verilmez — bu projenin §2.1'i tam olarak bunu yasaklıyor.

Kabul edilen kanıt biçimleri:
- `git -C <wt> log -S'<sembol>' --oneline` — sembolün doğuşu/ölümü
- `git -C <wt> ls-tree b4065f1 -- <yol>` — dosya pin anında var mıydı
- `git -C <repo> log --oneline b4065f1..19c623f -- <yol>` — pin sonrası hareket
- dosyanın kendisini okumak (worktree içinde)

**Bulunamadı = çürük değildir.** Yol yanlış yazılmış olabilir, sembol taşınmış
olabilir. En az iki farklı arama denenmeden `dosya-silindi` yazılmaz.

## 5. Çıktı biçimi — JSONL, satır başına bir iddia

`docs/olcumler/altin-set/claims-<gecis>.jsonl`

```json
{
  "note": "masaustu-guven-modeli",
  "claim_id": "masaustu-guven-modeli#3",
  "line_start": 24,
  "line_end": 25,
  "text": "adoptLegacyRoot eski kökü sessizce kabul eder",
  "verdict": "curuk",
  "decay_type": "sembol-kayboldu",
  "evidence": "463a18d adoptLegacyRoot→confirmLegacyRoot; davranış onay isteyecek şekilde tersine döndü",
  "method": "git -C <wt> log -S'adoptLegacyRoot' --oneline"
}
```

Alanlar: `note`, `claim_id`, `line_start`, `line_end`, `text`, `verdict`
zorunlu; `decay_type` **yalnız** `curuk` iken; `evidence` + `method`
`olculemez` dışında zorunlu.

**`line_start`/`line_end` neden var:** bugün kodda çapalar konum taşımıyor
(`parse.ts:244` — `Anchor` yalnız `{kind, value}`). İddia düzeyine geçince
"bu çapa hangi iddiaya ait" sorusu cevapsız kalıyor. Satır aralığı bu boşluğu
etiket tarafında şimdiden kapatıyor; kod tarafı sonra bunu kullanacak.

## 6. İki bağımsız geçiş

Aynı 28 not iki kez, **birbirini görmeden** etiketlenir:

- `claims-claude.jsonl` — Claude subagent'ları
- `claims-codex.jsonl` — Codex lane'leri

Uyuşan iddialar doğrudan altın sete girer. Uyuşmayanlar Burak'a hakemliğe
gider. Yan ürün: **Codex–Claude uyuşmazlık oranı** — M0 §5 bunu şart koşmuştu,
hiç ölçülmedi, ve M4'ün çapraz kontrol varsayılanı (açık/kapalı) buna bağlı.

Uyuşma ölçütü iki düzeyde ayrı raporlanır:
1. **Bölme uyuşması** — iki geçiş aynı iddiaları mı çıkardı (satır aralığı örtüşmesi).
2. **Hüküm uyuşması** — örtüşen iddialarda aynı hükmü mü verdi.

Bunlar farklı sayılar ve karıştırılmamalı: bölmede ayrışan iki geçiş hükümde
uyuşuyor görünebilir.

## 7. Ölçüm bütçesi — zorunlu

Denetim koşumunda ölçüldü (12 Ağu): bütçesiz bir "maliyeti ölç" talimatı
25 dakika %100 CPU yakan öksüz bir sürece yol açtı.

- Hiçbir tek komut **60 saniyeyi** geçmesin.
- Arka planda süreç bırakılmaz.
- Worktree'ye **yazılmaz** — yalnız okuma. `checkout`, `reset`, `clean` yasak.

## 8. Temizlik

Pinli worktree iş bitince kaldırılır:

```bash
git -C ~/Documents/unityaiPython worktree remove <wt-yolu>
git -C ~/Documents/unityaiPython worktree prune
```
