import { apiGet } from "./api.js";
import { mount as mountFleet } from "./fleet.js";
import { mount as mountProject } from "./project.js";
import { mount as mountDetail } from "./detail.js";
import { mount as mountRuns } from "./runs.js";
import { animBusy, runTransition } from "./transition.js";

// Route table: each entry's `mount(root, ctx, ...params)` is called with the
// route's regex capture groups after (root, ctx).
const ROUTES = [
  { pattern: /^#\/$/, mount: mountFleet },
  { pattern: /^#\/proje\/(\d+)$/, mount: (root, ctx, id) => mountProject(root, ctx, Number(id)) },
  { pattern: /^#\/finding\/(\d+)$/, mount: (root, ctx, id) => mountDetail(root, ctx, Number(id)) },
  { pattern: /^#\/runs$/, mount: mountRuns },
];

const root = document.getElementById("root");
const ctx = { apiGet, navigate };

let activeScreen = null;
// Every screen gets its own host element under #root. Each screen's mount()
// clears the node it is handed, so without a per-screen host the incoming
// screen would wipe the outgoing one — leaving no old node to animate out.
let activeHost = null;
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

// Presentational only: mark the nav tab matching the current hash. The project
// and finding screens live under "Projeler".
function syncTabs() {
  const hash = location.hash || "#/";
  for (const a of document.querySelectorAll(".tabs a")) {
    const target = a.getAttribute("href");
    const active = target === hash
      || (target === "#/" && (hash.startsWith("#/proje/") || hash.startsWith("#/finding/")));
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function render() {
  syncTabs();
  const route = currentRoute();
  const oldHost = activeHost;
  activeScreen = null;
  activeHost = null;
  runTransition(oldHost, () => {
    const host = document.createElement("div");
    host.className = "screen";
    root.appendChild(host);
    activeHost = host;
    if (route === null) {
      const p = document.createElement("p");
      p.textContent = "Bilinmeyen yol.";
      host.appendChild(p);
      return;
    }
    activeScreen = route.mount(host, ctx, ...route.params);
  });
}

window.addEventListener("hashchange", render);

async function pollVersion() {
  // A slow fetch must not let ticks stack: skip this tick while one is
  // still outstanding rather than piling up concurrent /api/version calls.
  if (pollInFlight) return;
  // Skip, never defer: a refresh mid-animation would tear down the screen being
  // animated. `lastVersion` is left untouched, so the change is still seen by
  // the next tick 3s later.
  if (animBusy()) return;
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
    }
    lastVersion = key;
  } catch {
    // A transient poll failure is not worth surfacing: the next tick retries.
  } finally {
    pollInFlight = false;
  }
}

render();
setInterval(pollVersion, 3000);
