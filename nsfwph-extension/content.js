// content.js - Stable DOM + SINGLE PLAYBACK + LIGHTWEIGHT CHUNK PREVIEWS + RAM optimized
// + SMART BUFFER BOOST for main videos AND previews (ported from nsfwph-fastream-extension)
// BACKGROUND TAB FIX: chunk previews, interval, and MutationObserver all pause when tab is hidden

let videos = new Map(); // video element → entry
let videoCards = new Map(); // video element → card DOM element
let currentlyPlaying = null; // Global: only one video plays at a time
let videoCounter = 0;
let panel = null;
let isPanelVisible = true;
let globalResources = {
  observers: [],
  intervals: [],
};
// Tracks whether the tab is currently visible to the user
let tabIsVisible = !document.hidden;
// Keeps a reference to the MutationObserver so we can disconnect/reconnect it
let domObserver = null;
// Keeps a reference to the polling interval so we can clear/restart it
let pollingInterval = null;
const MAX_GALLERY_ITEMS = 6;
const SELECTOR = ".message-inner video";
// Settings for lightweight chunk preview (2-3 second moving clips that loop)
const NUM_PREVIEW_CHUNKS = 5;
const CHUNK_PLAY_DURATION_MS = 400; // 0.4s per chunk → ~2s full cycle

// ═══════════════════════════════════════════════════════════════
// BUFFER BOOST ENGINE (ported from nsfwph-fastream-extension)
// Now supports both main videos AND preview videos
// ═══════════════════════════════════════════════════════════════
const BOOST_CONFIG = {
  // Main video settings
  BUFFER_LOW: 5,
  BOOST_DURATION: 8000,
  INITIAL_BUFFER_TARGET: 12,
  SEEK_BOOST_RATE: 1.5,
  SEEK_BOOST_DURATION: 10000,
  SEEK_MIN_EFFECTIVE_RATIO: 0.6,
  SEEK_BOOST_EXTENSION: 5000,
  MAX_BOOST_EXTENSIONS: 3,
  MAX_TOTAL_BOOST_MS: 30000,
  BOOST_RATE_NORMAL: 1.08,

  // 🆕 Preview video settings (much gentler, short-lived)
  PREVIEW_BOOST_RATE: 1.08, // Gentle - barely noticeable on muted previews
  PREVIEW_BOOST_DURATION: 4000, // 4 seconds max
  PREVIEW_BUFFER_TARGET: 3, // Only need 3s buffer for chunk previews
  PREVIEW_CHECK_INTERVAL: 500, // Check every 500ms (less aggressive)
};

// Store boost-related timers per video for cleanup
const boostTimers = new WeakMap();
// 🆕 Separate tracker for preview boost timers
const previewBoostTimers = new WeakMap();

let chatRoot = null;

/**
 * Calculate how many seconds of buffered data exist ahead of current playhead.
 * Returns 0 if playhead is beyond buffer (e.g., after seeking).
 */
function getBufferAhead(video) {
  if (!video.buffered || !video.buffered.length) return 0;
  const ahead =
    video.buffered.end(video.buffered.length - 1) - video.currentTime;
  return ahead < 0 ? 0 : ahead;
}

/**
 * Calculate what percentage of total buffered time is ahead of playhead.
 */
function getEffectiveBufferRatio(video) {
  if (!video.buffered || !video.buffered.length) return 0;
  let totalBuffered = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    totalBuffered += video.buffered.end(i) - video.buffered.start(i);
  }
  const ahead = getBufferAhead(video);
  return totalBuffered > 0 ? Math.min(1, ahead / totalBuffered) : 1;
}

/**
 * Clean up boost timers for main videos.
 */
function cleanupBoost(video) {
  if (!video) return;
  const timers = boostTimers.get(video);
  if (timers) {
    if (timers.boostTimeout) clearTimeout(timers.boostTimeout);
    if (timers.monitorInterval) clearInterval(timers.monitorInterval);
    boostTimers.delete(video);
  }
  if (video.__boostTimeout) {
    clearTimeout(video.__boostTimeout);
    delete video.__boostTimeout;
  }
  if (video.__boostState) {
    video.__boostState.active = false;
    video.__boostState.paused = true;
  }
  if (
    video.__originalPlaybackRate &&
    video.playbackRate === video.__boostTargetRate
  ) {
    video.playbackRate = video.__originalPlaybackRate;
  }
  delete video.__originalPlaybackRate;
  delete video.__boostTargetRate;
  delete video.__boostStartTime;
  delete video.__boostExtensionCount;
  delete video.__boostBaseDuration;
  delete video.__hasBoostedOnLoad;
}

/**
 * 🆕 Clean up preview boost timers specifically.
 * This is separate from main video boost cleanup because previews
 * have different state and lifecycle (tied to hover, not playback).
 */
function cleanupPreviewBoost(previewVideo) {
  if (!previewVideo) return;
  const timers = previewBoostTimers.get(previewVideo);
  if (timers) {
    if (timers.checkInterval) clearInterval(timers.checkInterval);
    if (timers.endTimeout) clearTimeout(timers.endTimeout);
    previewBoostTimers.delete(previewVideo);
  }
  // Restore original rate if boost was active
  if (
    previewVideo.__previewOriginalRate &&
    previewVideo.playbackRate === BOOST_CONFIG.PREVIEW_BOOST_RATE
  ) {
    previewVideo.playbackRate = previewVideo.__previewOriginalRate;
  }
  delete previewVideo.__previewOriginalRate;
  delete previewVideo.__previewBoostActive;
  delete previewVideo.__previewBoostStartTime;
}

