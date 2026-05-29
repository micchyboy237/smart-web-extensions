/**
 * Chunk Preview Engine - Lightweight video preview system
 * Creates hover-triggered, looping previews that play
 * small segments (chunks) of video instead of full playback.
 *
 * Integrates with BoostEngine priority system to avoid conflicts.
 */
import { DebugLogger as debug } from "../core/debug.js";
import { AppState } from "../core/state.js";
import { getBufferAhead } from "./video-utils.js";

// ═══════════════════════════════════════════════════════════════
// CHUNK CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CHUNK_CONFIG = {
  NUM_CHUNKS: 5, // Number of 4-second segments
  CHUNK_DURATION_MS: 4000, // Duration of each chunk
  MONITOR_INTERVAL: 100, // Position check frequency (ms)
  HOVER_DEBOUNCE_MS: 100, // Debounce hover events
  DOWNGRADE_DELAY: 2000, // Downgrade buffer after leaving
  IDLE_DOWNGRADE_DELAY: 30000, // Full metadata release after idle
  BOOST_RATE: 1.08, // Preview buffer boost rate
  BOOST_DURATION: 4000, // Preview boost duration
  BUFFER_TARGET: 3, // Target buffer ahead (seconds)
  PREVIEW_CHECK_INTERVAL: 500, // Buffer check interval
};

