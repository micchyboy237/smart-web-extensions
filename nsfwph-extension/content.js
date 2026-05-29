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
  // Main video settings
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

  // 🆕 Preview video settings (much gentler, short-lived)
  PREVIEW_BOOST_RATE: 1.08, // Gentle - barely noticeable on muted previews
  PREVIEW_BOOST_DURATION: 4000, // 4 seconds max
  PREVIEW_BUFFER_TARGET: 3, // Only need 3s buffer for chunk previews
  PREVIEW_CHECK_INTERVAL: 500, // Check every 500ms (less aggressive)
};

// Store boost-related timers per video for cleanup
const boostTimers = new WeakMap();
// 🆕 Separate tracker for preview boost timers
const previewBoostTimers = new WeakMap();

let chatRoot = null;

// ═══════════════════════════════════════════════════════════════
// CHUNK CACHE SYSTEM
// ═══════════════════════════════════════════════════════════════

/**
 * IndexedDB-based cache for chunk preview data.
 * Survives page reloads and browser restarts.
 * Uses IndexedDB which is available in content scripts without permissions.
 */
const ChunkCacheDB = {
  DB_NAME: "NsfwphPreviewCache",
  DB_VERSION: 1,
  STORE_NAME: "chunkCache",
  MAX_ENTRIES: 50, // Maximum number of cached videos
  MAX_AGE_MS: 24 * 60 * 60 * 1000, // 24 hours cache lifetime
  db: null,
  initPromise: null,

  /**
   * Initialize the IndexedDB database
   */
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

        // Handle database close events (e.g., private browsing exit)
        this.db.onclose = () => {
          console.warn(
            "[ChunkCacheDB] Database connection closed unexpectedly",
          );
          this.db = null;
          this.initPromise = null;
        };

        console.log("[ChunkCacheDB] Database opened successfully");
        // Clean up old entries on initialization
        this.cleanupOldEntries().then(() => {
          resolve(this.db);
        });
      };

      request.onupgradeneeded = (event) => {
        console.log("[ChunkCacheDB] Creating/upgrading database...");
        const db = event.target.result;

        // 🔧 FIX: Use db.objectStoreNames instead of db.objectStores
        // db.objectStoreNames is a DOMStringList with a .contains() method
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, {
            keyPath: "videoSrc", // Use video source URL as key
          });
          // Create indexes for efficient querying
          store.createIndex("timestamp", "timestamp", { unique: false });
          store.createIndex("accessCount", "accessCount", { unique: false });
          console.log("[ChunkCacheDB] Object store created with indexes");
        }
      };
    });

    return this.initPromise;
  },

  /**
   * Get cached chunk data for a video source
   */
  async get(videoSrc) {
    try {
      await this.init();

      // 🔧 FIX: Validate db is still open
      if (!this.db) {
        console.warn("[ChunkCacheDB] Database not available, skipping read");
        return null;
      }

      return new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = this.db.transaction([this.STORE_NAME], "readwrite");
        } catch (err) {
          // Handle cases where transaction creation fails
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

          // Check if cache is expired
          if (Date.now() - entry.timestamp > this.MAX_AGE_MS) {
            console.log(
              `[ChunkCacheDB] Cache expired for ${videoSrc.substring(0, 60)}...`,
            );
            try {
              store.delete(videoSrc); // Remove expired entry
            } catch (err) {
              // Silent fail - expiration cleanup is non-critical
            }
            resolve(null);
            return;
          }

          // Update access count and timestamp
          entry.accessCount = (entry.accessCount || 0) + 1;
          entry.lastAccessed = Date.now();

          try {
            store.put(entry);
          } catch (err) {
            // Non-critical - proceed with the data anyway
            console.warn(
              "[ChunkCacheDB] Could not update access metadata:",
              err,
            );
          }

          console.log(
            `[ChunkCacheDB] Cache hit for ${videoSrc.substring(0, 60)}... (accessed ${entry.accessCount} times)`,
          );
          resolve({
            chunks: entry.chunks,
            duration: entry.duration,
          });
        };

        request.onerror = (event) => {
          console.error(
            "[ChunkCacheDB] Error reading from cache:",
            event.target.error,
          );
          // Don't reject - treat as cache miss for robustness
          resolve(null);
        };

        // Handle transaction abort
        transaction.onabort = () => {
          console.warn("[ChunkCacheDB] Transaction aborted on get()");
          resolve(null);
        };
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error in get():", error);
      return null; // Graceful fallback
    }
  },

  /**
   * Store chunk data in cache
   */
  async set(videoSrc, chunks, duration) {
    try {
      await this.init();

      // 🔧 FIX: Validate db is still open
      if (!this.db) {
        console.warn("[ChunkCacheDB] Database not available, skipping write");
        return;
      }

      // Check current cache size and evict if needed
      this.getCacheSize().then((size) => {
        if (size >= this.MAX_ENTRIES) {
          console.log(
            `[ChunkCacheDB] Cache full (${size}/${this.MAX_ENTRIES}), evicting oldest entries...`,
          );
          this.evictOldest(5); // Evict 5 oldest entries
        }
      });

      return new Promise((resolve, reject) => {
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

        request.onerror = (event) => {
          console.error(
            "[ChunkCacheDB] Error writing to cache:",
            event.target.error,
          );
          // Don't reject - caching failures shouldn't break the app
          resolve();
        };

        transaction.onabort = () => {
          console.warn("[ChunkCacheDB] Transaction aborted on set()");
          resolve();
        };
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error in set():", error);
      // Silent fail - caching is optional
    }
  },

  /**
   * Get current number of cached entries
   */
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

        request.onsuccess = () => {
          resolve(request.result);
        };

        request.onerror = () => {
          resolve(0);
        };

        transaction.onabort = () => {
          resolve(0);
        };
      });
    } catch (error) {
      return 0;
    }
  },

  /**
   * Evict oldest entries from cache
   */
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

        index.openCursor().onerror = () => {
          resolve();
        };

        transaction.onabort = () => {
          console.warn("[ChunkCacheDB] Transaction aborted on evictOldest()");
          resolve();
        };
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error evicting entries:", error);
    }
  },

  /**
   * Clean up old entries (called on initialization)
   */
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
            if (cleaned > 0) {
              console.log(
                `[ChunkCacheDB] Cleaned up ${cleaned} expired entries`,
              );
            }
            resolve();
          }
        };

        index.openCursor().onerror = () => {
          resolve(); // Resolve even on error
        };

        transaction.onabort = () => {
          console.warn(
            "[ChunkCacheDB] Transaction aborted on cleanupOldEntries()",
          );
          resolve();
        };
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error cleaning up:", error);
    }
  },

  /**
   * Clear all cached data
   */
  async clear() {
    try {
      await this.init();

      if (!this.db) return;

      return new Promise((resolve) => {
        let transaction;
        try {
          transaction = this.db.transaction([this.STORE_NAME], "readwrite");
        } catch (err) {
          console.warn(
            "[ChunkCacheDB] Could not create transaction for clear():",
            err,
          );
          resolve();
          return;
        }

        const store = transaction.objectStore(this.STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => {
          console.log("[ChunkCacheDB] Cache cleared");
          resolve();
        };

        request.onerror = () => {
          resolve();
        };

        transaction.onabort = () => {
          console.warn("[ChunkCacheDB] Transaction aborted on clear()");
          resolve();
        };
      });
    } catch (error) {
      console.error("[ChunkCacheDB] Error clearing cache:", error);
    }
  },

  /**
   * Get cache statistics
   */
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

        store.openCursor().onerror = () => {
          resolve({ totalEntries: 0, totalChunks: 0 });
        };

        transaction.onabort = () => {
          resolve({ totalEntries: 0, totalChunks: 0 });
        };
      });
    } catch (error) {
      return { totalEntries: 0, totalChunks: 0 };
    }
  },
};

