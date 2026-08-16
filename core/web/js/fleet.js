// Giriş (fleet) screen — mock-giris-v5.html is the binding layout: one serif
// hero sentence + overall band, then a grid of project health cards.

import {
  el, ring, band, bandKey, sparkline, relTime, daysSince, possessive,
  projectStatus, clickable, handleStoreStates, shortPath, COLORS,
} from "./ui.js";

// Hero sentence, composed from the cards. Amber only when pending > 0.
function heroSentence(cards) {
  const h2 = el("p", "h2");
  const pendingCards = cards.filter((c) => c.pending > 0);
  const totalPending = pendingCards.reduce((s, c) => s + c.pending, 0);
  const n = cards.length;
  h2.appendChild(document.createTextNode(n === 1 ? "1 proje izleniyor. " : `${n} proje izleniyor. `));

  if (pendingCards.length === 0) {
    h2.appendChild(document.createTextNode(
      n === 1 ? "Şu an her şey sağlıklı." : "Hepsi sağlıklı.",
    ));
    return h2;
  }

  // Small counts spelled out, as in the approved mock ("İkisi sağlıklı").
  const SPELLED = ["", "biri", "ikisi", "üçü", "dördü", "beşi", "altısı", "yedisi", "sekizi", "dokuzu"];
  const healthy = n - pendingCards.length;
  if (n > 1 && healthy > 0) {
    const word = healthy < SPELLED.length ? SPELLED[healthy] : possessive(healthy);
    // toLocaleUpperCase: plain toUpperCase turns "ikisi" into "Ikisi" (dotless I).
    h2.appendChild(document.createTextNode(
      `${word.charAt(0).toLocaleUpperCase("tr-TR")}${word.slice(1)} sağlıklı; `,
    ));
  }
  if (pendingCards.length === 1) {
    const em = el("em", "", pendingCards[0].name);
    h2.append(em, document.createTextNode(" projesinde "));
  } else {
    h2.appendChild(document.createTextNode(`${pendingCards.length} projede toplam `));
  }
  h2.appendChild(el("span", "warn", `${totalPending} onay bekliyor`));
  h2.appendChild(document.createTextNode("."));
  return h2;
}

function projectCard(card, i, navigate) {
  const status = projectStatus(card);
  const node = el("article", "pcard");
  node.style.setProperty("--i", String(i)); // entrance stagger index
  clickable(node, () => navigate(`#/proje/${card.id}`));

  const top = el("div", "ptop");
  const names = el("div");
  names.appendChild(el("div", "pname", card.name));
  names.appendChild(el("div", "ppath", shortPath(card.path)));
  top.appendChild(names);
  top.appendChild(el("span", `status status--${status.kind}`, status.label));
  node.appendChild(top);

  const body = el("div", "pbody");
  const ringColor = card.pending > 0 ? COLORS.amber : COLORS.green;
  body.appendChild(ring(card.healthPct, ringColor, { faded: status.kind === "idle" }));

  const stats = el("div", "pstats");
  stats.appendChild(band([
    { n: card.clean, color: COLORS.green },
    { n: card.suspects, color: COLORS.violetHi },
  ]));

  const counts = el("div", "prow");
  const count = (n, label) => {
    const s = el("span");
    s.append(el("b", "", String(n)), document.createTextNode(` ${label}`));
    return s;
  };
  counts.appendChild(count(card.notes, "not"));
  counts.appendChild(count(card.suspects, "şüpheli"));
  if (card.anchorless > 0) counts.appendChild(count(card.anchorless, "çapasız"));
  stats.appendChild(counts);

  const spark = el("div", "prow spark");
  const line = status.kind === "wait"
    ? { stroke: COLORS.violetDim, dot: COLORS.violet }
    : status.kind === "ok"
      ? { stroke: COLORS.greenDim, dot: COLORS.green }
      : { stroke: COLORS.idleLine };
  spark.appendChild(sparkline(card.runSeries, line));
  if (status.kind === "idle") {
    const days = daysSince(card.lastRunAt);
    spark.appendChild(el("span", "", days === null
      ? "henüz kıpırtı yok"
      : `${Math.round(days)} gündür kıpırtı yok — uykuda, ölü değil`));
  } else {
    spark.appendChild(el("span", "", `son koşum ${relTime(card.lastRunAt)}`));
  }
  stats.appendChild(spark);

  body.appendChild(stats);
  node.appendChild(body);

  const foot = el("div", "pfoot");
  foot.appendChild(el("span", "",
    card.runSeries.length === 0 ? "henüz koşum yok" : `${card.runSeries.length} koşum kayıtlı`,
  ));
  foot.appendChild(el("span", "go", "rapora git →"));
  node.appendChild(foot);

  return node;
}

export function mount(root, ctx) {
  root.textContent = "";
  const wrap = el("div", "fleet");
  root.appendChild(wrap);

  function showMessage(text) {
    wrap.textContent = "";
    wrap.appendChild(el("div", "screen-message", text));
  }

  function render(cards) {
    wrap.textContent = "";

    const hero = el("div", "fleet-hero");
    if (cards.length === 0) {
      showMessage("Henüz izlenen proje yok — `context-police audit` ilk kartı açar.");
      return;
    }
    hero.appendChild(heroSentence(cards));

    const clean = cards.reduce((s, c) => s + c.clean, 0);
    const suspects = cards.reduce((s, c) => s + c.suspects, 0);
    const pending = cards.reduce((s, c) => s + c.pending, 0);
    hero.appendChild(band([
      { n: clean, color: COLORS.green },
      { n: suspects, color: COLORS.violetHi },
      { n: pending, color: COLORS.amber },
    ], true));
    hero.appendChild(bandKey([
      { n: clean, color: COLORS.green, label: `${clean} temiz not` },
      { n: suspects, color: COLORS.violetHi, label: `${suspects} şüpheli` },
      { n: pending, color: COLORS.amber, label: `${pending} onay bekliyor` },
    ]));
    wrap.appendChild(hero);

    const grid = el("div", "fleet-grid");
    cards.forEach((card, i) => grid.appendChild(projectCard(card, i, ctx.navigate)));
    wrap.appendChild(grid);
  }

  async function load() {
    try {
      const cards = await ctx.apiGet("/api/projects");
      if (!Array.isArray(cards)) {
        if (handleStoreStates(cards, showMessage)) return;
        showMessage("Beklenmeyen cevap.");
        return;
      }
      render(cards);
    } catch (err) {
      showMessage(`Yükleme hatası: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load();
  return { refresh: load };
}
