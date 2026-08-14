// Gözlemci prompt'u ve çıktı sözleşmesi. Prompt Türkçe (D-M2-7): prototipin
// oturumları Türkçe; ürünleşince bu dosya tek başına İngilizce'ye çevrilir.
//
// Durum = başlık listesi, özet DEĞİL (spec §3.3): gözlemci mevcut bulguları
// bilir ama yeniden yazamaz — özet-üstüne-özet kaybı böyle kesilir.

import type { Anchor, AnchorKind, Finding, Turn } from "../types.ts";
import { DATA_FENCE_RULE, fenceUntrusted } from "../prompt-fence.ts";
import { anchorValueError, normalizeAnchorValue } from "../anchor-value.ts";

export interface StateTitle {
  id: number;
  title: string;
}

export interface ObserverItem {
  content: string;
  anchors: Anchor[];
  supersedes?: number;
}

const TITLE_MAX = 80;
const CONTENT_MAX = 4000;
const ANCHOR_VALUE_MAX = 512;
const ANCHORS_MAX = 16;
const STATE_BUDGET_CHARS = 10_000; // ~2.5k token (spec §3.3: durum ~2-3k)

/**
 * Tek model yanıtının yazabileceği KALICI bulgu sayısı. Üst sınırsızken bir
 * yanıt 512 kayıt basabiliyordu (denetim: unbounded-model-output-amplification)
 * — append-only depoda bu geri alınması pahalı bir gürültü seli.
 * Ölçüm: ilk gerçek koşumda parti başına 6,3 bulgu çıktı; 24 fazlasıyla geniş.
 */
const ITEMS_MAX = 24;

/**
 * Ham yanıtın karakter üst sınırı. Sınır madde sayısından ÖNCE gerekiyor:
 * JSON.parse'a 50 MB'lık bir dize verilmesi tek başına bir maliyet.
 */
const RAW_MAX = 256_000;

/**
 * Çapa değerinde yasak karakterler. Küme kasten DAR: yalnız metni yeniden
 * yönlendiren ya da terminali kandıran sınıf.
 *
 *   U+0000-001F  C0 kontrol karakterleri (satır sonu U+000A ve U+000D dahil)
 *   U+007F       DEL
 *   U+0080-009F  C1 kontrol karakterleri
 *   U+2028/2029  satır ve paragraf ayırıcı
 *   U+061C, U+200E/200F, U+202A-202E, U+2066-2069
 *                bidi işaret/gömme/geçersiz kılma/izolat: "a.ts<U+202E>gnp.exe"
 *                ekranda "a.tsexe.png" görünür — görünenle saklanan ayrışır
 *   \p{Cs}       yalnız kalan vekil (surrogate). Bu bir GÖRÜNÜRLÜK değil
 *                iyi-biçimlilik meselesi: UTF-8'e kodlanamaz, depoya yazılınca
 *                gidiş-dönüş bozulur. Model çıktısındaki kaçak \uD800 böyle bir
 *                değer üretebiliyor (ölçüldü, M2 1. tur).
 *
 * KABUL EDİLEN — GERİ KALAN HER ŞEY. Emoji, varyasyon seçicisi (U+FE0E/FE0F),
 * ZWJ, tag karakterleri (U+E0020-E007F), CJK varyasyon dizileri, U+034F, Hangul
 * doldurucular, U+00AD, U+200B, U+FEFF, Türkçe, boşluk, her iki yol ayıracı,
 * yol gezinmesi ("../"), mutlak yol, var olmayan dosya.
 *
 * NEDEN BU KADAR DAR — kök tasarım kararı (11 Ağu 2026, üç doğrulama turundan
 * sonra). Önceki iki sürüm "bu geçerli bir dosya adı mı" sorusunu Unicode'u elle
 * sınıflandırarak çözmeye çalıştı ve SALINDI: her düzeltme bir yönü kapatıp
 * diğerini açtı.
 *   1. tur: elle sayılmış aralıklar → dört Cf karakteri kaçtı (U+00AD, U+180E,
 *           U+2060, U+206A).
 *   2. tur: Cc/Cf/Cs kategorisine geçildi → U+034F/U+115F/U+180B/U+3164 yine
 *           kaçtı; AMA aynı turda TERS hata da ölçüldü: "docs/❤️.md"
 *           (U+2764 U+FE0F) gibi GERÇEK dosya adları reddediliyordu.
 *   3. tur: Default_Ignorable + emoji bağlam denetimi eklendi → emoji-tag
 *           dizileri ("docs/🏴...󠁿.md") ve CJK varyant dizileri ("日本語/葛...ts")
 *           reddedilirken piktograf-ZWJ-piktograf geçmeye devam etti.
 * Üç turda da aynı sonuç: elle üretilen "meşru grafem" tanımı deliniyor.
 *
 * ÇARE: çapa bir VERİ parçasıdır, burada doğrulanmaz. Var olmayan ya da anlamsız
 * bir çapa M3'ün sinyal motorunda git'e karşı kendiliğinden düşer. Aşırı
 * reddetmenin bedeli ise ölçüldü ve tek yönlü: tek bir çapa yüzünden partinin
 * TAMAMI reddedilip turn'ler "işlenemedi" diye checkpoint'lendiği için doğrudan
 * veri kaybı (probes/emoji-anchor-rejected.sh).
 *
 * Geriye kalan "görünmez ama zararsız" meselesi (U+200B, U+034F, ZWJ) bir
 * GÖRÜNTÜLEME sorunudur, veri sınırı sorunu değil: dashboard (M5) çapayı
 * gösterirken kaçışlayacak. Yasak küme ise M1'de CLI ÇIKTI sınırında zaten
 * kapatılmıştı (cli.ts safe()); burada veri sınırında da kapalı tutulması o
 * kararın eşidir — genişletilmesi değil.
 */
