import { apiGet } from "./api.js";
import { mount as mountQueue } from "./queue.js";
import { mount as mountDetail } from "./detail.js";
import { mount as mountRuns } from "./runs.js";

// Route table: each entry's `mount(root, ctx, ...params)` is called with the
// route's regex capture groups after (root, ctx).
const ROUTES = [
  { pattern: /^#\/$/, mount: mountQueue },
  { pattern: /^#\/finding\/(\d+)$/, mount: (root, ctx, id) => mountDetail(root, ctx, Number(id)) },
  { pattern: /^#\/runs$/, mount: mountRuns },
];

const root = document.getElementById("root");
const storePathEl = document.getElementById("store-path");
const ctx = { apiGet, navigate };

let activeScreen = null;
let lastVersion = null;
let pollInFlight = false;

function navigate(hash) {
  if (location.hash !== hash) {
    location.hash = hash;
  } else {
    render();
  }
}

function currentRoute() {
  const hash = location.hash || "#/";
  for (const route of ROUTES) {
    const m = route.pattern.exec(hash);
    if (m !== null) return { mount: route.mount, params: m.slice(1) };
  }
  return null;
}

// Presentational only: mark the nav tab matching the current hash.
function syncTabs() {
  const hash = location.hash || "#/";
  for (const a of document.querySelectorAll(".tabs a")) {
    const target = a.getAttribute("href");
    const active = target === hash || (target === "#/" && hash.startsWith("#/finding/"));
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function render() {
  syncTabs();
  const route = currentRoute();
  if (route === null) {
    root.textContent = "";
    const p = document.createElement("p");
    p.textContent = "Bilinmeyen yol.";
    root.appendChild(p);
    activeScreen = null;
    return;
  }
  activeScreen = route.mount(root, ctx, ...route.params);
}

window.addEventListener("hashchange", render);

async function pollVersion() {
  // A slow fetch must not let ticks stack: skip this tick while one is
  // still outstanding rather than piling up concurrent /api/version calls.
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const v = await apiGet("/api/version");
    // Fold storeMissing/schemaOutdated into the key itself so a transition
    // between those states and a real version (or vice versa) is visible as
    // a key change too — an early return here used to skip the key update
    // entirely, so the first real version after "store appeared" only primed
    // the key and never triggered a refresh.
    const key = v.storeMissing === true
      ? "missing"
      : v.schemaOutdated === true
        ? "outdated"
        : `${v.maxVerdictId}:${v.maxEventId}`;
    if (lastVersion !== null && lastVersion !== key) {
      activeScreen?.refresh();
      loadSummaryForHeader();
    }
    lastVersion = key;
  } catch {
    // A transient poll failure is not worth surfacing: the next tick retries.
  } finally {
    pollInFlight = false;
  }
}

async function loadSummaryForHeader() {
  try {
    const s = await apiGet("/api/summary");
    if (s.storeMissing === true) {
      storePathEl.textContent = `depo bulunamadı: ${s.path}`;
      return;
    }
    if (s.schemaOutdated === true) {
      storePathEl.textContent = "depo şeması eski";
      return;
    }
    const proj = s.projects?.[0]?.path;
    storePathEl.textContent = proj ?? "";
  } catch {
    storePathEl.textContent = "";
  }
}

render();
loadSummaryForHeader();
setInterval(pollVersion, 3000);
