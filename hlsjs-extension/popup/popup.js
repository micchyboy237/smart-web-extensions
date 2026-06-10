/**
 * popup.js - Extension Popup Controller
 *
 * FULLY INDEPENDENT MODE: Injects HlsPlayer + all modules + DemoRunner
 * directly into the active page's MAIN world, then runs ALL demos.
 * No player.html tab needed. Fully self-contained.
 */

// ============================================================================
// Configuration
// ============================================================================
const CONFIG = {
  VIDEO_SELECTOR: ".plyr__video-wrapper video",
  OBSERVER_TIMEOUT: 30000,
  POLLING_INTERVAL: 500,
  STATS_REFRESH_INTERVAL: 3000,
};

// ============================================================================
// PopupController Class - FULLY INDEPENDENT MODE
// ============================================================================
class PopupController {
  constructor() {
    this.demoRunner = null;
    this.isDemoRunning = false;
    this.activeTabId = null;
    this.videoFound = false;
    this.videoElementInfo = null;
    this.observerScriptInjected = false;
    this.scriptsInjected = false;
    this.logger = this._createLogger();
    this._init();
  }

  _createLogger() {
    const prefix = "[Popup]";
    return {
      info: (mod, msg, data) =>
        console.log(`${prefix}[INFO][${mod}] ${msg}`, data || ""),
      warn: (mod, msg, data) =>
        console.warn(`${prefix}[WARN][${mod}] ${msg}`, data || ""),
      error: (mod, msg, data) =>
        console.error(`${prefix}[ERROR][${mod}] ${msg}`, data || ""),
      debug: (mod, msg, data) =>
        console.debug(`${prefix}[DEBUG][${mod}] ${msg}`, data || ""),
    };
  }

  _init() {
    this.logger.info(
      "popup",
      "🚀 PopupController (Fully Independent Mode) initializing...",
    );
    this.logger.info("popup", `📋 VIDEO_SELECTOR: ${CONFIG.VIDEO_SELECTOR}`);
    this.logger.info("popup", "📋 ALL 79 tests will run on the current page");

    this._cacheElements();
    this._setupDemoRunner();
    this._setupEventListeners();
    this._initializeActiveTab();

    this._statsInterval = setInterval(
      () => this._getBackgroundStats(),
      CONFIG.STATS_REFRESH_INTERVAL,
    );

    this._videoCheckInterval = setInterval(
      () => this._checkVideoStatus(),
      CONFIG.POLLING_INTERVAL * 2,
    );

    setTimeout(() => {
      this._populateStreamUrl();
    }, 1500);

    this.logger.info("popup", "✓ PopupController initialized");
    this.logger.info(
      "popup",
      "ℹ️  All demos run on the current page - no new tabs",
    );
  }

  _cacheElements() {
    const ids = [
      "openPlayerBtn",
      "loadStreamBtn",
      "statusDot",
      "statusText",
      "statRequests",
      "statCorsFixed",
      "statDomains",
      "statRules",
      "domainListContent",
      "domainList",
      "corsModeBadge",
      "playerStatusIcon",
      "playerStatusText",
      "demoRunBtn",
      "demoQuickBtn",
      "demoStopBtn",
      "demoProgress",
      "demoProgressFill",
      "demoProgressText",
      "demoTotal",
      "demoPassed",
      "demoFailed",
      "demoSkipped",
      "demoRate",
      "demoDuration",
      "demoResultsDetail",
      "demoStatusBadge",
      "streamUrl",
    ];
    this.el = {};
    ids.forEach((id) => {
      this.el[id] = document.getElementById(id);
    });
    this.logger.debug("popup", `Cached ${ids.length} DOM elements`);
  }

  _setupDemoRunner() {
    if (typeof DemoRunner !== "undefined") {
      this.demoRunner = new DemoRunner();
      this.logger.info(
        "popup",
        "✓ DemoRunner instance created (popup fallback)",
      );
    } else {
      this.logger.warn("popup", "DemoRunner class not available");
      this._updateDemoStatus("DemoRunner unavailable", "error");
    }
  }

