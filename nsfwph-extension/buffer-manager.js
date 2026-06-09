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
    METADATA_TIMEOUT_MS: 8000, // Increased to 8s
    INITIAL_BUFFER_TIMEOUT_MS: 5000,
    EVICTION_COOLDOWN_MS: 5000, // Increased to prevent premature eviction
    ENFORCE_DEBOUNCE_MS: 1000,
    MAX_CONCURRENT_INITIAL_BUFFERS: 2,
    INITIAL_BUFFER_STAGGER_MS: 800,
  };

  /**
   * Smart buffer manager for preview videos
   */
  const BufferManager = {
    managedVideos: new Map(),
    activeBufferCount: 0,
    totalEstimatedRAM: 0,
    _enforceTimer: null,
    _bufferingInProgress: new Set(),
    _initialBufferQueue: [],
    _processingQueue: false,
    _metadataRetryMap: new Map(), // Track metadata retry counts

    register(previewVideo, entryId) {
      if (this.managedVideos.has(previewVideo)) return;

      this.managedVideos.set(previewVideo, {
        strategy: RAM_CONFIG.BUFFER_STRATEGY.NONE,
        lastAccess: Date.now(),
        entryId,
        bufferTarget: 0,
        metadataReady: false,
        bufferingFailed: false,
      });

      console.log(`[BufferMgr] ✅ Registered preview for ${entryId}`);
    },

    unregister(previewVideo) {
      this._bufferingInProgress.delete(previewVideo);
      this._metadataRetryMap.delete(previewVideo);
      this._initialBufferQueue = this._initialBufferQueue.filter(
        (item) => item.previewVideo !== previewVideo,
      );
      this.releaseBuffer(previewVideo);
      this.managedVideos.delete(previewVideo);
      console.log(`[BufferMgr] 🗑️ Unregistered preview video`);
    },

    async setStrategy(previewVideo, strategy) {
      if (!this.managedVideos.has(previewVideo)) return;

      const info = this.managedVideos.get(previewVideo);
      const oldStrategy = info.strategy;

      // Skip if strategy hasn't changed
      if (
        oldStrategy === strategy &&
        strategy !== RAM_CONFIG.BUFFER_STRATEGY.ACTIVE
      ) {
        return;
      }

      if (
        this._bufferingInProgress.has(previewVideo) &&
        strategy === oldStrategy
      ) {
        return;
      }

      info.strategy = strategy;
      info.lastAccess = Date.now();
      info.bufferTarget = RAM_CONFIG.BUFFER_TARGETS[strategy];

      console.log(
        `[BufferMgr] Strategy change for ${info.entryId}: ${oldStrategy} → ${strategy}`,
      );

      if (
        !document.body.contains(previewVideo) &&
        strategy !== RAM_CONFIG.BUFFER_STRATEGY.NONE
      ) {
        console.warn(`[BufferMgr] ⚠️ Preview for ${info.entryId} not in DOM`);
        info.strategy = RAM_CONFIG.BUFFER_STRATEGY.NONE;
        return;
      }

      switch (strategy) {
        case RAM_CONFIG.BUFFER_STRATEGY.NONE:
          this.releaseBuffer(previewVideo);
          break;
        case RAM_CONFIG.BUFFER_STRATEGY.METADATA:
          this.lightBuffer(previewVideo);
          break;
        case RAM_CONFIG.BUFFER_STRATEGY.INITIAL:
          this._queueInitialBuffer(previewVideo, info);
          break;
        case RAM_CONFIG.BUFFER_STRATEGY.ACTIVE:
          this._bufferingInProgress.add(previewVideo);
          try {
            await this.activeBuffer(previewVideo, info);
          } finally {
            this._bufferingInProgress.delete(previewVideo);
          }
          break;
      }

      this._scheduleEnforceLimits();
    },

    _queueInitialBuffer(previewVideo, info) {
      this._initialBufferQueue = this._initialBufferQueue.filter(
        (item) => item.previewVideo !== previewVideo,
      );
      this._initialBufferQueue.push({ previewVideo, info });
      if (!this._processingQueue) {
        this._processInitialBufferQueue();
      }
    },

    async _processInitialBufferQueue() {
      if (this._processingQueue) return;
      this._processingQueue = true;

      console.log(
        `[BufferMgr] 🔄 Processing initial buffer queue (${this._initialBufferQueue.length} items)`,
      );

      while (this._initialBufferQueue.length > 0) {
        const currentlyBuffering = this._bufferingInProgress.size;
        if (currentlyBuffering >= RAM_CONFIG.MAX_CONCURRENT_INITIAL_BUFFERS) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }

        const item = this._initialBufferQueue.shift();
        if (!item) break;

        const { previewVideo, info } = item;

        if (info.strategy !== RAM_CONFIG.BUFFER_STRATEGY.INITIAL) {
          console.log(
            `[BufferMgr] ⏭️ Skipping queued buffer for ${info.entryId} - strategy changed`,
          );
          continue;
        }

        if (!document.body.contains(previewVideo)) {
          console.log(
            `[BufferMgr] ⏭️ Skipping queued buffer for ${info.entryId} - removed from DOM`,
          );
          continue;
        }

        // Less strict viewport check: just check if card is in the panel
        const card = previewVideo.closest(".video-card");
        if (card) {
          const panelEl = document.getElementById("video-observer-panel");
          if (panelEl && !panelEl.contains(card)) {
            console.log(
              `[BufferMgr] Card not in panel, skipping initial buffer for ${info.entryId}`,
            );
            continue;
          }
          // Don't skip if card is in panel but not fully visible - just log it
        }

        this._bufferingInProgress.add(previewVideo);
        try {
          await this.initialBuffer(previewVideo, info);
        } finally {
          this._bufferingInProgress.delete(previewVideo);
        }

        if (this._initialBufferQueue.length > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, RAM_CONFIG.INITIAL_BUFFER_STAGGER_MS),
          );
        }
      }

      this._processingQueue = false;
      console.log("[BufferMgr] ✅ Initial buffer queue processing complete");
    },

    _scheduleEnforceLimits() {
      if (this._enforceTimer) clearTimeout(this._enforceTimer);
      this._enforceTimer = setTimeout(() => {
        this._enforceTimer = null;
        this.enforceLimits();
      }, RAM_CONFIG.ENFORCE_DEBOUNCE_MS);
    },

    releaseBuffer(previewVideo) {
      if (!previewVideo) return;
      const info = this.managedVideos.get(previewVideo);
      if (previewVideo.dataset.bufferReleased === "true") return;

      try {
        previewVideo.pause();
      } catch (e) {}

      if (!previewVideo.dataset.savedSrc) {
        previewVideo.dataset.savedSrc =
          previewVideo.src || previewVideo.currentSrc || "";
      }

      if (previewVideo.src) {
        previewVideo.removeAttribute("src");
        previewVideo.load();
      }

      previewVideo.dataset.bufferReleased = "true";

      if (info) {
        info.metadataReady = false;
        this.activeBufferCount = Math.max(0, this.activeBufferCount - 1);
        this.totalEstimatedRAM = Math.max(0, this.totalEstimatedRAM - 500000);
      }

      console.log(
        `[BufferMgr] 💾 Released buffer for ${info?.entryId || "unknown"}`,
      );
    },

    lightBuffer(previewVideo) {
      const info = this.managedVideos.get(previewVideo);
      if (!info) return;

      previewVideo.preload = "metadata";

      if (previewVideo.dataset.bufferReleased === "true") {
        const savedSrc = previewVideo.dataset.savedSrc;
        if (savedSrc && savedSrc !== "undefined" && savedSrc !== "null") {
          previewVideo.src = savedSrc;
        }
        previewVideo.dataset.bufferReleased = "false";
      }

      console.log(
        `[BufferMgr] 📋 Light buffer (metadata only) set for ${info.entryId}`,
      );
    },

    /**
     * Wait for metadata with retry logic.
     * If the first attempt fails, tries reloading the source.
     */
    async _waitForMetadata(previewVideo, entryId) {
      // Already has metadata?
      if (previewVideo.readyState >= 1 && previewVideo.duration > 0) {
        return true;
      }

      // Track retry count
      const retryKey = previewVideo;
      const retries = this._metadataRetryMap.get(retryKey) || 0;

      // Restore source if buffer was released
      if (previewVideo.dataset.bufferReleased === "true") {
        const savedSrc = previewVideo.dataset.savedSrc;
        if (savedSrc && savedSrc !== "undefined" && savedSrc !== "null") {
          previewVideo.src = savedSrc;
          previewVideo.dataset.bufferReleased = "false";
        }
      }

      // If no source at all, can't load metadata
      if (!previewVideo.src && !previewVideo.currentSrc) {
        console.warn(
          `[BufferMgr] ⚠️ No source for ${entryId}, cannot load metadata`,
        );
        return false;
      }

      // Force load if retrying
      if (retries > 0) {
        console.log(
          `[BufferMgr] 🔄 Retry #${retries} loading metadata for ${entryId}`,
        );
        previewVideo.load();
      }

      return new Promise((resolve) => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            previewVideo.removeEventListener("loadedmetadata", onMeta);

            // Retry once by reloading the source
            if (retries < 1) {
              console.warn(
                `[BufferMgr] ⏱️ Metadata timeout for ${entryId}, retrying with reload...`,
              );
              this._metadataRetryMap.set(retryKey, retries + 1);
              previewVideo.load();
              // Wait again
              const retryTimeout = setTimeout(() => {
                if (!resolved) {
                  resolved = true;
                  previewVideo.removeEventListener("loadedmetadata", onMeta);
                  console.warn(
                    `[BufferMgr] ❌ Metadata retry failed for ${entryId}`,
                  );
                  resolve(false);
                }
              }, RAM_CONFIG.METADATA_TIMEOUT_MS);

              const onMetaRetry = () => {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(retryTimeout);
                  this._metadataRetryMap.delete(retryKey);
                  resolve(true);
                }
              };
              previewVideo.addEventListener("loadedmetadata", onMetaRetry, {
                once: true,
              });
            } else {
              console.warn(
                `[BufferMgr] ❌ Metadata failed after ${retries + 1} attempts for ${entryId}`,
              );
              this._metadataRetryMap.delete(retryKey);
              resolve(false);
            }
          }
        }, RAM_CONFIG.METADATA_TIMEOUT_MS);

        const onMeta = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            this._metadataRetryMap.delete(retryKey);
            resolve(true);
          }
        };

        if (previewVideo.readyState >= 1) {
          clearTimeout(timeout);
          this._metadataRetryMap.delete(retryKey);
          resolve(true);
          return;
        }

        previewVideo.addEventListener("loadedmetadata", onMeta, { once: true });
      });
    },

    async initialBuffer(previewVideo, info) {
      if (!window.__tabIsVisible) {
        console.log(
          `[BufferMgr] Tab hidden, skipping initial buffer for ${info.entryId}`,
        );
        return;
      }

      // Ensure preview is visible somewhere in the panel (relaxed check)
      const card = previewVideo.closest(".video-card");
      const panelEl = document.getElementById("video-observer-panel");
      if (card && panelEl && !panelEl.contains(card)) {
        console.log(
          `[BufferMgr] Card not in panel, skipping initial buffer for ${info.entryId}`,
        );
        return;
      }

      // Wait for metadata with retry
      const hasMetadata = await this._waitForMetadata(
        previewVideo,
        info.entryId,
      );
      if (!hasMetadata) {
        info.bufferingFailed = true;
        console.warn(
          `[BufferMgr] ❌ Cannot buffer ${info.entryId} - no metadata`,
        );
        return;
      }

      info.metadataReady = true;
      info.bufferingFailed = false;

      if (previewVideo.duration < 1) {
        console.log(
          `[BufferMgr] Video too short for ${info.entryId} (${previewVideo.duration.toFixed(1)}s)`,
        );
        return;
      }

      if (previewVideo.dataset.chunkLoopActive === "true") {
        console.log(
          `[BufferMgr] Chunk loop active for ${info.entryId}, skipping`,
        );
        return;
      }

      if (!document.body.contains(previewVideo)) {
        console.warn(
          `[BufferMgr] ⚠️ Preview removed during init for ${info.entryId}`,
        );
        return;
      }

      // Try to get first chunk start from cache
      let targetTime = 0;
      const cacheKeySrc = previewVideo.dataset.cacheKeySrc;

      if (cacheKeySrc) {
        try {
          const cached = await window.ChunkCache?.get(cacheKeySrc);
          if (cached && cached.chunks && cached.chunks.length > 0) {
            targetTime = cached.chunks[0];
            console.log(
              `[BufferMgr] ✅ Using cached chunk start: ${targetTime.toFixed(2)}s for ${info.entryId}`,
            );
          }
        } catch (err) {}
      }

      previewVideo.currentTime = targetTime;
      previewVideo.dataset.bufferManagerBuffering = "true";

      try {
        await previewVideo.play();

        const cleanupBoost =
          window.BoostEngine?.boostPreviewBuffer(previewVideo);

        const bufferStart = Date.now();
        await this.waitForBuffer(
          previewVideo,
          RAM_CONFIG.BUFFER_TARGETS.initial,
          RAM_CONFIG.INITIAL_BUFFER_TIMEOUT_MS,
        );
        const bufferDuration = Date.now() - bufferStart;

        if (previewVideo.dataset.bufferManagerBuffering === "true") {
          previewVideo.pause();
        }

        if (typeof cleanupBoost === "function") cleanupBoost();

        this.activeBufferCount++;
        this.totalEstimatedRAM += 500000;
        info.lastAccess = Date.now();

        console.log(
          `[BufferMgr] ✅ Initial buffer complete for ${info.entryId} at ${targetTime.toFixed(2)}s (${bufferDuration}ms)`,
        );
      } catch (err) {
        if (err.name !== "AbortError") {
          console.warn(
            `[BufferMgr] Initial buffer failed for ${info.entryId}:`,
            err.message,
          );
        }
        info.bufferingFailed = true;
      } finally {
        delete previewVideo.dataset.bufferManagerBuffering;
      }
    },

    async activeBuffer(previewVideo, info) {
      if (!window.__tabIsVisible) return;

      const ahead = window.BoostEngine?.getBufferAhead(previewVideo) || 0;
      if (ahead >= RAM_CONFIG.BUFFER_TARGETS.active) return;

      if (!info.metadataReady) {
        const hasMetadata = await this._waitForMetadata(
          previewVideo,
          info.entryId,
        );
        if (!hasMetadata) return;
        info.metadataReady = true;
      }

      if (previewVideo.paused) {
        try {
          await previewVideo.play();
          await this.waitForBuffer(
            previewVideo,
            RAM_CONFIG.BUFFER_TARGETS.active,
            3000,
          );
          info.lastAccess = Date.now();
          console.log(
            `[BufferMgr] ✅ Active buffer complete for ${info.entryId}`,
          );
        } catch (err) {
          console.warn(
            `[BufferMgr] Active buffer failed for ${info.entryId}:`,
            err.message,
          );
        }
      }
    },

    waitForBuffer(video, targetSeconds, maxWaitMs) {
      return new Promise((resolve) => {
        const startTime = Date.now();
        let lastAhead = 0;

        const check = () => {
          if (!document.body.contains(video)) {
            resolve();
            return;
          }

          const ahead = window.BoostEngine?.getBufferAhead(video) || 0;

          if (ahead >= targetSeconds || Date.now() - startTime >= maxWaitMs) {
            if (ahead >= targetSeconds) {
              console.log(
                `[BufferMgr:D] Buffer target: ${ahead.toFixed(1)}s >= ${targetSeconds}s`,
              );
            }
            resolve();
            return;
          }

          if (ahead !== lastAhead && Math.abs(ahead - lastAhead) > 0.5) {
            console.log(
              `[BufferMgr:D] Buffering: ${ahead.toFixed(1)}s / ${targetSeconds}s`,
            );
            lastAhead = ahead;
          }

          setTimeout(check, 100);
        };

        check();
      });
    },

    enforceLimits() {
      const now = Date.now();
      let activeVideos = [];

      for (const [video, info] of this.managedVideos) {
        if (
          info.strategy === RAM_CONFIG.BUFFER_STRATEGY.ACTIVE ||
          info.strategy === RAM_CONFIG.BUFFER_STRATEGY.INITIAL
        ) {
          if (this._bufferingInProgress.has(video)) continue;
          if (video.dataset.chunkLoopActive === "true") continue;
          activeVideos.push({ video, info });
        }
      }

      const overCount = activeVideos.length > RAM_CONFIG.MAX_ACTIVE_PREVIEWS;
      const overRAM = this.totalEstimatedRAM > RAM_CONFIG.MAX_TOTAL_BUFFER_RAM;

      if (!overCount && !overRAM) return;

      console.log(
        `[BufferMgr] Limits: ${activeVideos.length}/${RAM_CONFIG.MAX_ACTIVE_PREVIEWS} active, ` +
          `RAM: ${(this.totalEstimatedRAM / 1024 / 1024).toFixed(1)}MB/${(RAM_CONFIG.MAX_TOTAL_BUFFER_RAM / 1024 / 1024).toFixed(0)}MB`,
      );

      const eligibleForEviction = activeVideos.filter(
        (v) => now - v.info.lastAccess > RAM_CONFIG.EVICTION_COOLDOWN_MS,
      );

      if (eligibleForEviction.length === 0) {
        console.log(
          `[BufferMgr] All ${activeVideos.length} buffers within cooldown, relaxing`,
        );
        return;
      }

      eligibleForEviction.sort((a, b) => a.info.lastAccess - b.info.lastAccess);

      const targetCount = Math.max(1, RAM_CONFIG.MAX_ACTIVE_PREVIEWS - 1);
      let toEvict = activeVideos.length - targetCount;
      toEvict = Math.min(toEvict, eligibleForEviction.length);

      console.log(`[BufferMgr] 🧹 Evicting ${toEvict} buffer(s)`);

      for (let i = 0; i < toEvict && i < eligibleForEviction.length; i++) {
        const oldest = eligibleForEviction[i];
        console.log(
          `[BufferMgr] Evicting ${oldest.info.entryId} (last access ${now - oldest.info.lastAccess}ms ago)`,
        );
        oldest.video.preload = "metadata";
        oldest.info.strategy = RAM_CONFIG.BUFFER_STRATEGY.METADATA;
        this.activeBufferCount = Math.max(0, this.activeBufferCount - 1);
        this.totalEstimatedRAM = Math.max(0, this.totalEstimatedRAM - 500000);
      }
    },

    onTabHidden() {
      for (const [video, info] of this.managedVideos) {
        if (info.strategy !== RAM_CONFIG.BUFFER_STRATEGY.NONE) {
          this.releaseBuffer(video);
          info.strategy = RAM_CONFIG.BUFFER_STRATEGY.NONE;
        }
      }
    },

    onTabVisible() {
      let restored = 0;
      for (const [video, info] of this.managedVideos) {
        if (restored >= RAM_CONFIG.MAX_ACTIVE_PREVIEWS) break;
        const card = video.closest(".video-card");
        if (card) {
          this.setStrategy(video, RAM_CONFIG.BUFFER_STRATEGY.INITIAL);
          restored++;
        }
      }
      console.log(`[BufferMgr] Restored ${restored} buffers`);
    },

    getStats() {
      let stats = {
        totalManaged: this.managedVideos.size,
        activeBuffers: 0,
        estimatedRAM: this.totalEstimatedRAM,
        bufferingInProgress: this._bufferingInProgress.size,
        queueLength: this._initialBufferQueue.length,
        byStrategy: {},
      };
      for (const [, info] of this.managedVideos) {
        stats.byStrategy[info.strategy] =
          (stats.byStrategy[info.strategy] || 0) + 1;
        if (
          info.strategy !== RAM_CONFIG.BUFFER_STRATEGY.NONE &&
          info.strategy !== RAM_CONFIG.BUFFER_STRATEGY.METADATA
        ) {
          stats.activeBuffers++;
        }
      }
      return stats;
    },
  };

  window.RAM_CONFIG = RAM_CONFIG;
  window.BufferManager = BufferManager;

  console.log("[BufferManager] Module loaded successfully ✅");
  console.log("[BufferManager] Config:", {
    maxActivePreviews: RAM_CONFIG.MAX_ACTIVE_PREVIEWS,
    maxTotalRAM:
      (RAM_CONFIG.MAX_TOTAL_BUFFER_RAM / 1024 / 1024).toFixed(0) + "MB",
    bufferTargets: RAM_CONFIG.BUFFER_TARGETS,
    metadataTimeout: RAM_CONFIG.METADATA_TIMEOUT_MS + "ms",
    evictionCooldown: RAM_CONFIG.EVICTION_COOLDOWN_MS + "ms",
  });
})();
