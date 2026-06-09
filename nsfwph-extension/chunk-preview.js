// chunk-preview.js - Lightweight Chunk Preview System
// Creates 2-3 second moving clip previews that loop through video chunks

(function () {
  "use strict";

  console.log("[ChunkPreview] Module loading...");

  // ═══════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════

  const NUM_PREVIEW_CHUNKS = 5;
  const CHUNK_PLAY_DURATION_MS = 4000; // 4s per chunk → ~20s full cycle

  // ═══════════════════════════════════════════════════════════════
  // CORE FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Set up lightweight chunk preview loop for a preview video element
   */
  function setupLightChunkPreview(previewVideo, entryId, cacheKeySrc) {
    // Validate cacheKeySrc with fallback
    if (!cacheKeySrc || typeof cacheKeySrc !== "string") {
      console.error(`[Preview] ❌ Invalid cacheKeySrc for ${entryId}:`, {
        value: cacheKeySrc,
        type: typeof cacheKeySrc,
        previewSrc: previewVideo?.currentSrc || previewVideo?.src,
      });

      const rawSrc = previewVideo.currentSrc || previewVideo.src || "";
      cacheKeySrc = rawSrc
        .replace(/([?&])preview=1(&|$)/, "$1")
        .replace(/[?&]$/, "");

      console.log("[Preview:D] Fallback cacheKeySrc calculated:", {
        cacheKeySrc,
      });

      if (!cacheKeySrc) {
        console.error(
          `[Preview] ❌ Could not determine cacheKeySrc for ${entryId}, using timestamp fallback`,
        );
        cacheKeySrc = `fallback-${entryId}-${Date.now()}`;
      }
    }

    const validatedCacheKey = cacheKeySrc;

    if (previewVideo.dataset.previewLoopReady === "true") {
      console.log(`[Preview:D] Loop already set up for ${entryId}, skipping`);
      return () => {};
    }

    previewVideo.dataset.previewLoopReady = "true";
    console.log(`[Preview] Setting up chunk loop for ${entryId}`);
    console.log("[Preview:D] Cache key:", { validatedCacheKey });

    const state = {
      isRunning: false,
      isHovering: false,
      currentChunk: 0,
      monitorInterval: null,
      chunkStarts: null,
      chunkDuration: CHUNK_PLAY_DURATION_MS / 1000,
      cacheLoaded: false,
      playbackStarted: false,
      totalChunks: 0,
      debugFrameCount: 0,
    };

    let hoverDebounceTimer = null;
    const HOVER_DEBOUNCE_MS = 100;

    async function loadChunkPositions() {
      if (state.chunkStarts && state.chunkStarts.length > 0) {
        console.log(
          `[Preview:D] Chunk positions already loaded for ${entryId}`,
        );
        return;
      }

      console.log(`[Preview] Loading chunk positions for ${entryId}...`);
      console.log("[Preview:D] Looking up cache key:", { validatedCacheKey });

      try {
        const cached = await window.ChunkCache.get(validatedCacheKey);

        if (cached && cached.chunks && cached.chunks.length > 0) {
          console.log(
            `[Preview] ✅ CACHE HIT for ${entryId} ` +
              `(${cached.chunks.length} chunks, duration: ${cached.duration?.toFixed(1)}s)`,
          );
          console.log(
            `[Preview:D] Chunk positions from cache: [${cached.chunks.map((s) => s.toFixed(2)).join(", ")}]`,
          );

          state.chunkStarts = cached.chunks;
          state.totalChunks = cached.chunks.length;
          state.cacheLoaded = true;
          return;
        } else {
          console.log(
            `[Preview] ❌ CACHE MISS for ${entryId} - will calculate chunks`,
          );
        }
      } catch (err) {
        console.warn(
          `[Preview] Cache read failed for ${entryId}:`,
          err.message,
        );
      }

      console.log(`[Preview] Calculating chunks for ${entryId}...`);
      calculateChunks();
    }

    function calculateChunks() {
      const duration = previewVideo.duration || 0;
      console.log(
        `[Preview:D] Video duration: ${duration.toFixed(2)}s, ` +
          `chunk duration: ${state.chunkDuration}s`,
      );

      if (!duration || isNaN(duration) || duration < 1) {
        console.warn(`[Preview] Invalid duration for ${entryId}: ${duration}`);
        return;
      }

      const chunkDurationSec = state.chunkDuration;
      const usableDuration = duration - chunkDurationSec;

      console.log(
        `[Preview:D] Usable duration (minus chunk): ${usableDuration.toFixed(2)}s`,
      );

      if (usableDuration <= 0) {
        console.warn(`[Preview] Video too short for chunks: ${duration}s`);
        state.chunkStarts = [0];
        state.totalChunks = 1;
        return;
      }

      const chunkStarts = [];
      for (let i = 0; i < NUM_PREVIEW_CHUNKS; i++) {
        const start = (i / (NUM_PREVIEW_CHUNKS - 1)) * usableDuration;
        chunkStarts.push(Math.max(0, Math.min(start, usableDuration)));
      }

      state.chunkStarts = chunkStarts;
      state.totalChunks = chunkStarts.length;

      console.log(
        `[Preview] Calculated ${chunkStarts.length} chunks for ${entryId}:`,
        chunkStarts.map((s) => s.toFixed(2)),
      );
      console.log(
        `[Preview:D] Chunk boundaries: [${chunkStarts.map((s) => s.toFixed(2)).join(", ")}]`,
      );
      console.log("[Preview:D] Attempting to cache with key:", {
        validatedCacheKey,
      });

      window.ChunkCache.set(validatedCacheKey, chunkStarts, duration)
        .then(() => {
          console.log("[Preview:D] Successfully cached chunks for key:", {
            validatedCacheKey,
          });
        })
        .catch((err) => {
          console.warn("[Preview] Failed to cache chunks:", err);
        });
    }

    function startContinuousPlayback() {
      if (!state.chunkStarts || state.chunkStarts.length === 0) {
        console.warn(
          `[Preview:D] No chunks available for ${entryId}, aborting playback`,
        );
        return;
      }

      if (state.monitorInterval) {
        clearInterval(state.monitorInterval);
        state.monitorInterval = null;
      }

      state.currentChunk = 0;
      const firstChunkStart = state.chunkStarts[0];

      console.log(
        `[Preview] Starting continuous playback from ${firstChunkStart.toFixed(2)}s for ${entryId}`,
      );
      console.log(
        `[Preview:D] Total chunks: ${state.totalChunks}, starting at chunk 0`,
      );

      previewVideo.currentTime = firstChunkStart;

      const onSeeked = () => {
        previewVideo.removeEventListener("seeked", onSeeked);

        if (!state.isHovering || !state.isRunning) {
          console.log(`[Preview:D] Playback cancelled after seek`);
          return;
        }

        previewVideo
          .play()
          .then(() => {
            console.log(`[Preview] ✅ Playback started for ${entryId}`);
            state.playbackStarted = true;
            startPositionMonitor();
          })
          .catch((err) => {
            console.warn(
              `[Preview] ❌ Play failed for ${entryId}:`,
              err.message,
            );
            if (state.isHovering && state.isRunning) {
              setTimeout(() => startContinuousPlayback(), 500);
            }
          });
      };

      previewVideo.addEventListener("seeked", onSeeked, { once: true });

      // Timeout fallback
      setTimeout(() => {
        if (!state.playbackStarted && state.isHovering && state.isRunning) {
          previewVideo.removeEventListener("seeked", onSeeked);
          console.warn(
            `[Preview] ⚠️ Seek timeout for ${entryId}, forcing playback`,
          );

          previewVideo
            .play()
            .then(() => {
              state.playbackStarted = true;
              startPositionMonitor();
            })
            .catch((err) => {
              if (state.isHovering && state.isRunning) {
                setTimeout(() => startContinuousPlayback(), 500);
              }
            });
        }
      }, 3000);
    }

    function startPositionMonitor() {
      if (state.monitorInterval) {
        clearInterval(state.monitorInterval);
      }

      console.log(`[Preview] Starting position monitor for ${entryId}`);

      state.monitorInterval = setInterval(() => {
        state.debugFrameCount++;

        if (!state.isHovering || !state.isRunning) {
          stopPlayback();
          return;
        }

        if (previewVideo.paused && state.playbackStarted) {
          if (previewVideo.ended) {
            state.currentChunk = 0;
            previewVideo.currentTime = state.chunkStarts[0];
            previewVideo.play().catch(() => {});
            return;
          }

          previewVideo.play().catch(() => {});
          return;
        }

        if (!state.chunkStarts || state.chunkStarts.length === 0) return;

        const currentTime = previewVideo.currentTime;
        const currentChunkStart = state.chunkStarts[state.currentChunk];
        const currentChunkEnd = currentChunkStart + state.chunkDuration;
        const isLastChunk = state.currentChunk === state.totalChunks - 1;
        const videoDuration = previewVideo.duration || Infinity;
        const isNearVideoEnd = currentChunkEnd >= videoDuration - 0.1;

        if (currentTime >= currentChunkEnd || isNearVideoEnd) {
          const nextChunk = (state.currentChunk + 1) % state.chunkStarts.length;
          const nextChunkStart = state.chunkStarts[nextChunk];

          console.log(
            `[Preview] Chunk ${state.currentChunk + 1}→${nextChunk + 1} ` +
              `at ${nextChunkStart.toFixed(2)}s for ${entryId}`,
          );

          state.currentChunk = nextChunk;

          if (nextChunk === 0) {
            previewVideo.pause();
            previewVideo.currentTime = nextChunkStart;

            const onSeekComplete = () => {
              previewVideo.removeEventListener("seeked", onSeekComplete);
              previewVideo.play().catch(() => {});
            };

            previewVideo.addEventListener("seeked", onSeekComplete, {
              once: true,
            });
          } else {
            previewVideo.currentTime = nextChunkStart;
          }
        }
      }, 100);
    }

    function stopPlayback() {
      state.playbackStarted = false;

      if (state.monitorInterval) {
        clearInterval(state.monitorInterval);
        state.monitorInterval = null;
      }

      if (!previewVideo.paused) {
        previewVideo.pause();
      }

      state.currentChunk = 0;
    }

    async function startLoop() {
      if (state.isRunning) return;

      console.log(`[Preview] Starting chunk loop for ${entryId}`);
      state.isRunning = true;
      state.playbackStarted = false;

      previewVideo.dataset.chunkLoopActive = "true";

      await loadChunkPositions();

      if (previewVideo.readyState >= 1 && previewVideo.duration > 0) {
        console.log(
          `[Preview:D] Video ready (readyState: ${previewVideo.readyState}, ` +
            `duration: ${previewVideo.duration.toFixed(1)}s)`,
        );

        setTimeout(() => {
          if (state.isHovering && state.isRunning) startContinuousPlayback();
        }, 150);
      } else {
        console.log(`[Preview] Waiting for metadata for ${entryId}`);

        const onReady = async () => {
          if (state.isHovering && state.isRunning) {
            previewVideo.removeEventListener("loadedmetadata", onReady);
            await loadChunkPositions();
            setTimeout(() => startContinuousPlayback(), 150);
          }
        };

        previewVideo.addEventListener("loadedmetadata", onReady, {
          once: true,
        });

        setTimeout(async () => {
          if (state.isHovering && state.isRunning && !state.playbackStarted) {
            previewVideo.removeEventListener("loadedmetadata", onReady);
            await loadChunkPositions();
            startContinuousPlayback();
          }
        }, 5000);
      }
    }

    function stopLoop() {
      state.isRunning = false;
      state.isHovering = false;
      delete previewVideo.dataset.chunkLoopActive;
      stopPlayback();
    }

    function onMouseEnter() {
      clearTimeout(hoverDebounceTimer);

      if (state.isHovering) {
        clearTimeout(previewVideo._downgradeTimeout);
        return;
      }

      if (!window.__tabIsVisible) {
        console.log(
          `[Preview:D] Tab hidden, ignoring mouseenter for ${entryId}`,
        );
        return;
      }

      hoverDebounceTimer = setTimeout(() => {
        console.log(`[Preview] Mouse entered ${entryId}`);
        state.isHovering = true;

        clearTimeout(previewVideo._downgradeTimeout);

        window.BufferManager.setStrategy(
          previewVideo,
          window.RAM_CONFIG.BUFFER_STRATEGY.ACTIVE,
        );

        if (!state.isRunning) {
          startLoop();
        }
      }, HOVER_DEBOUNCE_MS);
    }

    function onMouseLeave() {
      clearTimeout(hoverDebounceTimer);

      hoverDebounceTimer = setTimeout(() => {
        if (!state.isHovering) return;

        console.log(`[Preview] Mouse left ${entryId}`);
        state.isHovering = false;
        stopLoop();

        clearTimeout(previewVideo._downgradeTimeout);
        previewVideo._downgradeTimeout = setTimeout(() => {
          if (!state.isHovering) {
            const timeSinceLastAccess =
              Date.now() -
              (window.BufferManager.managedVideos.get(previewVideo)
                ?.lastAccess || 0);

            if (timeSinceLastAccess > 30000) {
              window.BufferManager.setStrategy(
                previewVideo,
                window.RAM_CONFIG.BUFFER_STRATEGY.METADATA,
              );
            } else {
              window.BufferManager.setStrategy(
                previewVideo,
                window.RAM_CONFIG.BUFFER_STRATEGY.INITIAL,
              );
            }
          }
        }, 2000);
      }, HOVER_DEBOUNCE_MS);
    }

    // Attach hover listeners
    previewVideo.addEventListener("mouseenter", onMouseEnter);
    previewVideo.addEventListener("mouseleave", onMouseLeave);

    const card = previewVideo.closest(".video-card");
    if (card) {
      card.addEventListener("mouseenter", onMouseEnter);
      card.addEventListener("mouseleave", onMouseLeave);
      console.log(`[Preview] Attached hover listeners to card for ${entryId}`);
    }

    return () => {
      console.log(`[Preview] Cleaning up chunk loop for ${entryId}`);
      clearTimeout(hoverDebounceTimer);
      clearTimeout(previewVideo._downgradeTimeout);
      stopLoop();
      delete previewVideo.dataset.previewLoopReady;
      previewVideo.removeEventListener("mouseenter", onMouseEnter);
      previewVideo.removeEventListener("mouseleave", onMouseLeave);

      if (card) {
        card.removeEventListener("mouseenter", onMouseEnter);
        card.removeEventListener("mouseleave", onMouseLeave);
      }
    };
  }

  /**
   * Create a single preview video element
   */
  function createSinglePreview(originalVideo, entryId) {
    console.log(`[Preview] Creating preview video element for ${entryId}`);

    const rawSrc = originalVideo.currentSrc || originalVideo.src || "";
    const cleanSrc = rawSrc.split("?")[0];

    // Store cache key on the entry if available
    const entry = window.__videosMap?.get(originalVideo);
    if (entry) {
      entry.cacheKeySrc = cleanSrc;
    }

    let videoUrl = rawSrc;
    if (videoUrl) {
      videoUrl += (videoUrl.includes("?") ? "&" : "?") + "preview=1";
    }

    const preview = document.createElement("video");
    preview.src = videoUrl;
    preview.muted = true;
    preview.loop = false;
    preview.playsInline = true;
    preview.preload = "metadata";
    preview.style.width = "100%";
    preview.style.height = "100%";
    preview.style.objectFit = "cover";
    preview.style.borderRadius = "4px";
    preview.style.background = "#1a1a2e";
    preview.style.display = "block";
    preview.style.cursor = "pointer";

    preview.dataset.cacheKeySrc = cleanSrc;
    console.log(
      `[Preview] 🏷️ Stored cacheKeySrc on preview element: ${cleanSrc.substring(0, 40)}...`,
    );

    window.BufferManager.register(preview, entryId);

    let isInitialized = false;

    function initializePreview() {
      if (isInitialized) return;

      console.log(`[Preview] Initializing preview for ${entryId}`);
      isInitialized = true;

      const stopLoop = setupLightChunkPreview(preview, entryId, cleanSrc);
      preview._stopPreviewLoop = stopLoop;

      scheduleSmartBuffering(preview, entryId);

      console.log(
        `[Preview] Preview ready for ${entryId} - hover to play chunks`,
      );
    }

    if (preview.readyState >= 1) {
      initializePreview();
    } else {
      preview.addEventListener("loadedmetadata", initializePreview, {
        once: true,
      });
    }

    return preview;
  }

  /**
   * Schedule smart buffering based on element visibility and tab state
   */
  function scheduleSmartBuffering(previewVideo, entryId) {
    if (!window.__tabIsVisible) {
      window.BufferManager.setStrategy(
        previewVideo,
        window.RAM_CONFIG.BUFFER_STRATEGY.NONE,
      );
      return;
    }

    const card = previewVideo.closest(".video-card");

    if (card && window.BufferManager.isElementInViewport(card)) {
      window.BufferManager.setStrategy(
        previewVideo,
        window.RAM_CONFIG.BUFFER_STRATEGY.INITIAL,
      );
    } else {
      window.BufferManager.setStrategy(
        previewVideo,
        window.RAM_CONFIG.BUFFER_STRATEGY.METADATA,
      );
    }

    // Log buffer stats periodically
    const videoCounter = window.__videoCounter || 0;
    if (videoCounter % 4 === 0) {
      console.log("[BufferMgr] Stats:", window.BufferManager.getStats());
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPORT TO GLOBAL SCOPE
  // ═══════════════════════════════════════════════════════════════

  window.ChunkPreview = {
    setupLightChunkPreview,
    createSinglePreview,
    scheduleSmartBuffering,
    NUM_PREVIEW_CHUNKS,
    CHUNK_PLAY_DURATION_MS,
  };

  console.log("[ChunkPreview] Module loaded successfully ✅");
  console.log("[ChunkPreview] Config:", {
    numPreviewChunks: NUM_PREVIEW_CHUNKS,
    chunkPlayDuration: CHUNK_PLAY_DURATION_MS + "ms",
  });
})();
