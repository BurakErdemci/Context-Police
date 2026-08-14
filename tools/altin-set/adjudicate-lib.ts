// `adjudicate-cost.ts`'in SAF (yan etkisiz ya da yalnız fs-okuyan) mantığı.
//
// Neden ayrı dosya: `adjudicate-cost.ts` bir CLI giriş noktası — import edildiği
// anda argv ayrıştırıyor, `process.exit` çağırıyor ve dosya yazıyor. Bu yüzden
// içindeki kararlar (çıktı tamlığı, kök doğrulaması, usage toplamı) hiçbir
// zaman test edilemedi; M4.1 denetiminin 6 bulgusunun 6'sı da o dosyadaydı.
// Buraya YALNIZ o kararlar taşındı; akış (spawn, sinyal, raporlama) CLI'da kaldı.

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
// ÜRÜNÜN sınır ilkeli — KOPYALANMIYOR, import ediliyor. Gerekçe: bu denetimin
// bulduğu kusurun kendisi "araç ile ürünün sınır tanımı ıraksamış" idi; ıraksamış
// bir kopya aynı kusuru yeniden üretir. Modül saf ve yan etkisiz, `tools/tsconfig.json`
// ile tip denetimine giriyor. (Kill/sinyal kalıbındaki bilinçli kopya AYRI bir karar:
// o davranışsal ve araç/ürün ayrımını korumak için var; bu ise bir İLKEL.)
import {
  DATA_FENCE_CLOSE, DATA_FENCE_OPEN, DATA_FENCE_RULE, fenceUntrusted,
} from "../../core/src/prompt-fence.ts";

export type Usage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number; // gerçek akışta var (14 Ağu json-probe), ücretlendiriliyor
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

export const USAGE_FIELDS = [
  "input_tokens", "cached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens",
] as const;

/**
 * Turların usage'ını TOPLAR (üzerine yazmaz).
 *
 * Eskiden `usage = o.usage` idi: son tur kazanıyordu. Çok turlu bir koşumda bu
 * hem `--max-tokens` tavanını AZ uyguluyor hem manşet maliyet sayısını düşük
 * raporluyordu. Ürün (core/src/adapters/codex.ts) zaten topluyor; ölçüm aracı
 * ürünün göreceği sayıyı ölçmeli.
 */
export function addUsage(acc: Usage | null, next: Record<string, unknown>): Usage {
  const out: Usage = acc ?? {};
  for (const f of USAGE_FIELDS) {
    const v = next[f];
    if (typeof v === "number") out[f] = (out[f] ?? 0) + v;
  }
  return out;
}

export function totalTokens(u: Usage): number {
  return USAGE_FIELDS.reduce((s, f) => s + (u[f] ?? 0), 0);
}

/**
 * İlk `{`'dan başlayıp DENGELİ parantez sayarak ilk kapanan bloğu döndürür.
 *
 * Neden `lastIndexOf("}")` değil: geçerli JSON'un ARKASINDA süslü parantez
 * içeren düz metin varsa ("… {bkz. şema} …") son `}` yanlış yeri kapatıyor ve
 * kurtarma tutmuyordu. Dize içindeki parantezler sayılmaz — kaçış karakteri
 * takip ediliyor.
 */
