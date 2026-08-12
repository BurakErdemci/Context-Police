// Çapa doğrulama + kayma skoru. M2'nin %10 uydurma çapa borcu burada kapanır:
// "geçmişte hiç izi yok" (never_existed / unverifiable) ile "var olup kaybolmuş"
// (missing_now / symbol_lost) yapısal olarak ayrışır — suçlama yalnız kanıtlıya.

import type { Anchor } from "../types.ts";
import {
  type GitContext, type Measured, fileExistsAt, fileEverExisted, commitsTouching,
  symbolExists, symbolEverExisted, commitExists, filesMatchingSuffix,
} from "./git.ts";

export const SUSPICION_THRESHOLD = 0.6; // M0 kalibrasyonu (rapor §5)

export type AnchorState = "ok" | "missing_now" | "never_existed" | "symbol_lost" | "churned" | "unverifiable";

/** Hangi çapa, hangi komut, hangi sebeple ölçülemedi. audit.ts bunu
 *  `anchor_measurement_failed` olayına yazar — arıza sessiz kalmaz. */
export interface MeasurementFailure { command: string; reason: string }

export interface AnchorVerdict {
  anchor: Anchor;
  state: AnchorState;
  /** Not tarihinden beri çapa dosyasına dokunan commit sayısı. Ölçülemediyse tanımsız
   *  — 0 YAZILMAZ, çünkü "churn yok" ile "churn bilinmiyor" ayrı şeyler. */
  commits?: number;
  /** Çalışma ağacı ile origin farklı hüküm verdi (M0-D7) — ikisi de raporlanır. */
  refDisagreement?: { head: AnchorState; origin: AnchorState };
  /**
   * Git ölçümü ARIZALANDI (repo bozuk, promisor erişilemez, binary yok, zaman
   * aşımı, maxBuffer). Hüküm değil bilgisizlik: state `unverifiable` olur ve
   * skora katkı vermez (M0-D5 nötrlüğüyle aynı mantık — denetlenemez ≠ şüpheli).
   * Tek istisna `commitsTouching` arızası: dosya varlığı ÖLÇÜLDÜĞÜ için state
   * korunur, yalnız churn bilinmez — o hâlde de bu alan dolar ki kaçırılan
   * çürüme de görünür olsun.
   */
  measurementFailed?: MeasurementFailure;
  /**
   * Nottaki kısa yol repoda TEK bir gerçek yola çözüldü ve hüküm o yolla
   * yeniden ölçüldü (altın set §5.2). Hükümde durur ki denetim çıktısı "not
   * `./build_backend.sh` diyor, ölçüm `Backend/build_backend.sh` üzerinden
   * yapıldı" diyebilsin — aksi hâlde çözümleme sessiz bir varsayım olurdu.
   */
  resolvedPath?: string;
  /**
   * Koşumun git alt süreç bütçesi dolduğu için bu çapa HİÇ ölçülmedi.
   * `measurementFailed`ten AYRI tutuluyor: orada bir komut koşup arızalandı
   * (kullanıcının düzeltebileceği bir bozukluk), burada komut hiç koşmadı
   * (aracın kendi maliyet sınırı). İkisini aynı sayaçta toplamak, maliyet
   * sınırını bir arıza gibi gösterirdi — aynı ayrımın gerekçesi `observer_budget_halt`
   * olayında da yazılı. Skor açısından ikisi de nötr: state `unverifiable`.
   */
  budgetExhausted?: true;
}

/**
 * Koşum çapında git alt süreç bütçesi.
 *
 * Neden var (denetim 2026-08-12, `git-process-fanout`, İKİ denetimde tekrar eden
 * sınıf): çapa başına en kötü hâl 9 git süreci (sonek çözümlemesi, çözülen yolu
 * iki ref'e karşı BAŞTAN ölçüyor), not başına 16 çapa sınırı var ama koşum
 * çapında hiçbir tavan yoktu. Uçtan uca ölçüldü: tek notlu bir denetim 147 git
 * süreci doğurdu, hepsi sıralı. Tek sınır süreç başına 15 sn zaman aşımıydı,
 * yani 500 notluk bir depoda üst sınır saatlerle ifade ediliyordu.
 *
 * Sayı ÖLÇÜMDEN türedi (2026-08-12, gerçek 28 notluk altın-set silosu
 * `~/.context-police/golden/2026-08-11-gamachine`, 260 çapa, iki ref'li koşum):
 * **548 git süreci / 8,4 sn** → çapa başına **2,11**. Bütçe çapa başına 3
 * veriyor (~%42 pay) artı sabit bir taban; yani gerçek bir koşum bütçeyi
 * görmüyor bile. Tavan en kötü hâlden (9) türetilmedi bilerek: amaç patolojik
 * bir notun koşumun tamamını yutmasını engellemek, ve 9'dan türetilen bir tavan
 * tam da o durumu serbest bırakırdı.
 *
 * Taban 20: `openGit`in üç çağrısı bütçeye girmiyor (bütçe ondan sonra kuruluyor)
 * ve çok küçük depolarda yuvarlama payı gerekiyor.
 */
