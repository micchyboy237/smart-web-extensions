// boost.js - Forward Buffer Boost Engine (v2.3 - FINAL OPTIMIZED)
// Standalone module for smart buffer management
// Features: Forward-only boost, adaptive rates, continuous buffer maintenance
// ═══════════════════════════════════════════════════════════════

// Prevent double initialization
if (window.__BOOST_ENGINE_INITIALIZED__) {
  console.warn("[Boost] Engine already initialized, skipping");
} else {
  window.__BOOST_ENGINE_INITIALIZED__ = true;

  // ═══════════════════════════════════════════════════════════════
  // BOOST CONFIGURATION
  // ═══════════════════════════════════════════════════════════════
  const BOOST_CONFIG = {
    // Buffer thresholds
    BUFFER_CRITICAL: 2, // Critical low - emergency boost
    BUFFER_LOW: 8, // Start boosting below this
    BUFFER_COMFORT: 15, // Comfortable buffer - stop aggressive boost
    BUFFER_TARGET: 20, // Ideal buffer - maintain this

    // Boost timing
    BOOST_DURATION: 30000, // Max single boost duration (30s)
    MONITOR_INTERVAL: 1500, // Check every 1.5s
    BOOST_SESSION_GAP: 3000, // Minimum gap between boost sessions (3s)

    // Boost rates (forward only, >= 1.0)
    BOOST_RATE_AGGRESSIVE: 1.25, // Critical buffer (0-2s)
    BOOST_RATE_NORMAL: 1.25, // Low buffer (2-8s)
    BOOST_RATE_GENTLE: 1.25, // Comfort buffer (8-15s)
    BOOST_RATE_MAINTENANCE: 1.25, // Target buffer (15-20s) - barely perceptible
    BOOST_RATE_SEEK: 1.25, // Post-seek recovery

    // Seek handling
    SEEK_DEBOUNCE_MS: 800,

    // Limits
    MAX_BOOST_SESSIONS: 25,
    MAX_TOTAL_BOOST_MS: 180000, // 3 minutes total

    // Connection quality detection
    SLOW_CONNECTION_THRESHOLD: 0.3,
    CONNECTION_CHECK_WINDOW: 4000,

    // Smart detection
    MIN_PLAY_TIME_FOR_BOOST: 1000, // Reduced from 2s to 1s
    SHRINK_TOLERANCE: 4, // Allow 4 checks of shrinking

    // Maintenance mode
    MAINTENANCE_MAX_DURATION: 90000, // Max 90s of maintenance before cycling off
    MAINTENANCE_RESTART_DELAY: 10000, // Wait 10s before restarting maintenance

    // Debug
    DEBUG_VERBOSE: false,
  };

  // ═══════════════════════════════════════════════════════════════
  // BOOST STATE STORAGE
  // ═══════════════════════════════════════════════════════════════
  const boostTimers = new WeakMap();

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

  function getEffectiveBufferRatio(video) {
    if (!video || !video.buffered || !video.buffered.length) return 0;

    let totalBuffered = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      totalBuffered += video.buffered.end(i) - video.buffered.start(i);
    }

    const ahead = getBufferAhead(video);
    return totalBuffered > 0 ? Math.min(1, ahead / totalBuffered) : 1;
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOST STATE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  function createBoostState(video) {
    return {
      isBoosting: false,
      boostStartTime: 0,
      boostTargetRate: 1.0,
      currentBoostLevel: "none", // 'none', 'maintenance', 'gentle', 'normal', 'aggressive'

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
      isRealPlay: false, // NEW: Flag for real user playback

      lastSeekTime: 0,
      seekDebounceTimer: null,

      monitorInterval: null,
      boostTimeout: null,

      lastDebugTime: 0,
      hasInitialBoosted: false,

      maintenanceMode: false,
      maintenanceStartTime: 0,
      maintenanceOffTime: 0, // NEW: Track when maintenance was last turned off
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
  // ADAPTIVE RATE CALCULATION (PROACTIVE)
  // ═══════════════════════════════════════════════════════════════

  function calculateOptimalBoostRate(
    bufferAhead,
    isSeek = false,
    connectionQuality = 1.0,
  ) {
    const isSlow = connectionQuality < BOOST_CONFIG.SLOW_CONNECTION_THRESHOLD;

    // CRITICAL: 0-2s
    if (bufferAhead < BOOST_CONFIG.BUFFER_CRITICAL) {
      return {
        rate: isSeek
          ? BOOST_CONFIG.BOOST_RATE_SEEK
          : BOOST_CONFIG.BOOST_RATE_AGGRESSIVE,
        level: "aggressive",
      };
    }

    // LOW: 2-8s
    if (bufferAhead < BOOST_CONFIG.BUFFER_LOW) {
      return {
        rate: isSeek
          ? BOOST_CONFIG.BOOST_RATE_SEEK
          : BOOST_CONFIG.BOOST_RATE_NORMAL,
        level: "normal",
      };
    }

    // COMFORT: 8-15s - scale between NORMAL and GENTLE
    if (bufferAhead < BOOST_CONFIG.BUFFER_COMFORT) {
      const ratio =
        (bufferAhead - BOOST_CONFIG.BUFFER_LOW) /
        (BOOST_CONFIG.BUFFER_COMFORT - BOOST_CONFIG.BUFFER_LOW);
      // Exponential scaling for smoother transition
      const rate =
        BOOST_CONFIG.BOOST_RATE_NORMAL -
        (BOOST_CONFIG.BOOST_RATE_NORMAL - BOOST_CONFIG.BOOST_RATE_GENTLE) *
          Math.pow(ratio, 0.7);
      return {
        rate: Math.max(BOOST_CONFIG.BOOST_RATE_GENTLE, rate),
        level: "gentle",
      };
    }

    // TARGET: 15-20s - maintenance boost
    if (bufferAhead < BOOST_CONFIG.BUFFER_TARGET) {
      return {
        rate: BOOST_CONFIG.BOOST_RATE_MAINTENANCE,
        level: "maintenance",
      };
    }

    // Buffer sufficient (20s+)
    return { rate: 1.0, level: "none" };
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOST APPLICATION & CONTROL
  // ═══════════════════════════════════════════════════════════════

  function canBoost(state, isNewSession = true) {
    const now = Date.now();

    if (isNewSession) {
      if (state.boostSessionCount >= BOOST_CONFIG.MAX_BOOST_SESSIONS)
        return false;
      if (state.totalBoostTime >= BOOST_CONFIG.MAX_TOTAL_BOOST_MS) return false;

      if (state.lastBoostEndTime > 0) {
        const timeSinceLastSession = now - state.lastBoostEndTime;
        if (timeSinceLastSession < BOOST_CONFIG.BOOST_SESSION_GAP) return false;
      }

      // Check play time - but be more lenient
      if (
        state.totalPlayTime < BOOST_CONFIG.MIN_PLAY_TIME_FOR_BOOST &&
        !state.isRealPlay
      ) {
        return false;
      }
    }

    // Special case: maintenance mode can restart after delay
    if (
      state.maintenanceOffTime > 0 &&
      now - state.maintenanceOffTime < BOOST_CONFIG.MAINTENANCE_RESTART_DELAY
    ) {
      // Allow non-maintenance boosts, but block maintenance restart
      // This is checked in the apply function
    }

    return true;
  }

  function applyForwardBoost(video, targetRate, level, reason = "unknown") {
    if (!video || video.paused) return false;

    const state = getBoostState(video);
    if (!state) return false;

    const currentRate = video.playbackRate;

    // If already boosting, adjust rate if needed
    if (state.isBoosting) {
      if (Math.abs(currentRate - targetRate) < 0.015) return true;

      video.playbackRate = targetRate;
      state.boostTargetRate = targetRate;
      state.currentBoostLevel = level;

      if (level === "maintenance") {
        state.maintenanceMode = true;
        state.maintenanceStartTime = Date.now();
      }

      if (BOOST_CONFIG.DEBUG_VERBOSE) {
        console.log(
          `[Boost] 🔄 Adjust: ${currentRate.toFixed(2)}x → ${targetRate.toFixed(2)}x (${level})`,
        );
      }
      return true;
    }

    // Check if maintenance mode can restart
    if (level === "maintenance" && state.maintenanceOffTime > 0) {
      const now = Date.now();
      if (
        now - state.maintenanceOffTime <
        BOOST_CONFIG.MAINTENANCE_RESTART_DELAY
      ) {
        if (BOOST_CONFIG.DEBUG_VERBOSE) {
          console.log(
            `[Boost:D] Maintenance restart delayed (${((BOOST_CONFIG.MAINTENANCE_RESTART_DELAY - (now - state.maintenanceOffTime)) / 1000).toFixed(0)}s)`,
          );
        }
        // Allow the boost anyway if buffer is low enough
        if (level !== "maintenance") {
          // Continue to boost
        } else {
          return false;
        }
      }
    }

    if (!canBoost(state, true)) return false;
    if (currentRate >= targetRate - 0.01) return false;

    // APPLY THE BOOST
    video.playbackRate = targetRate;

    state.isBoosting = true;
    state.boostStartTime = Date.now();
    state.boostTargetRate = targetRate;
    state.currentBoostLevel = level;
    state.boostSessionCount++;
    state.maintenanceOffTime = 0; // Reset maintenance off timer

    if (level === "maintenance") {
      state.maintenanceMode = true;
      state.maintenanceStartTime = Date.now();
    }

    const ahead = getBufferAhead(video);
    console.log(
      `[Boost] ⚡ #${state.boostSessionCount}: ${currentRate.toFixed(2)}x → ${targetRate.toFixed(2)}x | ` +
        `${level.toUpperCase()} | ${reason} | Buffer: ${ahead.toFixed(1)}s | ` +
        `Play: ${(state.totalPlayTime / 1000).toFixed(0)}s`,
    );

    return true;
  }

  function stopForwardBoost(video, reason = "target reached") {
    if (!video) return;

    const state = getBoostState(video);
    if (!state || !state.isBoosting) return;

    const previousRate = video.playbackRate;
    const normalRate = state.originalRate;

    if (Math.abs(previousRate - normalRate) > 0.01) {
      video.playbackRate = normalRate;

      const boostDuration = Date.now() - state.boostStartTime;
      state.totalBoostTime += boostDuration;
      state.lastBoostEndTime = Date.now();

      // Track maintenance off time
      if (state.maintenanceMode) {
        state.maintenanceOffTime = Date.now();
      }

      console.log(
        `[Boost] ⏹️ Stopped: ${previousRate.toFixed(2)}x → ${normalRate.toFixed(2)}x | ` +
          `${reason} | Duration: ${(boostDuration / 1000).toFixed(1)}s | ` +
          `Total: ${(state.totalBoostTime / 1000).toFixed(1)}s`,
      );
    }

    state.isBoosting = false;
    state.boostTargetRate = normalRate;
    state.currentBoostLevel = "none";
    state.maintenanceMode = false;
    state.consecutiveShrinks = 0;
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

    // Track consecutive shrinks (only when actively boosting)
    if (state.isBoosting && growthRate < -0.1) {
      state.consecutiveShrinks++;
    } else if (state.isBoosting && growthRate > 0.1) {
      state.consecutiveShrinks = Math.max(0, state.consecutiveShrinks - 2);
    } else if (!state.isBoosting) {
      state.consecutiveShrinks = 0;
    }

    // Update connection quality with smoothing
    const newQuality = Math.max(0.1, Math.min(2.0, Math.abs(growthRate) + 0.5));
    state.connectionQuality = state.connectionQuality * 0.7 + newQuality * 0.3;

    state.lastBufferCheck = now;
    state.lastBufferAhead = currentBufferAhead;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTINUOUS BUFFER MONITOR (FINAL OPTIMIZED)
  // ═══════════════════════════════════════════════════════════════

  function startContinuousBufferMonitor(video) {
    if (!video || video.dataset.continuousMonitorActive === "true") {
      return () => {};
    }

    video.dataset.continuousMonitorActive = "true";

    const state = getBoostState(video);

    console.log(
      `[Boost] 🚀 Monitor attached | Comfort: ${BOOST_CONFIG.BUFFER_COMFORT}s | ` +
        `Target: ${BOOST_CONFIG.BUFFER_TARGET}s | Maint: ${BOOST_CONFIG.BOOST_RATE_MAINTENANCE}x`,
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

      // Update connection quality
      updateConnectionQuality(video, state);

      // Update play time tracking
      if (state.playStartTime > 0) {
        state.totalPlayTime += BOOST_CONFIG.MONITOR_INTERVAL;
      }

      // Periodic debug log
      const now = Date.now();
      if (now - state.lastDebugTime > 5000) {
        state.lastDebugTime = now;
        console.log(
          `[Boost] 📊 Buffer: ${ahead.toFixed(1)}s | Rate: ${video.playbackRate.toFixed(2)}x | ` +
            `Level: ${state.currentBoostLevel} | Sessions: ${state.boostSessionCount} | ` +
            `Play: ${(state.totalPlayTime / 1000).toFixed(0)}s`,
        );
      }

      // ============================================================
      // PROACTIVE BUFFER MANAGEMENT
      // ============================================================

      const { rate: optimalRate, level } = calculateOptimalBoostRate(
        ahead,
        false,
        state.connectionQuality,
      );

      if (optimalRate > 1.0) {
        // Need boost
        if (!state.isBoosting) {
          applyForwardBoost(video, optimalRate, level, `buffer ${level}`);
        } else if (Math.abs(video.playbackRate - optimalRate) > 0.015) {
          // Adjust existing boost
          applyForwardBoost(video, optimalRate, level, `adjust to ${level}`);
        }
      } else {
        // Buffer sufficient - stop if boosting
        if (state.isBoosting) {
          stopForwardBoost(video, "buffer sufficient");
        }
      }

      // SAFETY CHECKS (only when boosting)
      if (state.isBoosting) {
        // Duration limit
        if (now - state.boostStartTime > BOOST_CONFIG.BOOST_DURATION) {
          console.log(
            `[Boost] ⚠️ Max duration (${BOOST_CONFIG.BOOST_DURATION / 1000}s)`,
          );
          stopForwardBoost(video, "duration exceeded");
        }
        // Buffer shrinking persistently
        else if (state.consecutiveShrinks >= BOOST_CONFIG.SHRINK_TOLERANCE) {
          console.log(
            `[Boost] ⚠️ Buffer shrinking (${state.consecutiveShrinks})`,
          );
          stopForwardBoost(video, "buffer shrinking");
        }
        // Maintenance mode too long
        else if (
          state.maintenanceMode &&
          now - state.maintenanceStartTime >
            BOOST_CONFIG.MAINTENANCE_MAX_DURATION
        ) {
          console.log(
            `[Boost] ⚠️ Maintenance cycle (${BOOST_CONFIG.MAINTENANCE_MAX_DURATION / 1000}s)`,
          );
          stopForwardBoost(video, "maintenance cycle");
        }
      }

      // Safety: rate never below 1.0
      if (video.playbackRate < 0.99 && !state.isBoosting) {
        video.playbackRate = state.originalRate;
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

      if (ahead < BOOST_CONFIG.BUFFER_COMFORT) {
        const { rate, level } = calculateOptimalBoostRate(
          ahead,
          true,
          state.connectionQuality,
        );

        if (rate > 1.0) {
          applyForwardBoost(video, rate, level, "seek recovery");
        }
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

      if (state.isBoosting) {
        video.playbackRate = state.originalRate;
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
  // MAIN BOOST ATTACHMENT
  // ═══════════════════════════════════════════════════════════════

  function attachBoostToVideo(video) {
    if (!video || video.dataset.boostAttached === "true") {
      return () => {};
    }

    video.dataset.boostAttached = "true";

    const videoId = video.dataset.videoObserverId || "unknown";
    console.log(`[Boost] 🔗 Attached to ${videoId}`);

    const stopMonitor = startContinuousBufferMonitor(video);

    const onPlay = () => {
      const state = getBoostState(video);
      if (!state) return;

      state.playStartTime = Date.now();
      video.__lastPlayTime = Date.now();

      // Detect if this is a real user play (not BufferManager preload)
      const isBufferManager = video.dataset.bufferManagerBuffering === "true";
      const isChunkLoop = video.dataset.chunkLoopActive === "true";
      state.isRealPlay = !isBufferManager && !isChunkLoop;

      const ahead = getBufferAhead(video);

      // Initial boost on first real play
      if (
        !state.hasInitialBoosted &&
        state.isRealPlay &&
        ahead < BOOST_CONFIG.BUFFER_COMFORT
      ) {
        state.hasInitialBoosted = true;
        // Set minimum play time so boost can start immediately
        state.totalPlayTime = Math.max(
          state.totalPlayTime,
          BOOST_CONFIG.MIN_PLAY_TIME_FOR_BOOST,
        );

        console.log(`[Boost] 🆕 Initial boost for ${videoId}`);
        applyForwardBoost(
          video,
          BOOST_CONFIG.BOOST_RATE_NORMAL,
          "normal",
          "initial play",
        );
      }

      // Safety check
      if (!state.isBoosting) {
        const trueOriginal = video.__trueOriginalPlaybackRate || 1.0;
        if (Math.abs(video.playbackRate - trueOriginal) > 0.01) {
          video.playbackRate = trueOriginal;
        }
      }
    };

    const onPause = () => {
      const state = getBoostState(video);
      if (!state) return;

      // Update play time
      if (state.playStartTime > 0) {
        state.totalPlayTime += Date.now() - state.playStartTime;
        state.playStartTime = 0;
      }

      if (state.isBoosting) {
        stopForwardBoost(video, "paused");
      }
    };

    const onSeeking = () => {
      video.__lastSeekTime = Date.now();
      const state = getBoostState(video);
      if (state?.isBoosting) {
        stopForwardBoost(video, "seeking");
      }
    };

    const onSeeked = () => {
      video.__lastSeekTime = Date.now();
      if (typeof tabIsVisible === "undefined" || tabIsVisible) {
        boostBufferAfterSeek(video);
      }
    };

    const onEnded = () => {
      const state = getBoostState(video);
      if (state?.isBoosting) {
        stopForwardBoost(video, "ended");
      }
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ended", onEnded);

    return () => {
      console.log(`[Boost] 🔌 Detached from ${videoId}`);

      stopMonitor();
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
    getEffectiveBufferRatio,
    startContinuousBufferMonitor,
    boostBufferAfterSeek,
    boostPreviewBuffer,
    cleanupPreviewBoost,
    config: BOOST_CONFIG,
    getBoostState,
  };

  console.log("[Boost] ✅ v2.3 Ready - Proactive buffer maintenance");
  console.log(
    `[Boost] Strategy: Critical<${BOOST_CONFIG.BUFFER_CRITICAL}s | Low<${BOOST_CONFIG.BUFFER_LOW}s | Comfort<${BOOST_CONFIG.BUFFER_COMFORT}s | Target=${BOOST_CONFIG.BUFFER_TARGET}s`,
  );
  console.log(
    `[Boost] Rates: Maint=${BOOST_CONFIG.BOOST_RATE_MAINTENANCE}x | Gentle=${BOOST_CONFIG.BOOST_RATE_GENTLE}x | Normal=${BOOST_CONFIG.BOOST_RATE_NORMAL}x | Aggressive=${BOOST_CONFIG.BOOST_RATE_AGGRESSIVE}x | Seek=${BOOST_CONFIG.BOOST_RATE_SEEK}x`,
  );
}
