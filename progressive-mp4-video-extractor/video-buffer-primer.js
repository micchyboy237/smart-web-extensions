// video-buffer-primer.js - Initial Buffer Primer for MP4 Videos
// Makes range requests for initial bytes to ensure video initialization data is cached
// v2.2 - Enhanced URL logging + Configurable range + Full URL tracking

class VideoBufferPrimer {
  constructor(options = {}) {
    this.primedUrls = new Set();
    this.pendingPrimers = new Map();
    this.retryQueue = new Map();
    this.maxRetries = options.maxRetries || 3;
    this.retryDelayMs = options.retryDelayMs || 2000;
    this.maxConcurrent = options.maxConcurrent || 5;
    this.activeRequests = 0;
    this.queue = [];

    // CONFIGURABLE RANGE - Default 2000 bytes for MP4 init segment
    this.rangeStart = options.rangeStart || 0;
    this.rangeEnd = options.rangeEnd || 2000; // Set to null for "0-" (unbounded)

    // Track request history for debugging
    this.requestHistory = [];
    this.maxHistorySize = 100;

    // Default headers extracted from HTTP_Request_Headers_MP4_NsfwPH.md
    this.defaultHeaders = {
      Accept: "*/*",
      "Accept-Encoding": "identity;q=1, *;q=0",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Priority: "i",
      "Sec-Fetch-Dest": "video",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "same-site",
      "User-Agent":
        typeof navigator !== "undefined"
          ? navigator.userAgent
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    };

    // Build the range header value
    this.rangeHeader = this._buildRangeHeader();

    console.log(
      "[BufferPrimer] ✅ Initialized v2.2",
      `\n[BufferPrimer] 📋 Default headers:`,
      "\n  • Sec-Fetch-Mode: no-cors",
      "\n  • Sec-Fetch-Dest: video",
      "\n  • Accept-Encoding: identity",
      `\n[BufferPrimer] 🎯 Custom Range: ${this.rangeHeader}`,
      "\n[BufferPrimer] 🔍 Debug mode: Full URL logging enabled",
    );
  }

  /**
   * Build the Range header string from configured range
   * @returns {string}
   * @private
   */
  _buildRangeHeader() {
    if (this.rangeEnd === null || this.rangeEnd === undefined) {
      return `bytes=${this.rangeStart}-`;
    }
    return `bytes=${this.rangeStart}-${this.rangeEnd}`;
  }

