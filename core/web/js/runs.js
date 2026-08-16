// Koşumlar screen: each run is a narrative card — one serif headline sentence
// composed from the numbers, a small checked→suspects/cleared band, stat chips
// for the non-zero noteworthy fields, and the raw key-value dump collapsed
// behind "teknik döküm". The owner's critique of the raw table ("buradan ne
// anlamam gerek") is the reason the sentence comes first.

import { el, band, possessive, COLORS } from "./ui.js";

function localDate(iso) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
}

function formatValue(v) {
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Numeric detail field, defensively: broken/absent values read as 0. */
function num(detail, key) {
  const v = detail[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// One sentence from the run's numbers; zeros get their natural phrasing
// instead of "0'ı şüphe topladı".
function runSentence(detail) {
  const checked = num(detail, "checked");
  const suspects = num(detail, "suspects");
  const verdicts = num(detail, "verdictsRecorded");
  if (checked === 0) return "Bu koşumda hiç not taranmadı.";
  const suspectPart = suspects === 0
    ? "hiçbir şüphe çıkmadı"
    : `${possessive(suspects)} şüphe topladı`;
  const verdictPart = verdicts === 0
    ? "yeni hüküm yazılmadı"
    : `${verdicts} hüküm yazıldı`;
  return `${checked} not tarandı — ${suspectPart}, ${verdictPart}.`;
}

// [label, detail key(s)] chips — only rendered when the count is non-zero.
const INFO_CHIPS = [
  ["classifyCalls", (n) => `${n} codex çağrısı`],
  ["classifyUnclassified", (n) => `${n} aday sığmadı`],
];
const WARN_CHIPS = [
  ["measurementFailures", (n) => `${n} ölçüm arızası`],
  ["importErrors", (n) => `${n} içe aktarma hatası`],
];

function runChips(detail) {
  const row = el("div", "run-chips");
  for (const [key, label] of INFO_CHIPS) {
    const n = num(detail, key);
    if (n > 0) row.appendChild(el("span", "run-chip", label(n)));
  }
  for (const [key, label] of WARN_CHIPS) {
    const n = num(detail, key);
    if (n > 0) row.appendChild(el("span", "run-chip run-chip--warn", label(n)));
  }
  if (detail["fetchFailed"] === true) {
    row.appendChild(el("span", "run-chip run-chip--warn", "fetch arızalandı — origin bayat olabilir"));
  }
  return row;
}

function techDump(detail) {
  const details = document.createElement("details");
  details.className = "tech-dump";
  const summary = document.createElement("summary");
  summary.textContent = "teknik döküm";
  details.appendChild(summary);
  const table = document.createElement("table");
  table.className = "queue-table";
  const tbody = document.createElement("tbody");
  for (const [key, value] of Object.entries(detail)) {
    const tr = document.createElement("tr");
    const k = el("td");
    k.dataset.mono = "";
    k.textContent = key;
    const v = el("td");
    v.dataset.mono = "";
    v.textContent = formatValue(value);
    tr.append(k, v);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  details.appendChild(table);
  return details;
}

function runCard(run, i) {
  const card = el("div", "panel run-card");
  card.style.setProperty("--i", String(i)); // entrance stagger index

  if (run.detail === null) {
    card.appendChild(el("p", "empty-note", "detay çözülemedi (bozuk JSON)"));
    const stamp = el("p", "run-id");
    stamp.dataset.mono = "";
    stamp.textContent = localDate(run.at);
    card.appendChild(stamp);
    return card;
  }
  const d = run.detail;

  const sentence = el("p", "run-sentence", runSentence(d));
  card.appendChild(sentence);

  const checked = num(d, "checked");
  const suspects = num(d, "suspects");
  const cleared = num(d, "cleared");
  if (checked > 0) {
    // checked → suspects/cleared; the untouched remainder stays quiet gray.
    card.appendChild(band([
      { n: suspects, color: COLORS.violetHi },
      { n: cleared, color: COLORS.green },
      { n: Math.max(0, checked - suspects - cleared), color: COLORS.idleLine },
    ]));
  }

  const chips = runChips(d);
  if (chips.childElementCount > 0) card.appendChild(chips);

  const stamp = el("p", "run-id");
  stamp.dataset.mono = "";
  const runId = typeof d["runId"] === "string" ? d["runId"] : "";
  stamp.textContent = runId === "" ? localDate(run.at) : `${localDate(run.at)} · ${runId}`;
  card.appendChild(stamp);

  if (Object.keys(d).length > 0) card.appendChild(techDump(d));
  return card;
}

export function mount(root, ctx) {
  const state = { kindFilter: "" };

  root.textContent = "";
  const wrap = el("div", "runs");
  root.appendChild(wrap);

  const message = el("div", "screen-message");
  message.hidden = true;
  wrap.appendChild(message);

  const runsSection = el("div", "runs-list");

  // "diğer olaylar" stays reachable but visually quieter than the run cards.
  const eventsSection = el("div", "panel panel--quiet");
  const eventsTitle = el("p", "eyebrow", "diğer olaylar");
  const filterLabel = document.createElement("label");
  filterLabel.className = "filter-field";
  const filterEyebrow = el("span", "eyebrow", "kind filtrele");
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "olay türü içerir…";
  filterLabel.append(filterEyebrow, filterInput);
  const eventsList = el("div", "table-wrap");
  eventsSection.append(eventsTitle, filterLabel, eventsList);

  let lastEvents = [];
  filterInput.addEventListener("input", () => {
    state.kindFilter = filterInput.value.trim().toLowerCase();
    renderEvents(lastEvents);
  });

  function showMessage(text) {
    message.textContent = text;
    message.hidden = false;
    runsSection.hidden = true;
    eventsSection.hidden = true;
  }

  function hideMessage() {
    message.hidden = true;
    runsSection.hidden = false;
    eventsSection.hidden = false;
  }

  function renderRuns(runs) {
    runsSection.textContent = "";
    if (runs.length === 0) {
      runsSection.appendChild(
        el("p", "empty-note", "Henüz koşum yok — `context-police audit` ilk satırı yazar."),
      );
      return;
    }
    runs.forEach((run, i) => runsSection.appendChild(runCard(run, i)));
  }

  function renderEvents(events) {
    lastEvents = events;
    const filtered =
      state.kindFilter === ""
        ? events
        : events.filter((e) => e.kind.toLowerCase().includes(state.kindFilter));

    eventsList.textContent = "";
    if (filtered.length === 0) {
      eventsList.appendChild(el("p", "empty-note", "Olay yok."));
      return;
    }
    const table = document.createElement("table");
    table.className = "queue-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of ["id", "tarih", "tür"]) {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const e of filtered) {
      const tr = document.createElement("tr");
      const id = el("td");
      id.dataset.mono = "";
      id.textContent = String(e.id);
      const at = el("td");
      at.dataset.mono = "";
      at.textContent = localDate(e.at);
      const kind = el("td");
      kind.dataset.mono = "";
      kind.textContent = e.kind;
      tr.append(id, at, kind);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    eventsList.appendChild(table);
  }

  wrap.append(runsSection, eventsSection);

  async function load() {
    try {
      const data = await ctx.apiGet("/api/runs");
      if (data.storeMissing === true) {
        showMessage(
          `Depo bulunamadı: ${data.path} — \`context-police audit\` bir koşum sonra burayı doldurur.`,
        );
        return;
      }
      if (data.schemaOutdated === true) {
        showMessage("Depo bu gezginden eski — `context-police audit` bir kez koşunca güncellenir.");
        return;
      }
      hideMessage();
      renderRuns(data.runs);
      renderEvents(data.events);
    } catch (err) {
      showMessage(`Yükleme hatası: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load();
  return { refresh: load };
}