const FORBIDDEN_ANCHOR_CHARS =
  // Kaçış dizileriyle yazılıyor: bu karakterlerin kaynakta GÖRÜNMEZ durması
  // satırı okunamaz ve düzenlenemez kılardı.
  // eslint-disable-next-line no-control-regex -- kontrol karakteri aramak İŞİN KENDİSİ
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]|\p{Cs}/u;

/** Çapa değerinin karakter denetimi; dönen null "temiz", dize ise gösterilecek sebep. */
function anchorCharError(value: string): string | null {
  return FORBIDDEN_ANCHOR_CHARS.test(value) ? "kontrol/görünmez karakter" : null;
}

const ANCHOR_KINDS: readonly AnchorKind[] = ["file_path", "symbol", "commit_sha", "external_path"];

/** Yalnız hex sha; büyük harfe izin var çünkü `git rev-parse` de veriyor. */
const HEX_SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/**
 * Çapa değerinin TÜRÜNE göre biçim denetimi (denetim: model-commit-anchor-flag).
 * Karakter denetimi (yukarısı) "hangi baytlar" sorusuna bakıyordu; bu ise "bu
 * değer bu türde ne anlama gelebilir" sorusuna. İkisi ayrı: `--since=now`
 * karakter olarak tertemiz ama commit_sha olarak anlamsız ve
 * `git rev-parse --verify --quiet <değer>^{commit}` çağrısında ayraçsız ilk
 * konuma girip bayrak olarak okunuyordu.
 *
 * Asıl koruma çağrı yerinde (`--` ayracı, git.ts); burası ikinci kapı — çapa
 * değeri depoya girmeden önce daraltılırsa, ayracı olmayan yeni bir tüketici
 * eklendiğinde açık yeniden doğmaz.
 *
 * Dosya başındaki "çapa VERİdir, burada doğrulanmaz" kararıyla çelişmiyor:
 * o karar var olmayan/tuhaf bir çapanın M3 sinyal motorunda kendiliğinden
 * düşeceğini söylüyor, ki doğru — ama bayrak şekilli bir değer kendiliğinden
 * DÜŞMÜYOR, argümana dönüşüyor. Reddedilen tek sınıf o.
 */
const GLOB_META_RE = /[*?[\]]/;

