// content.js - Core Video Observer orchestrator
// Coordinates all modules: Boost, Cache, Buffer, Preview, Cards, Panel, Overlay, Visibility
(function () {
  "use strict";
  console.log("[Content] Core module loading...");

  // ═══════════════════════════════════════════════════════════════
  // GLOBAL STATE (shared across modules via getters/setters)
  // ═══════════════════════════════════════════════════════════════
  let videos = new Map(); // video element → entry
  let videoCards = new Map(); // video element → card DOM element
  let currentlyPlaying = null; // Global: only one video plays at a time
  let videoCounter = 0;
  let domObserver = null;
  let pollingInterval = null;
  let chatRoot = null;
  let globalResources = {
    observers: [],
    intervals: [],
  };

  // Panel update batching - prevents multiple rapid panel updates
  let panelUpdatePending = false;
  let panelUpdateTimer = null;
  const PANEL_UPDATE_DEBOUNCE = 100; // ms

  // ═══════════════════════════════════════════════════════════════
  // GLOBAL ACCESSORS (for cross-module communication)
  // ═══════════════════════════════════════════════════════════════
  window.__getVideosMap = () => videos;
  window.__getVideoCards = () => videoCards;
  window.__getCurrentlyPlaying = () => currentlyPlaying;
  window.__setCurrentlyPlaying = (val) => {
    currentlyPlaying = val;
  };
  window.__videoCounter = videoCounter;
  window.__getPollingInterval = () => pollingInterval;
  window.__setPollingInterval = (val) => {
    pollingInterval = val;
  };
  window.__getDomObserver = () => domObserver;
  window.__setDomObserver = (val) => {
    domObserver = val;
  };
  window.__getChatRoot = () => chatRoot;
  window.__addGlobalInterval = (interval) => {
    globalResources.intervals.push(interval);
  };
  window.__addGlobalObserver = (observer) => {
    globalResources.observers.push(observer);
  };
  window.__tabIsVisible = !document.hidden;
  window.__observeVideos = observeVideos;
  window.__enforceSinglePlayback = enforceSinglePlayback;
  window.__log = log;
  // Overlay bridge functions (delegated to overlay.js when available)
  window.__showVideoOverlay = showVideoOverlay;
  window.__closeVideoOverlay = closeVideoOverlay;
  window.__isOverlayShowingVideo = isOverlayShowingVideo;
  // Gallery bridge
  window.__openGallery = (entry) => {
    if (typeof window.GalleryModule !== "undefined") {
      window.GalleryModule.open(entry);
    } else {
      console.warn("[Content] Gallery module not loaded");
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // CORE CONSTANTS
  // ═══════════════════════════════════════════════════════════════
  const SELECTOR = ".message-inner video";
  const MAX_GALLERY_ITEMS = 6;

  // ═══════════════════════════════════════════════════════════════
  // SINGLE PLAYBACK CONTROLLER
  // ═══════════════════════════════════════════════════════════════
  function enforceSinglePlayback(videoToPlay) {
    if (currentlyPlaying && currentlyPlaying !== videoToPlay) {
      currentlyPlaying.pause();
      log(
        `Paused previous video to enforce single playback`,
        currentlyPlaying ? currentlyPlaying.dataset.videoObserverId : "",
      );
      if (isOverlayShowingVideo(currentlyPlaying)) {
        closeVideoOverlay();
      }
    }
    currentlyPlaying = videoToPlay;
    const onEnded = () => {
      if (currentlyPlaying === videoToPlay) {
        currentlyPlaying = null;
        closeVideoOverlay();
      }
    };
    videoToPlay.addEventListener("ended", onEnded, { once: true });
    console.log(
      `[Content] Single playback enforced for ${videoToPlay.dataset.videoObserverId}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // LOGGING
  // ═══════════════════════════════════════════════════════════════
  function log(message, data = null) {
    if (window.PanelManager && window.PanelManager.logToPanel) {
      window.PanelManager.logToPanel(message, data);
    } else {
      const ts = new Date().toLocaleTimeString();
      console.log(`[nsfwPH ${ts}] ${message}`, data || "");
    }
  }

  /**
   * Get current video information
   */
  function getVideoInfo(video) {
    return {
      id: video.dataset.videoObserverId || `video-${++videoCounter}`,
      src: video.currentSrc || video.src || "No source",
      currentTime: video.currentTime || 0,
      duration: video.duration || 0,
      paused: video.paused,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // VIDEO TRACKING
  // ═══════════════════════════════════════════════════════════════
  function trackVideo(video) {
    if (video.dataset.videoObserverAttached === "true") return;
    video.dataset.videoObserverAttached = "true";

    if (videos.has(video)) return;

    const id = `video-${++videoCounter}`;
    video.dataset.videoObserverId = id;

    // Update global counter for other modules
    window.__videoCounter = videoCounter;

    const entry = {
      id,
      element: video,
      info: getVideoInfo(video),
      preview: null,
      framesPopulated: false,
      cleanups: [],
      boostCleanup: null,
      cacheKeySrc: null,
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

    // Attach buffer boost
    if (window.BoostEngine) {
      entry.boostCleanup =
        window.BoostEngine.attachBoostToVideo(video) || (() => {});
    }

    // Start preview creation - this returns a preview element
    if (window.ChunkPreview) {
      entry.preview = window.ChunkPreview.createSinglePreview(video, id);
      // ✅ OPTIMIZED: Targeted single-card update — instant visual feedback
      // Only creates/inserts this ONE card instead of rebuilding all cards
      performPanelUpdateNow(id);
    }

    // Track all video events
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
        entry.info = getVideoInfo(video);
      };
      video.addEventListener(ev, handler, { passive: true });
      entry.cleanups.push(() => video.removeEventListener(ev, handler));
    });

    console.log(
      `[Content] Tracked video: ${id} (${events.length} events monitored)`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PANEL UPDATE FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Perform panel update, optionally targeting a single video.
   *
   * With videoId: Creates/updates ONLY the card for that video (O(1) per video).
   *   Used in trackVideo() for instant per-card appearance as each video is detected.
   *
   * Without videoId: Full panel rebuild with cleanup (O(n)).
   *   Used in observeVideos() after batch tracking completes, and on visibility restore.
   *
   * @param {string} [videoId] - Optional. If provided, only update the card for this video.
   */
  function performPanelUpdateNow(videoId) {
    if (!window.CardManager) return;

    if (videoId) {
      // ✅ OPTIMIZED: Targeted single-card update — instant visual feedback
      console.log(`[Content] 🎯 Targeted panel update for ${videoId}`);
      window.CardManager.performSingleCardUpdate(videoId);
    } else {
      // Full panel rebuild (for cleanup, visibility restore, etc.)
      console.log("[Content] 🔄 Full panel update...");
      window.CardManager.performPanelUpdate();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // VIDEO OBSERVATION
  // ═══════════════════════════════════════════════════════════════
  function observeVideos() {
    const foundVideos = document.querySelectorAll(SELECTOR);
    console.log(`[Content] Observing ${foundVideos.length} video elements`);

    // Track all videos — each one performs a targeted single-card update
    foundVideos.forEach(trackVideo);

    // ✅ Run one final full panel update for cleanup:
    //   - Removes cards for detached videos
    //   - Syncs counts
    //   - Updates any cards that may have been missed
    // This is cheap because all cards already exist; it just cleans up stragglers
    performPanelUpdateNow(); // No videoId → full update
    console.log(
      `[Content] 📋 Final full panel sync after observing ${foundVideos.length} videos`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // VIDEO OVERLAY BRIDGE
  // ═══════════════════════════════════════════════════════════════
  function setupVideoOverlay() {
    if (typeof window.VideoOverlay === "undefined") {
      console.warn(
        "[Content] VideoOverlay module not loaded! overlay.js may be missing.",
      );
      return;
    }
    window.VideoOverlay.setup({
      enforceSinglePlayback,
      log,
    });
    console.log("[Content] ✅ VideoOverlay dependencies injected");
  }

  function showVideoOverlay(videoEl, entry) {
    log(`Opening overlay for ${entry.id}`);
    if (typeof window.VideoOverlay !== "undefined") {
      window.VideoOverlay.show(videoEl, entry);
    } else {
      console.error(
        "[Content] VideoOverlay not available — is overlay.js loaded?",
      );
    }
  }

  function closeVideoOverlay() {
    log("Closing overlay");
    if (typeof window.VideoOverlay !== "undefined") {
      window.VideoOverlay.close();
    }
  }

  function isOverlayShowingVideo(videoEl) {
    if (typeof window.VideoOverlay !== "undefined") {
      return window.VideoOverlay.isShowing(videoEl);
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP FUNCTIONS
  // ═══════════════════════════════════════════════════════════════
  /**
   * Clean up runtime resources only - preserves IndexedDB cache
   */
  function cleanupRuntimeResources() {
    console.log("[Content] Cleaning up runtime resources...");

    // Clear pending panel update
    if (panelUpdateTimer) {
      clearTimeout(panelUpdateTimer);
      panelUpdateTimer = null;
    }

    globalResources.observers.forEach((o) => o.disconnect());
    globalResources.observers = [];

    globalResources.intervals.forEach((i) => clearInterval(i));
    globalResources.intervals = [];

    for (const entry of videos.values()) {
      if (entry.boostCleanup) {
        entry.boostCleanup();
        entry.boostCleanup = null;
      }
      if (entry.preview) {
        if (typeof entry.preview._initialBoostCleanup === "function") {
          entry.preview._initialBoostCleanup();
        }
        if (window.BoostEngine) {
          window.BoostEngine.cleanupPreviewBoost(entry.preview);
        }
      }
    }

    // Clear in-memory L1 cache only (IndexedDB L2 is preserved)
    if (window.ChunkCache) {
      window.ChunkCache.memoryCache.clear();
    }

    console.log("[Content] Runtime resources cleaned up ✅");
  }

  /**
   * Full cleanup including IndexedDB - ONLY called on extension unload
   */
  function cleanupAllResources() {
    console.log("[Content] Performing full cleanup...");
    cleanupRuntimeResources();

    // Destroy overlay
    if (typeof window.VideoOverlay !== "undefined") {
      window.VideoOverlay.destroy();
      log("Video overlay destroyed.");
    }

    // Clear chunk cache
    if (window.ChunkCache) {
      window.ChunkCache.clear().catch((err) => {
        console.warn("[Cleanup] Error clearing chunk cache:", err);
      });
    }

    console.log("[Content] Full cleanup complete ✅");
  }

  // ═══════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════
  function waitForBody(callback) {
    if (document.body) {
      console.log("[Content] Body already available, initializing immediately");
      return callback();
    }
    console.log("[Content] Waiting for body element...");
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        console.log("[Content] Body detected, initializing");
        callback();
      }
    });
    observer.observe(document.documentElement, { childList: true });
    setTimeout(() => {
      if (document.body) callback();
    }, 1500);
  }

  function init() {
    if (window.__VIDEO_OBSERVER_INITIALIZED__) {
      console.log("[Content] Already initialized, skipping");
      return;
    }

    window.__VIDEO_OBSERVER_INITIALIZED__ = true;

    cleanupRuntimeResources();
    console.log("[Content] Initializing Video Observer...");

    // Create floating panel
    if (window.PanelManager) {
      window.PanelManager.createFloatingPanel();
      log("Floating panel created.");
    }

    // Setup overlay module
    setupVideoOverlay();
    log("Video overlay module initialized.");

    // Initialize visibility listener
    if (window.VisibilityManager) {
      window.VisibilityManager.initVisibilityListener();
    }

    // Perform initial observation - each video updates panel as tracked
    observeVideos();
    log("Initial video observation performed.");

    // Setup MutationObserver for new videos
    let debounceTimer = null;
    domObserver = new MutationObserver((mutations) => {
      if (!window.__tabIsVisible) return;

      const hasRelevantChange = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (node) =>
            node.nodeType === 1 && !node.closest?.("#video-observer-panel"),
        ),
      );

      if (!hasRelevantChange) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(observeVideos, 600);
      console.log("[Content] DOM mutation detected, scheduling observation");
    });

    chatRoot = document.querySelector(
      ".messages-content, #messages, main, body",
    );

    domObserver.observe(chatRoot || document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });

    globalResources.observers.push(domObserver);

    // Periodic observation
    pollingInterval = setInterval(observeVideos, 30000);
    globalResources.intervals.push(pollingInterval);

    log("Init complete — observer watching chat root for child additions only");

    console.log("[Content] ✅ Full initialization complete");
    console.log("[Content] Active modules:", {
      BoostEngine: !!window.BoostEngine,
      ChunkCache: !!window.ChunkCache,
      BufferManager: !!window.BufferManager,
      ChunkPreview: !!window.ChunkPreview,
      CardManager: !!window.CardManager,
      PanelManager: !!window.PanelManager,
      VisibilityManager: !!window.VisibilityManager,
      VideoOverlay: !!window.VideoOverlay,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP ON UNLOAD
  // ═══════════════════════════════════════════════════════════════
  window.addEventListener("unload", () => {
    console.log("[Content] Page unloading, performing cleanup...");
    cleanupAllResources();
  });

  // ═══════════════════════════════════════════════════════════════
  // STARTUP
  // ═══════════════════════════════════════════════════════════════
  console.log("[Content] Waiting for body to start initialization...");
  waitForBody(init);
  console.log("[Content] Core module loaded ✅");
})();
