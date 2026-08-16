// Rule-based Turkish diagnosis sentences for case cards (yeniden-tasarım
// tasarım-notu.md §"Diagnosis sentences"). Deliberately NOT an LLM call: the
// sentence must be reproducible from (finding, live verdict, anchors) alone,
// so the same store state always renders the same card — an LLM call would
// make the UI itself a second, unaudited decay surface.
//
// Pure: no I/O, no store handle. Rules are data (ordered list), not an
// if-forest, so a new rule is one array entry instead of a new branch nested
// inside the old ones.

import type { VerdictDetail } from "./api.ts";
import { parseNote } from "../importer/parse.ts";

export interface DiagnoseInput {
  content: string;
  status: string;
  suspicion: number;
  verdict: VerdictDetail | null;
  anchors: { kind: string; value: string }[];
}

export interface Diagnosis {
  title: string;
  sentence: string;
  accent: string | null;
}

const MAX_SENTENCE = 140;

// Same literal as signals/status-pattern.ts's first pattern (the strongest
// cheap signal, M0-D1) — kept as its own constant here rather than imported
// because this rule additionally needs the CAPTURED line text for the
// excerpt, which the shared detector does not expose.
const DURUM_LINE_RE = /^DURUM\s*:\s*(.*)$/im;

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Pulls the «accented» phrase out of a sentence built with guillemets in-band. */
function withAccent(sentence: string): { sentence: string; accent: string | null } {
  const m = /«([^»]+)»/.exec(sentence);
  return { sentence, accent: m ? m[1]! : null };
}

function humanizeTitle(raw: string): string {
  const spaced = raw.trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (spaced.length === 0) return "";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function firstBodyLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "";
}

/**
 * Pulls the first anchor value out of an anchor-drift evidence line
 * (audit.ts `evidenceLine`: `"<state>: <value1>, <value2> (+N)"`). The first
 * token before the first comma is always the untruncated value — the "(+N)"
 * suffix only ever attaches after the LAST shown value, never the first.
 */
function firstAnchorFromEvidence(evidence: string | null): string | null {
  if (evidence === null) return null;
  const m = /:\s*(.+)$/.exec(evidence);
  if (m === null) return null;
  const first = (m[1]!.split(",")[0] ?? "").trim();
  return first.length > 0 ? first : null;
}

/**
 * Pulls the unmeasured dimension name out of an `unmeasured-dimension`
 * evidence line (audit.ts: `"${missing.join(" + ")} boyutu ..."`).
 */
function dimensionFromEvidence(evidence: string | null): string | null {
  if (evidence === null) return null;
  const m = /^(.+?) boyutu/.exec(evidence);
  return m ? m[1]!.trim() : null;
}

const UNMEASURED_SUB_REASONS = new Set(["classify-undecided", "classifier-not-run", "anchor-unmeasured"]);

export function diagnose(input: DiagnoseInput): Diagnosis {
  const { frontmatter, body } = parseNote(input.content);
  const title = humanizeTitle(frontmatter["name"] ?? "");
  const v = input.verdict;

  // Rule 1 — status log: this class decays by construction (§3 "Doğuştan-yanlış
  // körlüğü" family), regardless of what the live verdict says about it.
  const durumMatch = DURUM_LINE_RE.exec(input.content);
  if (input.status === "born_invalid" || durumMatch !== null) {
    const excerpt = truncate(durumMatch ? durumMatch[1]! : firstBodyLine(body), 60);
    const quoted = excerpt.length > 0 ? `"${excerpt}"` : "bu not";
    return {
      title,
      ...withAccent(truncate(
        `Bu not bir «durum günlüğü» — ${quoted} diyor; bu sınıf kod ilerledikçe sessizce eskiyor.`,
        MAX_SENTENCE,
      )),
    };
  }

  // Rule 2 — anchor drift: the mechanical layer measured a file/symbol gone.
  if (v !== null && v.verdict === "curuk" && (v.method ?? "").includes("anchor-drift")) {
    const value = firstAnchorFromEvidence(v.evidence);
    const sentence = value !== null
      ? `Çapaladığı dosya («${value}») artık izlediği yerde değil.`
      : "Çapaladığı dosya artık izlediği yerde değil.";
    return { title, ...withAccent(truncate(sentence, MAX_SENTENCE)) };
  }

  // Rule 3 — a dimension could not be measured this run; the prior suspicion
  // was held, not cleared (audit.ts markUnmeasured / heldUnmeasured path).
  if (v !== null && v.verdict === "olculemez" && v.subReason !== null
    && UNMEASURED_SUB_REASONS.has(v.subReason)) {
    const dimension = dimensionFromEvidence(v.evidence) ?? "bu boyut";
    return {
      title,
      ...withAccent(truncate(
        `Son koşumda «${dimension}» ölçülemedi; önceki şüphe düşürülmedi.`,
        MAX_SENTENCE,
      )),
    };
  }

  // Rule 4 — starved out of the classify rotation for three full turns.
  if (v !== null && v.verdict === "olculemez" && v.subReason === "rotation-starved") {
    return {
      title,
      ...withAccent(truncate(
        "Bu not «3 rotasyondur» sınıflama bütçesine giremedi.",
        MAX_SENTENCE,
      )),
    };
  }

  // Rule 5 — never_existed: the note was wrong the day it was written.
  if (v !== null && v.verdict === "dogustan-yanlis") {
    const evidence = truncate(v.evidence ?? "kanıt kaydı yok", 70);
    return {
      title,
      ...withAccent(truncate(
        `Alet bu notun yazıldığı gün de «yanlış» olduğunu düşünüyor — kanıt: ${evidence}.`,
        MAX_SENTENCE,
      )),
    };
  }

  // Rule 6 — historical record: describes a past day, not decay of today.
  if (v !== null && v.verdict === "tarihsel") {
    return {
      title,
      ...withAccent(truncate(
        "«Tarihsel kayıt»: bugünü değil, o günü anlatıyor — çürüme sayılmaz.",
        MAX_SENTENCE,
      )),
    };
  }

  // Fallback: no rule matched (e.g. verdict `gecerli`, or a verdict shape the
  // rules above don't recognise) — compress method+evidence into one line
  // rather than showing nothing.
  if (v === null) return { title, sentence: "Bu koşumda hüküm çıkmadı.", accent: null };
  const method = v.method ?? "ölçüm";
  const evidence = v.evidence ?? "kayıt yok";
  return { title, sentence: truncate(`${method}: ${evidence}`, MAX_SENTENCE), accent: null };
}
