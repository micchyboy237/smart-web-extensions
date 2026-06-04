// video-buffer-primer.js - Initial Buffer Primer for MP4 Videos
// Makes range requests for first 2000 bytes to ensure video initialization data is cached
// v2.1 - Fixed shouldPrime logic + Added debug logging for all URLs

class VideoBufferPrimer {
  constructor() {
    this.primedUrls = new Set();
    this.pendingPrimers = new Map();
    this.retryQueue = new Map();
    this.maxRetries = 3;
    this.retryDelayMs = 2000;
    this.maxConcurrent = 5;
    this.activeRequests = 0;
    this.queue = [];

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

    console.log(
      "[BufferPrimer] ✅ Initialized v2.1",
      "\n[BufferPrimer] 📋 Default headers:",
      "\n  • Sec-Fetch-Mode: no-cors",
      "\n  • Sec-Fetch-Dest: video",
      "\n  • Accept-Encoding: identity",
      "\n[BufferPrimer] 🔍 Debug mode: All shouldPrime calls will be logged",
    );
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

      if (source === "debugger" || source === "contentScript") {
        headers["Sec-Fetch-Site"] = "same-site";
      }

      console.log(
        `[BufferPrimer] 🛠️ Headers built for: ${urlObj.hostname}`,
        "\n  • Referer:",
        headers["Referer"],
        "\n  • Origin:",
        headers["Origin"],
      );
    } catch (error) {
      console.warn(
        `[BufferPrimer] ⚠️ URL parse failed, using fallback headers:`,
        error.message,
      );
      headers["Referer"] = "https://nsfwph.org/";
      headers["Origin"] = "https://nsfwph.org";
    }

