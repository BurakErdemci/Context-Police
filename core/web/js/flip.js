/**
 * Route transition as a page turn ("VAKA DEFTERİ" theme).
 *
 * Registers itself with transition.js on module load — importing this file is
 * the whole installation step. The outgoing screen is lifted out of the flow,
 * pinned over the incoming one and rotated away around its left edge; because
 * the face is `backface-visibility: hidden`, it disappears at 90° instead of
 * showing a blank reverse side.
 *
 * Styles live in css/defter.css (`.flip-stage`, `.flip-out`, `.flip-in`).
 */

import { setTransitionHandler, beginAnim, endAnim } from "./transition.js";

// Must stay >= the CSS transition on .flip-out; it is the watchdog that closes
// a turn whose transitionend never fires (interrupted transition, tab hidden,
// a browser that skips transitions on a display:none ancestor).
const TURN_MS = 620;
const WATCHDOG_MS = TURN_MS + 240;

// At most one turn is ever live: a second navigation finishes the first one on
// the spot rather than leaving its host stranded in the DOM (transition.js only
// removes the node it was handed, and that node is the *previous* old node).
let active = null;

function prefersReducedMotion() {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function pageTurn(oldNode, mountNew) {
  active?.finish();

  const stage = oldNode?.parentElement ?? null;
  if (stage === null || prefersReducedMotion()) {
    mountNew();
    return undefined;
  }

  // The box is frozen before the node leaves the flow: once it is absolute the
  // incoming screen defines the stage height, and an un-pinned outgoing screen
  // would resize mid-turn.
  const rect = oldNode.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  oldNode.style.top = `${rect.top - stageRect.top}px`;
  oldNode.style.left = `${rect.left - stageRect.left}px`;
  oldNode.style.width = `${rect.width}px`;
  oldNode.style.height = `${rect.height}px`;
  stage.classList.add("flip-stage");
  oldNode.classList.add("flip-out");

  mountNew();
  const incoming = stage.lastElementChild !== oldNode ? stage.lastElementChild : null;
  incoming?.classList.add("flip-in");

  beginAnim();
  let settled = false;
  let resolve = () => {};
  const done = new Promise((r) => { resolve = r; });

  const finish = () => {
    if (settled) return;
    settled = true;
    active = null;
    clearTimeout(watchdog);
    oldNode.removeEventListener("transitionend", onEnd);
    oldNode.remove();
    oldNode.classList.remove("flip-out", "flip-turning");
    oldNode.removeAttribute("style");
    incoming?.classList.remove("flip-in");
    stage.classList.remove("flip-stage");
    endAnim();
    resolve();
  };

  const onEnd = (e) => {
    if (e.target === oldNode && e.propertyName === "transform") finish();
  };
  oldNode.addEventListener("transitionend", onEnd);
  const watchdog = setTimeout(finish, WATCHDOG_MS);

  // Two frames: one for the browser to take the pre-turn state as the
  // transition's start value, one to flip. A single frame is enough on Chrome
  // and drops the animation on WebKit when the class lands in the same paint.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!settled) oldNode.classList.add("flip-turning");
    });
  });

  active = { finish };
  return done;
}

setTransitionHandler(pageTurn);