/**
 * 🆕 Gentle buffer boost for preview videos.
 *
 * SAFETY: Always pauses video first to avoid conflicts with
 * other play() calls (initial frame, chunk loop).
 *
 * @param {HTMLVideoElement} previewVideo - The preview video element
 * @returns {Function} Cleanup function to stop boost
 */
function boostPreviewBuffer(previewVideo) {
  if (!previewVideo || !tabIsVisible) return () => {};
  if (previewVideo.__previewBoostActive) return () => {}; // Already boosting

  // 🔧 FIX: Pause first to avoid fighting with other play() calls
  // The boost only affects download speed via playbackRate, not actual playback
  if (!previewVideo.paused) {
    previewVideo.pause();
  }

  // Store original playback rate
  if (!previewVideo.__previewOriginalRate) {
    previewVideo.__previewOriginalRate = previewVideo.playbackRate || 1.0;
  }

  // Only boost if buffer is actually low
  const initialAhead = getBufferAhead(previewVideo);
  if (initialAhead >= BOOST_CONFIG.PREVIEW_BUFFER_TARGET) {
    return () => {}; // Already enough buffer
  }

  // Mark as active and apply gentle boost
  previewVideo.__previewBoostActive = true;
  previewVideo.__previewBoostStartTime = Date.now();
  previewVideo.playbackRate = BOOST_CONFIG.PREVIEW_BOOST_RATE;

  // Create timer storage
  const timers = {
    checkInterval: null,
    endTimeout: null,
  };
  previewBoostTimers.set(previewVideo, timers);

  // Periodically check if buffer is sufficient
  timers.checkInterval = setInterval(() => {
    // Stop if tab hidden, video paused, or destroyed
    if (!tabIsVisible || !previewVideo.__previewBoostActive) {
      cleanupPreviewBoost(previewVideo);
      return;
    }

    const ahead = getBufferAhead(previewVideo);
    const elapsed = Date.now() - (previewVideo.__previewBoostStartTime || 0);

    // End boost if buffer is healthy or max duration reached
    if (
      ahead >= BOOST_CONFIG.PREVIEW_BUFFER_TARGET ||
      elapsed >= BOOST_CONFIG.PREVIEW_BOOST_DURATION
    ) {
      cleanupPreviewBoost(previewVideo);
    }
  }, BOOST_CONFIG.PREVIEW_CHECK_INTERVAL);

  // Hard stop after max duration (safety net)
  timers.endTimeout = setTimeout(() => {
    cleanupPreviewBoost(previewVideo);
  }, BOOST_CONFIG.PREVIEW_BOOST_DURATION + 200);

  // Return cleanup function
  return () => cleanupPreviewBoost(previewVideo);
}

/**
 * Core buffer boost function for main videos.
 */
function boostBufferAfterSeek(video, isSeek = false, options = {}) {
  if (!video || !tabIsVisible) return;

  const { extendDuration = false } = options;
  let timers = boostTimers.get(video);

  if (!timers) {
    timers = { boostTimeout: null, monitorInterval: null };
    boostTimers.set(video, timers);
  }

  let rate = isSeek
    ? BOOST_CONFIG.SEEK_BOOST_RATE
    : BOOST_CONFIG.BOOST_RATE_NORMAL;
  if (isSeek) {
    const initialAhead = getBufferAhead(video);
    if (initialAhead < 2) {
      rate = Math.min(rate, 1.25);
    }
  }

  let duration = isSeek
    ? BOOST_CONFIG.SEEK_BOOST_DURATION
    : BOOST_CONFIG.BOOST_DURATION;

  if (extendDuration && isSeek) {
    duration = Math.min(
      duration + BOOST_CONFIG.SEEK_BOOST_EXTENSION,
      BOOST_CONFIG.SEEK_BOOST_DURATION + BOOST_CONFIG.SEEK_BOOST_EXTENSION,
    );
  }

  if (!video.__originalPlaybackRate) {
    video.__originalPlaybackRate = video.playbackRate || 1.0;
  }

  const targetRate = rate;
  video.__boostTargetRate = targetRate;
  video.playbackRate = targetRate;

  video.__boostStartTime = Date.now();
  video.__boostExtensionCount = 0;
  video.__boostBaseDuration = duration;
  video.__boostState = {
    active: true,
    extensionCount: 0,
    paused: video.paused,
  };

  function evaluateBoost() {
    if (!video.__boostState?.active || !tabIsVisible) return;
    if (video.paused) {
      video.__boostState.paused = true;
      return;
    }

    video.__boostState.paused = false;
    const currentAhead = getBufferAhead(video);
    const elapsed = Date.now() - video.__boostStartTime;
    let endReason = null;

    if (currentAhead >= BOOST_CONFIG.BUFFER_LOW * 1.5) {
      endReason = "buffer healthy";
    } else if (
      video.__boostState.extensionCount >= BOOST_CONFIG.MAX_BOOST_EXTENSIONS
    ) {
      endReason = `max extensions (${BOOST_CONFIG.MAX_BOOST_EXTENSIONS})`;
    } else if (elapsed > BOOST_CONFIG.MAX_TOTAL_BOOST_MS) {
      endReason = `max total time (${BOOST_CONFIG.MAX_TOTAL_BOOST_MS / 1000}s)`;
    } else if (
      elapsed >
      video.__boostBaseDuration +
        video.__boostState.extensionCount * BOOST_CONFIG.SEEK_BOOST_EXTENSION
    ) {
      if (
        video.__boostState.extensionCount < BOOST_CONFIG.MAX_BOOST_EXTENSIONS &&
        elapsed <= BOOST_CONFIG.MAX_TOTAL_BOOST_MS
      ) {
        video.__boostState.extensionCount++;
        if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
        video.__boostTimeout = setTimeout(
          evaluateBoost,
          BOOST_CONFIG.SEEK_BOOST_EXTENSION,
        );
        if (timers) timers.boostTimeout = video.__boostTimeout;
        return;
      } else {
        endReason = "max limits reached";
      }
    }

    if (endReason) {
      if (video.playbackRate === targetRate) {
        video.playbackRate = video.__originalPlaybackRate || 1.0;
      }
      video.__boostState.active = false;
    }

    if (video.__boostTimeout) {
      clearTimeout(video.__boostTimeout);
      video.__boostTimeout = null;
      if (timers) timers.boostTimeout = null;
    }
  }

  if (timers.boostTimeout) clearTimeout(timers.boostTimeout);
  if (video.__boostTimeout) clearTimeout(video.__boostTimeout);

  video.__boostTimeout = setTimeout(evaluateBoost, duration);
  timers.boostTimeout = video.__boostTimeout;
}

