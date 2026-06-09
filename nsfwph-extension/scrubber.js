// scrubber.js - Video Overlay Scrubber System
// Features: progress bar, buffered regions, hover thumbnail preview
// ═══════════════════════════════════════════════════════════════

// Prevent double initialization
if (window.__SCRUBBER_SYSTEM_INITIALIZED__) {
  console.warn("[Scrubber] System already initialized, skipping");
} else {
  window.__SCRUBBER_SYSTEM_INITIALIZED__ = true;

  // ═══════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════
  const SCRUBBER_CONFIG = {
    // Thumbnail capture settings
    CAPTURE_INTERVAL: 2, // Capture a frame every 2 seconds of video
    MAX_THUMBNAILS: 120, // Max stored thumbnails (~4 min @ 2s interval)
    JPEG_QUALITY: 0.55, // 0-1, lower = smaller files, faster display
    THUMB_WIDTH: 320, // Capture resolution width
    THUMB_HEIGHT: 180, // 16:9 ratio
    CAPTURE_CHECK_MS: 250, // How often to check for new capture opportunity
    CLEANUP_ON_CLOSE: true, // Free memory when overlay closes
  };

  // ═══════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Formats seconds into m:ss display format.
   */
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // HTML TEMPLATE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Returns the scrubber HTML string.
   * Designed to be inserted into the overlay controls section.
   */
  function getScrubberHTML() {
    return `
      <div id="vo-scrubber-wrap">
        <div id="vo-scrubber-preview">
          <img src="" alt="preview" />
          <div class="preview-time-label">0:00</div>
        </div>
        <div id="vo-scrubber-track">
          <div id="vo-scrubber-buffered"></div>
          <div id="vo-scrubber-fill"></div>
          <div id="vo-scrubber-thumb"></div>
        </div>
      </div>
      <div id="vo-bottom-row">
        <span id="vo-time">0:00 / 0:00</span>
        <div id="vo-btn-row">
          <button class="vo-btn" id="vo-playpause">⏸ Pause</button>
          <button class="vo-btn" id="vo-mute">🔊 Mute</button>
          <button class="vo-btn" id="vo-pip">⛶ PiP</button>
        </div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════
  // SCRUBBER CREATION & ATTACHMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Creates the scrubber DOM elements and returns controller references.
   *
   * @param {HTMLElement} controlsContainer - The #vo-controls element
   * @returns {Object} References to scrubber elements
   */
  function createScrubberElements(controlsContainer) {
    // Insert scrubber HTML at the end of controls
    controlsContainer.insertAdjacentHTML("beforeend", getScrubberHTML());

    return {
      wrap: controlsContainer.querySelector("#vo-scrubber-wrap"),
      track: controlsContainer.querySelector("#vo-scrubber-track"),
      fill: controlsContainer.querySelector("#vo-scrubber-fill"),
      thumb: controlsContainer.querySelector("#vo-scrubber-thumb"),
      buffered: controlsContainer.querySelector("#vo-scrubber-buffered"),
      preview: controlsContainer.querySelector("#vo-scrubber-preview"),
      previewImg: controlsContainer.querySelector("#vo-scrubber-preview img"),
      previewLabel: controlsContainer.querySelector(
        "#vo-scrubber-preview .preview-time-label",
      ),
      timeDisplay: controlsContainer.querySelector("#vo-time"),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // BUFFERED REGIONS DISPLAY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Updates the buffered-regions visualization on the scrubber track.
   * Reads video.buffered (TimeRanges) and creates positioned segments
   * showing which portions of the video have been downloaded.
   *
   * @param {HTMLVideoElement} videoEl
   * @param {HTMLElement} bufferedContainer - The #vo-scrubber-buffered element
   */
  function updateBufferedDisplay(videoEl, bufferedContainer) {
    if (!bufferedContainer) return;

    // Clear previous segments
    bufferedContainer.innerHTML = "";

    if (
      !videoEl ||
      !videoEl.duration ||
      !videoEl.buffered ||
      !videoEl.buffered.length
    ) {
      return;
    }

    const duration = videoEl.duration;
    if (!isFinite(duration) || duration <= 0) return;

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < videoEl.buffered.length; i++) {
      const start = videoEl.buffered.start(i);
      const end = videoEl.buffered.end(i);

      // Skip tiny ranges
      if (end - start < 0.1) continue;

      const leftPercent = (start / duration) * 100;
      const widthPercent = ((end - start) / duration) * 100;

      const clampedLeft = Math.max(0, Math.min(100, leftPercent));
      const clampedWidth = Math.max(
        0,
        Math.min(100 - clampedLeft, widthPercent),
      );

      if (clampedWidth <= 0) continue;

      const segment = document.createElement("div");
      segment.className = "vo-buffer-segment";
      segment.style.left = clampedLeft + "%";
      segment.style.width = clampedWidth + "%";
      segment.title = `Buffered: ${fmtTime(start)} – ${fmtTime(end)}`;

      fragment.appendChild(segment);
    }

    bufferedContainer.appendChild(fragment);
  }

  // ═══════════════════════════════════════════════════════════════
  // PROGRESS DISPLAY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Updates the progress fill, thumb position, and time display.
   *
   * @param {HTMLVideoElement} videoEl
   * @param {Object} elements - Scrubber element references
   */
  function updateProgressDisplay(videoEl, elements) {
    if (!elements.fill || !elements.thumb || !elements.timeDisplay) return;

    const pct = videoEl.duration
      ? (videoEl.currentTime / videoEl.duration) * 100
      : 0;

    elements.fill.style.width = `${pct}%`;
    elements.thumb.style.left = `${pct}%`;
    elements.timeDisplay.textContent = `${fmtTime(videoEl.currentTime)} / ${fmtTime(videoEl.duration)}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // THUMBNAIL CAPTURE SYSTEM
  // ═══════════════════════════════════════════════════════════════

  /**
   * Creates a fresh thumbnail state object.
   * Each scrubber instance gets its own state.
   */
  function createThumbnailState() {
    return {
      thumbnails: [], // Array of { time: number, src: string }
      captureCanvas: null, // Hidden canvas for frame capture
      captureCtx: null,
      lastCaptureTime: -1, // Last video time we captured at
      isCapturing: false, // Prevent overlapping captures
      captureIntervalId: null, // setInterval handle
    };
  }

  /**
   * Creates or reuses a hidden canvas for capturing video frames.
   *
   * @param {Object} state - Thumbnail state
   */
  function getCaptureCanvas(state) {
    if (state.captureCanvas) return;

    const canvas = document.createElement("canvas");
    canvas.width = SCRUBBER_CONFIG.THUMB_WIDTH;
    canvas.height = SCRUBBER_CONFIG.THUMB_HEIGHT;
    canvas.style.display = "none";
    canvas.dataset.thumbCapture = "true";
    document.body.appendChild(canvas);

    state.captureCanvas = canvas;
    state.captureCtx = canvas.getContext("2d", {
      willReadFrequently: true,
      alpha: false,
    });

    console.log(
      `[Scrubber] 📸 Canvas created: ${SCRUBBER_CONFIG.THUMB_WIDTH}x${SCRUBBER_CONFIG.THUMB_HEIGHT}`,
    );
  }

  /**
   * Captures a single frame from the video at its current time.
   * Uses requestVideoFrameCallback for precise frame timing when available.
   *
   * @param {HTMLVideoElement} videoEl
   * @param {Object} state - Thumbnail state
   */
  function captureFrame(videoEl, state) {
    if (!videoEl || videoEl.paused || videoEl.readyState < 2) return;
    if (state.isCapturing) return;

    const currentTime = videoEl.currentTime;
    const timeSinceLastCapture = currentTime - state.lastCaptureTime;

    // Only capture if enough time has passed
    if (timeSinceLastCapture < SCRUBBER_CONFIG.CAPTURE_INTERVAL - 0.5) return;

    // Skip if we already have a thumbnail very close to this time
    if (state.thumbnails.length > 0) {
      const last = state.thumbnails[state.thumbnails.length - 1];
      if (
        Math.abs(currentTime - last.time) <
        SCRUBBER_CONFIG.CAPTURE_INTERVAL * 0.7
      ) {
        return;
      }
    }

    // Enforce max thumbnails (remove oldest)
    while (state.thumbnails.length >= SCRUBBER_CONFIG.MAX_THUMBNAILS) {
      const removed = state.thumbnails.shift();
      if (removed._blobUrl) URL.revokeObjectURL(removed._blobUrl);
    }

    state.isCapturing = true;
    state.lastCaptureTime = currentTime;

    // Use requestVideoFrameCallback for precise frame capture
    if (videoEl.requestVideoFrameCallback) {
      videoEl.requestVideoFrameCallback(() => {
        doCaptureFrame(videoEl, state, currentTime);
        state.isCapturing = false;
      });
    } else {
      requestAnimationFrame(() => {
        doCaptureFrame(videoEl, state, currentTime);
        state.isCapturing = false;
      });
    }
  }

  /**
   * Performs the actual canvas capture and stores the thumbnail.
   *
   * @param {HTMLVideoElement} videoEl
   * @param {Object} state - Thumbnail state
   * @param {number} captureTime - The video.currentTime when capture was triggered
   */
  function doCaptureFrame(videoEl, state, captureTime) {
    if (!state.captureCtx || !state.captureCanvas) return;

    const ctx = state.captureCtx;
    const canvas = state.captureCanvas;

    try {
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL(
        "image/jpeg",
        SCRUBBER_CONFIG.JPEG_QUALITY,
      );

      state.thumbnails.push({
        time: captureTime,
        src: dataUrl,
      });

      // Debug: log every 10th thumbnail
      if (state.thumbnails.length % 10 === 0) {
        console.log(
          `[Scrubber] 📸 Captured ${state.thumbnails.length} thumbnails | ` +
            `Last at ${captureTime.toFixed(1)}s | ` +
            `Size: ~${(dataUrl.length / 1024).toFixed(1)}KB`,
        );
      }
    } catch (err) {
      console.warn("[Scrubber] ❌ Capture failed:", err.message);
    }
  }

  /**
   * Starts the thumbnail capture loop for a video.
   *
   * @param {HTMLVideoElement} videoEl
   * @param {Object} state - Thumbnail state (stored on scrubberController)
   */
  function startThumbnailCapture(videoEl, state) {
    if (!videoEl || !state) return;

    // Reset for new video
    state.thumbnails = [];
    state.lastCaptureTime = -1;
    state.isCapturing = false;

    // Stop any existing capture
    stopThumbnailCapture(state, false);

    // Create capture canvas
    getCaptureCanvas(state);

    // Start periodic capture check (~4 times per second)
    state.captureIntervalId = setInterval(() => {
      if (videoEl.paused) return;
      captureFrame(videoEl, state);
    }, SCRUBBER_CONFIG.CAPTURE_CHECK_MS);

    console.log(
      `[Scrubber] ▶️ Capture started (every ~${SCRUBBER_CONFIG.CAPTURE_INTERVAL}s)`,
    );
  }

  /**
   * Stops the thumbnail capture and optionally frees memory.
   *
   * @param {Object} state - Thumbnail state
   * @param {boolean} freeMemory - Whether to clear thumbnails and remove canvas
   */
  function stopThumbnailCapture(state, freeMemory = false) {
    if (!state) return;

    if (state.captureIntervalId) {
      clearInterval(state.captureIntervalId);
      state.captureIntervalId = null;
    }

    if (freeMemory) {
      // Clean up canvas
      if (state.captureCanvas && document.body.contains(state.captureCanvas)) {
        document.body.removeChild(state.captureCanvas);
      }
      state.captureCanvas = null;
      state.captureCtx = null;
      state.thumbnails = [];
      console.log("[Scrubber] 🧹 Memory freed");
    }
  }

  /**
   * Finds the nearest thumbnail to a given time using binary search.
   * O(log n) complexity for fast hover response.
   *
   * @param {Array} thumbnails - Array of { time, src } objects
   * @param {number} targetTime - The time to find nearest thumbnail for
   * @returns {Object|null} The nearest thumbnail or null
   */
  function findNearestThumbnail(thumbnails, targetTime) {
    if (!thumbnails || thumbnails.length === 0) return null;

    let left = 0;
    let right = thumbnails.length - 1;

    // Handle edge cases quickly
    if (targetTime <= thumbnails[0].time) return thumbnails[0];
    if (targetTime >= thumbnails[right].time) return thumbnails[right];

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midTime = thumbnails[mid].time;

      if (midTime === targetTime) return thumbnails[mid];

      if (midTime < targetTime) {
        if (
          mid < thumbnails.length - 1 &&
          thumbnails[mid + 1].time > targetTime
        ) {
          const distToMid = targetTime - midTime;
          const distToNext = thumbnails[mid + 1].time - targetTime;
          return distToMid <= distToNext
            ? thumbnails[mid]
            : thumbnails[mid + 1];
        }
        left = mid + 1;
      } else {
        if (mid > 0 && thumbnails[mid - 1].time < targetTime) {
          const distToPrev = targetTime - thumbnails[mid - 1].time;
          const distToMid = midTime - targetTime;
          return distToPrev <= distToMid
            ? thumbnails[mid - 1]
            : thumbnails[mid];
        }
        right = mid - 1;
      }
    }

    return thumbnails[Math.min(left, thumbnails.length - 1)];
  }

  // ═══════════════════════════════════════════════════════════════
  // HOVER PREVIEW DISPLAY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Shows/hides and positions the hover preview thumbnail.
   * Called on mousemove over the scrubber.
   *
   * @param {MouseEvent} e - The mousemove event
   * @param {HTMLVideoElement} videoEl
   * @param {Object} elements - Scrubber element references
   * @param {Object} state - Thumbnail state (for thumbnails array)
   */
  function handleScrubberHover(e, videoEl, elements, state) {
    if (
      !elements.wrap ||
      !elements.preview ||
      !elements.previewImg ||
      !videoEl.duration
    )
      return;

    const rect = elements.wrap.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    const hoverTime = ratio * videoEl.duration;

    // Position the preview above the hover point
    const hoverX = e.clientX - rect.left;
    elements.preview.style.left = hoverX + "px";

    // Find nearest thumbnail
    if (!state || state.thumbnails.length === 0) {
      // No thumbnails yet, show time only
      elements.previewImg.style.display = "none";
      if (elements.previewLabel) {
        elements.previewLabel.textContent = fmtTime(hoverTime);
      }
      elements.preview.classList.add("visible");
      return;
    }

    const nearest = findNearestThumbnail(state.thumbnails, hoverTime);

    if (nearest) {
      elements.previewImg.style.display = "block";
      if (elements.previewImg.src !== nearest.src) {
        elements.previewImg.src = nearest.src;
      }

      if (elements.previewLabel) {
        elements.previewLabel.textContent = fmtTime(nearest.time);
      }
    }

    elements.preview.classList.add("visible");
  }

  /**
   * Hides the scrubber preview popup.
   * Called on mouseleave from the scrubber.
   *
   * @param {HTMLElement} previewEl - The #vo-scrubber-preview element
   */
  function hideScrubberPreview(previewEl) {
    if (previewEl) {
      previewEl.classList.remove("visible");
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SCRUBBER CONTROLLER
  // ═══════════════════════════════════════════════════════════════

  /**
   * Creates a scrubber controller for a video overlay.
   * Manages all scrubber-related functionality.
   *
   * @param {HTMLElement} controlsContainer - The #vo-controls element
   * @returns {Object} Scrubber controller with attach/detach/cleanup methods
   */
  function createScrubberController(controlsContainer) {
    // ─── Create DOM elements ───
    const elements = createScrubberElements(controlsContainer);

    // ─── State ───
    const thumbnailState = createThumbnailState();
    let currentVideo = null;
    let isAttached = false;

    // ─── Event handlers (stored for cleanup) ───
    const handlers = {
      onTimeUpdate: null,
      onProgress: null,
      onPlayPause: null,
      onScrubberMove: null,
      onScrubberLeave: null,
      onScrubberClick: null,
    };

    /**
     * Attach the scrubber to a video element.
     * Sets up all event listeners and starts thumbnail capture.
     *
     * @param {HTMLVideoElement} videoEl
     */
    function attach(videoEl) {
      if (isAttached) {
        console.warn("[Scrubber] Already attached, detaching first");
        detach();
      }

      currentVideo = videoEl;
      isAttached = true;

      console.log(`[Scrubber] 🔗 Attached to video`);

      // ─── Create bound handlers ───
      handlers.onTimeUpdate = () => {
        updateProgressDisplay(videoEl, elements);
      };

      handlers.onProgress = () => {
        updateBufferedDisplay(videoEl, elements.buffered);
      };

      handlers.onPlayPause = () => {
        const btn = document.getElementById("vo-playpause");
        if (btn) {
          btn.textContent = videoEl.paused ? "▶ Play" : "⏸ Pause";
          btn.classList.toggle("active", !videoEl.paused);
        }
      };

      handlers.onScrubberMove = (e) => {
        handleScrubberHover(e, videoEl, elements, thumbnailState);
      };

      handlers.onScrubberLeave = () => {
        hideScrubberPreview(elements.preview);
      };

      handlers.onScrubberClick = (e) => {
        if (!videoEl.duration) return;
        const rect = elements.wrap.getBoundingClientRect();
        const ratio = Math.max(
          0,
          Math.min(1, (e.clientX - rect.left) / rect.width),
        );
        videoEl.currentTime = ratio * videoEl.duration;
      };

      // ─── Add event listeners ───
      videoEl.addEventListener("timeupdate", handlers.onTimeUpdate);
      videoEl.addEventListener("progress", handlers.onProgress);
      videoEl.addEventListener("play", handlers.onPlayPause);
      videoEl.addEventListener("pause", handlers.onPlayPause);
      elements.wrap.addEventListener("mousemove", handlers.onScrubberMove);
      elements.wrap.addEventListener("mouseleave", handlers.onScrubberLeave);
      elements.wrap.addEventListener("click", handlers.onScrubberClick);

      // ─── Initial display ───
      updateProgressDisplay(videoEl, elements);
      updateBufferedDisplay(videoEl, elements.buffered);
      handlers.onPlayPause();

      // ─── Start thumbnail capture ───
      startThumbnailCapture(videoEl, thumbnailState);
    }

    /**
     * Detach the scrubber from the current video.
     * Removes all event listeners and stops thumbnail capture.
     */
    function detach() {
      if (!isAttached || !currentVideo) return;

      console.log(`[Scrubber] 🔌 Detaching from video`);

      // Stop thumbnail capture (keep thumbnails in memory for re-attach)
      stopThumbnailCapture(thumbnailState, false);

      // Remove event listeners
      if (handlers.onTimeUpdate) {
        currentVideo.removeEventListener("timeupdate", handlers.onTimeUpdate);
      }
      if (handlers.onProgress) {
        currentVideo.removeEventListener("progress", handlers.onProgress);
      }
      if (handlers.onPlayPause) {
        currentVideo.removeEventListener("play", handlers.onPlayPause);
        currentVideo.removeEventListener("pause", handlers.onPlayPause);
      }
      if (handlers.onScrubberMove) {
        elements.wrap?.removeEventListener(
          "mousemove",
          handlers.onScrubberMove,
        );
      }
      if (handlers.onScrubberLeave) {
        elements.wrap?.removeEventListener(
          "mouseleave",
          handlers.onScrubberLeave,
        );
      }
      if (handlers.onScrubberClick) {
        elements.wrap?.removeEventListener("click", handlers.onScrubberClick);
      }

      // Clear handler references
      Object.keys(handlers).forEach((key) => {
        handlers[key] = null;
      });

      // Clear displays
      if (elements.buffered) elements.buffered.innerHTML = "";
      if (elements.fill) elements.fill.style.width = "0%";
      if (elements.thumb) elements.thumb.style.left = "0%";
      hideScrubberPreview(elements.preview);

      currentVideo = null;
      isAttached = false;
    }

    /**
     * Full cleanup - frees all memory and removes canvas.
     * Call when the overlay is closed.
     */
    function cleanup() {
      detach();
      stopThumbnailCapture(thumbnailState, true);

      // Clean up any lingering capture canvases
      document
        .querySelectorAll('canvas[data-thumb-capture="true"]')
        .forEach((c) => c.remove());
    }

    /**
     * Returns the current thumbnail count for debugging.
     */
    function getThumbnailCount() {
      return thumbnailState.thumbnails.length;
    }

    // ─── Return controller ───
    return {
      attach,
      detach,
      cleanup,
      getThumbnailCount,
      elements, // Exposed for direct access if needed
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // GLOBAL API
  // ═══════════════════════════════════════════════════════════════
  window.ScrubberSystem = {
    createScrubberController,
    config: SCRUBBER_CONFIG,
    // Utility exports for external use
    fmtTime,
    getScrubberHTML,
  };

  console.log("[Scrubber] ✅ System initialized");
}
