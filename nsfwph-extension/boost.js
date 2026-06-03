// boost.js - Forward Buffer Boost Engine (v2.7 - SILENT PRELOAD SEEK)
// Standalone module for smart buffer management
// Features: Silent preload seeks for buffer protection (no fast-forward UX impact)
// ═══════════════════════════════════════════════════════════════
// Prevent double initialization
if (window.__BOOST_ENGINE_INITIALIZED__) {
  console.warn("[Boost] Engine already initialized, skipping");
} else {
  window.__BOOST_ENGINE_INITIALIZED__ = true;

  // ═══════════════════════════════════════════════════════════════
  // BOOST CONFIGURATION - SILENT PRELOAD SEEK
  // ═══════════════════════════════════════════════════════════════
  const BOOST_CONFIG = {
    // BUFFER ZONES (forward buffer in seconds)
    MIN_FORWARD_BUFFER: 5,
    BUFFER_CRITICAL: 5,
    BUFFER_LOW: 8,
    BUFFER_COMFORT: 15,
    BUFFER_TARGET: 20,

    // Silent Preload Seek settings
    PRELOAD_ENABLED: true,
    PRELOAD_SYNC_INTERVAL: 2000, // Check every 2 seconds
    PRELOAD_ADVANCE_SEEK: 20, // Seek 20s ahead to trigger download
    PRELOAD_MAX_AHEAD: 60, // Never seek more than 60s ahead
    PRELOAD_STOP_AT_BUFFER: 20, // Stop preloading when buffer >= this
    PRELOAD_SNAP_BACK_MS: 50, // Snap back after 50ms (imperceptible)
    PRELOAD_MIN_INTERVAL: 3000, // Min 3s between preload seeks
    PRELOAD_MIN_ADVANCE: 5, // Only preload if target is 5s+ ahead

    // Boost rates (kept for logging/reference, NOT applied to playbackRate)
    BOOST_RATE_AGGRESSIVE: 1.3,
    BOOST_RATE_NORMAL: 1.2,
    BOOST_RATE_GENTLE: 1.12,
    BOOST_RATE_MAINTENANCE: 1.08,
    BOOST_RATE_SEEK: 1.35,

    // Boost timing
    BOOST_DURATION: 30000,
    MONITOR_INTERVAL: 1500,
    BOOST_SESSION_GAP: 3000,

    // Safety limits
    MAX_BOOST_SESSIONS: 25,
    MAX_TOTAL_BOOST_MS: 180000,

    // Connection quality detection
    SLOW_CONNECTION_THRESHOLD: 0.3,
    CONNECTION_CHECK_WINDOW: 4000,

    // Smart detection
    MIN_PLAY_TIME_FOR_BOOST: 1000,
    SHRINK_TOLERANCE: 4,

    // Maintenance mode
    MAINTENANCE_MAX_DURATION: 90000,
    MAINTENANCE_RESTART_DELAY: 10000,

    // Seek handling
    SEEK_DEBOUNCE_MS: 800,

    // DEBUG
    DEBUG_VERBOSE: true,
    DEBUG_PRELOAD: true,
  };

  // ═══════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════
  function getBufferAhead(video) {
    if (!video || !video.buffered || !video.buffered.length) return 0;
    let maxEnd = 0;
    const currentTime = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (currentTime >= start && currentTime <= end) {
        maxEnd = Math.max(maxEnd, end);
      }
    }
    return Math.max(0, maxEnd - currentTime);
  }

  function getTotalBufferedRange(video) {
    if (!video || !video.buffered || !video.buffered.length)
      return { start: 0, end: 0 };
    let minStart = Infinity;
    let maxEnd = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      minStart = Math.min(minStart, video.buffered.start(i));
      maxEnd = Math.max(maxEnd, video.buffered.end(i));
    }
    return { start: minStart === Infinity ? 0 : minStart, end: maxEnd };
  }

  // ═══════════════════════════════════════════════════════════════
  // SILENT PRELOAD SEEK MANAGER
  // ═══════════════════════════════════════════════════════════════
  /**
   * Silently triggers buffer download by briefly seeking ahead and snapping back.
   *
   * HOW IT WORKS:
   * ┌─────────────────────────────────────────────────────────────────┐
   * │                                                                  │
   * │  Step 1: User watching at 10.0s, buffer only 3s ahead           │
   * │  Video: ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
   * │         10s  13s                                                 │
   * │                                                                  │
   * │  Step 2: currentTime = 30s (seek 20s ahead, 50ms duration)      │
   * │  Video: ░░░░░░░░░░░░░░░░░░░░░░████████░░░░░░░░░░░░░░░░░░░░░░░░░ │
   * │                              30s (browser starts downloading)    │
   * │                                                                  │
   * │  Step 3: After 50ms, currentTime = 10s (snap back)              │
   * │  Video: ████░░░░░░░░░░░░░░░░░░░░████████░░░░░░░░░░░░░░░░░░░░░░░ │
   * │         10s  13s                30s (browser CONTINUES download) │
   * │                                                                  │
   * │  Step 4: Browser now downloads both regions → buffer grows      │
   * │  Video: ████████████████████████████████████░░░░░░░░░░░░░░░░░░░░ │
   * │         10s                             40s                      │
   * │                                                                  │
   * │  ⚡ The browser remembers the seek to 30s and continues          │
   * │  downloading that region. User only sees ~3 frames flicker.      │
   * │                                                                  │
   * └─────────────────────────────────────────────────────────────────┘
   */
  function createSilentPreloadManager(originalVideo) {
    if (!BOOST_CONFIG.PRELOAD_ENABLED) {
      console.log("[Preload] ⏭️ Disabled in config, skipping");
      return { cleanup: () => {}, getStats: () => ({}) };
    }

    const videoId = originalVideo.dataset.videoObserverId || "unknown";
    const videoSrc = originalVideo.currentSrc || originalVideo.src;

    if (!videoSrc) {
      console.warn(`[Preload] ❌ No source for ${videoId}`);
      return { cleanup: () => {}, getStats: () => ({}) };
    }

    console.log(`[Preload] 🎬 Silent preload manager for ${videoId}`);
    console.log(`[Preload:D] Source: ${videoSrc.substring(0, 80)}...`);

    // ═══════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════
    let stats = {
      preloadSeeks: 0,
      successfulSeeks: 0,
      failedSeeks: 0,
      lastPreloadSeek: 0,
      lastSnapBack: 0,
      lastLogTime: Date.now(),
      isSnappingBack: false,
      userCurrentTime: 0,
      seekTargetTime: 0,
    };

    let seekSnapBackTimer = null;
    let seekTimeoutTimer = null;

    // Store original preload value to restore on cleanup
    const originalPreload = originalVideo.preload;

    // Force aggressive preload on main video
    originalVideo.preload = "auto";
    console.log(`[Preload] 📋 Set preload="auto" (was "${originalPreload}")`);

    // ═══════════════════════════════════════════════════════════
    // SAFETY: Intercept user-initiated seeks
    // ═══════════════════════════════════════════════════════════
    let userInitiatedSeek = false;
    let userSeekTimeout = null;

    const onUserSeeking = () => {
      // If we're in the middle of a preload snap-back, don't flag as user seek
      if (stats.isSnappingBack) return;
      userInitiatedSeek = true;
      clearTimeout(userSeekTimeout);
      userSeekTimeout = setTimeout(() => {
        userInitiatedSeek = false;
      }, 1000);
    };

    const onUserSeeked = () => {
      if (stats.isSnappingBack) return;
      if (BOOST_CONFIG.DEBUG_PRELOAD) {
        console.log(
          `[Preload] 👤 User seeked to ${originalVideo.currentTime.toFixed(1)}s`,
        );
      }
    };

    originalVideo.addEventListener("seeking", onUserSeeking);
    originalVideo.addEventListener("seeked", onUserSeeked);

    // ═══════════════════════════════════════════════════════════
    // CORE: Silent preload seek
    // ═══════════════════════════════════════════════════════════
    function triggerSilentPreload(targetTime) {
      // Guard conditions
      if (stats.isSnappingBack) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(`[Preload] ⏳ Already snapping back, skipping`);
        }
        return false;
      }
      if (userInitiatedSeek) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(`[Preload] 👤 User seek in progress, skipping`);
        }
        return false;
      }
      if (originalVideo.paused) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(`[Preload] ⏸️ Video paused, skipping`);
        }
        return false;
      }
      if (originalVideo.readyState < 2) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] ⏳ Video not ready (readyState: ${originalVideo.readyState}), skipping`,
          );
        }
        return false;
      }

      const currentTime = originalVideo.currentTime;
      const duration = originalVideo.duration || Infinity;

      // Calculate safe target
      const safeTarget = Math.min(targetTime, duration - 5);
      const advance = safeTarget - currentTime;

      if (advance < BOOST_CONFIG.PRELOAD_MIN_ADVANCE) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] 📏 Advance too small (${advance.toFixed(1)}s < ${BOOST_CONFIG.PRELOAD_MIN_ADVANCE}s), skipping`,
          );
        }
        return false;
      }

      // Rate limit
      const timeSinceLastSeek = Date.now() - stats.lastPreloadSeek;
      if (timeSinceLastSeek < BOOST_CONFIG.PRELOAD_MIN_INTERVAL) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] ⏱️ Rate limited (${timeSinceLastSeek}ms < ${BOOST_CONFIG.PRELOAD_MIN_INTERVAL}ms), skipping`,
          );
        }
        return false;
      }

      // ─── EXECUTE SILENT PRELOAD ───
      stats.lastPreloadSeek = Date.now();
      stats.preloadSeeks++;
      stats.isSnappingBack = true;
      stats.userCurrentTime = currentTime;
      stats.seekTargetTime = safeTarget;

      console.log(
        `[Preload] 🔄 #${stats.preloadSeeks}: Silent seek ${currentTime.toFixed(1)}s → ${safeTarget.toFixed(1)}s ` +
          `(advance: ${advance.toFixed(1)}s, snapping back in ${BOOST_CONFIG.PRELOAD_SNAP_BACK_MS}ms)`,
      );

      // Record buffer state before seek
      const bufferBefore = getBufferAhead(originalVideo);
      const rangeBefore = getTotalBufferedRange(originalVideo);

      // ─── SEEK AHEAD ───
      try {
        originalVideo.currentTime = safeTarget;
      } catch (err) {
        console.error(`[Preload] ❌ Seek failed:`, err.message);
        stats.failedSeeks++;
        stats.isSnappingBack = false;
        return false;
      }

      // ─── SNAP BACK AFTER BRIEF DELAY ───
      seekSnapBackTimer = setTimeout(() => {
        seekSnapBackTimer = null;

        if (!document.body.contains(originalVideo)) {
          stats.isSnappingBack = false;
          return;
        }

        // Check if we're still at the target (seeking might have been slow)
        const currentPos = originalVideo.currentTime;
        const snapBackTarget = stats.userCurrentTime;

        console.log(
          `[Preload] ↩️ Snapping back: ${currentPos.toFixed(1)}s → ${snapBackTarget.toFixed(1)}s ` +
            `(was at target for ~${BOOST_CONFIG.PRELOAD_SNAP_BACK_MS}ms)`,
        );

        stats.lastSnapBack = Date.now();

        try {
          originalVideo.currentTime = snapBackTarget;
        } catch (err) {
          console.error(`[Preload] ❌ Snap-back failed:`, err.message);
          stats.failedSeeks++;
          stats.isSnappingBack = false;
          return;
        }

        // ─── CHECK RESULTS AFTER SNAP-BACK SETTLES ───
        setTimeout(() => {
          stats.isSnappingBack = false;
          stats.successfulSeeks++;

          const bufferAfter = getBufferAhead(originalVideo);
          const rangeAfter = getTotalBufferedRange(originalVideo);
          const bufferGrowth = rangeAfter.end - rangeBefore.end;

          console.log(
            `[Preload] ✅ #${stats.preloadSeeks} complete | ` +
              `Buffer: ${bufferBefore.toFixed(1)}s → ${bufferAfter.toFixed(1)}s ` +
              `(${bufferGrowth > 0 ? "+" : ""}${bufferGrowth.toFixed(1)}s) | ` +
              `Range: ${rangeBefore.start.toFixed(1)}–${rangeBefore.end.toFixed(1)} → ` +
              `${rangeAfter.start.toFixed(1)}–${rangeAfter.end.toFixed(1)}`,
          );

          // If buffer didn't grow, the browser might not support this technique
          if (
            bufferGrowth <= 0 &&
            stats.preloadSeeks >= 5 &&
            stats.successfulSeeks <= 2
          ) {
            console.warn(
              `[Preload] ⚠️ Buffer not growing after ${stats.preloadSeeks} seeks. ` +
                `Browser may not support silent preload technique. ` +
                `Consider falling back to micro-boost approach.`,
            );
          }
        }, 500);
      }, BOOST_CONFIG.PRELOAD_SNAP_BACK_MS);

      // ─── SAFETY TIMEOUT ───
      // If snap-back timer doesn't fire for some reason, force cleanup
      seekTimeoutTimer = setTimeout(() => {
        if (stats.isSnappingBack) {
          console.warn(`[Preload] ⚠️ Safety timeout - forcing snap-back`);
          if (seekSnapBackTimer) {
            clearTimeout(seekSnapBackTimer);
            seekSnapBackTimer = null;
          }
          try {
            originalVideo.currentTime = stats.userCurrentTime;
          } catch (err) {
            console.error(`[Preload] ❌ Safety snap-back failed:`, err.message);
          }
          stats.isSnappingBack = false;
          stats.failedSeeks++;
        }
        seekTimeoutTimer = null;
      }, BOOST_CONFIG.PRELOAD_SNAP_BACK_MS + 2000);

      return true;
    }

    // ═══════════════════════════════════════════════════════════
    // MONITOR LOOP
    // ═══════════════════════════════════════════════════════════
    let monitorIteration = 0;

    const monitorInterval = setInterval(() => {
      monitorIteration++;

      // Clean up if video removed from DOM
      if (!document.body.contains(originalVideo)) {
        console.log(
          `[Preload] 🗑️ Video removed from DOM, cleaning up for ${videoId}`,
        );
        clearInterval(monitorInterval);
        return;
      }

      // Skip if snapping back
      if (stats.isSnappingBack) return;

      // Skip if paused
      if (originalVideo.paused) return;

      // Skip if user is seeking
      if (userInitiatedSeek) return;

      const mainBuffer = getBufferAhead(originalVideo);
      const mainTime = originalVideo.currentTime;
      const mainDuration = originalVideo.duration || Infinity;

      // ─── Log status every 10 iterations ───
      if (monitorIteration % 10 === 0) {
        const buffered = getTotalBufferedRange(originalVideo);
        const bufferPercent =
          mainDuration > 0
            ? (((buffered.end - buffered.start) / mainDuration) * 100).toFixed(
                1,
              )
            : "?";
        console.log(
          `[Preload] 📊 Status #${monitorIteration} | ` +
            `Time: ${mainTime.toFixed(1)}s/${mainDuration.toFixed(1)}s | ` +
            `Buffer ahead: ${mainBuffer.toFixed(1)}s | ` +
            `Total buffered: ${buffered.start.toFixed(1)}–${buffered.end.toFixed(1)} (${bufferPercent}%) | ` +
            `Seeks: ${stats.preloadSeeks} (${stats.successfulSeeks} ok, ${stats.failedSeeks} fail) | ` +
            `Snapping: ${stats.isSnappingBack ? "🔄" : "✅"}`,
        );
        stats.lastLogTime = Date.now();
      }

      // ─── DECISION: Trigger preload? ───
      const needsMoreBuffer = mainBuffer < BOOST_CONFIG.PRELOAD_STOP_AT_BUFFER;
      const hasRoomToGrow = mainTime + mainBuffer < mainDuration - 5;

      if (needsMoreBuffer && hasRoomToGrow) {
        const targetTime = Math.min(
          mainTime + BOOST_CONFIG.PRELOAD_ADVANCE_SEEK,
          Math.min(mainTime + BOOST_CONFIG.PRELOAD_MAX_AHEAD, mainDuration - 5),
        );

        if (targetTime > mainTime + mainBuffer) {
          // Target is beyond current buffer end → preload would help
          const urgency =
            mainBuffer < BOOST_CONFIG.MIN_FORWARD_BUFFER
              ? "🔴"
              : mainBuffer < BOOST_CONFIG.BUFFER_LOW
                ? "🟡"
                : "🟢";
          if (BOOST_CONFIG.DEBUG_PRELOAD) {
            console.log(
              `[Preload] ${urgency} Buffer ${mainBuffer.toFixed(1)}s < ${BOOST_CONFIG.PRELOAD_STOP_AT_BUFFER}s, ` +
                `triggering preload → target: ${targetTime.toFixed(1)}s`,
            );
          }
          triggerSilentPreload(targetTime);
        }
      }
    }, BOOST_CONFIG.PRELOAD_SYNC_INTERVAL);

    console.log(
      `[Preload] ✅ Silent preload manager initialized for ${videoId} | ` +
        `Sync: ${BOOST_CONFIG.PRELOAD_SYNC_INTERVAL}ms | ` +
        `Advance: ${BOOST_CONFIG.PRELOAD_ADVANCE_SEEK}s | ` +
        `Snap-back: ${BOOST_CONFIG.PRELOAD_SNAP_BACK_MS}ms`,
    );

    // ═══════════════════════════════════════════════════════════
    // RETURN CONTROLLER
    // ═══════════════════════════════════════════════════════════
    return {
      cleanup: () => {
        console.log(
          `[Preload] 🧹 Cleaning up for ${videoId} | ` +
            `Total seeks: ${stats.preloadSeeks} (${stats.successfulSeeks} ok, ${stats.failedSeeks} fail)`,
        );
        clearInterval(monitorInterval);
        if (seekSnapBackTimer) clearTimeout(seekSnapBackTimer);
        if (seekTimeoutTimer) clearTimeout(seekTimeoutTimer);
        if (userSeekTimeout) clearTimeout(userSeekTimeout);
        originalVideo.removeEventListener("seeking", onUserSeeking);
        originalVideo.removeEventListener("seeked", onUserSeeked);
        originalVideo.preload = originalPreload; // Restore original
      },
      getStats: () => ({ ...stats }),
      triggerSilentPreload,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOST STATE STORAGE
  // ═══════════════════════════════════════════════════════════════
  const boostTimers = new WeakMap();

  function createBoostState(video) {
    return {
      isBoosting: false,
      boostStartTime: 0,
      boostTargetRate: 1.0,
      currentBoostLevel: "none",
      boostSessionCount: 0,
      totalBoostTime: 0,
      lastBoostEndTime: 0,
      originalRate: video.playbackRate || 1.0,
      connectionQuality: 1.0,
      lastBufferCheck: Date.now(),
      lastBufferAhead: 0,
      lastBufferGrowth: 0,
      consecutiveShrinks: 0,
      playStartTime: 0,
      totalPlayTime: 0,
      isRealPlay: false,
      lastSeekTime: 0,
      seekDebounceTimer: null,
      monitorInterval: null,
      boostTimeout: null,
      lastDebugTime: 0,
      hasInitialBoosted: false,
      maintenanceMode: false,
      maintenanceStartTime: 0,
      maintenanceOffTime: 0,
      bufferWarningCount: 0,
      lastBufferZeroTime: 0,
      emergencyBoostActive: false,
      lastBufferBeforePause: 0,
      pauseResumeCount: 0,
      preloadManager: null,
    };
  }

  function getBoostState(video) {
    if (!video) return null;
    let state = boostTimers.get(video);
    if (!state) {
      state = createBoostState(video);
      boostTimers.set(video, state);
    }
    return state;
  }

  // ═══════════════════════════════════════════════════════════════
  // ADAPTIVE RATE CALCULATION (kept for logging/reference only)
  // ═══════════════════════════════════════════════════════════════
  function calculateOptimalBoostRate(
    bufferAhead,
    isSeek = false,
    connectionQuality = 1.0,
  ) {
    if (bufferAhead < BOOST_CONFIG.MIN_FORWARD_BUFFER) {
      const criticalRatio = bufferAhead / BOOST_CONFIG.MIN_FORWARD_BUFFER;
      const rate =
        BOOST_CONFIG.BOOST_RATE_AGGRESSIVE -
        (BOOST_CONFIG.BOOST_RATE_AGGRESSIVE - BOOST_CONFIG.BOOST_RATE_NORMAL) *
          criticalRatio;
      return {
        rate: Math.max(BOOST_CONFIG.BOOST_RATE_NORMAL, rate),
        level: "aggressive",
        emergency: bufferAhead < 2,
      };
    }
    if (bufferAhead < BOOST_CONFIG.BUFFER_LOW) {
      const ratio =
        (bufferAhead - BOOST_CONFIG.MIN_FORWARD_BUFFER) /
        (BOOST_CONFIG.BUFFER_LOW - BOOST_CONFIG.MIN_FORWARD_BUFFER);
      const rate =
        BOOST_CONFIG.BOOST_RATE_NORMAL -
        (BOOST_CONFIG.BOOST_RATE_NORMAL - BOOST_CONFIG.BOOST_RATE_GENTLE) *
          Math.pow(ratio, 0.5);
      return {
        rate: Math.max(BOOST_CONFIG.BOOST_RATE_GENTLE, rate),
        level: "normal",
      };
    }
    if (bufferAhead < BOOST_CONFIG.BUFFER_COMFORT) {
      const ratio =
        (bufferAhead - BOOST_CONFIG.BUFFER_LOW) /
        (BOOST_CONFIG.BUFFER_COMFORT - BOOST_CONFIG.BUFFER_LOW);
      const rate =
        BOOST_CONFIG.BOOST_RATE_GENTLE -
        (BOOST_CONFIG.BOOST_RATE_GENTLE - BOOST_CONFIG.BOOST_RATE_MAINTENANCE) *
          Math.pow(ratio, 0.7);
      return {
        rate: Math.max(BOOST_CONFIG.BOOST_RATE_MAINTENANCE, rate),
        level: "gentle",
      };
    }
    if (bufferAhead < BOOST_CONFIG.BUFFER_TARGET) {
      return {
        rate: BOOST_CONFIG.BOOST_RATE_MAINTENANCE,
        level: "maintenance",
      };
    }
    return { rate: 1.0, level: "none" };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONNECTION QUALITY DETECTION
  // ═══════════════════════════════════════════════════════════════
  function updateConnectionQuality(video, state) {
    if (!video || !state) return;
    const now = Date.now();
    const timeSinceLastCheck = now - state.lastBufferCheck;
    if (timeSinceLastCheck < BOOST_CONFIG.CONNECTION_CHECK_WINDOW) return;

    const currentBufferAhead = getBufferAhead(video);
    const bufferGrowth = currentBufferAhead - state.lastBufferAhead;
    const growthRate =
      timeSinceLastCheck > 0 ? bufferGrowth / (timeSinceLastCheck / 1000) : 0;
    state.lastBufferGrowth = growthRate;

    if (state.isBoosting && growthRate < -0.1) {
      state.consecutiveShrinks++;
    } else if (state.isBoosting && growthRate > 0.1) {
      state.consecutiveShrinks = Math.max(0, state.consecutiveShrinks - 2);
    } else if (!state.isBoosting) {
      state.consecutiveShrinks = 0;
    }

    const newQuality = Math.max(0.1, Math.min(2.0, Math.abs(growthRate) + 0.5));
    state.connectionQuality = state.connectionQuality * 0.7 + newQuality * 0.3;
    state.lastBufferCheck = now;
    state.lastBufferAhead = currentBufferAhead;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTINUOUS BUFFER MONITOR (preload-aware)
  // ═══════════════════════════════════════════════════════════════
  function startContinuousBufferMonitor(video) {
    if (!video || video.dataset.continuousMonitorActive === "true") {
      return () => {};
    }
    video.dataset.continuousMonitorActive = "true";
    const state = getBoostState(video);

    console.log(
      `[Boost] 🚀 Monitor attached | Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | ` +
        `Comfort: ${BOOST_CONFIG.BUFFER_COMFORT}s | Target: ${BOOST_CONFIG.BUFFER_TARGET}s | ` +
        `Preload: ${BOOST_CONFIG.PRELOAD_ENABLED ? "✅ ON" : "❌ OFF"}`,
    );

    if (!video.__trueOriginalPlaybackRate) {
      video.__trueOriginalPlaybackRate = video.playbackRate || 1.0;
      state.originalRate = video.__trueOriginalPlaybackRate;
    }

    const monitorInterval = setInterval(() => {
      if (typeof tabIsVisible !== "undefined" && !tabIsVisible) return;
      if (video.paused) return;

      const ahead = getBufferAhead(video);
      const state = getBoostState(video);
      if (!state) return;

      updateConnectionQuality(video, state);
      if (state.playStartTime > 0) {
        state.totalPlayTime += BOOST_CONFIG.MONITOR_INTERVAL;
      }

      const now = Date.now();
      const isBelowMinimum = ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER;

      // Debug log (every 5s or when below minimum)
      if (now - state.lastDebugTime > 5000 || isBelowMinimum) {
        state.lastDebugTime = now;
        const preloadStats = state.preloadManager?.getStats?.();
        const preloadInfo = preloadStats
          ? `Seeks: ${preloadStats.preloadSeeks} (${preloadStats.successfulSeeks}✓)`
          : "Preload: N/A";
        console.log(
          `[Boost] 📊 Buffer: ${ahead.toFixed(1)}s${isBelowMinimum ? " ⚠️BELOW MIN" : ""} | ` +
            `Rate: ${video.playbackRate.toFixed(2)}x | Play: ${(state.totalPlayTime / 1000).toFixed(0)}s | ` +
            `${preloadInfo}`,
        );
      }

      // Log warnings when buffer critically low
      if (isBelowMinimum) {
        state.bufferWarningCount++;
        if (state.bufferWarningCount % 10 === 0) {
          console.warn(
            `[Boost] ⚠️ Buffer critically low: ${ahead.toFixed(1)}s | ` +
              `Warning #${state.bufferWarningCount} | ` +
              `Preload seeks attempted: ${state.preloadManager?.getStats?.()?.preloadSeeks || 0}`,
          );
        }
      }

      // Ensure playback rate stays at 1.0 (no fast-forward)
      if (video.playbackRate !== 1.0 && !state.isBoosting) {
        // video.playbackRate = 1.0;  // Still commented out - preload handles it
      }
    }, BOOST_CONFIG.MONITOR_INTERVAL);

    state.monitorInterval = monitorInterval;

    return () => {
      clearInterval(monitorInterval);
      state.monitorInterval = null;
      delete video.dataset.continuousMonitorActive;
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOST APPLICATION (no-op - preload handles everything)
  // ═══════════════════════════════════════════════════════════════
  function applyForwardBoost(video, targetRate, level, reason = "unknown") {
    // NOTE: playbackRate modification is intentionally disabled.
    // Silent preload seeks handle buffer growth without UX impact.
    return false;
  }

  function stopForwardBoost(video, reason = "target reached") {
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // SEEK BOOST HANDLER
  // ═══════════════════════════════════════════════════════════════
  function boostBufferAfterSeek(video) {
    if (!video || video.paused) return;
    if (typeof tabIsVisible !== "undefined" && !tabIsVisible) return;

    const state = getBoostState(video);
    if (!state) return;

    if (state.seekDebounceTimer) clearTimeout(state.seekDebounceTimer);

    state.seekDebounceTimer = setTimeout(() => {
      const ahead = getBufferAhead(video);
      console.log(`[Boost] 🎯 Seek settled | Buffer: ${ahead.toFixed(1)}s`);

      // Trigger immediate preload if buffer is low after seek
      if (
        ahead < BOOST_CONFIG.BUFFER_COMFORT &&
        state.preloadManager?.triggerSilentPreload
      ) {
        const targetTime = Math.min(
          video.currentTime + BOOST_CONFIG.PRELOAD_ADVANCE_SEEK,
          (video.duration || Infinity) - 5,
        );
        console.log(
          `[Boost] 🎯 Post-seek preload trigger → ${targetTime.toFixed(1)}s`,
        );
        state.preloadManager.triggerSilentPreload(targetTime);
      }
      state.seekDebounceTimer = null;
    }, BOOST_CONFIG.SEEK_DEBOUNCE_MS);
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP FUNCTIONS
  // ═══════════════════════════════════════════════════════════════
  function cleanupBoost(video) {
    if (!video) return;
    const state = boostTimers.get(video);
    if (state) {
      if (state.monitorInterval) clearInterval(state.monitorInterval);
      if (state.boostTimeout) clearTimeout(state.boostTimeout);
      if (state.seekDebounceTimer) clearTimeout(state.seekDebounceTimer);
      if (state.preloadManager) {
        state.preloadManager.cleanup();
        state.preloadManager = null;
      }
      boostTimers.delete(video);
    }
    [
      "__trueOriginalPlaybackRate",
      "__originalPlaybackRate",
      "__boostTargetRate",
      "__boostStartTime",
      "__boostExtensionCount",
      "__boostBaseDuration",
      "__hasBoostedOnLoad",
      "__lastSeekTime",
      "__lastPlayTime",
      "__boostState",
    ].forEach((attr) => delete video[attr]);
    delete video.dataset.continuousMonitorActive;
    delete video.dataset.boostAttached;
  }

  function cleanupPreviewBoost(previewVideo) {
    if (previewVideo) {
      delete previewVideo.__previewOriginalRate;
      delete previewVideo.__previewBoostActive;
      delete previewVideo.__previewBoostStartTime;
    }
  }

  function boostPreviewBuffer(previewVideo) {
    return () => {};
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN BOOST ATTACHMENT (with silent preload manager)
  // ═══════════════════════════════════════════════════════════════
  function attachBoostToVideo(video) {
    if (!video || video.dataset.boostAttached === "true") return () => {};
    video.dataset.boostAttached = "true";
    const videoId = video.dataset.videoObserverId || "unknown";

    console.log(
      `[Boost] 🔗 Attached to ${videoId} | Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | ` +
        `Preload: ${BOOST_CONFIG.PRELOAD_ENABLED ? "✅ Silent Seek" : "❌ Off"}`,
    );

    // Start silent preload manager (no fast-forward, no second video element)
    const preloadManager = createSilentPreloadManager(video);

    // Store preload manager in state for monitoring
    const state = getBoostState(video);
    if (state) {
      state.preloadManager = preloadManager;
    }

    const stopMonitor = startContinuousBufferMonitor(video);

    const onPlay = () => {
      const state = getBoostState(video);
      if (!state) return;
      state.playStartTime = Date.now();
      video.__lastPlayTime = Date.now();

      const isBufferManager = video.dataset.bufferManagerBuffering === "true";
      const isChunkLoop = video.dataset.chunkLoopActive === "true";
      state.isRealPlay = !isBufferManager && !isChunkLoop;

      const ahead = getBufferAhead(video);
      state.lastBufferAhead = ahead;

      if (state.isRealPlay) {
        console.log(
          `[Boost] ▶️ Real play started for ${videoId} | Buffer: ${ahead.toFixed(1)}s`,
        );
      }
    };

    const onPause = () => {
      const state = getBoostState(video);
      if (!state) return;

      if (state.playStartTime > 0) {
        state.totalPlayTime += Date.now() - state.playStartTime;
        state.playStartTime = 0;
      }

      const ahead = getBufferAhead(video);
      state.lastBufferBeforePause = ahead;
      state.lastBufferAhead = ahead;

      if (ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER) {
        console.log(
          `[Boost] ⚠️ Pausing with buffer below minimum: ${ahead.toFixed(1)}s`,
        );
      }
    };

    const onSeeking = () => {
      video.__lastSeekTime = Date.now();
    };

    const onSeeked = () => {
      video.__lastSeekTime = Date.now();
      const ahead = getBufferAhead(video);
      console.log(`[Boost] 🎯 Seeked | Buffer: ${ahead.toFixed(1)}s`);

      // Trigger preload after user seek
      if (typeof tabIsVisible === "undefined" || tabIsVisible) {
        boostBufferAfterSeek(video);
      }
    };

    const onEnded = () => {
      console.log(`[Boost] 🏁 Video ended for ${videoId}`);
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ended", onEnded);

    return () => {
      console.log(`[Boost] 🔌 Detached from ${videoId}`);
      stopMonitor();
      if (preloadManager) preloadManager.cleanup();
      cleanupBoost(video);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("ended", onEnded);
      [
        "boostAttached",
        "__lastSeekTime",
        "__lastPlayTime",
        "__trueOriginalPlaybackRate",
        "__hasBoostedOnLoad",
      ].forEach((attr) => {
        if (attr.startsWith("__")) delete video[attr];
        else delete video.dataset[attr];
      });
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // GLOBAL API
  // ═══════════════════════════════════════════════════════════════
  window.BoostEngine = {
    attachBoostToVideo,
    cleanupBoost,
    getBufferAhead,
    startContinuousBufferMonitor,
    boostBufferAfterSeek,
    boostPreviewBuffer,
    cleanupPreviewBoost,
    config: BOOST_CONFIG,
    getBoostState,
    createSilentPreloadManager,
  };

  console.log("[Boost] ✅ v2.7 Ready - Silent Preload Seek Mode");
  console.log(
    `[Boost] Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | Target: ${BOOST_CONFIG.BUFFER_TARGET}s`,
  );
  console.log(
    `[Boost] Preload: ${BOOST_CONFIG.PRELOAD_ENABLED ? "✅ Silent Seek (no fast-forward)" : "❌ Disabled"}`,
  );
  console.log(
    `[Boost] Snap-back: ${BOOST_CONFIG.PRELOAD_SNAP_BACK_MS}ms | Advance: ${BOOST_CONFIG.PRELOAD_ADVANCE_SEEK}s`,
  );
}
