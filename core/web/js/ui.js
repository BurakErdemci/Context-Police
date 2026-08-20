import { postReview } from "./api.js";
import { playDecision } from "./anim.js";

// Shared visual dictionary (tasarim-notu.md): rings, bands, sparklines,
// meters, chips, and the Turkish sentence helpers. Everything here builds
// DOM via createElement — API-derived strings only ever pass through
// textContent, never innerHTML.

export const VERDICT_LABELS = {
  gecerli: "geçerli",
  curuk: "çürük",
  "dogustan-yanlis": "doğuştan yanlış",
  olculemez: "ölçülemez",
  tarihsel: "tarihsel",
};

export function verdictLabel(v) {
  return VERDICT_LABELS[v] ?? v;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Health ring: pct 0–100, colored by most urgent state. `faded` renders the
 * sleeping-project variant (full but dimmed — "unused ≠ decayed").
 */
export function ring(pct, color, { size = 84, faded = false, center } = {}) {
  const wrap = el("div", faded ? "ring ring--faded" : "ring");
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  const stroke = 7;
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const svg = svgEl("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  svg.appendChild(svgEl("circle", {
    cx: size / 2, cy: size / 2, r, fill: "none", stroke: COLORS.track, "stroke-width": stroke,
  }));
  const clamped = Math.max(0, Math.min(100, pct));
  const arc = svgEl("circle", {
    cx: size / 2, cy: size / 2, r, fill: "none", stroke: color, "stroke-width": stroke,
    "stroke-linecap": "round",
    "stroke-dasharray": `${(clamped / 100) * c} ${c}`,
    class: "ring-arc",
  });
  svg.appendChild(arc);
  wrap.appendChild(svg);
  const num = el("div", "ring-num", center ?? `%${Math.round(clamped)}`);
  num.style.fontSize = `${Math.round(size / 4.9)}px`;
  wrap.appendChild(num);
  return wrap;
}

/** Segmented distribution band. segments: [{n, color}], zero-n entries skipped. */
export function band(segments, big = false) {
  const node = el("div", big ? "band band--big" : "band");
  for (const s of segments) {
    if (s.n <= 0) continue;
    const i = el("i");
    i.style.flex = String(s.n);
    i.style.background = s.color;
    node.appendChild(i);
  }
  return node;
}

/** Tiny legend under a band. entries: [{n, color, label}] — zero entries skipped. */
export function bandKey(entries) {
  const key = el("div", "bandkey");
  for (const e of entries) {
    if (e.n <= 0) continue;
    const item = el("s");
    const dot = el("span", "dot");
    dot.style.background = e.color;
    item.append(dot, document.createTextNode(` ${e.label}`));
    key.appendChild(item);
  }
  return key;
}

/** Mini run-history polyline, last point emphasized when `dot` is given. */
export function sparkline(series, { stroke, dot, width = 110, height = 22 } = {}) {
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
  const pad = 4;
  const values = series.length > 0 ? series : [0, 0];
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = (width - 2 * pad) / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => {
    const x = pad + i * step;
    const y = height - pad - ((v - min) / span) * (height - 2 * pad);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
  svg.appendChild(svgEl("polyline", {
    points: pts.map(([x, y]) => `${x},${y}`).join(" "),
    fill: "none", stroke, "stroke-width": 2, "stroke-linecap": "round",
  }));
  if (dot !== undefined && pts.length > 0) {
    const [x, y] = pts[pts.length - 1];
    svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 2.5, fill: dot }));
  }
  return svg;
}

/** Suspicion meter (violet→drift fill) + tabular number, as a fragment. */
export function meter(value) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0));
  const bar = el("div", "meter");
  const fill = el("i");
  fill.style.width = `${Math.round(clamped * 100)}%`;
  bar.appendChild(fill);
  const num = el("span", "score", clamped.toFixed(2));
  return [bar, num];
}

/**
 * Renders a diagnosis sentence into `target`: plain text with «accent phrase»
 * markers; the accent goes into a <b> (createElement — the text is untrusted),
 * the guillemets themselves are markers and are dropped.
 */
export function renderSentence(target, sentence) {
  const parts = String(sentence).split(/«([^»]*)»/);
  parts.forEach((part, i) => {
    if (part === "") return;
    if (i % 2 === 1) target.appendChild(el("b", "", part));
    else target.appendChild(document.createTextNode(part));
  });
}

/**
 * Anchor chip with health dot. state: "ok" | "drift" | "untracked".
 * "untracked" is the symbol anchor: stored and shown, never measured (17 Aug
 * decision) — it gets the faint dot so a green one keeps meaning "measured, fine".
 */
const CHIP_CLASS = {
  drift: "anchor-chip anchor-chip--drift",
  untracked: "anchor-chip anchor-chip--untracked",
};
export function anchorChip(value, state) {
  const chip = el("span", CHIP_CLASS[state] ?? "anchor-chip");
  chip.appendChild(el("span", "", value));
  return chip;
}

