// content.js - Stable DOM + SINGLE PLAYBACK + LIGHTWEIGHT CHUNK PREVIEWS + RAM optimized
// + SMART BUFFER BOOST for main videos AND previews (ported from nsfwph-fastream-extension)
// BACKGROUND TAB FIX: chunk previews, interval, and MutationObserver all pause when tab is hidden
let videos = new Map(); // video element → entry
let videoCards = new Map(); // video element → card DOM element
let currentlyPlaying = null; // Global: only one video plays at a time
let videoCounter = 0;
let panel = null;
let isPanelVisible = true;
let globalResources = {
  observers: [],
  intervals: [],
};
// Tracks whether the tab is currently visible to the user
let tabIsVisible = !document.hidden;
// Keeps a reference to the MutationObserver so we can disconnect/reconnect it
let domObserver = null;
// Keeps a reference to the polling interval so we can clear/restart it
let pollingInterval = null;
const MAX_GALLERY_ITEMS = 6;
const SELECTOR = ".message-inner video";
// Settings for lightweight chunk preview (2-3 second moving clips that loop)
const NUM_PREVIEW_CHUNKS = 5;
const CHUNK_PLAY_DURATION_MS = 400; // 0.4s per chunk → ~2s full cycle

// ═══════════════════════════════════════════════════════════════
// BUFFER BOOST ENGINE (ported from nsfwph-fastream-extension)
// Now supports both main videos AND preview videos
// ═══════════════════════════════════════════════════════════════
const BOOST_CONFIG = {
  BUFFER_LOW: 5,
  BOOST_DURATION: 8000,
  INITIAL_BUFFER_TARGET: 12,
  SEEK_BOOST_RATE: 1.5,
  SEEK_BOOST_DURATION: 10000,
  SEEK_MIN_EFFECTIVE_RATIO: 0.6,
  SEEK_BOOST_EXTENSION: 5000,
  MAX_BOOST_EXTENSIONS: 3,
  MAX_TOTAL_BOOST_MS: 30000,
  BOOST_RATE_NORMAL: 1.08,
  PREVIEW_BOOST_RATE: 1.08,
  PREVIEW_BOOST_DURATION: 4000,
  PREVIEW_BUFFER_TARGET: 3,
  PREVIEW_CHECK_INTERVAL: 500,
};

const boostTimers = new WeakMap();
const previewBoostTimers = new WeakMap();
let chatRoot = null;