export function firstBalancedBlock(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * Şemalı iddia kümesini metinden çıkarır; çıkaramazsa null.
 *
 * TAMLIK ÖLÇÜTÜ YAPISAL: metin ayrıştırılabiliyor ve içinde `claims` DİZİSİ
 * varsa çıktı tamdır — dizinin BOŞ olması da tamdır. Eskiden aday metin seçimi
 * ve tamlık kararı `"verdict"` alt dizesine bakıyordu; şemaya uygun
 * `{"claims":[]}` o anahtarı taşımadığı için `parse_failed` damgası yiyordu
 * (M4.1 denetimi, adjudicate-empty-claims-rejected). Metin sezgisi ölçüt
 * olmaktan çıktı: yalnız katı ayrıştırma karar veriyor.
 *
 * Kurtarma katmanı: katı `JSON.parse` tek başına ölçüt olunca TAVANLA HİÇ
 * İLGİSİ OLMAYAN biçim pürüzleri notu "eksik çıktı" sayıyordu (ölçüldü, fix
 * turu 1: (a) cevap ```json çitiyle sarılmıştı, (b) iddia kümesi iki
 * item.completed'a bölünmüştü). Sıra: çiti soy → doğrudan parse → metindeki
 * ilk dengeli {…} bloğunu parse et.
 */
export function parseClaimsCount(text: string): number | null {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const tries = [stripped];
  const block = firstBalancedBlock(stripped);
  if (block !== null && block !== stripped) tries.push(block);
  for (const t of tries) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed?.claims)) return parsed.claims.length;
    } catch { /* sıradaki deneme */ }
  }
  return null;
}

/**
 * Akıştan toplanan aday metinlerden tamlık hükmünü verir.
 *
 * GUARD (değişmedi): kanıt yalnız akışın SON `item.completed`'ından kabul
 * edilir. Ölçülmüş dayanak (14 Ağu json-probe): gerçek `codex exec --json`
 * akışında son item.completed final `agent_message`'ın kendisi; ondan sonra
 * yalnız `turn.completed` geliyor — o bir item DEĞİL. Tek örneklem olduğu için
 * HATA YÖNÜ BİLİNÇLİ SEÇİLDİ: akış ileride mesaj-dışı bir item'la biterse not
 * GÜRÜLTÜLÜ şekilde `olculemez` olur (görülür ve düzeltilir), sessizce sızmaz.
 *
 * Adaylara AKIL YÜRÜTME METNİ GİRMEZ (çağıran süzer): prompt çıktı şemasını
 * tarif ettiği için modelin reasoning'inde biçimi örnekleyen çitli bir blok
 * görülebiliyor; o blok tamlık kanıtı sayılırsa sonradan tavanla kesilen bir
 * koşum "tam" damgası alıp kısmi iddialarını skor hattına sızdırıyor.
 */
export function decideCompleteness(
  candidates: string[],
  lastItemIsMessage: boolean,
): { complete: boolean; claims: number } {
  if (!lastItemIsMessage || candidates.length === 0) return { complete: false, claims: 0 };
  const tries = [candidates[candidates.length - 1]!];
  // Birleşim fallback'i: küme birden çok item'a bölünmüşse tek parça
  // ayrıştırılamaz ama sıralı birleşimi ayrıştırılabilir.
  if (candidates.length > 1) tries.push(candidates.join("\n"));
  for (const t of tries) {
    const n = parseClaimsCount(t);
    if (n !== null) return { complete: true, claims: n };
  }
  return { complete: false, claims: 0 };
}

/**
 * Alt sürecin stderr kuyruğunu sınırlı tutar.
 *
 * Ürün `core/src/adapters/codex.ts` aynı sınırı (`STDERR_TAIL = 500`) hata
 * mesajının kuyruğu için kullanıyor; buradaki BİLİNÇLİ bir kopya (araç/ürün
 * ayrımı korunuyor, bkz. killProcessGroup notu). Kuyruk tutuluyor çünkü
 * hatanın SEBEBİ sonda yazılıyor.
 */
export const STDERR_TAIL = 500;

export function appendTail(acc: string, chunk: string, limit: number = STDERR_TAIL): string {
  const s = acc + chunk;
  return s.length <= limit ? s : s.slice(-limit);
}

/** Operatörün kopyalayıp yapıştırabileceği temizlik komutu (sızan süreç için). */
export function cleanupCommand(pid: number): string {
  return `kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`;
}

export type RootCheck = { ok: true; root: string } | { ok: false; reason: string };

/**
 * İlk pozisyonel argümanı codex'in `-C` değerine geçirmeden önce doğrular.
 *
 * Bulgu (M4.1, adjudicator-arbitrary-root): argüman hiç doğrulanmadan alt
 * sürecin çalışma köküne geçiyordu — yazım hatası sessizce yanlış bir dizinde
 * ölçüm yaptırıyor, dosya yolu ise anlamsız bir hatayla patlıyordu. Ucuz kapı:
 * var mı, dizin mi, beklenen depo mu. `.git` hem normal depoda (dizin) hem
 * bağlı worktree'de (gitdir: satırı içeren DOSYA) var, ikisi de geçer.
 *
 * Yol ayrıca canonicalize ediliyor: alt sürece sembolik bağ değil gerçek yol
 * gider, böylece `-C` değeri ile ölçümün raporladığı yol aynı şey olur.
 *
 * "beklenen depo mu" ölçümü checkGitMarker'da: varlık kontrolü YETMİYOR.
 */
export function validateRoot(raw: string | undefined): RootCheck {
  if (!raw) return { ok: false, reason: "kök argümanı boş" };
  let real: string;
  try {
    real = realpathSync(resolve(raw));
  } catch {
    return { ok: false, reason: `kök yolu yok: ${raw}` };
  }
  try {
    if (!statSync(real).isDirectory()) return { ok: false, reason: `kök bir dizin değil: ${raw}` };
  } catch {
    return { ok: false, reason: `kök okunamadı: ${raw}` };
  }
  return checkGitMarker(real, raw);
}

/**
 * `.git` işaretçisinin GERÇEKTEN bir depoya işaret ettiğini ölçer.
 *
 * Bulgu (doğrulama turu, 14 Ağu): kapı yalnız `existsSync(<root>/.git)` idi —
 * `mkdir .git` ile kurulmuş BOŞ bir dizin depo sayılıyordu, yani kapı "yanlış
 * dizinde ölçüm yapma" işini yapmıyordu.
 *
 * İki biçim de MEŞRU ve ikisi de kabul ediliyor:
 *   - normal depo: `.git` bir DİZİN → içinde HEAD + objects + refs olmalı;
 *   - bağlı worktree / submodule: `.git` bir DOSYA → `gitdir: <yol>` satırı
 *     taşır ve gösterdiği yönetim dizini var olmalı.
 * İkinci biçim kırılırsa bu projenin kendi ölçüm koşumları durur: onlar
 * worktree'de koşuyor (bkz. audit-lanes).
 */
function checkGitMarker(real: string, raw: string): RootCheck {
  const marker = join(real, ".git");
  let st;
  try {
    st = statSync(marker);
  } catch {
    return { ok: false, reason: `kök bir git deposu değil (.git yok): ${raw}` };
  }
  if (st.isDirectory()) {
    const missing = ["HEAD", "objects", "refs"].filter((n) => !existsSync(join(marker, n)));
    if (missing.length > 0) {
      return { ok: false, reason: `kök bir git deposu değil (.git içinde eksik: ${missing.join(", ")}): ${raw}` };
    }
    return { ok: true, root: real };
  }
  if (st.isFile()) {
    let text: string;
    try {
      text = readFileSync(marker, "utf8");
    } catch {
      return { ok: false, reason: `.git dosyası okunamadı: ${raw}` };
    }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return { ok: false, reason: `.git dosyası 'gitdir:' satırı taşımıyor: ${raw}` };
    // Göreli gitdir gerçek bir hâl (taşınabilir worktree): köke göre çözülür.
    const target = isAbsolute(m[1]!) ? m[1]! : resolve(real, m[1]!);
    if (!existsSync(join(target, "HEAD"))) {
      return { ok: false, reason: `.git dosyasının gösterdiği git dizini yok: ${target}` };
    }
    return { ok: true, root: real };
  }
  return { ok: false, reason: `.git ne dizin ne dosya: ${raw}` };
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Not adını yol bileşeni yapmadan ÖNCE doğrular.
 *
 * Bulgu (M4.1 ikinci dalga, unvalidated-output-path-component): `note` hem girdi
 * yolunun (`<notlar>/<note>.md`) hem HAM ÇIKTI adının parçasıydı ve hiç
 * doğrulanmıyordu. Ölçülen iki arıza:
 *   - `../../../escaped` → ham kayıt ilan edilen `incomplete/` ağacının DIŞINA
 *     yazıldı, yani dosyanın kendi "eksik çıktı sözleşmesi" delindi;
 *   - `nested/child` → araç rc=0 ile bitti ama o notun ham kaydı hiç yazılmadı
 *     (ara dizin yok; istisna yutuldu). SESSİZ kanıt kaybı.
 * O yüzden reddetme gürültülü: kapı argv ayrıştırmasında, çıkış kodu 2.
 *
 * Ölçüt tek bir yol BİLEŞENİ olması: ayraç yok, `.`/`..` değil, mutlak değil.
 * `name.with.dot` gibi noktalı adlar geçerli — altın sette kullanılıyorlar.
 */
export function validateNoteName(raw: string | undefined): NameCheck {
  if (!raw) return { ok: false, reason: "not adı boş" };
  if (isAbsolute(raw)) return { ok: false, reason: `not adı mutlak yol olamaz: ${raw}` };
  // Windows ayracı da reddediliyor: bu araç POSIX'te koşuyor, orada `\` ada
  // gömülü meşru bir karakter sanılır ve başka bir platformda ayraç olur.
  if (/[/\\]/.test(raw)) return { ok: false, reason: `not adı yol ayracı içeremez: ${raw}` };
  if (raw === "." || raw === "..") return { ok: false, reason: `not adı yol bileşeni olamaz: ${raw}` };
  // İKİNCİ ARIZA SINIFI (doğrulama turu, 14 Ağu): ad yalnız bir yol bileşeni
  // değil, PROMPT'taki veri çitinin ETİKETİ. Yeni satır + `VERI>>>` taşıyan bir
  // ad çiti GÖVDEDEN ÖNCE kapatıyor, yani gövde talimat alanına düşüyordu.
  // Kontrol karakterleri ayrıca dosya adı olarak da meşru değil.
  if (/[\p{Cc}\p{Cf}]/u.test(raw)) {
    return { ok: false, reason: "not adı kontrol karakteri (yeni satır dahil) içeremez" };
  }
  if (raw.includes(DATA_FENCE_OPEN) || raw.includes(DATA_FENCE_CLOSE)) {
    return { ok: false, reason: `not adı veri çiti dizgesi içeremez: ${raw}` };
  }
  return { ok: true, name: raw };
}

export type OutPathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Çıktı yolunu, ondan TÜRETİLEN yollar kurulmadan ÖNCE doğrular.
 *
 * Bulgu (M4.1 üçüncü dalga, unvalidated-output-path-component): önceki dalga
 * `note` adını kapıya aldı (validateNoteName) ama `outPath` doğrulanmadan
 * kalmıştı — oysa aynı sınıfın öbür yarısı o. `outPath` üç yol üretiyor:
 *   - sonuç JSONL'i (`writeFileSync(outPath, "")`),
 *   - tam hamlar (`<outPath>.<note>.raw.jsonl`),
 *   - eksik hamlar (`<dirname(outPath)>/incomplete/<basename(outPath)>.<note>...`).
 * Doğrulanmadığında ölçülen arıza sınıfı `note`'unkiyle aynı: var olmayan bir
 * dizin verilirse araç ilk yazmada patlar (koşum kaybı), `basename` boş kalan
 * bir yol (`out/`, `.`, `..`) verilirse ham kayıt adları anlamsız kurulur ve
 * `incomplete/` sözleşmesi sessizce bozulur.
 *
 * Ölçütler ucuz ve hepsi YAZMADAN ÖNCE sınanabilir: dizin var mı, dizin mi,
 * YAZILABİLİR mi, ve dosya adı tek anlamlı bir bileşen mi. Dizin canonicalize
 * ediliyor (validateRoot ile aynı gerekçe: raporlanan yol ile yazılan yol aynı
 * şey olsun). Reddetme sessiz DEĞİL — çağıran gerekçeyi basıp çıkış kodu 2 ile
 * ölüyor; sessiz reddetme bu sınıfın ilk arızasının ta kendisiydi.
 */
export function validateOutPath(raw: string | undefined): OutPathCheck {
  if (!raw) return { ok: false, reason: "çıktı yolu boş" };
  // HAM DEĞERE ÖNCE BAKILIYOR. Bulgu (doğrulama turu, 14 Ağu): kural
  // `resolve(raw)` SONRASI basename'e bakıyordu, oysa `resolve` sondaki ayracı
  // KIRPIYOR — yani "sonda yol ayracı varsa reddet" kuralı hiç çalışmadı ve
  // var olmayan `.../eksik-dizin/` kabul edilip oraya normal bir DOSYA yazıldı.
  // Kullanıcının yazdığı şey bir DİZİN adıydı; niyet ham değerde duruyor.
  const rawTail = raw.split(/[/\\]/).pop() ?? "";
  if (rawTail === "") return { ok: false, reason: `çıktı yolu yol ayracıyla bitemez: ${raw}` };
  if (rawTail === "." || rawTail === "..") {
    return { ok: false, reason: `çıktı yolu bir dosya adıyla bitmeli: ${raw}` };
  }
  const abs = resolve(raw);
  const name = basename(abs);
  // `resolve` sonrası da sınanıyor (kök yolu gibi uç hâller): basename dosya adı
  // olmazsa ham kayıt adları sessizce bozulur.
  if (name === "" || name === "." || name === "..") {
    return { ok: false, reason: `çıktı yolu bir dosya adıyla bitmeli: ${raw}` };
  }
  const dir = dirname(abs);
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return { ok: false, reason: `çıktı dizini yok: ${dir}` };
  }
  try {
    if (!statSync(realDir).isDirectory()) {
      return { ok: false, reason: `çıktı dizini bir dizin değil: ${dir}` };
    }
  } catch {
    return { ok: false, reason: `çıktı dizini okunamadı: ${dir}` };
  }
  try {
    accessSync(realDir, constants.W_OK);
  } catch {
    return { ok: false, reason: `çıktı dizini yazılabilir değil: ${dir}` };
  }
  // Hedefin KENDİSİ bir dizinse (`out/sonuclar`) yazma EISDIR ile patlardı.
  try {
    if (statSync(join(realDir, name)).isDirectory()) {
      return { ok: false, reason: `çıktı yolu bir dizin: ${raw}` };
    }
  } catch { /* yok — normal hâl, birazdan yaratılacak */ }
  return { ok: true, path: join(realDir, name) };
}

/**
 * Hakem istemini kurar.
 *
 * SINIR (bulgu: untrusted-prompt-boundary-divergence): not gövdesi ve mekanik
 * kanıt GÜVENİLMEYEN metin — ürün istemleriyle (observer/prompt.ts,
 * signals/classify.ts) AYNI veri çitinden geçiyorlar. Eskiden gövde ham konuyor
 * ve bölüm sonu `--- NOT SONU ---` ile işaretleniyordu: gövdenin İÇİNDE aynı
 * dizge geçtiğinde hakemin gördüğü "not burada bitti" sınırı tek anlamlı
 * değildi. Çit hem sınırı etiketliyor hem metindeki sahte kapanışı
 * etkisizleştiriyor.
 *
 * ÇERÇEVE (CLAUDE.md §2.1): ölçüm görevi, hatırlama görevi değil. Modele "bu not
 * doğru mu" diye sorulmuyor; "diske karşı ÖLÇ" deniyor. Emir kipiyle "kır /
 * saldır" da yok — o dil sağlayıcı reddine yol açıyor (codex-cyberpolicy-reddi,
 * 11 Ağu ölçümü).
 */
export function buildPrompt(note: string, body: string, evidence: string | null): string {
  const ev = evidence
    ? `\n${fenceUntrusted("ÖNCEDEN ÖLÇÜLMÜŞ KANIT (mekanik katman, aynı commit)", evidence)}\n\nBu kanıt zaten ölçüldü; yeniden ölçme. Yalnız kanıtın YETMEDİĞİ yerlerde depoya bak.\n`
    : "";
  return `Bir yazılım deposunun kök dizinindesin. Depo \`b4065f1\` commit'ine sabitlenmiş.

Aşağıda o depoya ait bir hafıza notu var. Görevin bu notu OKUMAK değil, ÖLÇMEK:
notun her doğrulanabilir iddiasının bu commit'te geçerli olup olmadığını
depodan tespit et.

${DATA_FENCE_RULE}

Yöntem: dosyaları oku, \`git log\`/\`git show\`/\`git ls-files\` çalıştır.
Hükmü koddan çıkar, notun kendi anlatısından değil. Not bir şeyin var
olduğunu söylüyorsa bak; olmadığını söylüyorsa yine bak.

Her iddia için hüküm:
- gecerli          : bu commit'te doğru
- curuk            : yazıldığında doğruydu, bu commit'te yanlış
- dogustan-yanlis  : yazıldığı an da yanlıştı (kod hiç öyle olmamış)
- olculemez        : depoya karşı doğrulanamaz (dış servis, ağ, kullanıcı
                     beyanı, tarihsel anlatı). Bu ONURLU bir cevap —
                     ölçemediğin şeye hüküm verme.

SAYIM İDDİALARINI ATLAMA. Not bir sayı veriyorsa ("X.py 1682 satır",
"45 kayıtlı araç var", "3 test geçiyor", "8 sağlayıcı yolu") o sayıyı KOŞTUR
ve karşılaştır: \`wc -l\`, \`git grep -c\`, \`git ls-files | wc -l\`. Ölçülen
kaçtı, notta kaç yazıyor, ikisini de evidence'a yaz. (Ölçüldü: hakemin
kaçırdığı iddiaların hepsi bu sınıftandı.)

Notun HER doğrulanabilir ifadesini kapsa — yalnız dikkat çekenleri değil.

\`evidence\` alanına ölçtüğün somut şeyi yaz: SHA, dosya yolu, sembol adı,
sayı. Özet yargı değil.

\`line_start\`/\`line_end\`, iddianın notun kaçıncı satırlarından geldiği
(1'den başlayarak, aşağıdaki blok içindeki gövdeye göre).

Ölçüm bütçesi: hiçbir komut 60 saniyeyi geçmesin, arka planda süreç bırakma.

${ev}
${fenceUntrusted(`NOT: ${note}.md`, body)}`;
}
