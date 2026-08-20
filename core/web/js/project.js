// Proje raporu ("VAKA DEFTERİ"): the report is a three-leaf notebook —
// cover → table of contents (health ring + verdict sentence + note rows) →
// case pages. Leaves rotate around their left edge; only the leaf state is new,
// the diagnosis wording and the data flow are unchanged.
//
// /api/verdicts rows carry projectId, so the project filter costs no fetch.
// /api/findings/:id is still fetched for the cards that end up on screen —
// their anchors live only on the detail.

import "./flip.js"; // importing registers the page-turn route transition

import {
  el, ring, band, bandKey, sparkline, meter, renderSentence, anchorChip,
  anchorlessChip, verdictLabel, relTime, daysSince, possessive, projectStatus, clickable,
  handleStoreStates, driftedValues, shortPath, COLORS, reviewControls,
} from "./ui.js";

// Sub-reasons that mean "still a candidate for the next classify rotation".
const CANDIDATE_SUB_REASONS = new Set(["rotation-starved", "classify-undecided", "classifier-not-run"]);

/** Like ui.js `clickable`, but for in-page controls: a button, not a link. */
function pressable(node, go) {
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.addEventListener("click", go);
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
}

/** One notebook leaf: a front face plus the blank reverse the turn reveals. */
function leaf(className, faceClass) {
  const node = el("div", `yaprak ${className}`);
  const face = el("div", `yuz ${faceClass}`);
  node.append(face, el("div", "yuz arka"));
  return { node, face };
}

/**
 * A written page: holes and margin rule belong to the sheet, the text to an
 * inner scroller. Separated because a page whose content overflows must scroll
 * its text without dragging the punch holes out of the sheet with it.
 */
