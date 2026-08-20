// Giriş (fleet) screen — the detective's desk. Binding layout:
// docs/superpowers/specs/2026-08-17-vaka-defteri-maketi.html, section
// "DEDEKTİF MASASI": handwritten hero line over a wooden desk, a shelf of
// mini case notebooks (one per project), and post-its for the worst offenders.

import {
  el, relTime, possessive, verdictLabel,
  projectStatus, clickable, handleStoreStates, shortPath,
} from "./ui.js";

// How many post-its fit on the desk before it stops reading as a desk.
const POSTIT_LIMIT = 2;

// Hero sentence, composed from the cards. Highlighter yellow only when pending > 0.
function heroSentence(cards) {
  const h2 = el("div", "masa-baslik");
  const pendingCards = cards.filter((c) => c.pending > 0);
  const totalPending = pendingCards.reduce((s, c) => s + c.pending, 0);
  const n = cards.length;
  h2.appendChild(document.createTextNode(n === 1 ? "Masada 1 dosya var. " : `Masada ${n} dosya var. `));

  if (pendingCards.length === 0) {
    h2.appendChild(document.createTextNode(n === 1 ? "Sakin." : "Hepsi sakin."));
    return h2;
  }

  // Small counts spelled out, as in the approved mock ("İkisi sakin").
  const SPELLED = ["", "biri", "ikisi", "üçü", "dördü", "beşi", "altısı", "yedisi", "sekizi", "dokuzu"];
  const calm = n - pendingCards.length;
  if (n > 1 && calm > 0) {
    const word = calm < SPELLED.length ? SPELLED[calm] : possessive(calm);
    // toLocaleUpperCase: plain toUpperCase turns "ikisi" into "Ikisi" (dotless I).
    h2.appendChild(document.createTextNode(
      `${word.charAt(0).toLocaleUpperCase("tr-TR")}${word.slice(1)} sakin; `,
    ));
  }
  const warn = el("span", "warn");
  if (pendingCards.length === 1) {
    warn.appendChild(document.createTextNode(`${pendingCards[0].name}'te ${totalPending} onay bekliyor!!`));
  } else {
    warn.appendChild(document.createTextNode(
      `${pendingCards.length} projede toplam ${totalPending} onay bekliyor!!`,
    ));
  }
  h2.appendChild(warn);
  return h2;
}

const PUL = {
  wait: { cls: "acil", label: (card) => `${card.pending} ONAY BEKLİYOR` },
  ok: { cls: "tamam", label: () => "SAĞLIKLI ✓" },
  idle: { cls: "uyku", label: () => "uyuyor… zzz" },
};

function miniDefter(card, i, navigate) {
  const status = projectStatus(card);
  const node = el("article", `mini-defter mini-defter--${status.kind}`);
  node.style.setProperty("--i", String(i)); // entrance stagger index
  node.title = shortPath(card.path);
  clickable(node, () => navigate(`#/proje/${card.id}`));

  node.appendChild(el("span", "serit"));

  const etiket = el("div", "etiket");
  etiket.appendChild(el("b", "", card.name));
  etiket.appendChild(el("small", "", `${card.notes} not · %${Math.round(card.healthPct)}`));
  node.appendChild(etiket);

  const pul = PUL[status.kind] ?? PUL.ok;
  node.appendChild(el("span", `pul ${pul.cls}`, pul.label(card)));

  return node;
}

function postIt(row, navigate) {
  const node = el("article", "postit");
  clickable(node, () => navigate(`#/proje/${row.projectId}`));
  node.appendChild(el("span", "atas", "📎"));
  const title = row.diagnosis?.title !== "" && row.diagnosis?.title !== undefined
    ? row.diagnosis.title
    : row.preview;
  node.appendChild(document.createTextNode(`«${title}»`));
  node.appendChild(el("small", "", `${verdictLabel(row.verdict)} · ${Number(row.suspicion).toFixed(2)}`));
  return node;
}

// "son devriye … · N not izleniyor" — derived from the cards, no extra request.
function deskFooter(cards) {
  const notes = cards.reduce((s, c) => s + c.notes, 0);
  const last = cards
    .map((c) => c.lastRunAt)
    .filter((v) => typeof v === "string")
    .sort()
    .pop();
  const patrol = last === undefined ? "henüz devriye yok" : `son devriye ${relTime(last)}`;
  return el("div", "masa-alt", `${patrol} · ${notes} not izleniyor`);
}

export function mount(root, ctx) {
  root.textContent = "";
  const wrap = el("div", "fleet");
  root.appendChild(wrap);

  function showMessage(text) {
    wrap.textContent = "";
    wrap.appendChild(el("div", "screen-message", text));
  }

  function render(cards, pending) {
    wrap.textContent = "";
    if (cards.length === 0) {
      showMessage("Henüz izlenen proje yok — `context-police audit` ilk kartı açar.");
      return;
    }

    const masa = el("div", "masa");
    masa.appendChild(heroSentence(cards));
    masa.appendChild(deskFooter(cards));

    const raf = el("div", "raf");
    cards.forEach((card, i) => raf.appendChild(miniDefter(card, i, ctx.navigate)));
    masa.appendChild(raf);

    const postitler = el("div", "postitler");
    if (pending.length === 0) {
      postitler.appendChild(el("div", "postit-bos", "masa temiz — yapışkan not yok"));
    } else {
      for (const row of pending.slice(0, POSTIT_LIMIT)) {
        postitler.appendChild(postIt(row, ctx.navigate));
      }
    }
    masa.appendChild(postitler);

    wrap.appendChild(masa);
  }

  // Post-its are decoration over the desk, not the desk: a store state or a
  // failure here must not cost the user the project shelf, so it degrades to
  // the empty desk instead of propagating.
  async function loadPending() {
    try {
      const rows = await ctx.apiGet("/api/verdicts?review=pending");
      if (!Array.isArray(rows)) return [];
      return rows.slice().sort((a, b) => Number(b.suspicion) - Number(a.suspicion));
    } catch {
      return [];
    }
  }

  async function load() {
    try {
      const [cards, pending] = await Promise.all([ctx.apiGet("/api/projects"), loadPending()]);
      if (!Array.isArray(cards)) {
        if (handleStoreStates(cards, showMessage)) return;
        showMessage("Beklenmeyen cevap.");
        return;
      }
      render(cards, pending);
    } catch (err) {
      showMessage(`Yükleme hatası: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load();
  return { refresh: load };
}
