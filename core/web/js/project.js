// Proje raporu (diagnosis report): hero ring + one serif verdict sentence +
// band + sparkline, then "bakmanı isteyen N vaka" case cards, then quiet rows.
//
// /api/verdicts rows carry projectId, so the project filter costs no fetch.
// /api/findings/:id is still fetched for the cards that end up on screen —
// their anchors live only on the detail.

import {
  el, ring, band, bandKey, sparkline, meter, renderSentence, anchorChip,
  anchorlessChip, verdictLabel, relTime, daysSince, possessive, projectStatus, clickable,
  handleStoreStates, driftedValues, shortPath, COLORS, reviewControls,
} from "./ui.js";

// Sub-reasons that mean "still a candidate for the next classify rotation".
const CANDIDATE_SUB_REASONS = new Set(["rotation-starved", "classify-undecided", "classifier-not-run"]);

function verdictSentence(card) {
  const p = el("p", "report-sentence");
  const notes = card.notes;
  if (notes === 0) {
    p.textContent = "Bu projede henüz not yok.";
    return p;
  }
  if (card.pending > 0) {
    p.appendChild(document.createTextNode(
      `${notes} notun ${possessive(card.clean)} temiz görünüyor; `,
    ));
    p.appendChild(el("span", "warn",
      card.pending === 1 ? "1 hüküm onayını bekliyor" : `${card.pending} hüküm onayını bekliyor`,
    ));
    p.appendChild(document.createTextNode("."));
    return p;
  }
  if (card.suspects > 0) {
    p.textContent = `${notes} notun ${possessive(card.clean)} temiz; ${card.suspects} şüpheli izleniyor.`;
    return p;
  }
  // "tamamı" sidesteps the da/de vowel-harmony clitic a numeral would need.
  if (projectStatus(card).kind === "idle") {
    const days = daysSince(card.lastRunAt);
    p.textContent = days === null
      ? `${notes} notun tamamı yerinde; henüz koşum görmedi.`
      : `${notes} notun tamamı yerinde; ${Math.round(days)} gündür kıpırtı yok — uykuda, ölü değil.`;
    return p;
  }
  p.textContent = `Defter temiz: ${notes} notun tamamı yerinde.`;
  return p;
}

function caseCard(rows, detail, i, navigate, onDecision) {
  const row = rows[0]; // highest-suspicion pending row speaks for the finding
  const node = el("article", `case-card case-card--${row.verdict}`);
  node.style.setProperty("--i", String(i)); // entrance stagger index
  clickable(node, () => navigate(`#/finding/${row.findingId}`));

  const top = el("div", "case-top");
  const title = row.diagnosis?.title !== "" && row.diagnosis?.title !== undefined
    ? row.diagnosis.title
    : `Not #${row.findingId}`;
  top.appendChild(el("span", "case-title", title));
  top.appendChild(el("span", `badge badge--${row.verdict}`, verdictLabel(row.verdict)));
  if (rows.length > 1) {
    top.appendChild(el("span", "badge badge--repeat", `+${rows.length - 1} iddia daha`));
  }
  // Deciding the case decides all of its grouped verdicts.
  top.appendChild(reviewControls(rows.map((r) => r.id), onDecision));
  node.appendChild(top);

  const sentence = el("p", "case-sentence");
  renderSentence(sentence, row.diagnosis?.sentence ?? "");
  node.appendChild(sentence);

  const metaRow = el("div", "case-meta");
  for (const part of meter(row.suspicion)) metaRow.appendChild(part);
  metaRow.appendChild(el("span", "sep", "·"));
  const anchors = detail?.anchors ?? [];
  if (anchors.length === 0) {
    metaRow.appendChild(anchorlessChip());
  } else {
    const drifted = driftedValues(detail?.claims ?? []);
    const shown = anchors.slice(0, 3);
    for (const a of shown) {
      metaRow.appendChild(anchorChip(a.value, drifted.has(a.value) ? "drift" : "ok"));
    }
    if (anchors.length > shown.length) {
      metaRow.appendChild(el("span", "sep", `+${anchors.length - shown.length} çapa`));
    }
  }
  node.appendChild(metaRow);
  return node;
}

