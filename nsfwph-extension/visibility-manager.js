// visibility-manager.js - Page Visibility Management
// Handles tab visibility changes to pause/resume all systems

(function () {
  "use strict";

  console.log("[VisibilityManager] Module loading...");

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
   * Restart all preview loops
   */
  function restartAllPreviewLoops() {
    const videos = window.__getVideosMap();
    let restarted = 0;

    for (const entry of videos.values()) {
      if (entry.preview) {
        const cacheKeySrc = entry.cacheKeySrc || "";

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
        window.BoostEngine?.cleanupBoost(entry.element);
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
   * Handle tab becoming visible
   */
  function onTabVisible() {
    window.__tabIsVisible = true;

    console.log("[Visibility] 👁️ Tab visible — resuming everything");

    restartAllPreviewLoops();
    restartAllBoosts();

    // Restore buffers for visible previews
    window.BufferManager.onTabVisible();

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
   * Initialize visibility change listener
   */
  function initVisibilityListener() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        onTabHidden();
      } else {
        onTabVisible();
      }
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
