/**
 * Buffer Boost Engine - manages playback rate acceleration
 * with SMART SCOPE-AWARE cancellation
 *
 * Priority Tiers:
 * - PLAYING: The currently active video (highest boost)
 * - NEARBY: Videos within BOOST_WINDOW.RADIUS of playing video
 * - BACKGROUND: Visible videos outside window
 * - IDLE: Everything else (boost stopped, resources minimal)
 */
import { BOOST_CONFIG } from "../core/config.js";
import { getBufferAhead, getEffectiveBufferRatio } from "./video-utils.js";
import { AppState } from "../core/state.js";
import { DebugLogger as debug } from "../core/debug.js";

// Configuration for boost window
const BOOST_WINDOW = {
  RADIUS: 2,
  MAX_BACKGROUND: 3,
  RECALCULATE_DELAY: 300,
  // ✅ NEW: Scope thresholds
  NEARBY_RADIUS_EXTRA: 1, // Extra radius considered "nearby" before full stop
  GRACEFUL_STOP_DELAY: 1000, // 1s grace period before stopping background boosts
};

// Store boost state separately so it survives video element replacement
const boostStates = new WeakMap();
// Track all active boost managers
const activeManagers = new Map(); // video -> BoostManager
let recalculateTimer = null;
// ✅ NEW: Track videos pending graceful stop
const pendingStops = new Map(); // video -> { timer, reason }

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
      priority: "background",
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
 * ✅ UPDATED: Returns detailed scope info for smart cancellation
 */
