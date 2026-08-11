// Çapa doğrulama + kayma skoru. M2'nin %10 uydurma çapa borcu burada kapanır:
// "geçmişte hiç izi yok" (never_existed / unverifiable) ile "var olup kaybolmuş"
// (missing_now / symbol_lost) yapısal olarak ayrışır — suçlama yalnız kanıtlıya.

import type { Anchor } from "../types.ts";
import {
  type GitContext, type Measured, fileExistsAt, fileEverExisted, commitsTouching,
  symbolExists, symbolEverExisted, commitExists,
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
}

export interface DriftScore { score: number; reasons: string[] }

// D-M3-4 ağırlıkları. Değişiklik ancak altın set ölçümüyle — sayılar M0'dan.
const WEIGHT: Partial<Record<AnchorState, number>> = {
  missing_now: 0.5,
  symbol_lost: 0.4,
  never_existed: 0.3,
};
const SEVERITY: Record<AnchorState, number> = {
  missing_now: 3, symbol_lost: 3, never_existed: 2, churned: 1, ok: 0, unverifiable: 0,
};

/** Ölçüm arızasını AnchorVerdict alanına çevirir. */
const failureOf = (m: Measured<unknown>): MeasurementFailure | undefined =>
  m.ok ? undefined : { command: m.command, reason: m.reason };

interface FileState { state: AnchorState; commits?: number; failure?: MeasurementFailure }

// Çapa yolları ZATEN repo köküne göreli. Burada hiçbir yol birleştirmesi
// yapılmaz, `path` git'e olduğu gibi geçer: `ctx.repoRoot` çağıranın verdiği
// dizinle aynı olmayabilir (macOS /var → /private/var) ve kendi birleştirmemiz
// o farkı sessizce yanlış yola çevirirdi.
async function fileStateAt(ctx: GitContext, ref: string, path: string, sinceIso: string): Promise<FileState> {
  const exists = await fileExistsAt(ctx, ref, path);
  // Varlık ölçülemedi → hiçbir şey bilmiyoruz. Eskiden burası `missing_now`'a
  // düşüyordu (ağırlık 0.5) ve DURUM kalıplı notu tek başına suçlu yapıyordu.
  if (!exists.ok) return { state: "unverifiable", failure: failureOf(exists) };

  if (exists.value) {
    const churn = await commitsTouching(ctx, ref, path, sinceIso);
    // Ters yön: dosya DURUYOR, yalnız churn ölçülemedi. 0 saymak kaçırılan
    // çürüme demek — skoru şişirmiyoruz ama arızayı görünür bırakıyoruz.
    if (!churn.ok) return { state: "ok", failure: failureOf(churn) };
    return { state: churn.value >= 3 ? "churned" : "ok", commits: churn.value };
  }

  const ever = await fileEverExisted(ctx, path);
  // "Hiç var olmuş mu" ölçülemedi: missing_now (0.5) ile never_existed (0.3)
  // arasında seçim yapamayız, ikisi de suçlama. Bilgisizliği suçlamaya çevirmek
  // yerine nötr kalınır.
  if (!ever.ok) return { state: "unverifiable", failure: failureOf(ever) };
  return { state: ever.value ? "missing_now" : "never_existed", commits: 0 };
}

