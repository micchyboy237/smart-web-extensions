// shadow-dom-flattener.js
// Flattens <shreddit-player> shadow DOMs so internal <video> elements
// become queryable via standard document.querySelectorAll().

(function () {
  "use strict";

  const FLATTEN_MARKER = "data-shadow-flattened";
  const CLONE_MARKER = "data-shadow-clone";
  const TARGET_TAG = "shreddit-player"; // Only flatten this element's shadow

  function isFlattened(el) {
    return el.hasAttribute && el.hasAttribute(FLATTEN_MARKER);
  }

  function isClone(el) {
    return el.hasAttribute && el.hasAttribute(CLONE_MARKER);
  }

  /**
   * Clone shadow root children into the host's light DOM.
   * This exposes <video> inside <shreddit-player> to document.querySelectorAll().
   */
  function flattenShadowRoot(host) {
    if (!host || !host.shadowRoot || isFlattened(host)) return;

    const shadowChildren = host.shadowRoot.children;
    if (shadowChildren.length === 0) {
      host.setAttribute(FLATTEN_MARKER, "true");
      return;
    }

    for (const child of shadowChildren) {
      try {
        const clone = child.cloneNode(true);
        clone.setAttribute(CLONE_MARKER, "true");
        host.appendChild(clone);
      } catch (err) {
        console.warn(`[ShadowFlattener] ⚠️ Clone failed:`, err.message);
      }
    }
    host.setAttribute(FLATTEN_MARKER, "true");
  }

  /**
   * Find and flatten ONLY <shreddit-player> shadow DOMs.
   * This is MUCH faster than walking the entire document (556 → ~27 elements).
   */
  function flattenAllShadowDOMs(root = document.documentElement) {
    const players = root.querySelectorAll(TARGET_TAG);
    let count = 0;

    for (const player of players) {
      if (!isFlattened(player) && player.shadowRoot) {
        flattenShadowRoot(player);
        count++;
      }
    }

    console.log(
      `[ShadowFlattener] 🔓 Flattened ${count} ${TARGET_TAG} shadow roots`,
    );
    return count;
  }

  function unflattenAll() {
    const clones = document.querySelectorAll(`[${CLONE_MARKER}]`);
    clones.forEach((c) => c.remove());
    const flattened = document.querySelectorAll(`[${FLATTEN_MARKER}]`);
    flattened.forEach((el) => el.removeAttribute(FLATTEN_MARKER));
    console.log(`[ShadowFlattener] 🧹 Removed ${clones.length} clones`);
  }

  function reflattenAll() {
    unflattenAll();
    return flattenAllShadowDOMs();
  }

  window.ShadowDOMFlattener = {
    flattenAll: flattenAllShadowDOMs,
    flattenOne: flattenShadowRoot,
    unflattenAll,
    reflattenAll,
    isFlattened,
    isClone,
  };

  console.log("[ShadowFlattener] Module loaded ✅");
})();