function calculateBoostWindow() {
  const entries = AppState.getPlayerEntries();
  if (entries.length === 0)
    return { priority: null, nearby: [], background: [], allScoped: new Set() };

  const currentlyPlaying = AppState.getCurrentlyPlaying();
  let playingPlayer = null;
  let playingIndex = -1;

  if (currentlyPlaying) {
    for (let i = 0; i < entries.length; i++) {
      const [player, entry] = entries[i];
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
    allScoped: new Set(), // ✅ Track all videos that should have boosts
  };

  if (playingPlayer) {
    // Calculate nearby videos
    const start = Math.max(0, playingIndex - BOOST_WINDOW.RADIUS);
    const end = Math.min(
      entries.length,
      playingIndex + BOOST_WINDOW.RADIUS + 1,
    );

    for (let i = start; i < end; i++) {
      if (i === playingIndex) continue;
      result.nearby.push(entries[i]);
    }

    // Fill remaining background slots
    const remainingSlots = Math.max(
      0,
      BOOST_WINDOW.MAX_BACKGROUND - result.nearby.length,
    );
    if (remainingSlots > 0) {
      const outOfWindow = entries.filter(([player], index) => {
        return index < start || index >= end;
      });
      outOfWindow.sort((a, b) => {
        const aVisible = isElementInViewport(a[0]);
        const bVisible = isElementInViewport(b[0]);
        if (aVisible && !bVisible) return -1;
        if (!aVisible && bVisible) return 1;
        return 0;
      });
      result.background = outOfWindow.slice(0, remainingSlots);
    }

    // ✅ Mark all scoped videos
    if (result.priority) result.allScoped.add(result.priority[0]);
    result.nearby.forEach(([p]) => result.allScoped.add(p));
    result.background.forEach(([p]) => result.allScoped.add(p));
  } else {
    const visibleEntries = entries.filter(([player]) =>
      isElementInViewport(player),
    );
    result.background = visibleEntries.slice(0, BOOST_WINDOW.MAX_BACKGROUND);
    result.background.forEach(([p]) => result.allScoped.add(p));
  }

  return result;
}

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
 * BoostManager with smart priority handling
 */
class BoostManager {
  constructor(video) {
    this.video = video;
    this.state = getState(video);
    this._id = BoostManager._nextId++;
  }

  start({ rate, duration, isSeek = false, priority = "background" } = {}) {
    const video = this.video;
    if (!video || !AppState.isTabVisible()) return;

    // ✅ Don't downgrade priority
    const currentPriorityValue = this._priorityValue(this.state.priority);
    const newPriorityValue = this._priorityValue(priority);

    if (this.state.active && currentPriorityValue >= newPriorityValue) {
      return; // Already boosting at equal or higher priority
    }

    // ✅ If upgrading priority, restart with new params
    if (this.state.active && currentPriorityValue < newPriorityValue) {
      this.stop("upgrading priority", { silent: true });
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

    // ✅ Batch DOM writes
    if (BoostManager._pendingWrites.size === 0) {
      requestAnimationFrame(() => {
        for (const [vid, rate] of BoostManager._pendingWrites) {
          if (vid && vid.playbackRate !== undefined) {
            vid.playbackRate = rate;
          }
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
    const stagger = (this._id * 137) % 500;
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

  /**
   * Stop boost with optional graceful degradation
   * @param {string} reason - Why we're stopping
   * @param {object} options - { silent: true } to suppress logs
   */
  stop(reason = "manual", options = {}) {
    const video = this.video;
    const wasActive = this.state.active;

    if (
      video &&
      this.state.targetRate &&
      video.playbackRate === this.state.targetRate
    ) {
      // ✅ Smooth transition back to normal rate
      const originalRate = this.state.originalRate || 1.0;
      video.playbackRate = originalRate;
    }

    this.state.active = false;
    this.clearTimer();
    activeManagers.delete(video);

    if (video && !options.silent && reason !== "deprioritized") {
      const currentAhead = getBufferAhead(video);
      debug.log(
        "BOOST",
        `Boost end: ${reason} | Buffer: ${currentAhead.toFixed(1)}s | Was: ${this.state.priority.toUpperCase()}`,
      );
    }
  }

  /**
   * ✅ NEW: Graceful stop - downgrade priority before full stop
   */
  gracefulStop(reason, finalCallback) {
    const currentPriority = this.state.priority;

    if (currentPriority === "playing" || currentPriority === "nearby") {
      // High priority: keep boost but downgrade to background
      debug.log(
        "BOOST",
        `Graceful downgrade: ${currentPriority} → background (${reason})`,
      );
      this.start({
        rate: BOOST_CONFIG.BOOST_RATE_NORMAL,
        duration: Math.min(BOOST_CONFIG.BOOST_DURATION / 2, 4000),
        priority: "background",
      });

      // Schedule final stop after grace period
      setTimeout(() => {
        if (this.state.priority === "background") {
          this.stop(reason);
          if (finalCallback) finalCallback();
        }
      }, BOOST_WINDOW.GRACEFUL_STOP_DELAY);
    } else {
      // Already low priority, just stop
      this.stop(reason);
      if (finalCallback) finalCallback();
    }
  }

  clearTimer() {
    if (this.state.timer) {
      clearTimeout(this.state.timer);
      this.state.timer = null;
    }
  }

  dispose() {
    // Cancel any pending graceful stop
    const pending = pendingStops.get(this.video);
    if (pending) {
      clearTimeout(pending.timer);
      pendingStops.delete(this.video);
    }

    this.stop("dispose");
    clearState(this.video);
  }
}

// Static properties
BoostManager._nextId = 0;
BoostManager._pendingWrites = new Map();

const managers = new WeakMap();

export const BoostEngine = {
  _lastWindowKey: null,

  attach(video) {
    if (!video || video.dataset.boostAttached === "true") return () => {};
    video.dataset.boostAttached = "true";

    const manager = new BoostManager(video);
    managers.set(video, manager);

    const initialCheck = setTimeout(() => {
      if (!AppState.isTabVisible()) return;
      const state = getState(video);
      const ahead = getBufferAhead(video);
      if (
        ahead < BOOST_CONFIG.INITIAL_BUFFER_TARGET &&
        !state.hasBoostedOnLoad
      ) {
        state.hasBoostedOnLoad = true;
        BoostEngine.recalculateWindow();
      }
    }, 600);

    const onSeeked = () => {
      if (!AppState.isTabVisible()) return;
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
      AppState.setCurrentlyPlaying(video);
      BoostEngine.recalculateWindow();
    };

    const onPause = () => {
      BoostEngine.recalculateWindow();
    };

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);

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

  recalculateWindow() {
    clearTimeout(recalculateTimer);
    recalculateTimer = setTimeout(() => {
      this._performRecalculation();
    }, BOOST_WINDOW.RECALCULATE_DELAY);
  },

  /**
   * ✅ UPDATED: Smart cancellation with scope awareness
   */
  _performRecalculation() {
    if (!AppState.isTabVisible()) return;

    const newWindow = calculateBoostWindow();

    // Build a key for comparison
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

    // ✅ Collect target videos with priorities
    const newWindowVideos = new Map();
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

    // ✅ Update boost priority on entries
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

    // ✅ SMART CANCELLATION: Handle videos moving OUT of scope
    const allActiveVideos = new Set(activeManagers.keys());

    for (const video of allActiveVideos) {
      const manager = managers.get(video);
      if (!manager || !manager.state.active) continue;

      const newPriority = newWindowVideos.get(video);
      const currentPriority = manager.state.priority;

      if (!newPriority) {
        // ✅ Video is now OUT OF SCOPE entirely
        const currentPriorityValue = manager._priorityValue(currentPriority);

        if (currentPriorityValue >= 2) {
          // Was playing or nearby: graceful degradation
          debug.log(
            "BOOST",
            `Out of scope: ${currentPriority.toUpperCase()} → graceful stop`,
          );
          manager.gracefulStop("out of scope", () => {
            // After grace period, check if still out of scope
            if (!newWindowVideos.has(video)) {
              manager.stop("confirmed out of scope");
            }
          });
        } else {
          // Was background: immediate stop
          manager.stop("out of scope");
        }
      } else if (newPriority !== currentPriority) {
        // ✅ Priority changed: update boost
        const newValue = manager._priorityValue(newPriority);
        const currentValue = manager._priorityValue(currentPriority);

        if (newValue > currentValue) {
          // Upgraded priority
          manager.start({
            rate: BOOST_CONFIG.BOOST_RATE_NORMAL,
            duration: BOOST_CONFIG.BOOST_DURATION,
            priority: newPriority,
          });
        } else if (newValue < currentValue) {
          // ✅ Downgraded priority: graceful transition
          debug.log(
            "BOOST",
            `Downgrade: ${currentPriority.toUpperCase()} → ${newPriority.toUpperCase()}`,
          );
          manager.gracefulStop("downgraded");
          // Schedule new boost at lower priority
          setTimeout(() => {
            if (newWindowVideos.has(video)) {
              manager.start({
                rate: BOOST_CONFIG.BOOST_RATE_NORMAL,
                duration: BOOST_CONFIG.BOOST_DURATION,
                priority: newPriority,
              });
            }
          }, BOOST_WINDOW.GRACEFUL_STOP_DELAY + 100);
        }
      }
    }

    // ✅ Schedule new boosts for videos entering scope
    this._scheduleBoosts(newWindowVideos);
  },

  getManager(video) {
    return managers.get(video);
  },

  /**
   * Stop all boosts with smart ordering
   */
  stopAll() {
    debug.log("BOOST", `Stopping all boosts (${activeManagers.size} active)`);

    // ✅ Stop in priority order: background first, playing last
    const priorityOrder = { background: 0, nearby: 1, playing: 2 };
    const sorted = [...activeManagers.entries()]
      .sort(
        ([, a], [, b]) =>
          priorityOrder[a.state.priority] - priorityOrder[b.state.priority],
      )
      .reverse(); // Highest priority last

    sorted.forEach(([video, manager]) => {
      manager.stop("tab hidden");
    });

    // Clear pending graceful stops
    for (const [video, pending] of pendingStops) {
      clearTimeout(pending.timer);
    }
    pendingStops.clear();
  },

  getActiveCount() {
    return activeManagers.size;
  },

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

  _scheduleBoosts(newWindowVideos) {
    if (boostScheduler) {
      clearTimeout(boostScheduler);
      boostScheduler = null;
    }

    const priorityOrder = { playing: 0, nearby: 1, background: 2 };
    const sorted = [...newWindowVideos.entries()]
      .filter(([video]) => {
        // ✅ Skip if already boosting at equal or higher priority
        const manager = managers.get(video);
        if (!manager) return true;
        if (!manager.state.active) return true;
        const currentVal = manager._priorityValue(manager.state.priority);
        const newVal = manager._priorityValue(newWindowVideos.get(video));
        return newVal > currentVal;
      })
      .sort(([, a], [, b]) => priorityOrder[a] - priorityOrder[b]);

    if (sorted.length === 0) {
      this._logStats();
      return;
    }

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

      // ✅ Skip if buffer is already sufficient
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

      const executeBoost = () => {
        manager.start({
          rate: BOOST_CONFIG.BOOST_RATE_NORMAL,
          duration: BOOST_CONFIG.BOOST_DURATION,
          priority,
        });
        index++;

        if (index < total) {
          const nextPriority = sorted[index][1];
          if (nextPriority === "playing") {
            Promise.resolve().then(scheduleNext);
          } else if (nextPriority === "nearby") {
            setTimeout(scheduleNext, 16);
          } else {
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

      if (priority === "playing") {
        executeBoost();
      } else if (priority === "nearby") {
        requestAnimationFrame(executeBoost);
      } else {
        if (window.requestIdleCallback) {
          requestIdleCallback(executeBoost, { timeout: 50 });
        } else {
          setTimeout(executeBoost, 32);
        }
      }
    };

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