export const GIT_BUDGET_BASE = 20;
export const GIT_BUDGET_PER_ANCHOR = 3;

/** Sayaç + tavan. `used` yalnız GERÇEKTEN koşulan git çağrısıyla artar. */
export interface GitBudget { limit: number; used: number }

export const createGitBudget = (anchorCount: number, perAnchor = GIT_BUDGET_PER_ANCHOR): GitBudget =>
  ({ limit: GIT_BUDGET_BASE + anchorCount * perAnchor, used: 0 });

export interface DriftScore { score: number; reasons: string[] }

// D-M3-4 ağırlıkları. Değişiklik ancak altın set ölçümüyle — sayılar M0'dan.
const WEIGHT: Partial<Record<AnchorState, number>> = {
  missing_now: 0.5,
  symbol_lost: 0.4,
  never_existed: 0.3,
};
/**
 * `never_existed` katkılarının TOPLAM tavanı. Ölçüm (altın set r2 §8.2): kalan tek
 * yanlış alarm (`indirme-butunlugu-kutugu`) tam 0,3+0,3 = 0,60 ile eşiğe oturuyordu,
 * başka hiçbir sinyal olmadan. İlke: tek bir sinyal sınıfı tek başına mahkûm
 * edemez — eşiği ancak iki bağımsız sınıfın bileşimi delmeli. Per-anchor ağırlık
 * 0,3 kalır (tekil hüküm ve sayımlar değişmesin diye); kırpılan yalnız toplam.
 */
export const NEVER_EXISTED_CAP = 0.5;

/**
 * `born_invalid` (M0-D2) zayıf sinyali: notun yolları YAZILDIĞI hâliyle tutmuyor,
 * ancak sonek çözümlemesiyle bulunuyor. Ölçüm (r2 §6.1): `custom-tools-cs-eksik`
 * 1,00 → 0,30 düştü çünkü 5 `never_existed`'in 4'ü sonekle `ok`'a çözüldü — oysa
 * M0'ın bu nota verdiği çürüme tipi tam olarak "doğuştan-yanlış yol". Dosyanın
 * bir yerlerde bulunması notu doğru yapmaz; okuyanı yanlış yola gönderir.
 *
 * Eşik neden 2: 2. turda sonek çözümlemesi YAYGINDI (11 çapa kurtarıldı) ve çoğu
 * geçerli nottaydı — elle yazılmış notta tek kısaltma meşru bir üslup, iki ve
 * üzeri ise notun yol yazımının sistemli olarak güvenilmez olduğunun işareti.
 * Ağırlık 0,2: tek başına eşik altı (zayıf sinyal), bileşimde belirleyici.
 */
export const BORN_INVALID_MIN_RESOLVED = 2;
export const BORN_INVALID_WEIGHT = 0.2;

const SEVERITY: Record<AnchorState, number> = {
  missing_now: 3, symbol_lost: 3, never_existed: 2, churned: 1, ok: 0, unverifiable: 0,
};

/** Ölçüm arızasını AnchorVerdict alanına çevirir. */
const failureOf = (m: Measured<unknown>): MeasurementFailure | undefined =>
  m.ok ? undefined : { command: m.command, reason: m.reason };

interface FileState { state: AnchorState; commits?: number; failure?: MeasurementFailure }

/**
 * Bütçeden bir git çağrısı düşer ve çağrıyı koşar. Kapı ÇAPA sınırındadır
 * (checkAnchors), burada değil: başlanmış bir çapayı yarıda kesmek "iki ref'ten
 * yalnız biri ölçüldü" gibi yarım bir hüküm üretirdi — yani bütçe, tam da
 * engellemeye çalıştığı şeyi (ölçüme dayanmayan karar) üretirdi. Bedeli, çapa
 * başına en kötü 9 çağrılık aşım; tavanın payı bunu kapsıyor.
 */
function spend<T>(budget: GitBudget | null, run: () => Promise<Measured<T>>): Promise<Measured<T>> {
  if (budget !== null) budget.used++;
  return run();
}