export function anchorlessChip() {
  const chip = el("span", "anchor-chip anchor-chip--none");
  chip.appendChild(el("span", "", "çapasız — dosya izlenemiyor"));
  return chip;
}

/**
 * Anchor values a live curuk anchor-drift verdict names as moved/lost.
 * Evidence format (audit.ts evidenceLine): "<state>: <v1>, <v2> (+N)".
 */
export function driftedValues(claims) {
  const out = new Set();
  for (const claim of claims) {
    const v = claim.live;
    if (v === null || v.verdict !== "curuk" || !(v.method ?? "").includes("anchor-drift")) continue;
    const m = /:\s*(.+)$/.exec(v.evidence ?? "");
    if (m === null) continue;
    for (const part of m[1].split(",")) {
      const value = part.replace(/\(\+\d+\)\s*$/, "").trim();
      if (value.length > 0) out.add(value);
    }
  }
  return out;
}

/** Display-only path shortening: home prefix → "~" (mock renders paths so). */
export function shortPath(path) {
  return String(path).replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Humanized Turkish timestamp: "bugün 17:14", "dün 22:40", "5 gün önce", date. */
export function relTime(iso) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (days <= 0) return `bugün ${hm}`;
  if (days === 1) return `dün ${hm}`;
  if (days < 30) return `${days} gün önce`;
  return d.toLocaleDateString("tr-TR");
}

/** Days elapsed since `iso`, or null when unparsable. */
export function daysSince(iso) {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / DAY_MS;
}

// Turkish possessive suffix for a numeral ("2'si sağlıklı", "17'si temiz").
// Keyed on how the number's final word sounds; trailing zeros shift it to the
// tens/hundreds word ("10'u", "40'ı", "100'ü").
const POSSESSIVE_BY_DIGIT = { 1: "i", 2: "si", 3: "ü", 4: "ü", 5: "i", 6: "sı", 7: "si", 8: "i", 9: "u" };
const POSSESSIVE_BY_TENS = { 10: "u", 20: "si", 30: "u", 40: "ı", 50: "si", 60: "ı", 70: "i", 80: "i", 90: "ı" };

export function possessive(n) {
  const last = n % 10;
  if (last !== 0) return `${n}'${POSSESSIVE_BY_DIGIT[last]}`;
  const tens = n % 100;
  if (tens !== 0) return `${n}'${POSSESSIVE_BY_TENS[tens]}`;
  if (n === 0) return "0'ı";
  return `${n}'ü`; // yüz / bin / milyon all take "ü"/"i" — "ü" covers yüz, the common case
}

const IDLE_AFTER_DAYS = 7;

/** Project status for chips/rings: pending beats everything; then idleness. */
export function projectStatus(card) {
  if (card.pending > 0) return { kind: "wait", label: `${card.pending} ONAY` };
  const age = daysSince(card.lastRunAt);
  if (card.lastRunAt === null || card.runSeries.length === 0 || (age !== null && age > IDLE_AFTER_DAYS)) {
    return { kind: "idle", label: "SESSİZ" };
  }
  return { kind: "ok", label: "SAĞLIKLI" };
}

/** Make a card-like element behave as a link (click + Enter/Space). */
export function clickable(node, go) {
  node.tabIndex = 0;
  node.setAttribute("role", "link");
  node.addEventListener("click", go);
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
}

/** Shared storeMissing/schemaOutdated copy; returns true when handled. */
export function handleStoreStates(payload, showMessage) {
  if (payload.storeMissing === true) {
    showMessage(`Depo bulunamadı: ${payload.path} — \`context-police audit\` bir koşum sonra burayı doldurur.`);
    return true;
  }
  if (payload.schemaOutdated === true) {
    showMessage("Depo bu gezginden eski — `context-police audit` bir kez koşunca güncellenir.");
    return true;
  }
  return false;
}

/* --- review --------------------------------------------------------------- */

/** Decided-state chip. Also the post-success state of `reviewControls`. */
export function reviewBadge(decision) {
  return decision === "approved"
    ? el("span", "status status--approved", "ONAYLANDI")
    : el("span", "status status--rejected", "REDDEDİLDİ");
}

// Mapped from the status code, not from the server's message: the wording is a
// UI decision and must stay identical whichever shell (web, Tauri) is talking.
function reviewErrorText(err) {
  switch (err?.status) {
    // 409 covers two unrelated refusals (serve.ts REVIEW_STATUS): the verdict was
    // superseded, or the store file is gone. Only the body's `code` separates
    // them, and telling a user to re-read a note when the store moved sends them
    // looking for a problem that is not there.
    case 409:
      return err?.body?.code === "store_missing"
        ? "depo dosyası bulunamadı — denetim deposu taşınmış ya da silinmiş olabilir"
        : "bu hüküm daha yeni bir ölçümle geçersiz kılınmış";
    case 404: return "bu hüküm artık bulunamıyor";
    case 403: return "istek reddedildi — sayfayı yenile";
    case 400: return "istek geçersiz";
    case 0: return "sunucuya ulaşılamadı";
    default: return "karar kaydedilemedi";
  }
}

