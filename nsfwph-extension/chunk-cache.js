// chunk-cache.js - Two-level chunk cache system (L1: Memory, L2: IndexedDB)
// Caches calculated preview chunk positions to avoid recomputation

(function () {
  "use strict";

  console.log("[ChunkCache] Module loading...");

  // ═══════════════════════════════════════════════════════════════
  // LEVEL 2: INDEXEDDB CACHE
  // ═══════════════════════════════════════════════════════════════

  const ChunkCacheDB = {
    DB_NAME: "NsfwphPreviewCache",
    DB_VERSION: 1,
    STORE_NAME: "chunkCache",
    MAX_ENTRIES: 50,
    MAX_AGE_MS: 24 * 60 * 60 * 1000, // 24 hours
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
          this.cleanupOldEntries().then(() => resolve(this.db));
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
              `[ChunkCacheDB] Cache hit for ${videoSrc.substring(0, 60)}... ` +
                `(accessed ${entry.accessCount} times)`,
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

        // Check cache size and evict if needed
        this.getCacheSize().then((size) => {
          if (size >= this.MAX_ENTRIES) {
            console.log(
              `[ChunkCacheDB] Cache full (${size}/${this.MAX_ENTRIES}), ` +
                `evicting oldest entries...`,
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
                `[ChunkCacheDB] Evicting cached entry for ` +
                  `${cursor.value.videoSrc.substring(0, 60)}...`,
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
                  `[ChunkCacheDB] Removing expired cache for ` +
                    `${cursor.value.videoSrc.substring(0, 60)}...`,
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

  // ═══════════════════════════════════════════════════════════════
  // LEVEL 1: MEMORY CACHE
  // ═══════════════════════════════════════════════════════════════

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

      // Check L1 memory cache first
      if (this.memoryCache.has(videoSrc)) {
        const entry = this.memoryCache.get(videoSrc);
        console.log(
          `[ChunkCache] L1 memory cache hit for ${videoSrc.substring(0, 60)}...`,
        );
        return entry;
      }

      // Check L2 IndexedDB
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
        console.error(
          "[ChunkCache] Invalid videoSrc for cache store:",
          videoSrc,
        );
        return;
      }

      if (!chunks || !Array.isArray(chunks)) {
        console.error("[ChunkCache] Invalid chunks for cache store:", chunks);
        return;
      }

      const entry = { chunks, duration };

      // Store in L1 memory
      this.promoteToMemory(videoSrc, entry);

      // Store in L2 IndexedDB
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

  // ═══════════════════════════════════════════════════════════════
  // EXPORT TO GLOBAL SCOPE
  // ═══════════════════════════════════════════════════════════════

  window.ChunkCache = ChunkCache;
  window.ChunkCacheDB = ChunkCacheDB;

  // Log initial cache stats
  (async () => {
    try {
      const stats = await ChunkCache.getStats();
      console.log(
        "[ChunkCache] Initial cache stats:",
        JSON.stringify(stats, null, 2),
      );
    } catch (error) {
      console.warn("[ChunkCache] Could not get initial cache stats:", error);
    }
  })();

  console.log("[ChunkCache] Module loaded successfully ✅");
})();