/**
 * Two-level cache system for chunk previews:
 * - L1: In-memory cache (fast, cleared on reload)
 * - L2: IndexedDB cache (persistent, survives reloads)
 *
 * On first access, data is loaded from IndexedDB into memory.
 * Subsequent accesses use the fast in-memory cache.
 */
const ChunkCache = {
  // L1: In-memory cache
  memoryCache: new Map(),
  MAX_MEMORY_ENTRIES: 10,

  /**
   * Get cached chunk data (checks memory first, then IndexedDB)
   */
  async get(videoSrc) {
    // 🔧 FIX: Validate input
    if (!videoSrc || typeof videoSrc !== "string") {
      console.error(
        "[ChunkCache] Invalid videoSrc for cache lookup:",
        videoSrc,
      );
      return null;
    }

    // Check L1 cache (memory) first
    if (this.memoryCache.has(videoSrc)) {
      const entry = this.memoryCache.get(videoSrc);
      console.log(
        `[ChunkCache] L1 memory cache hit for ${videoSrc.substring(0, 60)}...`,
      );
      return entry;
    }

    // Check L2 cache (IndexedDB)
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

  /**
   * Store chunk data in both L1 and L2 caches
   */
  async set(videoSrc, chunks, duration) {
    // 🔧 FIX: Validate input
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

  /**
   * Promote entry to memory cache, evicting oldest if needed
   */
  promoteToMemory(videoSrc, entry) {
    // Evict oldest if memory cache is full
    if (this.memoryCache.size >= this.MAX_MEMORY_ENTRIES) {
      const oldestKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(oldestKey);
      console.log(`[ChunkCache] Evicted oldest L1 entry`);
    }

    this.memoryCache.set(videoSrc, entry);
  },

  /**
   * Clear both caches
   */
  async clear() {
    this.memoryCache.clear();
    await ChunkCacheDB.clear();
    console.log("[ChunkCache] Both L1 and L2 caches cleared");
  },

  /**
   * Get cache statistics
   */
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

/**
 * Calculate how many seconds of buffered data exist ahead of current playhead.
 * Returns 0 if playhead is beyond buffer (e.g., after seeking).
 */
function getBufferAhead(video) {
  if (!video.buffered || !video.buffered.length) return 0;
  const ahead =
    video.buffered.end(video.buffered.length - 1) - video.currentTime;
  return ahead < 0 ? 0 : ahead;
}

/**
 * Calculate what percentage of total buffered time is ahead of playhead.
 */
function getEffectiveBufferRatio(video) {
  if (!video.buffered || !video.buffered.length) return 0;
  let totalBuffered = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    totalBuffered += video.buffered.end(i) - video.buffered.start(i);
  }
  const ahead = getBufferAhead(video);
  return totalBuffered > 0 ? Math.min(1, ahead / totalBuffered) : 1;
}

/**
 * Clean up boost timers for main videos.
 */
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

/**
 * 🆕 Clean up preview boost timers specifically.
 * This is separate from main video boost cleanup because previews
 * have different state and lifecycle (tied to hover, not playback).
 */
function cleanupPreviewBoost(previewVideo) {
  if (!previewVideo) return;
  const timers = previewBoostTimers.get(previewVideo);
  if (timers) {
    if (timers.checkInterval) clearInterval(timers.checkInterval);
    if (timers.endTimeout) clearTimeout(timers.endTimeout);
    previewBoostTimers.delete(previewVideo);
  }
  // Restore original rate if boost was active
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

/**
 * 🆕 Gentle buffer boost for preview videos.
 *
 * SAFETY: Always pauses video first to avoid conflicts with
 * other play() calls (initial frame, chunk loop).
 *
 * @param {HTMLVideoElement} previewVideo - The preview video element
 * @returns {Function} Cleanup function to stop boost
 */
function boostPreviewBuffer(previewVideo) {
  if (!previewVideo || !tabIsVisible) return () => {};
  if (previewVideo.__previewBoostActive) return () => {}; // Already boosting

  // 🔧 FIX: Pause first to avoid fighting with other play() calls
  // The boost only affects download speed via playbackRate, not actual playback
  if (!previewVideo.paused) {
    previewVideo.pause();
  }

  // Store original playback rate
  if (!previewVideo.__previewOriginalRate) {
    previewVideo.__previewOriginalRate = previewVideo.playbackRate || 1.0;
  }

  // Only boost if buffer is actually low
  const initialAhead = getBufferAhead(previewVideo);
  if (initialAhead >= BOOST_CONFIG.PREVIEW_BUFFER_TARGET) {
    return () => {}; // Already enough buffer
  }

  // Mark as active and apply gentle boost
  previewVideo.__previewBoostActive = true;
  previewVideo.__previewBoostStartTime = Date.now();
  previewVideo.playbackRate = BOOST_CONFIG.PREVIEW_BOOST_RATE;

  // Create timer storage
  const timers = {
    checkInterval: null,
    endTimeout: null,
  };
  previewBoostTimers.set(previewVideo, timers);

  // Periodically check if buffer is sufficient
  timers.checkInterval = setInterval(() => {
    // Stop if tab hidden, video paused, or destroyed
    if (!tabIsVisible || !previewVideo.__previewBoostActive) {
      cleanupPreviewBoost(previewVideo);
      return;
    }

    const ahead = getBufferAhead(previewVideo);
    const elapsed = Date.now() - (previewVideo.__previewBoostStartTime || 0);

    // End boost if buffer is healthy or max duration reached
    if (
      ahead >= BOOST_CONFIG.PREVIEW_BUFFER_TARGET ||
      elapsed >= BOOST_CONFIG.PREVIEW_BOOST_DURATION
    ) {
      cleanupPreviewBoost(previewVideo);
    }
  }, BOOST_CONFIG.PREVIEW_CHECK_INTERVAL);

  // Hard stop after max duration (safety net)
  timers.endTimeout = setTimeout(() => {
    cleanupPreviewBoost(previewVideo);
  }, BOOST_CONFIG.PREVIEW_BOOST_DURATION + 200);

  // Return cleanup function
  return () => cleanupPreviewBoost(previewVideo);
}

/**
 * Core buffer boost function for main videos.
 */
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

/**
 * Attach buffer boost listeners to a main video element.
 */
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
// END BUFFER BOOST ENGINE
// ═══════════════════════════════════════════════════════════════

// Global single playback controller - Only one video plays at any time
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

// New: Play preview chunks WITHOUT interfering with main video playback
function playPreviewChunk(
  previewVideo,
  chunkTimeoutRef,
  currentChunkIndexRef,
  entryId,
  getChunkStarts,
) {
  const chunkStarts = getChunkStarts();
  if (!chunkStarts) return;
  const startTime = chunkStarts[currentChunkIndexRef.current];
  previewVideo.currentTime = startTime;
  previewVideo
    .play()
    .then(() => {
      chunkTimeoutRef.current = setTimeout(() => {
        previewVideo.pause();
        currentChunkIndexRef.current =
          (currentChunkIndexRef.current + 1) % NUM_PREVIEW_CHUNKS;
        setTimeout(
          () =>
            playPreviewChunk(
              previewVideo,
              chunkTimeoutRef,
              currentChunkIndexRef,
              entryId,
              getChunkStarts,
            ),
          30,
        );
      }, CHUNK_PLAY_DURATION_MS);
    })
    .catch((err) => {
      log(`Chunk preview play failed for ${entryId}`, err.message);
      currentChunkIndexRef.current =
        (currentChunkIndexRef.current + 1) % NUM_PREVIEW_CHUNKS;
      chunkTimeoutRef.current = setTimeout(
        () =>
          playPreviewChunk(
            previewVideo,
            chunkTimeoutRef,
            currentChunkIndexRef,
            entryId,
            getChunkStarts,
          ),
        150,
      );
    });
}

/**
 * Sets up a smooth, continuous chunk preview loop with caching.
 * Uses continuous playback with position monitoring - no seeks between chunks.
 *
 * @param {HTMLVideoElement} previewVideo - The preview video element
 * @param {string} entryId - Video entry ID for logging
 * @param {string} cacheKeySrc - Original video URL (without ?preview=1) for cache key
 * @returns {Function} Cleanup function to stop the loop
 */
function setupLightChunkPreview(previewVideo, entryId, cacheKeySrc) {
  // 🔧 FIX: Validate cacheKeySrc early with detailed debug logging
  if (!cacheKeySrc || typeof cacheKeySrc !== "string") {
    console.error(`[Preview] ❌ Invalid cacheKeySrc for ${entryId}:`, {
      value: cacheKeySrc,
      type: typeof cacheKeySrc,
      previewSrc: previewVideo?.currentSrc || previewVideo?.src,
    });

    // Fallback: try to get URL from the preview video itself
    const rawSrc = previewVideo.currentSrc || previewVideo.src || "";
    cacheKeySrc = rawSrc
      .replace(/([?&])preview=1(&|$)/, "$1") // Remove preview=1 param
      .replace(/[?&]$/, ""); // Clean trailing ? or &

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

  // 🔧 FIX: Store validated cacheKeySrc in a local const to prevent closure issues
  const validatedCacheKey = cacheKeySrc;

  if (previewVideo.dataset.previewLoopReady === "true") {
    console.log(`[Preview:D] Loop already set up for ${entryId}, skipping`);
    return () => {};
  }

  previewVideo.dataset.previewLoopReady = "true";
  console.log(`[Preview] Setting up chunk loop for ${entryId}`);
  console.log("[Preview:D] Cache key:", { validatedCacheKey });

  // State management
  const state = {
    isRunning: false,
    isHovering: false,
    currentChunk: 0,
    monitorInterval: null,
    chunkStarts: null,
    chunkDuration: CHUNK_PLAY_DURATION_MS / 1000, // 0.4 seconds
    cacheLoaded: false,
    playbackStarted: false,
    totalChunks: 0,
    debugFrameCount: 0,
  };

  /**
   * Load chunk positions from cache or calculate them
   */
  async function loadChunkPositions() {
    if (state.chunkStarts && state.chunkStarts.length > 0) {
      console.log(`[Preview:D] Chunk positions already loaded for ${entryId}`);
      return;
    }

    console.log(`[Preview] Loading chunk positions for ${entryId}...`);
    console.log("[Preview:D] Looking up cache key:", { validatedCacheKey });

    // Try to load from cache first
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
      console.warn(`[Preview:D] Cache error details:`, err);
    }

    // Calculate chunk positions
    console.log(`[Preview] Calculating chunks for ${entryId}...`);
    calculateChunks();
  }

  /**
   * Calculate chunk positions and cache them
   * 🔧 FIX: Now uses validatedCacheKey from closure (guaranteed to be a string)
   */
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

    // 🔧 FIX: Use validatedCacheKey which is guaranteed to be a string
    console.log("[Preview:D] Attempting to cache with key:", {
      validatedCacheKey,
    });

    // Cache the calculated chunks (async, don't wait)
    ChunkCache.set(validatedCacheKey, chunkStarts, duration)
      .then(() => {
        console.log("[Preview:D] Successfully cached chunks for key:", {
          validatedCacheKey,
        });
      })
      .catch((err) => {
        console.warn("[Preview] Failed to cache chunks:", err);
        console.warn("[Preview:D] Cache error type:", err?.constructor?.name);
        console.warn("[Preview:D] Cache error message:", err?.message);
      });
  }

  // ... rest of the function (startContinuousPlayback, startPositionMonitor,
  //     stopPlayback, startLoop, stopLoop, onMouseEnter, onMouseLeave,
  //     event listeners, and cleanup) remains EXACTLY THE SAME ...

  /**
   * Start continuous playback with position monitoring.
   */
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
        console.log(
          `[Preview:D] Playback cancelled after seek (hovering: ${state.isHovering}, running: ${state.isRunning})`,
        );
        return;
      }

      previewVideo
        .play()
        .then(() => {
          console.log(`[Preview] ✅ Playback started for ${entryId}`);
          console.log(
            `[Preview:D] Current position after seek: ${previewVideo.currentTime.toFixed(2)}s`,
          );
          state.playbackStarted = true;
          startPositionMonitor();
        })
        .catch((err) => {
          console.warn(`[Preview] ❌ Play failed for ${entryId}:`, err.message);
          console.warn(`[Preview:D] Play error details:`, err);
          if (state.isHovering && state.isRunning) {
            console.log(`[Preview:D] Will retry playback in 500ms`);
            setTimeout(() => {
              startContinuousPlayback();
            }, 500);
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
        console.warn(
          `[Preview:D] Ready state: ${previewVideo.readyState}, network state: ${previewVideo.networkState}`,
        );
        previewVideo
          .play()
          .then(() => {
            state.playbackStarted = true;
            startPositionMonitor();
          })
          .catch((err) => {
            console.warn(`[Preview:D] Forced play also failed:`, err.message);
            if (state.isHovering && state.isRunning) {
              setTimeout(() => startContinuousPlayback(), 500);
            }
          });
      }
    }, 3000);
  }

  /**
   * Monitor playback position and handle chunk transitions.
   */
  function startPositionMonitor() {
    if (state.monitorInterval) {
      clearInterval(state.monitorInterval);
    }

    console.log(`[Preview] Starting position monitor for ${entryId}`);
    console.log(
      `[Preview:D] Monitor interval: 100ms, chunk duration: ${state.chunkDuration}s`,
    );

    state.monitorInterval = setInterval(() => {
      state.debugFrameCount++;

      if (!state.isHovering || !state.isRunning) {
        console.log(
          `[Preview:D] Monitor stopping - hovering: ${state.isHovering}, running: ${state.isRunning}`,
        );
        stopPlayback();
        return;
      }

      if (previewVideo.paused && state.playbackStarted) {
        if (previewVideo.ended) {
          console.log(
            `[Preview:D] Video reached end naturally, restarting from first chunk`,
          );
          state.currentChunk = 0;
          const firstChunkStart = state.chunkStarts[0];
          previewVideo.currentTime = firstChunkStart;
          previewVideo.play().catch((err) => {
            console.warn(
              `[Preview:D] Failed to restart after end:`,
              err.message,
            );
          });
          return;
        }

        if (state.debugFrameCount % 10 === 0) {
          console.log(
            `[Preview:D] Video paused unexpectedly (readyState: ${previewVideo.readyState}, ended: ${previewVideo.ended})`,
          );
        }
        previewVideo.play().catch((err) => {
          if (state.debugFrameCount % 10 === 0) {
            console.warn(`[Preview:D] Failed to restart:`, err.message);
          }
        });
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
        console.log(
          `[Preview:D] Current position: ${currentTime.toFixed(2)}s, chunk end: ${currentChunkEnd.toFixed(2)}s`,
        );

        state.currentChunk = nextChunk;

        if (nextChunk === 0) {
          console.log(`[Preview:D] Wrapping back to start, smooth reset`);
          previewVideo.pause();
          previewVideo.currentTime = nextChunkStart;
          const onSeekComplete = () => {
            previewVideo.removeEventListener("seeked", onSeekComplete);
            previewVideo.play().catch((err) => {
              console.warn(
                `[Preview:D] Failed to play after wrap:`,
                err.message,
              );
            });
          };
          previewVideo.addEventListener("seeked", onSeekComplete, {
            once: true,
          });
        } else {
          previewVideo.currentTime = nextChunkStart;
        }
      }

      const expectedPosition = currentChunkStart + state.chunkDuration;
      const positionDiff = Math.abs(currentTime - expectedPosition);
      if (positionDiff > state.chunkDuration * 2) {
        console.log(
          `[Preview] ⚠️ Position drift detected (diff: ${positionDiff.toFixed(2)}s), resetting to chunk ${state.currentChunk + 1}`,
        );
        console.log(
          `[Preview:D] Expected: ${expectedPosition.toFixed(2)}s, Actual: ${currentTime.toFixed(2)}s`,
        );
        previewVideo.currentTime = currentChunkStart;
      }
    }, 100);
  }

  /**
   * Stop playback and clean up
   */
  function stopPlayback() {
    console.log(
      `[Preview:D] Stopping playback for ${entryId} (was started: ${state.playbackStarted})`,
    );
    state.playbackStarted = false;
    if (state.monitorInterval) {
      clearInterval(state.monitorInterval);
      state.monitorInterval = null;
      console.log(`[Preview:D] Position monitor cleared`);
    }
    if (!previewVideo.paused) {
      previewVideo.pause();
      console.log(`[Preview:D] Video paused`);
    }
    state.currentChunk = 0;
  }

  /**
   * Start the continuous chunk playback loop
   */
  async function startLoop() {
    if (state.isRunning) {
      console.log(`[Preview:D] Loop already running for ${entryId}`);
      return;
    }

    console.log(`[Preview] Starting chunk loop for ${entryId}`);
    state.isRunning = true;
    state.playbackStarted = false;

    await loadChunkPositions();

    if (previewVideo.readyState >= 1 && previewVideo.duration > 0) {
      console.log(
        `[Preview:D] Video ready (readyState: ${previewVideo.readyState}, duration: ${previewVideo.duration.toFixed(1)}s)`,
      );
      setTimeout(() => {
        if (state.isHovering && state.isRunning) {
          startContinuousPlayback();
        }
      }, 150);
    } else {
      console.log(`[Preview] Waiting for metadata for ${entryId}`);
      console.log(
        `[Preview:D] Current readyState: ${previewVideo.readyState}, duration: ${previewVideo.duration}`,
      );

      const onReady = async () => {
        if (state.isHovering && state.isRunning) {
          previewVideo.removeEventListener("loadedmetadata", onReady);
          console.log(
            `[Preview:D] Metadata loaded, readyState: ${previewVideo.readyState}, duration: ${previewVideo.duration.toFixed(1)}s`,
          );
          await loadChunkPositions();
          setTimeout(() => startContinuousPlayback(), 150);
        }
      };

      previewVideo.addEventListener("loadedmetadata", onReady, { once: true });

      setTimeout(async () => {
        if (state.isHovering && state.isRunning && !state.playbackStarted) {
          previewVideo.removeEventListener("loadedmetadata", onReady);
          console.warn(
            `[Preview] ⚠️ Metadata timeout (5s), forcing start for ${entryId}`,
          );
          console.warn(
            `[Preview:D] readyState: ${previewVideo.readyState}, networkState: ${previewVideo.networkState}`,
          );
          await loadChunkPositions();
          startContinuousPlayback();
        }
      }, 5000);
    }
  }

  /**
   * Stop the chunk playback loop completely
   */
  function stopLoop() {
    console.log(`[Preview] Stopping chunk loop for ${entryId}`);
    state.isRunning = false;
    state.isHovering = false;
    stopPlayback();
  }

  /**
   * Mouse enter handler
   */
  function onMouseEnter() {
    if (!tabIsVisible) {
      console.log(`[Preview:D] Tab hidden, ignoring mouseenter for ${entryId}`);
      return;
    }
    console.log(`[Preview] Mouse entered ${entryId}`);
    state.isHovering = true;
    if (!state.isRunning) {
      startLoop();
    }
  }

  /**
   * Mouse leave handler
   */
  function onMouseLeave() {
    console.log(`[Preview] Mouse left ${entryId}`);
    stopLoop();
  }

  // Attach hover listeners
  previewVideo.addEventListener("mouseenter", onMouseEnter);
  previewVideo.addEventListener("mouseleave", onMouseLeave);

  const card = previewVideo.closest(".video-card");
  if (card) {
    card.addEventListener("mouseenter", onMouseEnter);
    card.addEventListener("mouseleave", onMouseLeave);
    console.log(`[Preview] Attached hover listeners to card for ${entryId}`);
  } else {
    console.warn(
      `[Preview:D] No .video-card found for ${entryId}, hover listeners only on video`,
    );
  }

  // Return cleanup function
  return () => {
    console.log(`[Preview] Cleaning up chunk loop for ${entryId}`);
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
 * Creates a preview video element for thumbnail preview.
 * Simplified - just creates the element and sets up the chunk loop.
 */
function createSinglePreview(originalVideo, entryId) {
  console.log(`[Preview] Creating preview video element for ${entryId}`);
  const rawSrc = originalVideo.currentSrc || originalVideo.src || "";
  const cleanSrc = rawSrc.split("?")[0];

  // Store cache key on the entry so it can be reused
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
  preview.preload = "auto";
  preview.style.width = "100%";
  preview.style.height = "auto";
  preview.style.maxHeight = "96px";
  preview.style.objectFit = "cover";
  preview.style.borderRadius = "4px";
  preview.style.background = "#1a1a2e";
  preview.style.display = "block";
  preview.style.cursor = "pointer";

  let isInitialized = false;

  function initializePreview() {
    if (isInitialized) {
      console.log(`[Preview] Already initialized for ${entryId}`);
      return;
    }
    console.log(`[Preview] Initializing preview for ${entryId}`);
    isInitialized = true;

    // Use the entry's stored cacheKeySrc
    const stopLoop = setupLightChunkPreview(preview, entryId, cleanSrc);
    preview._stopPreviewLoop = stopLoop;

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
            <span class="video-status ${entry.info.paused ? "paused" : "playing"}">
              ${entry.info.paused ? "⏸" : "▶"}
            </span>
            <button class="gallery-btn" title="Open preview gallery">📷</button>
          </div>
        </div>
        <div class="video-src" title="${entry.info.src}">
          ${entry.info.src}
        </div>
        <div class="video-meta">
          ${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s
        </div>
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
        delete videoEl.dataset.clickInProgress;
      });
    } else {
      videoEl.pause();
      if (currentlyPlaying === videoEl) currentlyPlaying = null;
    }
    videoEl.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  const galleryBtn = card.querySelector(".gallery-btn");
  if (galleryBtn) {
    galleryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openGallery(entry);
    });
  }
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