// Çapa yolları ZATEN repo köküne göreli. Burada hiçbir yol birleştirmesi
// yapılmaz, `path` git'e olduğu gibi geçer: `ctx.repoRoot` çağıranın verdiği
// dizinle aynı olmayabilir (macOS /var → /private/var) ve kendi birleştirmemiz
// o farkı sessizce yanlış yola çevirirdi.
async function fileStateAt(
  ctx: GitContext, ref: string, path: string, sinceIso: string, budget: GitBudget | null,
): Promise<FileState> {
  const exists = await spend(budget, () => fileExistsAt(ctx, ref, path));
  // Varlık ölçülemedi → hiçbir şey bilmiyoruz. Eskiden burası `missing_now`'a
  // düşüyordu (ağırlık 0.5) ve DURUM kalıplı notu tek başına suçlu yapıyordu.
  if (!exists.ok) return { state: "unverifiable", failure: failureOf(exists) };

  if (exists.value) {
    const churn = await spend(budget, () => commitsTouching(ctx, ref, path, sinceIso));
    // Ters yön: dosya DURUYOR, yalnız churn ölçülemedi. 0 saymak kaçırılan
    // çürüme demek — skoru şişirmiyoruz ama arızayı görünür bırakıyoruz.
    if (!churn.ok) return { state: "ok", failure: failureOf(churn) };
    return { state: churn.value >= 3 ? "churned" : "ok", commits: churn.value };
  }

  const ever = await spend(budget, () => fileEverExisted(ctx, path));
  // "Hiç var olmuş mu" ölçülemedi: missing_now (0.5) ile never_existed (0.3)
  // arasında seçim yapamayız, ikisi de suçlama. Bilgisizliği suçlamaya çevirmek
  // yerine nötr kalınır.
  if (!ever.ok) return { state: "unverifiable", failure: failureOf(ever) };
  return { state: ever.value ? "missing_now" : "never_existed", commits: 0 };
}

export async function checkAnchors(
  ctx: GitContext, anchors: Anchor[], sinceIso: string, budget: GitBudget | null = null,
): Promise<AnchorVerdict[]> {
  const out: AnchorVerdict[] = [];
  for (const anchor of anchors) {
    if (anchor.kind === "external_path") { out.push({ anchor, state: "unverifiable" }); continue; } // D-M3-7
    // Bütçe kapısı: dolduysa ölçüm YAPILMAZ. Ölçmemek asla suçlamaya dönmez
    // (dosya başındaki temel sözleşme) → unverifiable, ağırlık 0. Kapı
    // `external_path`ten SONRA: o dal zaten git çağırmıyor, bütçeye takılması
    // yalnız sayıyı bulandırırdı.
    if (budget !== null && budget.used >= budget.limit) {
      out.push({ anchor, state: "unverifiable", budgetExhausted: true });
      continue;
    }
    if (anchor.kind === "commit_sha") {
      const r = await spend(budget, () => commitExists(ctx, anchor.value));
      // "sha yok" da "ölçemedim" de unverifiable; ama ikisi ayrı sebep, ve
      // yalnız ikincisi olay yazdırır. Skor açısından fark yok (ağırlık 0).
      out.push({ anchor, state: r.ok && r.value ? "ok" : "unverifiable", ...(r.ok ? {} : { measurementFailed: failureOf(r)! }) });
      continue;
    }
    if (anchor.kind === "symbol") {
      // Dikkat: `symbolExists` ALT-DİZE eşleşmesidir (git grep -F). Buradaki "ok"
      // "sembol kesin duruyor" değil "adı bir yerde hâlâ geçiyor" demektir —
      // yorumda kaldığı yer, skorda suçlama üretmediği için zararsız.
      const here = await spend(budget, () => symbolExists(ctx, null, anchor.value));
      if (!here.ok) { out.push({ anchor, state: "unverifiable", measurementFailed: failureOf(here)! }); continue; }
      if (here.value) { out.push({ anchor, state: "ok" }); continue; }
      const ever = await spend(budget, () => symbolEverExisted(ctx, anchor.value));
      if (!ever.ok) { out.push({ anchor, state: "unverifiable", measurementFailed: failureOf(ever)! }); continue; }
      out.push({ anchor, state: ever.value ? "symbol_lost" : "unverifiable" });
      continue;
    }
    // file_path: iki ref birden (M0-D7), skor kötüsünden (D-M3-5).
    let v = await filePathVerdict(ctx, anchor, anchor.value, sinceIso, budget);

    // Sonek çözümlemesi (altın set §5.2): `never_existed` demeden ÖNCE, nottaki
    // kısa yol repoda gerçekten var mı diye bakılır. Yalnız bu dalda ödenir —
    // duran, silinmiş ya da ölçülemeyen çapa ek git çağrısı görmez.
    if (v.state === "never_existed") {
      const matches = await spend(budget, () => filesMatchingSuffix(ctx, anchor.value));
      if (!matches.ok) {
        // Ölçüm arızası ASLA suçlamaya dönmez (dosya başındaki temel sözleşme):
        // eşleşmeyi göremediysek "hiç var olmamış" diyemeyiz.
        v = { anchor, state: "unverifiable", measurementFailed: failureOf(matches)! };
      } else if (matches.value.length === 1) {
        const resolved = matches.value[0]!;
        v = { ...(await filePathVerdict(ctx, anchor, resolved, sinceIso, budget)), resolvedPath: resolved };
      } else if (matches.value.length > 1) {
        // Hangi dosyanın kastedildiği ÖLÇÜLEMİYOR. Rastgele birini seçmek sahte
        // bir kesinlik, hepsini suçlamak uydurma bir kayma olurdu.
        v = { anchor, state: "unverifiable" };
      }
      // 0 eşleşme: yol gerçekten hiçbir yerde yok → never_existed korunur.
    }
    out.push(v);
  }
  return out;
}

