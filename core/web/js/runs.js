function localDate(iso) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatValue(v) {
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function mount(root, ctx) {
  const state = { kindFilter: "" };

  root.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "runs";
  root.appendChild(wrap);

  const message = document.createElement("div");
  message.className = "screen-message";
  message.hidden = true;
  wrap.appendChild(message);

  const runsSection = document.createElement("div");
  runsSection.className = "runs-list";

  const eventsSection = document.createElement("div");
  eventsSection.className = "panel";
  const eventsTitle = document.createElement("p");
  eventsTitle.className = "eyebrow";
  eventsTitle.textContent = "diğer olaylar";
  const filterLabel = document.createElement("label");
  filterLabel.className = "filter-field";
  const filterEyebrow = document.createElement("span");
  filterEyebrow.className = "eyebrow";
  filterEyebrow.textContent = "kind filtrele";
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "olay türü içerir…";
  filterLabel.append(filterEyebrow, filterInput);
  const eventsList = document.createElement("div");
  eventsList.className = "table-wrap";
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
      const p = document.createElement("p");
      p.className = "empty-note";
      p.textContent = "Henüz koşum yok — `context-police audit` ilk satırı yazar.";
      runsSection.appendChild(p);
      return;
    }
    for (const run of runs) {
      const card = document.createElement("div");
      card.className = "panel run-card";

      const at = document.createElement("p");
      at.className = "eyebrow";
      at.textContent = localDate(run.at);
      card.appendChild(at);

      if (run.detail === null) {
        const broken = document.createElement("p");
        broken.className = "empty-note";
        broken.textContent = "detay çözülemedi (bozuk JSON)";
        card.appendChild(broken);
      } else {
        const entries = Object.entries(run.detail);
        if (entries.length === 0) {
          const empty = document.createElement("p");
          empty.className = "empty-note";
          empty.textContent = "detay boş";
          card.appendChild(empty);
        } else {
          const table = document.createElement("table");
          table.className = "queue-table";
          const tbody = document.createElement("tbody");
          for (const [key, value] of entries) {
            const tr = document.createElement("tr");
            const k = document.createElement("td");
            k.dataset.mono = "";
            k.textContent = key;
            const v = document.createElement("td");
            v.dataset.mono = "";
            v.textContent = formatValue(value);
            tr.append(k, v);
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          card.appendChild(table);
        }
      }

      runsSection.appendChild(card);
    }
  }

  function renderEvents(events) {
    lastEvents = events;
    const filtered =
      state.kindFilter === ""
        ? events
        : events.filter((e) => e.kind.toLowerCase().includes(state.kindFilter));

    eventsList.textContent = "";
    if (filtered.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-note";
      p.textContent = "Olay yok.";
      eventsList.appendChild(p);
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
      const id = document.createElement("td");
      id.dataset.mono = "";
      id.textContent = String(e.id);
      const at = document.createElement("td");
      at.dataset.mono = "";
      at.textContent = localDate(e.at);
      const kind = document.createElement("td");
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