    return headers;
  }

  /**
   * Prime a video URL with initial 2000 bytes buffer
   * @param {string} url - The MP4 video URL
   * @param {string} source - Where the URL was detected
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async primeVideoBuffer(url, source = "unknown") {
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
   * @private
   */
  async _executePrime(url, source) {
    this.activeRequests++;
    this.pendingPrimers.set(url, { startTime: Date.now(), source });

    const filename = this.extractFilename(url);
    console.log(`[BufferPrimer] 🚀 START Priming: ${filename}`);
    console.log(`[BufferPrimer] 📡 Full URL: ${url}`);
    console.log(
      `[BufferPrimer] 📡 Active: ${this.activeRequests}/${this.maxConcurrent}`,
    );

    try {
      const dynamicHeaders = this.buildHeaders(url, source);

      const requestHeaders = {
        ...dynamicHeaders,
        Range: "bytes=0-2000",
      };

      console.log(
        `[BufferPrimer] 📤 Fetch headers:`,
        JSON.stringify({
          Range: requestHeaders["Range"],
          "Sec-Fetch-Mode": requestHeaders["Sec-Fetch-Mode"],
          "Sec-Fetch-Dest": requestHeaders["Sec-Fetch-Dest"],
          Referer: requestHeaders["Referer"],
          Origin: requestHeaders["Origin"],
        }),
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log(`[BufferPrimer] ⏱️ Timeout (10s): ${filename}`);
        controller.abort();
      }, 10000);

      console.log(`[BufferPrimer] 🌐 Executing fetch...`);

      const response = await fetch(url, {
        method: "GET",
        headers: requestHeaders,
        mode: "no-cors",
        signal: controller.signal,
        credentials: "omit",
      });

      clearTimeout(timeoutId);

      const responseType = response.type;
      const responseStatus = response.status;

      console.log(`[BufferPrimer] 📥 Response:`, {
        filename,
        type: responseType,
        status: responseStatus,
        ok: response.ok,
      });

      let actualSize = 0;
      let contentRange = null;

      try {
        if (responseType !== "opaque") {
          const buffer = await response.arrayBuffer();
          actualSize = buffer.byteLength;
          contentRange = response.headers.get("Content-Range");
          console.log(`[BufferPrimer] 📦 Received ${actualSize} bytes`);
        } else {
          console.log(`[BufferPrimer] ℹ️ Opaque response - body not readable`);
        }
      } catch (readError) {
        console.log(`[BufferPrimer] ℹ️ Cannot read body: ${readError.message}`);
      }

      this.primedUrls.add(url);
      this.retryQueue.delete(url);

      const totalSize = contentRange ? contentRange.split("/")[1] : "unknown";
      console.log(`[BufferPrimer] ✅ SUCCESS: ${filename}`);
      console.log(`[BufferPrimer]    ├─ Range: ${contentRange || "opaque"}`);
      console.log(
        `[BufferPrimer]    ├─ Received: ${actualSize || "opaque"} bytes`,
      );
      console.log(`[BufferPrimer]    └─ Total: ${totalSize}`);

      return {
        success: true,
        message: `Primed ${actualSize || "opaque"} bytes`,
        bytesReceived: actualSize,
        totalSize: totalSize,
        responseType: responseType,
      };
    } catch (error) {
      console.error(`[BufferPrimer] ❌ FAILED: ${filename}`);
      console.error(`[BufferPrimer]    Error name: ${error.name}`);
      console.error(`[BufferPrimer]    Error message: ${error.message}`);

      if (
        error.name === "TypeError" &&
        error.message.includes("Failed to fetch")
      ) {
        console.error(`[BufferPrimer] 🔴 Possible CORS/Network error`);
      }

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
        console.log(`[BufferPrimer] ❌ Max retries reached`);
        this.retryQueue.delete(url);
      }

      return {
        success: false,
        message: error.message,
        retryCount: retryInfo.count,
      };
    } finally {
      this.activeRequests--;
      this.pendingPrimers.delete(url);

      if (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
        const next = this.queue.shift();
        console.log(
          `[BufferPrimer] 📤 Dequeuing: ${this.extractFilename(next.url)}`,
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
   * @param {string} url
   * @returns {boolean}
   */
  shouldPrime(url) {
    if (!url) {
      console.log("[BufferPrimer] 🔍 shouldPrime: FALSE (null/empty URL)");
      return false;
    }

    const lowerUrl = url.toLowerCase();

    // Log the URL being checked (truncated for readability)
    console.log(
      `[BufferPrimer] 🔍 shouldPrime checking: ${url.substring(0, 100)}...`,
    );

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
      // Check if URL contains the extension followed by:
      // - end of string
      // - question mark (query param)
      // - ampersand (additional query param)
      // - hash fragment
      const extPatterns = [
        lowerUrl.endsWith(ext), // ends with .mp4
        lowerUrl.includes(`${ext}?`), // .mp4?hash=...
        lowerUrl.includes(`${ext}&`), // .mp4&other=...
        lowerUrl.includes(`${ext}#`), // .mp4#fragment
        lowerUrl.includes(`${ext}/`), // .mp4/ (unlikely but possible)
      ];

      if (extPatterns.some((p) => p)) {
        console.log(
          `[BufferPrimer] ✅ shouldPrime: TRUE (matched extension: ${ext})`,
        );
        console.log(`[BufferPrimer]    URL: ${url.substring(0, 100)}...`);
        return true;
      }
    }

    // Check for video MIME patterns in URL path
    const pathPatterns = ["/video/", "video/mp4", "content-type=video"];
    for (const pattern of pathPatterns) {
      if (lowerUrl.includes(pattern)) {
        console.log(
          `[BufferPrimer] ✅ shouldPrime: TRUE (matched path pattern: ${pattern})`,
        );
        console.log(`[BufferPrimer]    URL: ${url.substring(0, 100)}...`);
        return true;
      }
    }

    console.log(
      `[BufferPrimer] ❌ shouldPrime: FALSE (no video pattern matched)`,
    );
    console.log(`[BufferPrimer]    URL: ${url.substring(0, 100)}...`);
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
      filename = filename.split("?")[0];
      if (filename.length > 50) {
        filename = filename.substring(0, 47) + "...";
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
      primedUrlsList: Array.from(this.primedUrls).map((url) => ({
        url: url.substring(0, 80),
        filename: this.extractFilename(url),
      })),
    };

    console.log(
      `[BufferPrimer] 📊 Stats: ${JSON.stringify({
        primed: stats.totalPrimed,
        active: stats.activeRequests,
        queue: stats.queueLength,
        retries: stats.retryCount,
      })}`,
    );

    return stats;
  }

  /**
   * Clear all tracked URLs
   */
  clear() {
    const count = this.primedUrls.size;
    this.primedUrls.clear();
    this.pendingPrimers.clear();
    this.retryQueue.clear();
    this.queue = [];
    this.activeRequests = 0;
    console.log(`[BufferPrimer] 🧹 Cleared ${count} primed URLs`);
  }
}

// Export for use in background.js
if (typeof module !== "undefined" && module.exports) {
  module.exports = VideoBufferPrimer;
}
