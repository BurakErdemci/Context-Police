const VERDICTS = ["gecerli", "curuk", "dogustan-yanlis", "olculemez", "tarihsel"];
const SOURCES = ["mechanical", "adjudicator"];
const REVIEWS = ["pending", "approved", "rejected"];

export function mount(root, ctx) {
  const state = { verdict: "", subReason: "", source: "", review: "" };

  root.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "queue";

  const strip = document.createElement("div");
  strip.className = "verdict-strip";
  const stripButtons = new Map();
  for (const v of VERDICTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `verdict-count verdict-count--${v}`;
    const count = document.createElement("span");
    count.className = "verdict-count__n";
    count.dataset.mono = "";
    count.textContent = "–";
    const label = document.createElement("span");
    label.className = "verdict-count__label";
    label.textContent = v;
    btn.append(count, label);
    btn.addEventListener("click", () => {
      state.verdict = state.verdict === v ? "" : v;
      verdictSelect.value = state.verdict;
      syncStripActive();
      load();
    });
    strip.appendChild(btn);
    stripButtons.set(v, { btn, count });
  }

  function syncStripActive() {
    for (const [v, { btn }] of stripButtons) {
      btn.classList.toggle("is-active", state.verdict === v);
    }
  }

  const filters = document.createElement("div");
  filters.className = "filter-bar";

  const verdictSelect = makeSelect("hüküm", ["", ...VERDICTS], (val) => {
    state.verdict = val;
    syncStripActive();
    load();
  });
  const sourceSelect = makeSelect("kaynak", ["", ...SOURCES], (val) => {
    state.source = val;
    load();
  });
  const reviewSelect = makeSelect("gözden geçirme", ["", ...REVIEWS], (val) => {
    state.review = val;
    load();
  });

  const subReasonLabel = document.createElement("label");
  subReasonLabel.className = "filter-field";
  const subReasonEyebrow = document.createElement("span");
  subReasonEyebrow.className = "eyebrow";
  subReasonEyebrow.textContent = "alt sebep";
  const subReasonInput = document.createElement("input");
  subReasonInput.type = "text";
  subReasonInput.placeholder = "alt sebep içerir…";
  let debounceTimer = null;
  subReasonInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.subReason = subReasonInput.value.trim();
      load();
    }, 250);
  });
  subReasonLabel.append(subReasonEyebrow, subReasonInput);

  filters.append(verdictSelect.el, sourceSelect.el, reviewSelect.el, subReasonLabel);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";

  const message = document.createElement("div");
  message.className = "screen-message";
  message.hidden = true;

  wrap.append(strip, filters, message, tableWrap);
  root.appendChild(wrap);

  function makeSelect(labelText, options, onChange) {
    const label = document.createElement("label");
    label.className = "filter-field";
    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = labelText;
    const select = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt === "" ? "hepsi" : opt;
      select.appendChild(o);
    }
    select.addEventListener("change", () => onChange(select.value));
    label.append(eyebrow, select);
    return { el: label, select };
  }

  function showMessage(text) {
    message.textContent = text;
    message.hidden = false;
    tableWrap.textContent = "";
  }

  function hideMessage() {
    message.hidden = true;
  }

  function renderCounts(counts) {
    for (const [v, { count }] of stripButtons) {
      count.textContent = String(counts?.[v] ?? 0);
    }
  }

  function shortDate(iso) {
    if (typeof iso !== "string") return "";
    return iso.slice(0, 10);
  }

  function renderTable(rows) {
    tableWrap.textContent = "";
    if (rows.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-note";
      p.textContent = "Bu filtrede hüküm yok.";
      tableWrap.appendChild(p);
      return;
    }
    const table = document.createElement("table");
    table.className = "queue-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of ["skor", "not", "iddia", "hüküm", "alt sebep", "tekrar", "kaynak", "tarih"]) {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      tr.className = "queue-row";

      const score = document.createElement("td");
      score.dataset.mono = "";
      score.textContent = Number(row.suspicion).toFixed(2);

      const preview = document.createElement("td");
      preview.className = "cell-preview";
      preview.textContent = row.preview;

      const claim = document.createElement("td");
      claim.dataset.mono = "";
      claim.textContent = row.claimRef === "" ? "not geneli" : row.claimRef;

      const verdict = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `badge badge--${row.verdict}`;
      badge.textContent = row.verdict;
      verdict.appendChild(badge);

      const subReason = document.createElement("td");
      subReason.textContent = row.subReason ?? "";

      const repeat = document.createElement("td");
      if (row.repeatCount > 1) {
        const rbadge = document.createElement("span");
        rbadge.className = "badge badge--repeat";
        rbadge.dataset.mono = "";
        rbadge.textContent = `×${row.repeatCount}`;
        repeat.appendChild(rbadge);
      }

      const source = document.createElement("td");
      source.textContent = row.source;

      const date = document.createElement("td");
      date.dataset.mono = "";
      date.textContent = shortDate(row.createdAt);

      tr.append(score, preview, claim, verdict, subReason, repeat, source, date);

      const goto = () => ctx.navigate(`#/finding/${row.findingId}`);
      tr.addEventListener("click", goto);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          goto();
        }
      });

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  function buildQuery() {
    const params = new URLSearchParams();
    if (state.verdict !== "") params.set("verdict", state.verdict);
    if (state.subReason !== "") params.set("subReason", state.subReason);
    if (state.source !== "") params.set("source", state.source);
    if (state.review !== "") params.set("review", state.review);
    const qs = params.toString();
    return qs === "" ? "" : `?${qs}`;
  }

  async function load() {
    try {
      const [summary, rows] = await Promise.all([
        ctx.apiGet("/api/summary"),
        ctx.apiGet(`/api/verdicts${buildQuery()}`),
      ]);
      if (summary.storeMissing === true) {
        showMessage(
          `Depo bulunamadı: ${summary.path} — \`context-police audit\` bir koşum sonra burayı doldurur.`,
        );
        return;
      }
      if (summary.schemaOutdated === true) {
        showMessage("Depo bu gezginden eski — `context-police audit` bir kez koşunca güncellenir.");
        return;
      }
      if (rows.storeMissing === true || rows.schemaOutdated === true) {
        showMessage("Depo bu gezginden eski — `context-police audit` bir kez koşunca güncellenir.");
        return;
      }
      hideMessage();
      renderCounts(summary.counts);
      renderTable(rows);
    } catch (err) {
      showMessage(`Yükleme hatası: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  syncStripActive();
  load();

  return { refresh: load };
}