// ═══════════════════════════════════════════════════════════════
// CHUNK CACHE SYSTEM
// ═══════════════════════════════════════════════════════════════
const ChunkCacheDB = {
  DB_NAME: "NsfwphPreviewCache",
  DB_VERSION: 1,
  STORE_NAME: "chunkCache",
  MAX_ENTRIES: 50,
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
  db: null,
  initPromise: null,

  async init() {
    if (this.db) return this.db;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      console.log("[ChunkCacheDB] Initializing IndexedDB...");
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = (event) => {
        console.error(
          "[ChunkCacheDB] Failed to open database:",
          event.target.error,
        );
        this.initPromise = null;
        reject(event.target.error);
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        this.db.onclose = () => {
          console.warn(
            "[ChunkCacheDB] Database connection closed unexpectedly",
          );
          this.db = null;
          this.initPromise = null;
        };
        console.log("[ChunkCacheDB] Database opened successfully");
        this.cleanupOldEntries().then(() => {
          resolve(this.db);
        });
      };

      request.onupgradeneeded = (event) => {
        console.log("[ChunkCacheDB] Creating/upgrading database...");
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, {
            keyPath: "videoSrc",
          });
          store.createIndex("timestamp", "timestamp", { unique: false });
          store.createIndex("accessCount", "accessCount", { unique: false });
          console.log("[ChunkCacheDB] Object store created with indexes");
        }
      };
    });

    return this.initPromise;
  },

  async get(videoSrc) {
    try {
      await this.init();
      if (!this.db) {
        console.warn("[ChunkCacheDB] Database not available, skipping read");
        return null;
      }

      return new Promise((resolve) => {
        let transaction;
        try {
          transaction = this.db.transaction([this.STORE_NAME], "readwrite");
        } catch (err) {
          console.error("[ChunkCacheDB] Failed to create transaction:", err);
          resolve(null);
          return;
        }

        const store = transaction.objectStore(this.STORE_NAME);
        const request = store.get(videoSrc);

        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) {
            console.log(
              `[ChunkCacheDB] Cache miss for ${videoSrc.substring(0, 60)}...`,
            );
            resolve(null);
            return;
          }
          if (Date.now() - entry.timestamp > this.MAX_AGE_MS) {
            console.log(
              `[ChunkCacheDB] Cache expired for ${videoSrc.substring(0, 60)}...`,
            );
            try {
              store.delete(videoSrc);
            } catch (err) {
              /* silent */
            }
            resolve(null);
            return;
          }
          entry.accessCount = (entry.accessCount || 0) + 1;
          entry.lastAccessed = Date.now();
          try {
            store.put(entry);
          } catch (err) {
            /* silent */
          }
          console.log(
            `[ChunkCacheDB] Cache hit for ${videoSrc.substring(0, 60)}... (accessed ${entry.accessCount} times)`,
          );
          resolve({ chunks: entry.chunks, duration: entry.duration });
        };

        request.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error in get():", error);
      return null;
    }
  },

  async set(videoSrc, chunks, duration) {
    try {
      await this.init();
      if (!this.db) {
        console.warn("[ChunkCacheDB] Database not available, skipping write");
        return;
      }

      this.getCacheSize().then((size) => {
        if (size >= this.MAX_ENTRIES) {
          console.log(
            `[ChunkCacheDB] Cache full (${size}/${this.MAX_ENTRIES}), evicting oldest entries...`,
          );
          this.evictOldest(5);
        }
      });

      return new Promise((resolve) => {
        let transaction;
        try {
          transaction = this.db.transaction([this.STORE_NAME], "readwrite");
        } catch (err) {
          console.error("[ChunkCacheDB] Failed to create transaction:", err);
          resolve();
          return;
        }

        const store = transaction.objectStore(this.STORE_NAME);
        const entry = {
          videoSrc,
          chunks,
          duration,
          timestamp: Date.now(),
          lastAccessed: Date.now(),
          accessCount: 1,
        };

        const request = store.put(entry);
        request.onsuccess = () => {
          console.log(
            `[ChunkCacheDB] Cached ${chunks.length} chunks for ${videoSrc.substring(0, 60)}...`,
          );
          resolve();
        };
        request.onerror = () => resolve();
        transaction.onabort = () => resolve();
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error in set():", error);
    }
  },

  async getCacheSize() {
    try {
      await this.init();
      if (!this.db) return 0;
      return new Promise((resolve) => {
        let transaction;
        try {
          transaction = this.db.transaction([this.STORE_NAME], "readonly");
        } catch (err) {
          resolve(0);
          return;
        }
        const store = transaction.objectStore(this.STORE_NAME);
        const request = store.count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(0);
        transaction.onabort = () => resolve(0);
      });
    } catch (error) {
      return 0;
    }
  },

  async evictOldest(count) {
    try {
      await this.init();
      if (!this.db) return;
      return new Promise((resolve) => {
        let transaction;
        try {
          transaction = this.db.transaction([this.STORE_NAME], "readwrite");
        } catch (err) {
          resolve();
          return;
        }
        const store = transaction.objectStore(this.STORE_NAME);
        const index = store.index("timestamp");
        let evicted = 0;
        index.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor && evicted < count) {
            console.log(
              `[ChunkCacheDB] Evicting cached entry for ${cursor.value.videoSrc.substring(0, 60)}...`,
            );
            cursor.delete();
            evicted++;
            cursor.continue();
          } else {
            resolve();
          }
        };
        index.openCursor().onerror = () => resolve();
        transaction.onabort = () => resolve();
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error evicting entries:", error);
    }
  },

  async cleanupOldEntries() {
    try {
      await this.init();
      if (!this.db) return;
      return new Promise((resolve) => {
        let transaction;
        try {
          transaction = this.db.transaction([this.STORE_NAME], "readwrite");
        } catch (err) {
          resolve();
          return;
        }
        const store = transaction.objectStore(this.STORE_NAME);
        const index = store.index("timestamp");
        const now = Date.now();
        let cleaned = 0;
        index.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            if (now - cursor.value.timestamp > this.MAX_AGE_MS) {
              console.log(
                `[ChunkCacheDB] Removing expired cache for ${cursor.value.videoSrc.substring(0, 60)}...`,
              );
              cursor.delete();
              cleaned++;
            }
            cursor.continue();
          } else {
            if (cleaned > 0)
              console.log(
                `[ChunkCacheDB] Cleaned up ${cleaned} expired entries`,
              );
            resolve();
          }
        };
        index.openCursor().onerror = () => resolve();
        transaction.onabort = () => resolve();
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error cleaning up:", error);
    }
  },

  async clear() {
    try {
      await this.init();
      if (!this.db) return;
      return new Promise((resolve) => {
        let transaction;
        try {
          transaction = this.db.transaction([this.STORE_NAME], "readwrite");
        } catch (err) {
          resolve();
          return;
        }
        const store = transaction.objectStore(this.STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => {
          console.log("[ChunkCacheDB] Cache cleared");
          resolve();
        };
        request.onerror = () => resolve();
        transaction.onabort = () => resolve();
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error clearing cache:", error);
    }
  },

  async getStats() {
    try {
      await this.init();
      if (!this.db) return { totalEntries: 0, totalChunks: 0 };
      return new Promise((resolve) => {
        let transaction;
        try {
          transaction = this.db.transaction([this.STORE_NAME], "readonly");
        } catch (err) {
          resolve({ totalEntries: 0, totalChunks: 0 });
          return;
        }
        const store = transaction.objectStore(this.STORE_NAME);
        let totalEntries = 0;
        let totalChunks = 0;
        store.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            totalEntries++;
            totalChunks += cursor.value.chunks?.length || 0;
            cursor.continue();
          } else {
            resolve({
              totalEntries,
              totalChunks,
              maxEntries: this.MAX_ENTRIES,
              maxAge: this.MAX_AGE_MS / (60 * 60 * 1000) + " hours",
            });
          }
        };
        store.openCursor().onerror = () =>
          resolve({ totalEntries: 0, totalChunks: 0 });
        transaction.onabort = () =>
          resolve({ totalEntries: 0, totalChunks: 0 });
      });
    } catch (error) {
      return { totalEntries: 0, totalChunks: 0 };
    }
  },
};

const ChunkCache = {
  memoryCache: new Map(),
  MAX_MEMORY_ENTRIES: 10,

  async get(videoSrc) {
    if (!videoSrc || typeof videoSrc !== "string") {
      console.error(
        "[ChunkCache] Invalid videoSrc for cache lookup:",
        videoSrc,
      );
      return null;
    }
    if (this.memoryCache.has(videoSrc)) {
      const entry = this.memoryCache.get(videoSrc);
      console.log(
        `[ChunkCache] L1 memory cache hit for ${videoSrc.substring(0, 60)}...`,
      );
      return entry;
    }
    console.log(
      `[ChunkCache] L1 miss, checking L2 IndexedDB for ${videoSrc.substring(0, 60)}...`,
    );
    const dbEntry = await ChunkCacheDB.get(videoSrc);
    if (dbEntry) {
      this.promoteToMemory(videoSrc, dbEntry);
      console.log(`[ChunkCache] Promoted to L1 cache from IndexedDB`);
      return dbEntry;
    }
    console.log(
      `[ChunkCache] Cache miss (both L1 and L2) for ${videoSrc.substring(0, 60)}...`,
    );
    return null;
  },

  async set(videoSrc, chunks, duration) {
    if (!videoSrc || typeof videoSrc !== "string") {
      console.error("[ChunkCache] Invalid videoSrc for cache store:", videoSrc);
      return;
    }
    if (!chunks || !Array.isArray(chunks)) {
      console.error("[ChunkCache] Invalid chunks for cache store:", chunks);
      return;
    }
    const entry = { chunks, duration };
    this.promoteToMemory(videoSrc, entry);
    ChunkCacheDB.set(videoSrc, chunks, duration).catch((err) => {
      console.warn("[ChunkCache] Failed to store in IndexedDB:", err);
    });
    console.log(
      `[ChunkCache] Cached ${chunks.length} chunks in both L1 and L2`,
    );
  },

  promoteToMemory(videoSrc, entry) {
    if (this.memoryCache.size >= this.MAX_MEMORY_ENTRIES) {
      const oldestKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(oldestKey);
      console.log(`[ChunkCache] Evicted oldest L1 entry`);
    }
    this.memoryCache.set(videoSrc, entry);
  },

  async clear() {
    this.memoryCache.clear();
    await ChunkCacheDB.clear();
    console.log("[ChunkCache] Both L1 and L2 caches cleared");
  },

  async getStats() {
    const dbStats = await ChunkCacheDB.getStats();
    return {
      memoryEntries: this.memoryCache.size,
      maxMemoryEntries: this.MAX_MEMORY_ENTRIES,
      dbEntries: dbStats.totalEntries,
      maxDbEntries: dbStats.maxEntries,
      dbChunks: dbStats.totalChunks,
      cacheAge: dbStats.maxAge,
    };
  },
};

// Log cache stats on initialization
(async () => {
  try {
    const stats = await ChunkCache.getStats();
    console.log("[ChunkCache] Cache stats:", stats);
  } catch (error) {
    console.warn("[ChunkCache] Could not get cache stats:", error);
  }
})();

// ═══════════════════════════════════════════════════════════════
// RAM MANAGEMENT CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const RAM_CONFIG = {
  // 🔧 FIX: Allow more previews to stay buffered since each is small
  MAX_ACTIVE_PREVIEWS: 8, // Was 3 - too aggressive

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

  // 🔧 FIX: More realistic RAM estimate for 8 previews
  MAX_TOTAL_BUFFER_RAM: 20 * 1024 * 1024, // 20MB (was 10MB)
};

/**
 * Smart buffer manager that controls how much video data is buffered
 * to prevent RAM overuse across multiple previews and tabs.
 */
const BufferManager = {
  // Track all preview videos and their buffer state
  managedVideos: new Map(), // previewVideo → { strategy, lastAccess, entryId }
  activeBufferCount: 0,
  totalEstimatedRAM: 0,

  /**
   * Register a preview video for buffer management.
   */
  register(previewVideo, entryId) {
    if (this.managedVideos.has(previewVideo)) return;

    this.managedVideos.set(previewVideo, {
      strategy: RAM_CONFIG.BUFFER_STRATEGY.NONE,
      lastAccess: 0,
      entryId,
      bufferTarget: 0,
    });

    console.log(`[BufferMgr] Registered preview for ${entryId}`);
  },

  /**
   * Unregister a preview video (when it's being cleaned up).
   */
  unregister(previewVideo) {
    this.releaseBuffer(previewVideo);
    this.managedVideos.delete(previewVideo);
  },

  /**
   * Set the buffer strategy for a preview video.
   * Automatically enforces global RAM limits.
   */
  async setStrategy(previewVideo, strategy) {
    if (!this.managedVideos.has(previewVideo)) return;

    const info = this.managedVideos.get(previewVideo);
    const oldStrategy = info.strategy;
    info.strategy = strategy;
    info.lastAccess = Date.now();
    info.bufferTarget = RAM_CONFIG.BUFFER_TARGETS[strategy];

    console.log(`[BufferMgr] ${info.entryId}: ${oldStrategy} → ${strategy}`);

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

    // Enforce global limits
    this.enforceLimits();
  },

  /**
   * Release buffer memory by unloading the video source.
   */
  releaseBuffer(previewVideo) {
    if (!previewVideo || previewVideo.dataset.bufferReleased === "true") return;

    const info = this.managedVideos.get(previewVideo);
    const wasPlaying = !previewVideo.paused;

    // Pause first
    previewVideo.pause();

    // Store the src so we can restore it later
    if (!previewVideo.dataset.savedSrc) {
      previewVideo.dataset.savedSrc = previewVideo.src;
    }

    // Remove source to free decoded frames from RAM
    previewVideo.removeAttribute("src");
    previewVideo.load();
    previewVideo.dataset.bufferReleased = "true";

    if (info) {
      this.activeBufferCount = Math.max(0, this.activeBufferCount - 1);
      this.totalEstimatedRAM = Math.max(0, this.totalEstimatedRAM - 500000); // ~500KB
    }

    console.log(
      `[BufferMgr] Released buffer for ${info?.entryId || "unknown"}`,
    );
  },

  /**
   * Light buffer - just load metadata, no video data.
   */
  lightBuffer(previewVideo) {
    previewVideo.preload = "metadata";

    if (previewVideo.dataset.bufferReleased === "true") {
      previewVideo.src = previewVideo.dataset.savedSrc || "";
      previewVideo.dataset.bufferReleased = "false";
      previewVideo.load();
    }
  },

  /**
   * Initial buffer - buffer first 2 seconds for visible previews.
   * 🔧 FIX: Handle play/pause conflicts gracefully.
   */
  async initialBuffer(previewVideo, info) {
    if (!tabIsVisible) return;

    // Restore source if it was released
    if (previewVideo.dataset.bufferReleased === "true") {
      previewVideo.src = previewVideo.dataset.savedSrc || "";
      previewVideo.dataset.bufferReleased = "false";
      previewVideo.load();
    }

    previewVideo.preload = "auto";

    // Wait for metadata
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

    // Don't buffer if video is too short
    if (previewVideo.duration < 1) {
      console.log(
        `[BufferMgr] Video too short for ${info.entryId}, skipping buffer`,
      );
      return;
    }

    // 🔧 FIX: Check if something else is controlling playback
    if (previewVideo.dataset.chunkLoopActive === "true") {
      console.log(
        `[BufferMgr] Chunk loop active for ${info.entryId}, skipping initial buffer`,
      );
      return;
    }

    // Seek to start to trigger buffering of the beginning
    previewVideo.currentTime = 0;

    // 🔧 FIX: Use a flag to prevent conflicts
    previewVideo.dataset.bufferManagerBuffering = "true";

    try {
      // Brief play to start buffering
      await previewVideo.play();

      // Wait for ~2 seconds of buffer or 800ms max (reduced from 500ms to allow more time)
      await this.waitForBuffer(previewVideo, 2, 800);

      // Only pause if we're still the ones controlling playback
      if (previewVideo.dataset.bufferManagerBuffering === "true") {
        previewVideo.pause();
      }

      this.activeBufferCount++;
      this.totalEstimatedRAM += 500000;
      console.log(`[BufferMgr] Initial buffer complete for ${info.entryId}`);
    } catch (err) {
      // 🔧 FIX: Don't log as error if it's just an interruption
      if (err.name === "AbortError") {
        console.log(
          `[BufferMgr] Initial buffer interrupted for ${info.entryId} (chunk loop took over)`,
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
   * Active buffer - buffer multiple chunks for hovered preview.
   */
  async activeBuffer(previewVideo, info) {
    if (!tabIsVisible) return;

    // Already has initial buffer, just extend it
    const ahead = getBufferAhead(previewVideo);
    if (ahead >= 5) return; // Already enough

    // Resume playback briefly to fill buffer
    if (previewVideo.paused) {
      try {
        await previewVideo.play();
        await this.waitForBuffer(previewVideo, 5, 2000);
        // Don't pause - let the chunk loop handle it
      } catch (err) {
        console.warn(`[BufferMgr] Active buffer failed:`, err.message);
      }
    }
  },

  /**
   * Wait until the video has buffered up to target seconds or timeout.
   */
  waitForBuffer(video, targetSeconds, maxWaitMs) {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const check = () => {
        const ahead = getBufferAhead(video);
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
   * Enforce global RAM limits with smarter eviction.
   * 🔧 FIX: Don't evict previews that were buffered in the last 2 seconds.
   */
  enforceLimits() {
    const COOLDOWN_MS = 2000; // Don't evict previews buffered within last 2 seconds

    let activeVideos = [];
    for (const [video, info] of this.managedVideos) {
      if (
        info.strategy === RAM_CONFIG.BUFFER_STRATEGY.ACTIVE ||
        info.strategy === RAM_CONFIG.BUFFER_STRATEGY.INITIAL
      ) {
        activeVideos.push({ video, info });
      }
    }

    // If under limit, nothing to do
    if (
      activeVideos.length <= RAM_CONFIG.MAX_ACTIVE_PREVIEWS &&
      this.totalEstimatedRAM <= RAM_CONFIG.MAX_TOTAL_BUFFER_RAM
    ) {
      return;
    }

    // 🔧 FIX: Filter out recently buffered previews
    const now = Date.now();
    const eligibleForEviction = activeVideos.filter(
      (v) => now - v.info.lastAccess > COOLDOWN_MS,
    );

    // If nothing eligible, relax the limit temporarily
    if (eligibleForEviction.length === 0) {
      console.log(
        `[BufferMgr] All buffers within cooldown, relaxing limit temporarily`,
      );
      return;
    }

    // Sort by last access (oldest first)
    eligibleForEviction.sort((a, b) => a.info.lastAccess - b.info.lastAccess);

    // Evict oldest eligible until we're under limits
    let evicted = 0;
    while (
      activeVideos.length - evicted > RAM_CONFIG.MAX_ACTIVE_PREVIEWS ||
      this.totalEstimatedRAM > RAM_CONFIG.MAX_TOTAL_BUFFER_RAM
    ) {
      const oldest = eligibleForEviction.shift();
      if (!oldest) break;

      console.log(
        `[BufferMgr] Evicting buffer for ${oldest.info.entryId} (RAM pressure, last access ${now - oldest.info.lastAccess}ms ago)`,
      );
      this.setStrategy(oldest.video, RAM_CONFIG.BUFFER_STRATEGY.METADATA);
      evicted++;
    }
  },

  /**
   * Handle tab hidden: release ALL buffers to save RAM.
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
   * Handle tab visible: restore buffers for visible previews only.
   */
  onTabVisible() {
    // Only restore buffers for previews currently visible in the panel
    let restored = 0;
    for (const [video, info] of this.managedVideos) {
      // Check if the video/card is actually visible in the viewport
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
   * Check if an element is visible in the viewport.
   */
  isElementInViewport(el) {
    const rect = el.getBoundingClientRect();
    const panelEl = document.getElementById("video-observer-panel");

    // If in the floating panel, check against panel bounds
    if (panelEl && panelEl.contains(el)) {
      const panelRect = panelEl.getBoundingClientRect();
      return (
        rect.top >= panelRect.top &&
        rect.bottom <= panelRect.bottom &&
        rect.left >= panelRect.left &&
        rect.right <= panelRect.right
      );
    }

    // Otherwise check against viewport
    return (
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.left >= 0 &&
      rect.right <= window.innerWidth
    );
  },

  /**
   * Get buffer statistics for debugging.
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
// BUFFER BOOST FUNCTIONS (unchanged from original)
// ═══════════════════════════════════════════════════════════════
function getBufferAhead(video) {
  if (!video.buffered || !video.buffered.length) return 0;
  const ahead =
    video.buffered.end(video.buffered.length - 1) - video.currentTime;
  return ahead < 0 ? 0 : ahead;
}

function getEffectiveBufferRatio(video) {
  if (!video.buffered || !video.buffered.length) return 0;
  let totalBuffered = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    totalBuffered += video.buffered.end(i) - video.buffered.start(i);
  }
  const ahead = getBufferAhead(video);
  return totalBuffered > 0 ? Math.min(1, ahead / totalBuffered) : 1;
}

function cleanupBoost(video) {
  if (!video) return;
  const timers = boostTimers.get(video);
  if (timers) {
    if (timers.boostTimeout) clearTimeout(timers.boostTimeout);
    if (timers.monitorInterval) clearInterval(timers.monitorInterval);
    boostTimers.delete(video);
  }
  if (video.__boostTimeout) {
    clearTimeout(video.__boostTimeout);
    delete video.__boostTimeout;
  }
  if (video.__boostState) {
    video.__boostState.active = false;
    video.__boostState.paused = true;
  }
  if (
    video.__originalPlaybackRate &&
    video.playbackRate === video.__boostTargetRate
  ) {
    video.playbackRate = video.__originalPlaybackRate;
  }
  delete video.__originalPlaybackRate;
  delete video.__boostTargetRate;
  delete video.__boostStartTime;
  delete video.__boostExtensionCount;
  delete video.__boostBaseDuration;
  delete video.__hasBoostedOnLoad;
}

function cleanupPreviewBoost(previewVideo) {
  if (!previewVideo) return;
  const timers = previewBoostTimers.get(previewVideo);
  if (timers) {
    if (timers.checkInterval) clearInterval(timers.checkInterval);
    if (timers.endTimeout) clearTimeout(timers.endTimeout);
    previewBoostTimers.delete(previewVideo);
  }
  if (
    previewVideo.__previewOriginalRate &&
    previewVideo.playbackRate === BOOST_CONFIG.PREVIEW_BOOST_RATE
  ) {
    previewVideo.playbackRate = previewVideo.__previewOriginalRate;
  }
  delete previewVideo.__previewOriginalRate;
  delete previewVideo.__previewBoostActive;
  delete previewVideo.__previewBoostStartTime;
}

function boostPreviewBuffer(previewVideo) {
  if (!previewVideo || !tabIsVisible) return () => {};
  if (previewVideo.__previewBoostActive) return () => {};
  if (!previewVideo.paused) {
    previewVideo.pause();
  }
  if (!previewVideo.__previewOriginalRate) {
    previewVideo.__previewOriginalRate = previewVideo.playbackRate || 1.0;
  }
  const initialAhead = getBufferAhead(previewVideo);
  if (initialAhead >= BOOST_CONFIG.PREVIEW_BUFFER_TARGET) {
    return () => {};
  }
  previewVideo.__previewBoostActive = true;
  previewVideo.__previewBoostStartTime = Date.now();
  previewVideo.playbackRate = BOOST_CONFIG.PREVIEW_BOOST_RATE;
  const timers = { checkInterval: null, endTimeout: null };
  previewBoostTimers.set(previewVideo, timers);
  timers.checkInterval = setInterval(() => {
    if (!tabIsVisible || !previewVideo.__previewBoostActive) {
      cleanupPreviewBoost(previewVideo);
      return;
    }
    const ahead = getBufferAhead(previewVideo);
    const elapsed = Date.now() - (previewVideo.__previewBoostStartTime || 0);
    if (
      ahead >= BOOST_CONFIG.PREVIEW_BUFFER_TARGET ||
      elapsed >= BOOST_CONFIG.PREVIEW_BOOST_DURATION
    ) {
      cleanupPreviewBoost(previewVideo);
    }
  }, BOOST_CONFIG.PREVIEW_CHECK_INTERVAL);
  timers.endTimeout = setTimeout(() => {
    cleanupPreviewBoost(previewVideo);
  }, BOOST_CONFIG.PREVIEW_BOOST_DURATION + 200);
  return () => cleanupPreviewBoost(previewVideo);
}

function boostBufferAfterSeek(video, isSeek = false, options = {}) {
  if (!video || !tabIsVisible) return;
  const { extendDuration = false } = options;
  let timers = boostTimers.get(video);
  if (!timers) {
    timers = { boostTimeout: null, monitorInterval: null };
    boostTimers.set(video, timers);
  }
  let rate = isSeek
    ? BOOST_CONFIG.SEEK_BOOST_RATE
    : BOOST_CONFIG.BOOST_RATE_NORMAL;
  if (isSeek) {
    const initialAhead = getBufferAhead(video);
    if (initialAhead < 2) {
      rate = Math.min(rate, 1.25);
    }
  }
  let duration = isSeek
    ? BOOST_CONFIG.SEEK_BOOST_DURATION
    : BOOST_CONFIG.BOOST_DURATION;
  if (extendDuration && isSeek) {
    duration = Math.min(
      duration + BOOST_CONFIG.SEEK_BOOST_EXTENSION,
      BOOST_CONFIG.SEEK_BOOST_DURATION + BOOST_CONFIG.SEEK_BOOST_EXTENSION,
    );
  }
  if (!video.__originalPlaybackRate) {
    video.__originalPlaybackRate = video.playbackRate || 1.0;
  }
  const targetRate = rate;
  video.__boostTargetRate = targetRate;
  video.playbackRate = targetRate;
  video.__boostStartTime = Date.now();
  video.__boostExtensionCount = 0;
  video.__boostBaseDuration = duration;
  video.__boostState = {
    active: true,
    extensionCount: 0,
    paused: video.paused,
  };
  function evaluateBoost() {
    if (!video.__boostState?.active || !tabIsVisible) return;
    if (video.paused) {
      video.__boostState.paused = true;
      return;
    }
    video.__boostState.paused = false;
    const currentAhead = getBufferAhead(video);
    const elapsed = Date.now() - video.__boostStartTime;
    let endReason = null;
    if (currentAhead >= BOOST_CONFIG.BUFFER_LOW * 1.5) {
      endReason = "buffer healthy";
    } else if (
      video.__boostState.extensionCount >= BOOST_CONFIG.MAX_BOOST_EXTENSIONS
    ) {
      endReason = `max extensions (${BOOST_CONFIG.MAX_BOOST_EXTENSIONS})`;
    } else if (elapsed > BOOST_CONFIG.MAX_TOTAL_BOOST_MS) {
      endReason = `max total time (${BOOST_CONFIG.MAX_TOTAL_BOOST_MS / 1000}s)`;
    } else if (
      elapsed >
      video.__boostBaseDuration +
        video.__boostState.extensionCount * BOOST_CONFIG.SEEK_BOOST_EXTENSION
    ) {
      if (
        video.__boostState.extensionCount < BOOST_CONFIG.MAX_BOOST_EXTENSIONS &&
        elapsed <= BOOST_CONFIG.MAX_TOTAL_BOOST_MS
      ) {
        video.__boostState.extensionCount++;
        if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
        video.__boostTimeout = setTimeout(
          evaluateBoost,
          BOOST_CONFIG.SEEK_BOOST_EXTENSION,
        );
        if (timers) timers.boostTimeout = video.__boostTimeout;
        return;
      } else {
        endReason = "max limits reached";
      }
    }
    if (endReason) {
      if (video.playbackRate === targetRate) {
        video.playbackRate = video.__originalPlaybackRate || 1.0;
      }
      video.__boostState.active = false;
    }
    if (video.__boostTimeout) {
      clearTimeout(video.__boostTimeout);
      video.__boostTimeout = null;
      if (timers) timers.boostTimeout = null;
    }
  }
  if (timers.boostTimeout) clearTimeout(timers.boostTimeout);
  if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
  video.__boostTimeout = setTimeout(evaluateBoost, duration);
  timers.boostTimeout = video.__boostTimeout;
}

function attachBoostToVideo(video) {
  if (!video || video.dataset.boostAttached === "true") return () => {};
  video.dataset.boostAttached = "true";
  const initialCheck = setTimeout(() => {
    if (!tabIsVisible) return;
    const ahead = getBufferAhead(video);
    if (
      ahead < BOOST_CONFIG.INITIAL_BUFFER_TARGET &&
      !video.__hasBoostedOnLoad
    ) {
      boostBufferAfterSeek(video, false);
      video.__hasBoostedOnLoad = true;
    }
  }, 600);
  const onSeeked = () => {
    if (!tabIsVisible) return;
    const ratio = getEffectiveBufferRatio(video);
    const needsExtension = ratio < BOOST_CONFIG.SEEK_MIN_EFFECTIVE_RATIO;
    boostBufferAfterSeek(video, true, { extendDuration: needsExtension });
  };
  const onPlay = () => {
    if (!tabIsVisible) return;
    if (video.__boostState?.active && video.__boostState.paused) {
      video.__boostState.paused = false;
      const timers = boostTimers.get(video);
      if (timers?.boostTimeout) {
        clearTimeout(timers.boostTimeout);
        const remaining = Math.max(
          1000,
          (video.__boostBaseDuration || BOOST_CONFIG.BOOST_DURATION) -
            (Date.now() - (video.__boostStartTime || Date.now())),
        );
        if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
        video.__boostTimeout = setTimeout(
          () => {
            if (video.__boostState?.active) {
              const ahead = getBufferAhead(video);
              if (ahead >= BOOST_CONFIG.BUFFER_LOW * 1.5) {
                video.playbackRate = video.__originalPlaybackRate || 1.0;
                video.__boostState.active = false;
              }
            }
          },
          Math.min(remaining, 5000),
        );
        timers.boostTimeout = video.__boostTimeout;
      }
    }
  };
  const onPause = () => {
    if (video.__boostState?.active) {
      video.__boostState.paused = true;
    }
  };
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  return () => {
    clearTimeout(initialCheck);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    cleanupBoost(video);
    delete video.dataset.boostAttached;
  };
}

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
  }
  currentlyPlaying = videoToPlay;
  const onEnded = () => {
    if (currentlyPlaying === videoToPlay) currentlyPlaying = null;
  };
  videoToPlay.addEventListener("ended", onEnded, { once: true });
}

function log(message, data = null) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[nsfwPH ${ts}] ${message}`, data || "");
  if (panel && tabIsVisible) {
    const logsEl = panel.querySelector("#logs");
    if (logsEl) {
      const entry = document.createElement("div");
      entry.textContent = `[${ts}] ${message}`;
      logsEl.prepend(entry);
      if (logsEl.children.length > 60) logsEl.removeChild(logsEl.lastChild);
    }
  }
}

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
// LIGHTWEIGHT CHUNK PREVIEW
// ═══════════════════════════════════════════════════════════════
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

  async function loadChunkPositions() {
    if (state.chunkStarts && state.chunkStarts.length > 0) {
      console.log(`[Preview:D] Chunk positions already loaded for ${entryId}`);
      return;
    }
    console.log(`[Preview] Loading chunk positions for ${entryId}...`);
    console.log("[Preview:D] Looking up cache key:", { validatedCacheKey });
    try {
      const cached = await ChunkCache.get(validatedCacheKey);
      if (cached && cached.chunks && cached.chunks.length > 0) {
        console.log(
          `[Preview] ✅ CACHE HIT for ${entryId} (${cached.chunks.length} chunks, duration: ${cached.duration?.toFixed(1)}s)`,
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
      console.warn(`[Preview] Cache read failed for ${entryId}:`, err.message);
    }
    console.log(`[Preview] Calculating chunks for ${entryId}...`);
    calculateChunks();
  }

  function calculateChunks() {
    const duration = previewVideo.duration || 0;
    console.log(
      `[Preview:D] Video duration: ${duration.toFixed(2)}s, chunk duration: ${state.chunkDuration}s`,
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
    ChunkCache.set(validatedCacheKey, chunkStarts, duration)
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
          console.warn(`[Preview] ❌ Play failed for ${entryId}:`, err.message);
          if (state.isHovering && state.isRunning) {
            setTimeout(() => startContinuousPlayback(), 500);
          }
        });
    };
    previewVideo.addEventListener("seeked", onSeeked, { once: true });
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
            if (state.isHovering && state.isRunning)
              setTimeout(() => startContinuousPlayback(), 500);
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
          `[Preview] Chunk ${state.currentChunk + 1}→${nextChunk + 1} at ${nextChunkStart.toFixed(2)}s for ${entryId}`,
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
    if (state.isRunning) {
      return;
    }
    console.log(`[Preview] Starting chunk loop for ${entryId}`);
    state.isRunning = true;
    state.playbackStarted = false;

    // 🔧 NEW: Mark that chunk loop is active (prevents BufferManager conflicts)
    previewVideo.dataset.chunkLoopActive = "true";

    await loadChunkPositions();
    if (previewVideo.readyState >= 1 && previewVideo.duration > 0) {
      console.log(
        `[Preview:D] Video ready (readyState: ${previewVideo.readyState}, duration: ${previewVideo.duration.toFixed(1)}s)`,
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
      previewVideo.addEventListener("loadedmetadata", onReady, { once: true });
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

    // 🔧 NEW: Clear chunk loop active flag
    delete previewVideo.dataset.chunkLoopActive;

    stopPlayback();
  }

  function onMouseEnter() {
    if (!tabIsVisible) {
      return;
    }

    // 🔧 FIX: Cancel any pending buffer downgrade
    clearTimeout(previewVideo._downgradeTimeout);

    console.log(`[Preview] Mouse entered ${entryId}`);
    state.isHovering = true;

    BufferManager.setStrategy(previewVideo, RAM_CONFIG.BUFFER_STRATEGY.ACTIVE);

    if (!state.isRunning) {
      startLoop();
    }
  }

  function onMouseLeave() {
    console.log(`[Preview] Mouse left ${entryId}`);
    state.isHovering = false;

    // 🔧 FIX: Add a small delay before downgrading buffer
    // This prevents rapid strategy changes during quick hover/unhover
    clearTimeout(previewVideo._downgradeTimeout);
    previewVideo._downgradeTimeout = setTimeout(() => {
      if (!state.isHovering) {
        // Double-check still not hovering
        BufferManager.setStrategy(
          previewVideo,
          RAM_CONFIG.BUFFER_STRATEGY.METADATA,
        );
      }
    }, 2000); // Wait 2 seconds before releasing buffer

    stopLoop();
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

function createSinglePreview(originalVideo, entryId) {
  console.log(`[Preview] Creating preview video element for ${entryId}`);
  const rawSrc = originalVideo.currentSrc || originalVideo.src || "";
  const cleanSrc = rawSrc.split("?")[0];

  const entry = videos.get(originalVideo);
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
  // 🔧 FIX: Start with minimal preload - BufferManager will upgrade as needed
  preview.preload = "metadata";
  preview.style.width = "100%";
  preview.style.height = "auto";
  preview.style.maxHeight = "96px";
  preview.style.objectFit = "cover";
  preview.style.borderRadius = "4px";
  preview.style.background = "#1a1a2e";
  preview.style.display = "block";
  preview.style.cursor = "pointer";

  // 🔧 NEW: Register with BufferManager
  BufferManager.register(preview, entryId);

  let isInitialized = false;

  function initializePreview() {
    if (isInitialized) {
      return;
    }
    console.log(`[Preview] Initializing preview for ${entryId}`);
    isInitialized = true;

    const stopLoop = setupLightChunkPreview(preview, entryId, cleanSrc);
    preview._stopPreviewLoop = stopLoop;

    // 🔧 NEW: Smart buffer strategy based on visibility
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
 * Schedule smart buffering based on element visibility and tab state.
 */
function scheduleSmartBuffering(previewVideo, entryId) {
  // Don't buffer if tab is hidden
  if (!tabIsVisible) {
    BufferManager.setStrategy(previewVideo, RAM_CONFIG.BUFFER_STRATEGY.NONE);
    return;
  }

  // Check if the card is in the visible portion of the panel
  const card = previewVideo.closest(".video-card");
  if (card && BufferManager.isElementInViewport(card)) {
    // Visible in panel - give initial buffer
    BufferManager.setStrategy(previewVideo, RAM_CONFIG.BUFFER_STRATEGY.INITIAL);
  } else {
    // Off-screen - just load metadata
    BufferManager.setStrategy(
      previewVideo,
      RAM_CONFIG.BUFFER_STRATEGY.METADATA,
    );
  }

  // Log buffer stats periodically
  if (videoCounter % 4 === 0) {
    console.log("[BufferMgr] Stats:", BufferManager.getStats());
  }
}

// ═══════════════════════════════════════════════════════════════
// CARD CREATION & MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function createVideoCard(entry) {
  log(`Creating stable card DOM for ${entry.id}`);
  const card = document.createElement("div");
  card.className = "video-card";
  card.dataset.videoId = entry.id;
  card.innerHTML = `
    <div class="video-row">
      <div class="preview-container">
        <div class="thumb-placeholder"></div>
      </div>
      <div class="video-info">
        <div class="video-header">
          <strong>${entry.id}</strong>
          <div class="video-actions">
            <span class="video-status ${entry.info.paused ? "paused" : "playing"}">${entry.info.paused ? "⏸" : "▶"}</span>
            <button class="gallery-btn" title="Open preview gallery">📷</button>
          </div>
        </div>
        <div class="video-src" title="${entry.info.src}">${entry.info.src}</div>
        <div class="video-meta">${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s</div>
      </div>
    </div>
    <div class="time-selections">
      <small>Time selections</small>
      <div class="time-strip"></div>
    </div>
  `;

  card.addEventListener("click", (e) => {
    e.stopImmediatePropagation();
    const videoEl = entry.element;
    if (!videoEl) return;
    if (videoEl.dataset.clickInProgress === "true") return;
    videoEl.dataset.clickInProgress = "true";
    setTimeout(() => {
      delete videoEl.dataset.clickInProgress;
    }, 300);
    if (videoEl.paused) {
      enforceSinglePlayback(videoEl);
      videoEl.play().catch((err) => {
        console.warn("Play failed on card click", err);
      });
    } else {
      videoEl.pause();
      if (currentlyPlaying === videoEl) currentlyPlaying = null;
    }
    videoEl.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  return card;
}

function updateExistingCard(card, entry) {
  const statusEl = card.querySelector(".video-status");
  if (statusEl) {
    statusEl.className = `video-status ${entry.info.paused ? "paused" : "playing"}`;
    statusEl.textContent = entry.info.paused ? "⏸ Paused" : "▶ Playing";
  }
  const timeEl = card.querySelector(".video-meta");
  if (timeEl) {
    timeEl.textContent = `${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s`;
  }
  const placeholder = card.querySelector(".thumb-placeholder");
  if (placeholder && entry.preview) {
    log(`Replacing placeholder with real preview for ${entry.id}`);
    const container = card.querySelector(".preview-container");
    if (container) {
      container.innerHTML = "";
      container.appendChild(entry.preview);
    }
  }
}

function cleanupVideoEntry(entry) {
  if (!entry) return;
  log(`Cleaning up video entry for RAM optimization: ${entry.id}`);

  if (entry.boostCleanup) {
    entry.boostCleanup();
    entry.boostCleanup = null;
  }
  delete entry.cacheKeySrc;

  if (entry.preview) {
    // 🔧 NEW: Unregister from buffer manager
    BufferManager.unregister(entry.preview);

    cleanupPreviewBoost(entry.preview);
    if (typeof entry.preview._stopPreviewLoop === "function") {
      entry.preview._stopPreviewLoop();
      delete entry.preview._stopPreviewLoop;
    }
    entry.preview.pause();
    if (currentlyPlaying === entry.preview) currentlyPlaying = null;
    entry.preview.src = "";
    entry.preview.load();
    entry.preview = null;
  }

  if (entry.cleanups && entry.cleanups.length > 0) {
    entry.cleanups.forEach((cleanupFn) => cleanupFn());
    entry.cleanups = null;
  }
  if (entry.element && entry.element === currentlyPlaying) {
    currentlyPlaying = null;
  }
}

function trackVideo(video) {
  if (video.dataset.videoObserverAttached === "true") return;
  video.dataset.videoObserverAttached = "true";
  if (videos.has(video)) return;
  const id = `video-${++videoCounter}`;
  video.dataset.videoObserverId = id;
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
  entry.boostCleanup = attachBoostToVideo(video);
  const startPreview = () => {
    entry.preview = createSinglePreview(video, id);
    performPanelUpdate();
  };
  if (video.readyState >= 2) {
    startPreview();
  } else {
    const handler = () => startPreview();
    video.addEventListener("loadedmetadata", handler, { once: true });
    entry.cleanups.push(() =>
      video.removeEventListener("loadedmetadata", handler),
    );
  }
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
}

function performPanelUpdate() {
  if (!panel) return;
  const list = panel.querySelector("#videos-list");
  const countEl = panel.querySelector("#video-count");
  const empty = panel.querySelector("#empty-videos");
  countEl.textContent = videos.size;
  if (videos.size === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  Array.from(videos.values()).forEach((entry) => {
    let card;
    if (!videoCards.has(entry.element)) {
      card = createVideoCard(entry);
      videoCards.set(entry.element, card);
      list.appendChild(card);
    } else {
      card = videoCards.get(entry.element);
      updateExistingCard(card, entry);
    }
  });
  for (let [videoEl, entry] of Array.from(videos.entries())) {
    if (!document.body.contains(videoEl)) {
      cleanupVideoEntry(entry);
      videos.delete(videoEl);
      const card = videoCards.get(videoEl);
      if (card) {
        card.remove();
        videoCards.delete(videoEl);
      }
    }
  }
}

function observeVideos() {
  document.querySelectorAll(SELECTOR).forEach(trackVideo);
  performPanelUpdate();
}

function createFloatingPanel() {
  if (panel) return;
  panel = document.createElement("div");
  panel.id = "video-observer-panel";
  panel.innerHTML = `
    <header>🎥 Video Observer <button class="close-btn" id="toggle-panel">✕</button></header>
    <div class="tabs">
      <div class="tab active" data-tab="videos">Videos (<span id="video-count">0</span>)</div>
      <div class="tab" data-tab="logs">Logs</div>
    </div>
    <div id="videos-tab" class="content">
      <div id="videos-list"></div>
      <div id="empty-videos">No videos detected yet<br><small>Click card to toggle play/pause + scroll</small></div>
    </div>
    <div id="logs-tab" class="content" style="display:none">
      <div id="logs" class="log-container"></div>
    </div>
    <div class="status">Observing <strong>.message-inner video</strong> • ${new Date().toLocaleTimeString()}</div>
  `;
  document.body.appendChild(panel);
  panel.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      panel
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      panel.querySelector("#videos-tab").style.display =
        tab.dataset.tab === "videos" ? "block" : "none";
      panel.querySelector("#logs-tab").style.display =
        tab.dataset.tab === "logs" ? "block" : "none";
    });
  });
  panel.querySelector("#toggle-panel").addEventListener("click", () => {
    isPanelVisible = !isPanelVisible;
    panel.style.display = isPanelVisible ? "flex" : "none";
    if (!isPanelVisible && currentlyPlaying) {
      currentlyPlaying.pause();
      currentlyPlaying = null;
    }
  });
  performPanelUpdate();
}

// ═══════════════════════════════════════════════════════════════
// PAGE VISIBILITY MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function stopAllPreviewLoops() {
  for (const entry of videos.values()) {
    if (entry.preview && typeof entry.preview._stopPreviewLoop === "function") {
      entry.preview._stopPreviewLoop();
      delete entry.preview.dataset.previewLoopReady;
    }
  }
}

function restartAllPreviewLoops() {
  for (const entry of videos.values()) {
    if (entry.preview) {
      const cacheKeySrc = entry.cacheKeySrc || "";
      if (!cacheKeySrc) {
        console.warn(
          `[Preview] No cacheKeySrc stored for ${entry.id}, cannot restart loop`,
        );
        continue;
      }
      if (typeof entry.preview._stopPreviewLoop === "function") {
        entry.preview._stopPreviewLoop();
      }
      delete entry.preview.dataset.previewLoopReady;
      const stopFn = setupLightChunkPreview(
        entry.preview,
        entry.id,
        cacheKeySrc,
      );
      entry.preview._stopPreviewLoop = stopFn;
    }
  }
}

function stopAllBoosts() {
  for (const entry of videos.values()) {
    if (entry.boostCleanup) {
      cleanupBoost(entry.element);
    }
    if (entry.preview) {
      cleanupPreviewBoost(entry.preview);
    }
  }
}

function restartAllBoosts() {
  for (const entry of videos.values()) {
    if (entry.element && !entry.element.dataset.boostAttached) {
      entry.boostCleanup = attachBoostToVideo(entry.element);
    }
  }
}

function onTabHidden() {
  tabIsVisible = false;
  log("Tab hidden — pausing everything");
  stopAllPreviewLoops();
  stopAllBoosts();

  // 🔧 NEW: Release ALL video buffers to free RAM
  BufferManager.onTabHidden();

  if (currentlyPlaying) {
    currentlyPlaying.pause();
    currentlyPlaying = null;
  }
  if (pollingInterval !== null) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (domObserver) {
    domObserver.disconnect();
  }
}

function onTabVisible() {
  tabIsVisible = true;
  log("Tab visible — resuming everything");
  restartAllPreviewLoops();
  restartAllBoosts();

  // 🔧 NEW: Restore buffers only for visible previews
  BufferManager.onTabVisible();

  if (pollingInterval === null) {
    pollingInterval = setInterval(observeVideos, 30000);
    globalResources.intervals.push(pollingInterval);
  }
  if (domObserver) {
    domObserver.observe(chatRoot || document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
  }
  observeVideos();
}

// ═══════════════════════════════════════════════════════════════
// CLEANUP FUNCTIONS (FIXED - Preserves IndexedDB on page load)
// ═══════════════════════════════════════════════════════════════

/**
 * Clean up runtime resources only - preserves IndexedDB cache.
 * Called on every page load to reset in-memory state.
 */
function cleanupRuntimeResources() {
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
      cleanupPreviewBoost(entry.preview);
    }
  }

  // Clear in-memory L1 cache only (IndexedDB L2 is preserved)
  ChunkCache.memoryCache.clear();
}

/**
 * Full cleanup including IndexedDB - ONLY called on extension unload.
 */
function cleanupAllResources() {
  cleanupRuntimeResources();
  ChunkCache.clear().catch((err) => {
    console.warn("[Cleanup] Error clearing chunk cache:", err);
  });
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════
function waitForBody(callback) {
  if (document.body) return callback();
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect();
      callback();
    }
  });
  observer.observe(document.documentElement, { childList: true });
  setTimeout(() => {
    if (document.body) callback();
  }, 1500);
}

function init() {
  if (window.__VIDEO_OBSERVER_INITIALIZED__) return;
  window.__VIDEO_OBSERVER_INITIALIZED__ = true;

  // Only clean RUNTIME resources, preserve IndexedDB cache
  cleanupRuntimeResources();

  log(
    "Video Observer initialized – SINGLE PLAYBACK + CHUNK PREVIEWS + MAIN & PREVIEW BOOST + BACKGROUND PAUSE",
  );
  createFloatingPanel();
  log("Floating panel created.");
  observeVideos();
  log("Initial video observation performed.");

  let debounceTimer = null;
  domObserver = new MutationObserver((mutations) => {
    if (!tabIsVisible) return;
    const hasRelevantChange = mutations.some((m) =>
      Array.from(m.addedNodes).some(
        (node) =>
          node.nodeType === 1 && !node.closest?.("#video-observer-panel"),
      ),
    );
    if (!hasRelevantChange) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(observeVideos, 600);
  });

  chatRoot = document.querySelector(".messages-content, #messages, main, body");
  domObserver.observe(chatRoot || document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
  });
  globalResources.observers.push(domObserver);

  pollingInterval = setInterval(observeVideos, 30000);
  globalResources.intervals.push(pollingInterval);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      onTabHidden();
    } else {
      onTabVisible();
    }
  });

  log("Init complete — observer watching chat root for child additions only");
}

waitForBody(init);
