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

const pendingBoosts = new Map(); // video -> { priority, scheduled }
let boostScheduler = null;

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
    this._id = BoostManager._nextId++; // ✅ Unique ID for staggering
  }

  start({ rate, duration, isSeek = false, priority = "background" } = {}) {
    const video = this.video;
    if (!video || !AppState.isTabVisible()) return;

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

    // ✅ Batch with other DOM writes using requestAnimationFrame
    if (BoostManager._pendingWrites.size === 0) {
      requestAnimationFrame(() => {
        for (const [vid, rate] of BoostManager._pendingWrites) {
          vid.playbackRate = rate;
        }
        BoostManager._pendingWrites.clear();
      });
    }
    BoostManager._pendingWrites.set(video, effectiveRate);

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

    // ✅ Stagger timer based on video ID to prevent evaluation spikes
    const stagger = (this._id * 137) % 500; // Spread evaluations over 500ms
    const delay = this.state.baseDuration + stagger;

    this.state.timer = setTimeout(() => this._evaluate(), delay);
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

// ✅ Static properties for batching and ID generation
BoostManager._nextId = 0;
BoostManager._pendingWrites = new Map();

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

  /**
   * Optimized boost recalculation with:
   * - Priority-based scheduling
   * - requestIdleCallback for low-priority
   * - Staggered timers to prevent spikes
   * - Batch DOM writes
   */
  _performRecalculation() {
    if (!AppState.isTabVisible()) return;

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

    if (newKey === this._lastWindowKey) {
      return;
    }
    this._lastWindowKey = newKey;

    debug.log(
      "BOOST",
      `Window recalc: playing=${newWindow.priority ? "yes" : "no"}, nearby=${newWindow.nearby.length}, background=${newWindow.background.length}`,
    );

    // Collect target videos with priorities
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

    // ✅ Mark entries with boost priority for panel
    for (const [, entry] of AppState.getPlayerEntries()) {
      entry.boostPriority = "background";
    }
    if (newWindow.priority) {
      newWindow.priority[1].boostPriority = "playing";
    }
    for (const [, entry] of newWindow.nearby) {
      entry.boostPriority = "nearby";
    }
    for (const [, entry] of newWindow.background) {
      entry.boostPriority = "background";
    }
    AppState.notifyPlayersChanged();

    // Cancel pending boosts that are no longer needed
    for (const [video, scheduled] of pendingBoosts) {
      if (!newWindowVideos.has(video)) {
        clearTimeout(scheduled.timeout);
        pendingBoosts.delete(video);
      }
    }

    // Stop active boosts not in window
    const toStop = [];
    for (const [video, manager] of activeManagers) {
      if (!newWindowVideos.has(video)) {
        toStop.push(video);
      }
    }

    // ✅ Batch stop: collect first, then execute
    if (toStop.length > 0) {
      // Use requestAnimationFrame for smooth visual transition
      requestAnimationFrame(() => {
        for (const video of toStop) {
          const manager = managers.get(video);
          if (manager) manager.stop("outside window");
        }
      });
    }

    // ✅ Schedule starts with priority ordering
    this._scheduleBoosts(newWindowVideos);
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

  /**
   * Schedule boosts with intelligent prioritization
   */
  _scheduleBoosts(newWindowVideos) {
    // Cancel existing scheduler
    if (boostScheduler) {
      clearTimeout(boostScheduler);
      boostScheduler = null;
    }

    // Sort by priority: playing > nearby > background
    const priorityOrder = { playing: 0, nearby: 1, background: 2 };
    const sorted = [...newWindowVideos.entries()].sort(
      ([, a], [, b]) => priorityOrder[a] - priorityOrder[b],
    );

    let index = 0;
    const total = sorted.length;

    const scheduleNext = () => {
      if (index >= total) {
        this._logStats();
        return;
      }

      const [video, priority] = sorted[index];
      const manager = managers.get(video);

      if (!manager) {
        index++;
        scheduleNext();
        return;
      }

      const currentBuffer = getBufferAhead(video);

      // ✅ Skip conditions (unchanged)
      if (priority !== "playing" && currentBuffer >= BOOST_CONFIG.BUFFER_LOW) {
        index++;
        scheduleNext();
        return;
      }
      if (
        priority === "playing" &&
        currentBuffer >= BOOST_CONFIG.BUFFER_LOW * 1.5
      ) {
        index++;
        scheduleNext();
        return;
      }
      if (manager.state.active) {
        const currentPriority = manager._priorityValue(manager.state.priority);
        const newPriority = manager._priorityValue(priority);
        if (currentPriority >= newPriority) {
          index++;
          scheduleNext();
          return;
        }
      }

      // ✅ Execute boost based on priority
      const executeBoost = () => {
        manager.start({
          rate: BOOST_CONFIG.BOOST_RATE_NORMAL,
          duration: BOOST_CONFIG.BOOST_DURATION,
          priority,
        });

        index++;

        // ✅ Use requestIdleCallback for background,
        // setTimeout(0) for nearby, immediate for playing
        if (index < total) {
          const nextPriority = sorted[index][1];

          if (nextPriority === "playing") {
            // Playing: schedule immediately in next microtask
            Promise.resolve().then(scheduleNext);
          } else if (nextPriority === "nearby") {
            // Nearby: short delay to avoid jank
            setTimeout(scheduleNext, 16); // ~1 frame
          } else {
            // Background: use idle time
            if (window.requestIdleCallback) {
              requestIdleCallback(() => scheduleNext(), { timeout: 100 });
            } else {
              setTimeout(scheduleNext, 50);
            }
          }
        } else {
          this._logStats();
        }
      };

      // Execute current boost
      if (priority === "playing") {
        // Playing: immediate, synchronous (user is waiting)
        executeBoost();
      } else if (priority === "nearby") {
        // Nearby: next frame
        requestAnimationFrame(executeBoost);
      } else {
        // Background: idle time
        if (window.requestIdleCallback) {
          requestIdleCallback(executeBoost, { timeout: 50 });
        } else {
          setTimeout(executeBoost, 32); // ~2 frames
        }
      }
    };

    // Start the chain
    scheduleNext();
  },

  _logStats() {
    const stats = this.getStats();
    if (stats.total > 0) {
      debug.log(
        "BOOST",
        `Active boosts: ${stats.total} (P:${stats.byPriority.playing} N:${stats.byPriority.nearby} B:${stats.byPriority.background})`,
      );
    }
  },
};
