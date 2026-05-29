/**
 * Buffer Boost Engine - manages playback rate acceleration
 * for faster video buffering with intelligent prioritization.
 *
 * Strategy:
 * - Always prioritize currently playing video
 * - Boost N surrounding videos (configurable window)
 * - Stop boosts when video leaves the window
 * - Recalculate on play, scroll, or tab visibility change
 */
import { BOOST_CONFIG } from "../core/config.js";
import { getBufferAhead, getEffectiveBufferRatio } from "./video-utils.js";
import { AppState } from "../core/state.js";
import { DebugLogger as debug } from "../core/debug.js";

// Configuration for boost window
const BOOST_WINDOW = {
  RADIUS: 2, // Boost 2 videos above and below the playing video
  MAX_BACKGROUND: 3, // Max background videos to boost when nothing is playing
  RECALCULATE_DELAY: 300, // Debounce recalculations
};

// Store boost state separately so it survives video element replacement
const boostStates = new WeakMap();
// Track all active boost managers
const activeManagers = new Map(); // video -> BoostManager
let recalculateTimer = null;

function getState(video) {
  if (!boostStates.has(video)) {
    boostStates.set(video, {
      originalRate: null,
      targetRate: null,
      startTime: null,
      extensionCount: 0,
      baseDuration: 0,
      active: false,
      paused: false,
      hasBoostedOnLoad: false,
      timer: null,
      priority: "background", // 'playing' | 'nearby' | 'background'
    });
  }
  return boostStates.get(video);
}

function clearState(video) {
  const state = boostStates.get(video);
  if (state?.timer) {
    clearTimeout(state.timer);
  }
  boostStates.delete(video);
  activeManagers.delete(video);
}

/**
 * Determine which videos should be in the boost window
 * Returns array of [player, entry] pairs that should be boosted
 */
function calculateBoostWindow() {
  const entries = AppState.getPlayerEntries();
  if (entries.length === 0)
    return { priority: null, nearby: [], background: [] };

  const currentlyPlaying = AppState.getCurrentlyPlaying();

  // Find the playing video's player
  let playingPlayer = null;
  let playingIndex = -1;

  if (currentlyPlaying) {
    for (let i = 0; i < entries.length; i++) {
      const [player, entry] = entries[i];
      // Find video inside this player
      const video =
        player.shadowRoot?.querySelector("video") ||
        player.querySelector("video");
      if (video === currentlyPlaying) {
        playingPlayer = player;
        playingIndex = i;
        break;
      }
    }
  }

  const result = {
    priority: playingPlayer ? entries[playingIndex] : null,
    nearby: [],
    background: [],
  };

  if (playingPlayer) {
    // Calculate nearby videos (BOOST_WINDOW.RADIUS above and below)
    const start = Math.max(0, playingIndex - BOOST_WINDOW.RADIUS);
    const end = Math.min(
      entries.length,
      playingIndex + BOOST_WINDOW.RADIUS + 1,
    );

    for (let i = start; i < end; i++) {
      if (i === playingIndex) continue; // Skip the playing one (it's priority)
      result.nearby.push(entries[i]);
    }

    // Fill remaining background slots if window is small
    const remainingSlots = Math.max(
      0,
      BOOST_WINDOW.MAX_BACKGROUND - result.nearby.length,
    );
    if (remainingSlots > 0) {
      // Get visible but out-of-window videos (prefer those in viewport)
      const outOfWindow = entries.filter(([player], index) => {
        return index < start || index >= end;
      });

      // Sort by viewport proximity
      outOfWindow.sort((a, b) => {
        const aVisible = isElementInViewport(a[0]);
        const bVisible = isElementInViewport(b[0]);
        if (aVisible && !bVisible) return -1;
        if (!aVisible && bVisible) return 1;
        return 0;
      });

      result.background = outOfWindow.slice(0, remainingSlots);
    }
  } else {
    // Nothing playing - boost first few visible videos
    const visibleEntries = entries.filter(([player]) =>
      isElementInViewport(player),
    );
    result.background = visibleEntries.slice(0, BOOST_WINDOW.MAX_BACKGROUND);
  }

  return result;
}

/**
 * Check if element is within the viewport
 */
function isElementInViewport(el) {
  const rect = el.getBoundingClientRect();
  const windowHeight =
    window.innerHeight || document.documentElement.clientHeight;
  const windowWidth = window.innerWidth || document.documentElement.clientWidth;

  return (
    rect.top >= -rect.height &&
    rect.left >= -rect.width &&
    rect.bottom <= windowHeight + rect.height &&
    rect.right <= windowWidth + rect.width
  );
}

/**
 * Manages boost state for a single video element
 */
class BoostManager {
  constructor(video) {
    this.video = video;
    this.state = getState(video);
  }

