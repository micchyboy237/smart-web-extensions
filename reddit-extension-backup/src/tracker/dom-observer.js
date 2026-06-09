/**
 * DOM Mutation Observer for detecting new shreddit-player elements
 */
import { DOM_CONFIG } from "../core/config.js";
import { AppState } from "../core/state.js";
import { DebugLogger as debug } from "../core/debug.js";
import { scanForPlayers } from "./player-tracker.js";

let observer = null;
let debounceTimer = null;

// ✅ Import FloatingPanel dynamically to avoid circular deps
let FloatingPanel = null;
async function getFloatingPanel() {
  if (!FloatingPanel) {
    const module = await import("../panel/floating-panel.js");
    FloatingPanel = module.FloatingPanel;
  }
  return FloatingPanel;
}

export const DOMObserver = {
  /** Start observing for new players */
  start() {
    if (observer) {
      debug.log("DOM", "Observer already running");
      return;
    }

    observer = new MutationObserver((mutations) => {
      if (!AppState.isTabVisible()) return;

      let hasNewPlayers = false;
      let mutationCount = 0;

      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        mutationCount++;

        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Check if node itself is a player
          if (node.matches?.(DOM_CONFIG.PLAYER_SELECTOR)) {
            debug.log(
              "DOM",
              `New player detected via mutation: ${node.tagName}`,
            );
            hasNewPlayers = true;
            break;
          }

          // Check if node contains players
          const containedPlayers = node.querySelectorAll?.(
            DOM_CONFIG.PLAYER_SELECTOR,
          );
          if (containedPlayers?.length > 0) {
            debug.log(
              "DOM",
              `${containedPlayers.length} new players detected in added subtree`,
            );
            hasNewPlayers = true;
            break;
          }
        }

        if (hasNewPlayers) break;
      }

      if (hasNewPlayers) {
        debug.log(
          "DOM",
          `Triggering debounced scan (${mutations.length} mutations, ${mutationCount} childList)`,
        );
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          scanForPlayers();
          // ✅ Update panel after scan
          const panel = await getFloatingPanel();
          panel.performUpdate();
        }, DOM_CONFIG.DEBOUNCE_DELAY);
      }
    });

    const target =
      document.querySelector(DOM_CONFIG.FEED_SELECTOR) ||
      document.querySelector(DOM_CONFIG.FALLBACK_SELECTOR) ||
      document.body;

    observer.observe(target, { childList: true, subtree: true });
    debug.log(
      "DOM",
      `Observer watching: ${target.tagName}${target.id ? "#" + target.id : ""}${target.className ? "." + target.className.split(" ")[0] : ""}`,
    );
  },

  /** Stop observing */
  stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
      debug.log("DOM", "Observer stopped");
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  },
};
