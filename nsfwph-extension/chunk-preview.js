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
  const PREVIEW_INIT_TIMEOUT = 8000; // Max wait for preview init

  /**
   * Calculate evenly distributed chunk start positions across the video.
   */
  function calculateChunkPositions(duration) {
    const chunkDurationSec = CHUNK_PLAY_DURATION_MS / 1000;
    if (!duration || isNaN(duration) || duration < 1) return [0];
    const usableDuration = duration - chunkDurationSec;
    if (usableDuration <= 0) return [0];
    const chunkStarts = [];
    for (let i = 0; i < NUM_PREVIEW_CHUNKS; i++) {
      const start = (i / (NUM_PREVIEW_CHUNKS - 1)) * usableDuration;
      chunkStarts.push(Math.max(0, Math.min(start, usableDuration)));
    }
    return chunkStarts;
  }

  /**
   * Load chunk positions for a preview video directly.
   * Checks L1 memory cache → L2 IndexedDB → Calculates if missing.
   * No batching needed — each call is independent and async.
   */
  async function loadChunksForPreview(previewVideo, entryId, cacheKeySrc) {
    if (!cacheKeySrc || typeof cacheKeySrc !== "string") {
      const rawSrc = previewVideo.currentSrc || previewVideo.src || "";
      cacheKeySrc = rawSrc
        .replace(/([?&])preview=1(&|$)/, "$1")
        .replace(/[?&]$/, "");
      if (!cacheKeySrc) {
        cacheKeySrc = `fallback-${entryId}-${Date.now()}`;
      }
    }

    let chunkStarts = null;
    let duration = previewVideo.duration || 0;

    // Try L1 memory cache first
    if (window.ChunkCache && window.ChunkCache.memoryCache) {
      const memEntry = window.ChunkCache.memoryCache.get(cacheKeySrc);
      if (memEntry && memEntry.chunks && memEntry.chunks.length > 0) {
        console.log(
          `[ChunkLoad] ⚡ L1 MEMORY HIT for ${entryId} (${memEntry.chunks.length} chunks)`,
        );
        chunkStarts = memEntry.chunks;
        duration = memEntry.duration || duration;
      }
    }

    // Try L2 IndexedDB cache
    if (!chunkStarts && window.ChunkCache) {
      try {
        const cached = await window.ChunkCache.get(cacheKeySrc);
        if (cached && cached.chunks && cached.chunks.length > 0) {
          console.log(
            `[ChunkLoad] ✅ CACHE HIT for ${entryId} (${cached.chunks.length} chunks)`,
          );
          chunkStarts = cached.chunks;
          duration = cached.duration || duration;
        }
      } catch (err) {
        console.warn(
          `[ChunkLoad] Cache read failed for ${entryId}:`,
          err.message,
        );
      }
    }

    // Calculate chunks if no cache hit
    if (!chunkStarts) {
      console.log(
        `[ChunkLoad] ❌ CACHE MISS for ${entryId} - calculating chunks`,
      );
      chunkStarts = calculateChunkPositions(duration);
      if (window.ChunkCache && chunkStarts.length > 0) {
        window.ChunkCache.set(cacheKeySrc, chunkStarts, duration).catch(
          (err) => {
            console.warn(
              `[ChunkLoad] Failed to cache chunks for ${entryId}:`,
              err,
            );
          },
        );
      }
    }

    if (chunkStarts && chunkStarts.length > 0) {
      previewVideo._chunkStarts = chunkStarts;
      previewVideo._chunkDuration = duration;
      console.log(
        `[ChunkLoad] ✅ Chunks loaded for ${entryId}: ${chunkStarts.length} chunks, ` +
          `positions: [${chunkStarts.map((s) => s.toFixed(2)).join(", ")}]`,
      );
    } else {
      previewVideo._chunkStarts = [0];
      previewVideo._chunkDuration = duration;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CORE FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  function setupLightChunkPreview(previewVideo, entryId) {
    // ✅ Guard: If already set up, clean up old before re-creating
    if (previewVideo.dataset.previewLoopReady === "true") {
      console.log(
        `[Preview:D] Loop already set up for ${entryId}, cleaning up old before re-creating`,
      );
      // Clean up existing loop state
      if (typeof previewVideo._stopPreviewLoop === "function") {
        previewVideo._stopPreviewLoop();
      }
      delete previewVideo.dataset.previewLoopReady;
      delete previewVideo._chunkStarts;
      delete previewVideo._chunkDuration;
      // Continue to recreate
    }

    previewVideo.dataset.previewLoopReady = "true";
    console.log(`[Preview] Setting up chunk loop for ${entryId}`);

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
      chunksReady: false,
    };

    let hoverDebounceTimer = null;
    const HOVER_DEBOUNCE_MS = 100;

    async function waitForChunks(timeoutMs = 5000) {
      if (
        state.chunksReady &&
        state.chunkStarts &&
        state.chunkStarts.length > 0
      )
        return true;
      if (previewVideo._chunkStarts && previewVideo._chunkStarts.length > 0) {
        state.chunkStarts = previewVideo._chunkStarts;
        state.totalChunks = state.chunkStarts.length;
        state.chunksReady = true;
        return true;
      }
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (previewVideo._chunkStarts && previewVideo._chunkStarts.length > 0) {
          state.chunkStarts = previewVideo._chunkStarts;
          state.totalChunks = state.chunkStarts.length;
          state.chunksReady = true;
          return true;
        }
        if (previewVideo.duration > 0 && !state.chunksReady) {
          state.chunkStarts = calculateChunkPositions(previewVideo.duration);
          state.totalChunks = state.chunkStarts.length;
          state.chunksReady = true;
          return true;
        }
      }
      return false;
    }

    function startContinuousPlayback() {
      if (!state.chunkStarts || state.chunkStarts.length === 0) return;
      if (state.monitorInterval) {
        clearInterval(state.monitorInterval);
        state.monitorInterval = null;
      }
      state.currentChunk = 0;
      const firstChunkStart = state.chunkStarts[0];
      previewVideo.currentTime = firstChunkStart;
      const onSeeked = () => {
        previewVideo.removeEventListener("seeked", onSeeked);
        if (!state.isHovering || !state.isRunning) return;
        previewVideo
          .play()
          .then(() => {
            state.playbackStarted = true;
            startPositionMonitor();
          })
          .catch(() => {
            if (state.isHovering && state.isRunning)
              setTimeout(() => startContinuousPlayback(), 500);
          });
      };
      previewVideo.addEventListener("seeked", onSeeked, { once: true });
      setTimeout(() => {
        if (!state.playbackStarted && state.isHovering && state.isRunning) {
          previewVideo.removeEventListener("seeked", onSeeked);
          previewVideo
            .play()
            .then(() => {
              state.playbackStarted = true;
              startPositionMonitor();
            })
            .catch(() => {});
        }
      }, 3000);
    }

    function startPositionMonitor() {
      if (state.monitorInterval) clearInterval(state.monitorInterval);
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
        if (currentTime >= currentChunkEnd) {
          const nextChunk = (state.currentChunk + 1) % state.chunkStarts.length;
          state.currentChunk = nextChunk;
          previewVideo.currentTime = state.chunkStarts[nextChunk];
        }
      }, 100);
    }

    function stopPlayback() {
      state.playbackStarted = false;
      if (state.monitorInterval) {
        clearInterval(state.monitorInterval);
        state.monitorInterval = null;
      }
      if (!previewVideo.paused) previewVideo.pause();
      state.currentChunk = 0;
    }

    async function startLoop() {
      if (state.isRunning) return;
      state.isRunning = true;
      state.playbackStarted = false;
      previewVideo.dataset.chunkLoopActive = "true";
      const chunksReady = await waitForChunks(5000);
      if (!chunksReady) {
        state.isRunning = false;
        delete previewVideo.dataset.chunkLoopActive;
        return;
      }
      if (!state.isHovering || !state.isRunning) return;
      if (previewVideo.readyState >= 1) {
        setTimeout(() => {
          if (state.isHovering && state.isRunning) startContinuousPlayback();
        }, 150);
      } else {
        const onReady = () => {
          if (state.isHovering && state.isRunning) {
            previewVideo.removeEventListener("loadedmetadata", onReady);
            setTimeout(() => startContinuousPlayback(), 150);
          }
        };
        previewVideo.addEventListener("loadedmetadata", onReady, {
          once: true,
        });
        setTimeout(() => {
          if (state.isHovering && state.isRunning && !state.playbackStarted) {
            previewVideo.removeEventListener("loadedmetadata", onReady);
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
      if (!window.__tabIsVisible) return;
      hoverDebounceTimer = setTimeout(() => {
        state.isHovering = true;
        clearTimeout(previewVideo._downgradeTimeout);
        window.BufferManager.setStrategy(
          previewVideo,
          window.RAM_CONFIG.BUFFER_STRATEGY.ACTIVE,
        );
        if (!state.isRunning) startLoop();
      }, HOVER_DEBOUNCE_MS);
    }

    function onMouseLeave() {
      clearTimeout(hoverDebounceTimer);
      hoverDebounceTimer = setTimeout(() => {
        if (!state.isHovering) return;
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

    previewVideo.addEventListener("mouseenter", onMouseEnter);
    previewVideo.addEventListener("mouseleave", onMouseLeave);
    const card = previewVideo.closest(".video-card");
    if (card) {
      card.addEventListener("mouseenter", onMouseEnter);
      card.addEventListener("mouseleave", onMouseLeave);
      console.log(`[Preview] Attached hover listeners to card for ${entryId}`);
    }

    return () => {
      clearTimeout(hoverDebounceTimer);
      clearTimeout(previewVideo._downgradeTimeout);
      stopLoop();
      delete previewVideo.dataset.previewLoopReady;
      delete previewVideo._chunkStarts;
      delete previewVideo._chunkDuration;
      previewVideo.removeEventListener("mouseenter", onMouseEnter);
      previewVideo.removeEventListener("mouseleave", onMouseLeave);
      if (card) {
        card.removeEventListener("mouseenter", onMouseEnter);
        card.removeEventListener("mouseleave", onMouseLeave);
      }
    };
  }

  /**
   * Create a single preview video element.
   */
  function createSinglePreview(originalVideo, entryId) {
    console.log(`[Preview] Creating preview video element for ${entryId}`);
    const rawSrc = originalVideo.currentSrc || originalVideo.src || "";
    const cleanSrc = rawSrc.split("?")[0];
    const entry = window.__videosMap?.get(originalVideo);
    if (entry) entry.cacheKeySrc = cleanSrc;
    let videoUrl = rawSrc;
    if (videoUrl)
      videoUrl += (videoUrl.includes("?") ? "&" : "?") + "preview=1";
    const preview = document.createElement("video");
    // ✅ Store URL in data attribute instead of setting src immediately
    // This prevents flooding the browser's connection pool (max 6 per domain)
    preview.dataset.previewSrc = videoUrl;
    preview.muted = true;
    preview.loop = false;
    preview.playsInline = true;
    preview.preload = "none"; // Start with none — BufferManager upgrades
    preview.style.width = "100%";
    preview.style.height = "100%";
    preview.style.objectFit = "cover";
    preview.style.borderRadius = "4px";
    preview.style.background = "#1a1a2e";
    preview.style.display = "block";
    preview.style.cursor = "pointer";
    preview.dataset.cacheKeySrc = cleanSrc;
    preview.dataset.previewReady = "false";
    preview.dataset.sourceDeferred = "true"; // Track that src is deferred
    console.log(
      `[Preview] 🏷️ Stored cacheKeySrc on preview element: ${cleanSrc.substring(0, 40)}...`,
    );
    console.log(
      `[Preview] 📦 Src deferred for ${entryId} (avoids connection pool flood)`,
    );
    window.BufferManager.register(preview, entryId);
    let isInitialized = false;

    async function initializePreview() {
      if (isInitialized) {
        console.log(`[Preview:D] Already initialized for ${entryId}, skipping`);
        return;
      }
      console.log(`[Preview] Initializing preview for ${entryId}`);
      isInitialized = true;
      const stopLoop = setupLightChunkPreview(preview, entryId);
      preview._stopPreviewLoop = stopLoop;
      loadChunksForPreview(preview, entryId, cleanSrc);
      if (window.__tabIsVisible) {
        window.BufferManager.setStrategy(
          preview,
          window.RAM_CONFIG.BUFFER_STRATEGY.METADATA,
        );
      } else {
        window.BufferManager.setStrategy(
          preview,
          window.RAM_CONFIG.BUFFER_STRATEGY.NONE,
        );
      }
      preview.dataset.previewReady = "true";
      console.log(
        `[Preview] ✅ Preview ready for ${entryId} - hover to play chunks`,
      );
      const card = preview.closest(".video-card");
      if (card) {
        card.classList.remove("preview-loading");
        console.log(
          `[CardManager] ✅ Preview ready for ${entryId}, removed loading state`,
        );
      }
    }

    if (preview.readyState >= 1) {
      initializePreview();
    } else {
      preview.addEventListener("loadedmetadata", initializePreview, {
        once: true,
      });
      setTimeout(() => {
        if (!isInitialized && document.body.contains(preview)) {
          console.warn(
            `[Preview] ⚠️ Metadata timeout for ${entryId}, initializing anyway`,
          );
          initializePreview();
        }
      }, PREVIEW_INIT_TIMEOUT);
    }

    return preview;
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPORT TO GLOBAL SCOPE
  // ═══════════════════════════════════════════════════════════════
  window.ChunkPreview = {
    setupLightChunkPreview,
    createSinglePreview,
    loadChunksForPreview,
    NUM_PREVIEW_CHUNKS,
    CHUNK_PLAY_DURATION_MS,
  };

  console.log("[ChunkPreview] Module loaded successfully ✅");
  console.log("[ChunkPreview] Config:", {
    numPreviewChunks: NUM_PREVIEW_CHUNKS,
    chunkPlayDuration: CHUNK_PLAY_DURATION_MS + "ms",
    chunkLoading: "✅ Direct (no batch queue)",
  });
})();