  /**
   * Log a request to history for debugging
   * @param {Object} entry
   * @private
   */
  _logRequest(entry) {
    this.requestHistory.push({
      ...entry,
      timestamp: Date.now(),
    });
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Build request headers for a specific URL
   * @param {string} url - The target video URL
   * @param {string} source - Where the URL was detected
   * @returns {Object} Headers object for fetch request
   */
  buildHeaders(url, source = "unknown") {
    const headers = { ...this.defaultHeaders };
    try {
      const urlObj = new URL(url);
      headers["Referer"] = `${urlObj.protocol}//${urlObj.hostname}/`;
      headers["Origin"] = `${urlObj.protocol}//${urlObj.hostname}`;

      console.log(
        `[BufferPrimer] 🛠️ Headers built for: ${urlObj.hostname}`,
        "\n  • Full URL (truncated):",
        this._truncateUrl(url, 80),
        "\n  • Path:",
        urlObj.pathname,
        "\n  • Hash present:",
        urlObj.searchParams.has("hash") ? "✅ YES" : "❌ NO",
        "\n  • Hash value:",
        urlObj.searchParams.get("hash") || "N/A",
        "\n  • Referer:",
        headers["Referer"],
        "\n  • Origin:",
        headers["Origin"],
        "\n  • Range:",
        this.rangeHeader,
      );
    } catch (error) {
      console.warn(
        `[BufferPrimer] ⚠️ URL parse failed, using fallback headers:`,
        error.message,
        "\n  • Problematic URL:",
        url,
      );
      headers["Referer"] = "https://nsfwph.org/";
      headers["Origin"] = "https://nsfwph.org";
    }
    return headers;
  }

  /**
   * Truncate URL for logging
   * @param {string} url
   * @param {number} maxLen
   * @returns {string}
   * @private
   */
  _truncateUrl(url, maxLen = 80) {
    if (url.length <= maxLen) return url;
    return url.substring(0, maxLen - 3) + "...";
  }

  /**
   * Prime a video URL with initial buffer bytes
   * @param {string} url - The MP4 video URL (WITH hash parameter)
   * @param {string} source - Where the URL was detected
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async primeVideoBuffer(url, source = "unknown") {
    // Log the FULL URL being primed
    console.log(
      `[BufferPrimer] 📥 primeVideoBuffer called:`,
      "\n  • Full URL:",
      url,
      "\n  • Source:",
      source,
      "\n  • Already primed:",
      this.primedUrls.has(url),
      "\n  • Already pending:",
      this.pendingPrimers.has(url),
    );

    if (this.primedUrls.has(url)) {
      console.log(
        `[BufferPrimer] ⏭️ Already primed: ${this.extractFilename(url)}`,
      );
      return { success: true, message: "Already primed" };
    }

    if (this.pendingPrimers.has(url)) {
      console.log(
        `[BufferPrimer] ⏳ Already pending: ${this.extractFilename(url)}`,
      );
      return { success: false, message: "Already in progress" };
    }

    if (this.activeRequests >= this.maxConcurrent) {
      console.log(
        `[BufferPrimer] 📋 Queuing (${this.queue.length + 1}): ${this.extractFilename(url)}`,
      );
      return new Promise((resolve) => {
        this.queue.push({ url, source, resolve });
      });
    }

    return this._executePrime(url, source);
  }

  /**
   * Execute the actual priming request
   * @param {string} url - FULL URL with hash
   * @param {string} source
   * @returns {Promise}
   * @private
   */
  async _executePrime(url, source) {
    this.activeRequests++;
    this.pendingPrimers.set(url, { startTime: Date.now(), source });

    const filename = this.extractFilename(url);
    const startTime = Date.now();

    console.log(`[BufferPrimer] 🚀 START Priming: ${filename}`);
    console.log(`[BufferPrimer] 📡 FULL URL: ${url}`);
    console.log(
      `[BufferPrimer] 📡 Active: ${this.activeRequests}/${this.maxConcurrent}`,
    );

    // Verify hash presence
    try {
      const urlObj = new URL(url);
      const hasHash = urlObj.searchParams.has("hash");
      console.log(
        `[BufferPrimer] 🔑 Hash check:`,
        `\n  • Has hash param: ${hasHash ? "✅ YES" : "❌ NO"}`,
        `\n  • Hash value: ${urlObj.searchParams.get("hash") || "N/A"}`,
        `\n  • Full query string: ${urlObj.search}`,
      );
    } catch (e) {
      console.warn(
        `[BufferPrimer] ⚠️ Could not parse URL for hash check:`,
        e.message,
      );
    }

    try {
      const dynamicHeaders = this.buildHeaders(url, source);

      // BUILD REQUEST HEADERS WITH CUSTOM RANGE
      const requestHeaders = {
        ...dynamicHeaders,
        Range: this.rangeHeader, // ← CUSTOM RANGE APPLIED HERE
      };

      // Log the EXACT request being made
      console.log(
        `[BufferPrimer] 📤 REQUEST DETAILS:`,
        `\n  • URL: ${url}`,
        `\n  • Method: GET`,
        `\n  • Mode: no-cors`,
        `\n  • Range: ${this.rangeHeader}`,
        `\n  • Headers:`,
        JSON.stringify(
          {
            Range: requestHeaders["Range"],
            "Sec-Fetch-Mode": requestHeaders["Sec-Fetch-Mode"],
            "Sec-Fetch-Dest": requestHeaders["Sec-Fetch-Dest"],
            Referer: requestHeaders["Referer"],
            Origin: requestHeaders["Origin"],
          },
          null,
          2,
        ),
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log(`[BufferPrimer] ⏱️ Timeout (10s): ${filename}`);
        controller.abort();
      }, 10000);

      // THE ACTUAL FETCH - Full URL with hash is sent here
      console.log(`[BufferPrimer] 🌐 Executing fetch with FULL URL...`);
      const response = await fetch(url, {
        method: "GET",
        headers: requestHeaders,
        mode: "no-cors",
        signal: controller.signal,
        credentials: "omit",
      });

      clearTimeout(timeoutId);

      const elapsedMs = Date.now() - startTime;
      const responseType = response.type;
      const responseStatus = response.status;

      console.log(`[BufferPrimer] 📥 Response (${elapsedMs}ms):`, {
        filename,
        type: responseType,
        status: responseStatus,
        ok: response.ok,
        url: this._truncateUrl(response.url, 80), // The URL the server actually responded to
      });

      let actualSize = 0;
      let contentRange = null;

      try {
        if (responseType !== "opaque") {
          const buffer = await response.arrayBuffer();
          actualSize = buffer.byteLength;
          contentRange = response.headers.get("Content-Range");
          console.log(
            `[BufferPrimer] 📦 Received ${actualSize} bytes`,
            `\n  • Content-Range: ${contentRange || "N/A"}`,
          );
        } else {
          console.log(
            `[BufferPrimer] ℹ️ Opaque response - body not readable`,
            `\n  • This is expected in no-cors mode`,
            `\n  • The request WAS sent with the full URL and range header`,
          );
        }
      } catch (readError) {
        console.log(`[BufferPrimer] ℹ️ Cannot read body: ${readError.message}`);
      }

      // Mark as primed
      this.primedUrls.add(url);
      this.retryQueue.delete(url);

      // Log the request to history
      this._logRequest({
        url,
        filename,
        rangeSent: this.rangeHeader,
        responseType,
        responseStatus,
        bytesReceived: actualSize,
        contentRange,
        elapsedMs,
        success: true,
      });

      const totalSize = contentRange ? contentRange.split("/")[1] : "unknown";
      console.log(`[BufferPrimer] ✅ SUCCESS: ${filename}`);
      console.log(`[BufferPrimer]    ├─ Range sent: ${this.rangeHeader}`);
      console.log(
        `[BufferPrimer]    ├─ Range received: ${contentRange || "opaque"}`,
      );
      console.log(
        `[BufferPrimer]    ├─ Received: ${actualSize || "opaque"} bytes`,
      );
      console.log(`[BufferPrimer]    ├─ Total: ${totalSize}`);
      console.log(`[BufferPrimer]    └─ Elapsed: ${elapsedMs}ms`);

      return {
        success: true,
        message: `Primed ${actualSize || "opaque"} bytes`,
        bytesReceived: actualSize,
        totalSize: totalSize,
        responseType: responseType,
        rangeSent: this.rangeHeader,
        url: url,
      };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;

      console.error(`[BufferPrimer] ❌ FAILED: ${filename}`);
      console.error(`[BufferPrimer]    ├─ URL: ${url}`);
      console.error(`[BufferPrimer]    ├─ Range: ${this.rangeHeader}`);
      console.error(`[BufferPrimer]    ├─ Error name: ${error.name}`);
      console.error(`[BufferPrimer]    ├─ Error message: ${error.message}`);
      console.error(`[BufferPrimer]    └─ Elapsed: ${elapsedMs}ms`);

      if (
        error.name === "TypeError" &&
        error.message.includes("Failed to fetch")
      ) {
        console.error(`[BufferPrimer] 🔴 Possible CORS/Network error`);
        console.error(
          `[BufferPrimer] 🔴 Check if the hash is valid and the server accepts the range`,
        );
      }

      // Log failure
      this._logRequest({
        url,
        filename,
        rangeSent: this.rangeHeader,
        error: error.message,
        errorName: error.name,
        elapsedMs,
        success: false,
      });

      // Retry logic
      const retryInfo = this.retryQueue.get(url) || { count: 0 };
      retryInfo.count++;
      retryInfo.lastError = error.message;
      retryInfo.lastAttempt = Date.now();

      if (retryInfo.count < this.maxRetries) {
        console.log(
          `[BufferPrimer] 🔄 Will retry (${retryInfo.count}/${this.maxRetries})`,
        );
        this.retryQueue.set(url, retryInfo);
        const delay = this.retryDelayMs * Math.pow(2, retryInfo.count - 1);
        setTimeout(() => {
          this.pendingPrimers.delete(url);
          this._executePrime(url, source);
        }, delay);
      } else {
        console.log(`[BufferPrimer] ❌ Max retries reached for: ${url}`);
        this.retryQueue.delete(url);
      }

      return {
        success: false,
        message: error.message,
        retryCount: retryInfo.count,
        rangeSent: this.rangeHeader,
        url: url,
      };
    } finally {
      this.activeRequests--;
      this.pendingPrimers.delete(url);

      if (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
        const next = this.queue.shift();
        console.log(
          `[BufferPrimer] 📤 Dequeuing: ${this.extractFilename(next.url)}`,
          `\n  • Full URL: ${next.url}`,
        );
        this._executePrime(next.url, next.source).then(next.resolve);
      }

      console.log(
        `[BufferPrimer] 📊 Stats - Primed: ${this.primedUrls.size}, Active: ${this.activeRequests}, Queue: ${this.queue.length}`,
      );
    }
  }

