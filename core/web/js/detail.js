// Not sicili: the note tells its story. Frontmatter is never shown raw — the
// title comes from `name:`, the description becomes a subtitle, and the full
// raw text hides behind "ham not". The body renders as serif prose with the
// lines the measurement points at highlighted; the right column carries the
// diagnosis lede, the enriched verdict ledger, and the tool's advice.
//
// All highlighting is built by splitting text into createElement/textContent
// nodes — API-derived strings never pass through innerHTML.

import {
  verdictLabel, renderSentence, driftedValues, anchorChip, el, reviewControls,
} from "./ui.js";

function shortSha(sha) {
  if (typeof sha !== "string" || sha === "") return "—";
  return sha.slice(0, 7);
}

function localDate(iso) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
}

// Minimal client-side frontmatter split — same shape as importer/parse.ts's
// top level, but only for display (name/description); the store keeps truth.
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitNote(content) {
  const m = FM_RE.exec(content);
  if (m === null) return { fm: {}, body: content };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.+)$/.exec(line);
    if (kv !== null) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { fm, body: content.slice(m[0].length) };
}

// Plain-Turkish explainers for known measurement methods (matched by
// substring: the stored method may carry a suffix like "anchor-drift (git)").
// An unknown method gets no explainer — it is shown as-is, never guessed at.
const METHOD_EXPLAINERS = [
  ["anchor-drift", "çapalanan dosyalar git geçmişine karşı ölçüldü"],
  ["unmeasured-dimension", "bu boyut o koşumda ölçülemedi"],
  ["classify-rotation", "sınıflama bütçesi rotasyonu"],
  ["adjudicate", "araçlı hakem ölçümü"],
];

function methodExplainer(method) {
  for (const [key, text] of METHOD_EXPLAINERS) {
    if (method.includes(key)) return text;
  }
  return null;
}

// Honest generic advice when the verdict carries no correction text. Only the
// verdicts the tool actually understands get a line; anything else gets none.
const ADVICE_BY_VERDICT = {
  "dogustan-yanlis": "Bu notu gözden geçir: ölçüm, yazıldığı gün de yanlış olduğunu söylüyor.",
  curuk: "Not güncel durumu yansıtmıyor — güncelle ya da tarihsel işaretle.",
  olculemez: "Henüz tavsiye yok: boyut ölçülemedi.",
};

/**
 * Evidence fragments worth hunting for in the body: quoted "..." / «...»
 * pieces first, then the whole evidence line. Short fragments are dropped —
 * a 3-char substring match highlights noise, not evidence.
 */
function evidenceFragments(claims) {
  const out = [];
  const push = (s) => {
    const t = String(s).trim();
    if (t.length >= 4 && !out.includes(t)) out.push(t);
  };
  for (const claim of claims) {
    const v = claim.live;
    if (v === null || v.evidence === null || v.evidence === "") continue;
    for (const m of v.evidence.matchAll(/"([^"]+)"/g)) push(m[1]);
    for (const m of v.evidence.matchAll(/«([^»]+)»/g)) push(m[1]);
    push(v.evidence);
  }
  return out;
}

/**
 * Appends `text` to `target`, wrapping every fragment occurrence in a
 * <mark>. Case-sensitive match first; only when a fragment has no sensitive
 * hit in the remaining text does the insensitive pass run. No match → the
 * text passes through untouched (silent skip).
 */
function appendHighlighted(target, text, fragments) {
  let rest = text;
  while (rest.length > 0) {
    let best = null;
    for (const f of fragments) {
      let idx = rest.indexOf(f);
      if (idx === -1) idx = rest.toLowerCase().indexOf(f.toLowerCase());
      if (idx !== -1 && (best === null || idx < best.idx)) best = { idx, len: f.length };
    }
    if (best === null) break;
    if (best.idx > 0) target.appendChild(document.createTextNode(rest.slice(0, best.idx)));
    const mark = el("mark", "hl-ev", rest.slice(best.idx, best.idx + best.len));
    target.appendChild(mark);
    rest = rest.slice(best.idx + best.len);
  }
  if (rest.length > 0) target.appendChild(document.createTextNode(rest));
}

const DURUM_RE = /^\s*(?:[-*>]\s*)?(?:\*\*)?DURUM(?:\*\*)?\s*:/i;

function renderBody(body, fragments) {
  const node = el("div", "note-body");
  for (const line of body.split(/\r?\n/)) {
    const row = el("div", "note-line");
    if (DURUM_RE.test(line)) row.classList.add("note-line--durum");
    appendHighlighted(row, line, fragments);
    node.appendChild(row);
  }
  return node;
}

