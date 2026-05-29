/**
 * Floating panel manager - creates and manages the UI overlay
 * UPDATED: 2-row header, info bar, auto-scroll checkbox, keyboard pointer sync
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
import { ChunkPreviewEngine } from "../engine/chunk-preview.js";
import { DebugLogger as debug } from "../core/debug.js";

let panel = null;
let autoRefreshInterval = null;
let scheduledUpdate = null;
let lastUpdateTime = 0;
const UPDATE_COOLDOWN = 500;
const UNLOAD_MARGIN = 400;

// ✅ Track auto-scroll state
let autoScrollEnabled = true;

export const FloatingPanel = {
  create() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "video-observer-panel";
    panel.innerHTML = getPanelTemplate();
    document.body.appendChild(panel);

    // --- Tab switching ---
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

    // --- Panel toggle ---
    panel.querySelector("#toggle-panel").addEventListener("click", () => {
      AppState.togglePanel();
      panel.style.display = AppState.isPanelVisible() ? "flex" : "none";
    });

    // --- Auto-scroll checkbox ---
    const autoScrollCheckbox = panel.querySelector("#auto-scroll-checkbox");
    if (autoScrollCheckbox) {
      autoScrollCheckbox.addEventListener("change", (e) => {
        autoScrollEnabled = e.target.checked;
        debug.log("INFO", `Auto-scroll: ${autoScrollEnabled ? "ON" : "OFF"}`);
        // If enabled, immediately scroll to current playing video
        if (autoScrollEnabled) {
          this._scrollBodyToCurrentVideo();
        }
      });
    }

    // ✅ Listen for playback changes to update pointer & auto-scroll
    AppState.on("playback:changed", ({ video }) => {
      this._updateInfoBar();
      this._updatePanelPointer();
      if (autoScrollEnabled && video) {
        this._scrollBodyToCurrentVideo(video);
      }
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

    // ✅ Initial info bar update
    this._updateInfoBar();

    debug.log("SUCCESS", "Panel created with 2-row header + auto-scroll");
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
      this._updateInfoBar();
      lastUpdateTime = Date.now();
      return;
    }

    empty.style.display = "none";

    let cardsCreated = 0;
    let cardsUpdated = 0;

    // ✅ Get currently playing video for pointer update
    const currentlyPlaying = AppState.getCurrentlyPlaying();
    let currentPlayingPlayer = null;

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
        // ✅ Track which player is currently playing
        if (video === currentlyPlaying) {
          currentPlayingPlayer = player;
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

    // ✅ Update panel pointer (highlight current video card)
    this._updatePanelPointer();

    // Manage preview visibility based on scroll position
    this._managePreviewVisibility(list);

    // ✅ Update info bar
    this._updateInfoBar();

    lastUpdateTime = Date.now();

    if (cardsCreated > 0) {
      debug.log(
        "PANEL",
        `Panel: ${playerCount} players, ${cardsCreated} new, ${cardsUpdated} existing | Chunks: ${ChunkPreviewEngine.getStats().activeLoops} active`,
      );
    }
  },

  /**
   * ✅ NEW: Update the info bar with current stats
   */
  _updateInfoBar() {
    if (!panel) return;

    const statusEl = panel.querySelector("#panel-info-status");
    const positionEl = panel.querySelector("#panel-info-position");
    const boostEl = panel.querySelector("#panel-info-boost");
    const chunksEl = panel.querySelector("#panel-info-chunks");
    const counterEl = panel.querySelector("#panel-video-counter");

    const currentlyPlaying = AppState.getCurrentlyPlaying();
    const entries = AppState.getPlayerEntries();
    const totalVideos = entries.length;

    // Find current video index
    let currentIndex = -1;
    let currentEntry = null;
    if (currentlyPlaying) {
      for (let i = 0; i < entries.length; i++) {
        const [player, entry] = entries[i];
        const video = getVideoFromPlayer(player);
        if (video === currentlyPlaying) {
          currentIndex = i;
          currentEntry = entry;
          break;
        }
      }
    }

    // Status
    if (statusEl) {
      if (currentlyPlaying && !currentlyPlaying.paused) {
        statusEl.textContent = "▶ Playing";
        statusEl.className = "panel-info-item panel-info-playing";
      } else if (currentlyPlaying && currentlyPlaying.paused) {
        statusEl.textContent = "⏸ Paused";
        statusEl.className = "panel-info-item panel-info-paused";
      } else {
        statusEl.textContent = "⏸ Idle";
        statusEl.className = "panel-info-item";
      }
    }

    // Position (current / total)
    if (positionEl) {
      if (currentIndex >= 0) {
        positionEl.textContent = `${currentIndex + 1}/${totalVideos}`;
      } else {
        positionEl.textContent = `—/${totalVideos}`;
      }
    }

    // Boost count
    if (boostEl) {
      const boostStats = BoostEngine.getStats();
      boostEl.textContent = `🚀 ${boostStats.total} boosts`;
    }

    // Chunk count
    if (chunksEl) {
      const chunkStats = ChunkPreviewEngine.getStats();
      chunksEl.textContent = `🎞 ${chunkStats.activeLoops} chunks`;
    }

    // Video counter in title
    if (counterEl) {
      if (currentIndex >= 0 && currentEntry) {
        counterEl.textContent = `${currentEntry.id} (${currentIndex + 1}/${totalVideos})`;
      } else {
        counterEl.textContent = `${totalVideos} videos`;
      }
    }
  },

  /**
   * ✅ NEW: Update the panel pointer (highlight) to match current video
   * Called when arrow keys change the playing video
   */
  _updatePanelPointer() {
    if (!panel) return;

    const currentlyPlaying = AppState.getCurrentlyPlaying();
    const entries = AppState.getPlayerEntries();
    const list = panel.querySelector("#videos-list");
    if (!list) return;

    // Remove active-pointer from all cards
    list.querySelectorAll(".video-card.active-pointer").forEach((card) => {
      card.classList.remove("active-pointer");
    });

    if (!currentlyPlaying) return;

    // Find and mark the card for the currently playing video
    for (const [player, entry] of entries) {
      const video = getVideoFromPlayer(player);
      if (video === currentlyPlaying) {
        const card = AppState.getCard(player);
        if (card) {
          card.classList.add("active-pointer");

          // ✅ Also scroll the card into view within the panel
          card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        break;
      }
    }
  },

  /**
   * ✅ NEW: Scroll the Reddit page body to the currently playing video
   */
  _scrollBodyToCurrentVideo(video) {
    if (!video) {
      video = AppState.getCurrentlyPlaying();
    }
    if (!video || !autoScrollEnabled) return;

    // Find the player element containing this video
    const entries = AppState.getPlayerEntries();
    for (const [player, entry] of entries) {
      const playerVideo = getVideoFromPlayer(player);
      if (playerVideo === video) {
        player.scrollIntoView({ behavior: "smooth", block: "center" });
        debug.log("INFO", `Auto-scrolled to ${entry.id}`);
        break;
      }
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

    // ✅ Prioritize: playing > nearby > visible background > others
    for (const [player, entry] of entries) {
      const card = AppState.getCard(player);
      if (!card) continue;

      const cardRect = card.getBoundingClientRect();
      const isVisibleInPanel =
        cardRect.top < listRect.bottom + UNLOAD_MARGIN &&
        cardRect.bottom > listRect.top - UNLOAD_MARGIN;

      const priority = card.dataset.priority || "background";

      if (isVisibleInPanel && priority === "playing") {
        // Always load the playing video's preview first
        loadCardPreview(card);
        loadedCount++;
      } else if (isVisibleInPanel && priority === "nearby") {
        // Load nearby visible cards
        loadCardPreview(card);
        loadedCount++;
      } else if (isVisibleInPanel && priority === "background") {
        // Visible background cards: load if we have capacity (lazy)
        // Don't force-unload; let hover trigger them
      } else if (!isVisibleInPanel && priority === "background") {
        // Unload previews for cards far out of view
        unloadCardPreview(card);
        unloadedCount++;
      }
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
      // ✅ Update info bar on each tick
      this._updateInfoBar();
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

  /** ✅ Get current auto-scroll state */
  isAutoScrollEnabled() {
    return autoScrollEnabled;
  },

  /** ✅ Toggle auto-scroll */
  toggleAutoScroll() {
    autoScrollEnabled = !autoScrollEnabled;
    const checkbox = panel?.querySelector("#auto-scroll-checkbox");
    if (checkbox) checkbox.checked = autoScrollEnabled;
    return autoScrollEnabled;
  },
};