  /**
   * Check if URL should be primed (MP4/WebM videos only)
   * @param {string} url - Full URL to check
   * @returns {boolean}
   */
  shouldPrime(url) {
    if (!url) {
      console.log("[BufferPrimer] 🔍 shouldPrime: FALSE (null/empty URL)");
      return false;
    }

    const lowerUrl = url.toLowerCase();

    // Check for video extensions - INCLUDING when followed by ? or &
    const videoExtensions = [
      ".mp4",
      ".webm",
      ".mov",
      ".avi",
      ".mkv",
      ".flv",
      ".wmv",
    ];

    for (const ext of videoExtensions) {
      const extPatterns = [
        lowerUrl.endsWith(ext),
        lowerUrl.includes(`${ext}?`), // ← Catches .mp4?hash=...
        lowerUrl.includes(`${ext}&`),
        lowerUrl.includes(`${ext}#`),
        lowerUrl.includes(`${ext}/`),
      ];

      if (extPatterns.some((p) => p)) {
        // Log with hash detection
        const hasHash = lowerUrl.includes("hash=");
        console.log(
          `[BufferPrimer] ✅ shouldPrime: TRUE (matched extension: ${ext})`,
          `\n[BufferPrimer]    URL: ${this._truncateUrl(url, 100)}`,
          `\n[BufferPrimer]    Hash present: ${hasHash ? "✅ YES" : "❌ NO"}`,
        );
        return true;
      }
    }

    // Check for video MIME patterns in URL path
    const pathPatterns = ["/video/", "video/mp4", "content-type=video"];
    for (const pattern of pathPatterns) {
      if (lowerUrl.includes(pattern)) {
        console.log(
          `[BufferPrimer] ✅ shouldPrime: TRUE (matched path pattern: ${pattern})`,
          `\n[BufferPrimer]    URL: ${this._truncateUrl(url, 100)}`,
        );
        return true;
      }
    }

    console.log(
      `[BufferPrimer] ❌ shouldPrime: FALSE (no video pattern matched)`,
      `\n[BufferPrimer]    URL: ${this._truncateUrl(url, 100)}`,
    );
    return false;
  }

