// `adjudicate-cost.ts`'in SAF (yan etkisiz ya da yalnız fs-okuyan) mantığı.
//
// Neden ayrı dosya: `adjudicate-cost.ts` bir CLI giriş noktası — import edildiği
// anda argv ayrıştırıyor, `process.exit` çağırıyor ve dosya yazıyor. Bu yüzden
// içindeki kararlar (çıktı tamlığı, kök doğrulaması, usage toplamı) hiçbir
// zaman test edilemedi; M4.1 denetiminin 6 bulgusunun 6'sı da o dosyadaydı.
// Buraya YALNIZ o kararlar taşındı; akış (spawn, sinyal, raporlama) CLI'da kaldı.

import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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
  if (!existsSync(join(real, ".git"))) {
    return { ok: false, reason: `kök bir git deposu değil (.git yok): ${raw}` };
  }
  return { ok: true, root: real };
}
