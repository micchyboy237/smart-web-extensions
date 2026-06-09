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
   * Restart all preview loops after tab becomes visible again.
   * Chunks are already cached on previewVideo._chunkStarts, so no need to reload.
   */
  function restartAllPreviewLoops() {
    const videos = window.__getVideosMap();
    let restarted = 0;

    for (const entry of videos.values()) {
      if (!entry.preview) continue;

      // Clean up existing loop if any (stopAllPreviewLoops already did this,
      // but ensure clean state in case of partial cleanup)
      if (typeof entry.preview._stopPreviewLoop === "function") {
        entry.preview._stopPreviewLoop();
      }
      delete entry.preview.dataset.previewLoopReady;

      // ✅ setupLightChunkPreview only needs previewVideo and entryId
      // Chunks are already on previewVideo._chunkStarts from initial load
      const stopFn = window.ChunkPreview.setupLightChunkPreview(
        entry.preview,
        entry.id,
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

    // ✅ FIX: Only restore METADATA for visible cards to avoid connection pool flood
    // Non-visible cards stay at NONE until scrolled into view
    const videos = window.__getVideosMap();
    const panelEl = document.getElementById("video-observer-panel");
    let restoredCount = 0;

    for (const entry of videos.values()) {
      if (!entry.preview) continue;

      // Check if card is visible in the panel
      const card = entry.preview.closest(".video-card");
      const isCardInPanel = card && panelEl && panelEl.contains(card);

      if (isCardInPanel) {
        // Card is in panel — set to METADATA, CardManager will upgrade to INITIAL
        window.BufferManager.setStrategy(
          entry.preview,
          window.RAM_CONFIG.BUFFER_STRATEGY.METADATA,
        );
        restoredCount++;
      } else {
        // Card not in panel — leave at NONE to avoid wasting connections
        window.BufferManager.setStrategy(
          entry.preview,
          window.RAM_CONFIG.BUFFER_STRATEGY.NONE,
        );
      }
    }

    console.log(
      `[Visibility] Restored METADATA for ${restoredCount}/${videos.size} visible cards ` +
        `(others stay at NONE until scrolled into view)`,
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