export function mount(root, ctx, projectId) {
  root.textContent = "";
  const wrap = el("div", "report");
  const back = el("a", "back-link", "← projeler");
  back.href = "#/";
  root.append(back, wrap);
  let loadSeq = 0;
  // Set by renderHero when a progress bar exists; case-card decisions call it.
  let updateProgress = () => {};
  // Verdicts decided during THIS render. Reset per load because the server
  // stops listing them as pending, so the next load recomputes from scratch.
  let decidedIds = new Set();

  function showMessage(text) {
    wrap.textContent = "";
    wrap.appendChild(el("div", "screen-message", text));
  }

  function renderHero(card, pendingIds) {
    const hero = el("div", "report-hero");
    const status = projectStatus(card);

    const ringWrap = el("div");
    const ringColor = card.pending > 0 ? COLORS.amber : COLORS.green;
    ringWrap.appendChild(ring(card.healthPct, ringColor, { size: 108, faded: status.kind === "idle" }));
    ringWrap.appendChild(el("div", "ring-caption", `${card.clean}/${card.notes} not temiz`));
    hero.appendChild(ringWrap);

    const main = el("div", "report-hero-main");
    const nameRow = el("div", "report-name");
    nameRow.appendChild(el("span", "pname", card.name));
    nameRow.appendChild(el("span", "ppath", shortPath(card.path)));
    nameRow.appendChild(el("span", `status status--${status.kind}`, status.label));
    main.appendChild(nameRow);
    main.appendChild(verdictSentence(card));
    // Same segment set as the legend below it: a legend entry without a band
    // segment reads as a lie (round-1 critique).
    main.appendChild(band([
      { n: card.clean, color: COLORS.green },
      { n: card.suspects, color: COLORS.violetHi },
      { n: card.pending, color: COLORS.amber },
    ], true));
    main.appendChild(bandKey([
      { n: card.clean, color: COLORS.green, label: `${card.clean} temiz not` },
      { n: card.suspects, color: COLORS.violetHi, label: `${card.suspects} şüpheli` },
      { n: card.pending, color: COLORS.amber, label: `${card.pending} onay bekliyor` },
    ]));

    const spark = el("div", "spark report-since");
    const line = status.kind === "wait"
      ? { stroke: COLORS.violetDim, dot: COLORS.violet }
      : status.kind === "ok"
        ? { stroke: COLORS.greenDim, dot: COLORS.green }
        : { stroke: COLORS.idleLine };
    spark.appendChild(sparkline(card.runSeries, line));
    const since = el("span");
    since.dataset.mono = "";
    since.textContent = card.lastRunAt === null
      ? "henüz koşum yok"
      : `son koşum ${relTime(card.lastRunAt)} · ${card.runSeries.length} koşum kayıtlı`;
    spark.appendChild(since);
    main.appendChild(spark);

    // Review progress: green = decided, amber remainder = still waiting.
    if (pendingIds.length > 0) {
      const prog = el("div", "progress");
      const label = el("span", "progress-label");
      const track = el("div", "progress-track");
      const fill = el("i");
      track.appendChild(fill);
      updateProgress = () => {
        const done = pendingIds.filter((id) => decidedIds.has(id)).length;
        label.textContent = done === 0
          ? (pendingIds.length === 1
            ? "1 hüküm karar bekliyor"
            : `${pendingIds.length} hüküm karar bekliyor`)
          : `${pendingIds.length} hükümden ${possessive(done)} işlendi`;
        fill.style.width = `${Math.round((100 * done) / pendingIds.length)}%`;
      };
      updateProgress();
      prog.append(label, track);
      main.appendChild(prog);
    } else {
      updateProgress = () => {};
    }

    hero.appendChild(main);
    return hero;
  }

  function renderCases(pendingRows, details) {
    const frag = document.createDocumentFragment();
    // One card per finding: the highest-suspicion pending row speaks for it.
    const byFinding = new Map();
    for (const row of pendingRows) {
      const list = byFinding.get(row.findingId) ?? [];
      list.push(row);
      byFinding.set(row.findingId, list);
    }
    const groups = [...byFinding.values()]
      .map((rows) => rows.sort((a, b) => b.suspicion - a.suspicion))
      .sort((a, b) => b[0].suspicion - a[0].suspicion);

    if (groups.length === 0) {
      frag.appendChild(el("p", "empty-note", "Bakmanı isteyen vaka yok — kuyruk boş."));
      return frag;
    }
    const head = el("div", "case-head");
    head.appendChild(el("p", "eyebrow", `Bakmanı isteyen ${groups.length} vaka`));
    frag.appendChild(head);

    const list = el("div", "case-list");
    groups.forEach((rows, i) => {
      const onDecision = (ids) => {
        for (const id of ids) decidedIds.add(id);
        updateProgress();
      };
      list.appendChild(caseCard(rows, details.get(rows[0].findingId), i, ctx.navigate, onDecision));
    });
    frag.appendChild(list);
    return frag;
  }

  function renderQuiet(card, candidateCount) {
    const quiet = el("div", "quiet");
    if (card.clean > 0) {
      const row = el("div", "quiet-row");
      const squares = el("span", "squares");
      for (let i = 0; i < Math.min(card.clean, 40); i += 1) squares.appendChild(el("i"));
      row.appendChild(squares);
      row.appendChild(el("span", "", `${card.clean} not temiz`));
      quiet.appendChild(row);
    }
    if (candidateCount > 0) {
      quiet.appendChild(el("div", "quiet-row",
        candidateCount === 1 ? "1 aday sıradaki koşumda" : `${candidateCount} aday sıradaki koşumda`,
      ));
    }
    return quiet;
  }

  async function load() {
    const seq = ++loadSeq;
    try {
      const [cards, pendingAll, unmeasuredAll] = await Promise.all([
        ctx.apiGet("/api/projects"),
        ctx.apiGet("/api/verdicts?review=pending"),
        ctx.apiGet("/api/verdicts?verdict=olculemez"),
      ]);
      if (seq !== loadSeq) return;
      if (!Array.isArray(cards)) {
        if (handleStoreStates(cards, showMessage)) return;
        showMessage("Beklenmeyen cevap.");
        return;
      }
      const card = cards.find((c) => c.id === projectId);
      if (card === undefined) {
        showMessage("Proje bulunamadı.");
        return;
      }
      const pendingRows = Array.isArray(pendingAll) ? pendingAll : [];
      const unmeasuredRows = Array.isArray(unmeasuredAll) ? unmeasuredAll : [];

      const mine = (r) => r.projectId === projectId;
      const myPending = pendingRows.filter(mine);
      const pendingFindings = new Set(myPending.map((r) => r.findingId));
      const candidateCount = new Set(
        unmeasuredRows
          .filter((r) => mine(r)
            && CANDIDATE_SUB_REASONS.has(r.subReason ?? "")
            && !pendingFindings.has(r.findingId))
          .map((r) => r.findingId),
      ).size;

      // Anchors are detail-only, so the case cards still need one fetch each —
      // but only for the findings that actually get a card.
      const details = new Map();
      await Promise.all([...pendingFindings].map(async (id) => {
        try {
          details.set(id, await ctx.apiGet(`/api/findings/${id}`));
        } catch {
          /* a missing detail only costs that card its anchor chips */
        }
      }));
      if (seq !== loadSeq) return;

      wrap.textContent = "";
      decidedIds = new Set();
      wrap.appendChild(renderHero(card, myPending.map((r) => r.id)));
      wrap.appendChild(renderCases(myPending, details));
      wrap.appendChild(renderQuiet(card, candidateCount));
    } catch (err) {
      if (seq !== loadSeq) return;
      showMessage(`Yükleme hatası: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load();
  return { refresh: load };
}
