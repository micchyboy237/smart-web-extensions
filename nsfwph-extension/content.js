// content.js - Stable DOM + SINGLE PLAYBACK + LIGHTWEIGHT CHUNK PREVIEWS + RAM optimized
// + SMART BUFFER BOOST (ported from nsfwph-fastream-extension)
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
// ═══════════════════════════════════════════════════════════════
const BOOST_CONFIG = {
  BUFFER_LOW: 5, // seconds - threshold to trigger boost
  BOOST_DURATION: 8000, // ms - default boost period for page loads
  INITIAL_BUFFER_TARGET: 12, // seconds - target after page load
  SEEK_BOOST_RATE: 1.5, // playback rate multiplier after seek
  SEEK_BOOST_DURATION: 10000, // ms - max boost duration after seek
  SEEK_MIN_EFFECTIVE_RATIO: 0.6, // require ≥60% buffer ahead after seek
  SEEK_BOOST_EXTENSION: 5000, // ms - extend boost if ratio is low
  MAX_BOOST_EXTENSIONS: 3, // max times boost can be extended
  MAX_TOTAL_BOOST_MS: 30000, // ms - absolute max boost duration
  BOOST_RATE_NORMAL: 1.08, // gentle boost for page loads
};

// Store boost-related timers per video for cleanup
const boostTimers = new WeakMap();

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
 * Used to detect "dead" buffer retained after seeking.
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
 * Clean up all boost-related timers and state for a video.
 * Called when video is removed, tab hidden, or boost completes.
 */
