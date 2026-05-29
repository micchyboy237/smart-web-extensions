/**
 * Floating panel manager - creates and manages the UI overlay
 */
import { getPanelTemplate } from "./templates.js";
import { createVideoCard, updateVideoCard } from "./video-card.js";
import { AppState } from "../core/state.js";
import {
  scanForPlayers,
  cleanupStalePlayers,
} from "../tracker/player-tracker.js";
import { getVideoFromPlayer, getVideoInfo } from "../engine/video-utils.js";
import { BoostEngine } from "../engine/boost-engine.js";
import { DebugLogger as debug } from "../core/debug.js";

let panel = null;
let autoRefreshInterval = null;
let scheduledUpdate = null; // ✅ Track scheduled update
let lastUpdateTime = 0; // ✅ Track last update time
const UPDATE_COOLDOWN = 500; // ✅ Minimum 500ms between full updates

export const FloatingPanel = {
  /** Create and show the floating panel */
  create() {
    if (panel) return;

    panel = document.createElement("div");
    panel.id = "video-observer-panel";
    panel.innerHTML = getPanelTemplate();
    document.body.appendChild(panel);

    // Tab switching
    panel.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        panel
          .querySelectorAll(".tab")
          .forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        panel.querySelector("#videos-tab").style.display =
          tab.dataset.tab === "videos" ? "block" : "none";
        panel.querySelector("#logs-tab").style.display =
          tab.dataset.tab === "logs" ? "block" : "none";
      });
    });

    // Panel toggle
    panel.querySelector("#toggle-panel").addEventListener("click", () => {
      AppState.togglePanel();
      panel.style.display = AppState.isPanelVisible() ? "flex" : "none";
    });

    // ✅ Debounced listener for player changes
    AppState.on("players:changed", () => {
      this.scheduleUpdate();
    });

    debug.log("SUCCESS", "Panel created");
  },

  // ✅ NEW: Schedule a debounced update
  scheduleUpdate() {
    const now = Date.now();

    // If update just ran, don't schedule another immediately
    if (now - lastUpdateTime < UPDATE_COOLDOWN) {
      // Cancel existing scheduled update and push it further out
      if (scheduledUpdate) {
        clearTimeout(scheduledUpdate);
      }
      scheduledUpdate = setTimeout(() => {
        this.performUpdate();
        scheduledUpdate = null;
      }, UPDATE_COOLDOWN);
      return;
    }

    // Run immediately if enough time has passed
    this.performUpdate();
  },

  /** Perform a full panel update - sync state to DOM */
  performUpdate() {
    if (!panel || !AppState.isTabVisible()) return;

    const list = panel.querySelector("#videos-list");
    const countEl = panel.querySelector("#video-count");
    const empty = panel.querySelector("#empty-videos");

    if (!list || !countEl || !empty) return;

    // Cleanup stale players
    cleanupStalePlayers();

    const playerCount = AppState.getPlayerCount();
    countEl.textContent = playerCount;

    if (playerCount === 0) {
      empty.style.display = "block";
      list.innerHTML = "";
      lastUpdateTime = Date.now();
      return;
    }

    empty.style.display = "none";

    // Track if we actually changed anything
    let cardsCreated = 0;
    let cardsUpdated = 0;

    // Update all tracked players
    const entries = AppState.getPlayerEntries();
    for (const [player, entry] of entries) {
      const video = getVideoFromPlayer(player);
      if (video) {
        entry.info = getVideoInfo(video);
        // Re-attach boost if video element was replaced
        if (video.dataset.boostAttached !== "true" && video.readyState >= 1) {
          if (entry.boostCleanup) {
            entry.boostCleanup();
          }
          entry.boostCleanup = BoostEngine.attach(video);
        }
      }

      let card = AppState.getCard(player);
      if (!card) {
        card = createVideoCard(entry);
        AppState.setCard(player, card);
        list.appendChild(card);
        cardsCreated++;
      } else {
        updateVideoCard(card, entry);
        cardsUpdated++;
      }
    }

    lastUpdateTime = Date.now();

    // ✅ Only log if something changed
    if (cardsCreated > 0) {
      debug.log(
        "PANEL",
        `Panel updated: ${playerCount} players, ${cardsCreated} new, ${cardsUpdated} existing`,
      );
    }
  },

  /** Start periodic card updates (every second) */
  startAutoUpdate() {
    if (autoRefreshInterval) return;

    autoRefreshInterval = setInterval(() => {
      if (!AppState.isTabVisible() || !panel) return;

      const entries = AppState.getPlayerEntries();
      for (const [player, entry] of entries) {
        const video = getVideoFromPlayer(player);
        if (video) {
          entry.info = getVideoInfo(video);
        }
        const card = AppState.getCard(player);
        if (card) {
          updateVideoCard(card, entry);
        }
      }
    }, 1000);

    debug.log("PANEL", "Auto-update started (1s interval)");
  },

  /** Stop auto-updates */
  stopAutoUpdate() {
    if (autoRefreshInterval) {
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
      debug.log("PANEL", "Auto-update stopped");
    }
    if (scheduledUpdate) {
      clearTimeout(scheduledUpdate);
      scheduledUpdate = null;
    }
  },
};