/**
 * Chip + Onayla/Reddet buttons for one or more verdict ids (a case card can
 * speak for several grouped verdicts; the sicil card passes one). Amber lives
 * only on the undecided state — once decided, the chip goes green/gray and the
 * amber affordance disappears.
 *
 * The decision is written to the store here and now, and it is REVERSIBLE
 * (design §7b): a decided verdict keeps a "Geri al" button that posts
 * `pending`, and a live row can be flipped straight from one decision to the
 * other. `initialDecision` seeds the state for a record that was already
 * decided before this render. `onChange(ids, decision)` fires only after the
 * write actually landed.
 *
 * `opts.target` names the case-card node the decision choreography plays on
 * (stamp / basket throw / un-file). It is optional: without it the controls
 * behave exactly as before, silently and instantly. The gesture runs only on
 * the success path — a stamp that lands while the write was refused would be
 * the tool lying about its own ledger, which is the failure mode this product
 * exists to catch.
 */
export function reviewControls(verdictIds, onChange, initialDecision, opts) {
  const ids = Array.isArray(verdictIds) ? verdictIds : [verdictIds];
  const box = el("span", "review-box");
  // Clicks and Enter/Space inside the box must not reach a clickable card.
  for (const type of ["click", "keydown"]) {
    box.addEventListener(type, (e) => e.stopPropagation());
  }

  let busy = false;
  let decided = initialDecision === "approved" || initialDecision === "rejected"
    ? initialDecision
    : null;

  const btn = (className, label, go) => {
    const b = el("button", className, label);
    b.type = "button";
    b.disabled = busy;
    b.addEventListener("click", go);
    return b;
  };

  function render(errorText) {
    box.textContent = "";
    if (decided === null) {
      box.appendChild(el("span", "status status--wait", "ONAY BEKLİYOR"));
      box.appendChild(btn("btn btn--approve", "Onayla", () => decide("approved")));
      box.appendChild(btn("btn btn--reject", "Reddet", () => decide("rejected")));
    } else {
      box.appendChild(reviewBadge(decided));
      box.appendChild(btn("btn btn--undo", "Geri al", () => decide("pending")));
    }
    if (errorText !== undefined) {
      const line = el("span", "review-error", errorText);
      line.setAttribute("role", "status");
      box.appendChild(line);
    }
  }

  async function decide(decision) {
    if (busy) return;
    busy = true;
    render(); // clears any previous error and disables the buttons
    try {
      // Sequential on purpose: the first refusal stops the rest, so a grouped
      // card cannot half-decide beyond the one request already in flight.
      for (const id of ids) await postReview(id, decision);
      // Buttons stay disabled through the gesture: `busy` is only cleared once
      // the card has finished moving and the fresh controls are drawn.
      await playDecision(decision, opts?.target);
      busy = false;
      decided = decision === "pending" ? null : decision;
      render();
      if (onChange !== undefined) onChange(ids, decision);
    } catch (err) {
      // Nothing sticks in the UI: back to the previous state plus one line.
      // Any ids written before the failure reconcile on the next poll refresh,
      // which is the same reconciliation every screen already does.
      busy = false;
      render(reviewErrorText(err));
    }
  }

  render();
  return box;
}

/**
 * Ink palette for the SVG/inline-style dictionary (ring, band, sparkline).
 *
 * These are hex, not var(): the ring and the sparkline set them as SVG
 * presentation attributes (`stroke`, `fill`), where a custom property is not
 * resolved. The names are kept from the graphite skin so the three lanes' call
 * sites do not move; the values are the paper-ground equivalents.
 *
 * Calibrated for the "vaka defteri" paper (--paper #FAF6EC): every value here
 * is an ink or pencil tone dark enough to read on it. The dark skin's luminous
 * hues (#58C08A, #9D9BF5) disappear on paper — they were lit for a #17181D
 * ground. `amber` is the one deliberate divergence from --hilite: highlighter
 * yellow works as a chip fill behind ink text, but a 8px band segment of
 * #FFE45C on cream is invisible, so the drawn form takes an ochre of the same
 * family.
 */
export const COLORS = {
  green: "#4E8A5A",      // --green-pencil
  greenDim: "#8FB08F",   // spent pencil: sparkline line under a green dot
  violet: "#57524A",     // --ink-soft — "suspect" reads as ink, not as a hue
  violetHi: "#3F3A32",   // darker ink for the band segment beside green
  violetDim: "#A9A296",
  amber: "#C99400",      // ochre sibling of --hilite (see note above)
  drift: "#C43C2E",      // --red-ink
  idleLine: "#C6BFAF",   // faint pencil on paper: present, not shouting
  track: "#E3DCC9",      // --paper2 shaded: the unfilled part of a ring/band
};