export async function checkAnchors(ctx: GitContext, anchors: Anchor[], sinceIso: string): Promise<AnchorVerdict[]> {
  const out: AnchorVerdict[] = [];
  for (const anchor of anchors) {
    if (anchor.kind === "external_path") { out.push({ anchor, state: "unverifiable" }); continue; } // D-M3-7
    if (anchor.kind === "commit_sha") {
      const r = await commitExists(ctx, anchor.value);
      // "sha yok" da "ölçemedim" de unverifiable; ama ikisi ayrı sebep, ve
      // yalnız ikincisi olay yazdırır. Skor açısından fark yok (ağırlık 0).
      out.push({ anchor, state: r.ok && r.value ? "ok" : "unverifiable", ...(r.ok ? {} : { measurementFailed: failureOf(r)! }) });
      continue;
    }
    if (anchor.kind === "symbol") {
      // Dikkat: `symbolExists` ALT-DİZE eşleşmesidir (git grep -F). Buradaki "ok"
      // "sembol kesin duruyor" değil "adı bir yerde hâlâ geçiyor" demektir —
      // yorumda kaldığı yer, skorda suçlama üretmediği için zararsız.
      const here = await symbolExists(ctx, null, anchor.value);
      if (!here.ok) { out.push({ anchor, state: "unverifiable", measurementFailed: failureOf(here)! }); continue; }
      if (here.value) { out.push({ anchor, state: "ok" }); continue; }
      const ever = await symbolEverExisted(ctx, anchor.value);
      if (!ever.ok) { out.push({ anchor, state: "unverifiable", measurementFailed: failureOf(ever)! }); continue; }
      out.push({ anchor, state: ever.value ? "symbol_lost" : "unverifiable" });
      continue;
    }
    // file_path: iki ref birden (M0-D7), skor kötüsünden (D-M3-5).
    const head = await fileStateAt(ctx, "HEAD", anchor.value, sinceIso);
    const origin = ctx.originRef !== null ? await fileStateAt(ctx, ctx.originRef, anchor.value, sinceIso) : null;
    // Ölçülemeyen taraf hükme KATILMAZ: bir ref'te arıza, diğerinde başarılı
    // ölçüm varsa hüküm ölçülenden çıkar. Aksi hâlde tek bir arıza, çalışan
    // ölçümü de nötrleştirip gerçek çürümeyi kaçırırdı.
    const measured = [head, origin].filter((s): s is FileState => s !== null && s.failure === undefined);
    const worse = measured.length === 0
      ? head // ikisi de ölçülemedi → unverifiable, arıza aşağıda taşınır
      : measured.reduce((a, b) => (SEVERITY[b.state] > SEVERITY[a.state] ? b : a));
    const commits = [head.commits, origin?.commits].filter((n): n is number => n !== undefined);
    const failure = head.failure ?? origin?.failure;
    out.push({
      anchor,
      state: worse.state,
      ...(commits.length > 0 ? { commits: Math.max(...commits) } : {}),
      // Uyuşmazlık ancak İKİ taraf da ölçülebildiyse anlamlı; biri arızalıysa
      // "ok vs unverifiable" gibi yanıltıcı bir satır üretirdi.
      ...(origin !== null && failure === undefined && origin.state !== head.state
        ? { refDisagreement: { head: head.state, origin: origin.state } }
        : {}),
      ...(failure !== undefined ? { measurementFailed: failure } : {}),
    });
  }
  return out;
}

export function scoreDrift(verdicts: AnchorVerdict[], statusPattern: boolean): DriftScore {
  let score = 0;
  const reasons: string[] = [];
  let maxCommits = 0;
  let anchorMoved = false;

  for (const v of verdicts) {
    const w = WEIGHT[v.state];
    if (w !== undefined) {
      score += w;
      anchorMoved = anchorMoved || v.state !== "never_existed"; // hiç var olmamış çapa "hareket" değil
      const refNote = v.refDisagreement !== undefined
        ? ` (çalışma ağacı: ${v.refDisagreement.head}, origin: ${v.refDisagreement.origin})`
        : "";
      reasons.push(`${v.anchor.kind} ${v.anchor.value}: ${v.state}${refNote}`);
    }
    // Arıza gerekçesi skordan BAĞIMSIZ yazılır (ağırlıklı durum olmadığı için
    // yukarıdaki daldan geçmez). Kullanıcı "git söyleyemedi" ile "dosya gitti"yi
    // ancak burada ayırabiliyor; sessiz kalırsa skor 0 "temiz" diye okunur.
    if (v.measurementFailed !== undefined) {
      reasons.push(
        `${v.anchor.kind} ${v.anchor.value}: ölçülemedi — ${v.measurementFailed.command}` +
        ` (${v.measurementFailed.reason}); skora katkı yok`,
      );
    }
    if (v.commits !== undefined) maxCommits = Math.max(maxCommits, v.commits);
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