  start({ rate, duration, isSeek = false, priority = "background" } = {}) {
    const video = this.video;
    if (!video || !AppState.isTabVisible()) return;

    // If already boosting with same or higher priority, skip
    if (
      this.state.active &&
      this._priorityValue(this.state.priority) >= this._priorityValue(priority)
    ) {
      return;
    }

    const effectiveRate =
      rate ||
      (isSeek ? BOOST_CONFIG.SEEK_BOOST_RATE : BOOST_CONFIG.BOOST_RATE_NORMAL);
    const effectiveDuration =
      duration ||
      (isSeek ? BOOST_CONFIG.SEEK_BOOST_DURATION : BOOST_CONFIG.BOOST_DURATION);

    // Save original rate (only first time)
    if (this.state.originalRate === null) {
      this.state.originalRate = video.playbackRate || 1.0;
    }

    this.state.targetRate = effectiveRate;
    this.state.startTime = Date.now();
    this.state.extensionCount = 0;
    this.state.baseDuration = effectiveDuration;
    this.state.active = true;
    this.state.paused = video.paused;
    this.state.priority = priority;

    video.playbackRate = effectiveRate;
    activeManagers.set(video, this);

    debug.log(
      "BOOST",
      `Boost: ${effectiveRate.toFixed(2)}x for ${effectiveDuration}ms | Buffer: ${getBufferAhead(video).toFixed(1)}s | Priority: ${priority.toUpperCase()}`,
    );

    this._scheduleEvaluation();
  }

  _priorityValue(p) {
    return p === "playing" ? 3 : p === "nearby" ? 2 : 1;
  }

  _scheduleEvaluation() {
    this.clearTimer();
    this.state.timer = setTimeout(
      () => this._evaluate(),
      this.state.baseDuration,
    );
  }

  _evaluate() {
    const video = this.video;
    if (!video || !this.state.active || !AppState.isTabVisible()) {
      this.stop("inactive");
      return;
    }

    if (video.paused && this.state.priority !== "playing") {
      // Non-playing videos: stop if paused
      this.stop("paused");
      return;
    }

    this.state.paused = video.paused;
    const currentAhead = getBufferAhead(video);
    const elapsed = Date.now() - this.state.startTime;
    let endReason = null;

    if (currentAhead >= BOOST_CONFIG.BUFFER_LOW * 1.5) {
      endReason = "buffer healthy";
    } else if (this.state.extensionCount >= BOOST_CONFIG.MAX_BOOST_EXTENSIONS) {
      endReason = "max extensions";
    } else if (elapsed > BOOST_CONFIG.MAX_TOTAL_BOOST_MS) {
      endReason = "max time";
    } else if (
      elapsed >
      this.state.baseDuration +
        this.state.extensionCount * BOOST_CONFIG.SEEK_BOOST_EXTENSION
    ) {
      if (
        this.state.extensionCount < BOOST_CONFIG.MAX_BOOST_EXTENSIONS &&
        elapsed <= BOOST_CONFIG.MAX_TOTAL_BOOST_MS
      ) {
        this.state.extensionCount++;
        this._scheduleEvaluation();
        return;
      }
      endReason = "limits reached";
    }

    if (endReason) {
      this.stop(endReason);
    } else {
      this._scheduleEvaluation();
    }
  }

  stop(reason = "manual") {
    const video = this.video;
    if (
      video &&
      this.state.targetRate &&
      video.playbackRate === this.state.targetRate
    ) {
      video.playbackRate = this.state.originalRate || 1.0;
    }
    this.state.active = false;
    this.clearTimer();
    activeManagers.delete(video);

    if (video && reason !== "deprioritized") {
      const currentAhead = getBufferAhead(video);
      debug.log(
        "BOOST",
        `Boost end: ${reason} | Buffer: ${currentAhead.toFixed(1)}s`,
      );
    }
  }

  clearTimer() {
    if (this.state.timer) {
      clearTimeout(this.state.timer);
      this.state.timer = null;
    }
  }

  dispose() {
    this.stop("dispose");
    clearState(this.video);
  }
}

// Global boost manager registry
const managers = new WeakMap();

