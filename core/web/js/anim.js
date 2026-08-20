/**
 * Decision choreography — the "vaka defteri" feedback layer.
 *
 * Three gestures, one per decision, each returning a promise that settles when
 * the case has visibly finished moving:
 *
 *   approved → a TAMAM stamp lands on the card
 *   rejected → the card crumples, flies to the wastebasket, SWISH, and stays
 *              on the page as a filed (faded) record — §3.2: nothing is deleted
 *   pending  → the filed card un-crumples back into the queue
 *
 * Two rules the callers depend on:
 *   1. Every choreography is wrapped in beginAnim()/endAnim() so the 3s poll
 *      cannot re-render the screen out from under a running animation.
 *   2. Under `prefers-reduced-motion` nothing is touched at all — the promise
 *      resolves on the spot and the caller's render() supplies the (textual)
 *      feedback by itself.
 *
 * Overlay nodes (ball, basket, SWISH, corner note) are appended to
 * document.body with fixed positioning rather than into the card: the card is
 * mid-crumple and clips, and the throw has to cross the whole viewport.
 */

import { beginAnim, endAnim } from "./transition.js";

const REDUCED = "(prefers-reduced-motion: reduce)";

function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia(REDUCED).matches;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Corner note per card, so an undo can retract the note it left behind.
const noteFor = new WeakMap();

function overlay(className) {
  const node = document.createElement("div");
  node.className = className;
  document.body.appendChild(node);
  return node;
}

/** Runs `body` inside the anim lock; never rejects — feedback is not the write. */
async function choreograph(target, body) {
  if (!(target instanceof Element) || reducedMotion()) return;
  beginAnim();
  try {
    await body();
  } catch {
    /* a broken animation must not look like a failed decision */
  } finally {
    endAnim();
  }
}

/* --- approve: the stamp ----------------------------------------------------- */

export function stampApprove(target) {
  return choreograph(target, async () => {
    const r = target.getBoundingClientRect();
    const stamp = overlay("stamp-mark");
    stamp.textContent = "TAMAM";
    // Top-right corner of the card, pulled slightly outside it as in the mock.
    stamp.style.left = `${r.right - 24}px`;
    stamp.style.top = `${r.top + 6}px`;
    try {
      await wait(380);
    } finally {
      stamp.remove();
    }
  });
}

/* --- reject: crumple, throw, swish ------------------------------------------ */

// Beats are the mock's (docs/.../2026-08-17-vaka-defteri-maketi.html): crumple
// .5s, ball from .45s for 1s, basket shake at 1.45s, SWISH at 1.5s, note at
// 1.9s. Kept as named constants because four of them must stay in lockstep.
const T_BALL = 450;
const T_SHAKE = 1450;
const T_SWISH = 1500;
const T_NOTE = 1900;
const T_END = 2200;

function buildBall(from, to) {
  const ball = overlay("throw-ball");
  ball.style.left = `${from.x - 26}px`;
  ball.style.top = `${from.y - 26}px`;
  // The parabola is faked with two nested elements: X moves linearly on the
  // outer one, Y on the inner one with an ease-in-out — one element cannot
  // carry two differently-timed transforms.
  ball.style.setProperty("--dx", `${Math.round(to.x - from.x)}px`);
  ball.style.setProperty("--dy", `${Math.round(to.y - from.y)}px`);
  const x = document.createElement("div");
  x.className = "throw-ball__x";
  const y = document.createElement("div");
  y.className = "throw-ball__y";
  const bodyNode = document.createElement("div");
  bodyNode.className = "throw-ball__body";
  y.appendChild(bodyNode);
  x.appendChild(y);
  ball.appendChild(x);
  return ball;
}

export function basketReject(target) {
  return choreograph(target, async () => {
    noteFor.get(target)?.remove();
    const basket = overlay("basket");
    const pail = document.createElement("div");
    pail.className = "basket__pail";
    const swish = document.createElement("div");
    swish.className = "basket__swish";
    swish.textContent = "SWISH!";
    basket.append(swish, pail);

    const card = target.getBoundingClientRect();
    const rim = pail.getBoundingClientRect();
    const ball = buildBall(
      { x: card.left + card.width / 2, y: card.top + card.height / 2 },
      { x: rim.left + rim.width / 2, y: rim.top + 8 },
    );

    target.classList.add("anim-crumple");
    try {
      await wait(T_BALL);
      ball.classList.add("is-thrown");
      await wait(500 - T_BALL);
      // The crumple keyframe ends at scale 0; a static class holds that end
      // state so the card stays gone while the ball is still in the air.
      target.classList.remove("anim-crumple");
      target.classList.add("is-crumpled");

      await wait(T_SHAKE - 500);
      pail.classList.add("is-shaking");
      await wait(T_SWISH - T_SHAKE);
      swish.classList.add("is-shown");

      await wait(T_NOTE - T_SWISH);
      target.classList.remove("is-crumpled");
      target.classList.add("is-filed");
      const note = overlay("cop-notu");
      note.textContent = "sepete gitti… ama sicilde duruyor — geri açılabilir";
      note.setAttribute("role", "status");
      noteFor.set(target, note);
      setTimeout(() => { note.remove(); }, 4000);

      await wait(T_END - T_NOTE);
    } finally {
      ball.remove();
      basket.remove();
    }
  });
}

/* --- undo: back out of the basket ------------------------------------------- */

export function unfileRevert(target) {
  return choreograph(target, async () => {
    noteFor.get(target)?.remove();
    noteFor.delete(target);
    target.classList.remove("is-crumpled", "is-filed");
    target.classList.add("anim-uncrumple");
    try {
      await wait(400);
    } finally {
      target.classList.remove("anim-uncrumple");
    }
  });
}

/** Decision → gesture. Unknown decisions animate nothing. */
export function playDecision(decision, target) {
  if (decision === "approved") return stampApprove(target);
  if (decision === "rejected") return basketReject(target);
  // Undo only un-crumples a card that was actually thrown. Reverting an
  // approval would otherwise play the card open from scale 0 — a gesture for a
  // crumple that never happened.
  if (decision === "pending") {
    const thrown = target instanceof Element
      && (target.classList.contains("is-filed") || target.classList.contains("is-crumpled"));
    return thrown ? unfileRevert(target) : Promise.resolve();
  }
  return Promise.resolve();
}
