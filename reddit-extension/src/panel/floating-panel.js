/**
 * Floating panel manager - creates and manages the UI overlay
 * Now with integrated chunk preview management
 */
import { getPanelTemplate } from "./templates.js";
import {
  createVideoCard,
  updateVideoCard,
  loadCardPreview,
  unloadCardPreview,
} from "./video-card.js";
import { AppState } from "../core/state.js";
import {
  scanForPlayers,
  cleanupStalePlayers,
} from "../tracker/player-tracker.js";
import { getVideoFromPlayer, getVideoInfo } from "../engine/video-utils.js";
import { BoostEngine } from "../engine/boost-engine.js";
import { ChunkPreviewEngine } from "../engine/chunk-preview.js"; // ✅ NEW
import { DebugLogger as debug } from "../core/debug.js";

let panel = null;
let autoRefreshInterval = null;
let scheduledUpdate = null;
let lastUpdateTime = 0;
const UPDATE_COOLDOWN = 500;
// ✅ Configuration for preview visibility management
const UNLOAD_MARGIN = 400; // px margin for keeping previews loaded

export const FloatingPanel = {
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

    // Listen for player changes
    AppState.on("players:changed", () => {
      this.scheduleUpdate();
    });

    // Listen for tab visibility changes
    AppState.on("tab:visibility", ({ visible }) => {
      if (visible) {
        ChunkPreviewEngine.resumeAll();
      } else {
        ChunkPreviewEngine.stopAll();
      }
    });

    debug.log("SUCCESS", "Panel created with chunk preview support");
  },

  scheduleUpdate() {
    const now = Date.now();
    if (now - lastUpdateTime < UPDATE_COOLDOWN) {
      if (scheduledUpdate) clearTimeout(scheduledUpdate);
      scheduledUpdate = setTimeout(() => {
        this.performUpdate();
        scheduledUpdate = null;
      }, UPDATE_COOLDOWN);
      return;
    }
    this.performUpdate();
  },

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

    // ✅ Manage preview visibility based on scroll position
    this._managePreviewVisibility(list);

    lastUpdateTime = Date.now();

    if (cardsCreated > 0) {
      debug.log(
        "PANEL",
        `Panel: ${playerCount} players, ${cardsCreated} new, ${cardsUpdated} existing | Chunks: ${ChunkPreviewEngine.getStats().activeLoops} active`,
      );
    }
  },

  /**
   * Smart preview management - load previews for visible/nearby cards,
   * unload for cards far out of view
   */
  _managePreviewVisibility(list) {
    const listRect = list.getBoundingClientRect();
    const entries = AppState.getPlayerEntries();
    let loadedCount = 0;
    let unloadedCount = 0;

    for (const [player, entry] of entries) {
      const card = AppState.getCard(player);
      if (!card) continue;

      const cardRect = card.getBoundingClientRect();
      const isVisibleInPanel =
        cardRect.top < listRect.bottom + UNLOAD_MARGIN &&
        cardRect.bottom > listRect.top - UNLOAD_MARGIN;

      const priority = card.dataset.priority || "background";

      if (
        isVisibleInPanel &&
        (priority === "playing" || priority === "nearby")
      ) {
        // Ensure preview is loaded for high-priority visible cards
        loadCardPreview(card);
        loadedCount++;
      } else if (!isVisibleInPanel && priority === "background") {
        // Unload previews for cards far out of view
        unloadCardPreview(card);
        unloadedCount++;
      }
    }

    // ✅ Log chunk preview stats periodically
    if ((loadedCount > 0 || unloadedCount > 0) && Math.random() < 0.2) {
      const stats = ChunkPreviewEngine.getStats();
      console.log(
        `[Panel] Preview visibility: ${loadedCount} loaded, ${unloadedCount} unloaded | Active chunks: ${stats.activeLoops}`,
      );
    }
  },

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
    debug.log("PANEL", "Auto-update started (1s)");
  },

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