function cleanupBoost(video) {
  if (!video) return;
  const timers = boostTimers.get(video);
  if (timers) {
    if (timers.boostTimeout) clearTimeout(timers.boostTimeout);
    if (timers.monitorInterval) clearInterval(timers.monitorInterval);
    boostTimers.delete(video);
  }
  // Also clear any timeout stored directly on the element (backward compat)
  if (video.__boostTimeout) {
    clearTimeout(video.__boostTimeout);
    delete video.__boostTimeout;
  }
  // Reset boost state
  if (video.__boostState) {
    video.__boostState.active = false;
    video.__boostState.paused = true;
  }
  // Restore original playback rate if it was modified
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
 * Core buffer boost function. Temporarily increases playback rate
 * to build buffer faster, then restores normal speed.
 *
 * @param {HTMLVideoElement} video - The video to boost
 * @param {boolean} isSeek - Whether this boost follows a seek event
 * @param {Object} options - { extendDuration: boolean }
 */
function boostBufferAfterSeek(video, isSeek = false, options = {}) {
  if (!video || !tabIsVisible) return; // Don't boost when tab hidden

  const { extendDuration = false } = options;
  let timers = boostTimers.get(video);

  // Create timer storage if not exists
  if (!timers) {
    timers = { boostTimeout: null, monitorInterval: null };
    boostTimers.set(video, timers);
  }

  // Adaptive boost rate based on network conditions
  let rate = isSeek
    ? BOOST_CONFIG.SEEK_BOOST_RATE
    : BOOST_CONFIG.BOOST_RATE_NORMAL;
  if (isSeek) {
    const initialAhead = getBufferAhead(video);
    // If buffer was very low after seek, use gentler boost to avoid overwhelming server
    if (initialAhead < 2) {
      rate = Math.min(rate, 1.25);
    }
  }

  let duration = isSeek
    ? BOOST_CONFIG.SEEK_BOOST_DURATION
    : BOOST_CONFIG.BOOST_DURATION;

  // Extend duration if post-seek buffer is mostly behind playhead
  if (extendDuration && isSeek) {
    duration = Math.min(
      duration + BOOST_CONFIG.SEEK_BOOST_EXTENSION,
      BOOST_CONFIG.SEEK_BOOST_DURATION + BOOST_CONFIG.SEEK_BOOST_EXTENSION,
    );
  }

  // Store original rate so we can restore it
  if (!video.__originalPlaybackRate) {
    video.__originalPlaybackRate = video.playbackRate || 1.0;
  }

  const targetRate = rate;
  video.__boostTargetRate = targetRate;

  // Apply the boost
  video.playbackRate = targetRate;

  // Initialize boost state
  video.__boostStartTime = Date.now();
  video.__boostExtensionCount = 0;
  video.__boostBaseDuration = duration;
  video.__boostState = {
    active: true,
    extensionCount: 0,
    paused: video.paused,
  };

  /**
   * Centralized boost evaluation - checks if buffer is healthy enough to end boost,
   * or extends boost if buffer is still low (within configured limits).
   */
  function evaluateBoost() {
    // Guard: stop if boost is no longer active, tab hidden, or video paused
    if (!video.__boostState?.active || !tabIsVisible) {
      return;
    }
    if (video.paused) {
      video.__boostState.paused = true;
      return; // Don't evaluate while paused; will resume on play
    }

    video.__boostState.paused = false;
    const currentAhead = getBufferAhead(video);
    const elapsed = Date.now() - video.__boostStartTime;
    let endReason = null;

    // Determine if boost should end
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
      // Base duration elapsed - consider extension
      if (
        video.__boostState.extensionCount < BOOST_CONFIG.MAX_BOOST_EXTENSIONS &&
        elapsed <= BOOST_CONFIG.MAX_TOTAL_BOOST_MS
      ) {
        // Extend further
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

    // End boost if we have a reason
    if (endReason) {
      if (video.playbackRate === targetRate) {
        video.playbackRate = video.__originalPlaybackRate || 1.0;
      }
      video.__boostState.active = false;
    }

    // Clean up timeout reference
    if (video.__boostTimeout) {
      clearTimeout(video.__boostTimeout);
      video.__boostTimeout = null;
      if (timers) timers.boostTimeout = null;
    }
  }

  // Clear any existing boost timeout
  if (timers.boostTimeout) clearTimeout(timers.boostTimeout);
  if (video.__boostTimeout) clearTimeout(video.__boostTimeout);

  // Schedule first evaluation
  video.__boostTimeout = setTimeout(evaluateBoost, duration);
  timers.boostTimeout = video.__boostTimeout;
}

/**
 * Attach buffer boost listeners to a video element.
 * Sets up event handlers for seeking and initial buffering.
 * Returns a cleanup function.
 */
function attachBoostToVideo(video) {
  if (!video || video.dataset.boostAttached === "true") return () => {};
  video.dataset.boostAttached = "true";

  // Early check for page-load buffering (runs once per video)
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

  // Seek handler: boost after user seeks to new position
  const onSeeked = () => {
    if (!tabIsVisible) return;
    const ratio = getEffectiveBufferRatio(video);
    const needsExtension = ratio < BOOST_CONFIG.SEEK_MIN_EFFECTIVE_RATIO;
    boostBufferAfterSeek(video, true, { extendDuration: needsExtension });
  };

  // Play handler: resume boost if it was paused
  const onPlay = () => {
    if (!tabIsVisible) return;
    if (video.__boostState?.active && video.__boostState.paused) {
      video.__boostState.paused = false;
      // Re-trigger evaluation
      const timers = boostTimers.get(video);
      if (timers?.boostTimeout) {
        clearTimeout(timers.boostTimeout);
        // Use the evaluateBoost logic by calling boost again with existing state
        // Simple approach: just restart with remaining time
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

  // Pause handler: mark boost as paused
  const onPause = () => {
    if (video.__boostState?.active) {
      video.__boostState.paused = true;
    }
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
  // Auto-pause when this video ends
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

// Lightweight automatic chunk preview (looping short clips) - NOW STOPPABLE
function setupLightChunkPreview(previewVideo, entryId) {
  if (previewVideo.dataset.previewLoopRunning === "true") return () => {};
  previewVideo.dataset.previewLoopRunning = "true";
  const chunkTimeoutRef = { current: null };
  const currentChunkIndexRef = { current: 0 };
  const isStoppedRef = { current: false };
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
    previewVideo.currentTime = startTime;
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
        log(`Chunk preview play failed for ${entryId}`, err.message);
        if (isStoppedRef.current) return;
        currentChunkIndexRef.current =
          (currentChunkIndexRef.current + 1) % NUM_PREVIEW_CHUNKS;
        const t = setTimeout(() => playPreviewChunkLocal(), 150);
        chunkTimeoutRef.current = t;
      });
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
  if (previewVideo.readyState >= 1) {
    tryStartLoop();
  } else {
    previewVideo.addEventListener("loadedmetadata", tryStartLoop, {
      once: true,
    });
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
  let frameShown = false;
  const tryShowFrame = () => {
    if (frameShown) return;
    frameShown = true;
    preview.currentTime = 0.8;
    preview
      .play()
      .then(() => {
        setTimeout(() => preview.pause(), 280);
        log(`Initial preview frame shown for ${entryId}`);
      })
      .catch((err) => {
        log(`Initial frame play failed for ${entryId}`, err.message);
        preview.currentTime = 1.5;
      });
  };
  preview.addEventListener(
    "loadeddata",
    () => {
      log(`loadeddata fired for preview ${entryId}`);
      tryShowFrame();
    },
    { once: true },
  );
  preview.addEventListener(
    "loadedmetadata",
    () => {
      log(`loadedmetadata for preview ${entryId}`);
    },
    { once: true },
  );
  const stopPreviewLoop = setupLightChunkPreview(preview, entryId);
  preview.stopPreviewLoop = stopPreviewLoop;
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

  // Clean up boost engine
  if (entry.boostCleanup) {
    entry.boostCleanup();
    entry.boostCleanup = null;
  }

  if (entry.preview) {
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
    boostCleanup: null, // NEW: store boost cleanup function
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

  // Attach buffer boost to this video
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
// PAGE VISIBILITY: pause everything when tab is hidden,
// resume when it comes back. This is the main RAM/CPU fix.
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

/**
 * Pause all boost engines when tab is hidden (RAM optimization).
 * Each boost is cleaned up and will be re-attached on tab visible.
 */
function stopAllBoosts() {
  for (const entry of videos.values()) {
    if (entry.boostCleanup) {
      // Don't fully clean up - just clean the boost state so timers stop
      // The boostCleanup function reference is kept for re-attachment
      cleanupBoost(entry.element);
    }
  }
}

/**
 * Re-attach boost to all active videos when tab becomes visible.
 */
function restartAllBoosts() {
  for (const entry of videos.values()) {
    if (entry.element && !entry.element.dataset.boostAttached) {
      entry.boostCleanup = attachBoostToVideo(entry.element);
    }
  }
}

function onTabHidden() {
  tabIsVisible = false;
  log("Tab hidden — pausing everything");
  stopAllPreviewLoops();
  stopAllBoosts(); // NEW: pause boost timers
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

function onTabVisible() {
  tabIsVisible = true;
  log("Tab visible — resuming everything");
  restartAllPreviewLoops();
  restartAllBoosts(); // NEW: re-attach boost engines
  if (pollingInterval === null) {
    if (pollingInterval !== null) clearInterval(pollingInterval);
    pollingInterval = setInterval(observeVideos, 30000);
    globalResources.intervals.push(pollingInterval);
  }
  if (domObserver) {
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
  // NEW: Clean up all boost engines
  for (const entry of videos.values()) {
    if (entry.boostCleanup) {
      entry.boostCleanup();
      entry.boostCleanup = null;
    }
  }
}

function init() {
  if (window.__VIDEO_OBSERVER_INITIALIZED__) return;
  window.__VIDEO_OBSERVER_INITIALIZED__ = true;
  cleanupGlobalResources();
  log(
    "Video Observer initialized – SINGLE PLAYBACK + LIGHTWEIGHT CHUNK PREVIEWS + BUFFER BOOST + BACKGROUND PAUSE",
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
  const chatRoot = document.querySelector(
    ".messages-content, #messages, main, body",
  );
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
