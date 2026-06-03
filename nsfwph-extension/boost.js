// boost.js - Forward Buffer Boost Engine (v2.5 - PERSISTENT BUFFER PROTECTION)
// Standalone module for smart buffer management
// Features: Minimum buffer enforcement that survives pause/seek cycles
// ═══════════════════════════════════════════════════════════════
// Prevent double initialization
if (window.__BOOST_ENGINE_INITIALIZED__) {
  console.warn("[Boost] Engine already initialized, skipping");
} else {
  window.__BOOST_ENGINE_INITIALIZED__ = true;

  // ═══════════════════════════════════════════════════════════════
  // BOOST CONFIGURATION - PERSISTENT BUFFER PROTECTION
  // ═══════════════════════════════════════════════════════════════
  const BOOST_CONFIG = {
    // BUFFER ZONES (forward buffer in seconds)
    MIN_FORWARD_BUFFER: 5, // ABSOLUTE MINIMUM: Never let buffer drop below this
    BUFFER_CRITICAL: 5, // Critical threshold
    BUFFER_LOW: 8, // Start boosting more aggressively
    BUFFER_COMFORT: 15, // Comfortable buffer
    BUFFER_TARGET: 20, // Target buffer - maintenance only

    // Boost rates - PROPERLY ADAPTIVE
    BOOST_RATE_AGGRESSIVE: 1.3, // Critical zone: Fast recovery
    BOOST_RATE_NORMAL: 1.2, // Low zone: Moderate boost
    BOOST_RATE_GENTLE: 1.12, // Comfort zone: Slow fill
    BOOST_RATE_MAINTENANCE: 1.08, // Target zone: Barely perceptible
    BOOST_RATE_SEEK: 1.35, // Post-seek: Fastest recovery

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

  // ═══════════════════════════════════════════════════════════════
  // BOOST STATE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
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
      // FIX: Track buffer state across pause/resume cycles
      lastBufferBeforePause: 0,
      pauseResumeCount: 0,
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
  // ADAPTIVE RATE CALCULATION
  // ═══════════════════════════════════════════════════════════════
  function calculateOptimalBoostRate(
    bufferAhead,
    isSeek = false,
    connectionQuality = 1.0,
  ) {
    // CRITICAL ZONE: 0 to MIN_FORWARD_BUFFER
    if (bufferAhead < BOOST_CONFIG.MIN_FORWARD_BUFFER) {
      const criticalRatio = bufferAhead / BOOST_CONFIG.MIN_FORWARD_BUFFER;
      // Scale: closer to 0 = faster
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

    // LOW ZONE: MIN to BUFFER_LOW
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

    // COMFORT ZONE: BUFFER_LOW to BUFFER_COMFORT
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

    // TARGET ZONE: BUFFER_COMFORT to BUFFER_TARGET
    if (bufferAhead < BOOST_CONFIG.BUFFER_TARGET) {
      return {
        rate: BOOST_CONFIG.BOOST_RATE_MAINTENANCE,
        level: "maintenance",
      };
    }

    // Buffer sufficient
    return { rate: 1.0, level: "none" };
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOST APPLICATION & CONTROL
  // ═══════════════════════════════════════════════════════════════
  function canBoost(state, isNewSession = true) {
    const now = Date.now();

    // EMERGENCY: Always allow if buffer is critical
    if (
      state.emergencyBoostActive ||
      state.lastBufferAhead < BOOST_CONFIG.MIN_FORWARD_BUFFER
    ) {
      return true;
    }

    if (isNewSession) {
      if (state.boostSessionCount >= BOOST_CONFIG.MAX_BOOST_SESSIONS) {
        if (state.lastBufferAhead < BOOST_CONFIG.MIN_FORWARD_BUFFER)
          return true;
        return false;
      }
      if (state.totalBoostTime >= BOOST_CONFIG.MAX_TOTAL_BOOST_MS) {
        if (state.lastBufferAhead < BOOST_CONFIG.MIN_FORWARD_BUFFER)
          return true;
        return false;
      }
      if (state.lastBoostEndTime > 0) {
        const timeSinceLastSession = now - state.lastBoostEndTime;
        if (timeSinceLastSession < BOOST_CONFIG.BOOST_SESSION_GAP) {
          if (state.lastBufferAhead >= BOOST_CONFIG.MIN_FORWARD_BUFFER)
            return false;
        }
      }
      if (
        state.totalPlayTime < BOOST_CONFIG.MIN_PLAY_TIME_FOR_BOOST &&
        !state.isRealPlay
      ) {
        return false;
      }
    }
    return true;
  }

  function applyForwardBoost(video, targetRate, level, reason = "unknown") {
    if (!video || video.paused) return false;
    const state = getBoostState(video);
    if (!state) return false;

    const currentRate = video.playbackRate;
    const ahead = getBufferAhead(video);

    // Update state tracking
    state.lastBufferAhead = ahead;

    // Determine if this is an emergency (buffer at or near 0)
    const isEmergency = ahead < 2;
    if (isEmergency) {
      state.emergencyBoostActive = true;
      state.bufferWarningCount++;
      if (ahead <= 0.5) state.lastBufferZeroTime = Date.now();
    }

    // If already boosting, adjust rate if needed
    if (state.isBoosting) {
      if (Math.abs(currentRate - targetRate) < 0.02) return true;
      video.playbackRate = targetRate;
      state.boostTargetRate = targetRate;
      state.currentBoostLevel = level;
      if (level === "maintenance") {
        state.maintenanceMode = true;
        state.maintenanceStartTime = Date.now();
      }
      if (BOOST_CONFIG.DEBUG_VERBOSE || isEmergency) {
        console.log(
          `[Boost] 🔄 Adjust: ${currentRate.toFixed(2)}x → ${targetRate.toFixed(2)}x (${level})${isEmergency ? " ⚠️" : ""} | Buffer: ${ahead.toFixed(1)}s`,
        );
      }
      return true;
    }

    // Check if we can start a new boost session
    if (!isEmergency && !canBoost(state, true)) return false;
    if (!isEmergency && currentRate >= targetRate - 0.01) return false;

    // APPLY THE BOOST
    video.playbackRate = targetRate;
    state.isBoosting = true;
    state.boostStartTime = Date.now();
    state.boostTargetRate = targetRate;
    state.currentBoostLevel = level;
    state.boostSessionCount++;
    state.maintenanceOffTime = 0;

    if (level === "maintenance") {
      state.maintenanceMode = true;
      state.maintenanceStartTime = Date.now();
    }

    const logPrefix = isEmergency ? "🚨" : "⚡";
    console.log(
      `[Boost] ${logPrefix} #${state.boostSessionCount}: ${currentRate.toFixed(2)}x → ${targetRate.toFixed(2)}x | ` +
        `${level.toUpperCase()} | ${reason} | Buffer: ${ahead.toFixed(1)}s | ` +
        `Play: ${(state.totalPlayTime / 1000).toFixed(0)}s`,
    );

    if (state.bufferWarningCount > 0 && state.bufferWarningCount % 5 === 0) {
      console.warn(`[Boost] ⚠️ Buffer warnings: ${state.bufferWarningCount}`);
    }

    return true;
  }

  function stopForwardBoost(video, reason = "target reached") {
    if (!video) return;
    const state = getBoostState(video);
    if (!state || !state.isBoosting) return;

    const ahead = getBufferAhead(video);
    state.lastBufferAhead = ahead;
    state.lastBufferBeforePause = ahead;

    // FIX: NEVER stop boosting if buffer is below minimum, regardless of reason
    // The only exception is "ended" (video finished)
    if (reason !== "ended" && ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER) {
      console.log(
        `[Boost] ⛔ Prevented stop: Buffer ${ahead.toFixed(1)}s below minimum ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | Reason: ${reason}`,
      );

      // If paused, we can't boost, but mark that we need to resume boosting on play
      if (reason === "paused" || reason === "seeking") {
        state.emergencyBoostActive = true;
        state.isBoosting = false; // Reset boost state but keep emergency flag
        state.currentBoostLevel = "none";
        // Don't change playback rate - let it stay at boosted rate
        // The monitor will pick up on play and resume boosting
        console.log(
          `[Boost] ⚠️ Paused while below minimum - emergency flag set for resume`,
        );
        return;
      }
      return; // Don't stop for other reasons
    }

    const previousRate = video.playbackRate;
    const normalRate = state.originalRate;

    if (Math.abs(previousRate - normalRate) > 0.01) {
      video.playbackRate = normalRate;
      const boostDuration = Date.now() - state.boostStartTime;
      state.totalBoostTime += boostDuration;
      state.lastBoostEndTime = Date.now();

      if (state.maintenanceMode) {
        state.maintenanceOffTime = Date.now();
      }

      console.log(
        `[Boost] ⏹️ Stopped: ${previousRate.toFixed(2)}x → ${normalRate.toFixed(2)}x | ` +
          `${reason} | Duration: ${(boostDuration / 1000).toFixed(1)}s | ` +
          `Total: ${(state.totalBoostTime / 1000).toFixed(1)}s | Buffer: ${ahead.toFixed(1)}s`,
      );
    }

    state.isBoosting = false;
    state.boostTargetRate = normalRate;
    state.currentBoostLevel = "none";
    state.maintenanceMode = false;
    state.emergencyBoostActive = false;
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

    // Track consecutive shrinks
    if (state.isBoosting && growthRate < -0.1) {
      state.consecutiveShrinks++;
    } else if (state.isBoosting && growthRate > 0.1) {
      state.consecutiveShrinks = Math.max(0, state.consecutiveShrinks - 2);
    } else if (!state.isBoosting) {
      state.consecutiveShrinks = 0;
    }

    // Update connection quality
    const newQuality = Math.max(0.1, Math.min(2.0, Math.abs(growthRate) + 0.5));
    state.connectionQuality = state.connectionQuality * 0.7 + newQuality * 0.3;
    state.lastBufferCheck = now;
    state.lastBufferAhead = currentBufferAhead;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTINUOUS BUFFER MONITOR
  // ═══════════════════════════════════════════════════════════════
  function startContinuousBufferMonitor(video) {
    if (!video || video.dataset.continuousMonitorActive === "true") {
      return () => {};
    }
    video.dataset.continuousMonitorActive = "true";
    const state = getBoostState(video);

    console.log(
      `[Boost] 🚀 Monitor attached | Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | ` +
        `Comfort: ${BOOST_CONFIG.BUFFER_COMFORT}s | Target: ${BOOST_CONFIG.BUFFER_TARGET}s`,
    );

    if (!video.__trueOriginalPlaybackRate) {
      video.__trueOriginalPlaybackRate = video.playbackRate || 1.0;
      state.originalRate = video.__trueOriginalPlaybackRate;
    }

    const monitorInterval = setInterval(() => {
      // Skip if tab hidden or video paused
      if (typeof tabIsVisible !== "undefined" && !tabIsVisible) return;
      if (video.paused) return;

      const ahead = getBufferAhead(video);
      const state = getBoostState(video);
      if (!state) return;

      // Update connection quality and play time
      updateConnectionQuality(video, state);
      if (state.playStartTime > 0) {
        state.totalPlayTime += BOOST_CONFIG.MONITOR_INTERVAL;
      }

      const now = Date.now();
      const isBelowMinimum = ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER;

      // Debug log (every 5s or when below minimum)
      if (now - state.lastDebugTime > 5000 || isBelowMinimum) {
        state.lastDebugTime = now;
        console.log(
          `[Boost] 📊 Buffer: ${ahead.toFixed(1)}s${isBelowMinimum ? " ⚠️BELOW MIN" : ""} | ` +
            `Rate: ${video.playbackRate.toFixed(2)}x | Level: ${state.currentBoostLevel} | ` +
            `Sessions: ${state.boostSessionCount} | Play: ${(state.totalPlayTime / 1000).toFixed(0)}s`,
        );
      }

      // ═══════════════════════════════════════════════════════════
      // BOOST DECISION
      // ═══════════════════════════════════════════════════════════
      const {
        rate: optimalRate,
        level,
        emergency,
      } = calculateOptimalBoostRate(ahead, false, state.connectionQuality);

      if (optimalRate > 1.0) {
        // Need to boost
        if (!state.isBoosting) {
          applyForwardBoost(video, optimalRate, level, `buffer ${level}`);
        } else if (Math.abs(video.playbackRate - optimalRate) > 0.02) {
          applyForwardBoost(video, optimalRate, level, `adjust to ${level}`);
        }
      } else if (state.isBoosting && ahead >= BOOST_CONFIG.MIN_FORWARD_BUFFER) {
        // Buffer is sufficient - stop boosting
        stopForwardBoost(video, "buffer sufficient");
      }

      // SAFETY CHECKS
      if (state.isBoosting) {
        const boostDuration = now - state.boostStartTime;

        // Duration limit - don't stop if below minimum
        if (boostDuration > BOOST_CONFIG.BOOST_DURATION) {
          if (ahead >= BOOST_CONFIG.MIN_FORWARD_BUFFER) {
            stopForwardBoost(video, "duration exceeded");
          } else {
            // Reset timer to allow continued protection
            state.boostStartTime = now;
            console.log(
              `[Boost] ⚠️ Duration limit reached but buffer below minimum - continuing`,
            );
          }
        }
        // Buffer shrinking persistently
        else if (state.consecutiveShrinks >= BOOST_CONFIG.SHRINK_TOLERANCE) {
          if (ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER) {
            // Increase rate instead of stopping
            const newRate = Math.min(2.0, video.playbackRate * 1.1);
            if (newRate > video.playbackRate) {
              video.playbackRate = newRate;
              console.log(
                `[Boost] ⚠️ Increasing rate to ${newRate.toFixed(2)}x (buffer shrinking)`,
              );
            }
          } else {
            stopForwardBoost(video, "buffer shrinking");
          }
        }
        // Maintenance mode too long
        else if (
          state.maintenanceMode &&
          now - state.maintenanceStartTime >
            BOOST_CONFIG.MAINTENANCE_MAX_DURATION
        ) {
          if (ahead >= BOOST_CONFIG.MIN_FORWARD_BUFFER) {
            stopForwardBoost(video, "maintenance cycle");
          }
        }
      }

      // Ensure rate never drops below 1.0
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
    if (!video || video.dataset.boostAttached === "true") return () => {};
    video.dataset.boostAttached = "true";
    const videoId = video.dataset.videoObserverId || "unknown";
    console.log(
      `[Boost] 🔗 Attached to ${videoId} | Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s`,
    );

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

      // FIX: If we have an emergency flag from a previous pause-below-minimum,
      // resume boosting immediately
      if (
        state.emergencyBoostActive &&
        ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER
      ) {
        state.pauseResumeCount++;
        console.log(
          `[Boost] 🚨 Resume after pause - buffer still below minimum: ${ahead.toFixed(1)}s`,
        );
        applyForwardBoost(
          video,
          BOOST_CONFIG.BOOST_RATE_AGGRESSIVE,
          "aggressive",
          "resume after pause (below min)",
        );
        return;
      }

      // Initial boost on first real play
      if (
        !state.hasInitialBoosted &&
        state.isRealPlay &&
        ahead < BOOST_CONFIG.BUFFER_COMFORT
      ) {
        state.hasInitialBoosted = true;
        state.totalPlayTime = Math.max(
          state.totalPlayTime,
          BOOST_CONFIG.MIN_PLAY_TIME_FOR_BOOST,
        );
        console.log(`[Boost] 🆕 Initial boost | Buffer: ${ahead.toFixed(1)}s`);
        applyForwardBoost(
          video,
          BOOST_CONFIG.BOOST_RATE_NORMAL,
          "normal",
          "initial play",
        );
        return;
      }

      // Boost if buffer is below minimum on play
      if (ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER && !state.isBoosting) {
        console.log(
          `[Boost] ⚠️ Buffer below minimum on play: ${ahead.toFixed(1)}s`,
        );
        applyForwardBoost(
          video,
          BOOST_CONFIG.BOOST_RATE_AGGRESSIVE,
          "aggressive",
          "below minimum on play",
        );
      }

      // Safety: ensure rate is normal if not boosting
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

      if (state.playStartTime > 0) {
        state.totalPlayTime += Date.now() - state.playStartTime;
        state.playStartTime = 0;
      }

      const ahead = getBufferAhead(video);
      state.lastBufferBeforePause = ahead;
      state.lastBufferAhead = ahead;

      // FIX: If buffer is below minimum when pausing, set emergency flag
      // and DON'T stop the boost (just mark it for resume)
      if (ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER) {
        console.log(
          `[Boost] ⚠️ Pausing with buffer below minimum: ${ahead.toFixed(1)}s`,
        );
        state.emergencyBoostActive = true;
      }

      if (state.isBoosting) {
        // Let stopForwardBoost handle the minimum buffer check
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
    startContinuousBufferMonitor,
    boostBufferAfterSeek,
    boostPreviewBuffer,
    cleanupPreviewBoost,
    config: BOOST_CONFIG,
    getBoostState,
  };

  console.log("[Boost] ✅ v2.5 Ready - Persistent Buffer Protection");
  console.log(
    `[Boost] Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | Target: ${BOOST_CONFIG.BUFFER_TARGET}s`,
  );
  console.log(`[Boost] Emergency resume on pause-below-minimum enabled`);
}