export const BoostEngine = {
  _lastWindowKey: null,

  /**
   * Attach boost capabilities to a video element
   * Returns cleanup function
   */
  attach(video) {
    if (!video || video.dataset.boostAttached === "true") return () => {};
    video.dataset.boostAttached = "true";

    const manager = new BoostManager(video);
    managers.set(video, manager);

    debug.log(
      "BOOST",
      `Attached to ${video.dataset.videoObserverId || "unknown"}`,
    );

    // Initial buffer check after load - deferred to recalculate
    const initialCheck = setTimeout(() => {
      if (!AppState.isTabVisible()) return;

      const state = getState(video);
      const ahead = getBufferAhead(video);
      if (
        ahead < BOOST_CONFIG.INITIAL_BUFFER_TARGET &&
        !state.hasBoostedOnLoad
      ) {
        // Don't start here - let recalculateWindow decide
        state.hasBoostedOnLoad = true;
        BoostEngine.recalculateWindow();
      }
    }, 600);

    // Event handlers
    const onSeeked = () => {
      if (!AppState.isTabVisible()) return;
      // Only boost-seek if this is the currently playing video
      if (AppState.getCurrentlyPlaying() !== video) return;

      const ratio = getEffectiveBufferRatio(video);
      manager.start({
        rate: BOOST_CONFIG.SEEK_BOOST_RATE,
        duration:
          ratio < BOOST_CONFIG.SEEK_MIN_EFFECTIVE_RATIO
            ? BOOST_CONFIG.SEEK_BOOST_DURATION +
              BOOST_CONFIG.SEEK_BOOST_EXTENSION
            : BOOST_CONFIG.SEEK_BOOST_DURATION,
        isSeek: true,
        priority: "playing",
      });
    };

    const onPlay = () => {
      // When this video starts playing, recalculate the boost window
      AppState.setCurrentlyPlaying(video);
      BoostEngine.recalculateWindow();
    };

    const onPause = () => {
      // Recalculate when paused (might deprioritize)
      BoostEngine.recalculateWindow();
    };

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);

    // Return cleanup function
    return () => {
      clearTimeout(initialCheck);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      manager.dispose();
      managers.delete(video);
      delete video.dataset.boostAttached;
    };
  },

  /**
   * Recalculate which videos should be boosted
   * Call this when: video plays, video pauses, user scrolls, tab becomes visible
   */
  recalculateWindow() {
    // Debounce to avoid rapid recalculations
    clearTimeout(recalculateTimer);
    recalculateTimer = setTimeout(() => {
      this._performRecalculation();
    }, BOOST_WINDOW.RECALCULATE_DELAY);
  },

  _performRecalculation() {
    if (!AppState.isTabVisible()) return;

    // ✅ Prevent duplicate recalculations
    const windowKey = this._lastWindowKey;
    const newWindow = calculateBoostWindow();
    const newKey = JSON.stringify({
      playing: newWindow.priority?.[1]?.id || "none",
      nearby: newWindow.nearby
        .map(([, e]) => e.id)
        .sort()
        .join(","),
      background: newWindow.background
        .map(([, e]) => e.id)
        .sort()
        .join(","),
    });

    if (newKey === windowKey) {
      debug.log("BOOST", "Window unchanged, skipping recalculation");
      return;
    }
    this._lastWindowKey = newKey;

    debug.log(
      "BOOST",
      `Window recalc: playing=${newWindow.priority ? "yes" : "no"}, nearby=${newWindow.nearby.length}, background=${newWindow.background.length}`,
    );

    // Collect videos that should be in the new window
    const newWindowVideos = new Map(); // video -> priority

    if (newWindow.priority) {
      const [player] = newWindow.priority;
      const video =
        player.shadowRoot?.querySelector("video") ||
        player.querySelector("video");
      if (video) newWindowVideos.set(video, "playing");
    }

    for (const [player] of newWindow.nearby) {
      const video =
        player.shadowRoot?.querySelector("video") ||
        player.querySelector("video");
      if (video) newWindowVideos.set(video, "nearby");
    }

    for (const [player] of newWindow.background) {
      const video =
        player.shadowRoot?.querySelector("video") ||
        player.querySelector("video");
      if (video) newWindowVideos.set(video, "background");
    }

    // Stop videos no longer in window
    for (const [video, manager] of activeManagers) {
      if (!newWindowVideos.has(video)) {
        manager.stop("outside window");
      }
    }

    // Start/update boosts for videos in window
    for (const [video, priority] of newWindowVideos) {
      const manager = managers.get(video);
      if (!manager) continue;

      const currentBuffer = getBufferAhead(video);

      // ✅ Skip if already sufficiently buffered
      if (priority !== "playing" && currentBuffer >= BOOST_CONFIG.BUFFER_LOW) {
        continue;
      }

      // ✅ For playing video, only boost if buffer is low
      if (
        priority === "playing" &&
        currentBuffer >= BOOST_CONFIG.BUFFER_LOW * 1.5
      ) {
        continue;
      }

      // ✅ Skip if already active with same or higher priority
      if (manager.state.active) {
        const currentPriority = manager._priorityValue(manager.state.priority);
        const newPriority = manager._priorityValue(priority);
        if (currentPriority >= newPriority) {
          continue;
        }
      }

      manager.start({
        rate: BOOST_CONFIG.BOOST_RATE_NORMAL,
        duration: BOOST_CONFIG.BOOST_DURATION,
        priority,
      });
    }

    // Log stats
    const stats = this.getStats();
    if (stats.total > 0) {
      debug.log(
        "BOOST",
        `Active boosts: ${stats.total} (P:${stats.byPriority.playing} N:${stats.byPriority.nearby} B:${stats.byPriority.background})`,
      );
    }
  },

  /** Get manager for a video */
  getManager(video) {
    return managers.get(video);
  },

  /** Stop all boosts (for tab hide) */
  stopAll() {
    debug.log("BOOST", `Stopping all boosts (${activeManagers.size} active)`);
    for (const [video, manager] of activeManagers) {
      manager.stop("tab hidden");
    }
  },

  /** Get active boost count */
  getActiveCount() {
    return activeManagers.size;
  },

  /** Get boost stats for debugging */
  getStats() {
    const stats = {
      total: activeManagers.size,
      byPriority: { playing: 0, nearby: 0, background: 0 },
    };
    for (const [video, manager] of activeManagers) {
      stats.byPriority[manager.state.priority]++;
    }
    return stats;
  },
};