// Update cleanup functions to handle IndexedDB properly
function cleanupVideoEntry(entry) {
  if (!entry) return;
  log(`Cleaning up video entry for RAM optimization: ${entry.id}`);

  // Clean up boost engine (main video)
  if (entry.boostCleanup) {
    entry.boostCleanup();
    entry.boostCleanup = null;
  }

  // Clean up stored cache key
  delete entry.cacheKeySrc;

  if (entry.preview) {
    // Clean up preview boost
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

  // Attach buffer boost to main video
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
  const addTrackedListener = (el, eventName, handlerFn, options = {}) => {
    el.addEventListener(eventName, handlerFn, options);
    entry.cleanups.push(() =>
      el.removeEventListener(eventName, handlerFn, options),
    );
  };
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
      const info = getVideoInfo(video);
      entry.info = info;
    };
    addTrackedListener(video, ev, handler, { passive: true });
  });
  const addPlayingClass = () => video.classList.add("video-observer-playing");
  const removePlayingClass = () =>
    video.classList.remove("video-observer-playing");
  addTrackedListener(video, "play", addPlayingClass, { passive: true });
  addTrackedListener(video, "pause", removePlayingClass, { passive: true });
  addTrackedListener(video, "ended", removePlayingClass, { passive: true });
  if (!video.paused) {
    video.classList.add("video-observer-playing");
  }
}