/**
 * Attach buffer boost listeners to a main video element.
 */
function attachBoostToVideo(video) {
  if (!video || video.dataset.boostAttached === "true") return () => {};
  video.dataset.boostAttached = "true";

  const initialCheck = setTimeout(() => {
    if (!tabIsVisible) return;
    const ahead = getBufferAhead(video);
    if (
      ahead < BOOST_CONFIG.INITIAL_BUFFER_TARGET &&
      !video.__hasBoostedOnLoad
    ) {
      boostBufferAfterSeek(video, false);
      video.__hasBoostedOnLoad = true;
    }
  }, 600);

  const onSeeked = () => {
    if (!tabIsVisible) return;
    const ratio = getEffectiveBufferRatio(video);
    const needsExtension = ratio < BOOST_CONFIG.SEEK_MIN_EFFECTIVE_RATIO;
    boostBufferAfterSeek(video, true, { extendDuration: needsExtension });
  };

  const onPlay = () => {
    if (!tabIsVisible) return;
    if (video.__boostState?.active && video.__boostState.paused) {
      video.__boostState.paused = false;
      const timers = boostTimers.get(video);
      if (timers?.boostTimeout) {
        clearTimeout(timers.boostTimeout);
        const remaining = Math.max(
          1000,
          (video.__boostBaseDuration || BOOST_CONFIG.BOOST_DURATION) -
            (Date.now() - (video.__boostStartTime || Date.now())),
        );
        if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
        video.__boostTimeout = setTimeout(
          () => {
            if (video.__boostState?.active) {
              const ahead = getBufferAhead(video);
              if (ahead >= BOOST_CONFIG.BUFFER_LOW * 1.5) {
                video.playbackRate = video.__originalPlaybackRate || 1.0;
                video.__boostState.active = false;
              }
            }
          },
          Math.min(remaining, 5000),
        );
        timers.boostTimeout = video.__boostTimeout;
      }
    }
  };

  const onPause = () => {
    if (video.__boostState?.active) {
      video.__boostState.paused = true;
    }
  };

  video.addEventListener("seeked", onSeeked);
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);

  return () => {
    clearTimeout(initialCheck);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    cleanupBoost(video);
    delete video.dataset.boostAttached;
  };
}
// ═══════════════════════════════════════════════════════════════
// END BUFFER BOOST ENGINE
// ═══════════════════════════════════════════════════════════════

// Global single playback controller - Only one video plays at any time
function enforceSinglePlayback(videoToPlay) {
  if (currentlyPlaying && currentlyPlaying !== videoToPlay) {
    currentlyPlaying.pause();
    log(
      `Paused previous video to enforce single playback`,
      currentlyPlaying ? currentlyPlaying.dataset.videoObserverId : "",
    );
  }
  currentlyPlaying = videoToPlay;
  const onEnded = () => {
    if (currentlyPlaying === videoToPlay) currentlyPlaying = null;
  };
  videoToPlay.addEventListener("ended", onEnded, { once: true });
}