/** Bir yolun iki ref'e karşı hükmü. Sonek çözümlemesinde çözülmüş yolla TEKRAR
 *  çağrılır — çözülen çapa normal akışın (exists/churn) tamamından geçsin diye. */
async function filePathVerdict(
  ctx: GitContext, anchor: Anchor, path: string, sinceIso: string, budget: GitBudget | null,
): Promise<AnchorVerdict> {
  const head = await fileStateAt(ctx, "HEAD", path, sinceIso, budget);
  const origin = ctx.originRef !== null ? await fileStateAt(ctx, ctx.originRef, path, sinceIso, budget) : null;
  // Ölçülemeyen taraf hükme KATILMAZ: bir ref'te arıza, diğerinde başarılı
  // ölçüm varsa hüküm ölçülenden çıkar. Aksi hâlde tek bir arıza, çalışan
  // ölçümü de nötrleştirip gerçek çürümeyi kaçırırdı.
  const measured = [head, origin].filter((s): s is FileState => s !== null && s.failure === undefined);
  const worse = measured.length === 0
    ? head // ikisi de ölçülemedi → unverifiable, arıza aşağıda taşınır
    : measured.reduce((a, b) => (SEVERITY[b.state] > SEVERITY[a.state] ? b : a));
  const commits = [head.commits, origin?.commits].filter((n): n is number => n !== undefined);
  const failure = head.failure ?? origin?.failure;
  return {
    anchor,
    state: worse.state,
    ...(commits.length > 0 ? { commits: Math.max(...commits) } : {}),
    // Uyuşmazlık ancak İKİ taraf da ölçülebildiyse anlamlı; biri arızalıysa
    // "ok vs unverifiable" gibi yanıltıcı bir satır üretirdi.
    ...(origin !== null && failure === undefined && origin.state !== head.state
      ? { refDisagreement: { head: head.state, origin: origin.state } }
      : {}),
    ...(failure !== undefined ? { measurementFailed: failure } : {}),
  };
}