// Add cache stats to panel updates (optional)
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

  // Show cache stats in panel (optional)
  ChunkCache.getStats()
    .then((stats) => {
      const statusEl = panel.querySelector(".status");
      if (statusEl && stats) {
        const cacheInfo =
          stats.dbEntries > 0 ? ` • Cache: ${stats.dbEntries} videos` : "";
        statusEl.innerHTML = `Observing <strong>.message-inner video</strong> • ${new Date().toLocaleTimeString()}${cacheInfo}`;
      }
    })
    .catch(() => {});

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
    if (card && !entry.framesPopulated && entry.info.duration > 2) {
      entry.framesPopulated = true;
      populateTimeSelections(card, entry);
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

function populateTimeSelections(card, entry) {
  const strip = card.querySelector(".time-strip");
  if (!strip) return;
  strip.innerHTML = "";
  const div = document.createElement("div");
  div.textContent = "⏱ Time frames";
  div.style.fontSize = "10px";
  div.style.color = "#666";
  strip.appendChild(div);
}

function observeVideos() {
  document.querySelectorAll(SELECTOR).forEach(trackVideo);
  performPanelUpdate();
}

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
// PAGE VISIBILITY: pause everything when tab is hidden
// ═══════════════════════════════════════════════════════════════

function restartAllPreviewLoops() {
  for (const entry of videos.values()) {
    if (entry.preview) {
      // Get the stored cache key from the entry
      const cacheKeySrc = entry.cacheKeySrc || "";

      if (!cacheKeySrc) {
        console.warn(
          `[Preview] No cacheKeySrc stored for ${entry.id}, cannot restart loop`,
        );
        continue;
      }

      // Remove old stop function reference
      if (typeof entry.preview._stopPreviewLoop === "function") {
        entry.preview._stopPreviewLoop();
      }
      delete entry.preview.dataset.previewLoopReady;

      // Re-attach with the correct cache key
      const stopFn = setupLightChunkPreview(
        entry.preview,
        entry.id,
        cacheKeySrc,
      );
      entry.preview._stopPreviewLoop = stopFn;
    }
  }
}

function stopAllPreviewLoops() {
  for (const entry of videos.values()) {
    if (entry.preview && typeof entry.preview._stopPreviewLoop === "function") {
      entry.preview._stopPreviewLoop();
      delete entry.preview.dataset.previewLoopReady;
    }
  }
}
function stopAllBoosts() {
  for (const entry of videos.values()) {
    if (entry.boostCleanup) {
      cleanupBoost(entry.element);
    }
    // 🆕 NEW: Also clean up preview boosts
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

/**
 * 🆕 NEW: Pause all preview-specific boosts when tab is hidden.
 * Separate from main video boosts because previews have different cleanup needs.
 */
function stopAllPreviewBoosts() {
  for (const entry of videos.values()) {
    if (entry.preview) {
      // Clean up the initial boost if still active
      if (typeof entry.preview._initialBoostCleanup === "function") {
        entry.preview._initialBoostCleanup();
      }
      // Clean up any ongoing preview boost
      cleanupPreviewBoost(entry.preview);
    }
  }
}

/**
 * 🆕 NEW: Re-apply preview boosts when tab becomes visible.
 * Only boosts previews that are currently visible in the panel.
 */
function restartAllPreviewBoosts() {
  for (const entry of videos.values()) {
    if (entry.preview && tabIsVisible) {
      // Pre-warm buffer so hover playback is instant
      const cleanupFn = boostPreviewBuffer(entry.preview);
      entry.preview._initialBoostCleanup = cleanupFn;
    }
  }
}

function onTabHidden() {
  tabIsVisible = false;
  log("Tab hidden — pausing everything");
  stopAllPreviewLoops();
  stopAllBoosts();
  stopAllPreviewBoosts(); // 🆕 NEW
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

// ═══════════════════════════════════════════════════
// Uses module-level chatRoot
// ═══════════════════════════════════════════════════
function onTabVisible() {
  tabIsVisible = true;
  log("Tab visible — resuming everything");
  restartAllPreviewLoops();
  restartAllBoosts();
  restartAllPreviewBoosts();
  if (pollingInterval === null) {
    if (pollingInterval !== null) clearInterval(pollingInterval);
    pollingInterval = setInterval(observeVideos, 30000);
    globalResources.intervals.push(pollingInterval);
  }
  if (domObserver) {
    // 🔧 FIX: chatRoot is now module-level, accessible here
    domObserver.observe(chatRoot || document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
  }
  observeVideos();
}

// Add cache cleanup to global cleanup
function cleanupGlobalResources() {
  globalResources.observers.forEach((o) => o.disconnect());
  globalResources.intervals.forEach((i) => clearInterval(i));
  globalResources.observers = [];
  globalResources.intervals = [];

  // Clear both caches
  ChunkCache.clear().catch((err) => {
    console.warn("[Cleanup] Error clearing chunk cache:", err);
  });

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
}

// ═══════════════════════════════════════════════════
// Assigns to module-level chatRoot
// ═══════════════════════════════════════════════════
function init() {
  if (window.__VIDEO_OBSERVER_INITIALIZED__) return;
  window.__VIDEO_OBSERVER_INITIALIZED__ = true;
  cleanupGlobalResources();
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
  // 🔧 FIX: Assign to module-level variable so onTabVisible can use it
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
