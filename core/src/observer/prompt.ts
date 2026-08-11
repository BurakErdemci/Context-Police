// Gözlemci prompt'u ve çıktı sözleşmesi. Prompt Türkçe (D-M2-7): prototipin
// oturumları Türkçe; ürünleşince bu dosya tek başına İngilizce'ye çevrilir.
//
// Durum = başlık listesi, özet DEĞİL (spec §3.3): gözlemci mevcut bulguları
// bilir ama yeniden yazamaz — özet-üstüne-özet kaybı böyle kesilir.

import type { Anchor, AnchorKind, Finding, Turn } from "../types.ts";

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
 * Çapa değerinde YASAK karakterler. Tek kaynak burası ve küme bir kod noktası
 * listesi DEĞİL, Unicode KATEGORİSİ:
 *
 *   \p{Cc}  kontrol karakterleri: C0 (satır sonları dahil), DEL, C1
 *   \p{Cf}  biçim karakterleri: U+00AD (yumuşak tire), U+061C (ALM), U+180E,
 *           U+200B-F (sıfır genişlik + yön işaretleri), U+202A-E (bidi gömme/
 *           geçersiz kılma), U+2060-4 (birleştiriciler), U+206A-F (eski biçim
 *           denetimi), U+2066-9 (bidi izolat), U+FEFF (BOM/ZWNBSP), U+FFF9-B,
 *           U+E0001 ve U+E0020-7F (tag karakterleri)
 *   \p{Cs}  yalnız kalan vekil (surrogate): model çıktısındaki \uD800 böyle bir
 *           değer üretebiliyor, depoya yazılınca kodlama gidiş-dönüşü bozuluyor
 *   U+2028/29                 satır/paragraf ayırıcı (Zl/Zp — C* değil, ayrıca yazılı)
 *   U+FE00-0F, U+E0100-E01EF  varyasyon seçiciler (kategori Mn ama görünmez;
 *                             yol/sembol/SHA değerinde meşru karşılıkları yok)
 *
 * NEDEN KATEGORİ, NEDEN ELLE LİSTE DEĞİL: ilk düzeltme elle sayılmış aralıklar
 * kullanıyordu ve doğrulama turu dört görünmez `Cf` karakterinin (U+00AD, U+180E,
 * U+2060, U+206A) o listeden kaçtığını ÖLÇTÜ. Elle liste bir sonraki denetimde
 * yine delinir; kategori delinmez.
 *
 * AŞIRI DÜZELTMENİN SINIRI (ölçüldü): normal içerik bu kümede DEĞİL —
 * "src/çekirdek/görüntü.ts", "日本語/パス.ts", "İĞÜŞÖÇığüşöç", "naïve café"
 * hepsi geçiyor. Reddedilen küme yalnız GÖRÜNMEZ olanlar; fazla geniş bir küme
 * meşru çapayı sessizce yutar, o da veri kaybıdır.
 *
 * Gerekçe: aynı sınıf M1'de ÇIKTI sınırında kapatılmıştı (cli.ts safe()); veri
 * sınırında açık kalınca sahte bir çapa (U+202E ile ters çevrilmiş yol) bulguyu
 * unanchored yerine active yapıyor ve M3/M5 o değeri tüketiyor. Görünenle saklanan
 * ayrışıyorsa çapa çapa değildir.
 *
 * REDDEDİLMEYEN: yol gezinmesi ("../"), mutlak yol, var olmayan dosya. Bunlar
 * veri olarak meşru olabilir (repo dışı çapa şemada var, M0-D6) ve doğrulaması
 * M3'ün işi — burada reddetmek gerçek bulguyu sessizce yutardı.
 */
const FORBIDDEN_ANCHOR_CHARS =
  // eslint-disable-next-line no-control-regex -- kontrol karakteri aramak İŞİN KENDİSİ
  /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;

const ANCHOR_KINDS: readonly AnchorKind[] = ["file_path", "symbol", "commit_sha", "external_path"];

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

  const transcript = args.turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");

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

Yalnız şu biçimde JSON döndür:
{"findings":[{"content":"...","anchors":[{"kind":"file_path","value":"..."}],"supersedes":12}]}

OTURUM PARÇASI:
${transcript}`;
}

/**
 * Çıktıyı elle doğrular. --output-schema modele gider ama ona GÜVENİLMEZ:
 * sınır bizim tarafta çizilir (denetim dersi: biçime bakarak güvenli ilan
 * etmek çalışmıyor — sabit sözleşme + üst sınırlar).
 */
export function parseObserverOutput(
  raw: string,
): { ok: true; items: ObserverItem[] } | { ok: false; error: string } {
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
      if (typeof value !== "string" || value.trim().length === 0 || value.length > ANCHOR_VALUE_MAX)
        return { ok: false, error: `madde ${i} çapa ${j}: geçersiz değer` };
      if (FORBIDDEN_ANCHOR_CHARS.test(value))
        return { ok: false, error: `madde ${i} çapa ${j}: çapa değerinde kontrol/görünmez karakter` };
      validAnchors.push({ kind: kind as AnchorKind, value });
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
  return { ok: true, items };
}