// ═══════════════════════════════════════════════════════════════
// TWO-LEVEL CHUNK CACHE (L1: Memory, L2: IndexedDB)
// ═══════════════════════════════════════════════════════════════
const ChunkCacheDB = {
  DB_NAME: "RedditPreviewCache",
  DB_VERSION: 1,
  STORE_NAME: "chunks",
  MAX_ENTRIES: 50,
  MAX_AGE_MS: 24 * 60 * 60 * 1000, // 24 hours
  db: null,
  initPromise: null,

  async init() {
    if (this.db) return this.db;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      console.log("[ChunkCacheDB:Reddit] Initializing IndexedDB...");
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = (event) => {
        console.error("[ChunkCacheDB:Reddit] Open failed:", event.target.error);
        this.initPromise = null;
        reject(event.target.error);
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        this.db.onclose = () => {
          console.warn("[ChunkCacheDB:Reddit] Connection closed");
          this.db = null;
          this.initPromise = null;
        };
        console.log("[ChunkCacheDB:Reddit] Database ready");
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, {
            keyPath: "videoSrc",
          });
          store.createIndex("timestamp", "timestamp", { unique: false });
          console.log("[ChunkCacheDB:Reddit] Store created");
        }
      };
    });

    return this.initPromise;
  },

  async get(videoSrc) {
    try {
      await this.init();
      if (!this.db) return null;

      return new Promise((resolve) => {
        const tx = this.db.transaction([this.STORE_NAME], "readwrite");
        const store = tx.objectStore(this.STORE_NAME);
        const request = store.get(videoSrc);

        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) {
            console.log(
              `[ChunkCacheDB:Reddit] Miss: ${videoSrc.substring(0, 50)}...`,
            );
            resolve(null);
            return;
          }
          if (Date.now() - entry.timestamp > this.MAX_AGE_MS) {
            console.log(
              `[ChunkCacheDB:Reddit] Expired: ${videoSrc.substring(0, 50)}...`,
            );
            store.delete(videoSrc);
            resolve(null);
            return;
          }
          entry.accessCount = (entry.accessCount || 0) + 1;
          entry.lastAccessed = Date.now();
          store.put(entry);
          console.log(
            `[ChunkCacheDB:Reddit] Hit: ${videoSrc.substring(0, 50)}...`,
          );
          resolve({ chunks: entry.chunks, duration: entry.duration });
        };

        request.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      });
    } catch (error) {
      console.error("[ChunkCacheDB:Reddit] Error:", error);
      return null;
    }
  },

  async set(videoSrc, chunks, duration) {
    try {
      await this.init();
      if (!this.db) return;

      return new Promise((resolve) => {
        const tx = this.db.transaction([this.STORE_NAME], "readwrite");
        const store = tx.objectStore(this.STORE_NAME);
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
          console.log(`[ChunkCacheDB:Reddit] Cached ${chunks.length} chunks`);
          resolve();
        };
        request.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch (error) {
      console.error("[ChunkCacheDB:Reddit] Set error:", error);
    }
  },

  async clear() {
    try {
      await this.init();
      if (!this.db) return;
      return new Promise((resolve) => {
        const tx = this.db.transaction([this.STORE_NAME], "readwrite");
        const store = tx.objectStore(this.STORE_NAME);
        store.clear().onsuccess = () => {
          console.log("[ChunkCacheDB:Reddit] Cleared");
          resolve();
        };
        tx.onabort = () => resolve();
      });
    } catch (error) {
      console.error("[ChunkCacheDB:Reddit] Clear error:", error);
    }
  },
};

// In-memory L1 cache (fast access)
const memoryCache = new Map();
const MAX_MEMORY_ENTRIES = 10;

// Track active chunk loops for cleanup
const activeChunkLoops = new Map(); // video -> ChunkLoop

/**
 * Calculate optimal chunk positions for a video
 * Returns array of timestamps evenly distributed across the video
 */
function calculateChunkPositions(duration, numChunks, chunkDuration) {
  if (!duration || isNaN(duration) || duration < 1) {
    console.warn(`[ChunkPreview] Invalid duration: ${duration}`);
    return [0];
  }

  const chunkDurationSec = chunkDuration / 1000;
  const usableDuration = duration - chunkDurationSec;

  if (usableDuration <= 0) {
    console.warn(`[ChunkPreview] Video too short: ${duration}s`);
    return [0];
  }

  const positions = [];
  for (let i = 0; i < numChunks; i++) {
    const start = (i / (numChunks - 1)) * usableDuration;
    positions.push(Math.max(0, Math.min(start, usableDuration)));
  }

  return positions;
}

/**
 * Get cached chunk positions or calculate and cache them
 */
async function getChunkPositions(videoSrc, duration) {
  if (!videoSrc || typeof videoSrc !== "string") {
    console.error("[ChunkPreview] Invalid videoSrc:", videoSrc);
    return null;
  }

  // Check L1 memory cache
  if (memoryCache.has(videoSrc)) {
    console.log(`[ChunkPreview] L1 cache hit`);
    return memoryCache.get(videoSrc);
  }

  // Check L2 IndexedDB cache
  console.log(`[ChunkPreview] L1 miss, checking L2...`);
  const dbEntry = await ChunkCacheDB.get(videoSrc);
  if (dbEntry) {
    // Promote to L1
    if (memoryCache.size >= MAX_MEMORY_ENTRIES) {
      const oldestKey = memoryCache.keys().next().value;
      memoryCache.delete(oldestKey);
    }
    memoryCache.set(videoSrc, dbEntry);
    console.log(`[ChunkPreview] Promoted from L2 cache`);
    return dbEntry;
  }

  // Cache miss - calculate
  console.log(`[ChunkPreview] Cache miss - calculating chunks`);
  const chunks = calculateChunkPositions(
    duration,
    CHUNK_CONFIG.NUM_CHUNKS,
    CHUNK_CONFIG.CHUNK_DURATION_MS,
  );

  // Store in both caches
  const entry = { chunks, duration };
  if (memoryCache.size >= MAX_MEMORY_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    memoryCache.delete(oldestKey);
  }
  memoryCache.set(videoSrc, entry);
  ChunkCacheDB.set(videoSrc, chunks, duration).catch(console.warn);

  return entry;
}

/**
 * ChunkLoop class - manages playback of chunk sequences for one preview video
 */
class ChunkLoop {
  constructor(previewVideo, entryId, videoSrc) {
    this.video = previewVideo;
    this.entryId = entryId;
    this.videoSrc = videoSrc;
    this.chunkStarts = null;
    this.totalChunks = 0;
    this.currentChunk = 0;
    this.isRunning = false;
    this.isHovering = false;
    this.playbackStarted = false;
    this.monitorInterval = null;
    this.chunkDuration = CHUNK_CONFIG.CHUNK_DURATION_MS / 1000;
    this.cacheLoaded = false;
    this.downgradeTimer = null;
    this.debugFrameCount = 0;

    // Bound event handlers for cleanup
    this._onMouseEnter = this._onMouseEnter.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
  }

  async init() {
    // Mark that chunk loop is active on this video
    this.video.dataset.chunkLoopActive = "true";

    // Load chunk positions from cache or calculate
    const cached = await getChunkPositions(this.videoSrc, this.video.duration);
    if (cached && cached.chunks) {
      this.chunkStarts = cached.chunks;
      this.totalChunks = cached.chunks.length;
      this.cacheLoaded = true;
      console.log(
        `[ChunkPreview] ${this.entryId}: ${this.totalChunks} chunks ready`,
      );
    }
  }

  attachHoverListeners(card) {
    // Attach to both video and card for better UX
    this.video.addEventListener("mouseenter", this._onMouseEnter);
    this.video.addEventListener("mouseleave", this._onMouseLeave);

    if (card) {
      card.addEventListener("mouseenter", this._onMouseEnter);
      card.addEventListener("mouseleave", this._onMouseLeave);
    }
  }

  _onMouseEnter() {
    if (!AppState.isTabVisible()) return;

    clearTimeout(this.downgradeTimer);

    if (this.isHovering) return; // Already hovering

    console.log(`[ChunkPreview] ${this.entryId}: Hover started`);
    this.isHovering = true;

    // Cancel any pending buffer downgrade
    if (this.video._downgradeTimeout) {
      clearTimeout(this.video._downgradeTimeout);
    }

    if (!this.isRunning) {
      this._startLoop();
    }
  }

  _onMouseLeave() {
    console.log(`[ChunkPreview] ${this.entryId}: Hover ended`);
    this.isHovering = false;
    this._stopLoop();

    // Schedule buffer downgrade after delay
    this.video._downgradeTimeout = setTimeout(() => {
      if (!this.isHovering && !this.video.dataset.chunkLoopActive) {
        // Video is idle - could release buffer here
        // BufferManager would handle this in the NSFWPH version
      }
    }, CHUNK_CONFIG.DOWNGRADE_DELAY);
  }

  _startLoop() {
    if (this.isRunning) return;
    if (!this.chunkStarts || this.chunkStarts.length === 0) {
      console.warn(`[ChunkPreview] ${this.entryId}: No chunks available`);
      return;
    }

    console.log(`[ChunkPreview] ${this.entryId}: Starting chunk loop`);
    this.isRunning = true;
    this.playbackStarted = false;
    this.video.dataset.chunkLoopActive = "true";

    this._startContinuousPlayback();
  }

  _startContinuousPlayback() {
    this.currentChunk = 0;
    const firstChunkStart = this.chunkStarts[0];

    console.log(
      `[ChunkPreview] ${this.entryId}: Seeking to chunk 0 at ${firstChunkStart.toFixed(2)}s`,
    );

    this.video.currentTime = firstChunkStart;

    const onSeeked = () => {
      this.video.removeEventListener("seeked", onSeeked);

      if (!this.isHovering || !this.isRunning) {
        console.log(`[ChunkPreview] ${this.entryId}: Playback cancelled`);
        return;
      }

      this.video
        .play()
        .then(() => {
          console.log(`[ChunkPreview] ${this.entryId}: Playback started`);
          this.playbackStarted = true;
          this._startPositionMonitor();
        })
        .catch((err) => {
          console.warn(
            `[ChunkPreview] ${this.entryId}: Play failed:`,
            err.message,
          );
          if (this.isHovering && this.isRunning) {
            setTimeout(() => this._startContinuousPlayback(), 500);
          }
        });
    };

    this.video.addEventListener("seeked", onSeeked, { once: true });

    // Fallback timeout if seek never fires
    setTimeout(() => {
      if (!this.playbackStarted && this.isHovering && this.isRunning) {
        this.video.removeEventListener("seeked", onSeeked);
        console.warn(
          `[ChunkPreview] ${this.entryId}: Seek timeout, forcing play`,
        );
        this.video
          .play()
          .then(() => {
            this.playbackStarted = true;
            this._startPositionMonitor();
          })
          .catch(() => {});
      }
    }, 3000);
  }

  _startPositionMonitor() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    console.log(`[ChunkPreview] ${this.entryId}: Position monitor active`);

    this.monitorInterval = setInterval(() => {
      this.debugFrameCount++;

      // Stop if not hovering or not running
      if (!this.isHovering || !this.isRunning) {
        this._stopPlayback();
        return;
      }

      // Resume if paused unexpectedly
      if (this.video.paused && this.playbackStarted) {
        if (this.video.ended) {
          // Reached end - loop back to first chunk
          this.currentChunk = 0;
          this.video.currentTime = this.chunkStarts[0];
          this.video.play().catch(() => {});
          return;
        }
        // Try to resume
        this.video.play().catch(() => {});
        return;
      }

      if (!this.chunkStarts || this.chunkStarts.length === 0) return;

      const currentTime = this.video.currentTime;
      const currentChunkStart = this.chunkStarts[this.currentChunk];
      const currentChunkEnd = currentChunkStart + this.chunkDuration;

      if (currentTime >= currentChunkEnd) {
        // Move to next chunk
        const nextChunk = (this.currentChunk + 1) % this.chunkStarts.length;
        const nextChunkStart = this.chunkStarts[nextChunk];

        console.log(
          `[ChunkPreview] ${this.entryId}: Chunk ${this.currentChunk + 1} → ${nextChunk + 1} at ${nextChunkStart.toFixed(2)}s`,
        );

        this.currentChunk = nextChunk;

        if (nextChunk === 0) {
          // Looping back to start - need to handle carefully
          this.video.pause();
          this.video.currentTime = nextChunkStart;

          const onSeekComplete = () => {
            this.video.removeEventListener("seeked", onSeekComplete);
            this.video.play().catch(() => {});
          };
          this.video.addEventListener("seeked", onSeekComplete, { once: true });
        } else {
          this.video.currentTime = nextChunkStart;
        }
      }
    }, CHUNK_CONFIG.MONITOR_INTERVAL);
  }

  _stopPlayback() {
    this.playbackStarted = false;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    if (!this.video.paused) {
      this.video.pause();
    }

    this.currentChunk = 0;
  }

  _stopLoop() {
    this.isRunning = false;
    this.isHovering = false;
    delete this.video.dataset.chunkLoopActive;
    this._stopPlayback();
  }

  dispose() {
    console.log(`[ChunkPreview] ${this.entryId}: Disposing chunk loop`);

    // Clear timers
    clearTimeout(this.downgradeTimer);
    if (this.video._downgradeTimeout) {
      clearTimeout(this.video._downgradeTimeout);
    }

    // Stop playback
    this._stopLoop();

    // Remove event listeners
    this.video.removeEventListener("mouseenter", this._onMouseEnter);
    this.video.removeEventListener("mouseleave", this._onMouseLeave);

    // Clean up dataset
    delete this.video.dataset.chunkLoopActive;
    delete this.video.dataset.previewLoopReady;

    // Remove from active loops
    activeChunkLoops.delete(this.video);
  }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════
export const ChunkPreviewEngine = {
  /**
   * Initialize chunk preview for a video element
   * Returns cleanup function
   */
  async setup(previewVideo, entryId, cardElement) {
    if (!previewVideo) {
      console.error("[ChunkPreview] No video element provided");
      return () => {};
    }

    if (previewVideo.dataset.previewLoopReady === "true") {
      console.log(`[ChunkPreview] ${entryId}: Already set up`);
      return () => {};
    }

    // Clean up any existing loop
    this.cleanup(previewVideo);

    // Get clean video source for cache key
    const rawSrc = previewVideo.currentSrc || previewVideo.src || "";
    const cacheKey = rawSrc.split("?")[0]; // Remove query params

    if (!cacheKey) {
      console.error(`[ChunkPreview] ${entryId}: No valid video source`);
      return () => {};
    }

    previewVideo.dataset.previewLoopReady = "true";
    previewVideo.muted = true;
    previewVideo.loop = false;
    previewVideo.playsInline = true;
    previewVideo.preload = "metadata";

    console.log(`[ChunkPreview] ${entryId}: Setting up`);

    // Wait for video to have metadata
    if (previewVideo.readyState < 1) {
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            previewVideo.removeEventListener("loadedmetadata", handler);
            reject(new Error("Metadata timeout"));
          }, 5000);

          const handler = () => {
            clearTimeout(timeout);
            resolve();
          };

          previewVideo.addEventListener("loadedmetadata", handler, {
            once: true,
          });
        });
      } catch (err) {
        console.warn(
          `[ChunkPreview] ${entryId}: Metadata wait failed:`,
          err.message,
        );
      }
    }

    // Create chunk loop
    const loop = new ChunkLoop(previewVideo, entryId, cacheKey);
    await loop.init();
    loop.attachHoverListeners(cardElement);

    // Register for tracking
    activeChunkLoops.set(previewVideo, loop);

    console.log(`[ChunkPreview] ${entryId}: Ready for hover`);

    // Return cleanup function
    return () => {
      loop.dispose();
    };
  },

  /**
   * Clean up chunk preview for a video
   */
  cleanup(previewVideo) {
    if (!previewVideo) return;

    const existing = activeChunkLoops.get(previewVideo);
    if (existing) {
      existing.dispose();
    }

    delete previewVideo.dataset.previewLoopReady;
    delete previewVideo.dataset.chunkLoopActive;
  },

  /**
   * Stop all active chunk loops (for tab hide)
   */
  stopAll() {
    console.log(
      `[ChunkPreview] Stopping all (${activeChunkLoops.size} active)`,
    );
    for (const [video, loop] of activeChunkLoops) {
      loop._stopLoop();
    }
  },

  /**
   * Resume all active chunk loops (for tab visible)
   */
  resumeAll() {
    console.log(
      `[ChunkPreview] Resuming all (${activeChunkLoops.size} active)`,
    );
    // Loops will resume on next hover - no need to force
  },

  /**
   * Get stats for debugging
   */
  getStats() {
    return {
      activeLoops: activeChunkLoops.size,
      memoryCacheSize: memoryCache.size,
    };
  },

  /**
   * Clear all caches
   */
  async clearAllCaches() {
    memoryCache.clear();
    await ChunkCacheDB.clear();
    console.log("[ChunkPreview] All caches cleared");
  },
};
