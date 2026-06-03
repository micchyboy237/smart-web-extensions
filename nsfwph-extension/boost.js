// boost.js - Forward Buffer Boost Engine (OPTIMIZED)
// Standalone module for smart buffer management
// Features: Forward-only boost, adaptive rates, connection quality detection
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
    // Buffer thresholds - tuned for intermittent connections
    BUFFER_LOW: 5, // Start boosting below this
    BUFFER_TARGET: 15, // Stop boosting when reaching this
    BUFFER_CRITICAL: 2, // Critical low - use faster boost

    // Boost timing
    BOOST_DURATION: 10000, // Max single boost duration (ms)
    MONITOR_INTERVAL: 1500, // Check every 1.5s (responsive, low CPU)
    BOOST_COOLDOWN: 2000, // Cooldown between boost SESSIONS (not extensions)

    // Boost rates (forward only, >= 1.0)
    BOOST_RATE_NORMAL: 1.15, // Normal boost for steady buffering
    BOOST_RATE_CRITICAL: 1.25, // Faster boost when buffer is critical
    BOOST_RATE_SEEK: 1.4, // Fastest boost after seeking
    BOOST_RATE_MIN: 1.08, // Minimum boost near target

    // Seek handling
    SEEK_DEBOUNCE_MS: 500, // Debounce rapid seeks
    SEEK_MIN_EFFECTIVE_RATIO: 0.6, // Ratio threshold for aggressive seek boost

    // Limits (prevent resource waste)
    MAX_BOOST_SESSIONS: 10, // Max number of boost sessions (increased from 3)
    MAX_TOTAL_BOOST_MS: 60000, // Max total boost time (increased from 30s)
    BOOST_SESSION_GAP: 3000, // Minimum gap between boost sessions (ms)

    // Connection quality detection
    SLOW_CONNECTION_THRESHOLD: 0.5, // Buffer growth < 0.5s/s = slow
    CONNECTION_CHECK_WINDOW: 5000, // Check connection every 5s

    // Debug
    DEBUG_VERBOSE: false, // Set to true for detailed logs
  };

  // ═══════════════════════════════════════════════════════════════
  // BOOST STATE STORAGE
  // ═══════════════════════════════════════════════════════════════
  const boostTimers = new WeakMap(); // video → boost state

  // ═══════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get the buffered time ahead of current playback position
   * @param {HTMLVideoElement} video
   * @returns {number} Seconds buffered ahead
   */
  function getBufferAhead(video) {
    if (!video || !video.buffered || !video.buffered.length) return 0;

    let maxEnd = 0;
    const currentTime = video.currentTime;

    // Find the furthest buffered point that includes currentTime
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);

      if (currentTime >= start && currentTime <= end) {
        maxEnd = Math.max(maxEnd, end);
      }
    }

    return Math.max(0, maxEnd - currentTime);
  }

  /**
   * Get the effective buffer ratio (ahead vs total buffered)
   * @param {HTMLVideoElement} video
   * @returns {number} Ratio between 0 and 1
   */
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

  /**
   * Create initial boost state for a video element
   * @param {HTMLVideoElement} video
   * @returns {Object} Boost state object
   */
  function createBoostState(video) {
    return {
      // Current boost information
      isBoosting: false,
      boostStartTime: 0,
      boostTargetRate: 1.0,

      // Session tracking (a session = continuous boost period)
      boostSessionCount: 0,
      totalBoostTime: 0,
      lastBoostEndTime: 0,

      // Original playback rate (typically 1.0)
      originalRate: video.playbackRate || 1.0,

      // Connection quality tracking
      connectionQuality: 1.0, // 1.0 = normal, < 0.5 = slow
      lastBufferCheck: Date.now(),
      lastBufferAhead: 0,
      lastBufferGrowth: 0,

      // Seek tracking
      lastSeekTime: 0,
      seekDebounceTimer: null,

      // Monitor state
      monitorInterval: null,
      boostTimeout: null,

      // Debug
      lastDebugTime: 0,

      // Track if initial boost has happened
      hasInitialBoosted: false,
    };
  }

  /**
   * Get or create boost state for a video
   * @param {HTMLVideoElement} video
   * @returns {Object|null} Boost state object or null if video is invalid
   */
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

  /**
   * Calculate optimal boost rate based on current buffer state
   * Uses adaptive scaling to avoid overshooting the target
   *
   * @param {number} bufferAhead - Seconds of buffer ahead
   * @param {boolean} isSeek - Whether this is a post-seek boost
   * @param {number} connectionQuality - Connection quality factor (0.1-2.0)
   * @returns {number} Optimal playback rate (1.0 = no boost)
   */
  function calculateOptimalBoostRate(
    bufferAhead,
    isSeek = false,
    connectionQuality = 1.0,
  ) {
    // Clamp connection quality to prevent extreme rates
    const qualityFactor = Math.min(1.3, Math.max(0.7, connectionQuality));

    // Critical: buffer almost empty - emergency boost
    if (bufferAhead < BOOST_CONFIG.BUFFER_CRITICAL) {
      const baseRate = isSeek
        ? BOOST_CONFIG.BOOST_RATE_SEEK
        : BOOST_CONFIG.BOOST_RATE_CRITICAL;
      // On slow connections, be more aggressive; on fast, be more conservative
      return connectionQuality < BOOST_CONFIG.SLOW_CONNECTION_THRESHOLD
        ? Math.min(1.8, baseRate * 1.1) // Slow connection: push harder
        : baseRate; // Normal connection: use standard rate
    }

    // Low: buffer below comfortable threshold
    if (bufferAhead < BOOST_CONFIG.BUFFER_LOW) {
      const baseRate = isSeek
        ? BOOST_CONFIG.BOOST_RATE_SEEK
        : BOOST_CONFIG.BOOST_RATE_NORMAL;
      return connectionQuality < BOOST_CONFIG.SLOW_CONNECTION_THRESHOLD
        ? Math.min(1.6, baseRate * 1.05)
        : baseRate;
    }

    // Approaching target: use scaled boost to avoid overshooting
    if (bufferAhead < BOOST_CONFIG.BUFFER_TARGET) {
      const ratio = bufferAhead / BOOST_CONFIG.BUFFER_TARGET;
      const baseRate = isSeek
        ? BOOST_CONFIG.BOOST_RATE_NORMAL
        : BOOST_CONFIG.BOOST_RATE_MIN;
      const maxRate = isSeek
        ? BOOST_CONFIG.BOOST_RATE_SEEK
        : BOOST_CONFIG.BOOST_RATE_NORMAL;

      // Logarithmic decay as we approach target (gentler than exponential)
      const scaledRate =
        maxRate - (maxRate - baseRate) * Math.log10(1 + 9 * ratio);
      const adjustedRate =
        connectionQuality < BOOST_CONFIG.SLOW_CONNECTION_THRESHOLD
          ? scaledRate * 1.05 // Slightly more aggressive on slow connections
          : scaledRate;

      return Math.max(
        BOOST_CONFIG.BOOST_RATE_MIN,
        Math.min(maxRate, adjustedRate),
      );
    }

    // Buffer sufficient, no boost needed
    return 1.0;
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOST APPLICATION & CONTROL
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if we can start a new boost session
   * @param {Object} state - Boost state
   * @returns {boolean} True if boost can start
   */
  function canStartBoostSession(state) {
    const now = Date.now();

    // Check max sessions
    if (state.boostSessionCount >= BOOST_CONFIG.MAX_BOOST_SESSIONS) {
      if (BOOST_CONFIG.DEBUG_VERBOSE) {
        console.log(
          `[Boost:D] Max sessions reached (${state.boostSessionCount}/${BOOST_CONFIG.MAX_BOOST_SESSIONS})`,
        );
      }
      return false;
    }

    // Check total boost time
    if (state.totalBoostTime >= BOOST_CONFIG.MAX_TOTAL_BOOST_MS) {
      if (BOOST_CONFIG.DEBUG_VERBOSE) {
        console.log(
          `[Boost:D] Max total boost time reached (${(state.totalBoostTime / 1000).toFixed(1)}s)`,
        );
      }
      return false;
    }

    // Check session gap (cooldown between sessions)
    if (state.lastBoostEndTime > 0) {
      const timeSinceLastSession = now - state.lastBoostEndTime;
      if (timeSinceLastSession < BOOST_CONFIG.BOOST_SESSION_GAP) {
        if (BOOST_CONFIG.DEBUG_VERBOSE) {
          console.log(
            `[Boost:D] Session gap active (${((BOOST_CONFIG.BOOST_SESSION_GAP - timeSinceLastSession) / 1000).toFixed(1)}s remaining)`,
          );
        }
        return false;
      }
    }

    return true;
  }

  /**
   * Apply forward boost to video (never slows down playback)
   *
   * @param {HTMLVideoElement} video - The video element to boost
   * @param {number} targetRate - Desired playback rate (> 1.0)
   * @param {string} reason - Reason for boost (for debugging)
   * @returns {boolean} True if boost was applied
   */
  function applyForwardBoost(video, targetRate, reason = "unknown") {
    if (!video || video.paused) {
      if (BOOST_CONFIG.DEBUG_VERBOSE) {
        console.log(
          `[Boost:D] Cannot boost - ${!video ? "no video" : "video paused"} (${reason})`,
        );
      }
      return false;
    }

    const state = getBoostState(video);
    if (!state) return false;

    // Don't boost if already boosting
    if (state.isBoosting) {
      // But we can adjust the rate if needed (within same session)
      const currentRate = video.playbackRate;
      if (Math.abs(currentRate - targetRate) > 0.05) {
        video.playbackRate = targetRate;
        state.boostTargetRate = targetRate;
        console.log(
          `[Boost] 🔄 Adjusted rate: ${currentRate.toFixed(2)}x → ${targetRate.toFixed(2)}x (${reason})`,
        );
      }
      return true;
    }

    // Check if we can start a new session
    if (!canStartBoostSession(state)) {
      return false;
    }

    // Don't boost if already at or above target rate
    const currentRate = video.playbackRate;
    if (currentRate >= targetRate - 0.01) {
      if (BOOST_CONFIG.DEBUG_VERBOSE) {
        console.log(
          `[Boost:D] Already at ${currentRate.toFixed(2)}x, target ${targetRate.toFixed(2)}x (${reason})`,
        );
      }
      return false;
    }

    // Apply the boost
    const previousRate = currentRate;
    video.playbackRate = targetRate;

    // Update state
    state.isBoosting = true;
    state.boostStartTime = Date.now();
    state.boostTargetRate = targetRate;
    state.boostSessionCount++;

    const ahead = getBufferAhead(video);
    console.log(
      `[Boost] ⚡ Session #${state.boostSessionCount}: ${previousRate.toFixed(2)}x → ${targetRate.toFixed(2)}x | ` +
        `${reason} | Buffer: ${ahead.toFixed(1)}s | Quality: ${state.connectionQuality.toFixed(2)}x`,
    );

    return true;
  }

  /**
   * Stop boosting and restore normal playback rate
   *
   * @param {HTMLVideoElement} video - The video element
   * @param {string} reason - Reason for stopping (for debugging)
   */
  function stopForwardBoost(video, reason = "target reached") {
    if (!video) return;

    const state = getBoostState(video);
    if (!state || !state.isBoosting) return;

    const previousRate = video.playbackRate;
    const normalRate = state.originalRate;

    // Only restore if rate was changed
    if (Math.abs(previousRate - normalRate) > 0.01) {
      video.playbackRate = normalRate;

      // Update tracking
      const boostDuration = Date.now() - state.boostStartTime;
      state.totalBoostTime += boostDuration;
      state.lastBoostEndTime = Date.now();

      console.log(
        `[Boost] ⏹️ Session ended: ${previousRate.toFixed(2)}x → ${normalRate.toFixed(2)}x | ` +
          `${reason} | Duration: ${(boostDuration / 1000).toFixed(1)}s | ` +
          `Total: ${(state.totalBoostTime / 1000).toFixed(1)}s | ` +
          `Sessions: ${state.boostSessionCount}`,
      );
    }

    state.isBoosting = false;
    state.boostTargetRate = normalRate;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONNECTION QUALITY DETECTION (IMPROVED)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Monitor connection quality by measuring actual buffer growth rate
   * Fixed: Properly handles negative growth (buffer shrinking)
   *
   * @param {HTMLVideoElement} video
   * @param {Object} state - Boost state object
   */
  function updateConnectionQuality(video, state) {
    if (!video || !state) return;

    const now = Date.now();
    const timeSinceLastCheck = now - state.lastBufferCheck;

    // Only check every CONNECTION_CHECK_WINDOW
    if (timeSinceLastCheck < BOOST_CONFIG.CONNECTION_CHECK_WINDOW) return;

    const currentBufferAhead = getBufferAhead(video);
    const bufferGrowth = currentBufferAhead - state.lastBufferAhead;

    // Calculate growth rate (can be negative if buffer is shrinking)
    const growthRate =
      timeSinceLastCheck > 0 ? bufferGrowth / (timeSinceLastCheck / 1000) : 0;

    // Store last growth for debugging
    state.lastBufferGrowth = growthRate;

    // Update connection quality with exponential smoothing
    // Use absolute value for quality, but keep sign information
    const absGrowthRate = Math.abs(growthRate);
    const newQuality = Math.max(0.1, Math.min(2.0, absGrowthRate + 0.5)); // +0.5 baseline
    state.connectionQuality = state.connectionQuality * 0.7 + newQuality * 0.3;

    // Update tracking
    state.lastBufferCheck = now;
    state.lastBufferAhead = currentBufferAhead;

    // Log if connection seems problematic
    if (growthRate < 0 && BOOST_CONFIG.DEBUG_VERBOSE) {
      console.log(
        `[Boost:D] ⚠️ Buffer shrinking: ${growthRate.toFixed(2)}s/s | ` +
          `Ahead: ${currentBufferAhead.toFixed(1)}s | Quality: ${state.connectionQuality.toFixed(2)}x`,
      );
    } else if (
      Math.abs(growthRate - state.lastBufferGrowth) > 0.5 &&
      BOOST_CONFIG.DEBUG_VERBOSE
    ) {
      console.log(
        `[Boost:D] Connection quality: ${state.connectionQuality.toFixed(2)}x | ` +
          `Growth: ${growthRate.toFixed(2)}s/s | Ahead: ${currentBufferAhead.toFixed(1)}s`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTINUOUS BUFFER MONITOR (IMPROVED)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Start continuous buffer monitoring with smart forward boost
   * Fixed: Better session management, handles initial boost properly
   *
   * @param {HTMLVideoElement} video
   * @returns {Function} Cleanup function to stop monitoring
   */
  function startContinuousBufferMonitor(video) {
    if (!video || video.dataset.continuousMonitorActive === "true") {
      return () => {};
    }

    video.dataset.continuousMonitorActive = "true";

    // Initialize boost state
    const state = getBoostState(video);

    console.log(
      `[Boost] 🚀 Monitor attached to ${video.dataset.videoObserverId || "video"} | ` +
        `Target: ${BOOST_CONFIG.BUFFER_TARGET}s | Interval: ${BOOST_CONFIG.MONITOR_INTERVAL}ms | ` +
        `Max sessions: ${BOOST_CONFIG.MAX_BOOST_SESSIONS}`,
    );

    // Store original playback rate for reference
    if (!video.__trueOriginalPlaybackRate) {
      video.__trueOriginalPlaybackRate = video.playbackRate || 1.0;
      state.originalRate = video.__trueOriginalPlaybackRate;
    }

    // Main monitoring loop
    const monitorInterval = setInterval(() => {
      // Skip if video is not actively playing
      if (typeof tabIsVisible !== "undefined" && !tabIsVisible) return;
      if (video.paused) return;

      const ahead = getBufferAhead(video);
      const state = getBoostState(video);
      if (!state) return;

      // Update connection quality
      updateConnectionQuality(video, state);

      // Periodic debug log (every 5 seconds)
      const now = Date.now();
      if (now - state.lastDebugTime > 5000) {
        state.lastDebugTime = now;
        const rate = video.playbackRate;
        console.log(
          `[Boost] 📊 Buffer: ${ahead.toFixed(1)}s | Rate: ${rate.toFixed(2)}x | ` +
            `Boosting: ${state.isBoosting} | Quality: ${state.connectionQuality.toFixed(2)}x | ` +
            `Sessions: ${state.boostSessionCount}/${BOOST_CONFIG.MAX_BOOST_SESSIONS} | ` +
            `Total time: ${(state.totalBoostTime / 1000).toFixed(1)}s`,
        );
      }

      // DECISION: Should we start boosting?
      if (ahead < BOOST_CONFIG.BUFFER_LOW && !state.isBoosting) {
        const optimalRate = calculateOptimalBoostRate(
          ahead,
          false,
          state.connectionQuality,
        );

        if (optimalRate > 1.0) {
          applyForwardBoost(video, optimalRate, "buffer low");
        }
      }

      // DECISION: Should we stop boosting?
      if (state.isBoosting) {
        // Stop if target reached
        if (ahead >= BOOST_CONFIG.BUFFER_TARGET) {
          stopForwardBoost(video, "target reached");
        }
        // Stop if duration exceeded (safety)
        else if (now - state.boostStartTime > BOOST_CONFIG.BOOST_DURATION) {
          console.log(
            `[Boost] ⚠️ Duration exceeded ${(BOOST_CONFIG.BOOST_DURATION / 1000).toFixed(1)}s`,
          );
          stopForwardBoost(video, "duration exceeded");
        }
        // Stop if buffer is shrinking (connection too slow for boost to help)
        else if (
          state.lastBufferGrowth < -0.3 &&
          now - state.boostStartTime > 3000
        ) {
          console.log(`[Boost] ⚠️ Buffer shrinking despite boost, pausing`);
          stopForwardBoost(video, "buffer shrinking");
        }
      }

      // SAFETY: Ensure rate never drops below 1.0
      if (video.playbackRate < 0.99 && !state.isBoosting) {
        console.warn(
          `[Boost] ⚠️ Unexpected low rate ${video.playbackRate.toFixed(2)}x, restoring to 1.0x`,
        );
        video.playbackRate = state.originalRate;
      }
    }, BOOST_CONFIG.MONITOR_INTERVAL);

    // Store monitor reference
    state.monitorInterval = monitorInterval;

    // Return cleanup function
    return () => {
      clearInterval(monitorInterval);
      state.monitorInterval = null;
      delete video.dataset.continuousMonitorActive;
      console.log(
        `[Boost] 📴 Monitor detached from ${video.dataset.videoObserverId || "video"}`,
      );
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // SEEK BOOST HANDLER (IMPROVED)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Handle buffer boost after seeking
   * Fixed: Respects session limits, better rate calculation
   *
   * @param {HTMLVideoElement} video
   */
  function boostBufferAfterSeek(video) {
    if (!video || video.paused) return;

    // Check tab visibility if available
    if (typeof tabIsVisible !== "undefined" && !tabIsVisible) return;

    const state = getBoostState(video);
    if (!state) return;

    // Clear any existing debounce timer
    if (state.seekDebounceTimer) {
      clearTimeout(state.seekDebounceTimer);
    }

    // Debounce: wait for seeks to settle before boosting
    state.seekDebounceTimer = setTimeout(() => {
      const ahead = getBufferAhead(video);
      const effectiveRatio = getEffectiveBufferRatio(video);

      console.log(
        `[Boost] 🎯 Seek settled | Buffer: ${ahead.toFixed(1)}s | ` +
          `Ratio: ${effectiveRatio.toFixed(2)} | Quality: ${state.connectionQuality.toFixed(2)}x`,
      );

      // Only boost if buffer is significantly below target
      if (ahead < BOOST_CONFIG.BUFFER_TARGET) {
        // Use more aggressive rate for seek recovery
        const seekRate =
          effectiveRatio < BOOST_CONFIG.SEEK_MIN_EFFECTIVE_RATIO
            ? BOOST_CONFIG.BOOST_RATE_SEEK
            : calculateOptimalBoostRate(ahead, true, state.connectionQuality);

        if (seekRate > 1.0 && canStartBoostSession(state)) {
          applyForwardBoost(video, seekRate, "seek recovery");

          // Set a timeout to re-evaluate after seek boost
          if (state.boostTimeout) clearTimeout(state.boostTimeout);
          state.boostTimeout = setTimeout(() => {
            const currentAhead = getBufferAhead(video);
            if (currentAhead >= BOOST_CONFIG.BUFFER_TARGET) {
              stopForwardBoost(video, "seek boost complete");
            }
          }, BOOST_CONFIG.BOOST_DURATION);
        } else if (BOOST_CONFIG.DEBUG_VERBOSE) {
          console.log(
            `[Boost:D] Seek boost skipped - rate: ${seekRate.toFixed(2)}x, can start: ${canStartBoostSession(state)}`,
          );
        }
      }

      state.seekDebounceTimer = null;
    }, BOOST_CONFIG.SEEK_DEBOUNCE_MS);
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Complete cleanup of boost state for a video
   * @param {HTMLVideoElement} video
   */
  function cleanupBoost(video) {
    if (!video) return;

    const state = boostTimers.get(video);
    if (state) {
      // Clear all timers
      if (state.monitorInterval) clearInterval(state.monitorInterval);
      if (state.boostTimeout) clearTimeout(state.boostTimeout);
      if (state.seekDebounceTimer) clearTimeout(state.seekDebounceTimer);

      // Restore normal playback rate if boosting
      if (state.isBoosting) {
        console.log(`[Boost] Restoring rate during cleanup`);
        video.playbackRate = state.originalRate;
      }

      boostTimers.delete(video);
    }

    // Clean up data attributes
    const attrsToDelete = [
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
    ];

    attrsToDelete.forEach((attr) => {
      delete video[attr];
    });

    delete video.dataset.continuousMonitorActive;
    delete video.dataset.boostAttached;
  }

  /**
   * Cleanup preview boost (kept for API compatibility)
   * @param {HTMLVideoElement} previewVideo
   */
  function cleanupPreviewBoost(previewVideo) {
    // Preview boost disabled - chunk previews handle their own buffering
    if (previewVideo) {
      delete previewVideo.__previewOriginalRate;
      delete previewVideo.__previewBoostActive;
      delete previewVideo.__previewBoostStartTime;
    }
  }

  /**
   * Preview boost (kept for API compatibility)
   * @param {HTMLVideoElement} previewVideo
   * @returns {Function} No-op cleanup
   */
  function boostPreviewBuffer(previewVideo) {
    return () => {};
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN BOOST ATTACHMENT (IMPROVED)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Attach buffer boost system to a video element
   * Fixed: Initial boost only triggers on first actual play, not on preload
   *
   * @param {HTMLVideoElement} video - The video element to boost
   * @returns {Function} Cleanup function to detach boost
   */
  function attachBoostToVideo(video) {
    if (!video || video.dataset.boostAttached === "true") {
      return () => {};
    }

    video.dataset.boostAttached = "true";

    const videoId = video.dataset.videoObserverId || "unknown";
    console.log(`[Boost] 🔗 Attaching to ${videoId}`);

    // Start continuous buffer monitor
    const stopMonitor = startContinuousBufferMonitor(video);

    // Event handlers
    const onSeeking = () => {
      video.__lastSeekTime = Date.now();

      // Stop any active boost during seek to prevent issues
      const state = boostTimers.get(video);
      if (state?.isBoosting) {
        stopForwardBoost(video, "seek started");
      }

      if (BOOST_CONFIG.DEBUG_VERBOSE) {
        console.log(
          `[Boost:D] Seek started at ${video.currentTime.toFixed(1)}s`,
        );
      }
    };

    const onSeeked = () => {
      video.__lastSeekTime = Date.now();

      if (typeof tabIsVisible === "undefined" || tabIsVisible) {
        if (BOOST_CONFIG.DEBUG_VERBOSE) {
          console.log(
            `[Boost:D] Seek completed at ${video.currentTime.toFixed(1)}s`,
          );
        }
        boostBufferAfterSeek(video);
      }
    };

    const onPlay = () => {
      const ahead = getBufferAhead(video);
      const state = boostTimers.get(video);

      video.__lastPlayTime = Date.now();

      if (BOOST_CONFIG.DEBUG_VERBOSE) {
        console.log(
          `[Boost:D] Play event | Buffer: ${ahead.toFixed(1)}s | ` +
            `Rate: ${video.playbackRate.toFixed(2)}x`,
        );
      }

      // INITIAL BOOST: Only on first real play, not on buffer preloads
      if (
        !state.hasInitialBoosted &&
        ahead < BOOST_CONFIG.BUFFER_LOW &&
        !video.dataset.bufferManagerBuffering
      ) {
        state.hasInitialBoosted = true;
        console.log(`[Boost] 🆕 Initial buffer boost for ${videoId}`);

        applyForwardBoost(
          video,
          BOOST_CONFIG.BOOST_RATE_NORMAL,
          "initial load",
        );
      }

      // Safety: ensure normal rate if not actively boosting
      if (!state?.isBoosting) {
        const trueOriginal = video.__trueOriginalPlaybackRate || 1.0;
        if (Math.abs(video.playbackRate - trueOriginal) > 0.01) {
          console.warn(
            `[Boost] ⚠️ Unexpected rate ${video.playbackRate.toFixed(2)}x, ` +
              `restoring to ${trueOriginal.toFixed(2)}x`,
          );
          video.playbackRate = trueOriginal;
        }
      }
    };

    const onPause = () => {
      const state = boostTimers.get(video);
      if (state?.isBoosting) {
        stopForwardBoost(video, "playback paused");
      }

      if (BOOST_CONFIG.DEBUG_VERBOSE) {
        console.log(`[Boost:D] Pause event`);
      }
    };

    // Attach event listeners
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);

    // Return cleanup function
    return () => {
      console.log(`[Boost] 🔌 Detaching from ${videoId}`);

      // Stop the monitor
      stopMonitor();

      // Complete cleanup
      cleanupBoost(video);

      // Remove event listeners
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);

      // Clean up data attributes
      const attrsToDelete = [
        "boostAttached",
        "__lastSeekTime",
        "__lastPlayTime",
        "__trueOriginalPlaybackRate",
        "__hasBoostedOnLoad",
      ];

      attrsToDelete.forEach((attr) => {
        if (attr.startsWith("__")) {
          delete video[attr];
        } else {
          delete video.dataset[attr];
        }
      });
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // GLOBAL API - Expose to other scripts
  // ═══════════════════════════════════════════════════════════════

  // Make boost functions available globally for content.js
  window.BoostEngine = {
    // Core functions
    attachBoostToVideo,
    cleanupBoost,
    getBufferAhead,
    getEffectiveBufferRatio,

    // Monitor control
    startContinuousBufferMonitor,

    // Seek handling
    boostBufferAfterSeek,

    // Preview (disabled but API preserved)
    boostPreviewBuffer,
    cleanupPreviewBoost,

    // Configuration (read-only)
    config: BOOST_CONFIG,

    // Debug utilities
    getBoostState,
    getActiveVideos: () => {
      // Note: WeakMap can't be iterated, but we can check known videos
      return "Use getBoostState(video) for individual videos";
    },
  };

  console.log("[Boost] ✅ Engine initialized - Forward boost ready (v2.0)");
  console.log(
    `[Boost] Config: Target=${BOOST_CONFIG.BUFFER_TARGET}s, ` +
      `Normal=${BOOST_CONFIG.BOOST_RATE_NORMAL}x, Critical=${BOOST_CONFIG.BOOST_RATE_CRITICAL}x, ` +
      `Seek=${BOOST_CONFIG.BOOST_RATE_SEEK}x, Sessions=${BOOST_CONFIG.MAX_BOOST_SESSIONS}`,
  );
}
