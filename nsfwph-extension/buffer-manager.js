// buffer-manager.js - Smart RAM Buffer Manager for preview videos
// Controls buffer strategy to prevent excessive memory usage across multiple previews

(function () {
  "use strict";

  console.log("[BufferManager] Module loading...");

  // ═══════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════

  const RAM_CONFIG = {
    MAX_ACTIVE_PREVIEWS: 8,
    BUFFER_STRATEGY: {
      NONE: "none",
      METADATA: "metadata",
      INITIAL: "initial",
      ACTIVE: "active",
    },
    BUFFER_TARGETS: {
      metadata: 0,
      initial: 2,
      active: 5,
    },
    MAX_TOTAL_BUFFER_RAM: 20 * 1024 * 1024, // 20MB
  };

  /**
   * Smart buffer manager for preview videos
   */
  const BufferManager = {
    managedVideos: new Map(),
    activeBufferCount: 0,
    totalEstimatedRAM: 0,

    /**
     * Register a preview video for buffer management
     */
    register(previewVideo, entryId) {
      if (this.managedVideos.has(previewVideo)) return;

      this.managedVideos.set(previewVideo, {
        strategy: RAM_CONFIG.BUFFER_STRATEGY.NONE,
        lastAccess: 0,
        entryId,
        bufferTarget: 0,
      });

      console.log(`[BufferMgr] ✅ Registered preview for ${entryId}`);
    },

    /**
     * Unregister a preview video
     */
    unregister(previewVideo) {
      this.releaseBuffer(previewVideo);
      this.managedVideos.delete(previewVideo);
      console.log(`[BufferMgr] 🗑️ Unregistered preview video`);
    },

    /**
     * Set the buffer strategy for a preview video
     */
    async setStrategy(previewVideo, strategy) {
      if (!this.managedVideos.has(previewVideo)) return;

      const info = this.managedVideos.get(previewVideo);
      const oldStrategy = info.strategy;

      info.strategy = strategy;
      info.lastAccess = Date.now();
      info.bufferTarget = RAM_CONFIG.BUFFER_TARGETS[strategy];

      console.log(
        `[BufferMgr] Strategy change for ${info.entryId}: ${oldStrategy} → ${strategy}`,
      );

      switch (strategy) {
        case RAM_CONFIG.BUFFER_STRATEGY.NONE:
          this.releaseBuffer(previewVideo);
          break;
        case RAM_CONFIG.BUFFER_STRATEGY.METADATA:
          this.lightBuffer(previewVideo);
          break;
        case RAM_CONFIG.BUFFER_STRATEGY.INITIAL:
          await this.initialBuffer(previewVideo, info);
          break;
        case RAM_CONFIG.BUFFER_STRATEGY.ACTIVE:
          await this.activeBuffer(previewVideo, info);
          break;
      }

      this.enforceLimits();
    },

    /**
     * Release buffer memory by unloading the video source
     */
    releaseBuffer(previewVideo) {
      if (!previewVideo || previewVideo.dataset.bufferReleased === "true")
        return;

      const info = this.managedVideos.get(previewVideo);

      previewVideo.pause();

      if (!previewVideo.dataset.savedSrc) {
        previewVideo.dataset.savedSrc = previewVideo.src;
      }

      previewVideo.removeAttribute("src");
      previewVideo.load();
      previewVideo.dataset.bufferReleased = "true";

      if (info) {
        this.activeBufferCount = Math.max(0, this.activeBufferCount - 1);
        this.totalEstimatedRAM = Math.max(0, this.totalEstimatedRAM - 500000);
      }

      console.log(
        `[BufferMgr] 💾 Released buffer for ${info?.entryId || "unknown"}`,
      );
    },

    /**
     * Light buffer - just load metadata
     */
    lightBuffer(previewVideo) {
      previewVideo.preload = "metadata";

      if (previewVideo.dataset.bufferReleased === "true") {
        previewVideo.src = previewVideo.dataset.savedSrc || "";
        previewVideo.dataset.bufferReleased = "false";
        previewVideo.load();
      }

      console.log(`[BufferMgr] 📋 Light buffer (metadata only) set`);
    },

    /**
     * Initial buffer - buffer first 2 seconds
     */
    async initialBuffer(previewVideo, info) {
      if (!window.__tabIsVisible) return;

      if (previewVideo.dataset.bufferReleased === "true") {
        previewVideo.src = previewVideo.dataset.savedSrc || "";
        previewVideo.dataset.bufferReleased = "false";
        previewVideo.load();
      }

      previewVideo.preload = "auto";

      if (previewVideo.readyState < 1) {
        try {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              previewVideo.removeEventListener("loadedmetadata", onMeta);
              reject(new Error("Metadata timeout"));
            }, 3000);

            const onMeta = () => {
              clearTimeout(timeout);
              resolve();
            };

            previewVideo.addEventListener("loadedmetadata", onMeta, {
              once: true,
            });
          });
        } catch (err) {
          console.warn(
            `[BufferMgr] Metadata wait failed for ${info.entryId}:`,
            err.message,
          );
          return;
        }
      }

      if (previewVideo.duration < 1) {
        console.log(
          `[BufferMgr] Video too short for ${info.entryId}, skipping buffer`,
        );
        return;
      }

      if (previewVideo.dataset.chunkLoopActive === "true") {
        console.log(
          `[BufferMgr] Chunk loop active for ${info.entryId}, skipping initial buffer`,
        );
        return;
      }

      // Try to get first chunk start from cache
      let targetTime = 0;
      const cacheKeySrc = previewVideo.dataset.cacheKeySrc;

      if (cacheKeySrc) {
        try {
          console.log(
            `[BufferMgr] 🔍 Checking cache for first chunk start time...`,
          );
          const cached = await window.ChunkCache?.get(cacheKeySrc);

          if (cached && cached.chunks && cached.chunks.length > 0) {
            targetTime = cached.chunks[0];
            console.log(
              `[BufferMgr] ✅ Reusing first chunk start time from cache: ` +
                `${targetTime.toFixed(2)}s for ${info.entryId}`,
            );
          }
        } catch (err) {
          console.warn(
            `[BufferMgr] ⚠️ Cache lookup failed for ${info.entryId}:`,
            err.message,
          );
        }
      }

      previewVideo.currentTime = targetTime;
      previewVideo.dataset.bufferManagerBuffering = "true";

      try {
        await previewVideo.play();

        const cleanupBoost =
          window.BoostEngine?.boostPreviewBuffer(previewVideo);
        await this.waitForBuffer(previewVideo, 2, 800);

        if (previewVideo.dataset.bufferManagerBuffering === "true") {
          previewVideo.pause();
        }

        if (typeof cleanupBoost === "function") cleanupBoost();

        this.activeBufferCount++;
        this.totalEstimatedRAM += 500000;

        console.log(
          `[BufferMgr] ✅ Initial buffer complete for ${info.entryId} at ${targetTime.toFixed(2)}s`,
        );
      } catch (err) {
        if (err.name === "AbortError") {
          console.log(
            `[BufferMgr] Initial buffer interrupted for ${info.entryId}`,
          );
        } else {
          console.warn(
            `[BufferMgr] Initial buffer failed for ${info.entryId}:`,
            err.message,
          );
        }
      } finally {
        delete previewVideo.dataset.bufferManagerBuffering;
      }
    },

    /**
     * Active buffer - buffer multiple chunks for hovered preview
     */
    async activeBuffer(previewVideo, info) {
      if (!window.__tabIsVisible) return;

      const ahead = window.BoostEngine?.getBufferAhead(previewVideo) || 0;
      if (ahead >= 5) return;

      if (previewVideo.paused) {
        try {
          await previewVideo.play();
          await this.waitForBuffer(previewVideo, 5, 2000);
        } catch (err) {
          console.warn(`[BufferMgr] Active buffer failed:`, err.message);
        }
      }
    },

    /**
     * Wait until video has buffered up to target seconds or timeout
     */
    waitForBuffer(video, targetSeconds, maxWaitMs) {
      return new Promise((resolve) => {
        const startTime = Date.now();

        const check = () => {
          const ahead = window.BoostEngine?.getBufferAhead(video) || 0;
          if (ahead >= targetSeconds || Date.now() - startTime >= maxWaitMs) {
            resolve();
            return;
          }
          setTimeout(check, 100);
        };

        check();
      });
    },

    /**
     * Enforce global RAM limits with smarter eviction
     */
    enforceLimits() {
      const COOLDOWN_MS = 2000;
      let activeVideos = [];

      for (const [video, info] of this.managedVideos) {
        if (
          info.strategy === RAM_CONFIG.BUFFER_STRATEGY.ACTIVE ||
          info.strategy === RAM_CONFIG.BUFFER_STRATEGY.INITIAL
        ) {
          activeVideos.push({ video, info });
        }
      }

      if (
        activeVideos.length <= RAM_CONFIG.MAX_ACTIVE_PREVIEWS &&
        this.totalEstimatedRAM <= RAM_CONFIG.MAX_TOTAL_BUFFER_RAM
      ) {
        return;
      }

      const now = Date.now();
      const eligibleForEviction = activeVideos.filter(
        (v) => now - v.info.lastAccess > COOLDOWN_MS,
      );

      if (eligibleForEviction.length === 0) {
        console.log(
          `[BufferMgr] All buffers within cooldown, relaxing limit temporarily`,
        );
        return;
      }

      eligibleForEviction.sort((a, b) => a.info.lastAccess - b.info.lastAccess);

      let evicted = 0;
      while (
        activeVideos.length - evicted > RAM_CONFIG.MAX_ACTIVE_PREVIEWS ||
        this.totalEstimatedRAM > RAM_CONFIG.MAX_TOTAL_BUFFER_RAM
      ) {
        const oldest = eligibleForEviction.shift();
        if (!oldest) break;

        console.log(
          `[BufferMgr] Evicting buffer for ${oldest.info.entryId} ` +
            `(RAM pressure, last access ${now - oldest.info.lastAccess}ms ago)`,
        );

        this.setStrategy(oldest.video, RAM_CONFIG.BUFFER_STRATEGY.METADATA);
        evicted++;
      }
    },

    /**
     * Handle tab hidden: release ALL buffers
     */
    onTabHidden() {
      for (const [video, info] of this.managedVideos) {
        if (info.strategy !== RAM_CONFIG.BUFFER_STRATEGY.NONE) {
          this.setStrategy(video, RAM_CONFIG.BUFFER_STRATEGY.NONE);
        }
      }
      console.log(`[BufferMgr] Tab hidden - released all buffers`);
    },

    /**
     * Handle tab visible: restore buffers for visible previews
     */
    onTabVisible() {
      let restored = 0;

      for (const [video, info] of this.managedVideos) {
        const card = video.closest(".video-card");

        if (
          card &&
          this.isElementInViewport(card) &&
          restored < RAM_CONFIG.MAX_ACTIVE_PREVIEWS
        ) {
          this.setStrategy(video, RAM_CONFIG.BUFFER_STRATEGY.INITIAL);
          restored++;
        }
      }

      console.log(`[BufferMgr] Tab visible - restored ${restored} buffers`);
    },

    /**
     * Check if an element is visible in the viewport
     */
    isElementInViewport(el) {
      const rect = el.getBoundingClientRect();

      // Special handling for floating panel cards
      const panelEl = document.getElementById("video-observer-panel");
      if (panelEl && panelEl.contains(el)) {
        const panelRect = panelEl.getBoundingClientRect();
        const listEl = panelEl.querySelector("#videos-list");
        const listRect = listEl ? listEl.getBoundingClientRect() : panelRect;

        return (
          rect.top >= listRect.top &&
          rect.bottom <= listRect.bottom &&
          rect.left >= listRect.left &&
          rect.right <= listRect.right
        );
      }

      // Default: check against main browser viewport
      return (
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.left >= 0 &&
        rect.right <= window.innerWidth
      );
    },

    /**
     * Get buffer statistics for debugging
     */
    getStats() {
      let stats = {
        totalManaged: this.managedVideos.size,
        activeBuffers: 0,
        estimatedRAM: this.totalEstimatedRAM,
        maxRAM: RAM_CONFIG.MAX_TOTAL_BUFFER_RAM,
        byStrategy: {},
      };

      for (const [, info] of this.managedVideos) {
        stats.byStrategy[info.strategy] =
          (stats.byStrategy[info.strategy] || 0) + 1;
        if (info.strategy !== RAM_CONFIG.BUFFER_STRATEGY.NONE) {
          stats.activeBuffers++;
        }
      }

      return stats;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // EXPORT TO GLOBAL SCOPE
  // ═══════════════════════════════════════════════════════════════

  window.RAM_CONFIG = RAM_CONFIG;
  window.BufferManager = BufferManager;

  console.log("[BufferManager] Module loaded successfully ✅");
  console.log("[BufferManager] Config:", {
    maxActivePreviews: RAM_CONFIG.MAX_ACTIVE_PREVIEWS,
    maxTotalRAM:
      (RAM_CONFIG.MAX_TOTAL_BUFFER_RAM / 1024 / 1024).toFixed(0) + "MB",
    bufferTargets: RAM_CONFIG.BUFFER_TARGETS,
  });
})();
