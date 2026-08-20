/**
 * Screen-swap seam for the router.
 *
 * Without a handler installed the swap is synchronous and indistinguishable
 * from the old `root.textContent = ""` teardown. A handler opts into keeping
 * the outgoing screen in the DOM while the incoming one is built, which is
 * what a page-turn needs.
 */

let handler = null;

/**
 * @param {?(oldNode: ?Element, mountNew: () => void) => (void | Promise<void>)} fn
 *   Pass null to restore the instant swap.
 */
export function setTransitionHandler(fn) {
  handler = fn ?? null;
}

/**
 * Swap the screen under the router.
 *
 * Contract for a handler: `mountNew()` may be called at any point (it is
 * idempotent — runTransition calls it itself if the handler did not), and
 * `oldNode` is removed by runTransition once the returned promise settles, so
 * a handler that leaves it in place is still safe. A handler that throws or
 * rejects degrades to the instant swap rather than leaving no screen mounted.
 *
 * @param {?Element} oldNode
 * @param {() => void} mountNew
 * @returns {Promise<void>}
 */
export function runTransition(oldNode, mountNew) {
  let mounted = false;
  const mountOnce = () => {
    if (mounted) return;
    mounted = true;
    mountNew();
  };

  if (handler === null) {
    oldNode?.remove();
    mountOnce();
    return Promise.resolve();
  }

  beginAnim();
  return Promise.resolve()
    .then(() => handler(oldNode, mountOnce))
    .catch(() => {})
    .then(() => {
      mountOnce();
      if (oldNode?.isConnected === true) oldNode.remove();
      endAnim();
    });
}

// Counted rather than boolean: nested animations (a page turn containing a
// stamp) must not have the inner one clear the outer one's lock.
let animDepth = 0;

export function animBusy() {
  return animDepth > 0;
}

export function beginAnim() {
  animDepth += 1;
}

export function endAnim() {
  if (animDepth > 0) animDepth -= 1;
}