function pageLeaf(className) {
  const { node, face } = leaf(className, "sayfa-yuz");
  for (const top of ["12%", "50%", "88%"]) {
    const hole = el("span", "delik");
    hole.style.top = top;
    face.appendChild(hole);
  }
  const body = el("div", "sayfa-ic");
  face.appendChild(body);
  return { node, face, body };
}

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
  // Deciding the case decides all of its grouped verdicts. `target` is the card
  // itself: the stamp/basket feedback plays on the record being decided.
  top.appendChild(reviewControls(rows.map((r) => r.id), onDecision, undefined, { target: node }));
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
  // Which leaves are turned. Kept OUTSIDE load() on purpose: the 3s version
  // poll re-renders the whole notebook, and a reader who had opened the cover
  // must not have it slam shut under them.
  let coverOpen = false;
  let casesOpen = false;
  // Reassigned every render; a no-op until the first one lands.
  let applyLeaves = () => {};
  // Set by the case leaf so a contents row can land on its own card.
  let scrollToCase = () => {};

  function showMessage(text) {
    wrap.textContent = "";
    wrap.appendChild(el("div", "screen-message", text));
  }

  function renderCover(card) {
    const { node, face } = leaf("yaprak--kapak", "kapak-yuz");
    const label = el("div", "kapak-etiket");
    label.appendChild(el("div", "ust", "ÇOK GİZLİ · DOSYA"));
    label.appendChild(el("h2", "", card.name));
    label.appendChild(el("div", "alt", shortPath(card.path)));
    face.appendChild(label);

    face.appendChild(el("div", "kapak-rozet",
      card.pending > 0
        ? (card.pending === 1 ? "1 onay bekliyor" : `${card.pending} onay bekliyor`)
        : `${card.notes} not izleniyor`,
    ));
    if (card.pending > 0) face.classList.add("kapak-yuz--acil");
    face.appendChild(el("div", "kapak-ipucu", "☞ açmak için tıkla"));

    pressable(face, () => {
      coverOpen = true;
      applyLeaves();
    });
    face.setAttribute("aria-label", `${card.name} defterini aç`);
    return node;
  }

  function renderHero(card, pendingIds, target) {
    const status = projectStatus(card);
    target.appendChild(el("span", "vaka-etiket", `DOSYA · ${card.notes} NOT`));

    const sentence = verdictSentence(card);
    sentence.classList.add("h-hand");
    target.appendChild(sentence);

    const top = el("div", "dosya-ust");
    const ringWrap = el("div");
    const ringColor = card.pending > 0 ? COLORS.amber : COLORS.green;
    ringWrap.appendChild(ring(card.healthPct, ringColor, { size: 96, faded: status.kind === "idle" }));
    ringWrap.appendChild(el("div", "ring-caption", `${card.clean}/${card.notes} not temiz`));
    top.appendChild(ringWrap);

    const main = el("div", "report-hero-main");
    const nameRow = el("div", "report-name");
    nameRow.appendChild(el("span", `status status--${status.kind}`, status.label));
    nameRow.appendChild(el("span", "ppath", shortPath(card.path)));
    main.appendChild(nameRow);
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
    top.appendChild(main);
    target.appendChild(top);

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
    target.appendChild(spark);

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
      target.appendChild(prog);
    } else {
      updateProgress = () => {};
    }
  }

  /** Contents rows: highlighted = wants a decision, faded = nothing to do. */
  function renderContents(groups, card, candidateCount, target) {
    const list = el("div", "icindekiler");
    groups.forEach((rows, i) => {
      const row = rows[0];
      const line = el("div", "satir-not sicak");
      line.appendChild(el("span", "carpi", "✗"));
      const title = row.diagnosis?.title !== "" && row.diagnosis?.title !== undefined
        ? row.diagnosis.title
        : `Not #${row.findingId}`;
      line.appendChild(el("span", "satir-ad", title));
      line.appendChild(el("small", "", `sf. ${i + 1} →`));
      pressable(line, () => {
        casesOpen = true;
        applyLeaves();
        scrollToCase(i);
      });
      list.appendChild(line);
    });

    if (card.clean > 0) {
      const line = el("div", "satir-not");
      line.appendChild(el("span", "tik", "✓"));
      line.appendChild(el("span", "satir-ad", `${card.clean} not temiz — dokunma`));
      line.appendChild(el("small", "", "sicilde"));
      list.appendChild(line);
    }
    if (candidateCount > 0) {
      const line = el("div", "satir-not");
      line.appendChild(el("span", "tik", "·"));
      line.appendChild(el("span", "satir-ad",
        candidateCount === 1 ? "1 aday sıradaki koşumda" : `${candidateCount} aday sıradaki koşumda`,
      ));
      line.appendChild(el("small", "", "ölçülmedi"));
      list.appendChild(line);
    }
    if (list.childElementCount === 0) {
      list.appendChild(el("p", "empty-note", "Bu defterde henüz kayıt yok."));
    }
    target.appendChild(list);
  }

  function renderContentsLeaf(card, groups, pendingIds, candidateCount) {
    const { node, body } = pageLeaf("yaprak--icindekiler");
    renderHero(card, pendingIds, body);
    renderContents(groups, card, candidateCount, body);

    const corners = el("div", "koseler");
    const close = el("span", "kose geri", "⟵ kapağı kapat");
    pressable(close, () => {
      coverOpen = false;
      applyLeaves();
    });
    corners.appendChild(close);
    if (groups.length > 0) {
      const go = el("span", "kose", "şüpheli vakaya git ➜");
      pressable(go, () => {
        casesOpen = true;
        applyLeaves();
        scrollToCase(0);
      });
      corners.appendChild(go);
    }
    body.appendChild(corners);
    return node;
  }

  function renderCasesLeaf(groups, details) {
    const { node, body } = pageLeaf("yaprak--vaka");
    body.appendChild(el("span", "vaka-etiket", "VAKALAR"));

    if (groups.length === 0) {
      body.appendChild(el("p", "empty-note", "Bakmanı isteyen vaka yok — kuyruk boş."));
      scrollToCase = () => {};
    } else {
      const head = el("div", "case-head");
      head.appendChild(el("p", "eyebrow", `Bakmanı isteyen ${groups.length} vaka`));
      body.appendChild(head);

      const list = el("div", "case-list");
      const cards = groups.map((rows, i) => {
        // An undo puts the case back on the counter; the progress line must not
        // keep claiming a decision the user just withdrew.
        const onDecision = (ids, decision) => {
          for (const id of ids) {
            if (decision === "pending") decidedIds.delete(id);
            else decidedIds.add(id);
          }
          updateProgress();
        };
        const cardNode = caseCard(rows, details.get(rows[0].findingId), i, ctx.navigate, onDecision);
        list.appendChild(cardNode);
        return cardNode;
      });
      body.appendChild(list);
      // Scrolls the page body, not the window: the leaf is position:absolute
      // and the document behind it does not move with it, so scrollIntoView
      // would drag the whole notebook off-screen instead.
      scrollToCase = (i) => {
        const target = cards[Math.min(i, cards.length - 1)];
        if (target === undefined) return;
        body.scrollTo({ top: Math.max(0, target.offsetTop - 24), behavior: "smooth" });
      };
    }

    const corners = el("div", "koseler");
    const backRow = el("span", "kose geri", "⟵ içindekilere dön");
    pressable(backRow, () => {
      casesOpen = false;
      applyLeaves();
    });
    corners.appendChild(backRow);
    body.appendChild(corners);
    return node;
  }

  function renderDefter(card, groups, details, pendingIds, candidateCount) {
    const stage = el("div", "defter-stage");
    const defter = el("div", "defter");
    // Bottom-to-top: the leaf turned last must sit under the ones above it.
    const vaka = renderCasesLeaf(groups, details);
    const contents = renderContentsLeaf(card, groups, pendingIds, candidateCount);
    const cover = renderCover(card);
    defter.append(vaka, contents, cover);
    stage.appendChild(defter);

    applyLeaves = () => {
      cover.classList.toggle("acik", coverOpen);
      contents.classList.toggle("acik", casesOpen);
    };
    applyLeaves();
    return stage;
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

      // One card per finding: the highest-suspicion pending row speaks for it.
      const byFinding = new Map();
      for (const row of myPending) {
        const list = byFinding.get(row.findingId) ?? [];
        list.push(row);
        byFinding.set(row.findingId, list);
      }
      const groups = [...byFinding.values()]
        .map((rows) => rows.sort((a, b) => b.suspicion - a.suspicion))
        .sort((a, b) => b[0].suspicion - a[0].suspicion);

      wrap.textContent = "";
      decidedIds = new Set();
      // Nothing left to look at behind the contents page: don't restore a leaf
      // state that would open onto an empty case page.
      if (groups.length === 0) casesOpen = false;
      wrap.appendChild(renderDefter(card, groups, details, myPending.map((r) => r.id), candidateCount));
    } catch (err) {
      if (seq !== loadSeq) return;
      showMessage(`Yükleme hatası: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load();
  return { refresh: load };
}
