// buffer-boost.js - Buffer Boost Engine for intermittent connections
// Supports both main videos AND preview videos with continuous buffer maintenance

/**
 * Buffer Boost Engine
 * Provides aggressive buffering strategies for slow/intermittent connections
 * Handles both main video playback and preview video buffering
 */
(function () {
  "use strict";

  console.log("[BufferBoost] Module loading...");

  // ═══════════════════════════════════════════════════════════════
  // BOOST CONFIGURATION
  // ═══════════════════════════════════════════════════════════════
  const BOOST_CONFIG = {
    // Buffer thresholds - more aggressive for intermittent connections
    BUFFER_LOW: 5, // Start boosting below this
    BUFFER_TARGET: 15, // Stop boosting when reaching this (increased from 12)
    BUFFER_CRITICAL: 2, // Critical low - use faster boost

    // Boost timing
    BOOST_DURATION: 10000, // Max single boost duration (increased from 8000)
    INITIAL_BUFFER_TARGET: 15,
    MONITOR_INTERVAL: 1500, // Check every 1.5s (less CPU, still responsive)
    BOOST_COOLDOWN: 2000, // Cooldown between boost attempts (reduced from 3000)

    // Boost rates - adaptive based on buffer level
    BOOST_RATE_NORMAL: 1.15, // Normal boost (increased from 1.08 for slow connections)
    BOOST_RATE_CRITICAL: 1.3, // Faster boost when buffer is critical
    BOOST_RATE_SEEK: 1.5, // Fastest boost after seeking
    BOOST_RATE_MIN: 1.05, // Minimum boost to use when close to target

    // Seek handling
    SEEK_BOOST_RATE: 1.5,
    SEEK_BOOST_DURATION: 15000, // Longer boost after seek (increased from 10000)
    SEEK_DEBOUNCE_MS: 500, // Debounce rapid seeks
    SEEK_MIN_EFFECTIVE_RATIO: 0.6,

    // Limits
    MAX_BOOST_EXTENSIONS: 5, // More extensions allowed (increased from 3)
    MAX_TOTAL_BOOST_MS: 45000, // Longer max total boost (increased from 30000)

    // Connection quality detection
    SLOW_CONNECTION_THRESHOLD: 0.5, // Buffer growth < 0.5s per second = slow connection
    CONNECTION_CHECK_WINDOW: 5000, // Check connection speed over 5 seconds

    // Preview settings
    PREVIEW_BOOST_RATE: 1.08,
    PREVIEW_BOOST_DURATION: 4000,
    PREVIEW_BUFFER_TARGET: 3,
    PREVIEW_CHECK_INTERVAL: 500,
  };

  const boostTimers = new WeakMap();
  const previewBoostTimers = new WeakMap();

  // ═══════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get buffered time ahead of current position
   */
  function getBufferAhead(video) {
    if (!video || video.readyState < 1) return 0;
    try {
      const buffered = video.buffered;
      if (buffered.length === 0) return 0;

      const currentTime = video.currentTime;
      let maxBuffered = currentTime;

      for (let i = 0; i < buffered.length; i++) {
        if (
          currentTime >= buffered.start(i) &&
          currentTime <= buffered.end(i)
        ) {
          maxBuffered = Math.max(maxBuffered, buffered.end(i));
        }
      }

      return Math.max(0, maxBuffered - currentTime);
    } catch (e) {
      return 0;
    }
  }

  /**
   * Detect if connection appears slow based on buffer growth rate
   */
  function detectSlowConnection(video) {
    if (!video || video.readyState < 2) return false;

    const bufferStart = getBufferAhead(video);
    const startTime = Date.now();

    return new Promise((resolve) => {
      setTimeout(() => {
        const bufferEnd = getBufferAhead(video);
        const elapsed = (Date.now() - startTime) / 1000;

        if (elapsed < 0.1) {
          resolve(false);
          return;
        }

        const growthRate = (bufferEnd - bufferStart) / elapsed;
        const isSlow = growthRate < BOOST_CONFIG.SLOW_CONNECTION_THRESHOLD;

        console.log(
          `[BufferBoost] Connection check: growth ${growthRate.toFixed(3)}s/s, ` +
            `${isSlow ? "SLOW" : "normal"} connection detected`,
        );

        resolve(isSlow);
      }, BOOST_CONFIG.CONNECTION_CHECK_WINDOW);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOST FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Attach buffer boost to a main video element
   */
  function attachBoostToVideo(video) {
    if (!video || video.dataset.boostAttached === "true") {
      return () => {};
    }

    video.dataset.boostAttached = "true";
    console.log(
      `[BufferBoost] Attaching boost to video ${video.dataset.videoObserverId || "unknown"}`,
    );

    const cleanup = startContinuousBufferMonitor(video);

    return () => {
      cleanup();
      delete video.dataset.boostAttached;
      cleanupBoost(video);
    };
  }

  /**
   * Start continuous buffer monitoring for a main video
   */
  function startContinuousBufferMonitor(video) {
    if (!video) return () => {};

    const intervalId = setInterval(() => {
      if (video.paused || video.ended) return;

      const bufferAhead = getBufferAhead(video);

      if (bufferAhead < BOOST_CONFIG.BUFFER_LOW) {
        console.log(
          `[BufferBoost] Low buffer detected (${bufferAhead.toFixed(1)}s), ` +
            `boosting for ${video.dataset.videoObserverId || "unknown"}`,
        );

        if (bufferAhead < BOOST_CONFIG.BUFFER_CRITICAL) {
          applyBoost(
            video,
            BOOST_CONFIG.BOOST_RATE_CRITICAL,
            BOOST_CONFIG.BOOST_DURATION,
          );
        } else {
          applyBoost(
            video,
            BOOST_CONFIG.BOOST_RATE_NORMAL,
            BOOST_CONFIG.BOOST_DURATION,
          );
        }
      }
    }, BOOST_CONFIG.MONITOR_INTERVAL);

    console.log(
      `[BufferBoost] Continuous monitor started for video ${video.dataset.videoObserverId || "unknown"}`,
    );

    return () => {
      clearInterval(intervalId);
      console.log(
        `[BufferBoost] Continuous monitor stopped for video ${video.dataset.videoObserverId || "unknown"}`,
      );
    };
  }

  /**
   * Apply playback rate boost to fill buffer faster
   */
  function applyBoost(video, rate, duration) {
    if (!video || video.paused) return;

    const currentRate = video.playbackRate;
    const targetRate = Math.min(rate, 16); // Cap at 16x

    video.playbackRate = targetRate;

    console.log(
      `[BufferBoost] Boosting at ${targetRate}x for ${duration}ms ` +
        `(was ${currentRate}x) on ${video.dataset.videoObserverId || "unknown"}`,
    );

    setTimeout(() => {
      if (video && video.playbackRate === targetRate) {
        video.playbackRate = currentRate;
        console.log(`[BufferBoost] Boost ended, restored ${currentRate}x`);
      }
    }, duration);
  }

  /**
   * Boost buffer specifically after seeking
   */
  function boostBufferAfterSeek(video) {
    if (!video || video.paused) return;

    const bufferAhead = getBufferAhead(video);

    if (
      bufferAhead <
      BOOST_CONFIG.BUFFER_TARGET * BOOST_CONFIG.SEEK_MIN_EFFECTIVE_RATIO
    ) {
      console.log(
        `[BufferBoost] Post-seek boost for ${video.dataset.videoObserverId || "unknown"} ` +
          `(buffer: ${bufferAhead.toFixed(1)}s)`,
      );
      applyBoost(
        video,
        BOOST_CONFIG.SEEK_BOOST_RATE,
        BOOST_CONFIG.SEEK_BOOST_DURATION,
      );
    }
  }

  /**
   * Boost preview video buffer
   */
  function boostPreviewBuffer(previewVideo) {
    if (!previewVideo || previewVideo.paused) return () => {};

    const videoId = previewVideo.dataset.videoObserverId || "unknown";
    console.log(`[BufferBoost] Starting preview boost for ${videoId}`);

    const originalRate = previewVideo.playbackRate;
    previewVideo.playbackRate = BOOST_CONFIG.PREVIEW_BOOST_RATE;

    const boostTimeout = setTimeout(() => {
      if (previewVideo) {
        previewVideo.playbackRate = originalRate;
        console.log(`[BufferBoost] Preview boost ended for ${videoId}`);
      }
    }, BOOST_CONFIG.PREVIEW_BOOST_DURATION);

    return () => {
      clearTimeout(boostTimeout);
      if (
        previewVideo &&
        previewVideo.playbackRate === BOOST_CONFIG.PREVIEW_BOOST_RATE
      ) {
        previewVideo.playbackRate = originalRate;
      }
      console.log(`[BufferBoost] Preview boost cleaned up for ${videoId}`);
    };
  }

  /**
   * Clean up all boost timers for a video
   */
  function cleanupBoost(video) {
    if (!video) return;

    const timers = boostTimers.get(video);
    if (timers) {
      timers.forEach((timer) => clearTimeout(timer));
      timers.forEach((timer) => clearInterval(timer));
      boostTimers.delete(video);
    }

    // Reset playback rate if it was modified
    if (video.playbackRate > 1.0 && video.playbackRate < 16) {
      video.playbackRate = 1.0;
    }

    console.log(
      `[BufferBoost] Cleaned up for video ${video.dataset.videoObserverId || "unknown"}`,
    );
  }

  /**
   * Clean up preview boost timers
   */
  function cleanupPreviewBoost(previewVideo) {
    if (!previewVideo) return;

    const timers = previewBoostTimers.get(previewVideo);
    if (timers) {
      timers.forEach((timer) => clearTimeout(timer));
      timers.forEach((timer) => clearInterval(timer));
      previewBoostTimers.delete(previewVideo);
    }

    if (previewVideo.playbackRate > 1.0 && previewVideo.playbackRate < 16) {
      previewVideo.playbackRate = 1.0;
    }

    console.log(
      `[BufferBoost] Preview boost cleaned up for ${previewVideo.dataset.videoObserverId || "unknown"}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPORT TO GLOBAL SCOPE
  // ═══════════════════════════════════════════════════════════════

  window.BoostEngine = window.BoostEngine || {
    config: BOOST_CONFIG,
    getBufferAhead,
    attachBoostToVideo,
    startContinuousBufferMonitor,
    boostBufferAfterSeek,
    boostPreviewBuffer,
    cleanupBoost,
    cleanupPreviewBoost,
    detectSlowConnection,
    applyBoost,
  };

  console.log("[BufferBoost] Module loaded successfully ✅");
  console.log("[BufferBoost] Config:", {
    bufferLow: BOOST_CONFIG.BUFFER_LOW,
    bufferTarget: BOOST_CONFIG.BUFFER_TARGET,
    bufferCritical: BOOST_CONFIG.BUFFER_CRITICAL,
    boostDuration: BOOST_CONFIG.BOOST_DURATION + "ms",
    monitorInterval: BOOST_CONFIG.MONITOR_INTERVAL + "ms",
    previewBoostDuration: BOOST_CONFIG.PREVIEW_BOOST_DURATION + "ms",
  });
})();
