// Çapa doğrulama + kayma skoru. M2'nin %10 uydurma çapa borcu burada kapanır:
// "geçmişte hiç izi yok" (never_existed / unverifiable) ile "var olup kaybolmuş"
// (missing_now / symbol_lost) yapısal olarak ayrışır — suçlama yalnız kanıtlıya.

import type { Anchor } from "../types.ts";
import {
  type GitContext, fileExistsAt, fileEverExisted, commitsTouching,
  symbolExists, symbolEverExisted, commitExists,
} from "./git.ts";

export const SUSPICION_THRESHOLD = 0.6; // M0 kalibrasyonu (rapor §5)

export type AnchorState = "ok" | "missing_now" | "never_existed" | "symbol_lost" | "churned" | "unverifiable";

export interface AnchorVerdict {
  anchor: Anchor;
  state: AnchorState;
  /** Not tarihinden beri çapa dosyasına dokunan commit sayısı. */
  commits?: number;
  /** Çalışma ağacı ile origin farklı hüküm verdi (M0-D7) — ikisi de raporlanır. */
  refDisagreement?: { head: AnchorState; origin: AnchorState };
}

export interface DriftScore { score: number; reasons: string[] }

// D-M3-4 ağırlıkları. Değişiklik ancak altın set ölçümüyle — sayılar M0'dan.
// never_existed'ın düşük tutulmasının bir sebebi daha var: `fileEverExisted`
// hata hâlinde de false döner (git.ts: ok=false → "hayır"), yani bir git arızası
// çapayı sessizce never_existed yönüne düşürür. Ucuz yanlış tarafta duruyoruz.
const WEIGHT: Partial<Record<AnchorState, number>> = {
  missing_now: 0.5,
  symbol_lost: 0.4,
  never_existed: 0.3,
};
const SEVERITY: Record<AnchorState, number> = {
  missing_now: 3, symbol_lost: 3, never_existed: 2, churned: 1, ok: 0, unverifiable: 0,
};

// Çapa yolları ZATEN repo köküne göreli. Burada hiçbir yol birleştirmesi
// yapılmaz, `path` git'e olduğu gibi geçer: `ctx.repoRoot` çağıranın verdiği
// dizinle aynı olmayabilir (macOS /var → /private/var) ve kendi birleştirmemiz
// o farkı sessizce yanlış yola çevirirdi.
async function fileStateAt(ctx: GitContext, ref: string, path: string, sinceIso: string): Promise<{ state: AnchorState; commits: number }> {
  if (await fileExistsAt(ctx, ref, path)) {
    const commits = await commitsTouching(ctx, ref, path, sinceIso);
    return { state: commits >= 3 ? "churned" : "ok", commits };
  }
  return { state: (await fileEverExisted(ctx, path)) ? "missing_now" : "never_existed", commits: 0 };
}

export async function checkAnchors(ctx: GitContext, anchors: Anchor[], sinceIso: string): Promise<AnchorVerdict[]> {
  const out: AnchorVerdict[] = [];
  for (const anchor of anchors) {
    if (anchor.kind === "external_path") { out.push({ anchor, state: "unverifiable" }); continue; } // D-M3-7
    if (anchor.kind === "commit_sha") {
      out.push({ anchor, state: (await commitExists(ctx, anchor.value)) ? "ok" : "unverifiable" });
      continue;
    }
    if (anchor.kind === "symbol") {
      // Dikkat: `symbolExists` ALT-DİZE eşleşmesidir (git grep -F). Buradaki "ok"
      // "sembol kesin duruyor" değil "adı bir yerde hâlâ geçiyor" demektir —
      // yorumda kaldığı yer, skorda suçlama üretmediği için zararsız.
      if (await symbolExists(ctx, null, anchor.value)) { out.push({ anchor, state: "ok" }); continue; }
      out.push({ anchor, state: (await symbolEverExisted(ctx, anchor.value)) ? "symbol_lost" : "unverifiable" });
      continue;
    }
    // file_path: iki ref birden (M0-D7), skor kötüsünden (D-M3-5).
    const head = await fileStateAt(ctx, "HEAD", anchor.value, sinceIso);
    const origin = ctx.originRef !== null ? await fileStateAt(ctx, ctx.originRef, anchor.value, sinceIso) : null;
    const worse = origin !== null && SEVERITY[origin.state] > SEVERITY[head.state] ? origin : head;
    out.push({
      anchor,
      state: worse.state,
      commits: Math.max(head.commits, origin?.commits ?? 0),
      ...(origin !== null && origin.state !== head.state
        ? { refDisagreement: { head: head.state, origin: origin.state } }
        : {}),
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