function log(message, data = null) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[nsfwPH ${ts}] ${message}`, data || "");
  if (panel && tabIsVisible) {
    const logsEl = panel.querySelector("#logs");
    if (logsEl) {
      const entry = document.createElement("div");
      entry.textContent = `[${ts}] ${message}`;
      logsEl.prepend(entry);
      if (logsEl.children.length > 60) logsEl.removeChild(logsEl.lastChild);
    }
  }
}

function getVideoInfo(video) {
  return {
    id: video.dataset.videoObserverId || `video-${++videoCounter}`,
    src: video.currentSrc || video.src || "No source",
    currentTime: video.currentTime || 0,
    duration: video.duration || 0,
    paused: video.paused,
  };
}

// New: Play preview chunks WITHOUT interfering with main video playback
function playPreviewChunk(
  previewVideo,
  chunkTimeoutRef,
  currentChunkIndexRef,
  entryId,
  getChunkStarts,
) {
  const chunkStarts = getChunkStarts();
  if (!chunkStarts) return;
  const startTime = chunkStarts[currentChunkIndexRef.current];
  previewVideo.currentTime = startTime;
  previewVideo
    .play()
    .then(() => {
      chunkTimeoutRef.current = setTimeout(() => {
        previewVideo.pause();
        currentChunkIndexRef.current =
          (currentChunkIndexRef.current + 1) % NUM_PREVIEW_CHUNKS;
        setTimeout(
          () =>
            playPreviewChunk(
              previewVideo,
              chunkTimeoutRef,
              currentChunkIndexRef,
              entryId,
              getChunkStarts,
            ),
          30,
        );
      }, CHUNK_PLAY_DURATION_MS);
    })
    .catch((err) => {
      log(`Chunk preview play failed for ${entryId}`, err.message);
      currentChunkIndexRef.current =
        (currentChunkIndexRef.current + 1) % NUM_PREVIEW_CHUNKS;
      chunkTimeoutRef.current = setTimeout(
        () =>
          playPreviewChunk(
            previewVideo,
            chunkTimeoutRef,
            currentChunkIndexRef,
            entryId,
            getChunkStarts,
          ),
        150,
      );
    });
}

// Lightweight automatic chunk preview (looping short clips)
function setupLightChunkPreview(previewVideo, entryId) {
  if (previewVideo.dataset.previewLoopRunning === "true") return () => {};
  previewVideo.dataset.previewLoopRunning = "true";
  const chunkTimeoutRef = { current: null };
  const currentChunkIndexRef = { current: 0 };
  const isStoppedRef = { current: false };

  // 🔧 FIX: Removed preview boost from here — it's now handled by
  // createSinglePreview's phased init BEFORE chunk loop starts.
  // This prevents the play()/pause() race condition.

  const getChunkStarts = () => {
    const duration = previewVideo.duration || 0;
    if (!duration || isNaN(duration) || duration < 1) return null;
    const chunkDurationSec = CHUNK_PLAY_DURATION_MS / 1000;
    const chunkStarts = [];
    const spacing =
      (duration - chunkDurationSec) /
      (NUM_PREVIEW_CHUNKS > 1 ? NUM_PREVIEW_CHUNKS - 1 : 1);
    for (let i = 0; i < NUM_PREVIEW_CHUNKS; i++) {
      let start = i * spacing;
      if (start + chunkDurationSec > duration)
        start = duration - chunkDurationSec;
      chunkStarts.push(Math.max(0, start));
    }
    return chunkStarts;
  };

  function stopPreviewLoop() {
    isStoppedRef.current = true;
    if (chunkTimeoutRef.current) {
      clearTimeout(chunkTimeoutRef.current);
      chunkTimeoutRef.current = null;
    }
    previewVideo.pause();
    if (
      typeof currentlyPlaying !== "undefined" &&
      currentlyPlaying === previewVideo
    ) {
      currentlyPlaying = null;
    }
  }

  function playPreviewChunkLocal() {
    if (isStoppedRef.current) return;
    const chunkStarts = getChunkStarts();
    if (!chunkStarts) return;
    const startTime = chunkStarts[currentChunkIndexRef.current];

    // 🔧 FIX: Pause before seeking to avoid interrupted play() errors
    if (!previewVideo.paused) {
      previewVideo.pause();
    }

    previewVideo.currentTime = startTime;

    // Small delay to let seek settle before playing
    setTimeout(() => {
      if (isStoppedRef.current) return;
      previewVideo
        .play()
        .then(() => {
          if (isStoppedRef.current) return;
          const t = setTimeout(() => {
            previewVideo.pause();
            currentChunkIndexRef.current =
              (currentChunkIndexRef.current + 1) % NUM_PREVIEW_CHUNKS;
            const t2 = setTimeout(() => playPreviewChunkLocal(), 30);
            chunkTimeoutRef.current = t2;
          }, CHUNK_PLAY_DURATION_MS);
          chunkTimeoutRef.current = t;
        })
        .catch((err) => {
          // 🔧 FIX: Only log if not a normal interruption (stopped or tab hidden)
          if (!isStoppedRef.current && tabIsVisible) {
            log(`Chunk preview play failed for ${entryId}`, err.message);
          }
          if (isStoppedRef.current) return;
          currentChunkIndexRef.current =
            (currentChunkIndexRef.current + 1) % NUM_PREVIEW_CHUNKS;
          const t = setTimeout(() => playPreviewChunkLocal(), 150);
          chunkTimeoutRef.current = t;
        });
    }, 50);
  }

  function tryStartLoop() {
    if (
      previewVideo.duration &&
      !isNaN(previewVideo.duration) &&
      previewVideo.duration > 1
    ) {
      log(`Light chunk preview loop started for ${entryId}`);
      playPreviewChunkLocal();
    }
  }

  // 🔧 FIX: Only start if we have enough data.
  // The caller (createSinglePreview) already handled metadata waiting.
  if (previewVideo.readyState >= 1) {
    tryStartLoop();
  } else {
    // Fallback: wait for canplay (shouldn't normally reach here)
    previewVideo.addEventListener("canplay", tryStartLoop, { once: true });
  }

  const onMouseLeave = stopPreviewLoop;
  previewVideo.addEventListener("mouseleave", onMouseLeave);

  return () => {
    stopPreviewLoop();
    delete previewVideo.dataset.previewLoopRunning;
    previewVideo.removeEventListener("mouseleave", onMouseLeave);
  };
}

function createSinglePreview(originalVideo, entryId) {
  log(`Creating preview video element for ${entryId}`);
  let videoUrl = originalVideo.currentSrc || originalVideo.src;
  if (videoUrl) {
    videoUrl += (videoUrl.includes("?") ? "&" : "?") + "t=0.8";
  }
  const preview = document.createElement("video");
  preview.src = videoUrl;
  preview.muted = true;
  preview.preload = "metadata";
  preview.style.width = "100%";
  preview.style.height = "auto";
  preview.style.maxHeight = "96px";
  preview.style.objectFit = "cover";
  preview.style.borderRadius = "4px";
  preview.style.background = "#1a1a2e";
  preview.style.display = "block";

  // Track state to prevent overlapping operations
  let initialBoostCleanup = null;
  let frameDisplayDone = false;
  let chunkLoopStarted = false;
  // Promise that resolves when frame display phase is complete
  let frameDisplayResolve = null;
  const frameDisplayPromise = new Promise((resolve) => {
    frameDisplayResolve = resolve;
  });

  /**
   * Sequential phase manager using Promise chaining.
   * Phase 1: Boost → Phase 2: Show Frame → Phase 3: Chunk Loop
   * Each phase completes fully before the next begins.
   */
  function startPhasedInit() {
    // Phase 1: Apply boost immediately
    if (tabIsVisible) {
      initialBoostCleanup = boostPreviewBuffer(preview);
    }

    // Phase 2: Show initial frame — wait for it to fully complete
    showInitialFrame();

    // Phase 3: Start chunk loop ONLY after frame is done
    frameDisplayPromise.then(() => {
      startChunkLoop();
    });
  }

  function showInitialFrame() {
    // Ensure video is paused before seeking
    if (!preview.paused) {
      preview.pause();
    }

    preview.currentTime = 0.8;

    // Wait for seek to complete, then play
    const onSeeked = () => {
      preview.removeEventListener("seeked", onSeeked);

      preview
        .play()
        .then(() => {
          // Display frame for 280ms, then resolve
          setTimeout(() => {
            preview.pause();

            // Clean up initial boost
            if (initialBoostCleanup) {
              initialBoostCleanup();
              initialBoostCleanup = null;
            }

            log(`Initial preview frame shown for ${entryId}`);

            // 🔑 Signal that frame display is complete
            frameDisplayDone = true;
            if (frameDisplayResolve) {
              frameDisplayResolve();
              frameDisplayResolve = null;
            }
          }, 280);
        })
        .catch((err) => {
          log(`Initial frame play failed for ${entryId}`, err.message);

          // Clean up boost even on failure
          if (initialBoostCleanup) {
            initialBoostCleanup();
            initialBoostCleanup = null;
          }

          // 🔑 Still signal completion so chunk loop can proceed
          frameDisplayDone = true;
          if (frameDisplayResolve) {
            frameDisplayResolve();
            frameDisplayResolve = null;
          }
        });
    };

    // Wait for seek to settle before playing
    preview.addEventListener("seeked", onSeeked, { once: true });

    // Safety timeout: if seeked never fires, force completion after 3s
    setTimeout(() => {
      if (!frameDisplayDone && frameDisplayResolve) {
        log(`Frame display timeout for ${entryId}, forcing completion`);
        frameDisplayDone = true;
        frameDisplayResolve();
        frameDisplayResolve = null;
      }
    }, 3000);
  }

  function startChunkLoop() {
    if (chunkLoopStarted) return;
    chunkLoopStarted = true;

    // Ensure any lingering boost is cleaned up
    if (initialBoostCleanup) {
      initialBoostCleanup();
      initialBoostCleanup = null;
    }

    // 🔑 Pause and wait a tick before starting chunk loop
    // This ensures no lingering play() operations are in flight
    if (!preview.paused) {
      preview.pause();
    }

    setTimeout(() => {
      const stopPreviewLoop = setupLightChunkPreview(preview, entryId);
      preview.stopPreviewLoop = stopPreviewLoop;
    }, 100); // Small buffer to ensure pause() settled
  }

  // Single trigger: loadedmetadata
  if (preview.readyState >= 1) {
    startPhasedInit();
  } else {
    preview.addEventListener("loadedmetadata", startPhasedInit, { once: true });

    // Safety timeout
    setTimeout(() => {
      if (!chunkLoopStarted && !frameDisplayDone) {
        log(`Metadata timeout for ${entryId}, forcing init`);
        startPhasedInit();
      }
    }, 3000);
  }

  // Store cleanup reference
  preview._initialBoostCleanup = () => {
    if (initialBoostCleanup) {
      initialBoostCleanup();
      initialBoostCleanup = null;
    }
  };

  return preview;
}

function createVideoCard(entry) {
  log(`Creating stable card DOM for ${entry.id}`);
  const card = document.createElement("div");
  card.className = "video-card";
  card.dataset.videoId = entry.id;
  card.innerHTML = ` 
    <div class="video-row">
      <div class="preview-container">
        <div class="thumb-placeholder"></div>
      </div>
      <div class="video-info">
        <div class="video-header">
          <strong>${entry.id}</strong>
          <div class="video-actions">
            <span class="video-status ${entry.info.paused ? "paused" : "playing"}">
              ${entry.info.paused ? "⏸" : "▶"}
            </span>
            <button class="gallery-btn" title="Open preview gallery">📷</button>
          </div>
        </div>
        <div class="video-src" title="${entry.info.src}">
          ${entry.info.src}
        </div>
        <div class="video-meta">
          ${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s
        </div>
      </div>
    </div>
    <div class="time-selections">
      <small>Time selections</small>
      <div class="time-strip"></div>
    </div>
  `;
  card.addEventListener("click", (e) => {
    e.stopImmediatePropagation();
    const videoEl = entry.element;
    if (!videoEl) return;
    if (videoEl.dataset.clickInProgress === "true") return;
    videoEl.dataset.clickInProgress = "true";
    setTimeout(() => {
      delete videoEl.dataset.clickInProgress;
    }, 300);
    if (videoEl.paused) {
      enforceSinglePlayback(videoEl);
      videoEl.play().catch((err) => {
        console.warn("Play failed on card click", err);
        delete videoEl.dataset.clickInProgress;
      });
    } else {
      videoEl.pause();
      if (currentlyPlaying === videoEl) currentlyPlaying = null;
    }
    videoEl.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  const galleryBtn = card.querySelector(".gallery-btn");
  if (galleryBtn) {
    galleryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openGallery(entry);
    });
  }
  return card;
}

function updateExistingCard(card, entry) {
  const statusEl = card.querySelector(".video-status");
  if (statusEl) {
    statusEl.className = `video-status ${entry.info.paused ? "paused" : "playing"}`;
    statusEl.textContent = entry.info.paused ? "⏸ Paused" : "▶ Playing";
  }
  const timeEl = card.querySelector(".video-meta");
  if (timeEl) {
    timeEl.textContent = `${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s`;
  }
  const placeholder = card.querySelector(".thumb-placeholder");
  if (placeholder && entry.preview) {
    log(`Replacing placeholder with real preview for ${entry.id}`);
    const container = card.querySelector(".preview-container");
    if (container) {
      container.innerHTML = "";
      container.appendChild(entry.preview);
    }
  }
}

function cleanupVideoEntry(entry) {
  if (!entry) return;
  log(`Cleaning up video entry for RAM optimization: ${entry.id}`);

  // Clean up boost engine (main video)
  if (entry.boostCleanup) {
    entry.boostCleanup();
    entry.boostCleanup = null;
  }

  if (entry.preview) {
    // 🆕 NEW: Clean up preview initial boost
    if (typeof entry.preview._initialBoostCleanup === "function") {
      entry.preview._initialBoostCleanup();
      delete entry.preview._initialBoostCleanup;
    }
    // Clean up preview boost (via previewBoostTimers)
    cleanupPreviewBoost(entry.preview);

    if (typeof entry.preview.stopPreviewLoop === "function") {
      entry.preview.stopPreviewLoop();
      delete entry.preview.stopPreviewLoop;
    }
    entry.preview.pause();
    if (currentlyPlaying === entry.preview) currentlyPlaying = null;
    entry.preview.src = "";
    entry.preview.load();
    entry.preview = null;
  }
  if (entry.cleanups && entry.cleanups.length > 0) {
    entry.cleanups.forEach((cleanupFn) => cleanupFn());
    entry.cleanups = null;
  }
  if (entry.element && entry.element === currentlyPlaying) {
    currentlyPlaying = null;
  }
}

function trackVideo(video) {
  if (video.dataset.videoObserverAttached === "true") return;
  video.dataset.videoObserverAttached = "true";
  if (videos.has(video)) return;
  const id = `video-${++videoCounter}`;
  video.dataset.videoObserverId = id;
  const entry = {
    id,
    element: video,
    info: getVideoInfo(video),
    preview: null,
    framesPopulated: false,
    cleanups: [],
    boostCleanup: null,
  };
  videos.set(video, entry);
  if (!video.dataset.volumeSet) {
    video.volume = 0.5;
    video.dataset.volumeSet = "true";
  }
  log(`New video detected`, {
    id,
    srcShort: (video.currentSrc || "").substring(0, 80) + "...",
  });

  // Attach buffer boost to main video
  entry.boostCleanup = attachBoostToVideo(video);

  const startPreview = () => {
    entry.preview = createSinglePreview(video, id);
    performPanelUpdate();
  };
  if (video.readyState >= 2) {
    startPreview();
  } else {
    const handler = () => startPreview();
    video.addEventListener("loadedmetadata", handler, { once: true });
    entry.cleanups.push(() =>
      video.removeEventListener("loadedmetadata", handler),
    );
  }
  const addTrackedListener = (el, eventName, handlerFn, options = {}) => {
    el.addEventListener(eventName, handlerFn, options);
    entry.cleanups.push(() =>
      el.removeEventListener(eventName, handlerFn, options),
    );
  };
  const events = [
    "loadstart",
    "progress",
    "suspend",
    "abort",
    "error",
    "emptied",
    "stalled",
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "canplaythrough",
    "durationchange",
    "play",
    "playing",
    "pause",
    "ended",
    "waiting",
    "seeking",
    "seeked",
    "ratechange",
    "volumechange",
    "resize",
  ];
  events.forEach((ev) => {
    const handler = () => {
      const info = getVideoInfo(video);
      entry.info = info;
    };
    addTrackedListener(video, ev, handler, { passive: true });
  });
  const addPlayingClass = () => video.classList.add("video-observer-playing");
  const removePlayingClass = () =>
    video.classList.remove("video-observer-playing");
  addTrackedListener(video, "play", addPlayingClass, { passive: true });
  addTrackedListener(video, "pause", removePlayingClass, { passive: true });
  addTrackedListener(video, "ended", removePlayingClass, { passive: true });
  if (!video.paused) {
    video.classList.add("video-observer-playing");
  }
}

function performPanelUpdate() {
  if (!panel) return;
  const list = panel.querySelector("#videos-list");
  const countEl = panel.querySelector("#video-count");
  const empty = panel.querySelector("#empty-videos");
  countEl.textContent = videos.size;
  if (videos.size === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  Array.from(videos.values()).forEach((entry) => {
    let card;
    if (!videoCards.has(entry.element)) {
      card = createVideoCard(entry);
      videoCards.set(entry.element, card);
      list.appendChild(card);
    } else {
      card = videoCards.get(entry.element);
      updateExistingCard(card, entry);
    }
    if (card && !entry.framesPopulated && entry.info.duration > 2) {
      entry.framesPopulated = true;
      populateTimeSelections(card, entry);
    }
  });
  for (let [videoEl, entry] of Array.from(videos.entries())) {
    if (!document.body.contains(videoEl)) {
      cleanupVideoEntry(entry);
      videos.delete(videoEl);
      const card = videoCards.get(videoEl);
      if (card) {
        card.remove();
        videoCards.delete(videoEl);
      }
    }
  }
}

function populateTimeSelections(card, entry) {
  const strip = card.querySelector(".time-strip");
  if (!strip) return;
  strip.innerHTML = "";
  const div = document.createElement("div");
  div.textContent = "⏱ Time frames";
  div.style.fontSize = "10px";
  div.style.color = "#666";
  strip.appendChild(div);
}

function observeVideos() {
  document.querySelectorAll(SELECTOR).forEach(trackVideo);
  performPanelUpdate();
}

function waitForBody(callback) {
  if (document.body) return callback();
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect();
      callback();
    }
  });
  observer.observe(document.documentElement, { childList: true });
  setTimeout(() => {
    if (document.body) callback();
  }, 1500);
}

function createFloatingPanel() {
  if (panel) return;
  panel = document.createElement("div");
  panel.id = "video-observer-panel";
  panel.innerHTML = `
    <header>🎥 Video Observer <button class="close-btn" id="toggle-panel">✕</button></header>
    <div class="tabs">
      <div class="tab active" data-tab="videos">Videos (<span id="video-count">0</span>)</div>
      <div class="tab" data-tab="logs">Logs</div>
    </div>
    <div id="videos-tab" class="content">
      <div id="videos-list"></div>
      <div id="empty-videos">No videos detected yet<br><small>Click card to toggle play/pause + scroll</small></div>
    </div>
    <div id="logs-tab" class="content" style="display:none">
      <div id="logs" class="log-container"></div>
    </div>
    <div class="status">Observing <strong>.message-inner video</strong> • ${new Date().toLocaleTimeString()}</div>
  `;
  document.body.appendChild(panel);
  panel.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      panel
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      panel.querySelector("#videos-tab").style.display =
        tab.dataset.tab === "videos" ? "block" : "none";
      panel.querySelector("#logs-tab").style.display =
        tab.dataset.tab === "logs" ? "block" : "none";
    });
  });
  panel.querySelector("#toggle-panel").addEventListener("click", () => {
    isPanelVisible = !isPanelVisible;
    panel.style.display = isPanelVisible ? "flex" : "none";
    if (!isPanelVisible && currentlyPlaying) {
      currentlyPlaying.pause();
      currentlyPlaying = null;
    }
  });
  performPanelUpdate();
}

// ═══════════════════════════════════════════════════════════════
// PAGE VISIBILITY: pause everything when tab is hidden
// ═══════════════════════════════════════════════════════════════
function stopAllPreviewLoops() {
  for (const entry of videos.values()) {
    if (entry.preview && typeof entry.preview.stopPreviewLoop === "function") {
      entry.preview.stopPreviewLoop();
    }
  }
}

function restartAllPreviewLoops() {
  for (const entry of videos.values()) {
    if (entry.preview) {
      const stopFn = setupLightChunkPreview(entry.preview, entry.id);
      entry.preview.stopPreviewLoop = stopFn;
    }
  }
}

function stopAllBoosts() {
  for (const entry of videos.values()) {
    if (entry.boostCleanup) {
      cleanupBoost(entry.element);
    }
    // 🆕 NEW: Also clean up preview boosts
    if (entry.preview) {
      cleanupPreviewBoost(entry.preview);
    }
  }
}

function restartAllBoosts() {
  for (const entry of videos.values()) {
    if (entry.element && !entry.element.dataset.boostAttached) {
      entry.boostCleanup = attachBoostToVideo(entry.element);
    }
  }
}

/**
 * 🆕 NEW: Pause all preview-specific boosts when tab is hidden.
 * Separate from main video boosts because previews have different cleanup needs.
 */
function stopAllPreviewBoosts() {
  for (const entry of videos.values()) {
    if (entry.preview) {
      // Clean up the initial boost if still active
      if (typeof entry.preview._initialBoostCleanup === "function") {
        entry.preview._initialBoostCleanup();
      }
      // Clean up any ongoing preview boost
      cleanupPreviewBoost(entry.preview);
    }
  }
}

/**
 * 🆕 NEW: Re-apply preview boosts when tab becomes visible.
 * Only boosts previews that are currently visible in the panel.
 */
function restartAllPreviewBoosts() {
  for (const entry of videos.values()) {
    if (entry.preview && tabIsVisible) {
      // Re-apply gentle boost to pre-warm the buffer
      const cleanupFn = boostPreviewBuffer(entry.preview);
      // Update the stored cleanup reference
      entry.preview._initialBoostCleanup = cleanupFn;
    }
  }
}

function onTabHidden() {
  tabIsVisible = false;
  log("Tab hidden — pausing everything");
  stopAllPreviewLoops();
  stopAllBoosts();
  stopAllPreviewBoosts(); // 🆕 NEW
  if (currentlyPlaying) {
    currentlyPlaying.pause();
    currentlyPlaying = null;
  }
  if (pollingInterval !== null) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (domObserver) {
    domObserver.disconnect();
  }
}

// ═══════════════════════════════════════════════════
// Uses module-level chatRoot
// ═══════════════════════════════════════════════════
function onTabVisible() {
  tabIsVisible = true;
  log("Tab visible — resuming everything");
  restartAllPreviewLoops();
  restartAllBoosts();
  restartAllPreviewBoosts();
  if (pollingInterval === null) {
    if (pollingInterval !== null) clearInterval(pollingInterval);
    pollingInterval = setInterval(observeVideos, 30000);
    globalResources.intervals.push(pollingInterval);
  }
  if (domObserver) {
    // 🔧 FIX: chatRoot is now module-level, accessible here
    domObserver.observe(chatRoot || document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
  }
  observeVideos();
}

function cleanupGlobalResources() {
  globalResources.observers.forEach((o) => o.disconnect());
  globalResources.intervals.forEach((i) => clearInterval(i));
  globalResources.observers = [];
  globalResources.intervals = [];
  for (const entry of videos.values()) {
    if (entry.boostCleanup) {
      entry.boostCleanup();
      entry.boostCleanup = null;
    }
    // 🆕 NEW: Clean up preview boosts globally
    if (entry.preview) {
      if (typeof entry.preview._initialBoostCleanup === "function") {
        entry.preview._initialBoostCleanup();
      }
      cleanupPreviewBoost(entry.preview);
    }
  }
}

// ═══════════════════════════════════════════════════
// Assigns to module-level chatRoot
// ═══════════════════════════════════════════════════
function init() {
  if (window.__VIDEO_OBSERVER_INITIALIZED__) return;
  window.__VIDEO_OBSERVER_INITIALIZED__ = true;
  cleanupGlobalResources();
  log(
    "Video Observer initialized – SINGLE PLAYBACK + CHUNK PREVIEWS + MAIN & PREVIEW BOOST + BACKGROUND PAUSE",
  );
  createFloatingPanel();
  log("Floating panel created.");
  observeVideos();
  log("Initial video observation performed.");
  let debounceTimer = null;
  domObserver = new MutationObserver((mutations) => {
    if (!tabIsVisible) return;
    const hasRelevantChange = mutations.some((m) =>
      Array.from(m.addedNodes).some(
        (node) =>
          node.nodeType === 1 && !node.closest?.("#video-observer-panel"),
      ),
    );
    if (!hasRelevantChange) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(observeVideos, 600);
  });
  // 🔧 FIX: Assign to module-level variable so onTabVisible can use it
  chatRoot = document.querySelector(".messages-content, #messages, main, body");
  domObserver.observe(chatRoot || document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
  });
  globalResources.observers.push(domObserver);
  pollingInterval = setInterval(observeVideos, 30000);
  globalResources.intervals.push(pollingInterval);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      onTabHidden();
    } else {
      onTabVisible();
    }
  });
  log("Init complete — observer watching chat root for child additions only");
}

waitForBody(init);