export function mount(root, ctx, findingId) {
  root.textContent = "";
  const wrap = el("div", "detail");
  root.appendChild(wrap);

  function renderMessage(text, showQueueLink) {
    wrap.textContent = "";
    wrap.classList.add("detail--message"); // single column: no ledger to lay out
    if (showQueueLink === true) {
      const link = el("a", "back-link", "← projelere dön");
      link.href = "#/";
      wrap.appendChild(link);
    }
    wrap.appendChild(el("div", "screen-message", text));
  }

  function renderHeader(d) {
    const header = el("div", "panel detail-header");
    const { fm, body } = splitNote(d.content);

    // The case label the mock stamps at the top of every page ("VAKA #003 ·
    // SAYFA 7"); uppercasing is the eyebrow rule's job, not this string's.
    header.appendChild(el("p", "eyebrow", `vaka #${d.id} · sicil sayfası`));

    // Title from frontmatter name (diagnosis already humanizes it); the raw
    // frontmatter block itself never renders — it hides behind "ham not".
    const title = d.diagnosis?.title !== "" && d.diagnosis?.title !== undefined
      ? d.diagnosis.title
      : `Not #${d.id}`;
    header.appendChild(el("h1", "detail-title", title));

    if (typeof fm["description"] === "string" && fm["description"] !== "") {
      header.appendChild(el("p", "detail-sub", fm["description"]));
    }

    header.appendChild(renderBody(body, evidenceFragments(d.claims)));

    const raw = document.createElement("details");
    raw.className = "tech-dump";
    const summary = document.createElement("summary");
    summary.textContent = "ham not";
    const pre = document.createElement("pre");
    pre.className = "detail-content";
    pre.textContent = d.content;
    raw.append(summary, pre);
    header.appendChild(raw);

    const meta = document.createElement("dl");
    meta.className = "detail-meta";
    const addMeta = (term, value) => {
      const dt = el("dt", "", term);
      const dd = el("dd", "", value);
      dd.dataset.mono = "";
      meta.append(dt, dd);
    };
    addMeta("kaynak", d.sourceRef ?? "—");
    addMeta("durum", d.status);
    addMeta("şüphe skoru", Number(d.suspicion).toFixed(2));
    addMeta("oluşturulma", localDate(d.createdAt));
    if (d.supersededBy !== null && d.supersededBy !== undefined) {
      addMeta("değiştirildi", `#${d.supersededBy}`);
    }
    header.appendChild(meta);

    return header;
  }

  // The diagnosis sentence as the right column's serif lede: the reason this
  // record is open, stated before the ledger's evidence.
  function renderDiagnosis(d) {
    if (d.diagnosis?.sentence === undefined || d.diagnosis.sentence === "") return null;
    const panel = el("div", "panel");
    panel.appendChild(el("p", "eyebrow", "tanı"));
    const lede = el("p", "detail-lede");
    renderSentence(lede, d.diagnosis.sentence);
    panel.appendChild(lede);
    return panel;
  }

  // Anchors as mono chips with health dots (tasarim-notu visual dictionary).
  function renderAnchors(anchors, drifted) {
    const section = el("div", "panel");
    section.appendChild(el("p", "eyebrow", "çapalar"));

    if (anchors.length === 0) {
      section.appendChild(el("p", "empty-note", "Çapa yok — bu not sürüklenme sinyali üretemez."));
      return section;
    }

    const list = el("div", "anchor-list");
    list.style.marginTop = "12px";
    for (const a of anchors) {
      // Sembol çapası ölçülmüyor; yeşil nokta "ölçüldü, temiz" demek olduğu için
      // sembol o noktayı alamaz.
      const untracked = a.kind === "symbol";
      const chip = anchorChip(a.value, untracked ? "untracked" : (drifted.has(a.value) ? "drift" : "ok"));
      chip.title = untracked
        ? `${a.kind} · izlenmez (görüntü amaçlı) · alındığı commit ${shortSha(a.takenAtCommit)}`
        : `${a.kind} · alındığı commit ${shortSha(a.takenAtCommit)}`;
      const sha = el("span", "anchor-sha", shortSha(a.takenAtCommit));
      chip.appendChild(sha);
      list.appendChild(chip);
    }
    section.appendChild(list);
    return section;
  }

  // key/value ledger line; prose=true sets the value in the editorial serif.
  function ledgerField(key, value, prose) {
    const p = el("p", "ledger-field");
    const k = el("span", "ledger-field__k", key);
    const v = el("span", prose === true ? "ledger-field__v ledger-field__v--prose" : "ledger-field__v", value);
    p.append(k, v);
    return p;
  }

  function renderVerdictBody(record) {
    const body = el("div", "ledger-body");

    if (record.subReason !== null && record.subReason !== "") {
      body.appendChild(ledgerField("alt sebep", record.subReason, false));
    }
    if (record.decayType !== null && record.decayType !== "") {
      body.appendChild(ledgerField("çürüme türü", record.decayType, false));
    }
    if (record.evidence !== null && record.evidence !== "") {
      body.appendChild(ledgerField("kanıt", record.evidence, true));
    }
    if (record.method !== null && record.method !== "") {
      body.appendChild(ledgerField("yöntem", record.method, false));
      const explainer = methodExplainer(record.method);
      if (explainer !== null) body.appendChild(el("p", "ledger-note", explainer));
    }
    return body;
  }

  // ALETİN TAVSİYESİ: the correction when the tool has one, else one honest
  // generic line per verdict — and nothing at all when it has neither.
  function renderAdvice(record) {
    const text = record.correction !== null && record.correction !== ""
      ? record.correction
      : ADVICE_BY_VERDICT[record.verdict];
    if (text === undefined) return null;
    const box = el("div", "advice");
    box.appendChild(el("p", "eyebrow", "aletin tavsiyesi"));
    box.appendChild(el("p", "", text));
    return box;
  }

  function renderLiveRecord(record) {
    const live = el("div", "ledger-live");

    const head = el("div", "ledger-live-head");
    head.appendChild(el("span", `badge badge--${record.verdict}`, verdictLabel(record.verdict)));
    if (record.repeatCount > 1) {
      const repeat = el("span", "ledger-repeat", `×${record.repeatCount} koşum aynı sonucu ölçtü`);
      repeat.dataset.mono = "";
      head.appendChild(repeat);
    }
    // The ledger is the place a past decision stays readable — and, since a
    // decision is reversible, the place it can be taken back. The card itself
    // is the animation target: the stamp lands on it, the basket throw crumples
    // it, and an undo un-crumples it back into the record.
    head.appendChild(reviewControls(record.id, undefined, record.review, { target: live }));
    live.appendChild(head);
    live.appendChild(renderVerdictBody(record));

    const advice = renderAdvice(record);
    if (advice !== null) live.appendChild(advice);

    return live;
  }

  function renderHistoryRecord(record) {
    const item = el("div", "ledger-old");

    const head = el("div", "ledger-old-head");
    head.appendChild(el("span", `badge badge--${record.verdict} ledger-old-label`, verdictLabel(record.verdict)));

    const supersededNote = el("span", "ledger-old-note");
    supersededNote.dataset.mono = "";
    const supersededBy = record.supersededBy !== null ? `#${record.supersededBy}` : "bilinmiyor";
    supersededNote.textContent = `#${record.id} — ${supersededBy} ile değiştirildi — ${localDate(record.createdAt)}`;
    head.appendChild(supersededNote);
    item.appendChild(head);
    item.appendChild(renderVerdictBody(record));

    return item;
  }

  function renderClaim(claim) {
    const card = el("div", "panel ledger");

    const title = el("p", "eyebrow",
      claim.claimRef === "" ? "iddia: not geneli" : `iddia: ${claim.claimRef}`);
    card.appendChild(title);

    if (claim.live !== null) {
      card.appendChild(renderLiveRecord(claim.live));
    } else {
      card.appendChild(el("p", "empty-note", "Bu iddia için canlı hüküm yok."));
    }

    const historical = claim.history.filter((v) => claim.live === null || v.id !== claim.live.id);
    if (historical.length > 0) {
      card.appendChild(el("p", "eyebrow ledger-hist-title", "tarihsel kayıtlar"));
      for (const record of historical) {
        card.appendChild(renderHistoryRecord(record));
      }
    }

    return card;
  }

  async function load() {
    try {
      const d = await ctx.apiGet(`/api/findings/${findingId}`);
      if (d.storeMissing === true) {
        renderMessage(
          `Depo bulunamadı: ${d.path} — \`context-police audit\` bir koşum sonra burayı doldurur.`,
          true,
        );
        return;
      }
      if (d.schemaOutdated === true) {
        renderMessage("Depo bu gezginden eski — `context-police audit` bir kez koşunca güncellenir.", true);
        return;
      }
      wrap.textContent = "";
      wrap.classList.remove("detail--message");
      const back = el("a", "back-link detail-back", "⟵ deftere dön");
      back.href = `#/proje/${d.projectId}`;
      wrap.appendChild(back);
      // Two-column ledger: note + anchors on the left; diagnosis, verdict
      // claims and advice on the right.
      const noteCol = el("div", "detail-col detail-col--note");
      const claimsCol = el("div", "detail-col detail-col--claims");

      noteCol.appendChild(renderHeader(d));
      noteCol.appendChild(renderAnchors(d.anchors, driftedValues(d.claims)));
      const diagnosisPanel = renderDiagnosis(d);
      if (diagnosisPanel !== null) claimsCol.appendChild(diagnosisPanel);
      if (d.claims.length === 0) {
        claimsCol.appendChild(el("p", "empty-note", "Bu not için hüküm kaydı yok."));
      } else {
        for (const claim of d.claims) {
          claimsCol.appendChild(renderClaim(claim));
        }
      }
      // entrance stagger indices, left column first then claims
      let seq = 0;
      for (const col of [noteCol, claimsCol]) {
        for (const panel of col.children) {
          panel.style.setProperty("--i", String(seq));
          seq += 1;
        }
      }
      wrap.append(noteCol, claimsCol);
    } catch (err) {
      if (err instanceof Error && /HTTP 404/.test(err.message)) {
        renderMessage("Bulgu bulunamadı.", true);
        return;
      }
      renderMessage(`Yükleme hatası: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  load();
  return { refresh: load };
}
