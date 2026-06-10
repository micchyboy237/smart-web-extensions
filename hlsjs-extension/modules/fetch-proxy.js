/**
 * fetch-proxy.js - Intercepts fetch() calls and routes through background.js
 *
 * This module overrides window.fetch to proxy HLS resource requests through
 * the extension's service worker, bypassing CORS restrictions entirely.
 *
 * WHY THIS WORKS:
 * - Service workers have no CORS restrictions when making fetch requests
 * - We intercept the fetch in the content script
 * - Send the URL to background.js via chrome.runtime.sendMessage
 * - background.js fetches the resource (no CORS!)
 * - Return the response back to the content script as a Response object
 */

(function () {
  "use strict";

  // ============================================================================
  // Configuration
  // ============================================================================
  const CONFIG = {
    HLS_EXTENSIONS: [
      ".m3u8",
      ".ts",
      ".m4s",
      ".m4a",
      ".m4v",
      ".mp4",
      ".aac",
      ".vtt",
    ],
    ENABLE_LOGGING: true,
    // Timeout for proxy fetch requests
    FETCH_TIMEOUT: 30000,
  };

  // ============================================================================
  // Logger (Self-contained, no external dependencies)
  // ============================================================================
  const Logger = {
    log: (level, msg, data) => {
      if (!CONFIG.ENABLE_LOGGING) return;
      const prefix = "[FetchProxy]";
      switch (level) {
        case "debug":
          console.debug(`${prefix}[DEBUG] ${msg}`, data || "");
          break;
        case "info":
          console.log(`${prefix}[INFO] ${msg}`, data || "");
          break;
        case "warn":
          console.warn(`${prefix}[WARN] ${msg}`, data || "");
          break;
        case "error":
          console.error(`${prefix}[ERROR] ${msg}`, data || "");
          break;
      }
    },
    // Shorthand methods so Logger.info(), Logger.warn(), etc. work
    debug: (msg, data) => Logger.log("debug", msg, data),
    info: (msg, data) => Logger.log("info", msg, data),
    warn: (msg, data) => Logger.log("warn", msg, data),
    error: (msg, data) => Logger.log("error", msg, data),
  };

  // ============================================================================
  // URL Check
  // ============================================================================
  function isHlsResource(url) {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();
    return CONFIG.HLS_EXTENSIONS.some((ext) => lowerUrl.includes(ext));
  }

  // ============================================================================
  // Fetch Proxy
  // ============================================================================
  let originalFetch = null;
  let proxyActive = false;
  let fetchStats = {
    total: 0,
    proxied: 0,
    direct: 0,
    errors: 0,
  };

  /**
   * Proxy a fetch request through background.js
   */
  async function proxyFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      Logger.debug("proxyFetch", `Proxying: ${url.substring(0, 100)}`);

      const timeout = setTimeout(() => {
        reject(new Error(`Proxy fetch timeout: ${url}`));
      }, CONFIG.FETCH_TIMEOUT);

      chrome.runtime.sendMessage(
        {
          action: "proxyFetch",
          url: url,
          options: {
            method: options.method || "GET",
            headers: options.headers || {},
          },
        },
        (response) => {
          clearTimeout(timeout);

          // Check for runtime errors
          if (chrome.runtime.lastError) {
            fetchStats.errors++;
            Logger.error(
              "proxyFetch",
              `Runtime error: ${chrome.runtime.lastError.message}`,
            );
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response || !response.success) {
            fetchStats.errors++;
            const errorMsg = response?.error || "Unknown proxy error";
            Logger.error("proxyFetch", `Failed: ${errorMsg}`);
            reject(new Error(errorMsg));
            return;
          }

          fetchStats.proxied++;

          // Reconstruct a Response object from the proxy response
          try {
            let body;

            if (response.isBinary && response.body) {
              // Convert array back to Uint8Array
              body = new Uint8Array(response.body).buffer;
            } else {
              body = response.body || "";
            }

            const responseInit = {
              status: response.status,
              statusText: response.statusText,
              headers: new Headers(response.headers),
            };

            const fetchResponse = new Response(body, responseInit);

            Logger.debug(
              "proxyFetch",
              `✅ ${response.status} (${typeof body === "string" ? body.length + " chars" : body.byteLength + " bytes"})`,
            );

            resolve(fetchResponse);
          } catch (error) {
            Logger.error(
              "proxyFetch",
              `Response construction failed: ${error.message}`,
            );
            reject(error);
          }
        },
      );
    });
  }

  /**
   * Override window.fetch to intercept HLS resource requests
   */
  function installFetchOverride() {
    if (proxyActive) {
      Logger.warn("installFetchOverride", "Already active");
      return;
    }

    // Save original fetch
    originalFetch = window.fetch;

    window.fetch = async function (input, init = {}) {
      const url = typeof input === "string" ? input : input.url;

      fetchStats.total++;

      // Only proxy HLS resources
      if (isHlsResource(url)) {
        Logger.debug(
          "fetch",
          `📡 Intercepted HLS request: ${url.substring(0, 100)}`,
        );

        try {
          return await proxyFetch(url, init);
        } catch (error) {
          Logger.warn(
            "fetch",
            `⚠️ Proxy failed, trying direct fetch: ${error.message}`,
          );

          // Fall back to original fetch
          if (originalFetch) {
            return originalFetch.call(window, input, init);
          }

          throw error;
        }
      }

      // Non-HLS requests: use original fetch
      fetchStats.direct++;
      if (originalFetch) {
        return originalFetch.call(window, input, init);
      }

      // Shouldn't reach here if originalFetch is saved properly
      throw new Error("Original fetch not available");
    };

    proxyActive = true;
    Logger.info(
      "installFetchOverride",
      "✅ Fetch override installed - HLS requests will be proxied",
    );
    Logger.info(
      "installFetchOverride",
      `📋 Intercepting: ${CONFIG.HLS_EXTENSIONS.join(", ")}`,
    );
  }

  /**
   * Restore original fetch
   */
  function uninstallFetchOverride() {
    if (!proxyActive) return;

    if (originalFetch) {
      window.fetch = originalFetch;
    }

    proxyActive = false;
    Logger.info("uninstallFetchOverride", "🔄 Original fetch restored");
  }

  /**
   * Pre-load CORS rules for a stream URL
   */
  async function preloadCorsRules(streamUrl) {
    return new Promise((resolve) => {
      Logger.info(
        "preloadCorsRules",
        `Pre-loading CORS rules for: ${streamUrl}`,
      );

      chrome.runtime.sendMessage(
        {
          action: "preloadCorsRules",
          url: streamUrl,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            Logger.error(
              "preloadCorsRules",
              `Error: ${chrome.runtime.lastError.message}`,
            );
            resolve(false);
            return;
          }

          if (response?.success) {
            Logger.info("preloadCorsRules", "✅ CORS rules pre-loaded");
          } else {
            Logger.warn("preloadCorsRules", "⚠️ CORS rules pre-load failed");
          }

          resolve(response?.success || false);
        },
      );
    });
  }

  /**
   * Get fetch proxy statistics
   */
  function getStats() {
    return {
      ...fetchStats,
      proxyActive,
    };
  }

  // ============================================================================
  // Initialize
  // ============================================================================
  function initialize() {
    Logger.info("init", "🚀 FetchProxy initializing...");

    // Check if running in extension context
    if (
      typeof chrome !== "undefined" &&
      chrome.runtime &&
      chrome.runtime.sendMessage
    ) {
      installFetchOverride();
      Logger.info("init", "✅ FetchProxy ready");

      // Log initial stats
      Logger.info(
        "init",
        `📊 Extension context detected - fetch interception active`,
      );

      // Make stats available globally for debugging
      window.__fetchProxyStats = fetchStats;
      window.__fetchProxy = {
        getStats,
        preloadCorsRules,
        install: installFetchOverride,
        uninstall: uninstallFetchOverride,
      };
    } else {
      Logger.warn(
        "init",
        "⚠️ Not in extension context - fetch proxy not installed",
      );
      Logger.warn(
        "init",
        "   This module must run as a content script or in extension pages",
      );
    }
  }

  // Auto-initialize
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }

  // ============================================================================
  // Public API
  // ============================================================================
  // Expose for debugging and manual control
  window.FetchProxy = {
    getStats,
    preloadCorsRules,
    install: installFetchOverride,
    uninstall: uninstallFetchOverride,
    isActive: () => proxyActive,
  };

  Logger.info("module", "📦 FetchProxy module loaded");
})();
