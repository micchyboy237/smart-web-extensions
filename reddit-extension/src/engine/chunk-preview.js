/**
 * Chunk Preview Engine - Lightweight video preview system
 * UPDATED: Better metadata timeout handling, duplicate hover event prevention,
 * graceful fallback when metadata fails
 */
import { DebugLogger as debug } from "../core/debug.js";
import { AppState } from "../core/state.js";

// ═══════════════════════════════════════════════════════════════
// CHUNK CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CHUNK_CONFIG = {
  NUM_CHUNKS: 5,
  CHUNK_DURATION_MS: 4000,
  MONITOR_INTERVAL: 100,
  HOVER_DEBOUNCE_MS: 150, // ✅ Increased to prevent rapid fire
  DOWNGRADE_DELAY: 2000,
  IDLE_DOWNGRADE_DELAY: 30000,
  BOOST_RATE: 1.08,
  BOOST_DURATION: 4000,
  BUFFER_TARGET: 3,
  PREVIEW_CHECK_INTERVAL: 500,
  METADATA_TIMEOUT_MS: 8000, // ✅ Increased from 5000
};

// ═══════════════════════════════════════════════════════════════
// TWO-LEVEL CHUNK CACHE (L1: Memory, L2: IndexedDB)
// ═══════════════════════════════════════════════════════════════
const ChunkCacheDB = {
  DB_NAME: "RedditPreviewCache",
  DB_VERSION: 1,
  STORE_NAME: "chunks",
  MAX_ENTRIES: 50,
  MAX_AGE_MS: 24 * 60 * 60 * 1000,
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
            resolve(null);
            return;
          }
          if (Date.now() - entry.timestamp > this.MAX_AGE_MS) {
            store.delete(videoSrc);
            resolve(null);
            return;
          }
          entry.accessCount = (entry.accessCount || 0) + 1;
          entry.lastAccessed = Date.now();
          store.put(entry);
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
        request.onsuccess = () => resolve();
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
        store.clear().onsuccess = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch (error) {
      console.error("[ChunkCacheDB:Reddit] Clear error:", error);
    }
  },
};

// In-memory L1 cache
const memoryCache = new Map();
const MAX_MEMORY_ENTRIES = 10;

// Track active chunk loops
const activeChunkLoops = new Map(); // video -> ChunkLoop