function anchorShapeError(kind: AnchorKind, value: string): string | null {
  // Her türde ortak hüküm (anchor-value.ts): boş değer + bayrak şekilli önek.
  // Tür denetiminden ÖNCE çalışır — "  " gibi bir değerin hex olmadığı için
  // "commit_sha hex değil" diye raporlanması teşhisi yanıltırdı.
  const shared = anchorValueError(value);
  if (shared !== null) return shared;
  if (kind === "commit_sha") return HEX_SHA_RE.test(value) ? null : "commit_sha hex (7-40) değil";
  // Sembol PATHSPEC OLARAK TÜKETİLMİYOR: `symbolExists` değeri `git grep -F -e
  // <değer>` ile (sabit dize, ayraçlı), `symbolEverExisted` `-S<değer>` ile
  // geçiriyor. Yol kısıtlarını sembole de dayatmak, kazancı olmayan bir aşırı
  // reddetme olurdu — ve aşırı reddetmenin bedeli bu dosyada ölçülmüş
  // (probes/emoji-anchor-rejected.sh).
  if (kind === "symbol") return null;
  return pathShapeError(value, kind === "file_path");
}

/**
 * Yol çapalarının biçim kapısı (denetim: git-pathspec-injection, BLOCKER).
 *
 * Importer'ın ürettiği çapalar `PATH_RE` karakter sınıfıyla DOLAYLI olarak
 * korunuyordu (`[\w.-]` glob karakteri üretemez); gözlemcinin ÜRETTİĞİ çapalar
 * ise yalnız "boş değil + ≤512 karakter" denetiminden geçiyordu, yani `*`, `?`,
 * `[`, `]` ve pathspec sihri serbestti. Ölçüldü: `core/src/signals/g?t.ts`
 * çapası `ls-tree`de bulunamayıp `log`da eşleşerek `missing_now` üretiyor, DURUM
 * kalıbıyla birleşince 0,7 suspect — var olmayan bir yol gerçek bir notu
 * şüpheliye çeviriyor.
 *
 * İKİ KATMANIN İKİNCİSİ. Asıl koruma çağrı yerinde: git.ts'teki üç literal
 * yardımcı `--literal-pathspecs` ile koşuyor. Bu kapı ise değeri DEPOYA girmeden
 * daraltıyor, çünkü koruma yalnız çağrı yerinde olursa bayraksız yeni bir
 * tüketici eklendiği an açık geri geliyor (dosyanın kendi tarihinde ölçülmüş
 * bir sınıf).
 *
 * Dosya başındaki "çapa VERİdir, burada doğrulanmaz" kararıyla çelişmiyor:
 * o karar var olmayan/tuhaf bir çapanın git'e karşı kendiliğinden düşeceğini
 * söylüyor — doğru, ama glob şekilli bir değer kendiliğinden DÜŞMÜYOR, YANLIŞ
 * bir şeyle eşleşiyor. Reddedilen sınıf o.
 *
 * Reddedilen çapa sessizce kaybolmuyor: `droppedAnchors` sayısına giriyor ve
 * observer.ts onu `observer_batch_ok` olayının `detail.droppedAnchors` alanına
 * yazıyor.
 */
function pathShapeError(value: string, repoRelative: boolean): string | null {
  // `:` öneki pathspec sihri (`:(glob)`, `:!`, `:/`). Değerin İÇİNDEKİ iki nokta
  // meşru (Windows sürücüsü, `a:b` adlı dosya) — sihir yalnız BAŞTA çalışır.
  if (value.startsWith(":")) return "':' öneki (pathspec sihri)";
  if (GLOB_META_RE.test(value)) return "glob metakarakteri (* ? [ ])";
  // Üst dizine çıkan çapa repo kökünün dışını ölçtürür. Her iki ayraç: model
  // Windows biçiminde de yazabiliyor.
  if (value.split(/[\\/]/).includes("..")) return "'..' ile repo dışına çıkıyor";
  // file_path repo köküne GÖRELİ olmak zorunda (anchor-drift.ts hiçbir yol
  // birleştirmesi yapmadan git'e olduğu gibi veriyor). Mutlak/ev yolu için
  // ayrı bir tür var: external_path — ve o D-M3-7 gereği zaten `unverifiable`.
  if (repoRelative && (value.startsWith("/") || value.startsWith("~")))
    return "mutlak yol (file_path repo köküne göreli olmalı; external_path kullanılmalı)";
  return null;
}

// Veri-çiti tanımı ortak modülde (../prompt-fence.ts): sinyal katmanı da aynı
// sınırı kullanıyor ve oraya buradan bağımlı olmamalı. Buradan yeniden dışa
// açılıyor — bu dosyanın adresini kullanan çağıranlar kırılmasın diye.
export {
  DATA_FENCE_OPEN, DATA_FENCE_CLOSE, DATA_FENCE_RULE, neutralizeFence, fenceUntrusted,
} from "../prompt-fence.ts";

