import { apiGet } from "./api.js";
import { mount as mountQueue } from "./queue.js";

// Route table: adding detail.js / runs.js later is a one-line entry here.
// Each entry's `mount(root, ctx, ...params)` is called with the route's
// regex capture groups after (root, ctx).
const ROUTES = [
  { pattern: /^#\/$/, mount: mountQueue },
  { pattern: /^#\/finding\/(\d+)$/, mount: mountPlaceholder("Not detayı") },
  { pattern: /^#\/runs$/, mount: mountPlaceholder("Koşumlar") },
];

function mountPlaceholder(title) {
  return (root) => {
    root.textContent = "";
    const p = document.createElement("div");
    p.className = "panel placeholder";
    const h = document.createElement("p");
    h.className = "eyebrow";
    h.textContent = title;
    const body = document.createElement("p");
    body.textContent = "Bu ekran henüz yapılmadı.";
    p.append(h, body);
    root.appendChild(p);
    return { refresh() {} };
  };
}

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

function render() {
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
    if (v.storeMissing === true || v.schemaOutdated === true) return;
    const key = `${v.maxVerdictId}:${v.maxEventId}`;
    if (lastVersion !== null && lastVersion !== key) {
      activeScreen?.refresh();
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