/**
 * Calculate optimal chunk positions for a video
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
    return memoryCache.get(videoSrc);
  }

  // Check L2 IndexedDB cache
  const dbEntry = await ChunkCacheDB.get(videoSrc);
  if (dbEntry) {
    if (memoryCache.size >= MAX_MEMORY_ENTRIES) {
      const oldestKey = memoryCache.keys().next().value;
      memoryCache.delete(oldestKey);
    }
    memoryCache.set(videoSrc, dbEntry);
    return dbEntry;
  }

  // Cache miss - calculate
  console.log(`[ChunkPreview] Cache miss - calculating chunks`);
  const chunks = calculateChunkPositions(
    duration,
    CHUNK_CONFIG.NUM_CHUNKS,
    CHUNK_CONFIG.CHUNK_DURATION_MS,
  );

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
 * ✅ FIXED: Duplicate hover prevention with debounce
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
    // ✅ Hover debounce
    this._hoverDebounceTimer = null;
    this._lastHoverEvent = 0;

    // Bound event handlers
    this._onMouseEnter = this._onMouseEnter.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
  }

  async init() {
    this.video.dataset.chunkLoopActive = "true";

    // Use duration if available, otherwise default to 60s estimate
    const duration = this.video.duration || 60;

    const cached = await getChunkPositions(this.videoSrc, duration);
    if (cached && cached.chunks) {
      this.chunkStarts = cached.chunks;
      this.totalChunks = cached.chunks.length;
      this.cacheLoaded = true;
    }
  }

  attachHoverListeners(card) {
    // ✅ Only attach to card to prevent duplicate events
    if (card) {
      card.addEventListener("mouseenter", this._onMouseEnter);
      card.addEventListener("mouseleave", this._onMouseLeave);
    } else {
      // Fallback: attach to video only
      this.video.addEventListener("mouseenter", this._onMouseEnter);
      this.video.addEventListener("mouseleave", this._onMouseLeave);
    }
  }

  _onMouseEnter() {
    if (!AppState.isTabVisible()) return;

    // ✅ Debounce hover to prevent rapid enter/leave cycles
    const now = Date.now();
    if (now - this._lastHoverEvent < CHUNK_CONFIG.HOVER_DEBOUNCE_MS) {
      return;
    }
    this._lastHoverEvent = now;

    clearTimeout(this._hoverDebounceTimer);
    clearTimeout(this.downgradeTimer);

    if (this.isHovering) return; // Already hovering

    this.isHovering = true;
    console.log(`[ChunkPreview] ${this.entryId}: Hover started`);

    if (this.video._downgradeTimeout) {
      clearTimeout(this.video._downgradeTimeout);
    }

    if (!this.isRunning) {
      this._startLoop();
    }
  }

  _onMouseLeave() {
    clearTimeout(this._hoverDebounceTimer);

    this._hoverDebounceTimer = setTimeout(() => {
      this.isHovering = false;
      console.log(`[ChunkPreview] ${this.entryId}: Hover ended`);
      this._stopLoop();
    }, CHUNK_CONFIG.HOVER_DEBOUNCE_MS);
  }

  _startLoop() {
    if (this.isRunning) return;
    if (!this.chunkStarts || this.chunkStarts.length === 0) {
      console.warn(`[ChunkPreview] ${this.entryId}: No chunks available`);
      return;
    }

    this.isRunning = true;
    this.playbackStarted = false;
    this.video.dataset.chunkLoopActive = "true";

    this._startContinuousPlayback();
  }

  _startContinuousPlayback() {
    this.currentChunk = 0;
    const firstChunkStart = this.chunkStarts[0];

    this.video.currentTime = firstChunkStart;

    const onSeeked = () => {
      this.video.removeEventListener("seeked", onSeeked);

      if (!this.isHovering || !this.isRunning) {
        return;
      }

      this.video
        .play()
        .then(() => {
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

    // Fallback timeout
    setTimeout(() => {
      if (!this.playbackStarted && this.isHovering && this.isRunning) {
        this.video.removeEventListener("seeked", onSeeked);
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

    this.monitorInterval = setInterval(() => {
      this.debugFrameCount++;

      if (!this.isHovering || !this.isRunning) {
        this._stopPlayback();
        return;
      }

      if (this.video.paused && this.playbackStarted) {
        if (this.video.ended) {
          this.currentChunk = 0;
          this.video.currentTime = this.chunkStarts[0];
          this.video.play().catch(() => {});
          return;
        }
        this.video.play().catch(() => {});
        return;
      }

      if (!this.chunkStarts || this.chunkStarts.length === 0) return;

      const currentTime = this.video.currentTime;
      const currentChunkStart = this.chunkStarts[this.currentChunk];
      const currentChunkEnd = currentChunkStart + this.chunkDuration;

      if (currentTime >= currentChunkEnd) {
        const nextChunk = (this.currentChunk + 1) % this.chunkStarts.length;
        const nextChunkStart = this.chunkStarts[nextChunk];

        this.currentChunk = nextChunk;

        if (nextChunk === 0) {
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
    clearTimeout(this._hoverDebounceTimer);
    clearTimeout(this.downgradeTimer);
    if (this.video._downgradeTimeout) {
      clearTimeout(this.video._downgradeTimeout);
    }

    this._stopLoop();

    this.video.removeEventListener("mouseenter", this._onMouseEnter);
    this.video.removeEventListener("mouseleave", this._onMouseLeave);

    delete this.video.dataset.chunkLoopActive;
    delete this.video.dataset.previewLoopReady;

    activeChunkLoops.delete(this.video);
  }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════
export const ChunkPreviewEngine = {
  async setup(previewVideo, entryId, cardElement) {
    if (!previewVideo) {
      return () => {};
    }

    if (previewVideo.dataset.previewLoopReady === "true") {
      return () => {};
    }

    this.cleanup(previewVideo);

    const rawSrc = previewVideo.currentSrc || previewVideo.src || "";
    const cacheKey = rawSrc.split("?")[0];

    if (!cacheKey) {
      return () => {};
    }

    previewVideo.dataset.previewLoopReady = "true";
    previewVideo.muted = true;
    previewVideo.loop = false;
    previewVideo.playsInline = true;
    previewVideo.preload = "metadata";

    // ✅ Wait for metadata with longer timeout and graceful fallback
    if (previewVideo.readyState < 1) {
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            previewVideo.removeEventListener("loadedmetadata", handler);
            reject(new Error("Metadata timeout"));
          }, CHUNK_CONFIG.METADATA_TIMEOUT_MS);

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
          `[ChunkPreview] ${entryId}: Metadata wait failed (will use estimate):`,
          err.message,
        );
        // ✅ Continue anyway - we'll use a default duration estimate
      }
    }

    // Create chunk loop (works even without perfect metadata)
    const loop = new ChunkLoop(previewVideo, entryId, cacheKey);
    await loop.init();
    loop.attachHoverListeners(cardElement);

    activeChunkLoops.set(previewVideo, loop);

    // Return cleanup function
    return () => {
      loop.dispose();
    };
  },

  cleanup(previewVideo) {
    if (!previewVideo) return;

    const existing = activeChunkLoops.get(previewVideo);
    if (existing) {
      existing.dispose();
    }

    delete previewVideo.dataset.previewLoopReady;
    delete previewVideo.dataset.chunkLoopActive;
  },

  stopAll() {
    for (const [video, loop] of activeChunkLoops) {
      loop._stopLoop();
    }
  },

  resumeAll() {
    // Loops resume on next hover
  },

  getStats() {
    return {
      activeLoops: activeChunkLoops.size,
      memoryCacheSize: memoryCache.size,
    };
  },

  async clearAllCaches() {
    memoryCache.clear();
    await ChunkCacheDB.clear();
  },
};