  /**
   * Extract filename from URL
   * @param {string} url
   * @returns {string}
   */
  extractFilename(url) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split("/");
      let filename = pathParts[pathParts.length - 1];
      if (!filename || filename.length === 0) {
        filename = "unknown.mp4";
      }
      // Strip query params for display, but note the hash is still in the URL
      const hashValue = urlObj.searchParams.get("hash");
      filename = filename.split("?")[0];
      if (filename.length > 50) {
        filename = filename.substring(0, 47) + "...";
      }
      if (hashValue) {
        filename += ` [hash: ${hashValue.substring(0, 8)}...]`;
      }
      return filename;
    } catch {
      return url.substring(0, 50);
    }
  }

  /**
   * Get statistics about priming activity
   * @returns {Object}
   */
  getStats() {
    const stats = {
      totalPrimed: this.primedUrls.size,
      activeRequests: this.activeRequests,
      queueLength: this.queue.length,
      pendingCount: this.pendingPrimers.size,
      retryCount: this.retryQueue.size,
      maxConcurrent: this.maxConcurrent,
      rangeHeader: this.rangeHeader,
      primedUrlsList: Array.from(this.primedUrls).map((url) => ({
        url: url,
        filename: this.extractFilename(url),
      })),
      recentRequests: this.requestHistory.slice(-10), // Last 10 requests
    };

    console.log(
      `[BufferPrimer] 📊 Stats:`,
      JSON.stringify(
        {
          primed: stats.totalPrimed,
          active: stats.activeRequests,
          queue: stats.queueLength,
          retries: stats.retryCount,
          range: stats.rangeHeader,
          recentFailures: stats.recentRequests.filter((r) => !r.success).length,
        },
        null,
        2,
      ),
    );

    return stats;
  }

  /**
   * Get request history
   * @returns {Array}
   */
  getRequestHistory() {
    return [...this.requestHistory];
  }

  /**
   * Clear all tracked URLs and history
   */
  clear() {
    const count = this.primedUrls.size;
    const historyCount = this.requestHistory.length;

    this.primedUrls.clear();
    this.pendingPrimers.clear();
    this.retryQueue.clear();
    this.queue = [];
    this.activeRequests = 0;
    this.requestHistory = [];

    console.log(
      `[BufferPrimer] 🧹 Cleared ${count} primed URLs and ${historyCount} history entries`,
    );
  }
}

// Export for use in background.js
if (typeof module !== "undefined" && module.exports) {
  module.exports = VideoBufferPrimer;
}
