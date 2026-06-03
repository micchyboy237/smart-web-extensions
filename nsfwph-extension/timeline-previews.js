// timeline-previews.js - Fixed cache persistence (don't cancel before cache save)
// Caches TIMESTAMPS + keeps capture video alive between overlay opens.
// Regenerates video display thumbnails quickly from cached timestamps.
const TimelinePreviews = {
  NUM_PREVIEWS: 6,
  THUMB_WIDTH: 120,
  THUMB_HEIGHT: 68,
  SEEK_TIMEOUT: 5000,
  METADATA_TIMEOUT: 10000,

  // ═══════════════════════════════════════════════════════════════
  // CACHE: Stores timestamps + capture video reference
  // ═══════════════════════════════════════════════════════════════
  _cache: new Map(), // cacheKey → { timestamps, captureVideo, sourceUrl, isVideoDisplay }
  _state: null,

  hardDetachAll() {
    console.log("[TimelinePreviews] 🧹 Hard detach all");
    this._detachInternal(true);
    // Destroy all cached capture videos
    for (const [key, entry] of this._cache) {
      if (entry.captureVideo) {
        try {
          console.log(
            `[TimelinePreviews] 🗑️ Destroying cached capture video for key: ${key}`,
          );
          entry.captureVideo.pause();
          entry.captureVideo.removeAttribute("src");
          entry.captureVideo.load();
          if (entry.captureVideo.parentElement) {
            entry.captureVideo.parentElement.removeChild(entry.captureVideo);
          }
        } catch (e) {
          /* ignore */
        }
        entry.captureVideo = null;
      }
    }
    this._cache.clear();
  },

  async softAttach(videoRef, options = {}) {
    const cacheKey =
      videoRef.cacheKey || this._getCleanSourceUrl(videoRef.sourceUrl);
    console.log(`[TimelinePreviews] softAttach: ${cacheKey}`);

    // 🔧 FIX: Validate cache key against source URL to catch mismatches
    const cleanSourceUrl = this._getCleanSourceUrl(videoRef.sourceUrl);
    console.log(`[TimelinePreviews:D] Cache key: ${cacheKey}`);
    console.log(`[TimelinePreviews:D] Clean source URL: ${cleanSourceUrl}`);

    const cached = this._cache.get(cacheKey);
    console.log(`[TimelinePreviews:D] Cache has entry: ${!!cached}`);

    // 🔧 FIX: If cached entry exists but source URLs don't match, it's a hash collision or wrong key
    if (
      cached &&
      cached.sourceUrl &&
      cleanSourceUrl &&
      cached.sourceUrl !== cleanSourceUrl
    ) {
      console.warn(
        `[TimelinePreviews] ⚠️ CACHE KEY COLLISION! Cached source "${cached.sourceUrl}" ≠ requested "${cleanSourceUrl}". Clearing stale cache.`,
      );
      // Destroy the stale cached video
      if (cached.captureVideo) {
        try {
          cached.captureVideo.pause();
          cached.captureVideo.removeAttribute("src");
          cached.captureVideo.load();
          if (cached.captureVideo.parentElement) {
            cached.captureVideo.parentElement.removeChild(cached.captureVideo);
          }
        } catch (e) {
          /* ignore */
        }
      }
      this._cache.delete(cacheKey);
      // Fall through to cache miss path
    }

    if (cached) {
      console.log(
        `[TimelinePreviews:D] Cached timestamps: ${cached.timestamps?.length || 0}`,
      );
      console.log(
        `[TimelinePreviews:D] Cached captureVideo exists: ${!!cached.captureVideo}`,
      );
      console.log(
        `[TimelinePreviews:D] Cached sourceUrl: ${cached.sourceUrl || "none"}`,
      );
      if (cached.captureVideo) {
        console.log(
          `[TimelinePreviews:D] Capture video parentElement: ${!!cached.captureVideo.parentElement}`,
        );
        console.log(
          `[TimelinePreviews:D] Capture video duration: ${cached.captureVideo.duration}`,
        );
        console.log(
          `[TimelinePreviews:D] Capture video readyState: ${cached.captureVideo.readyState}`,
        );
        console.log(
          `[TimelinePreviews:D] Capture video src: ${cached.captureVideo.src || "empty"}`,
        );
      }
    }

    // Check if we have a valid cached entry with a LIVE capture video
    if (
      cached &&
      cached.timestamps &&
      cached.timestamps.length > 0 &&
      cached.captureVideo &&
      cached.captureVideo.parentElement &&
      cached.captureVideo.duration > 0
    ) {
      console.log(
        `[TimelinePreviews] 💾 CACHE HIT! ${cached.timestamps.length} timestamps + live capture video ready`,
      );
      return this._attachWithCachedVideo(videoRef, cached, options, cacheKey);
    }

    // Cache entry exists but capture video is dead - clean it up
    if (cached) {
      console.log(
        `[TimelinePreviews] ⚠️ Cache entry exists but capture video is dead/missing - cleaning up stale cache for key: ${cacheKey}`,
      );
      if (cached.captureVideo) {
        try {
          cached.captureVideo.pause();
          cached.captureVideo.removeAttribute("src");
          cached.captureVideo.load();
          if (cached.captureVideo.parentElement) {
            cached.captureVideo.parentElement.removeChild(cached.captureVideo);
          }
        } catch (e) {
          /* ignore */
        }
      }
      this._cache.delete(cacheKey);
    }

    console.log(
      `[TimelinePreviews] ❌ Cache miss — full generation needed for key: ${cacheKey}`,
    );
    return this._attachAndGenerate(videoRef, options, cacheKey);
  },

  async attach(videoRef, options = {}) {
    const cacheKey =
      videoRef.cacheKey || this._getCleanSourceUrl(videoRef.sourceUrl);
    // Destroy cached capture video
    const cached = this._cache.get(cacheKey);
    if (cached?.captureVideo) {
      try {
        cached.captureVideo.pause();
        cached.captureVideo.removeAttribute("src");
        cached.captureVideo.load();
        if (cached.captureVideo.parentElement)
          cached.captureVideo.parentElement.removeChild(cached.captureVideo);
      } catch (e) {
        /* ignore */
      }
      cached.captureVideo = null;
    }
    this._cache.delete(cacheKey);
    console.log(
      `[TimelinePreviews] Hard attach — forcing regeneration for key: ${cacheKey}`,
    );
    return this._attachAndGenerate(videoRef, options, cacheKey);
  },

  // ═══════════════════════════════════════════════════════════════
  // ATTACH WITH CACHED VIDEO (FAST PATH)
  // ═══════════════════════════════════════════════════════════════
  async _attachWithCachedVideo(videoRef, cached, options = {}, cacheKey) {
    this._detachInternal(false); // Soft detach previous state

    const config = {
      numPreviews: options.numPreviews || cached.timestamps.length,
      thumbWidth: options.thumbWidth || this.THUMB_WIDTH,
      thumbHeight: options.thumbHeight || this.THUMB_HEIGHT,
    };

    const sourceUrl = this._getCleanSourceUrl(videoRef.sourceUrl);

    this._state = {
      videoRef,
      cacheKey,
      sourceUrl,
      config,
      timestamps: [...cached.timestamps],
      thumbnails: new Array(cached.timestamps.length).fill(null),
      captureVideo: cached.captureVideo, // REUSE the cached video!
      abortController: null,
      cancelled: false,
      containerEl: null,
      placeholderRow: null,
      cleanupFns: [],
      fromCache: true, // Already from cache
      generating: true,
      generationPromise: null,
    };

    const state = this._state;

    // Render placeholders immediately
    this._renderPlaceholderStrip(state);

    // Quickly seek and capture all frames using the already-loaded video
    state.generationPromise = this._quickGenerateFromCachedVideo(state)
      .then(() => {
        if (!state.cancelled) {
          state.generating = false;
          console.log(
            `[TimelinePreviews] ✅ Quick generation complete for key: ${cacheKey}`,
          );
        }
      })
      .catch((err) => {
        if (!state.cancelled)
          console.warn("[TimelinePreviews] Quick generation error:", err);
        state.generating = false;
      });

    return {
      cleanup: (hard = false) => this._detachInternal(hard),
      isReady: () =>
        state.thumbnails.filter((t) => t !== null).length ===
        state.timestamps.length,
    };
  },

  /**
   * Quickly generate thumbnails from an already-loaded capture video.
   */
  async _quickGenerateFromCachedVideo(state) {
    state.abortController = new AbortController();
    const signal = state.abortController.signal;
    const video = state.captureVideo;
    const { timestamps, config } = state;

    console.log(
      `[TimelinePreviews] ⚡ Quick generating ${timestamps.length} frames from cached video...`,
    );

    // Test if canvas works
    let canvasWorks = false;
    try {
      const testTime = Math.min(1, video.duration * 0.3);
      video.currentTime = testTime;
      await this._seekVideo(video, testTime, signal);
      await new Promise((r) => setTimeout(r, 100));
      const c = document.createElement("canvas");
      c.width = 10;
      c.height = 10;
      c.getContext("2d").drawImage(video, 0, 0, 10, 10);
      c.toDataURL("image/jpeg", 0.1);
      canvasWorks = true;
    } catch (e) {
      canvasWorks = false;
    }

    if (signal.aborted || state.cancelled) return;

    for (let i = 0; i < timestamps.length; i++) {
      if (state.cancelled || signal.aborted) return;

      const timestamp = timestamps[i];
      try {
        await this._seekVideo(video, timestamp, signal);
        if (signal.aborted) return;

        await new Promise((r) => setTimeout(r, 50));

        if (canvasWorks) {
          const canvas = document.createElement("canvas");
          canvas.width = config.thumbWidth;
          canvas.height = config.thumbHeight;
          canvas
            .getContext("2d")
            .drawImage(video, 0, 0, config.thumbWidth, config.thumbHeight);
          state.thumbnails[i] = canvas.toDataURL("image/jpeg", 0.75);
          this._updatePlaceholder(state, i, state.thumbnails[i]);
        } else {
          const clone = video.cloneNode(true);
          clone.style.display = "block";
          clone.style.width = "100%";
          clone.style.height = "100%";
          clone.style.objectFit = "cover";
          clone.style.position = "static";
          clone.style.opacity = "1";
          clone.style.pointerEvents = "none";
          clone.muted = true;
          clone.pause();
          this._insertMiniVideoIntoPlaceholder(state, i, clone);
          state.thumbnails[i] = "video:" + timestamp;
        }

        console.log(
          `[TimelinePreviews] ⚡ Frame ${i + 1}/${timestamps.length} done`,
        );
      } catch (err) {
        if (signal.aborted) return;
        console.warn(
          `[TimelinePreviews] ⚡ Frame ${i + 1} failed:`,
          err.message,
        );
        state.thumbnails[i] = null;
        this._markPlaceholderError(state, i);
      }
    }

    console.log(`[TimelinePreviews] ✅ Quick generation complete`);
  },

  // ═══════════════════════════════════════════════════════════════
  // ATTACH AND GENERATE (SLOW PATH — first time)
  // ═══════════════════════════════════════════════════════════════
  async _attachAndGenerate(videoRef, options = {}, cacheKey) {
    this._detachInternal(false);

    const config = {
      numPreviews: options.numPreviews || this.NUM_PREVIEWS,
      thumbWidth: options.thumbWidth || this.THUMB_WIDTH,
      thumbHeight: options.thumbHeight || this.THUMB_HEIGHT,
    };

    const sourceUrl = this._getCleanSourceUrl(videoRef.sourceUrl);

    this._state = {
      videoRef,
      cacheKey,
      sourceUrl,
      config,
      timestamps: [],
      thumbnails: [],
      captureVideo: null,
      abortController: null,
      cancelled: false,
      containerEl: null,
      placeholderRow: null,
      cleanupFns: [],
      fromCache: false,
      generating: true,
      generationPromise: null,
    };

    const state = this._state;

    await this._ensureDuration(state);
    if (state.cancelled) return this._makeCleanupReturn();

    state.timestamps = this._calculateTimestamps(
      state.videoRef.duration,
      config.numPreviews,
    );

    console.log(
      "[TimelinePreviews] Timestamps:",
      state.timestamps.map((t) => this._fmtTime(t)),
    );

    this._renderPlaceholderStrip(state);

    // ═══════════════════════════════════════════════════════════════
    // KEY FIX: The .then() callback must NOT check state.cancelled
    // because detach sets cancelled=true before waiting for this promise.
    // The cache save is the whole reason we wait, so it must always run.
    // ═══════════════════════════════════════════════════════════════
    state.generationPromise = this._generateAllThumbnails(state)
      .then(() => {
        // Always save to cache if generation succeeded (regardless of cancelled flag)
        // The cancelled flag only means the user closed the overlay - we still want to cache
        console.log(
          `[TimelinePreviews:D] Generation .then() fired - saving to cache for key: ${cacheKey}`,
        );
        console.log(
          `[TimelinePreviews:D] state.cancelled=${state.cancelled}, captureVideo exists=${!!state.captureVideo}`,
        );

        // Cache the timestamps + capture video for future reuse
        this._cache.set(cacheKey, {
          timestamps: [...state.timestamps],
          captureVideo: state.captureVideo,
          sourceUrl: sourceUrl, // 🔧 Already present but verify it's correct
          isVideoDisplay: true,
        });
        console.log(
          `[TimelinePreviews] 💾 Cached timestamps + capture video for reuse (key: ${cacheKey}, sourceUrl: ${sourceUrl})`,
        );
        console.log(
          `[TimelinePreviews:D] Cache now has ${this._cache.size} entries`,
        );

        // IMPORTANT: Mark state as fromCache so detach preserves the video
        state.fromCache = true;
        state.captureVideo = null; // Null the state reference but cache still holds it
        state.generating = false;
      })
      .catch((err) => {
        // On error, don't cache
        console.warn("[TimelinePreviews] Generation error (not caching):", err);
        state.generating = false;
      });

    return {
      cleanup: (hard = false) => this._detachInternal(hard),
      isReady: () =>
        state.thumbnails.filter((t) => t !== null).length ===
        state.timestamps.length,
    };
  },

  _makeCleanupReturn() {
    return {
      cleanup: (hard = false) => this._detachInternal(hard),
      isReady: () => false,
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // DETACH
  // ═══════════════════════════════════════════════════════════════
  async _detachInternal(hard = false) {
    if (!this._state) {
      console.log("[TimelinePreviews] No state to detach");
      return;
    }

    const state = this._state;
    const mode = hard ? "HARD" : "SOFT";

    console.log(
      `[TimelinePreviews] 🛑 ${mode} detaching... (generating=${state.generating}, fromCache=${state.fromCache}, cacheKey=${state.cacheKey || "none"})`,
    );

    // ═══════════════════════════════════════════════════════════════
    // IMPORTANT: Set cancelled BEFORE aborting, but the .then() callback
    // no longer checks cancelled for cache saving (see fix above).
    // We still abort the abortController to stop any in-progress seeks.
    // ═══════════════════════════════════════════════════════════════
    state.cancelled = true;

    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }

    // ═══════════════════════════════════════════════════════════════
    // KEY FIX: If generation is still in progress, wait for it to finish
    // so the cache gets saved before we decide to destroy the video
    // ═══════════════════════════════════════════════════════════════
    if (state.generationPromise && !hard) {
      console.log(
        `[TimelinePreviews] ⏳ Waiting for generation to complete before detaching...`,
      );
      try {
        await Promise.race([
          state.generationPromise,
          new Promise((resolve) => setTimeout(resolve, 5000)), // 5s timeout
        ]);
        console.log(
          `[TimelinePreviews] ✅ Generation completed, proceeding with detach`,
        );
      } catch (e) {
        console.log(
          `[TimelinePreviews] ⚠️ Generation failed/timed out, proceeding with detach`,
        );
      }
      // Re-check fromCache after generation completes (should be true now!)
      console.log(
        `[TimelinePreviews:D] After generation wait: fromCache=${state.fromCache}, isVideoCached=${!!(state.cacheKey && this._cache.has(state.cacheKey))}`,
      );
    }

    // Determine if the capture video should be destroyed:
    // - HARD detach: Always destroy (even cached ones)
    // - SOFT detach: Only destroy if it's NOT in the cache
    const isVideoCached = state.cacheKey && this._cache.has(state.cacheKey);
    const shouldDestroyVideo = hard || (!isVideoCached && !state.fromCache);

    console.log(
      `[TimelinePreviews:D] Detach decision: hard=${hard}, isVideoCached=${isVideoCached}, fromCache=${state.fromCache}, shouldDestroyVideo=${shouldDestroyVideo}`,
    );

    if (shouldDestroyVideo && state.captureVideo) {
      console.log(
        `[TimelinePreviews] 🗑️ Destroying capture video (not cached or hard detach)`,
      );
      this._destroyCaptureVideo(state);
    } else if (state.captureVideo) {
      console.log(
        `[TimelinePreviews] 💾 Preserving capture video (cached for reuse)`,
      );
    } else if (isVideoCached) {
      console.log(
        `[TimelinePreviews] 💾 Capture video preserved in cache (state had null reference, cache key: ${state.cacheKey})`,
      );
    }

    // Run cleanup functions
    state.cleanupFns.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        /* ignore */
      }
    });
    state.cleanupFns = [];

    // Remove container
    if (state.containerEl?.parentElement) {
      state.containerEl.remove();
    }

    // HARD detach: also clear the cache entry
    if (hard && state.cacheKey) {
      const cached = this._cache.get(state.cacheKey);
      if (cached?.captureVideo) {
        try {
          cached.captureVideo.pause();
          cached.captureVideo.removeAttribute("src");
          cached.captureVideo.load();
          if (cached.captureVideo.parentElement)
            cached.captureVideo.parentElement.removeChild(cached.captureVideo);
        } catch (e) {
          /* ignore */
        }
      }
      this._cache.delete(state.cacheKey);
      console.log(
        `[TimelinePreviews] 🗑️ Cache cleared for key: ${state.cacheKey}`,
      );
    }

    // Clear state references
    state.thumbnails = [];
    state.timestamps = [];

    if (shouldDestroyVideo) {
      state.captureVideo = null;
    }

    state.containerEl = null;
    state.placeholderRow = null;
    state.videoRef = null;
    this._state = null;

    console.log(`[TimelinePreviews] ✅ ${mode} detach complete`);
  },

  detach(hard = false) {
    this._detachInternal(hard);
  },

  // ═══════════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════════
  _getCleanSourceUrl(rawSrc) {
    if (typeof rawSrc === "object" && rawSrc.sourceUrl)
      rawSrc = rawSrc.sourceUrl;
    if (typeof rawSrc !== "string") return "";
    return rawSrc.replace(/([?&])preview=1(&|$)/, "$1").replace(/[?&]$/, "");
  },

  _fmtTime(seconds) {
    if (!isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  },

  async _ensureDuration(state) {
    const { videoRef } = state;
    if (
      videoRef.duration &&
      isFinite(videoRef.duration) &&
      videoRef.duration > 0
    )
      return;

    const startTime = Date.now();
    while (Date.now() - startTime < this.METADATA_TIMEOUT) {
      if (state.cancelled) return;
      if (
        videoRef.duration &&
        isFinite(videoRef.duration) &&
        videoRef.duration > 0
      )
        return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Duration timeout");
  },

  _calculateTimestamps(duration, numPreviews) {
    if (duration <= 0 || numPreviews <= 0) return [];

    const timestamps = [];
    const startPercent = 0.1;
    const endPercent = 0.9;
    const range = duration * (endPercent - startPercent);
    const start = duration * startPercent;

    for (let i = 0; i < numPreviews; i++) {
      timestamps.push(
        Math.max(
          0.1,
          Math.min(start + (range * i) / (numPreviews - 1), duration - 0.1),
        ),
      );
    }
    return timestamps;
  },

  // ═══════════════════════════════════════════════════════════════
  // RENDERING
  // ═══════════════════════════════════════════════════════════════
  _renderPlaceholderStrip(state) {
    const { config, timestamps } = state;
    const existingContainer = state.existingContainer;
    const existingRow = state.existingRow;
    let row, container;

    if (existingRow && existingContainer) {
      container = existingContainer;
      row = existingRow;
      row.innerHTML = "";
    } else {
      container = document.createElement("div");
      container.id = "vo-timeline-previews";
      container.className = "timeline-previews-strip";
      const header = document.createElement("div");
      header.className = "timeline-previews-header";
      header.textContent = "Timeline Previews";
      container.appendChild(header);
      row = document.createElement("div");
      row.className = "timeline-previews-row";
      container.appendChild(row);
      this._insertIntoOverlay(container);
    }

    timestamps.forEach((timestamp, index) => {
      const item = document.createElement("div");
      item.className = "timeline-preview-item loading";
      item.dataset.index = index;
      item.dataset.timestamp = timestamp;

      // 🔧 FIX: Use <img> element instead of background-image on div
      const thumbContainer = document.createElement("div");
      thumbContainer.className = "timeline-preview-thumb";
      thumbContainer.style.width = config.thumbWidth + "px";
      thumbContainer.style.height = config.thumbHeight + "px";

      // Create an <img> element that will hold the actual thumbnail
      const img = document.createElement("img");
      img.className = "timeline-preview-img";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      img.style.display = "none"; // Hidden until loaded
      img.alt = `Preview at ${this._fmtTime(timestamp)}`;
      img.dataset.timestampIndex = index;

      // Loading spinner (shown while thumbnail is loading)
      const loading = document.createElement("div");
      loading.className = "timeline-preview-loading";
      loading.innerHTML = '<span class="loading-spinner"></span>';

      thumbContainer.appendChild(img);
      thumbContainer.appendChild(loading);
      item.appendChild(thumbContainer);

      const label = document.createElement("div");
      label.className = "timeline-preview-label";
      label.textContent = this._fmtTime(timestamp);
      item.appendChild(label);

      const clickHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.videoRef.isActive && state.videoRef.isActive()) {
          state.videoRef.seekTo(timestamp);
          if (state.containerEl) {
            state.containerEl
              .querySelectorAll(".timeline-preview-item")
              .forEach((el) => {
                el.classList.toggle(
                  "active",
                  Math.abs(parseFloat(el.dataset.timestamp) - timestamp) < 0.01,
                );
              });
          }
        }
      };
      item.addEventListener("click", clickHandler);
      state.cleanupFns.push(() =>
        item.removeEventListener("click", clickHandler),
      );
      row.appendChild(item);
    });

    state.containerEl = container;
    state.placeholderRow = row;
    container.style.display = "block";
  },

  _insertIntoOverlay(stripEl) {
    const controlsEl = document.getElementById("vo-controls");
    if (controlsEl) {
      controlsEl.insertAdjacentElement("beforebegin", stripEl);
    } else {
      const player = document.getElementById("vo-player");
      if (player) player.appendChild(stripEl);
      else document.body.appendChild(stripEl);
    }
  },

  _updatePlaceholder(state, index, dataUrl) {
    const item = state.placeholderRow?.querySelector(`[data-index="${index}"]`);
    if (!item || !dataUrl) return;

    const thumbContainer = item.querySelector(".timeline-preview-thumb");
    if (!thumbContainer) return;

    const img = thumbContainer.querySelector(".timeline-preview-img");
    const loadingEl = thumbContainer.querySelector(".timeline-preview-loading");

    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      if (img) {
        // 🔧 FIX: Set the <img> src to the data URL (actual thumbnail image)
        img.src = dataUrl;
        img.style.display = "block";
        img.onload = () => {
          // Hide loading spinner once image loads
          if (loadingEl) loadingEl.style.display = "none";
        };
        img.onerror = () => {
          // On error, keep loading visible (will show error state)
          console.warn(`[TimelinePreviews] Failed to load thumbnail ${index}`);
          img.style.display = "none";
          if (loadingEl) {
            loadingEl.innerHTML =
              '<span style="font-size:10px;color:#ff6666;">⚠️</span>';
          }
        };
      }
      // Fallback: also set background-image as backup
      thumbContainer.style.backgroundImage = `url(${dataUrl})`;
      thumbContainer.style.backgroundSize = "cover";
      thumbContainer.style.backgroundPosition = "center";
    }

    // Hide loading spinner if img is already loaded
    if (img && img.complete && img.naturalWidth > 0) {
      if (loadingEl) loadingEl.style.display = "none";
    }

    item.classList.remove("loading");
    item.classList.add("loaded");
  },

  _insertMiniVideoIntoPlaceholder(state, index, miniVideo) {
    const item = state.placeholderRow?.querySelector(`[data-index="${index}"]`);
    if (!item) return;

    const thumbContainer = item.querySelector(".timeline-preview-thumb");
    if (!thumbContainer) return;

    const loadingEl = thumbContainer.querySelector(".timeline-preview-loading");
    if (loadingEl) loadingEl.remove();

    thumbContainer.appendChild(miniVideo);

    item.classList.remove("loading");
    item.classList.add("loaded");
  },

  _markPlaceholderError(state, index) {
    const item = state.placeholderRow?.querySelector(`[data-index="${index}"]`);
    if (!item) return;

    const loadingEl = item.querySelector(".timeline-preview-loading");
    if (loadingEl)
      loadingEl.innerHTML =
        '<span style="font-size:10px;color:#ff6666;">⚠️</span>';

    item.classList.remove("loading");
    item.classList.add("error");
  },

  // ═══════════════════════════════════════════════════════════════
  // CAPTURE VIDEO
  // ═══════════════════════════════════════════════════════════════
  _createCaptureVideo(state) {
    if (state.captureVideo) return state.captureVideo;

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.style.display = "none";
    video.style.position = "absolute";
    video.style.width = "1px";
    video.style.height = "1px";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    video.dataset.timelinePreviewCapture = "true";
    video.dataset.boostAttached = "true";
    video.dataset.videoObserverAttached = "true";
    video.dataset.continuousMonitorActive = "true";

    document.body.appendChild(video);
    state.captureVideo = video;

    console.log(`[TimelinePreviews] 📹 Created new capture video`);
    return video;
  },

  _destroyCaptureVideo(state) {
    if (!state.captureVideo) return;

    try {
      console.log(
        `[TimelinePreviews] 🗑️ Destroying capture video (src: ${state.captureVideo.src || "empty"})`,
      );
      state.captureVideo.pause();
      state.captureVideo.removeAttribute("src");
      state.captureVideo.load();
      if (state.captureVideo.parentElement)
        state.captureVideo.parentElement.removeChild(state.captureVideo);
    } catch (e) {
      /* ignore */
    }
    state.captureVideo = null;
  },

  // ═══════════════════════════════════════════════════════════════
  // GENERATION
  // ═══════════════════════════════════════════════════════════════
  async _generateAllThumbnails(state) {
    state.abortController = new AbortController();
    const signal = state.abortController.signal;
    const video = this._createCaptureVideo(state);
    const { sourceUrl } = state;

    console.log(
      `[TimelinePreviews] 🎬 Generating ${state.timestamps.length} thumbnails for source: ${sourceUrl}`,
    );

    await this._loadCaptureVideo(state, sourceUrl, signal);
    if (state.cancelled || signal.aborted) return;

    const canvasWorks = await this._testCanvasSupport(state, signal);
    if (canvasWorks) {
      await this._generateViaCanvas(state, signal);
    } else {
      await this._generateViaVideoDisplay(state, signal);
    }

    // DON'T destroy capture video — keep it for caching
    console.log(
      `[TimelinePreviews] 📹 Keeping capture video alive for cache (src: ${video.src || "empty"})`,
    );
  },

  async _loadCaptureVideo(state, sourceUrl, signal) {
    const video = state.captureVideo;

    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const onAbort = () => {
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onError);
        clearTimeout(timeout);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const timeout = setTimeout(() => {
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Load timeout"));
      }, this.METADATA_TIMEOUT);

      const onMeta = () => {
        clearTimeout(timeout);
        video.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };

      const onError = () => {
        clearTimeout(timeout);
        video.removeEventListener("loadedmetadata", onMeta);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Load error"));
      };

      video.addEventListener("loadedmetadata", onMeta, { once: true });
      video.addEventListener("error", onError, { once: true });

      video.src = sourceUrl;

      if (video.readyState >= 1 && video.duration > 0) {
        clearTimeout(timeout);
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
    });
  },

  async _testCanvasSupport(state, signal) {
    const video = state.captureVideo;

    video.crossOrigin = "anonymous";
    video.src = state.sourceUrl;

    try {
      await this._loadCaptureVideo(state, state.sourceUrl, signal);
    } catch (e) {
      video.crossOrigin = null;
      video.src = state.sourceUrl;
      try {
        await this._loadCaptureVideo(state, state.sourceUrl, signal);
      } catch (e2) {
        return false;
      }
    }

    if (signal.aborted || state.cancelled) return false;

    try {
      await this._seekVideo(video, Math.min(1, video.duration * 0.3), signal);
    } catch (e) {
      return false;
    }

    await new Promise((r) => setTimeout(r, 150));

    try {
      const c = document.createElement("canvas");
      c.width = 10;
      c.height = 10;
      c.getContext("2d").drawImage(video, 0, 0, 10, 10);
      c.toDataURL("image/jpeg", 0.1);
      return true;
    } catch (e) {
      return false;
    }
  },

  async _seekVideo(video, timestamp, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const onAbort = () => {
        video.removeEventListener("seeked", onSeeked);
        clearTimeout(timeout);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const timeout = setTimeout(() => {
        video.removeEventListener("seeked", onSeeked);
        signal.removeEventListener("abort", onAbort);
        reject(new Error(`Seek timeout at ${timestamp.toFixed(1)}s`));
      }, this.SEEK_TIMEOUT);

      const onSeeked = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      video.addEventListener("seeked", onSeeked, { once: true });

      if (Math.abs(video.currentTime - timestamp) < 0.05) {
        clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        signal.removeEventListener("abort", onAbort);
        resolve();
        return;
      }

      video.currentTime = timestamp;
    });
  },

  async _generateViaCanvas(state, signal) {
    const video = state.captureVideo;
    const { timestamps, config } = state;

    for (let i = 0; i < timestamps.length; i++) {
      if (state.cancelled || signal.aborted) return;

      try {
        await this._seekVideo(video, timestamps[i], signal);
        if (signal.aborted) return;

        await new Promise((r) => setTimeout(r, 100));
        if (signal.aborted) return;

        const canvas = document.createElement("canvas");
        canvas.width = config.thumbWidth;
        canvas.height = config.thumbHeight;
        canvas
          .getContext("2d")
          .drawImage(video, 0, 0, config.thumbWidth, config.thumbHeight);

        state.thumbnails[i] = canvas.toDataURL("image/jpeg", 0.75);
        this._updatePlaceholder(state, i, state.thumbnails[i]);
      } catch (err) {
        if (signal.aborted) return;
        state.thumbnails[i] = null;
        this._markPlaceholderError(state, i);
      }
    }
  },

  async _generateViaVideoDisplay(state, signal) {
    const video = state.captureVideo;
    video.crossOrigin = null;

    // Reload without CORS
    video.src = state.sourceUrl;
    await this._loadCaptureVideo(state, state.sourceUrl, signal);
    if (signal.aborted) return;

    for (let i = 0; i < state.timestamps.length; i++) {
      if (state.cancelled || signal.aborted) return;

      try {
        await this._seekVideo(video, state.timestamps[i], signal);
        if (signal.aborted) return;

        const clone = video.cloneNode(true);
        clone.style.display = "block";
        clone.style.width = "100%";
        clone.style.height = "100%";
        clone.style.objectFit = "cover";
        clone.style.position = "static";
        clone.style.opacity = "1";
        clone.style.pointerEvents = "none";
        clone.muted = true;
        clone.pause();

        this._insertMiniVideoIntoPlaceholder(state, i, clone);
        state.thumbnails[i] = "video:" + state.timestamps[i];
      } catch (err) {
        if (signal.aborted) return;
        state.thumbnails[i] = null;
        this._markPlaceholderError(state, i);
      }
    }
  },
};

if (typeof window !== "undefined") {
  window.TimelinePreviews = TimelinePreviews;
}
