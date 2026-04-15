(() => {
  if (window.__FASTSTREAM_MP4__) return;
  window.__FASTSTREAM_MP4__ = true;
  console.log("🔥 [FastStream] injector loaded");

  // Buffer thresholds - consistent for page load and seeks
  const BUFFER_LOW = 5;
  const BOOST_DURATION = 8000; // 8 seconds - for page load
  const INITIAL_BUFFER_TARGET = 12; // for page load
  const SEEK_BOOST_RATE = 1.5; // stronger nudge after seek
  const SEEK_BOOST_DURATION = 10000; // 10 seconds for seeks only

  // 🆕 New: Seek retention awareness
  const SEEK_MIN_EFFECTIVE_RATIO = 0.6; // require ≥60% of buffer to be ahead after seek
  const SEEK_BOOST_EXTENSION = 5000; // extend boost by 5s if ratio is low

  // 🆕 NEW: Hard caps to prevent runaway boost extensions
  const MAX_BOOST_EXTENSIONS = 3; // Max times we'll extend beyond base duration
  const MAX_TOTAL_BOOST_MS = 30000; // Absolute max: 30 seconds total boost

  function formatTime(t) {
    return t.toFixed(2) + "s";
  }

  // 🔧 Fix 2: Graceful Handling of Negative Buffer Ahead
  function getBufferAhead(video) {
    if (!video.buffered.length) return 0;
    const ahead =
      video.buffered.end(video.buffered.length - 1) - video.currentTime;
    // 🆕 Return 0 for negative values (seeked beyond buffer) to avoid confusing logs
    if (ahead < 0) {
      console.log(
        `🔄 Seeked beyond buffer: ${ahead.toFixed(2)}s → treating as 0s ahead`,
      );
      return 0;
    }
    return ahead;
  }

  // 🆕 NEW: Calculate what % of total buffered time is actually ahead of playhead
  function getEffectiveBufferRatio(video) {
    if (!video.buffered.length) return 0;
    let totalBuffered = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      totalBuffered += video.buffered.end(i) - video.buffered.start(i);
    }
    const ahead = getBufferAhead(video);
    return totalBuffered > 0 ? Math.min(1, ahead / totalBuffered) : 1;
  }

  function logBuffer(video, label = "") {
    const ranges = [];
    for (let i = 0; i < video.buffered.length; i++) {
      ranges.push(
        `[${formatTime(video.buffered.start(i))} → ${formatTime(
          video.buffered.end(i),
        )}]`,
      );
    }
    console.log("📊 [BUFFER]", label, {
      currentTime: formatTime(video.currentTime),
      bufferAhead: formatTime(getBufferAhead(video)),
      ranges,
    });
  }

  function attachVideoListeners(video) {
    if (video.__FASTSTREAM_ATTACHED__) return;
    video.__FASTSTREAM_ATTACHED__ = true;
    console.log("🎬 [FastStream] Video detected:", video);

    let boostTimeout = null;

    video.addEventListener("seeking", () => {
      console.log("⏩ seeking started");
      if (boostTimeout) clearTimeout(boostTimeout);
    });

    // Early check for page-load buffering (runs once)
    setTimeout(() => {
      const ahead = getBufferAhead(video);
      if (ahead < INITIAL_BUFFER_TARGET && !video.__hasBoostedOnLoad) {
        console.log(
          `📈 Page load buffer low (${formatTime(ahead)}), triggering 8s boost...`,
        );
        boostBufferAfterSeek(video, false);
        video.__hasBoostedOnLoad = true;
      }
    }, 600);

    // Improved seek handling
    video.addEventListener("seeked", () => {
      console.log("✅ seeked finished");

      // 🆕 NEW: Check if retained old buffer reduces effective forward buffer
      const ratio = getEffectiveBufferRatio(video);
      const needsExtension = ratio < SEEK_MIN_EFFECTIVE_RATIO;

      if (needsExtension) {
        console.log(
          `📉 Low effective buffer ratio (${(ratio * 100).toFixed(0)}%) after seek, extending boost...`,
        );
        boostBufferAfterSeek(video, true, { extendDuration: true });
      } else {
        boostBufferAfterSeek(video, true);
      }

      logBuffer(video, "after seek");
    });

    video.addEventListener("play", () => {
      console.log("▶️ play");
      logBuffer(video, "on play");
    });

    video.addEventListener("pause", () => {
      console.log("⏸ pause");
      logBuffer(video, "on pause");
    });

    video.addEventListener("waiting", () => {
      console.log("⏳ waiting (buffer underrun)");
      logBuffer(video, "waiting");
    });

    video.addEventListener("progress", () => {
      logBuffer(video, "progress");
    });

    video.addEventListener("timeupdate", () => {
      logBuffer(video, "timeupdate");
    });

    // 🔧 Fix 4: Suppress Low-Buffer Warnings During Active Boost
    setInterval(() => {
      if (video.paused) return;
      logBuffer(video, "interval");
      const ahead = getBufferAhead(video);
      if (ahead < BUFFER_LOW) {
        // 🆕 Don't warn if we're actively boosting (expected temporary low buffer)
        if (!video.__boostTimeout) {
          console.warn(`⚠️ LOW BUFFER: ${formatTime(ahead)}`);
        } else {
          console.log(
            `⏳ Boost active, buffer low but expected: ${formatTime(ahead)}`,
          );
        }
      }
    }, 1000);
  }

  // 🆕 Updated: Unified buffer booster with duration extension support and hard caps
  function boostBufferAfterSeek(video, isSeek = false, options = {}) {
    if (!video) return;
    const { extendDuration = false } = options;

    // 🔧 Fix 3: Adaptive Boost Rate Based on Network Conditions
    let rate = isSeek ? SEEK_BOOST_RATE : 1.08;
    if (isSeek) {
      const initialAhead = getBufferAhead(video);
      // If buffer was very low after seek, use gentler boost to avoid overwhelming server
      if (initialAhead < 2) {
        rate = Math.min(rate, 1.25);
        console.log(
          `🎚 Adaptive rate: using ${rate}x (gentle) due to very low post-seek buffer`,
        );
      }
    }

    let duration = isSeek ? SEEK_BOOST_DURATION : BOOST_DURATION;

    // 🆕 NEW: Extend duration if post-seek buffer is mostly "dead" (behind playhead)
    if (extendDuration && isSeek) {
      const originalDuration = duration;
      duration = Math.min(
        duration + SEEK_BOOST_EXTENSION,
        SEEK_BOOST_DURATION + SEEK_BOOST_EXTENSION,
      );
      console.log(
        `⏱ Extended boost to ${duration / 1000}s (was ${originalDuration / 1000}s)`,
      );
    }

    console.log(
      `🚀 Starting ${duration / 1000}s buffer boost (${rate}x)${isSeek ? " [AFTER SEEK]" : " [PAGE LOAD]"}`,
    );

    const originalRate = video.playbackRate || 1.0;
    const targetRate = rate;

    // Optional extra nudge for seeks: brief pause + play can help trigger prefetch on some sites
    if (isSeek && !video.paused) {
      const wasPlaying = true;
      video.pause();
      setTimeout(() => {
        if (wasPlaying) video.play().catch(() => {});
      }, 50);
    }

    video.playbackRate = targetRate;
    if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
    // 🆕 NEW: Initialize boost tracking
    video.__boostStartTime = Date.now(); // Track when boost started
    video.__boostExtensionCount = 0;
    video.__boostBaseDuration = duration; // Store original duration for calculations

    // 🆕 NEW: Single recursive handler with clear termination logic
    function checkBoostEnd() {
      // 🆕 NEW: Only restore rate if buffer is now healthy
      const currentAhead = getBufferAhead(video);
      const elapsed = Date.now() - video.__boostStartTime;

      // Determine termination reason for logging
      let endReason = null;
      if (currentAhead >= BUFFER_LOW * 1.5) {
        endReason = "buffer healthy";
      } else if (video.__boostExtensionCount >= MAX_BOOST_EXTENSIONS) {
        endReason = `max extensions reached (${MAX_BOOST_EXTENSIONS}/${MAX_BOOST_EXTENSIONS})`;
      } else if (elapsed > MAX_TOTAL_BOOST_MS) {
        endReason = `max total time reached (${MAX_TOTAL_BOOST_MS / 1000}s)`;
      } else if (
        elapsed >
        video.__boostBaseDuration +
          video.__boostExtensionCount * SEEK_BOOST_EXTENSION
      ) {
        // Time for this "stage" has elapsed
        if (
          video.__boostExtensionCount < MAX_BOOST_EXTENSIONS &&
          elapsed <= MAX_TOTAL_BOOST_MS
        ) {
          // Can extend further
          video.__boostExtensionCount++;
          console.log(
            `⏳ Buffer still low (${currentAhead.toFixed(2)}s), extending boost (${video.__boostExtensionCount}/${MAX_BOOST_EXTENSIONS})...`,
          );
          // Schedule next check in SEEK_BOOST_EXTENSION ms
          video.__boostTimeout = setTimeout(
            checkBoostEnd,
            SEEK_BOOST_EXTENSION,
          );
          return;
        } else {
          // Can't extend further - determine final reason
          if (video.__boostExtensionCount >= MAX_BOOST_EXTENSIONS) {
            endReason = `max extensions reached (${MAX_BOOST_EXTENSIONS}/${MAX_BOOST_EXTENSIONS})`;
          } else {
            endReason = `max total time reached (${MAX_TOTAL_BOOST_MS / 1000}s)`;
          }
        }
      }

      // If we reach here, boost is ending
      if (currentAhead >= BUFFER_LOW * 1.5 || endReason !== null) {
        if (video.playbackRate === targetRate) {
          video.playbackRate = originalRate;
          const reason = endReason ? ` (${endReason})` : " (unknown reason)";
          console.log(
            `✅ Boost ended: buffer ${currentAhead >= BUFFER_LOW * 1.5 ? "healthy" : "still low"} ` +
              `(${currentAhead.toFixed(2)}s)${reason}`,
          );
        }
      }
      logBuffer(video, "after boost");
    }

    // Start the first check after base duration
    video.__boostTimeout = setTimeout(checkBoostEnd, video.__boostBaseDuration);
  }

  function detectVideos() {
    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      attachVideoListeners(video);
    });
  }

  detectVideos();
  const observer = new MutationObserver(detectVideos);
  observer.observe(document, { childList: true, subtree: true });
})();
