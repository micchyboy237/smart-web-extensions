// visibility-manager.js - Page Visibility Management
// Handles tab visibility changes to pause/resume all systems

(function () {
  "use strict";

  console.log("[VisibilityManager] Module loading...");

  // Debounce to prevent rapid hide/show cycles
  let _visibilityDebounceTimer = null;
  const VISIBILITY_DEBOUNCE_MS = 500;

  /**
   * Stop all active preview loops
   */
  function stopAllPreviewLoops() {
    const videos = window.__getVideosMap();

    for (const entry of videos.values()) {
      if (
        entry.preview &&
        typeof entry.preview._stopPreviewLoop === "function"
      ) {
        entry.preview._stopPreviewLoop();
        delete entry.preview.dataset.previewLoopReady;
        console.log(`[Visibility] Stopped preview loop for ${entry.id}`);
      }
    }

    console.log("[Visibility] All preview loops stopped");
  }

  /**
   * Restart all preview loops.
   * Uses cacheKeySrc from the preview element's dataset (not entry, which gets cleaned up).
   */
  function restartAllPreviewLoops() {
    const videos = window.__getVideosMap();
    let restarted = 0;

    for (const entry of videos.values()) {
      if (!entry.preview) continue;

      // Get cacheKeySrc from the preview element's dataset (persistent)
      // Fallback: derive from the entry if available
      const cacheKeySrc =
        entry.preview.dataset.cacheKeySrc || entry.cacheKeySrc || "";

      if (!cacheKeySrc) {
        console.warn(
          `[Visibility] No cacheKeySrc for ${entry.id}, cannot restart loop`,
        );
        continue;
      }

      // Clean up existing loop if any
      if (typeof entry.preview._stopPreviewLoop === "function") {
        entry.preview._stopPreviewLoop();
      }

      delete entry.preview.dataset.previewLoopReady;

      const stopFn = window.ChunkPreview.setupLightChunkPreview(
        entry.preview,
        entry.id,
        cacheKeySrc,
      );

      entry.preview._stopPreviewLoop = stopFn;
      restarted++;
    }

    console.log(`[Visibility] Restarted ${restarted} preview loops`);
  }

  /**
   * Stop all buffer boosts
   */
  function stopAllBoosts() {
    const videos = window.__getVideosMap();

    for (const entry of videos.values()) {
      if (entry.boostCleanup) {
        entry.boostCleanup();
        entry.boostCleanup = null;
      }

      if (entry.preview) {
        window.BoostEngine?.cleanupPreviewBoost(entry.preview);
      }
    }

    console.log("[Visibility] All boosts stopped");
  }

  /**
   * Restart all buffer boosts
   */
  function restartAllBoosts() {
    const videos = window.__getVideosMap();
    let restarted = 0;

    for (const entry of videos.values()) {
      if (entry.element && !entry.element.dataset.boostAttached) {
        entry.boostCleanup =
          window.BoostEngine?.attachBoostToVideo(entry.element) || (() => {});
        restarted++;
      }
    }

    console.log(`[Visibility] Restarted ${restarted} boosts`);
  }

  /**
   * Handle tab becoming hidden
   */
  function onTabHidden() {
    window.__tabIsVisible = false;

    console.log("[Visibility] 👁️ Tab hidden — pausing everything");

    stopAllPreviewLoops();
    stopAllBoosts();

    // Release all video buffers
    window.BufferManager.onTabHidden();

    // Pause currently playing video
    const currentlyPlaying = window.__getCurrentlyPlaying();
    if (currentlyPlaying) {
      currentlyPlaying.pause();
      window.__setCurrentlyPlaying(null);
    }

    // Clear polling interval
    const pollingInterval = window.__getPollingInterval();
    if (pollingInterval !== null) {
      clearInterval(pollingInterval);
      window.__setPollingInterval(null);
      console.log("[Visibility] Polling interval cleared");
    }

    // Disconnect DOM observer
    const domObserver = window.__getDomObserver();
    if (domObserver) {
      domObserver.disconnect();
      console.log("[Visibility] DOM observer disconnected");
    }

    window.__log("Tab hidden — pausing everything");
  }

  /**
   * Handle tab becoming visible.
   * Restores preview loops and buffers without flooding INITIAL for all videos.
   */
  function onTabVisible() {
    window.__tabIsVisible = true;

    console.log("[Visibility] 👁️ Tab visible — resuming everything");

    restartAllPreviewLoops();
    restartAllBoosts();

    // Restore buffers - but ONLY for visible cards, not all videos
    // The CardManager's IntersectionObserver will handle upgrading visible cards to INITIAL
    // So we just set all to METADATA and let the observer do its job
    const videos = window.__getVideosMap();
    for (const entry of videos.values()) {
      if (entry.preview) {
        // Only set to METADATA - CardManager will upgrade to INITIAL for visible cards
        window.BufferManager.setStrategy(
          entry.preview,
          window.RAM_CONFIG.BUFFER_STRATEGY.METADATA,
        );
      }
    }
    console.log(
      `[Visibility] Set all previews to METADATA, CardManager will upgrade visible ones`,
    );

    // Restart polling interval
    if (window.__getPollingInterval() === null) {
      const newInterval = setInterval(window.__observeVideos, 30000);
      window.__setPollingInterval(newInterval);
      window.__addGlobalInterval(newInterval);
      console.log("[Visibility] Polling interval restarted");
    }

    // Reconnect DOM observer
    const domObserver = window.__getDomObserver();
    const chatRoot = window.__getChatRoot();

    if (domObserver) {
      domObserver.observe(chatRoot || document.body, {
        childList: true,
        subtree: true,
        attributes: false,
        characterData: false,
      });
      console.log("[Visibility] DOM observer reconnected");
    }

    // Perform immediate observation
    window.__observeVideos();

    window.__log("Tab visible — resuming everything");
  }

  /**
   * Initialize visibility change listener with debouncing
   */
  function initVisibilityListener() {
    document.addEventListener("visibilitychange", () => {
      // Debounce to prevent rapid hide/show cycles
      if (_visibilityDebounceTimer) {
        clearTimeout(_visibilityDebounceTimer);
      }

      _visibilityDebounceTimer = setTimeout(() => {
        _visibilityDebounceTimer = null;
        if (document.hidden) {
          onTabHidden();
        } else {
          onTabVisible();
        }
      }, VISIBILITY_DEBOUNCE_MS);
    });

    console.log("[Visibility] Visibility change listener initialized ✅");

    // Set initial tab visibility state
    window.__tabIsVisible = !document.hidden;
    console.log(
      `[Visibility] Initial tab state: ${window.__tabIsVisible ? "visible" : "hidden"}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPORT TO GLOBAL SCOPE
  // ═══════════════════════════════════════════════════════════════

  window.VisibilityManager = {
    initVisibilityListener,
    onTabHidden,
    onTabVisible,
    stopAllPreviewLoops,
    restartAllPreviewLoops,
    stopAllBoosts,
    restartAllBoosts,
  };

  console.log("[VisibilityManager] Module loaded successfully ✅");
})();