export function scoreDrift(verdicts: AnchorVerdict[], statusPattern: boolean): DriftScore {
  let score = 0;
  const reasons: string[] = [];
  let maxCommits = 0;
  let anchorMoved = false;
  let neverExistedRaw = 0;   // kırpma ÖNCESİ toplam — tavana değip değmediği buradan
  let neverExistedCount = 0;
  let resolvedCount = 0;     // sonekle çözülen çapa sayısı (born_invalid göstergesi)
  let budgetExhausted = 0;   // bütçe dolduğu için HİÇ ölçülmemiş çapa

  for (const v of verdicts) {
    const w = WEIGHT[v.state];
    if (w !== undefined) {
      if (v.state === "never_existed") { neverExistedRaw += w; neverExistedCount++; }
      else score += w;
      // `never_existed` de hareket sayılır. Eski kural ("hiç var olmamış çapa
      // hareket değil") sonek çözümlemesinden ÖNCE doğruydu: o zaman hüküm yolun
      // kısa yazılmasından da çıkabiliyordu. Artık `never_existed` ancak sonek
      // araması SIFIR eşleşme döndükten sonra ayakta kalıyor (r2 §2: 15 hükmün
      // 3'ü bu elemeden geçebildi) — yani "gerçekten hiçbir yerde yok" ölçülmüş
      // bir iddia, ve çapanın işaret ettiği yüzeyin gitmiş olmasıyla eşdeğer.
      // Eski kuralın bedeli ölçüldü: `windows-acikleri` iki tur boyunca tam
      // 0,50'de takıldı çünkü D1 (DURUM + hareket) bileşimi hiç açılmadı.
      anchorMoved = true;
      const refNote = v.refDisagreement !== undefined
        ? ` (çalışma ağacı: ${v.refDisagreement.head}, origin: ${v.refDisagreement.origin})`
        : "";
      reasons.push(`${v.anchor.kind} ${v.anchor.value}: ${v.state}${refNote}`);
    }
    // Arıza gerekçesi skordan BAĞIMSIZ yazılır (ağırlıklı durum olmadığı için
    // yukarıdaki daldan geçmez). Kullanıcı "git söyleyemedi" ile "dosya gitti"yi
    // ancak burada ayırabiliyor; sessiz kalırsa skor 0 "temiz" diye okunur.
    // Çözümleme skordan bağımsız yazılır: çözülen çapa çoğunlukla `ok` çıkıyor
    // (ağırlıksız dal) ve o hâlde HİÇ gerekçe üretmezdi — yani bir varsayım
    // sessizce hükme girerdi. Kullanıcı hangi yolun ölçüldüğünü görmeli.
    if (v.resolvedPath !== undefined) {
      // Sayım yalnız GERÇEKTEN çözülmüş çapaya: çözümleme sonrası hükmü hâlâ
      // `never_existed` olan çapa "kısaltma kullanılmış" kanıtı DEĞİL — o yol
      // yeni ölçülen konumda da yok, yani ortada tek bir olgu var.
      //
      // Denetim (2026-08-12, `suffix-index-double-count`): `filesMatchingSuffix`
      // INDEX'e bakıyor (`git ls-files`), hüküm ise AĞAÇLARA (HEAD/origin).
      // Index'te olup ağaçta olmayan bir dosya (yeni staged) tek olgudan iki
      // "bağımsız sınıf" üretiyordu: never_existed toplamı 0,5 (tavanda) +
      // born_invalid 0,2 = 0,7 → tek sinyal sınıfı tek başına mahkûm ediyordu.
      // Bu, 4fa874d ile yazılan tavanın açık gerekçesinin ihlaliydi.
      if (v.state !== "never_existed") resolvedCount++;
      reasons.push(`${v.anchor.kind} ${v.anchor.value}: sonek çözümlendi → ${v.resolvedPath} (durum: ${v.state})`);
    }
    if (v.budgetExhausted === true) budgetExhausted++;
    if (v.measurementFailed !== undefined) {
      reasons.push(
        `${v.anchor.kind} ${v.anchor.value}: ölçülemedi — ${v.measurementFailed.command}` +
        ` (${v.measurementFailed.reason}); skora katkı yok`,
      );
    }
    if (v.commits !== undefined) maxCommits = Math.max(maxCommits, v.commits);
  }

  // Sessiz tavan görünmez bir varsayım olurdu: kırpma gerçekleştiğinde söylenir.
  score += Math.min(neverExistedRaw, NEVER_EXISTED_CAP);
  if (neverExistedRaw > NEVER_EXISTED_CAP) {
    reasons.push(`never_existed katkısı ${NEVER_EXISTED_CAP} tavanında kırpıldı (${neverExistedCount} çapa)`);
  }

  // Tek satır, çapa başına değil: bütçe dolduğunda yüzlerce çapa etkilenebilir
  // ve gerekçe listesi olay günlüğüne yazılıyor (audit.ts signal_scored).
  if (budgetExhausted > 0)
    reasons.push(`${budgetExhausted} çapa git bütçesi dolduğu için ÖLÇÜLMEDİ; skora katkı yok`);

  if (resolvedCount >= BORN_INVALID_MIN_RESOLVED) {
    score += BORN_INVALID_WEIGHT;
    reasons.push(`${resolvedCount} çapa yazıldığı yolda değil — not yolları yanlış yazıyor (born_invalid)`);
  }

  if (maxCommits >= 3) {
    score += maxCommits >= 10 ? 0.3 : 0.2;
    anchorMoved = true;
    reasons.push(`churn: not tarihinden beri ${maxCommits} commit`);
  } else if (maxCommits >= 1) anchorMoved = true;

  if (statusPattern) {
    // M0-D1: DURUM + hareket bileşimi tek başına eşiği aşar; kalıp tek başına aşmaz.
    if (anchorMoved) {
      score = Math.max(score, 0.7);
      reasons.push("DURUM-kalıbı + çapa hareketi (M0-D1)");
    } else {
      score += 0.2;
      reasons.push("DURUM-kalıbı (hareketsiz: tek başına eşik altı)");
    }
  }

  return { score: Math.min(1, Number(score.toFixed(4))), reasons };
}
