# Context Police — Tasarım Spesifikasyonu

**Tarih:** 2026-08-10
**Durum:** Onaylandı (Burak ile bölüm bölüm gözden geçirildi)
**Kaynak:** `CLAUDE.md` tasarım dokümanı + 2026-08-10 brainstorming oturumu
**Kapsam:** 15 günlük prototip penceresi

---

## 1. Ürün özeti

AI kodlama ajanlarının hafızası için arka plan denetçisi. İki işlev, tek depo:

- **Gözlem** — CLI ajan oturumlarının transcript'lerini izler, kalıcı bulguları
  çıkarıp bilgi tabanına yazar.
- **Denetim** — bu tabanı ve diskteki hafıza dosyalarını koda karşı sürekli
  doğrular, sessizce çürüyen notları işaretler.

Hedef: dağıtılabilir bir masaüstü ürün. Prototip yalnız Claude Code'u ve yalnız
`memory/*.md` dosyalarını kapsar; asıl ürün çoğu CLI'ı ve tüm hafıza türlerini
(CLAUDE.md'ler, aracın kendi bulguları) kapsayacak.

---

## 2. Kilitli kararlar ve gerekçeleri

Her karar gerekçesiyle; gerekçesi çöken karar yeniden tartışılır, sessizce değil.

| # | Karar | Gerekçe |
|---|---|---|
| K1 | Gözlemci **ve** hakem `codex exec` (headless) ile koşar | Tek entegrasyon, tek adapter; Codex modelleri bu işte tercih ediliyor (Burak); mevcut codex-delegate/Divan deneyimiyle uyumlu |
| K2 | **Codex sert bağımlılık** — yoksa uygulama çalışmaz; onboarding tespit eder, kurulum yönlendirmesi gösterir | "Codex'siz kuyruk" modu karmaşıklık ekleyip değer katmıyor; kurulum yönlendirmesi GaMachine onboarding felsefesiyle çözülüyor |
| K3 | Araç TypeScript/Node | JSONL parse, dosya izleme, web UI aynı dilde; Claude Code ekosistemi de Node |
| K4 | Bulgu deposu **merkezi**: `~/.context-police/` (SQLite), proje yoluyla anahtarlı | Ürün başkalarının PC'sinde çalışacak; çapraz-proje sorgu bedava; git gürültüsü yok |
| K5 | Masaüstü kabuk **Tauri**, çekirdek **bağımsız Node sidecar** | Electron istenmiyor; Tauri Electron-dışı en olgun seçenek. Sidecar: webview'da Node API yok — büyük JSONL/alt süreç/SQLite sidecar'da doğal; çekirdek UI'sız test edilir; UI↔çekirdek API'si ilk seam |
| K6 | **Aralıklı tarama** (varsayılan 90 sn), canlı fs-watch değil | Çürüme saatler içinde oluşmuyor, gerçek-zamanlılık değer katmıyor; jsonl diskte durduğu için kaçırma yok; watch edge-case'leri prototipte zaman yer |
| K7 | Canlı oturuma **asla** yazılmaz; hakem temiz bağlam + araç erişimiyle koşar | Notu taşıyan ajan nota inanır — aynı yanılsamaya sorulmaz. Cevap araçlardan geliyorsa canlı oturumun katkısı sıfır; `--resume` geçmişi kirlenmez (CLAUDE.md §2.1) |
| K8 | Silme yok; yalnız `superseded` | Yanlış işaretin maliyeti sıfır, geri alma tek tık; geri alınan karar oranı = ölçülebilir hata oranı (CLAUDE.md §3.2) |
| K9 | **Onaysız hiçbir disk yazımı yok, istisnasız** | Hafıza dosyaları yanlışlıkla bozulursa güven biter; `superseded` işareti bile ancak onaydan sonra dosyaya iner |
| K10 | İki adapter seam'i gün birden tanımlı, birer implementasyon: `TranscriptAdapter` (Claude Code jsonl), `ExecutorAdapter` (Codex headless) | "Seam'i erken tanımla, birini implemente et" — sonradan seam açmak pahalı; şimdi ikinci implementasyon YAGNI |
| K11 | Gün-0: kod yazmadan önce GaMachine hafızasında retrospektif çürüme ölçümü | Ucuz doğrulama önce: düşük çürüme oranı projeyi ucuza öldürür (iyi sonuç); yüksek oran eşikleri/sinyalleri kalibre eder ve altın test seti üretir. **Koşuldu 2026-08-10: %61 çürüme → GO** (`docs/olcumler/2026-08-10-m0-gamachine-retrospektif.md`); bu spec'in D1-D8 atıfları o rapordan |
| K12 | Çekirdek stack: Node 24 + TypeScript tip-soyma + `node:sqlite` + `node:test` — sıfır çalışma-zamanı bağımlılığı | Ölçüldü 2026-08-10: üçü de bu makinede çalışıyor. Native modül (better-sqlite3) derleme/prebuild yükü dağıtımda ağır; gömülü sqlite o yükü sıfırlıyor. `node:sqlite` deneysel uyarı veriyor → depo katmanı ince bir arayüzün arkasında, takas tek dosya |

---

## 3. Mimari

### 3.1 Süreç topolojisi

```
┌─────────────────────────────┐
│  Tauri kabuk (dashboard UI) │  ince katman: listeler, onay kuyruğu, diff
└──────────────┬──────────────┘
               │ localhost HTTP + WebSocket
┌──────────────▼──────────────┐
│  Çekirdek (Node/TS sidecar) │  `context-police serve` ile tek başına da koşar
│  ├─ Transcript tarayıcı     │  ~/.claude/projects/**/*.jsonl, artımlı imleç
│  ├─ Gözlemci döngüsü        │──→ codex exec (araçsız, sınırlı bağlam)
│  ├─ Sinyal motoru           │  LLM'siz: anchor kayması (git) + çelişki adaylığı
│  ├─ Hakem kuyruğu           │──→ codex exec (araçlı, temiz bağlam)
│  │   └─ Çapraz kontrol      │──→ claude -p (opsiyonel ikinci görüş, ayarlanabilir)
│  └─ Bulgu deposu            │  ~/.context-police/store.db (SQLite)
└─────────────────────────────┘
               │ yalnız kullanıcı onayından sonra
┌──────────────▼──────────────┐
│  memory/*.md dosyaları      │  ajan bir sonraki okumada alır; iz bloğu içinde
└─────────────────────────────┘
```

- Çekirdek UI'sız çalışır; Tauri onu sidecar olarak başlatır, localhost'a bağlanır.
  Geliştirmede Tauri açılmadan tarayıcıyla test edilir.
- LLM'siz olan her şey LLM'siz: sinyaller mekanik, pahalı çağrı en son katman.

### 3.2 Veri modeli (SQLite, `~/.context-police/store.db`)

**projects** — yol, transcript kaynağı, hafıza dizini, son tarama imleci.

**findings** — gözlemlenen bulgular ve `memory/*.md` notlarının içe aktarılmış
temsili aynı tabloda (denetim ikisine aynı davranır):

```
finding {
  id, project_id
  source        observed | imported   -- transcript'ten mi, memory dosyasından mı
  content                             -- olgunun markdown gövdesi
  source_ref                          -- imported: dosya yolu; observed: oturum id + turn
  created_at
  status        active | suspect | superseded | born_invalid | unanchored
  superseded_by
  suspicion     0..1 birikimli şüphe skoru
}
```

`born_invalid` (M0-D2): iddia yazıldığı gün de yanlıştı — var olmayan bir yol,
yanlış sayı, yanlış konum beyanı. Çürüme değil doğum kusuru; bozan commit aranmaz,
aramak boşa döner. M0'da 28 notta ~6 örnek çıktı.

`unanchored` (M0-D5): notun kod çapası yok (tercih kaydı, ders). **Nötr durumdur —
şüphe üretmez.** M0'da en dayanıklı notların bir kısmı bu sınıftaydı; "denetlenemez"
ile "şüpheli" karıştırılırsa sağlam notlar boşuna kuyruğa düşer.

**anchors** — bulgu başına N kayıt: `file_path | symbol | commit_sha | external_path`
+ çapanın alındığı andaki commit.

Çapa öncelik sırası (M0-D4): **sembol > dosya yolu > satır numarası.** Satır
numarası çıpası kırılgan ve içerik göstergesi değil — M0'da bir notta 3/3 satır
çıpası kaymışken içerik %100 ayaktaydı. **Satır kayması tek başına şüphe skorunu
yükseltmez;** yalnız hakem kartında "çıpa tazelenmeli" notu olarak görünür.

`external_path` (M0-D6): repo dışı çapalar gerçek ve ölçülebilir çıktı
(`~/.gemini/settings.json`, başka projenin `manifest.json`'ı — M0'da ikisi çürüme
yakaladı). Şema izin verir; sinyal motorunda kapsama alınması v1 sonrası.

**events** — append-only denetim günlüğü: sinyal, hakem koşusu, onay/ret.
Hata oranı metriği (reddedilen / toplam hüküm) doğrudan buradan.

Kurallar:

- `findings.content` asla UPDATE edilmez; düzeltme = yeni kayıt + `superseded_by`.
  Silme şemada dahi yok.
- Import eşlemedir, senkron değil: `memory/*.md` her taramada okunur; dosya
  değiştiyse eski temsil `superseded`, yenisi `imported`. Kaynak dosya her zaman
  gerçek — depo onun gölgesi + denetim üst-verisi.

### 3.3 İçe alma ve gözlemci döngüsü

Tarama döngüsü (90 sn, ayarlanabilir):

1. `~/.claude/projects/*/` listele → proje ve oturum keşfi bedava.
2. Her `.jsonl` için depodaki **bayt imlecinden** itibaren yeni satırları oku;
   dosyanın tamamı asla yeniden okunmaz. Yarım satır → imleç ilerlemez, sonraki tura.
3. LLM'siz süzme: araç çıktı gövdeleri atılır; kullanıcı + asistan metni ve araç
   çağrı başlıkları kalır.

Gözlemci çağrısı — süzülmüş turn'ler ~8k token'ı aşınca ya da oturum kapanınca:

```
girdi  = gözlemci durumu (proje başına ~2-3k token: aktif bulgu BAŞLIK listesi)
       + yeni süzülmüş turn'ler
çıktı  = JSON: [{ content, anchors[], supersedes? }]
```

- `new_state = f(previous_state, latest_turn)` (CLAUDE.md §2.2) — kritik fark:
  durum bulguların özeti değil **başlık listesi**. Gözlemci mevcut bulguları bilir
  (mükerrer üretmesin, `supersedes` diyebilsin) ama yeniden yazamaz: çıktı yalnız
  ekler veya mevcut id'ye superseded işareti koyar (append-only, §2.3).
- **Çapa zorunlu:** çapasız bulgu "denetlenemez" sınıfına düşer, dashboard'da ayrı
  görünür — sessizce denetim dışı kalmaz.
- Geçici çağrı hatasında (ağ, rate limit) aynı turda tekrar denenir.
- Bulgu ölçütü (gözlemci prompt'unun özü): kalıcı olan alınır — karar + gerekçe,
  ölçüm, "denendi olmadı", kısıt. Alınmaz: akış durumu, kod içeriği, git'ten
  türetilebilen her şey.

### 3.4 Denetim: sinyaller, hakem, çapraz kontrol

Sinyal katmanı (LLM'siz, her taramada):

- **Anchor kayması:** çapalar git geçmişine karşı —
  `git log --since=<çapa commit'i> -- <dosya>`. Dosya silindi → güçlü; N+ commit →
  orta; sembol `git grep`'te kayıp → güçlü; satır no kayması → **skora katkı yok**
  (M0-D4).
- **DURUM-kalıbı dedektörü (M0-D1, en güçlü ucuz sinyal):** gövdede akış-durumu
  kalıbı (`DURUM:`, "şu an", "henüz", "sıradaki iş", "commit edilmedi",
  "pushlanmadı") + çapalarda commit hareketi = **tek başına eşiği aşar.**
  Gerekçe ölçülmüş: M0'da çürüyen 17 notun 9'u tam olarak bu sınıftı; kalıcı
  ders/karar notları neredeyse hiç çürümedi.
- **Çelişki adaylığı — üç yüzey (M0-D3), üçünde de saha örneği var:**
  1. *Notlar arası:* çapa/anahtar kelime kesişen bulgu çiftleri.
  2. *Not içi:* aynı notun iki bölümü zıt şey söylüyor.
  3. *Frontmatter/indeks ↔ gövde:* `description` satırı gövdeyle çelişiyor —
     **en sinsisi**, çünkü indeksten okuyan ajan yalnız o satırı görür.
  Ön eleme mekanik; aday çiftler tek ucuz Codex çağrısıyla sınıflanır. Çelişki
  onaylanırsa **iki** taraf da yükselir.
- **Yaş tek başına asla sinyal değil**; yalnız yaş × çapa churn'ü oranı katkı verir.

**Denetim ref'i (M0-D7):** sinyaller çalışma ağacına **ve** fetch edilmiş
`origin/<default>`'a karşı ölçülür. M0'da bozan commit'lerin önemli kısmı yalnız
origin'deydi (yerel main 12 commit gerideydi) — yalnız çalışma ağacına bakan
denetçi onları göremezdi. İki ref uyuşmazsa ikisi de rapor edilir.

Hakem — `suspicion` ≥ eşik (başlangıç 0.6, Gün-0 ölçümü kalibre eder):

- Temiz bağlamda `codex exec`, araç erişimli, proje dizininde.
- Çerçeve daima ölçüm, asla teyit: ✗ "bu not doğru mu?" ✓ "şu iddialar var; şu
  dosyaları ve `git log`'u oku, bugün hangisi geçerli söyle." Yanlılık modelde
  değil soruda (CLAUDE.md §2.1 nüansı).
- Çıktı JSON: `hüküm (geçerli|çürümüş|kararsız) + kanıt (dosya/commit) + önerilen
  düzeltme metni`.

Çapraz kontrol (ikinci görüş, K7 ile uyumlu):

- Codex "çürümüş" derse, onay kuyruğuna düşmeden önce temiz bağlamlı `claude -p`
  (araçlı, aynı ölçüm çerçevesi) koşar. Canlı oturuma hiçbir şey gitmez.
- Uyum → kart "2/2 hemfikir"; uyuşmazlık → "modeller uyuşmadı" (en dikkat
  gerektiren kart).
- Ayarlardan açılır/kapanır; varsayılanı Gün-0 ölçümünün yanlış-pozitif oranı
  belirler (oran düşükse katman israf — CLAUDE.md §3.2 kapısı).

### 3.5 Onay akışı ve disk yazımı

- Hüküm ne olursa olsun otomatik yazım yok; her şey onay kuyruğunda bekler (K9).
- Kart: eski ↔ yeni diff, sinyal gerekçesi, hakem kanıtı (tıklanabilir
  dosya/commit), hemfikirlik rozeti. Aksiyonlar: Onayla / Reddet / Ertele.
- **Onayla** → `memory/*.md`'ye yazılır: not superseded arşiv bölümüne taşınır
  (dosya içinde kalır, ajan okumaz), düzeltilmiş hali eklenir, altına iz bloğu:

```markdown
> [!denetim] 2026-08-14 — Context Police
> Tespit: bu not `src/engine/adapter.ts` dosyasına çapalıydı; dosya a3f21c0'da
> silinip `src/adapters/` altına bölündü (anchor kayması).
> Doğrulama: Codex hakemi + Claude çapraz kontrolü hemfikir (2/2).
> Karar: Burak onayladı, 2026-08-14. Eski metin aşağıda arşivde.
```

  Şeffaflık gerçeğin kendisinde: dosyayı açan herkes (ajan dahil) neyin neden
  değiştiğini dosyada görür.
- **Reddet** → bulgu `active`'e döner, skor sıfırlanır, `events`'e yanlış alarm
  kaydı düşer.
- **Restore** (superseded'ı geri getirme) de bir onay aksiyonudur ve dosyaya yazılır.

### 3.6 Dashboard (Tauri)

Dört görünüm, çekirdeğin HTTP API'sinden; WebSocket ile canlı tazelenir:

1. **Projeler** — keşfedilenler, hafıza sağlık özeti (aktif/şüpheli/çürümüş),
   son tarama.
2. **Onay kuyruğu** — ana ekran (yukarıdaki kartlar).
3. **Bulgu deposu** — durum filtresi, tek tık restore.
4. **Denetim günlüğü** — `events` + hata oranı metriği.

Onboarding: Codex tespiti (yoksa kurulum yönlendirmesi, geçilmez) →
`~/.claude/projects` taraması → izlenecek proje seçimi (varsayılan: hepsi).
Tek tık felsefesi.

### 3.7 Hata yönetimi

- Bilinmeyen transcript satır tipi: satır atlanır, örneğiyle `events`'e loglanır,
  tarama durmaz — format değişikliği sessiz kayıp değil görünür uyarı.
- Codex geçersiz JSON: bir kez yeniden iste; yine bozuksa parti "işlenemedi"
  işaretlenir, dashboard'da görünür. Sessiz atlama yok.
- Git olmayan proje: anchor sinyali kapalı, yalnız çelişki çalışır; kart bunu söyler.

### 3.8 Test stratejisi

- Çekirdek saf fonksiyon ağırlıklı: parser, imleç, sinyal hesapları gerçek
  transcript fixture'larıyla testli.
- LLM çağrıları testte sahte executor'la (K10 seam'inin ilk kârı).
- Uçtan uca zemin: bu proje + GaMachine. Gün-0 ölçümünün elle bulduğu çürümüş
  notlar altın set; **başarı skaleri: altın setteki çürümüş notların kaçını
  boru hattı kendiliğinden yakaladı.**

---

## 4. Prototip kapsamı (15 gün)

**Gün-0 (kod öncesi):** GaMachine `memory/` retrospektif çürüme ölçümü — kaç not
doğru, kaçı çürümüş, hangi commit bozmuş. Çıktıları: eşik kalibrasyonu, çapraz
kontrol varsayılanı, altın test seti. Düşük çürüme oranı projeyi ucuza öldürür.

**Kapsamda:**
1. Transcript tarayıcı (Claude Code jsonl, artımlı imleç)
2. Gözlemci döngüsü (Codex headless, append-only)
3. `memory/*.md` import + eşleme
4. Sinyal motoru (anchor kayması + çelişki adaylığı)
5. Hakem + opsiyonel Claude çapraz kontrolü
6. Tauri dashboard (dört görünüm + onboarding + onay akışı)

**Kapsam dışı (ertelendi):**
- Hook-tabanlı içe alma; Codex/Gemini transcript adapter'ları
- CLAUDE.md / AGENTS.md denetimi (asıl üründe var, prototipte yok). Not:
  gözlemlenen bulgular prototipte de çelişki sinyaline **katılır** (bir hafıza
  notuyla çelişebilirler); yalnız düzeltme-yazma akışının hedefi prototipte
  sadece `memory/*.md` dosyalarıdır.
- Otonom arka plan zamanlama (uygulama açıkken tarama var, servis/daemon yok)
- Kullanım sıklığı takibi; onaysız oto-düzeltme (bu asla gelmeyecek — K9)

---

## 5. Açık kalanlar

- **İsim.** "Context Police" kod adı; ürün adı sonra (iş güven skoru üretmek,
  cezalandırmak değil).
- **Hakem maliyeti / eşik değeri.** Gün-0 ölçümü kalibre edecek; 0.6 başlangıç.
- **Tauri sidecar paketleme** (Node çekirdeği tek binary'ye derleme: bun compile /
  pkg seçimi) — uygulama planında karara bağlanacak; dağıtım prototip sonunda.
