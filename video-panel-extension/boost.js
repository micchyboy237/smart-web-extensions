// boost.js - Forward Buffer Boost Engine (v2.9 - ACTIVE VIDEO PRIORITY)
// Standalone module for smart buffer management
// Features: Silent preload seeks + Active video priority for bandwidth optimization
// ═══════════════════════════════════════════════════════════════
// Prevent double initialization
if (window.__BOOST_ENGINE_INITIALIZED__) {
  console.warn("[Boost] Engine already initialized, skipping");
} else {
  window.__BOOST_ENGINE_INITIALIZED__ = true;
  // ═══════════════════════════════════════════════════════════════
  // BOOST CONFIGURATION - SILENT PRELOAD SEEK + PRIORITY
  // ═══════════════════════════════════════════════════════════════
  const BOOST_CONFIG = {
    // BUFFER ZONES (forward buffer in seconds)
    MIN_FORWARD_BUFFER: 5,
    BUFFER_CRITICAL: 5,
    BUFFER_LOW: 8,
    BUFFER_COMFORT: 15,
    BUFFER_TARGET: 20,
    // Silent Preload Seek settings
    PRELOAD_ENABLED: true,
    PRELOAD_SYNC_INTERVAL: 2000,
    PRELOAD_ADVANCE_SEEK: 20,
    PRELOAD_MAX_AHEAD: 60,
    PRELOAD_STOP_AT_BUFFER: 20,
    PRELOAD_SNAP_BACK_MS: 50,
    PRELOAD_MIN_INTERVAL: 3000,
    PRELOAD_MIN_ADVANCE: 5,
    PRELOAD_GRACE_PERIOD_MS: 3000,
    PRELOAD_FIRST_BUFFER_GRACE: 8,
    // 🔧 NEW: Active Video Priority
    PRIORITY_ENABLED: true,
    PRIORITY_CHECK_INTERVAL: 1000, // Check active video status every 1s
    PRIORITY_BACKGROUND_PRELOAD: "none", // "none", "metadata", or "auto" for non-active videos
    // Boost rates (kept for logging, NOT applied to playbackRate)
    BOOST_RATE_AGGRESSIVE: 1.3,
    BOOST_RATE_NORMAL: 1.2,
    BOOST_RATE_GENTLE: 1.12,
    BOOST_RATE_MAINTENANCE: 1.08,
    BOOST_RATE_SEEK: 1.35,
    // Boost timing
    BOOST_DURATION: 30000,
    MONITOR_INTERVAL: 1500,
    BOOST_SESSION_GAP: 3000,
    // Safety limits
    MAX_BOOST_SESSIONS: 25,
    MAX_TOTAL_BOOST_MS: 180000,
    // Connection quality detection
    SLOW_CONNECTION_THRESHOLD: 0.3,
    CONNECTION_CHECK_WINDOW: 4000,
    // Smart detection
    MIN_PLAY_TIME_FOR_BOOST: 1000,
    SHRINK_TOLERANCE: 4,
    // Maintenance mode
    MAINTENANCE_MAX_DURATION: 90000,
    MAINTENANCE_RESTART_DELAY: 10000,
    // Seek handling
    SEEK_DEBOUNCE_MS: 800,
    // DEBUG
    DEBUG_VERBOSE: true,
    DEBUG_PRELOAD: true,
    DEBUG_PRIORITY: true, // 🔧 NEW: Priority debug logging
  };
  // ═══════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════
  function getBufferAhead(video) {
    if (!video || !video.buffered || !video.buffered.length) return 0;
    let maxEnd = 0;
    const currentTime = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (currentTime >= start && currentTime <= end) {
        maxEnd = Math.max(maxEnd, end);
      }
    }
    return Math.max(0, maxEnd - currentTime);
  }
  function getTotalBufferedRange(video) {
    if (!video || !video.buffered || !video.buffered.length)
      return { start: 0, end: 0 };
    let minStart = Infinity;
    let maxEnd = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      minStart = Math.min(minStart, video.buffered.start(i));
      maxEnd = Math.max(maxEnd, video.buffered.end(i));
    }
    return { start: minStart === Infinity ? 0 : minStart, end: maxEnd };
  }
  // ═══════════════════════════════════════════════════════════════
  // ACTIVE VIDEO PRIORITY MANAGER (NEW)
  // ═══════════════════════════════════════════════════════════════
  /**
   * Priority Manager ensures the actively-playing video gets all the bandwidth.
   *
   * STRATEGY:
   * ┌─────────────────────────────────────────────────────────────┐
   * │                                                              │
   * │  Active Video (overlay open + playing):                      │
   * │    ✅ preload="auto"                                         │
   * │    ✅ Silent preload seeks enabled                           │
   │    ✅ Full buffer target: 20s                                 │
   │    ✅ Monitor running                                         │
   │                                                              │
   │  Background Videos (not active):                              │
   │    ❌ preload="none" (stops all downloading)                  │
   │    ❌ Silent preload seeks disabled                           │
   │    ❌ Monitor paused                                          │
   │    💾 Metadata only (saves bandwidth)                         │
   │                                                              │
   │  When active video ends/is closed:                            │
   │    🔄 Restore all background videos to "metadata"             │
   │    (They'll get preload="auto" when they become active)       │
   │                                                              │
   └─────────────────────────────────────────────────────────────┘
   */
  const PriorityManager = {
    /** @type {HTMLVideoElement|null} */
    _activeVideo: null,
    /** @type {Set<Object>} All registered preload managers */
    _registeredManagers: new Set(),
    /** @type {number|null} Priority check interval */
    _checkInterval: null,
    /** @type {boolean} Is the priority system active */
    _isActive: false,
    /**
     * Register a preload manager so the priority system can control it.
     * @param {Object} manager - The preload manager object
     * @param {HTMLVideoElement} video - The video element
     */
    register(manager, video) {
      const entry = { manager, video, originalPreload: video.preload };
      this._registeredManagers.add(entry);

      if (BOOST_CONFIG.DEBUG_PRIORITY) {
        const id = video.dataset.videoObserverId || "unknown";
        console.log(
          `[Priority] 📋 Registered ${id} (preload="${video.preload}")`,
        );
      }

      // If there's already an active video, immediately deprioritize this one
      if (this._activeVideo && video !== this._activeVideo) {
        this._deprioritizeVideo(entry);
      }

      return entry;
    },
    /**
     * Unregister a preload manager when a video is cleaned up.
     * @param {Object} manager - The preload manager to unregister
     */
    unregister(manager) {
      for (const entry of this._registeredManagers) {
        if (entry.manager === manager) {
          const id = entry.video.dataset.videoObserverId || "unknown";

          // Restore original preload before removing
          entry.video.preload = entry.originalPreload || "metadata";

          this._registeredManagers.delete(entry);

          if (BOOST_CONFIG.DEBUG_PRIORITY) {
            console.log(`[Priority] 🗑️ Unregistered ${id}`);
          }
          break;
        }
      }
    },
    /**
     * Set the active video that should get priority bandwidth.
     * Call this when:
     *   - User opens overlay and starts playing
     *   - User clicks play on a video in the panel
     *
     * @param {HTMLVideoElement} video - The video to prioritize
     */
    setActiveVideo(video) {
      if (!BOOST_CONFIG.PRIORITY_ENABLED) return;

      // If same video, nothing to do
      if (this._activeVideo === video) return;

      const newId = video?.dataset.videoObserverId || "unknown";
      const oldId = this._activeVideo?.dataset.videoObserverId || "none";

      if (BOOST_CONFIG.DEBUG_PRIORITY) {
        console.log(`[Priority] 🎯 Setting active video: ${oldId} → ${newId}`);
      }

      // Deprioritize old active video
      if (this._activeVideo) {
        this._deprioritizeVideoForElement(this._activeVideo);
      }

      // Set new active video
      this._activeVideo = video;

      // Prioritize new active video
      if (video) {
        this._prioritizeVideoForElement(video);
      }

      // Deprioritize all other registered videos
      this._deprioritizeAllOthers();

      // Start priority check loop if not running
      this._startCheckLoop();
    },
    /**
     * Clear the active video (called when overlay closes or video ends).
     * Restores all videos to normal metadata preloading.
     */
    clearActiveVideo() {
      if (!this._activeVideo) return;

      const oldId = this._activeVideo.dataset.videoObserverId || "unknown";

      if (BOOST_CONFIG.DEBUG_PRIORITY) {
        console.log(`[Priority] 🏁 Clearing active video: ${oldId}`);
      }

      // Restore previous active to metadata
      this._deprioritizeVideoForElement(this._activeVideo);
      this._activeVideo = null;

      // Restore all background videos to metadata (so previews can load on hover)
      this._restoreAllToMetadata();

      // Stop priority check loop
      this._stopCheckLoop();
    },
    /**
     * Check if a video is the active priority video.
     * @param {HTMLVideoElement} video
     * @returns {boolean}
     */
    isActiveVideo(video) {
      return this._activeVideo === video;
    },
    /**
     * Get the current active video.
     * @returns {HTMLVideoElement|null}
     */
    getActiveVideo() {
      return this._activeVideo;
    },
    /**
     * Prioritize a specific video element (preload="auto", enable seeks).
     * @private
     */
    _prioritizeVideoForElement(video) {
      const entry = this._findEntry(video);
      if (!entry) return;

      const id = video.dataset.videoObserverId || "unknown";
      const wasPreload = video.preload;

      // Set aggressive preloading
      video.preload = "auto";

      if (BOOST_CONFIG.DEBUG_PRIORITY) {
        console.log(
          `[Priority] ⬆️ PRIORITIZED ${id} | preload: "${wasPreload}" → "auto"`,
        );
      }
    },
    /**
     * Deprioritize a specific video element (preload="none", pause seeks).
     * @private
     */
    _deprioritizeVideoForElement(video) {
      const entry = this._findEntry(video);
      if (!entry) return;

      this._deprioritizeVideo(entry);
    },
    /**
     * Deprioritize a registered entry.
     * @private
     */
    _deprioritizeVideo(entry) {
      const id = entry.video.dataset.videoObserverId || "unknown";
      const wasPreload = entry.video.preload;

      // Stop all downloading for non-active videos
      entry.video.preload = BOOST_CONFIG.PRIORITY_BACKGROUND_PRELOAD;

      if (
        BOOST_CONFIG.DEBUG_PRIORITY &&
        wasPreload !== BOOST_CONFIG.PRIORITY_BACKGROUND_PRELOAD
      ) {
        console.log(
          `[Priority] ⬇️ DEPRIORITIZED ${id} | preload: "${wasPreload}" → "${BOOST_CONFIG.PRIORITY_BACKGROUND_PRELOAD}"`,
        );
      }
    },
    /**
     * Deprioritize all registered videos except the active one.
     * @private
     */
    _deprioritizeAllOthers() {
      let count = 0;
      for (const entry of this._registeredManagers) {
        if (entry.video !== this._activeVideo) {
          this._deprioritizeVideo(entry);
          count++;
        }
      }
      if (count > 0 && BOOST_CONFIG.DEBUG_PRIORITY) {
        console.log(`[Priority] 🔇 Deprioritized ${count} background video(s)`);
      }
    },
    /**
     * Restore all registered videos to "metadata" preload.
     * Called when active video is cleared.
     * @private
     */
    _restoreAllToMetadata() {
      let count = 0;
      for (const entry of this._registeredManagers) {
        if (entry.video.preload === BOOST_CONFIG.PRIORITY_BACKGROUND_PRELOAD) {
          entry.video.preload = "metadata";
          count++;
        }
      }
      if (count > 0 && BOOST_CONFIG.DEBUG_PRIORITY) {
        console.log(
          `[Priority] 🔄 Restored ${count} video(s) to "metadata" preload`,
        );
      }
    },
    /**
     * Find the registered entry for a video element.
     * @private
     */
    _findEntry(video) {
      for (const entry of this._registeredManagers) {
        if (entry.video === video) return entry;
      }
      return null;
    },
    /**
     * Start the periodic check loop to ensure priority is maintained.
     * This handles edge cases where videos change preload on their own.
     * @private
     */
    _startCheckLoop() {
      if (this._checkInterval) return;

      this._checkInterval = setInterval(() => {
        if (!this._activeVideo) {
          this._stopCheckLoop();
          return;
        }

        // Verify active video still has preload="auto"
        if (this._activeVideo.preload !== "auto") {
          if (BOOST_CONFIG.DEBUG_PRIORITY) {
            console.warn(
              `[Priority] ⚠️ Active video preload changed to "${this._activeVideo.preload}", restoring "auto"`,
            );
          }
          this._activeVideo.preload = "auto";
        }

        // Check if active video has been removed from DOM
        if (!document.body.contains(this._activeVideo)) {
          if (BOOST_CONFIG.DEBUG_PRIORITY) {
            console.log(
              `[Priority] 🗑️ Active video removed from DOM, clearing`,
            );
          }
          this.clearActiveVideo();
          return;
        }

        // Check if active video ended
        if (this._activeVideo.ended) {
          if (BOOST_CONFIG.DEBUG_PRIORITY) {
            console.log(`[Priority] 🏁 Active video ended, clearing`);
          }
          this.clearActiveVideo();
          return;
        }

        // Verify no other video is trying to preload
        for (const entry of this._registeredManagers) {
          if (
            entry.video !== this._activeVideo &&
            entry.video.preload === "auto" &&
            document.body.contains(entry.video)
          ) {
            if (BOOST_CONFIG.DEBUG_PRIORITY) {
              const id = entry.video.dataset.videoObserverId || "unknown";
              console.warn(
                `[Priority] ⚠️ Background video ${id} has preload="auto", fixing`,
              );
            }
            this._deprioritizeVideo(entry);
          }
        }
      }, BOOST_CONFIG.PRIORITY_CHECK_INTERVAL);

      if (BOOST_CONFIG.DEBUG_PRIORITY) {
        console.log(
          `[Priority] 🔍 Check loop started (every ${BOOST_CONFIG.PRIORITY_CHECK_INTERVAL}ms)`,
        );
      }
    },
    /**
     * Stop the periodic check loop.
     * @private
     */
    _stopCheckLoop() {
      if (this._checkInterval) {
        clearInterval(this._checkInterval);
        this._checkInterval = null;
        if (BOOST_CONFIG.DEBUG_PRIORITY) {
          console.log(`[Priority] 🔍 Check loop stopped`);
        }
      }
    },
    /** @type {Set<HTMLVideoElement>} Videos currently prioritized for gallery */
    _galleryVideos: new Set(),
    /** @type {Set<HTMLVideoElement>} Videos currently prioritized for gallery */
    _galleryVideos: new Set(),
    /** @type {Set<HTMLVideoElement>} Videos currently prioritized for overlay previews */
    _overlayPreviews: new Set(),
    /**
     * Internal helper to apply priority to a batch of videos.
     * @private
     */
    _applyBatchPriority(videos, targetSet, label) {
      if (!BOOST_CONFIG.PRIORITY_ENABLED) {
        console.log(
          `[Priority] ⚠️ Priority disabled, skipping ${label} priority`,
        );
        return;
      }

      console.log(
        `[Priority] 🖼️ Setting ${label} priority for ${videos.length} videos`,
      );

      // Deprioritize the main active video if it exists
      if (this._activeVideo) {
        this._deprioritizeVideoForElement(this._activeVideo);
        console.log(
          `[Priority] ⏸️ Temporarily suspended main active video for ${label}`,
        );
      }

      // Deprioritize all other registered background videos
      for (const entry of this._registeredManagers) {
        if (!videos.includes(entry.video)) {
          this._deprioritizeVideo(entry);
        }
      }

      // Prioritize batch videos
      targetSet.clear();
      videos.forEach((video) => {
        targetSet.add(video);
        video.preload = "auto"; // Force download for batch items
        if (BOOST_CONFIG.DEBUG_PRIORITY) {
          console.log(
            `[Priority] ⬆️ ${label.toUpperCase()} PRIORITIZED | preload → "auto"`,
          );
        }
      });
    },
    /**
     * Internal helper to clear batch priority and clean up RAM.
     * @private
     */
    _clearBatchPriority(targetSet, label) {
      if (targetSet.size === 0) return;

      console.log(
        `[Priority] 🖼️ Clearing ${label} priority and cleaning up ${targetSet.size} videos`,
      );

      // Proper cleanup for each batch video to free RAM
      targetSet.forEach((video) => {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load(); // Force release of decoded frames
          if (BOOST_CONFIG.DEBUG_PRIORITY) {
            console.log(`[Priority] 🗑️ Cleaned up ${label} video`);
          }
        } catch (err) {
          console.warn(`[Priority] Error cleaning up ${label} video:`, err);
        }
      });
      targetSet.clear();

      // Restore main active video if it still exists and is in DOM
      if (this._activeVideo && document.body.contains(this._activeVideo)) {
        this._prioritizeVideoForElement(this._activeVideo);
        console.log(
          `[Priority] 🔄 Restored main active video priority after ${label}`,
        );
      }

      // Restore all other background videos to metadata
      this._restoreAllToMetadata();
    },
    /**
     * Prioritize a set of gallery videos for downloading.
     */
    setGalleryPriority(videos) {
      this._applyBatchPriority(videos, this._galleryVideos, "Gallery");
    },
    /**
     * Clear gallery priority and perform proper cleanup.
     */
    clearGalleryPriority() {
      this._clearBatchPriority(this._galleryVideos, "Gallery");
    },
    /**
     * Prioritize a set of overlay preview videos for downloading.
     */
    setOverlayPreviewsPriority(videos) {
      this._applyBatchPriority(
        videos,
        this._overlayPreviews,
        "OverlayPreviews",
      );
    },
    /**
     * Clear overlay previews priority and perform proper cleanup.
     */
    clearOverlayPreviewsPriority() {
      this._clearBatchPriority(this._overlayPreviews, "OverlayPreviews");
    },
    /**
     * Get priority stats for debugging.
     */
    getStats() {
      return {
        activeVideo: this._activeVideo?.dataset.videoObserverId || null,
        registeredCount: this._registeredManagers.size,
        priorityEnabled: BOOST_CONFIG.PRIORITY_ENABLED,
        backgroundPreload: BOOST_CONFIG.PRIORITY_BACKGROUND_PRELOAD,
      };
    },
    /**
     * Cleanup everything.
     */
    cleanup() {
      this._stopCheckLoop();
      this._restoreAllToMetadata();
      this._registeredManagers.clear();
      this._activeVideo = null;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // SILENT PRELOAD SEEK MANAGER (v2.9 - Priority aware)
  // ═══════════════════════════════════════════════════════════════
  function createSilentPreloadManager(originalVideo) {
    if (!BOOST_CONFIG.PRELOAD_ENABLED) {
      console.log("[Preload] ⏭️ Disabled in config, skipping");
      return { cleanup: () => {}, getStats: () => ({}) };
    }
    const videoId = originalVideo.dataset.videoObserverId || "unknown";
    const videoSrc = originalVideo.currentSrc || originalVideo.src;
    if (!videoSrc) {
      console.warn(`[Preload] ❌ No source for ${videoId}`);
      return { cleanup: () => {}, getStats: () => ({}) };
    }
    console.log(`[Preload] 🎬 Silent preload manager for ${videoId}`);
    console.log(`[Preload:D] Source: ${videoSrc.substring(0, 80)}...`);

    // ═══════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════
    let stats = {
      preloadSeeks: 0,
      successfulSeeks: 0,
      failedSeeks: 0,
      lastPreloadSeek: 0,
      lastSnapBack: 0,
      lastLogTime: Date.now(),
      isSnappingBack: false,
      userCurrentTime: 0,
      seekTargetTime: 0,
      playStartTime: 0,
      gracePeriodActive: false,
      maxBufferSeen: 0,
      wasPlayingBeforePreload: false,
      isPrioritized: false, // 🔧 NEW: Track priority status
    };
    let seekSnapBackTimer = null;
    let seekTimeoutTimer = null;
    let gracePeriodTimer = null;

    // Store original preload value to restore on cleanup
    const originalPreload = originalVideo.preload;

    // 🔧 NEW: Register with Priority Manager (but don't set preload="auto" yet)
    const priorityEntry = PriorityManager.register(
      {
        cleanup: () => {},
        getStats: () => stats,
        triggerSilentPreload: () => {},
      },
      originalVideo,
    );
    // Update the entry with the real manager reference after we create it

    // ═══════════════════════════════════════════════════════════
    // GRACE PERIOD - Prevent preload right after play
    // ═══════════════════════════════════════════════════════════
    const onPlayHandler = () => {
      stats.playStartTime = Date.now();
      stats.gracePeriodActive = true;
      stats.maxBufferSeen = 0;

      if (gracePeriodTimer) clearTimeout(gracePeriodTimer);

      gracePeriodTimer = setTimeout(() => {
        stats.gracePeriodActive = false;
        const buffer = getBufferAhead(originalVideo);
        stats.maxBufferSeen = Math.max(stats.maxBufferSeen, buffer);

        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] 🟢 Grace period ended for ${videoId} | ` +
              `Buffer: ${buffer.toFixed(1)}s | Max seen: ${stats.maxBufferSeen.toFixed(1)}s | ` +
              `Play time: ${((Date.now() - stats.playStartTime) / 1000).toFixed(1)}s`,
          );
        }
        gracePeriodTimer = null;
      }, BOOST_CONFIG.PRELOAD_GRACE_PERIOD_MS);

      if (BOOST_CONFIG.DEBUG_PRELOAD) {
        console.log(
          `[Preload] 🛡️ Grace period started for ${videoId} ` +
            `(${BOOST_CONFIG.PRELOAD_GRACE_PERIOD_MS / 1000}s) - ` +
            `no preload seeks during this time`,
        );
      }

      // 🔧 NEW: Notify Priority Manager this video is now playing
      // Only set as active if the overlay is showing this video
      if (originalVideo.closest("#vo-overlay")) {
        PriorityManager.setActiveVideo(originalVideo);
        stats.isPrioritized = true;
      }
    };

    const onPauseHandler = () => {
      // Don't end grace period on pause
    };

    // 🔧 NEW: Listen for overlay open/close to manage priority
    const onOverlayOpen = () => {
      // This video was moved to the overlay - it should get priority
      if (!originalVideo.paused) {
        PriorityManager.setActiveVideo(originalVideo);
        stats.isPrioritized = true;
      }
    };

    const onOverlayClose = () => {
      // Video was removed from overlay - clear priority
      if (PriorityManager.isActiveVideo(originalVideo)) {
        PriorityManager.clearActiveVideo();
        stats.isPrioritized = false;
      }
    };

    originalVideo.addEventListener("play", onPlayHandler);
    originalVideo.addEventListener("pause", onPauseHandler);

    // 🔧 NEW: Use MutationObserver to detect when video enters/leaves overlay
    const overlayObserver = new MutationObserver(() => {
      const isInOverlay = !!originalVideo.closest("#vo-overlay");
      if (isInOverlay && !stats.isPrioritized && !originalVideo.paused) {
        onOverlayOpen();
      } else if (!isInOverlay && stats.isPrioritized) {
        onOverlayClose();
      }
    });

    // Observe the video's parent changes
    const observeParent = () => {
      if (originalVideo.parentElement) {
        overlayObserver.observe(originalVideo.parentElement, {
          childList: true,
        });
      }
    };
    observeParent();
    // Re-observe when parent changes (video moved to overlay)
    const parentObserver = new MutationObserver(() => {
      overlayObserver.disconnect();
      observeParent();
    });
    if (originalVideo.parentElement) {
      parentObserver.observe(
        originalVideo.parentElement.parentElement || document.body,
        { childList: true, subtree: true },
      );
    }

    // ═══════════════════════════════════════════════════════════
    // SAFETY: Intercept user-initiated seeks
    // ═══════════════════════════════════════════════════════════
    let userInitiatedSeek = false;
    let userSeekTimeout = null;
    const onUserSeeking = () => {
      if (stats.isSnappingBack) return;
      userInitiatedSeek = true;
      clearTimeout(userSeekTimeout);
      userSeekTimeout = setTimeout(() => {
        userInitiatedSeek = false;
      }, 1000);
    };
    const onUserSeeked = () => {
      if (stats.isSnappingBack) return;
      if (BOOST_CONFIG.DEBUG_PRELOAD) {
        console.log(
          `[Preload] 👤 User seeked to ${originalVideo.currentTime.toFixed(1)}s`,
        );
      }
      stats.gracePeriodActive = true;
      stats.playStartTime = Date.now();
      stats.maxBufferSeen = 0;
      if (gracePeriodTimer) clearTimeout(gracePeriodTimer);
      gracePeriodTimer = setTimeout(() => {
        stats.gracePeriodActive = false;
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] 🟢 Post-seek grace period ended for ${videoId}`,
          );
        }
        gracePeriodTimer = null;
      }, BOOST_CONFIG.PRELOAD_GRACE_PERIOD_MS);
    };
    originalVideo.addEventListener("seeking", onUserSeeking);
    originalVideo.addEventListener("seeked", onUserSeeked);

    // ═══════════════════════════════════════════════════════════
    // CORE: Silent preload seek (v2.8 logic, unchanged)
    // ═══════════════════════════════════════════════════════════
    function triggerSilentPreload(targetTime) {
      // 🔧 NEW: Check if this video has priority
      if (
        !PriorityManager.isActiveVideo(originalVideo) &&
        BOOST_CONFIG.PRIORITY_ENABLED
      ) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] 🔇 Skipping preload for ${videoId} - not the active video`,
          );
        }
        return false;
      }

      // Guard conditions
      if (stats.isSnappingBack) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(`[Preload] ⏳ Already snapping back, skipping`);
        }
        return false;
      }
      if (userInitiatedSeek) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(`[Preload] 👤 User seek in progress, skipping`);
        }
        return false;
      }
      if (originalVideo.paused) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(`[Preload] ⏸️ Video paused, skipping`);
        }
        return false;
      }
      if (originalVideo.readyState < 2) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] ⏳ Video not ready (readyState: ${originalVideo.readyState}), skipping`,
          );
        }
        return false;
      }

      if (stats.gracePeriodActive) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          const elapsed = ((Date.now() - stats.playStartTime) / 1000).toFixed(
            1,
          );
          console.log(
            `[Preload] 🛡️ Grace period active (${elapsed}s elapsed), skipping preload`,
          );
        }
        return false;
      }

      const currentBuffer = getBufferAhead(originalVideo);
      stats.maxBufferSeen = Math.max(stats.maxBufferSeen, currentBuffer);

      if (stats.maxBufferSeen < BOOST_CONFIG.PRELOAD_FIRST_BUFFER_GRACE) {
        if (BOOST_CONFIG.DEBUG_PRELOAD && stats.preloadSeeks === 0) {
          console.log(
            `[Preload] 🐌 Buffer hasn't reached ${BOOST_CONFIG.PRELOAD_FIRST_BUFFER_GRACE}s yet ` +
              `(max seen: ${stats.maxBufferSeen.toFixed(1)}s), waiting for natural buffer growth`,
          );
        }
        return false;
      }

      const currentTime = originalVideo.currentTime;
      const duration = originalVideo.duration || Infinity;
      const safeTarget = Math.min(targetTime, duration - 5);
      const advance = safeTarget - currentTime;
      if (advance < BOOST_CONFIG.PRELOAD_MIN_ADVANCE) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] 📏 Advance too small (${advance.toFixed(1)}s < ${BOOST_CONFIG.PRELOAD_MIN_ADVANCE}s), skipping`,
          );
        }
        return false;
      }

      const timeSinceLastSeek = Date.now() - stats.lastPreloadSeek;
      if (timeSinceLastSeek < BOOST_CONFIG.PRELOAD_MIN_INTERVAL) {
        if (BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] ⏱️ Rate limited (${timeSinceLastSeek}ms < ${BOOST_CONFIG.PRELOAD_MIN_INTERVAL}ms), skipping`,
          );
        }
        return false;
      }

      // ─── EXECUTE SILENT PRELOAD ───
      stats.lastPreloadSeek = Date.now();
      stats.preloadSeeks++;
      stats.isSnappingBack = true;
      stats.userCurrentTime = currentTime;
      stats.seekTargetTime = safeTarget;
      stats.wasPlayingBeforePreload = !originalVideo.paused;

      console.log(
        `[Preload] 🔄 #${stats.preloadSeeks}: Silent seek ${currentTime.toFixed(1)}s → ${safeTarget.toFixed(1)}s ` +
          `(advance: ${advance.toFixed(1)}s, snapping back in ${BOOST_CONFIG.PRELOAD_SNAP_BACK_MS}ms)`,
      );

      const bufferBefore = getBufferAhead(originalVideo);
      const rangeBefore = getTotalBufferedRange(originalVideo);

      try {
        originalVideo.currentTime = safeTarget;
      } catch (err) {
        console.error(`[Preload] ❌ Seek failed:`, err.message);
        stats.failedSeeks++;
        stats.isSnappingBack = false;
        return false;
      }

      seekSnapBackTimer = setTimeout(() => {
        seekSnapBackTimer = null;
        if (!document.body.contains(originalVideo)) {
          stats.isSnappingBack = false;
          return;
        }
        const currentPos = originalVideo.currentTime;
        const snapBackTarget = stats.userCurrentTime;
        console.log(
          `[Preload] ↩️ Snapping back: ${currentPos.toFixed(1)}s → ${snapBackTarget.toFixed(1)}s ` +
            `(was at target for ~${BOOST_CONFIG.PRELOAD_SNAP_BACK_MS}ms)`,
        );
        stats.lastSnapBack = Date.now();
        try {
          originalVideo.currentTime = snapBackTarget;
        } catch (err) {
          console.error(`[Preload] ❌ Snap-back failed:`, err.message);
          stats.failedSeeks++;
          stats.isSnappingBack = false;
          if (stats.wasPlayingBeforePreload && originalVideo.paused) {
            originalVideo.play().catch(() => {});
          }
          return;
        }

        setTimeout(() => {
          stats.isSnappingBack = false;
          stats.successfulSeeks++;

          if (stats.wasPlayingBeforePreload && originalVideo.paused) {
            console.log(`[Preload] ▶️ Resuming playback after preload seek`);
            originalVideo.play().catch((err) => {
              console.warn(
                `[Preload] ⚠️ Failed to resume playback:`,
                err.message,
              );
            });
          }

          const bufferAfter = getBufferAhead(originalVideo);
          const rangeAfter = getTotalBufferedRange(originalVideo);
          const bufferGrowth = rangeAfter.end - rangeBefore.end;
          console.log(
            `[Preload] ✅ #${stats.preloadSeeks} complete | ` +
              `Buffer: ${bufferBefore.toFixed(1)}s → ${bufferAfter.toFixed(1)}s ` +
              `(${bufferGrowth > 0 ? "+" : ""}${bufferGrowth.toFixed(1)}s) | ` +
              `Range: ${rangeBefore.start.toFixed(1)}–${rangeBefore.end.toFixed(1)} → ` +
              `${rangeAfter.start.toFixed(1)}–${rangeAfter.end.toFixed(1)}`,
          );

          if (
            bufferGrowth <= 0 &&
            stats.preloadSeeks >= 5 &&
            stats.successfulSeeks <= 2
          ) {
            console.warn(
              `[Preload] ⚠️ Buffer not growing after ${stats.preloadSeeks} seeks. ` +
                `Browser may not support silent preload technique.`,
            );
          }
        }, 500);
      }, BOOST_CONFIG.PRELOAD_SNAP_BACK_MS);

      seekTimeoutTimer = setTimeout(() => {
        if (stats.isSnappingBack) {
          console.warn(`[Preload] ⚠️ Safety timeout - forcing snap-back`);
          if (seekSnapBackTimer) {
            clearTimeout(seekSnapBackTimer);
            seekSnapBackTimer = null;
          }
          try {
            originalVideo.currentTime = stats.userCurrentTime;
          } catch (err) {
            console.error(`[Preload] ❌ Safety snap-back failed:`, err.message);
          }
          stats.isSnappingBack = false;
          stats.failedSeeks++;

          if (stats.wasPlayingBeforePreload && originalVideo.paused) {
            originalVideo.play().catch(() => {});
          }
        }
        seekTimeoutTimer = null;
      }, BOOST_CONFIG.PRELOAD_SNAP_BACK_MS + 2000);
      return true;
    }

    // ═══════════════════════════════════════════════════════════
    // MONITOR LOOP
    // ═══════════════════════════════════════════════════════════
    let monitorIteration = 0;
    const monitorInterval = setInterval(() => {
      monitorIteration++;

      if (!document.body.contains(originalVideo)) {
        console.log(
          `[Preload] 🗑️ Video removed from DOM, cleaning up for ${videoId}`,
        );
        clearInterval(monitorInterval);
        return;
      }

      // 🔧 NEW: Skip monitoring if this video is not the active priority video
      if (
        BOOST_CONFIG.PRIORITY_ENABLED &&
        !PriorityManager.isActiveVideo(originalVideo)
      ) {
        // Only log occasionally to reduce noise
        if (monitorIteration % 30 === 0 && BOOST_CONFIG.DEBUG_PRELOAD) {
          console.log(
            `[Preload] 💤 Monitor paused for ${videoId} - not active video`,
          );
        }
        return;
      }

      if (stats.isSnappingBack) return;
      if (originalVideo.paused) return;
      if (userInitiatedSeek) return;

      const mainBuffer = getBufferAhead(originalVideo);
      stats.maxBufferSeen = Math.max(stats.maxBufferSeen, mainBuffer);

      const mainTime = originalVideo.currentTime;
      const mainDuration = originalVideo.duration || Infinity;

      if (monitorIteration % 10 === 0) {
        const buffered = getTotalBufferedRange(originalVideo);
        const bufferPercent =
          mainDuration > 0
            ? (((buffered.end - buffered.start) / mainDuration) * 100).toFixed(
                1,
              )
            : "?";
        const graceInfo = stats.gracePeriodActive
          ? `🛡️ Grace: ${((Date.now() - stats.playStartTime) / 1000).toFixed(1)}s`
          : "✅ Ready";
        const priorityInfo = stats.isPrioritized
          ? "⭐ Priority"
          : "🔇 Background";
        console.log(
          `[Preload] 📊 Status #${monitorIteration} | ` +
            `Time: ${mainTime.toFixed(1)}s/${mainDuration.toFixed(1)}s | ` +
            `Buffer ahead: ${mainBuffer.toFixed(1)}s | ` +
            `Max buffer: ${stats.maxBufferSeen.toFixed(1)}s | ` +
            `Total buffered: ${buffered.start.toFixed(1)}–${buffered.end.toFixed(1)} (${bufferPercent}%) | ` +
            `Seeks: ${stats.preloadSeeks} (${stats.successfulSeeks} ok, ${stats.failedSeeks} fail) | ` +
            `${graceInfo} | ${priorityInfo}`,
        );
        stats.lastLogTime = Date.now();
      }

      if (stats.gracePeriodActive) return;
      if (stats.maxBufferSeen < BOOST_CONFIG.PRELOAD_FIRST_BUFFER_GRACE) return;

      const needsMoreBuffer = mainBuffer < BOOST_CONFIG.PRELOAD_STOP_AT_BUFFER;
      const hasRoomToGrow = mainTime + mainBuffer < mainDuration - 5;
      if (needsMoreBuffer && hasRoomToGrow) {
        const targetTime = Math.min(
          mainTime + BOOST_CONFIG.PRELOAD_ADVANCE_SEEK,
          Math.min(mainTime + BOOST_CONFIG.PRELOAD_MAX_AHEAD, mainDuration - 5),
        );
        if (targetTime > mainTime + mainBuffer) {
          const urgency =
            mainBuffer < BOOST_CONFIG.MIN_FORWARD_BUFFER
              ? "🔴"
              : mainBuffer < BOOST_CONFIG.BUFFER_LOW
                ? "🟡"
                : "🟢";
          if (BOOST_CONFIG.DEBUG_PRELOAD) {
            console.log(
              `[Preload] ${urgency} Buffer ${mainBuffer.toFixed(1)}s < ${BOOST_CONFIG.PRELOAD_STOP_AT_BUFFER}s, ` +
                `triggering preload → target: ${targetTime.toFixed(1)}s`,
            );
          }
          triggerSilentPreload(targetTime);
        }
      }
    }, BOOST_CONFIG.PRELOAD_SYNC_INTERVAL);

    console.log(
      `[Preload] ✅ Silent preload manager initialized for ${videoId} | ` +
        `Sync: ${BOOST_CONFIG.PRELOAD_SYNC_INTERVAL}ms | ` +
        `Advance: ${BOOST_CONFIG.PRELOAD_ADVANCE_SEEK}s | ` +
        `Snap-back: ${BOOST_CONFIG.PRELOAD_SNAP_BACK_MS}ms | ` +
        `Grace: ${BOOST_CONFIG.PRELOAD_GRACE_PERIOD_MS}ms | ` +
        `First buffer: ${BOOST_CONFIG.PRELOAD_FIRST_BUFFER_GRACE}s | ` +
        `Priority: ${BOOST_CONFIG.PRIORITY_ENABLED ? "✅ ON" : "❌ OFF"}`,
    );

    // ═══════════════════════════════════════════════════════════
    // BUILD MANAGER OBJECT (so we can update the priority entry)
    // ═══════════════════════════════════════════════════════════
    const manager = {
      cleanup: () => {
        console.log(
          `[Preload] 🧹 Cleaning up for ${videoId} | ` +
            `Total seeks: ${stats.preloadSeeks} (${stats.successfulSeeks} ok, ${stats.failedSeeks} fail)`,
        );
        clearInterval(monitorInterval);
        if (seekSnapBackTimer) clearTimeout(seekSnapBackTimer);
        if (seekTimeoutTimer) clearTimeout(seekTimeoutTimer);
        if (userSeekTimeout) clearTimeout(userSeekTimeout);
        if (gracePeriodTimer) clearTimeout(gracePeriodTimer);
        overlayObserver.disconnect();
        parentObserver.disconnect();
        originalVideo.removeEventListener("seeking", onUserSeeking);
        originalVideo.removeEventListener("seeked", onUserSeeked);
        originalVideo.removeEventListener("play", onPlayHandler);
        originalVideo.removeEventListener("pause", onPauseHandler);

        // 🔧 Unregister from Priority Manager
        PriorityManager.unregister(manager);

        originalVideo.preload = originalPreload;
      },
      getStats: () => ({ ...stats }),
      triggerSilentPreload,
    };

    // Update the priority entry with the real manager
    if (priorityEntry) {
      priorityEntry.manager = manager;
    }

    // 🔧 NEW: If this video is NOT the active one, deprioritize it immediately
    if (
      BOOST_CONFIG.PRIORITY_ENABLED &&
      !PriorityManager.isActiveVideo(originalVideo)
    ) {
      originalVideo.preload = BOOST_CONFIG.PRIORITY_BACKGROUND_PRELOAD;
      if (BOOST_CONFIG.DEBUG_PRIORITY) {
        console.log(
          `[Preload] 🔇 ${videoId} starts as background - preload="${BOOST_CONFIG.PRIORITY_BACKGROUND_PRELOAD}"`,
        );
      }
    }

    return manager;
  }

  // ═══════════════════════════════════════════════════════════
  // BOOST STATE STORAGE (unchanged)
  // ═══════════════════════════════════════════════════════════
  const boostTimers = new WeakMap();
  function createBoostState(video) {
    return {
      isBoosting: false,
      boostStartTime: 0,
      boostTargetRate: 1.0,
      currentBoostLevel: "none",
      boostSessionCount: 0,
      totalBoostTime: 0,
      lastBoostEndTime: 0,
      originalRate: video.playbackRate || 1.0,
      connectionQuality: 1.0,
      lastBufferCheck: Date.now(),
      lastBufferAhead: 0,
      lastBufferGrowth: 0,
      consecutiveShrinks: 0,
      playStartTime: 0,
      totalPlayTime: 0,
      isRealPlay: false,
      lastSeekTime: 0,
      seekDebounceTimer: null,
      monitorInterval: null,
      boostTimeout: null,
      lastDebugTime: 0,
      hasInitialBoosted: false,
      maintenanceMode: false,
      maintenanceStartTime: 0,
      maintenanceOffTime: 0,
      bufferWarningCount: 0,
      lastBufferZeroTime: 0,
      emergencyBoostActive: false,
      lastBufferBeforePause: 0,
      pauseResumeCount: 0,
      preloadManager: null,
    };
  }
  function getBoostState(video) {
    if (!video) return null;
    let state = boostTimers.get(video);
    if (!state) {
      state = createBoostState(video);
      boostTimers.set(video, state);
    }
    return state;
  }

  // ═══════════════════════════════════════════════════════════
  // ADAPTIVE RATE CALCULATION (unchanged)
  // ═══════════════════════════════════════════════════════════
  function calculateOptimalBoostRate(
    bufferAhead,
    isSeek = false,
    connectionQuality = 1.0,
  ) {
    if (bufferAhead < BOOST_CONFIG.MIN_FORWARD_BUFFER) {
      const criticalRatio = bufferAhead / BOOST_CONFIG.MIN_FORWARD_BUFFER;
      const rate =
        BOOST_CONFIG.BOOST_RATE_AGGRESSIVE -
        (BOOST_CONFIG.BOOST_RATE_AGGRESSIVE - BOOST_CONFIG.BOOST_RATE_NORMAL) *
          criticalRatio;
      return {
        rate: Math.max(BOOST_CONFIG.BOOST_RATE_NORMAL, rate),
        level: "aggressive",
        emergency: bufferAhead < 2,
      };
    }
    if (bufferAhead < BOOST_CONFIG.BUFFER_LOW) {
      const ratio =
        (bufferAhead - BOOST_CONFIG.MIN_FORWARD_BUFFER) /
        (BOOST_CONFIG.BUFFER_LOW - BOOST_CONFIG.MIN_FORWARD_BUFFER);
      const rate =
        BOOST_CONFIG.BOOST_RATE_NORMAL -
        (BOOST_CONFIG.BOOST_RATE_NORMAL - BOOST_CONFIG.BOOST_RATE_GENTLE) *
          Math.pow(ratio, 0.5);
      return {
        rate: Math.max(BOOST_CONFIG.BOOST_RATE_GENTLE, rate),
        level: "normal",
      };
    }
    if (bufferAhead < BOOST_CONFIG.BUFFER_COMFORT) {
      const ratio =
        (bufferAhead - BOOST_CONFIG.BUFFER_LOW) /
        (BOOST_CONFIG.BUFFER_COMFORT - BOOST_CONFIG.BUFFER_LOW);
      const rate =
        BOOST_CONFIG.BOOST_RATE_GENTLE -
        (BOOST_CONFIG.BOOST_RATE_GENTLE - BOOST_CONFIG.BOOST_RATE_MAINTENANCE) *
          Math.pow(ratio, 0.7);
      return {
        rate: Math.max(BOOST_CONFIG.BOOST_RATE_MAINTENANCE, rate),
        level: "gentle",
      };
    }
    if (bufferAhead < BOOST_CONFIG.BUFFER_TARGET) {
      return {
        rate: BOOST_CONFIG.BOOST_RATE_MAINTENANCE,
        level: "maintenance",
      };
    }
    return { rate: 1.0, level: "none" };
  }

  // ═══════════════════════════════════════════════════════════
  // CONNECTION QUALITY DETECTION (unchanged)
  // ═══════════════════════════════════════════════════════════
  function updateConnectionQuality(video, state) {
    if (!video || !state) return;
    const now = Date.now();
    const timeSinceLastCheck = now - state.lastBufferCheck;
    if (timeSinceLastCheck < BOOST_CONFIG.CONNECTION_CHECK_WINDOW) return;
    const currentBufferAhead = getBufferAhead(video);
    const bufferGrowth = currentBufferAhead - state.lastBufferAhead;
    const growthRate =
      timeSinceLastCheck > 0 ? bufferGrowth / (timeSinceLastCheck / 1000) : 0;
    state.lastBufferGrowth = growthRate;
    if (state.isBoosting && growthRate < -0.1) {
      state.consecutiveShrinks++;
    } else if (state.isBoosting && growthRate > 0.1) {
      state.consecutiveShrinks = Math.max(0, state.consecutiveShrinks - 2);
    } else if (!state.isBoosting) {
      state.consecutiveShrinks = 0;
    }
    const newQuality = Math.max(0.1, Math.min(2.0, Math.abs(growthRate) + 0.5));
    state.connectionQuality = state.connectionQuality * 0.7 + newQuality * 0.3;
    state.lastBufferCheck = now;
    state.lastBufferAhead = currentBufferAhead;
  }

  // ═══════════════════════════════════════════════════════════
  // CONTINUOUS BUFFER MONITOR (priority aware)
  // ═══════════════════════════════════════════════════════════
  function startContinuousBufferMonitor(video) {
    if (!video || video.dataset.continuousMonitorActive === "true") {
      return () => {};
    }
    video.dataset.continuousMonitorActive = "true";
    const state = getBoostState(video);
    const priorityInfo = BOOST_CONFIG.PRIORITY_ENABLED
      ? `Priority: ${PriorityManager.isActiveVideo(video) ? "⭐ Active" : "🔇 Background"}`
      : "Priority: OFF";
    console.log(
      `[Boost] 🚀 Monitor attached | Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | ` +
        `Comfort: ${BOOST_CONFIG.BUFFER_COMFORT}s | Target: ${BOOST_CONFIG.BUFFER_TARGET}s | ` +
        `Preload: ${BOOST_CONFIG.PRELOAD_ENABLED ? "✅ ON" : "❌ OFF"} | ${priorityInfo}`,
    );
    if (!video.__trueOriginalPlaybackRate) {
      video.__trueOriginalPlaybackRate = video.playbackRate || 1.0;
      state.originalRate = video.__trueOriginalPlaybackRate;
    }
    const monitorInterval = setInterval(() => {
      if (typeof tabIsVisible !== "undefined" && !tabIsVisible) return;
      if (video.paused) return;

      // 🔧 NEW: Skip intensive monitoring for non-priority videos
      if (
        BOOST_CONFIG.PRIORITY_ENABLED &&
        !PriorityManager.isActiveVideo(video)
      ) {
        return;
      }

      const ahead = getBufferAhead(video);
      const state = getBoostState(video);
      if (!state) return;
      updateConnectionQuality(video, state);
      if (state.playStartTime > 0) {
        state.totalPlayTime += BOOST_CONFIG.MONITOR_INTERVAL;
      }
      const now = Date.now();
      const isBelowMinimum = ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER;
      if (now - state.lastDebugTime > 5000 || isBelowMinimum) {
        state.lastDebugTime = now;
        const preloadStats = state.preloadManager?.getStats?.();
        const preloadInfo = preloadStats
          ? `Seeks: ${preloadStats.preloadSeeks} (${preloadStats.successfulSeeks}✓) | Grace: ${preloadStats.gracePeriodActive ? "🛡️" : "✅"}`
          : "Preload: N/A";
        const priorityLabel = PriorityManager.isActiveVideo(video)
          ? "⭐"
          : "🔇";
        console.log(
          `[Boost] 📊 ${priorityLabel} Buffer: ${ahead.toFixed(1)}s${isBelowMinimum ? " ⚠️BELOW MIN" : ""} | ` +
            `Rate: ${video.playbackRate.toFixed(2)}x | Play: ${(state.totalPlayTime / 1000).toFixed(0)}s | ` +
            `${preloadInfo}`,
        );
      }
      if (isBelowMinimum) {
        state.bufferWarningCount++;
        if (state.bufferWarningCount % 10 === 0) {
          console.warn(
            `[Boost] ⚠️ Buffer critically low: ${ahead.toFixed(1)}s | ` +
              `Warning #${state.bufferWarningCount} | ` +
              `Preload seeks attempted: ${state.preloadManager?.getStats?.()?.preloadSeeks || 0}`,
          );
        }
      }
      if (video.playbackRate !== 1.0 && !state.isBoosting) {
        // video.playbackRate = 1.0;
      }
    }, BOOST_CONFIG.MONITOR_INTERVAL);
    state.monitorInterval = monitorInterval;
    return () => {
      clearInterval(monitorInterval);
      state.monitorInterval = null;
      delete video.dataset.continuousMonitorActive;
    };
  }

  // ═══════════════════════════════════════════════════════════
  // BOOST APPLICATION (no-op)
  // ═══════════════════════════════════════════════════════════
  function applyForwardBoost(video, targetRate, level, reason = "unknown") {
    return false;
  }
  function stopForwardBoost(video, reason = "target reached") {
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // SEEK BOOST HANDLER (unchanged)
  // ═══════════════════════════════════════════════════════════
  function boostBufferAfterSeek(video) {
    if (!video || video.paused) return;
    if (typeof tabIsVisible !== "undefined" && !tabIsVisible) return;
    const state = getBoostState(video);
    if (!state) return;
    if (state.seekDebounceTimer) clearTimeout(state.seekDebounceTimer);
    state.seekDebounceTimer = setTimeout(() => {
      const ahead = getBufferAhead(video);
      console.log(`[Boost] 🎯 Seek settled | Buffer: ${ahead.toFixed(1)}s`);
      if (
        ahead < BOOST_CONFIG.BUFFER_COMFORT &&
        state.preloadManager?.triggerSilentPreload
      ) {
        const targetTime = Math.min(
          video.currentTime + BOOST_CONFIG.PRELOAD_ADVANCE_SEEK,
          (video.duration || Infinity) - 5,
        );
        console.log(
          `[Boost] 🎯 Post-seek preload trigger → ${targetTime.toFixed(1)}s`,
        );
        state.preloadManager.triggerSilentPreload(targetTime);
      }
      state.seekDebounceTimer = null;
    }, BOOST_CONFIG.SEEK_DEBOUNCE_MS);
  }

  // ═══════════════════════════════════════════════════════════
  // CLEANUP FUNCTIONS
  // ═══════════════════════════════════════════════════════════
  function cleanupBoost(video) {
    if (!video) return;
    const state = boostTimers.get(video);
    if (state) {
      if (state.monitorInterval) clearInterval(state.monitorInterval);
      if (state.boostTimeout) clearTimeout(state.boostTimeout);
      if (state.seekDebounceTimer) clearTimeout(state.seekDebounceTimer);
      if (state.preloadManager) {
        state.preloadManager.cleanup();
        state.preloadManager = null;
      }
      boostTimers.delete(video);
    }
    [
      "__trueOriginalPlaybackRate",
      "__originalPlaybackRate",
      "__boostTargetRate",
      "__boostStartTime",
      "__boostExtensionCount",
      "__boostBaseDuration",
      "__hasBoostedOnLoad",
      "__lastSeekTime",
      "__lastPlayTime",
      "__boostState",
    ].forEach((attr) => delete video[attr]);
    delete video.dataset.continuousMonitorActive;
    delete video.dataset.boostAttached;
  }
  function cleanupPreviewBoost(previewVideo) {
    if (previewVideo) {
      delete previewVideo.__previewOriginalRate;
      delete previewVideo.__previewBoostActive;
      delete previewVideo.__previewBoostStartTime;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SMART PREVIEW BOOST (Replaces no-op)
  // ═══════════════════════════════════════════════════════════════
  function boostPreviewBuffer(previewVideo) {
    if (!previewVideo) return () => {};

    const videoId =
      previewVideo.dataset.videoObserverId ||
      previewVideo.dataset.cacheKeySrc?.substring(0, 20) ||
      "preview-unknown";
    console.log(`[Boost] 🚀 Applying smart preview boost for ${videoId}`);

    let isBoosting = true;
    let monitorInterval = null;
    let timeoutId = null;

    const TARGET_BUFFER = 3; // seconds
    const BOOST_RATE = 1.25; // Smart boost rate for previews
    const originalRate = previewVideo.playbackRate || 1.0;

    const monitor = () => {
      if (!isBoosting || !document.body.contains(previewVideo)) {
        cleanup();
        return;
      }

      const ahead = getBufferAhead(previewVideo);

      // Target reached, stop boosting
      if (ahead >= TARGET_BUFFER) {
        console.log(
          `[Boost] ✅ Preview buffer target reached (${ahead.toFixed(1)}s) for ${videoId}`,
        );
        cleanup();
        return;
      }

      // Apply boost rate if buffer is low and video is playing
      if (ahead < 1.5 && !previewVideo.paused) {
        if (previewVideo.playbackRate !== BOOST_RATE) {
          previewVideo.playbackRate = BOOST_RATE;
          console.log(
            `[Boost] ⬆️ Boosting preview rate to ${BOOST_RATE}x for ${videoId} (buffer: ${ahead.toFixed(1)}s)`,
          );
        }
      } else {
        if (previewVideo.playbackRate !== originalRate) {
          previewVideo.playbackRate = originalRate;
          console.log(
            `[Boost] ⬇️ Restoring preview rate to ${originalRate}x for ${videoId} (buffer: ${ahead.toFixed(1)}s)`,
          );
        }
      }
    };

    // Monitor every 300ms
    monitorInterval = setInterval(monitor, 300);

    // Safety timeout to prevent infinite boosting
    timeoutId = setTimeout(() => {
      if (isBoosting) {
        console.log(`[Boost] ⏱️ Preview boost timeout reached for ${videoId}`);
        cleanup();
      }
    }, 4000);

    const cleanup = () => {
      if (!isBoosting) return;
      isBoosting = false;

      if (monitorInterval) clearInterval(monitorInterval);
      if (timeoutId) clearTimeout(timeoutId);

      if (previewVideo.playbackRate !== originalRate) {
        previewVideo.playbackRate = originalRate;
      }

      console.log(`[Boost] 🧹 Preview boost cleaned up for ${videoId}`);
    };

    return cleanup;
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN BOOST ATTACHMENT (with silent preload + priority)
  // ═══════════════════════════════════════════════════════════════
  function attachBoostToVideo(video) {
    if (!video || video.dataset.boostAttached === "true") return () => {};
    video.dataset.boostAttached = "true";
    const videoId = video.dataset.videoObserverId || "unknown";
    const priorityInfo = BOOST_CONFIG.PRIORITY_ENABLED
      ? "✅ Priority"
      : "❌ No Priority";
    console.log(
      `[Boost] 🔗 Attached to ${videoId} | Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | ` +
        `Preload: ${BOOST_CONFIG.PRELOAD_ENABLED ? "✅ Silent Seek" : "❌ Off"} | ${priorityInfo}`,
    );

    const preloadManager = createSilentPreloadManager(video);
    const state = getBoostState(video);
    if (state) {
      state.preloadManager = preloadManager;
    }
    const stopMonitor = startContinuousBufferMonitor(video);

    const onPlay = () => {
      const state = getBoostState(video);
      if (!state) return;
      state.playStartTime = Date.now();
      video.__lastPlayTime = Date.now();
      const isBufferManager = video.dataset.bufferManagerBuffering === "true";
      const isChunkLoop = video.dataset.chunkLoopActive === "true";
      state.isRealPlay = !isBufferManager && !isChunkLoop;
      const ahead = getBufferAhead(video);
      state.lastBufferAhead = ahead;
      if (state.isRealPlay) {
        console.log(
          `[Boost] ▶️ Real play started for ${videoId} | Buffer: ${ahead.toFixed(1)}s`,
        );
        // 🔧 NEW: Set this video as the active priority video
        if (BOOST_CONFIG.PRIORITY_ENABLED && video.closest("#vo-overlay")) {
          PriorityManager.setActiveVideo(video);
        }
      }
    };

    const onPause = () => {
      const state = getBoostState(video);
      if (!state) return;
      if (state.playStartTime > 0) {
        state.totalPlayTime += Date.now() - state.playStartTime;
        state.playStartTime = 0;
      }
      const ahead = getBufferAhead(video);
      state.lastBufferBeforePause = ahead;
      state.lastBufferAhead = ahead;

      const isPreloadActive =
        state.preloadManager?.getStats?.()?.isSnappingBack;
      if (ahead < BOOST_CONFIG.MIN_FORWARD_BUFFER && !isPreloadActive) {
        console.log(
          `[Boost] ⚠️ Pausing with buffer below minimum: ${ahead.toFixed(1)}s`,
        );
      }
    };

    const onSeeking = () => {
      video.__lastSeekTime = Date.now();
    };

    const onSeeked = () => {
      video.__lastSeekTime = Date.now();
      const ahead = getBufferAhead(video);
      console.log(`[Boost] 🎯 Seeked | Buffer: ${ahead.toFixed(1)}s`);
      if (typeof tabIsVisible === "undefined" || tabIsVisible) {
        boostBufferAfterSeek(video);
      }
    };

    const onEnded = () => {
      console.log(`[Boost] 🏁 Video ended for ${videoId}`);
      // 🔧 NEW: Clear priority when video ends
      if (PriorityManager.isActiveVideo(video)) {
        PriorityManager.clearActiveVideo();
      }
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ended", onEnded);

    return () => {
      console.log(`[Boost] 🔌 Detached from ${videoId}`);
      stopMonitor();
      if (preloadManager) preloadManager.cleanup();
      cleanupBoost(video);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("ended", onEnded);
      [
        "boostAttached",
        "__lastSeekTime",
        "__lastPlayTime",
        "__trueOriginalPlaybackRate",
        "__hasBoostedOnLoad",
      ].forEach((attr) => {
        if (attr.startsWith("__")) delete video[attr];
        else delete video.dataset[attr];
      });
    };
  }

  // ═══════════════════════════════════════════════════════════
  // GLOBAL API
  // ═══════════════════════════════════════════════════════════
  window.BoostEngine = {
    attachBoostToVideo,
    cleanupBoost,
    getBufferAhead,
    startContinuousBufferMonitor,
    boostBufferAfterSeek,
    boostPreviewBuffer,
    cleanupPreviewBoost,
    config: BOOST_CONFIG,
    getBoostState,
    createSilentPreloadManager,
    PriorityManager, // 🔧 NEW: Expose Priority Manager
  };
  console.log("[Boost] ✅ v2.9 Ready - Silent Preload + Active Video Priority");
  console.log(
    `[Boost] Min: ${BOOST_CONFIG.MIN_FORWARD_BUFFER}s | Target: ${BOOST_CONFIG.BUFFER_TARGET}s`,
  );
  console.log(
    `[Boost] Preload: ${BOOST_CONFIG.PRELOAD_ENABLED ? "✅ Silent Seek" : "❌ Disabled"}`,
  );
  console.log(
    `[Boost] Snap-back: ${BOOST_CONFIG.PRELOAD_SNAP_BACK_MS}ms | Advance: ${BOOST_CONFIG.PRELOAD_ADVANCE_SEEK}s`,
  );
  console.log(
    `[Boost] Grace: ${BOOST_CONFIG.PRELOAD_GRACE_PERIOD_MS}ms | First buffer: ${BOOST_CONFIG.PRELOAD_FIRST_BUFFER_GRACE}s`,
  );
  console.log(
    `[Boost] Priority: ${BOOST_CONFIG.PRIORITY_ENABLED ? "✅ Active video gets all bandwidth" : "❌ Disabled"}`,
  );
  console.log(
    `[Boost] Background preload: "${BOOST_CONFIG.PRIORITY_BACKGROUND_PRELOAD}"`,
  );
}
