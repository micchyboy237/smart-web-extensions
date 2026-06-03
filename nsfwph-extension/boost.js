// boost.js - Forward Buffer Boost Engine (v2.6 - HIDDEN PRELOADER)
// Standalone module for smart buffer management
// Features: Hidden preloader for silent buffer protection (no fast-forward UX impact)
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
    MIN_FORWARD_BUFFER: 5,
    BUFFER_CRITICAL: 5,
    BUFFER_LOW: 8,
    BUFFER_COMFORT: 15,
    BUFFER_TARGET: 20,

    // Preloader settings (silent buffer protection)
    PRELOADER_ENABLED: true,
    PRELOADER_SYNC_INTERVAL: 2000, // Check every 2 seconds
    PRELOADER_ADVANCE_SEEK: 20, // Seek 20s ahead of current position
    PRELOADER_MAX_AHEAD: 60, // Don't seek more than 60s ahead
    PRELOADER_STOP_AT_BUFFER: 20, // Stop preloader when main buffer >= this

    // Boost rates (kept for emergency/compatibility but NOT applied to playbackRate)
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

    // DEBUG - Enable for detailed preloader logs
    DEBUG_VERBOSE: true, // ← ENABLED for verification
    DEBUG_PRELOADER: true, // ← NEW: Preloader-specific debug flag
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

  // Get total buffered range (for comparing main vs preloader)
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
  // HIDDEN PRELOADER - Silent buffer protection (NO fast-forward)
  // ═══════════════════════════════════════════════════════════════
  /**
   * Creates a hidden <video> element that silently downloads video data
   * ahead of the user's playback position. Since the browser caches video
   * data by URL, the main video benefits from this preloaded data.
   *
   * ┌─────────────────────────────────────────────────────────────┐
   * │                    HOW IT WORKS                              │
   * ├─────────────────────────────────────────────────────────────┤
   * │                                                              │
   * │   Main Video (visible)         Preloader (hidden)            │
   * │   ┌──────────────────┐        ┌──────────────────┐          │
   * │   │ You watch here   │        │ Seeks ahead      │          │
   * │   │ at 1.0x speed    │        │ to trigger       │          │
   * │   │                  │        │ download         │          │
   * │   │ ████████░░░░░░░░ │        │ ░░░░░░░░████████ │          │
   * │   │ current  future  │        │  skip    future  │          │
   * │   │ buffer           │        │  ahead   data    │          │
   * │   └──────────────────┘        └──────────────────┘          │
   * │                                                              │
   * │   Same URL → Browser cache shared → Main video benefits     │
   * │                                                              │
   * └─────────────────────────────────────────────────────────────┘
   */
  function createHiddenPreloader(originalVideo) {
    if (!BOOST_CONFIG.PRELOADER_ENABLED) {
      console.log("[Preloader] ⏭️ Disabled in config, skipping");
      return { cleanup: () => {}, preloader: null };
    }

    const videoId = originalVideo.dataset.videoObserverId || "unknown";
    const videoSrc = originalVideo.currentSrc || originalVideo.src;

    if (!videoSrc) {
      console.warn(
        `[Preloader] ❌ No source for ${videoId}, cannot create preloader`,
      );
      return { cleanup: () => {}, preloader: null };
    }

    console.log(`[Preloader] 🎬 Creating hidden preloader for ${videoId}`);
    console.log(`[Preloader:D] Source: ${videoSrc.substring(0, 80)}...`);

    const preloader = document.createElement("video");

    // Make it completely invisible and inert
    preloader.style.cssText = `
      position: fixed !important;
      width: 1px !important;
      height: 1px !important;
      opacity: 0 !important;
      pointer-events: none !important;
      top: -9999px !important;
      left: -9999px !important;
      visibility: hidden !important;
      z-index: -1 !important;
    `;

    // Copy the source (browser will recognize same URL and share cache)
    preloader.src = videoSrc;
    preloader.muted = true;
    preloader.preload = "auto";
    preloader.volume = 0; // Ensure no audio processing
    preloader.dataset.isPreloader = "true";

    // Performance: request minimal decoding
    if ("decoding" in preloader) {
      preloader.decoding = "async"; // Don't block main thread for decoding
    }

    // State tracking for logs
    let preloaderStats = {
      seekCount: 0,
      lastSeekTime: 0,
      lastLogTime: Date.now(),
      bytesDownloaded: 0,
      isActive: false,
    };

    // ─── Event: Metadata loaded ───
    preloader.addEventListener(
      "loadedmetadata",
      () => {
        const duration = preloader.duration;
        console.log(
          `[Preloader] 📋 Metadata loaded for ${videoId} | Duration: ${duration?.toFixed(1)}s`,
        );

        if (duration && isFinite(duration)) {
          // Start downloading from current position
          const currentTime = originalVideo.currentTime;
          preloader.currentTime = Math.min(currentTime, duration - 1);
          console.log(
            `[Preloader] 🎯 Initial seek to ${preloader.currentTime.toFixed(1)}s (main at ${currentTime.toFixed(1)}s)`,
          );
          preloaderStats.seekCount++;
          preloaderStats.lastSeekTime = Date.now();
        }
      },
      { once: true },
    );

    // ─── Event: Seeking ───
    preloader.addEventListener("seeking", () => {
      if (BOOST_CONFIG.DEBUG_PRELOADER) {
        console.log(
          `[Preloader] 🔍 Seeking to ${preloader.currentTime?.toFixed(1)}s...`,
        );
      }
    });

    // ─── Event: Seeked ───
    preloader.addEventListener("seeked", () => {
      preloaderStats.seekCount++;
      preloaderStats.lastSeekTime = Date.now();
      if (BOOST_CONFIG.DEBUG_PRELOADER) {
        const buffered = getTotalBufferedRange(preloader);
        console.log(
          `[Preloader] ✅ Seeked to ${preloader.currentTime.toFixed(1)}s | Buffered: ${buffered.start.toFixed(1)}s–${buffered.end.toFixed(1)}s`,
        );
      }
    });

    // ─── Event: Progress (data downloaded) ───
    preloader.addEventListener("progress", () => {
      const buffered = getTotalBufferedRange(preloader);
      const totalBuffered = buffered.end - buffered.start;
      if (
        BOOST_CONFIG.DEBUG_PRELOADER &&
        Date.now() - preloaderStats.lastLogTime > 5000
      ) {
        preloaderStats.lastLogTime = Date.now();
        console.log(
          `[Preloader] 📥 Downloading... | Total buffered: ${totalBuffered.toFixed(1)}s (${buffered.start.toFixed(1)}–${buffered.end.toFixed(1)})`,
        );
      }
    });

    // ─── Event: Waiting (stalled) ───
    preloader.addEventListener("waiting", () => {
      if (BOOST_CONFIG.DEBUG_PRELOADER) {
        console.log(
          `[Preloader] ⏳ Waiting for data at ${preloader.currentTime?.toFixed(1)}s...`,
        );
      }
    });

    // ─── Event: Error ───
    preloader.addEventListener("error", (e) => {
      console.error(
        `[Preloader] ❌ Error:`,
        preloader.error?.message || "Unknown error",
      );
    });

    // Add to DOM (required for loading)
    document.body.appendChild(preloader);
    console.log(`[Preloader] 📌 Added to DOM for ${videoId}`);

    // ─── Sync Loop: Keep preloader ahead of main video ───
    let syncIteration = 0;
    const syncInterval = setInterval(() => {
      syncIteration++;

      // Clean up if main video is gone
      if (!document.body.contains(originalVideo)) {
        console.log(
          `[Preloader] 🗑️ Main video removed, cleaning up preloader for ${videoId}`,
        );
        clearInterval(syncInterval);
        preloader.pause();
        preloader.remove();
        return;
      }

      const mainBuffer = getBufferAhead(originalVideo);
      const mainTime = originalVideo.currentTime;
      const mainDuration = originalVideo.duration || Infinity;
      const mainBuffered = getTotalBufferedRange(originalVideo);
      const preloaderBuffered = getTotalBufferedRange(preloader);

      const isMainPlaying = !originalVideo.paused;
      const needsMoreBuffer =
        mainBuffer < BOOST_CONFIG.PRELOADER_STOP_AT_BUFFER;

      // ─── Log every 10 iterations or on state change ───
      const wasActive = preloaderStats.isActive;
      preloaderStats.isActive = isMainPlaying && needsMoreBuffer;

      if (syncIteration % 10 === 0 || wasActive !== preloaderStats.isActive) {
        console.log(
          `[Preloader] 📊 Sync #${syncIteration} | ` +
            `Main: ${mainTime.toFixed(1)}s (buffer: ${mainBuffer.toFixed(1)}s, range: ${mainBuffered.start.toFixed(1)}–${mainBuffered.end.toFixed(1)}) | ` +
            `Preloader: ${preloader.currentTime.toFixed(1)}s (range: ${preloaderBuffered.start.toFixed(1)}–${preloaderBuffered.end.toFixed(1)}) | ` +
            `Active: ${preloaderStats.isActive} | Seeks: ${preloaderStats.seekCount}`,
        );
      }

      // ─── Decision: Should preloader be active? ───
      if (isMainPlaying && needsMoreBuffer) {
        // Main is playing and buffer is below comfort → preloader works
        const targetTime = Math.min(
          mainTime + BOOST_CONFIG.PRELOADER_ADVANCE_SEEK,
          Math.min(
            mainTime + BOOST_CONFIG.PRELOADER_MAX_AHEAD,
            mainDuration - 0.5,
          ),
        );

        // Only seek if target is meaningfully different
        if (Math.abs(preloader.currentTime - targetTime) > 1.0) {
          console.log(
            `[Preloader] 🎯 Seeking ahead: ${preloader.currentTime.toFixed(1)}s → ${targetTime.toFixed(1)}s (main at ${mainTime.toFixed(1)}s, buffer: ${mainBuffer.toFixed(1)}s)`,
          );
          preloader.currentTime = targetTime;
        }

        // Keep preloader "playing" to trigger download
        if (preloader.paused) {
          console.log(`[Preloader] ▶️ Starting preloader playback`);
          preloader.play().catch((err) => {
            console.warn(`[Preloader] ⚠️ Play failed:`, err.message);
          });
        }
      } else if (!isMainPlaying) {
        // Main is paused - pause preloader to save bandwidth
        if (!preloader.paused && preloaderStats.isActive) {
          console.log(`[Preloader] ⏸️ Main paused, pausing preloader`);
          preloader.pause();
        }
      } else if (mainBuffer >= BOOST_CONFIG.PRELOADER_STOP_AT_BUFFER) {
        // Buffer is sufficient
        if (!preloader.paused) {
          console.log(
            `[Preloader] ✅ Buffer sufficient (${mainBuffer.toFixed(1)}s ≥ ${BOOST_CONFIG.PRELOADER_STOP_AT_BUFFER}s), pausing preloader`,
          );
          preloader.pause();
        }
      }
    }, BOOST_CONFIG.PRELOADER_SYNC_INTERVAL);

    console.log(
      `[Preloader] ✅ Preloader initialized for ${videoId} | Sync interval: ${BOOST_CONFIG.PRELOADER_SYNC_INTERVAL}ms`,
    );

    return {
      cleanup: () => {
        console.log(
          `[Preloader] 🧹 Cleaning up preloader for ${videoId} | Total seeks: ${preloaderStats.seekCount}`,
        );
        clearInterval(syncInterval);
        preloader.pause();
        preloader.removeAttribute("src");
        preloader.load();
        preloader.remove();
      },
      preloader,
      getStats: () => ({ ...preloaderStats }),
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
      preloaderController: null, // ← NEW: Track preloader in state
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
  // ADAPTIVE RATE CALCULATION (kept for logging/reference)
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
  // CONTINUOUS BUFFER MONITOR (now preloader-aware)
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
        `Preloader: ${BOOST_CONFIG.PRELOADER_ENABLED ? "✅ ON" : "❌ OFF"}`,
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
        const preloaderStatus = state.preloaderController?.getStats
          ? `Preloader: ${state.preloaderController.getStats().isActive ? "🟢" : "🔴"}`
          : "Preloader: N/A";
        console.log(
          `[Boost] 📊 Buffer: ${ahead.toFixed(1)}s${isBelowMinimum ? " ⚠️BELOW MIN" : ""} | ` +
            `Rate: ${video.playbackRate.toFixed(2)}x | Level: ${state.currentBoostLevel} | ` +
            `Sessions: ${state.boostSessionCount} | Play: ${(state.totalPlayTime / 1000).toFixed(0)}s | ` +
            `${preloaderStatus}`,
        );
      }

      // NOTE: We do NOT modify playbackRate anymore.
      // The preloader handles buffer growth silently.
      // We only log warnings when buffer is critically low.

      if (isBelowMinimum && state.bufferWarningCount < 100) {
        state.bufferWarningCount++;
        if (state.bufferWarningCount % 5 === 0) {
          console.warn(
            `[Boost] ⚠️ Buffer critically low: ${ahead.toFixed(1)}s | ` +
              `Warning #${state.bufferWarningCount} | ` +
              `Preloader should be helping...`,
          );
        }
      }

      // Ensure rate stays at normal
      if (video.playbackRate !== state.originalRate && !state.isBoosting) {
        // video.playbackRate = state.originalRate;  // ← Still commented out
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
  // BOOST APPLICATION (kept for compatibility, does NOT change rate)
  // ═══════════════════════════════════════════════════════════════
  function applyForwardBoost(video, targetRate, level, reason = "unknown") {
    // NOTE: playbackRate modification is intentionally disabled.
    // The preloader handles buffer growth silently.
    if (!video || video.paused) return false;
    const state = getBoostState(video);
    if (!state) return false;
    const ahead = getBufferAhead(video);
    state.lastBufferAhead = ahead;

    console.log(
      `[Boost] 💡 Would boost: 1.00x → ${targetRate.toFixed(2)}x | ` +
        `${level.toUpperCase()} | ${reason} | Buffer: ${ahead.toFixed(1)}s | ` +
        `(Boost disabled - preloader handles buffer instead)`,
    );

    return false; // Don't actually boost
  }

  function stopForwardBoost(video, reason = "target reached") {
    // No-op since we don't boost
    return;
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
      if (state.preloaderController) {
        state.preloaderController.cleanup();
        state.preloaderController = null;
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
  // MAIN BOOST ATTACHMENT (with hidden preloader)
  // ═══════════════════════════════════════════════════════════════
  function attachBoostToVideo(video) {
    if (!video || video.dataset.boostAttached === "true") return () => {};
    video.dataset.boostAttached = "true";
    const videoId = video.dataset.videoObserverId || "unknown";

    console.log(
      `[Boost] 🔗 Attached to ${videoId} | Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | ` +
        `Preloader: ${BOOST_CONFIG.PRELOADER_ENABLED ? "✅" : "❌"}`,
    );

    // Start hidden preloader for silent buffer protection
    const preloaderController = createHiddenPreloader(video);

    // Store preloader in state for monitoring
    const state = getBoostState(video);
    if (state) {
      state.preloaderController = preloaderController;
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
          `[Boost] ⚠️ Pausing with buffer below minimum: ${ahead.toFixed(1)}s | ` +
            `Preloader will continue downloading`,
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
      if (preloaderController) preloaderController.cleanup();
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
    boostPreviewBuffer,
    cleanupPreviewBoost,
    config: BOOST_CONFIG,
    getBoostState,
    createHiddenPreloader, // ← Exposed for debugging
  };

  console.log("[Boost] ✅ v2.6 Ready - Hidden Preloader Mode");
  console.log(
    `[Boost] Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | Target: ${BOOST_CONFIG.BUFFER_TARGET}s`,
  );
  console.log(
    `[Boost] Preloader: ${BOOST_CONFIG.PRELOADER_ENABLED ? "✅ Active (no fast-forward)" : "❌ Disabled"}`,
  );
  console.log(
    `[Boost] Debug: ${BOOST_CONFIG.DEBUG_VERBOSE ? "✅ Verbose" : "❌ Silent"}`,
  );
}