  _setupEventListeners() {
    this.el.openPlayerBtn?.addEventListener("click", () => {
      this._openPlayerInNewTab();
    });

    this.el.loadStreamBtn?.addEventListener("click", () => {
      this._sendLoadStreamCommand();
    });

    this.el.demoRunBtn?.addEventListener("click", () => {
      this._runAllDemos();
    });
    this.el.demoQuickBtn?.addEventListener("click", () => {
      this._runAllDemos(); // Same - all tests run every time
    });
    this.el.demoStopBtn?.addEventListener("click", () => {
      this._stopDemo();
    });

    this.el.streamUrl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._sendLoadStreamCommand();
    });

    this.logger.debug("popup", "✓ Event listeners setup complete");
  }

  // ==========================================================================
  // Active Tab Management
  // ==========================================================================
  async _initializeActiveTab() {
    try {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tabs.length === 0) {
        this.logger.warn("popup", "No active tab found");
        this._updatePlayerConnectionStatus("disconnected");
        return;
      }
      this.activeTabId = tabs[0].id;
      this.logger.info(
        "popup",
        `📍 Active tab: #${this.activeTabId} - ${tabs[0].url}`,
      );
      await this._injectVideoObserver();
      this._checkVideoStatus();
    } catch (error) {
      this.logger.error("popup", "Failed to initialize active tab", {
        error: error.message,
      });
      this._updatePlayerConnectionStatus("disconnected");
    }
  }

  async _injectVideoObserver() {
    if (this.observerScriptInjected) return;
    if (!this.activeTabId) return;

    try {
      this.logger.info(
        "popup",
        `💉 Injecting video observer into tab #${this.activeTabId}`,
      );
      await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        world: "MAIN", // ← Run in MAIN world so we can see the page's variables
        func: setupVideoObserver,
        args: [CONFIG.VIDEO_SELECTOR, CONFIG.OBSERVER_TIMEOUT],
      });
      this.observerScriptInjected = true;
      this.logger.info("popup", "✅ Video observer script injected");
    } catch (error) {
      this.logger.error("popup", "Failed to inject video observer", {
        error: error.message,
      });
    }
  }

  async _checkVideoStatus() {
    if (!this.activeTabId || !this.observerScriptInjected) return;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        world: "MAIN", // ← MAIN world
        func: getVideoElementStatus,
        args: [CONFIG.VIDEO_SELECTOR],
      });
      if (results && results[0] && results[0].result) {
        const status = results[0].result;
        if (status.found && !this.videoFound) {
          this.videoFound = true;
          this.videoElementInfo = status.info;
          this.logger.info("popup", `🎯 Video element FOUND!`);
          this._updatePlayerConnectionStatus("connected", this.activeTabId);
          this._enablePlayerControls(true);
          this._enableDemoControls(true);
          this._updateDemoStatus("Video found - ready for demo", "ready");
        } else if (!status.found && this.videoFound) {
          this.videoFound = false;
          this.videoElementInfo = null;
          this._updatePlayerConnectionStatus("disconnected");
          this._enablePlayerControls(false);
          this._enableDemoControls(false);
          this._updateDemoStatus("Waiting for video...", "info");
        }
      }
    } catch (error) {
      this.logger.debug("popup", "Video status check failed", {
        error: error.message,
      });
    }
  }

  _updatePlayerConnectionStatus(state, tabId = null) {
    if (state === "connected") {
      if (this.el.playerStatusIcon) this.el.playerStatusIcon.textContent = "🟢";
      if (this.el.playerStatusText) {
        this.el.playerStatusText.textContent = this.videoFound
          ? `Video found (Tab #${tabId}) - Demos run on page`
          : `Tab connected (Tab #${tabId}) - waiting for video...`;
      }
      if (this.el.statusDot) this.el.statusDot.className = "status-dot active";
      if (this.el.statusText) {
        this.el.statusText.textContent = this.videoFound
          ? "Video ready - click Run All Demos"
          : "Waiting for video element...";
      }
    } else {
      if (this.el.playerStatusIcon) this.el.playerStatusIcon.textContent = "⚪";
      if (this.el.playerStatusText) {
        this.el.playerStatusText.textContent = "No video element found";
      }
      if (this.el.statusDot) this.el.statusDot.className = "status-dot";
      if (this.el.statusText) {
        this.el.statusText.textContent = "Open a page with video player";
      }
    }
  }

  _enablePlayerControls(enabled) {
    if (this.el.loadStreamBtn) this.el.loadStreamBtn.disabled = !enabled;
  }

  _enableDemoControls(enabled) {
    if (this.el.demoRunBtn)
      this.el.demoRunBtn.disabled = !enabled || this.isDemoRunning;
    if (this.el.demoQuickBtn)
      this.el.demoQuickBtn.disabled = !enabled || this.isDemoRunning;
  }

  // ==========================================================================
  // Script Injection - FIXED: Inject ALL scripts as ONE combined script
  // into the MAIN world so modules can reference each other
  // ==========================================================================
  /**
   * Fetch all required scripts, combine them into ONE script string,
   * and inject it into the page's MAIN world.
   *
   * This ensures:
   * 1. All modules execute in order in the same context
   * 2. Later scripts can see variables from earlier scripts
   * 3. Everything runs in MAIN world (not isolated)
   */
  async _injectAllScriptsIntoPage() {
    if (this.scriptsInjected) {
      this.logger.info("popup", "ℹ️ Scripts already injected into page");
      return true;
    }

    if (!this.activeTabId) {
      this.logger.error("popup", "No active tab for script injection");
      return false;
    }

    this.logger.info(
      "popup",
      "📥 Fetching and injecting all modules into the page (MAIN world)...",
    );

    // List of scripts in dependency order
    const scriptsToInject = [
      "lib/hls.min.js",
      "modules/logger.js",
      "modules/core.js",
      "modules/playback.js",
      "modules/quality.js",
      "modules/audio.js",
      "modules/live.js",
      "modules/error.js",
      "modules/iframe.js",
      "modules/drm.js",
      "modules/cmcd.js",
      "modules/demo-runner.js",
    ];

    try {
      // Step 1: Fetch all scripts in parallel
      this.logger.info("popup", "  Fetching all scripts...");
      const scriptContents = [];

      for (const scriptPath of scriptsToInject) {
        const url = chrome.runtime.getURL(scriptPath);
        const response = await fetch(url);
        if (!response.ok) {
          this.logger.error(
            "popup",
            `  ❌ Failed to fetch ${scriptPath}: ${response.status}`,
          );
          return false;
        }
        const content = await response.text();
        scriptContents.push({
          path: scriptPath,
          content: content,
        });
        this.logger.debug(
          "popup",
          `  📄 Fetched: ${scriptPath} (${content.length} chars)`,
        );
      }

      // Step 2: Combine all scripts into one, with separators and logging
      this.logger.info("popup", "  Combining scripts...");
      const combinedScript = scriptContents
        .map((sc, index) => {
          return `
// ================================================================
// Script ${index + 1}/${scriptContents.length}: ${sc.path}
// ================================================================
console.log("[HLS-Inject] Loading: ${sc.path} (${sc.content.length} chars)");
${sc.content}
console.log("[HLS-Inject] ✓ Loaded: ${sc.path}");
`;
        })
        .join("\n");

      // Step 3: Add verification code at the end
      const verifyScript = `
// ================================================================
// Verification: Check all modules loaded
// ================================================================
(function() {
  const requiredModules = [
    "Hls", "HlsPlayer", "Logger", "DemoRunner",
    "PlaybackController", "QualityController", "AudioController",
    "LiveController", "ErrorController", "IFrameController",
    "DRMController", "CMCDController"
  ];
  
  const missing = [];
  const found = [];
  
  requiredModules.forEach(name => {
    if (typeof window[name] !== "undefined" && window[name] !== null) {
      found.push(name);
      console.log("[HLS-Inject] ✅ Found: " + name);
    } else {
      missing.push(name);
      console.error("[HLS-Inject] ❌ MISSING: " + name);
    }
  });
  
  window.__hlsModulesInjected = {
    success: missing.length === 0,
    found: found,
    missing: missing,
    totalRequired: requiredModules.length,
    totalFound: found.length,
    timestamp: Date.now()
  };
  
  console.log("[HLS-Inject] =========================================");
  console.log("[HLS-Inject] Injection complete: " + found.length + "/" + requiredModules.length + " modules found");
  if (missing.length > 0) {
    console.error("[HLS-Inject] MISSING: " + missing.join(", "));
  }
  console.log("[HLS-Inject] =========================================");
})();
`;

      const finalScript = combinedScript + "\n" + verifyScript;

      // Step 4: Inject the combined script into the MAIN world
      this.logger.info(
        "popup",
        `  💉 Injecting combined script (${finalScript.length} chars) into MAIN world...`,
      );

      await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        world: "MAIN", // ← CRITICAL: Run in MAIN world so scripts can set window.Hls, etc.
        func: injectCombinedScript,
        args: [finalScript],
      });

      // Step 5: Wait a moment and verify injection
      await new Promise((resolve) => setTimeout(resolve, 500));

      const verifyResults = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        world: "MAIN",
        func: () => {
          return (
            window.__hlsModulesInjected || {
              success: false,
              error: "Verification not found",
            }
          );
        },
      });

      if (verifyResults && verifyResults[0] && verifyResults[0].result) {
        const status = verifyResults[0].result;
        if (status.success) {
          this.scriptsInjected = true;
          this.logger.info(
            "popup",
            `✅ All ${status.totalFound}/${status.totalRequired} modules loaded successfully!`,
          );
          return true;
        } else {
          this.logger.error(
            "popup",
            `❌ Module injection failed: ${status.found.length}/${status.totalRequired} found`,
          );
          this.logger.error(
            "popup",
            `   Missing: ${status.missing.join(", ")}`,
          );
          return false;
        }
      }

      this.logger.error("popup", "❌ Could not verify script injection");
      return false;
    } catch (error) {
      this.logger.error(
        "popup",
        "❌ Script injection failed: " + error.message,
      );
      return false;
    }
  }

  // ==========================================================================
  // Demo Runner Methods
  // ==========================================================================
  async _runAllDemos() {
    if (this.isDemoRunning) {
      this.logger.warn("popup", "Demo is already running");
      return;
    }
    if (!this.videoFound) {
      this.logger.warn("popup", "No video element found.");
      this._updateDemoStatus("❌ No video element found", "error");
      return;
    }

    this.isDemoRunning = true;
    this._setDemoRunningState(true);
    this._updateDemoStatus("🔄 Injecting scripts...", "running");
    this._clearDemoResults();
    this._updateDemoProgress(5, "Injecting modules into page...");

    const streamUrl = await this._detectStreamUrl();
    const pageInfo = await this._getOriginalReferer();

    this.logger.info("popup", "=".repeat(50));
    this.logger.info(
      "popup",
      "🚀 STARTING FULL FEATURE DEMONSTRATION (On Page)",
    );
    this.logger.info("popup", `📋 Stream URL: ${streamUrl}`);
    this.logger.info("popup", `📋 Referer: ${pageInfo?.url || "none"}`);
    this.logger.info("popup", "📋 ALL 79 tests will run on the page");
    this.logger.info("popup", "=".repeat(50));

    try {
      // Step 1: Inject all scripts into the page's MAIN world
      this._updateDemoProgress(10, "Injecting modules...");
      const injected = await this._injectAllScriptsIntoPage();
      if (!injected) {
        throw new Error("Failed to inject required scripts into page");
      }

      // Step 2: Pre-load CORS rules
      this._updateDemoProgress(15, "Pre-loading CORS rules...");
      await this._preloadCorsRules(streamUrl, pageInfo);

      // Step 3: Run ALL demos on the page (in MAIN world)
      this._updateDemoProgress(20, "Running all demos on page...");

      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        world: "MAIN", // ← CRITICAL: Run in MAIN world to access window.HlsPlayer, etc.
        func: runAllDemosOnPage,
        args: [CONFIG.VIDEO_SELECTOR, streamUrl, pageInfo?.url || null],
      });

      if (results && results[0] && results[0].result) {
        const demoResults = results[0].result;

        if (demoResults.success) {
          this._displayDemoResults(demoResults.results);
          this._updateDemoStatus("✅ Complete", "success");
          this._updateDemoProgress(
            100,
            `Complete: ${demoResults.results.passed}/${demoResults.results.total} passed`,
          );

          this.logger.info("popup", "=".repeat(50));
          this.logger.info("popup", "✅ ALL DEMOS COMPLETE");
          this.logger.info(
            "popup",
            `   ${demoResults.results.passed}/${demoResults.results.total} passed`,
          );
          this.logger.info("popup", "=".repeat(50));
        } else {
          throw new Error(demoResults.error || "Unknown error on page");
        }
      } else {
        throw new Error("No response from page");
      }
    } catch (error) {
      this.logger.error("popup", "Demo run failed", { error: error.message });
      this._updateDemoStatus("❌ Failed: " + error.message, "error");
    } finally {
      this.isDemoRunning = false;
      this._setDemoRunningState(false);
    }
  }

  async _stopDemo() {
    if (this.isDemoRunning) {
      this.logger.info("popup", "⏹️ Stopping demo...");
      this.isDemoRunning = false;
      this._setDemoRunningState(false);
      this._updateDemoStatus("⏹️ Stopped by user", "stopped");

      if (this.activeTabId) {
        chrome.scripting
          .executeScript({
            target: { tabId: this.activeTabId },
            world: "MAIN",
            func: () => {
              window.__stopDemo = true;
            },
          })
          .catch(() => {});
      }
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  async _getVideoElementInfo() {
    if (!this.activeTabId) return null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        world: "MAIN",
        func: getVideoElementInfoFromPage,
        args: [CONFIG.VIDEO_SELECTOR],
      });
      return results?.[0]?.result || null;
    } catch (error) {
      return null;
    }
  }

  async _getOriginalReferer() {
    if (!this.activeTabId) return null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        world: "MAIN",
        func: () => ({
          url: window.location.href,
          referer: document.referrer || window.location.href,
          origin: window.location.origin,
        }),
      });
      return results?.[0]?.result || null;
    } catch (error) {
      return null;
    }
  }

  async _preloadCorsRules(url, pageInfo) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: "preloadCorsRules",
          url: url,
          referer: pageInfo?.url || null,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            this.logger.error("popup", "CORS pre-load error", {
              error: chrome.runtime.lastError.message,
            });
            resolve(false);
          } else {
            resolve(response?.success || false);
          }
        },
      );
    });
  }

  async _sendLoadStreamCommand() {
    const url = await this._detectStreamUrl();
    if (!url) return;

    // Pre-load CORS rules
    chrome.runtime.sendMessage(
      { action: "preloadCorsRules", url: url },
      async (response) => {
        // Inject scripts
        await this._injectAllScriptsIntoPage();

        if (this.activeTabId) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: this.activeTabId },
              world: "MAIN",
              func: loadStreamOnPage,
              args: [url, CONFIG.VIDEO_SELECTOR],
            });
            if (results?.[0]?.result?.success) {
              this._updateDemoStatus("Stream loaded - ready for demo", "ready");
            }
          } catch (error) {
            this.logger.error("popup", "Failed to load stream", {
              error: error.message,
            });
          }
        }
      },
    );
  }

  async _openPlayerInNewTab() {
    const streamUrl = await this._detectStreamUrl();
    let pageUrl = null;
    if (this.activeTabId) {
      try {
        const tabs = await chrome.tabs.get(this.activeTabId);
        if (tabs?.url && !tabs.url.startsWith("chrome-extension://")) {
          pageUrl = tabs.url;
        }
      } catch (error) {
        /* ignore */
      }
    }

    const playerBaseUrl = chrome.runtime.getURL("player/player.html");
    let playerUrl = `${playerBaseUrl}?url=${encodeURIComponent(streamUrl)}&autorun=true`;
    if (pageUrl) {
      playerUrl += `&ref=${encodeURIComponent(pageUrl)}`;
    }
    chrome.tabs.create({ url: playerUrl });
  }

  async _populateStreamUrl() {
    const detectedUrl = await this._detectStreamUrl();
    if (detectedUrl && this.el.streamUrl) {
      const currentValue = this.el.streamUrl.value.trim();
      const defaultUrl = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
      if (detectedUrl !== currentValue && detectedUrl !== defaultUrl) {
        this.el.streamUrl.value = detectedUrl;
      }
    }
  }

  // ==========================================================================
  // Stream URL Detection
  // ==========================================================================
  async _detectStreamUrl() {
    // Source 1: Background request history (most reliable for blob URLs)
    try {
      const response = await this._sendMessageAsync({ action: "getStats" });
      if (response?.success && response.stats?.recentRequests) {
        const recentM3u8 = response.stats.recentRequests
          .filter((req) => req.url && req.url.endsWith(".m3u8"))
          .sort((a, b) => b.timestamp - a.timestamp);
        if (recentM3u8.length > 0) {
          this.logger.info(
            "popup",
            `✅ Stream URL from background: ${recentM3u8[0].url}`,
          );
          return recentM3u8[0].url;
        }
      }
    } catch (error) {
      /* ignore */
    }

    // Source 2: Current input value
    const currentValue = this.el.streamUrl?.value?.trim();
    if (currentValue) return currentValue;

    // Fallback
    return "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
  }

  _sendMessageAsync(message) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        resolve({ success: false, error: "chrome.runtime not available" });
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { success: false, error: "No response" });
      });
    });
  }

  // ==========================================================================
  // UI Update Methods
  // ==========================================================================
  _setDemoRunningState(running) {
    if (this.el.demoRunBtn)
      this.el.demoRunBtn.disabled = running || !this.videoFound;
    if (this.el.demoQuickBtn)
      this.el.demoQuickBtn.disabled = running || !this.videoFound;
    if (this.el.demoStopBtn) {
      this.el.demoStopBtn.style.display = running ? "inline-block" : "none";
    }
    if (this.el.demoProgress) {
      this.el.demoProgress.style.display = running ? "block" : "none";
    }
  }

  _updateDemoStatus(message, type = "info") {
    if (this.el.demoStatusBadge) {
      this.el.demoStatusBadge.textContent = message;
      const colors = {
        success: { bg: "#00ff8822", color: "#00ff88", border: "#00ff8844" },
        error: { bg: "#ff444422", color: "#ff4444", border: "#ff444444" },
        running: { bg: "#ffaa0022", color: "#ffaa00", border: "#ffaa0044" },
        ready: { bg: "#00d4ff22", color: "#00d4ff", border: "#00d4ff44" },
        loading: { bg: "#ffaa0022", color: "#ffaa00", border: "#ffaa0044" },
        stopped: { bg: "#88888822", color: "#888", border: "#88888844" },
      };
      const style = colors[type] || colors.ready;
      Object.assign(this.el.demoStatusBadge.style, {
        background: style.bg,
        color: style.color,
        border: `1px solid ${style.border}`,
      });
    }
  }

  _updateDemoProgress(percent, text) {
    if (this.el.demoProgressFill) {
      this.el.demoProgressFill.style.width = `${percent}%`;
    }
    if (this.el.demoProgressText) {
      this.el.demoProgressText.textContent = text || `${percent}%`;
    }
    if (this.el.demoProgress) {
      this.el.demoProgress.style.display = "block";
    }
  }

  _clearDemoResults() {
    const els = [
      "demoTotal",
      "demoPassed",
      "demoFailed",
      "demoSkipped",
      "demoRate",
      "demoDuration",
    ];
    els.forEach((id) => {
      if (this.el[id]) this.el[id].textContent = "--";
    });
    if (this.el.demoResultsDetail) this.el.demoResultsDetail.innerHTML = "";
    this._updateDemoProgress(0, "Starting...");
  }

  _displayDemoResults(results) {
    if (!results) return;

    if (this.el.demoTotal) this.el.demoTotal.textContent = results.total || 0;
    if (this.el.demoPassed)
      this.el.demoPassed.textContent = results.passed || 0;
    if (this.el.demoFailed)
      this.el.demoFailed.textContent = results.failed || 0;
    if (this.el.demoSkipped)
      this.el.demoSkipped.textContent = results.skipped || 0;

    const successRate =
      results.total > 0
        ? ((results.passed / results.total) * 100).toFixed(1) + "%"
        : "0%";
    if (this.el.demoRate) this.el.demoRate.textContent = successRate;
    if (this.el.demoDuration) {
      this.el.demoDuration.textContent = results.duration
        ? (results.duration / 1000).toFixed(2) + "s"
        : "--";
    }

    if (this.el.demoResultsDetail && results.tests) {
      this.el.demoResultsDetail.innerHTML = results.tests
        .map((test) => {
          const icon = test.status === "passed" ? "✅" : "❌";
          const cssClass =
            test.status === "passed" ? "demo-test-pass" : "demo-test-fail";
          return `
            <div class="demo-test-item ${cssClass}">
              <span>${icon}</span>
              <span class="demo-test-name">#${test.id} [${test.phase}] ${test.name}</span>
              <span class="demo-test-msg">${test.message || ""}</span>
            </div>
          `;
        })
        .join("");
    }
  }

  // ==========================================================================
  // Background Stats
  // ==========================================================================
  _getBackgroundStats() {
    chrome.runtime.sendMessage({ action: "getStats" }, (response) => {
      if (chrome.runtime.lastError || !response?.success) return;
      this._updateStatsDisplay(response.stats);
    });
  }

  _updateStatsDisplay(stats) {
    if (this.el.statRequests)
      this.el.statRequests.textContent = stats.requestsIntercepted || 0;
    if (this.el.statCorsFixed)
      this.el.statCorsFixed.textContent = stats.corsHeadersAdded || 0;
    if (this.el.statDomains)
      this.el.statDomains.textContent = (stats.activeStreams || []).length;
    if (this.el.statRules)
      this.el.statRules.textContent = stats.corsRules?.totalRules || 0;

    if (stats.activeStreams?.length > 0 && this.el.domainList) {
      this.el.domainList.style.display = "block";
      const rulesDomains = new Set(stats.corsRules?.domains || []);
      if (this.el.domainListContent) {
        this.el.domainListContent.innerHTML = stats.activeStreams
          .map((domain) => {
            const fixed = rulesDomains.has(domain);
            return `
              <div class="domain-item">
                <span class="domain-name" title="${domain}">${domain}</span>
                <span class="cors-badge ${fixed ? "fixed" : "ok"}">${fixed ? "Fixed" : "OK"}</span>
              </div>
            `;
          })
          .join("");
      }
    } else if (this.el.domainList) {
      this.el.domainList.style.display = "none";
    }
  }

  destroy() {
    if (this._statsInterval) clearInterval(this._statsInterval);
    if (this._videoCheckInterval) clearInterval(this._videoCheckInterval);
    this.logger.info("popup", "PopupController destroyed");
  }
}

