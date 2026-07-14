// Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server-client.js
/**
 * Server Integration Client
 *
 * Handles all communication with the Python FastAPI server.
 * Loaded by service-worker.js (background context) so that Chrome's Local
 * Network Access permission applies to the extension's own origin rather
 * than whatever page injected a content script.
 */
// ====================== CONFIGURATION ======================
const SERVER_CONFIG = {
  BASE_URL: "http://192.168.68.30:8000/api",
  ENDPOINTS: {
    INGEST: "/videos/ingest",
    SEARCH: "/search",
    VIDEO: "/videos",
    COUNT: "/videos/count",
    PREFERENCES: "/preferences",
  },
  TIMEOUT_MS: 10000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 1000,
};
// ====================== SERVER CLIENT CLASS ======================
class MissAVServerClient {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || SERVER_CONFIG.BASE_URL;
    this.timeout = config.timeout || SERVER_CONFIG.TIMEOUT_MS;
    this.retryAttempts = config.retryAttempts || SERVER_CONFIG.RETRY_ATTEMPTS;
    this.retryDelay = config.retryDelay || SERVER_CONFIG.RETRY_DELAY_MS;
    // Track sync state
    this.syncState = {
      isOnline: false,
      lastSyncTime: null,
      pendingVideos: [],
      syncInProgress: false,
    };
    // Check server connectivity on init
    this._checkConnectivity();
    console.log("[SERVER CLIENT] ✅ Initialized", {
      baseUrl: this.baseUrl,
      timeout: this.timeout,
    });
  }
  // ====================== CONNECTIVITY ======================
  async _checkConnectivity() {
    try {
      const response = await this._fetchWithTimeout(
        `${this.baseUrl}${SERVER_CONFIG.ENDPOINTS.COUNT}`,
        { method: "GET", signal: AbortSignal.timeout(5000) },
      );
      if (response.ok) {
        const data = await response.json();
        this.syncState.isOnline = true;
        console.log("[SERVER CLIENT] 🌐 Server online. Videos:", data.count);
      }
    } catch (err) {
      this.syncState.isOnline = false;
      console.warn("[SERVER CLIENT] ⚠️ Server offline:", err.message);
    }
  }
  async isServerOnline() {
    await this._checkConnectivity();
    return this.syncState.isOnline;
  }
  // ====================== VIDEO INGESTION ======================
  /**
   * Send scraped videos to the server.
   *
   * @param {Array} videos - Array of video objects from extractData()
   * @param {Object} options - Ingestion options
   * @returns {Promise<Object>} Server response
   */
  async ingestVideos(videos, options = {}) {
    const { source = "extension", retry = true } = options;
    if (!videos || videos.length === 0) {
      console.log("[SERVER CLIENT] 📭 No videos to ingest");
      return { ingested: 0, total: 0 };
    }
    // Add generated IDs if not present
    const videosWithIds = videos.map((video) => ({
      ...video,
      id: video.id || generateIdFromUrl(video.url, video.videoId),
    }));
    console.log(
      `[SERVER CLIENT] 📤 Sending ${videosWithIds.length} videos to server`,
    );
    const payload = {
      videos: videosWithIds,
      source: source,
    };
    try {
      const response = await this._fetchWithRetry(
        `${this.baseUrl}${SERVER_CONFIG.ENDPOINTS.INGEST}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          // NOTE: no signal here anymore — _fetchWithRetry builds a FRESH
          // AbortSignal.timeout() for every attempt (see below). Passing a
          // pre-built one meant the SAME signal was reused across retries,
          // and since AbortSignal.timeout() starts counting the moment
          // it's created, later retries could arrive already-expired and
          // get "canceled" instantly.
        },
        retry ? this.retryAttempts : 0,
      );
      if (!response.ok) {
        throw new Error(
          `Server returned ${response.status}: ${response.statusText}`,
        );
      }
      const result = await response.json();
      this.syncState.lastSyncTime = new Date().toISOString();
      this.syncState.isOnline = true;
      console.log("[SERVER CLIENT] ✅ Ingest complete:", {
        ingested: result.ingested,
        total: result.total,
        time_ms: result.time_ms,
      });
      return result;
    } catch (err) {
      console.error("[SERVER CLIENT] ❌ Ingest failed:", err.message);
      this.syncState.isOnline = false;
      // Queue for retry if offline
      if (retry) {
        this.syncState.pendingVideos.push(...videosWithIds);
        console.log(
          "[SERVER CLIENT] 📦 Queued for retry. Pending:",
          this.syncState.pendingVideos.length,
        );
      }
      throw err;
    }
  }
  /**
   * Retry sending any pending videos.
   */
  async retryPendingVideos() {
    if (this.syncState.pendingVideos.length === 0) {
      console.log("[SERVER CLIENT] 📦 No pending videos to retry");
      return;
    }
    if (this.syncState.syncInProgress) {
      console.log("[SERVER CLIENT] ⏳ Sync already in progress");
      return;
    }
    this.syncState.syncInProgress = true;
    const pending = [...this.syncState.pendingVideos];
    this.syncState.pendingVideos = [];
    console.log(`[SERVER CLIENT] 🔄 Retrying ${pending.length} pending videos`);
    try {
      await this.ingestVideos(pending, { retry: false });
    } catch (err) {
      // Put back in queue if still failing
      this.syncState.pendingVideos.push(...pending);
      console.error("[SERVER CLIENT] ❌ Retry failed, re-queued");
    } finally {
      this.syncState.syncInProgress = false;
    }
  }
  // ====================== SMART SEARCH ======================
  /**
   * Perform smart search with filters and diversity.
   *
   * @param {Object} searchParams - Search configuration
   * @returns {Promise<Object>} SearchResponse
   */
  async search(searchParams = {}) {
    const {
      query = "",
      topK = 20,
      includeCodes = [],
      excludeCodes = [],
      excludeIds = [],
      includeEpisodes = [],
      episodeRange = null,
      diversityFactor = 0.3,
      maxPerCode = null,
      searchType = "hybrid",
      limitToIds = null,
    } = searchParams;
    console.log("[SERVER CLIENT] 🔍 Search request:", {
      query,
      topK,
      searchType,
      includeCodes,
      excludeCodes,
      diversityFactor,
      limitToIds,
    });
    const payload = {
      query,
      top_k: topK,
      include_codes: includeCodes,
      exclude_codes: excludeCodes,
      exclude_ids: excludeIds,
      include_episodes: includeEpisodes,
      include_episode_range: episodeRange,
      diversity_factor: diversityFactor,
      max_per_code: maxPerCode,
      search_type: searchType,
      limit_to_ids: limitToIds,
    };
    try {
      const response = await this._fetchWithTimeout(
        `${this.baseUrl}${SERVER_CONFIG.ENDPOINTS.SEARCH}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeout),
        },
      );
      if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
      }
      const result = await response.json();
      console.log("[SERVER CLIENT] ✅ Search complete:", {
        results_count: result.results?.length,
        total_candidates: result.total_candidates,
        time_ms: result.search_time_ms,
      });
      if (result.query_understanding) {
        console.log(
          "[SERVER CLIENT] 🧠 Query understanding:",
          result.query_understanding,
        );
      }
      return result;
    } catch (err) {
      console.error("[SERVER CLIENT] ❌ Search failed:", err.message);
      throw err;
    }
  }
  /**
   * Quick search helper for common use cases.
   */
  async quickSearch(query, options = {}) {
    return this.search({
      query,
      topK: options.topK || 10,
      searchType: options.searchType || "hybrid",
      diversityFactor: options.diversityFactor || 0.3,
      ...options,
    });
  }
  /**
   * Find similar videos to a given video.
   */
  async findSimilar(videoId, options = {}) {
    const video = await this.getVideo(videoId);
    if (!video) {
      throw new Error(`Video not found: ${videoId}`);
    }
    // Search using the video's text/code as query
    const searchQuery = video.metadata?.text || video.metadata?.code || "";
    return this.search({
      query: searchQuery,
      topK: options.topK || 10,
      excludeIds: [videoId], // Exclude the video itself
      diversityFactor: 0.5, // Higher diversity for recommendations
      ...options,
    });
  }
  // ====================== VIDEO OPERATIONS ======================
  /**
   * Get a single video by ID.
   */
  async getVideo(videoId) {
    console.log("[SERVER CLIENT] 🔍 Getting video:", videoId);
    try {
      const response = await this._fetchWithTimeout(
        `${this.baseUrl}${SERVER_CONFIG.ENDPOINTS.VIDEO}/${videoId}`,
        {
          method: "GET",
          signal: AbortSignal.timeout(this.timeout),
        },
      );
      if (response.status === 404) {
        console.log("[SERVER CLIENT] ⚠️ Video not found:", videoId);
        return null;
      }
      if (!response.ok) {
        throw new Error(`Failed to get video: ${response.status}`);
      }
      const result = await response.json();
      console.log("[SERVER CLIENT] ✅ Video retrieved:", result.id);
      return result;
    } catch (err) {
      console.error("[SERVER CLIENT] ❌ Get video failed:", err.message);
      throw err;
    }
  }
  /**
   * Get total video count on server.
   */
  async getCount() {
    try {
      const response = await this._fetchWithTimeout(
        `${this.baseUrl}${SERVER_CONFIG.ENDPOINTS.COUNT}`,
        {
          method: "GET",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (response.ok) {
        const data = await response.json();
        return data.count;
      }
    } catch (err) {
      console.error("[SERVER CLIENT] ❌ Get count failed:", err.message);
    }
    return 0;
  }
  // ====================== USER PREFERENCES ======================
  /**
   * Update user preferences for personalized search.
   */
  async updatePreferences(preferences = {}) {
    const payload = {
      user_id: preferences.userId || "default",
      favorite_codes: preferences.favoriteCodes || [],
      blocked_codes: preferences.blockedCodes || [],
      watched_ids: preferences.watchedIds || [],
      preferred_episode_range: preferences.preferredEpisodeRange || null,
      diversity_preference: preferences.diversityPreference || 0.3,
    };
    console.log("[SERVER CLIENT] 📝 Updating preferences:", payload);
    try {
      const response = await this._fetchWithTimeout(
        `${this.baseUrl}${SERVER_CONFIG.ENDPOINTS.PREFERENCES}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeout),
        },
      );
      if (response.ok) {
        const result = await response.json();
        console.log("[SERVER CLIENT] ✅ Preferences updated");
        return result;
      }
    } catch (err) {
      console.error(
        "[SERVER CLIENT] ❌ Preferences update failed:",
        err.message,
      );
    }
    return null;
  }
  /**
   * Get user preferences.
   */
  async getPreferences(userId = "default") {
    try {
      const response = await this._fetchWithTimeout(
        `${this.baseUrl}${SERVER_CONFIG.ENDPOINTS.PREFERENCES}/${userId}`,
        {
          method: "GET",
          signal: AbortSignal.timeout(this.timeout),
        },
      );
      if (response.ok) {
        const result = await response.json();
        console.log("[SERVER CLIENT] ✅ Preferences retrieved");
        return result;
      }
    } catch (err) {
      console.error("[SERVER CLIENT] ❌ Get preferences failed:", err.message);
    }
    return null;
  }
  // ====================== SYNC STATUS ======================
  /**
   * Get current sync state.
   */
  getSyncState() {
    return {
      ...this.syncState,
      pendingCount: this.syncState.pendingVideos.length,
    };
  }
  /**
   * Force a full sync check.
   */
  async syncNow() {
    console.log("[SERVER CLIENT] 🔄 Force sync requested");
    await this._checkConnectivity();
    if (this.syncState.isOnline) {
      await this.retryPendingVideos();
    }
    return this.getSyncState();
  }
  // ====================== HTTP HELPERS ======================
  /**
   * Plain fetch wrapper. Falls back to a fresh AbortSignal.timeout() if
   * the caller didn't already supply a signal.
   */
  async _fetchWithTimeout(url, options = {}) {
    const signal = options.signal || AbortSignal.timeout(this.timeout);
    return fetch(url, { ...options, signal });
  }
  /**
   * Retry wrapper with exponential backoff.
   *
   * FIX: builds a brand new AbortSignal.timeout() for EVERY attempt,
   * created right before that attempt fires (i.e. after the backoff
   * delay has already elapsed). Previously a single signal was created
   * once before the loop and reused — since AbortSignal.timeout() starts
   * counting down at creation time, later retries could start with a
   * signal that had already expired during the backoff wait, causing an
   * instant "canceled" fetch before any request was even sent.
   */
  async _fetchWithRetry(url, options = {}, retries = 0) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
          console.log(
            `[SERVER CLIENT] 🔄 Retry ${attempt}/${retries} in ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const attemptOptions = {
          ...options,
          signal: AbortSignal.timeout(this.timeout), // fresh signal, fresh clock
        };
        console.log(
          `[SERVER CLIENT] 🌐 Attempt ${attempt + 1}/${retries + 1} → ${url}`,
        );
        return await this._fetchWithTimeout(url, attemptOptions);
      } catch (err) {
        lastError = err;
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          console.warn(
            `[SERVER CLIENT] ⏱️ Timed out / canceled (attempt ${attempt + 1}):`,
            err.message,
          );
        } else if (err.name === "TypeError" && err.message.includes("fetch")) {
          console.warn(
            `[SERVER CLIENT] 🌐 Network error (attempt ${attempt + 1})`,
          );
        }
      }
    }
    throw lastError;
  }
}
// ====================== GLOBAL INSTANCE ======================
// Create singleton instance
const serverClient = new MissAVServerClient();
// Export for use in other files
if (typeof module !== "undefined" && module.exports) {
  module.exports = { MissAVServerClient, serverClient, SERVER_CONFIG };
}
console.log("[SERVER CLIENT] ✅ Module loaded");