export function titleOf(content: string): string {
  const first = content.split("\n", 1)[0]!.trim();
  return first.length > TITLE_MAX ? first.slice(0, TITLE_MAX) + "…" : first;
}

/**
 * Aktif bulguların başlık listesi, karakter bütçesiyle. Bütçe aşılırsa EN YENİ
 * bulgular kalır (gözlemcinin mükerrer üretme riski en çok yakın geçmişte) ve
 * atlanan sayısı prompt'ta açıkça söylenir — sessiz eksik liste, gözlemciye
 * "bu bulgu yok" dedirtir.
 */
export function buildStateTitles(
  findings: Finding[],
  budgetChars = STATE_BUDGET_CHARS,
): { titles: StateTitle[]; omitted: number } {
  const newestFirst = [...findings].sort((a, b) => b.id - a.id);
  const titles: StateTitle[] = [];
  let used = 0;
  for (const f of newestFirst) {
    const title = titleOf(f.content);
    const cost = title.length + 8; // "#id: " + satır sonu payı
    if (used + cost > budgetChars) break;
    titles.push({ id: f.id, title });
    used += cost;
  }
  titles.reverse(); // prompt'ta eski→yeni okunur
  return { titles, omitted: findings.length - titles.length };
}

export const OBSERVER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          anchors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...ANCHOR_KINDS] },
                value: { type: "string" },
              },
              required: ["kind", "value"],
              additionalProperties: false,
            },
          },
          // ["number","null"] + required: OpenAI strict structured-output modu
          // `required`ın properties'teki HER anahtarı içermesini şart koşuyor.
          // İlk gerçek koşumda ölçüldü (11 Ağu 2026): `supersedes` required
          // listesinde olmayınca API 6/6 partiyi `invalid_json_schema` (400) ile
          // reddetti — gözlemci tek bulgu üretemedi. Opsiyonelliği taşıyan şey
          // artık `null`; parseObserverOutput null'ı zaten "geçersiz kılınan yok"
          // sayıyor.
          supersedes: { type: ["number", "null"] },
        },
        required: ["content", "anchors", "supersedes"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

export function buildObserverPrompt(args: {
  projectPath: string;
  titles: StateTitle[];
  omitted: number;
  turns: Turn[];
}): string {
  const state =
    args.titles.length === 0
      ? "(henüz bulgu yok)"
      : args.titles.map((t) => `#${t.id}: ${t.title}`).join("\n") +
        (args.omitted > 0 ? `\n(… ve listede gösterilmeyen ${args.omitted} bulgu daha var)` : "");

  // Transcript güvenilmeyen metin: kullanıcı da model de oraya "şu bulguyu
  // geçersiz kıl" yazabilir. Tek blok halinde çitleniyor; rol etiketleri blok
  // İÇİNDE kalıyor çünkü onlar da transcript'in verisi.
  const transcript = fenceUntrusted(
    "oturum parçası",
    args.turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n"),
  );

  return `Sen bir hafıza gözlemcisisin. Aşağıda bir AI kodlama oturumunun parçası var.
Görevin: bu parçadan KALICI bulguları çıkarmak.

KALICI olan (al):
- verilmiş kararlar + gerekçeleri
- ölçüm sonuçları (sayılar, süreler, oranlar, "X denendi Y çıktı")
- "denendi, olmadı" kayıtları
- kısıtlar, sözleşmeler, kalıcı tercihler

ALMA:
- anlık akış durumu (şu an ne yapılıyor, sıradaki adım, todo)
- kod içeriği (kod repoda yaşıyor)
- git geçmişinden türetilebilen her şey (commit listesi, dosya listesi)
- araç çıktısı özetleri

MEVCUT BULGULAR (proje: ${args.projectPath}):
${state}

Kurallar:
- Mevcut bir bulguyla aynı olguyu TEKRAR yazma.
- Bu parça mevcut bir bulguyu geçersiz kılıyorsa yeni bulgunun "supersedes"
  alanına o bulgunun id numarasını yaz.
- Her bulguya mümkünse çapa ekle: dosya yolu (file_path), sembol adı (symbol),
  commit SHA (commit_sha) ya da repo dışı yol (external_path). Çapasız bulgu
  denetlenemez sınıfına düşer; çapa uyduramıyorsan boş bırak, uydurma.
- Bulgu içeriği: oturumun dilinde, 1-4 cümle, tek başına anlaşılır.
- Yeni bulgu yoksa boş liste döndür.

${DATA_FENCE_RULE}

Yalnız şu biçimde JSON döndür:
{"findings":[{"content":"...","anchors":[{"kind":"file_path","value":"..."}],"supersedes":12}]}

OTURUM PARÇASI (ölçülecek malzeme):
${transcript}`;
}

/**
 * Çıktıyı elle doğrular. --output-schema modele gider ama ona GÜVENİLMEZ:
 * sınır bizim tarafta çizilir (denetim dersi: biçime bakarak güvenli ilan
 * etmek çalışmıyor — sabit sözleşme + üst sınırlar).
 */
export function parseObserverOutput(
  raw: string,
): { ok: true; items: ObserverItem[]; droppedAnchors: number } | { ok: false; error: string } {
  // Sınır ayrıştırmadan ÖNCE: dev bir dizeyi JSON.parse'a vermek tek başına
  // bir maliyet. Aşan yanıt mevcut hata yolundan geçer (spec §3.7: bir düzeltme
  // turu + "işlenemedi" işareti), sessizce kırpılmaz.
  if (raw.length > RAW_MAX) return { ok: false, error: `ham çıktı ${raw.length} > ${RAW_MAX} karakter` };
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) text = fence[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Sarmalayıcı kurtarması: model JSON'u düzyazıya ("İşte bulgular: …") ya da
    // kapanmamış bir çite sarabiliyor. İlk '{' ile son '}' arasını bir kez daha
    // dener. Bu bir gevşetme DEĞİL: kurtarılan metin aynı JSON.parse'tan ve aynı
    // şema doğrulamasından geçer — yalnız sarmalayıcı soyulur, çöp kabul edilmez.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const inner = start !== -1 && end > start ? text.slice(start, end + 1) : null;
    let recovered = false;
    if (inner !== null && inner !== text) {
      try {
        parsed = JSON.parse(inner);
        recovered = true;
      } catch {
        // Kurtarma da tutmadı; aşağıda ORİJİNAL hata döner — teşhis, modelin
        // gerçekte ne yazdığına işaret etmeli, kurtarma denemesine değil.
      }
    }
    if (!recovered)
      return { ok: false, error: `JSON ayrıştırılamadı: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, error: "üst düzey nesne değil" };
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return { ok: false, error: "findings dizi değil" };
  if (findings.length > ITEMS_MAX)
    return { ok: false, error: `${findings.length} madde > ${ITEMS_MAX} (tek yanıt bu kadar kalıcı kayıt yazamaz)` };

  const items: ObserverItem[] = [];
  /**
   * Biçim denetiminden düşen çapa sayısı. Neden partiyi REDDETMİYOR (karakter
   * denetiminin aksine): tür uyuşmazlığı iyi niyetli ve SIK bir model hatası —
   * commit_sha alanına "HEAD", "main", "v1.2.3" yazmak. Tek bir çapa yüzünden
   * partinin tamamını reddetmenin bedeli ölçüldü ve tek yönlü: turn'ler
   * "işlenemedi" diye checkpoint'lenir, bulgular kalıcı kaybolur
   * (probes/emoji-anchor-rejected.sh, M2). Çapayı düşürmenin bedeli ise en kötü
   * ihtimalle bulgunun `unanchored` sınıfına düşmesi — M0-D5 gereği nötr.
   *
   * Sessiz de yutulmuyor: sayı dönüş değerinde, ve observer.ts onu
   * `observer_batch_ok` olayının `detail.droppedAnchors` alanına yazıyor.
   */
  let droppedAnchors = 0;
  for (const [i, f] of findings.entries()) {
    if (typeof f !== "object" || f === null) return { ok: false, error: `madde ${i}: nesne değil` };
    const { content, anchors, supersedes } = f as Record<string, unknown>;

    if (typeof content !== "string" || content.trim().length === 0)
      return { ok: false, error: `madde ${i}: content boş ya da dize değil` };
    if (content.length > CONTENT_MAX)
      return { ok: false, error: `madde ${i}: content ${content.length} > ${CONTENT_MAX} karakter` };

    if (!Array.isArray(anchors)) return { ok: false, error: `madde ${i}: anchors dizi değil` };
    if (anchors.length > ANCHORS_MAX) return { ok: false, error: `madde ${i}: ${anchors.length} çapa > ${ANCHORS_MAX}` };
    const validAnchors: Anchor[] = [];
    for (const [j, a] of anchors.entries()) {
      if (typeof a !== "object" || a === null) return { ok: false, error: `madde ${i} çapa ${j}: nesne değil` };
      const { kind, value } = a as Record<string, unknown>;
      if (typeof kind !== "string" || !ANCHOR_KINDS.includes(kind as AnchorKind))
        return { ok: false, error: `madde ${i} çapa ${j}: geçersiz tür ${JSON.stringify(kind)}` };
      // Tür ve tavan ihlali PARTİYİ reddeder: ikisi de şema ihlali, yani
      // çıktının bütününe güvenilemeyeceğinin işareti. BOŞ değer ise artık
      // burada DEĞİL — aşağıda tek çapa olarak düşüyor (gerekçe orada).
      if (typeof value !== "string" || value.length > ANCHOR_VALUE_MAX)
        return { ok: false, error: `madde ${i} çapa ${j}: geçersiz değer` };
      // Karakter denetimi HAM değerde, normalize ÖNCESİ. Sıra bilinçli:
      // `trim()` yalnız boşluğu değil satır sonlarını (U+000A/000D) ve
      // U+2028/2029/FEFF'i de kırpar — normalize sonrası denetlemek, bugün
      // partiyi reddeden kontrol karakterlerini sessizce meşrulaştırırdı.
      // İstenen hizalama bu değil: gevşetme yok.
      const charError = anchorCharError(value);
      if (charError !== null)
        return { ok: false, error: `madde ${i} çapa ${j}: çapa değerinde ${charError}` };
      // Normalize ÖNCE, hüküm SONRA (anchor-value.ts sözleşmesi). Depoya giren
      // değer normalize edilmiş olan — importer'ın ürettiği değerle aynı olması
      // ancak böyle sağlanıyor (" src/a.ts" ≠ "src/a.ts" iki ayrı çapaydı).
      const normalized = normalizeAnchorValue(value);
      // Boş/yalnız-boşluk değer artık partiyi DEĞİL yalnız çapayı düşürür.
      // Bilinçli seçim, iki yönlü ölçüme dayanıyor: parti reddinin bedeli
      // ölçülmüş ve TEK YÖNLÜ — turn'ler "işlenemedi" diye checkpoint'lenir ve
      // o partideki bulgular KALICI kaybolur (probes/emoji-anchor-rejected.sh,
      // M2). Çapa düşürmenin bedeli en kötü ihtimalle notun `unanchored`
      // sınıfına düşmesi (M0-D5: nötr). Hizalama açısından da doğru olan bu:
      // importer boş değer üretemediği için "çapa yok" veriyor; parti reddi iki
      // yüzeyi farklı KAPSAMDA cezalandırıyordu (tek çapa ↔ tüm parti).
      if (anchorShapeError(kind as AnchorKind, normalized) !== null) {
        droppedAnchors++;
        continue;
      }
      validAnchors.push({ kind: kind as AnchorKind, value: normalized });
    }

    // null, "geçersiz kılınan yok"un en doğal model ifadesi — şema alanı
    // opsiyonel diye modeller onu boş bırakmak yerine null yazıyor. Bu yüzden
    // undefined ile aynı sayılır: tek bir null yüzünden partinin tamamını
    // reddetmek (ve D-M2-3 ile turn'leri kalıcı atlamak) orantısız bir bedel.
    let sup: number | undefined;
    if (supersedes !== undefined && supersedes !== null) {
      if (typeof supersedes !== "number" || !Number.isInteger(supersedes) || supersedes <= 0)
        return { ok: false, error: `madde ${i}: supersedes pozitif tam sayı değil` };
      sup = supersedes;
    }

    // Bilinmeyen madde anahtarları bilinçli yutulur: modeller süs alan ekler,
    // sözleşmeyi bilinen anahtarlar taşır.
    items.push(sup === undefined ? { content, anchors: validAnchors } : { content, anchors: validAnchors, supersedes: sup });
  }
  return { ok: true, items, droppedAnchors };
}