// ============================================================================
// CONTENT SCRIPTS - All injected into MAIN world
// ============================================================================

/**
 * FIXED: Inject a combined script string into the page's MAIN world.
 * Uses a <script> element appended to the document, NOT removed until
 * the script fully executes.
 *
 * @param {string} combinedScript - All scripts combined into one string
 */
function injectCombinedScript(combinedScript) {
  console.log(
    "[HLS-Inject] 💉 Injecting combined script into MAIN world (" +
      combinedScript.length +
      " chars)",
  );

  const script = document.createElement("script");
  script.id = "hlsjs-extension-injected";
  script.textContent = combinedScript;

  // Append to document (don't remove - let it stay for debugging)
  (document.head || document.documentElement).appendChild(script);

  console.log("[HLS-Inject] ✓ Script element added to DOM");
  return true;
}

/**
 * Setup MutationObserver on the page to watch for video element.
 */
function setupVideoObserver(videoSelector, timeout) {
  console.log(
    `[ContentScript] 🔍 Setting up MutationObserver for: "${videoSelector}"`,
  );

  window.__hlsVideoObserver = window.__hlsVideoObserver || {
    found: false,
    observer: null,
    startTime: Date.now(),
    videoSelector: videoSelector,
  };

  const state = window.__hlsVideoObserver;

  const existingVideo = document.querySelector(videoSelector);
  if (existingVideo) {
    console.log(`[ContentScript] ✅ Video element already exists!`);
    state.found = true;
    return;
  }

  if (state.observer) return;

  const observer = new MutationObserver((mutations, obs) => {
    if (Date.now() - state.startTime > timeout) {
      obs.disconnect();
      state.observer = null;
      return;
    }
    const videoEl = document.querySelector(videoSelector);
    if (videoEl) {
      console.log(`[ContentScript] 🎯 Video element FOUND!`);
      state.found = true;
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  state.observer = observer;
}

/**
 * Get current status of the video element.
 */
function getVideoElementStatus(videoSelector) {
  const state = window.__hlsVideoObserver || {};
  const videoEl = document.querySelector(videoSelector);

  if (videoEl) {
    state.found = true;
    return {
      found: true,
      info: {
        tagName: videoEl.tagName,
        currentSrc: videoEl.currentSrc,
        duration: videoEl.duration,
        paused: videoEl.paused,
        readyState: videoEl.readyState,
        networkState: videoEl.networkState,
      },
    };
  }

  return {
    found: false,
    info: null,
    observerActive: !!state.observer,
  };
}

/**
 * Get detailed video element information.
 */
function getVideoElementInfoFromPage(videoSelector) {
  const videoEl = document.querySelector(videoSelector);
  if (!videoEl) return null;
  return {
    tagName: videoEl.tagName,
    currentSrc: videoEl.currentSrc,
    duration: videoEl.duration,
    paused: videoEl.paused,
    readyState: videoEl.readyState,
  };
}

/**
 * Load a stream URL into a video element on the page.
 */
function loadStreamOnPage(url, videoSelector) {
  console.log(`[ContentScript] 📥 Loading stream: ${url}`);
  try {
    let videoEl =
      document.querySelector(videoSelector) || document.querySelector("video");
    if (!videoEl) return { success: false, error: "No video element found" };

    if (typeof Hls !== "undefined" && Hls.isSupported()) {
      if (videoEl._hlsInstance) videoEl._hlsInstance.destroy();
      const hls = new Hls({ debug: false, enableWorker: true });
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      videoEl._hlsInstance = hls;
      return { success: true, method: "hlsjs" };
    } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      videoEl.src = url;
      return { success: true, method: "native" };
    }
    return { success: false, error: "HLS not supported" };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * ========================================================================
 * MAIN DEMO FUNCTION - Runs ALL demos in the page's MAIN world
 * ========================================================================
 * This runs in MAIN world and has access to window.Hls, window.HlsPlayer, etc.
 * that were set by the injected scripts.
 */
function runAllDemosOnPage(videoSelector, streamUrl, originalReferer) {
  console.log(
    "[PageDemo] ==========================================================",
  );
  console.log("[PageDemo] 🚀 RUNNING ALL DEMOS ON PAGE (MAIN world)");
  console.log(
    "[PageDemo] ==========================================================",
  );
  console.log(`[PageDemo] Video Selector: ${videoSelector}`);
  console.log(`[PageDemo] Stream URL: ${streamUrl}`);

  try {
    // Step 1: Find video element
    const videoEl = document.querySelector(videoSelector);
    if (!videoEl) {
      return { success: false, error: `Video not found: ${videoSelector}` };
    }
    console.log(`[PageDemo] ✅ Video element: ${videoEl.tagName}`);

    // Step 2: Set referer
    if (originalReferer) {
      window.__hlsOriginalReferer = originalReferer;
      console.log(`[PageDemo] 🔑 Referer: ${originalReferer}`);
    }

    // Step 3: Verify modules (using window.* since we're in MAIN world)
    const requiredModules = [
      "Hls",
      "HlsPlayer",
      "Logger",
      "DemoRunner",
      "PlaybackController",
      "QualityController",
      "AudioController",
      "LiveController",
      "ErrorController",
      "IFrameController",
      "DRMController",
      "CMCDController",
    ];

    const missingModules = requiredModules.filter((m) => {
      return typeof window[m] === "undefined" || window[m] === null;
    });

    if (missingModules.length > 0) {
      console.error("[PageDemo] ❌ Missing modules:", missingModules);
      console.log(
        "[PageDemo] Available on window:",
        Object.keys(window)
          .filter(
            (k) =>
              typeof window[k] === "function" && k[0] === k[0].toUpperCase(),
          )
          .join(", "),
      );
      return {
        success: false,
        error:
          `Missing modules: ${missingModules.join(", ")}. ` +
          `Check that scripts were injected into MAIN world.`,
      };
    }
    console.log(`[PageDemo] ✅ All ${requiredModules.length} modules verified`);

    // Step 4: Pre-load CORS rules
    if (
      window.FetchProxy &&
      typeof window.FetchProxy.preloadCorsRules === "function"
    ) {
      console.log("[PageDemo] 🔧 Pre-loading CORS rules...");
      window.FetchProxy.preloadCorsRules(streamUrl);
    }

    // Step 5: Create DemoRunner and run ALL tests
    console.log("[PageDemo] 🏃 Creating DemoRunner...");
    const demoRunner = new DemoRunner();

    console.log("[PageDemo] ▶️ Running all demos (this may take a while)...");

    return demoRunner
      .runAll({
        videoElement: videoEl,
        streamUrl: streamUrl,
        verbose: true,
        stopOnFailure: false,
        playerProxy: null,
      })
      .then((results) => {
        console.log(
          "[PageDemo] ==========================================================",
        );
        console.log(
          `[PageDemo] ✅ ALL DEMOS COMPLETE: ${results.passed}/${results.total} passed`,
        );
        console.log(
          "[PageDemo] ==========================================================",
        );
        return { success: true, results: results, error: null };
      })
      .catch((error) => {
        console.error("[PageDemo] ❌ Demo run failed:", error);
        return {
          success: false,
          results: demoRunner.results || null,
          error: error.message,
        };
      });
  } catch (error) {
    console.error("[PageDemo] ❌ Setup failed:", error);
    return { success: false, results: null, error: error.message };
  }
}

// ============================================================================
// Initialize
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  console.log("[Popup] 🚀 Popup initializing (Fully Independent Mode)...");
  window.popupController = new PopupController();
  console.log("[Popup] ✓ Popup ready");
});

window.addEventListener("beforeunload", () => {
  if (window.popupController) window.popupController.destroy();
});
