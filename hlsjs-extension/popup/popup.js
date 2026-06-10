/**
 * popup.js - Extension Popup Controller
 *
 * INDEPENDENT MODE: Uses MutationObserver to find video elements on the current page.
 * No longer requires a separate player tab. Works directly with any page containing
 * a video element matching VIDEO_SELECTOR = ".plyr__video-wrapper video".
 *
 * Uses chrome.scripting.executeScript to inject a content script that:
 * 1. Observes DOM for the target video element
 * 2. Returns video element info once found
 * 3. Executes demo steps directly on the page
 */
// ============================================================================
// Configuration
// ============================================================================
const CONFIG = {
  VIDEO_SELECTOR: ".plyr__video-wrapper video",
  OBSERVER_TIMEOUT: 30000, // 30 seconds max wait
  POLLING_INTERVAL: 500, // Check every 500ms
  STATS_REFRESH_INTERVAL: 3000,
};

// ============================================================================
// PopupController Class - INDEPENDENT MODE
// ============================================================================
class PopupController {
  constructor() {
    this.demoRunner = null;
    this.isDemoRunning = false;
    this.activeTabId = null;
    this.videoFound = false;
    this.videoElementInfo = null;
    this.observerScriptInjected = false;
    this.logger = this._createLogger();
    this._init();
  }

  // --------------------------------------------------------------------------
  // Logger (lightweight, since we can't import modules directly in popup context)
  // --------------------------------------------------------------------------
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

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------
  _init() {
    this.logger.info(
      "popup",
      "🚀 PopupController (Independent Mode) initializing...",
    );
    this.logger.info("popup", `📋 VIDEO_SELECTOR: ${CONFIG.VIDEO_SELECTOR}`);

    // Cache DOM elements
    this._cacheElements();

    // Setup DemoRunner
    this._setupDemoRunner();

    // Setup event listeners
    this._setupEventListeners();

    // Get active tab and start video observer
    this._initializeActiveTab();

    // Get background stats periodically
    this._statsInterval = setInterval(
      () => this._getBackgroundStats(),
      CONFIG.STATS_REFRESH_INTERVAL,
    );

    // Refresh video status periodically (in case DOM changes)
    this._videoCheckInterval = setInterval(
      () => this._checkVideoStatus(),
      CONFIG.POLLING_INTERVAL * 2,
    );

    // NEW: Detect and populate the stream URL after initialization
    // Delay slightly to allow video observer to find elements first
    setTimeout(() => {
      this._populateStreamUrl();
    }, 1500);

    this.logger.info(
      "popup",
      "✓ PopupController initialized (Independent Mode)",
    );
    this.logger.info(
      "popup",
      "ℹ️  Looking for video element on current page...",
    );
  }

  /**
   * Populate the stream URL input field with the detected URL.
   * Updates the UI to show the detected stream.
   */
  async _populateStreamUrl() {
    const detectedUrl = await this._detectStreamUrl();

    if (detectedUrl && this.el.streamUrl) {
      // Only update if the detected URL is different from current
      const currentValue = this.el.streamUrl.value.trim();
      if (
        detectedUrl !== currentValue &&
        detectedUrl !== "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
      ) {
        this.el.streamUrl.value = detectedUrl;
        this.logger.info(
          "popup",
          `📝 Stream URL input updated to: ${detectedUrl}`,
        );

        // Update the UI to reflect that a stream was detected
        this._updatePlayerConnectionStatus("connected", this.activeTabId);
      } else if (detectedUrl === currentValue) {
        this.logger.debug(
          "popup",
          `Stream URL already matches: ${detectedUrl}`,
        );
      } else {
        this.logger.debug("popup", `Using default stream URL: ${detectedUrl}`);
      }
    }
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

  // --------------------------------------------------------------------------
  // Demo Runner Setup
  // --------------------------------------------------------------------------
  _setupDemoRunner() {
    if (typeof DemoRunner !== "undefined") {
      this.demoRunner = new DemoRunner();
      this.logger.info("popup", "✓ DemoRunner instance created");
    } else {
      this.logger.warn(
        "popup",
        "DemoRunner class not available - demo features disabled",
      );
      this._updateDemoStatus("DemoRunner unavailable", "error");
    }
  }

  // --------------------------------------------------------------------------
  // Event Listeners
  // --------------------------------------------------------------------------
  _setupEventListeners() {
    // Open player button - now opens a new tab with player.html
    this.el.openPlayerBtn?.addEventListener("click", () => {
      this._openPlayerInNewTab();
    });

    // Load stream button
    this.el.loadStreamBtn?.addEventListener("click", () => {
      this._sendLoadStreamCommand();
    });

    // Demo control buttons
    this.el.demoRunBtn?.addEventListener("click", () => {
      this._runAllDemos();
    });
    this.el.demoQuickBtn?.addEventListener("click", () => {
      this._runQuickDemo();
    });
    this.el.demoStopBtn?.addEventListener("click", () => {
      this._stopDemo();
    });

    // Stream URL enter key
    this.el.streamUrl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._sendLoadStreamCommand();
    });

    this.logger.debug("popup", "✓ Event listeners setup complete");
  }

  // ==========================================================================
  // Active Tab Management & Video Observer (NEW - INDEPENDENT MODE)
  // ==========================================================================

  /**
   * Get the active tab and start watching for video element
   */
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

      // Inject the video observer script
      await this._injectVideoObserver();

      // Start checking for video element
      this._checkVideoStatus();
    } catch (error) {
      this.logger.error("popup", "Failed to initialize active tab", {
        error: error.message,
      });
      this._updatePlayerConnectionStatus("disconnected");
    }
  }

  /**
   * Inject the MutationObserver content script into the active tab
   */
  async _injectVideoObserver() {
    if (this.observerScriptInjected) {
      this.logger.debug("popup", "Video observer already injected");
      return;
    }

    if (!this.activeTabId) {
      this.logger.warn("popup", "No active tab to inject observer into");
      return;
    }

    try {
      this.logger.info(
        "popup",
        `💉 Injecting video observer script into tab #${this.activeTabId}`,
      );

      await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        func: setupVideoObserver,
        args: [CONFIG.VIDEO_SELECTOR, CONFIG.OBSERVER_TIMEOUT],
      });

      this.observerScriptInjected = true;
      this.logger.info(
        "popup",
        "✅ Video observer script injected successfully",
      );
    } catch (error) {
      this.logger.error("popup", "Failed to inject video observer", {
        error: error.message,
      });
      // Some URLs (like chrome://) can't be scripted
      if (error.message.includes("Cannot access")) {
        this.logger.warn(
          "popup",
          "⚠️ Cannot access this page. Try opening the player instead.",
        );
      }
    }
  }

  /**
   * Check if video element has been found by the observer
   */
  async _checkVideoStatus() {
    if (!this.activeTabId || !this.observerScriptInjected) return;

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        func: getVideoElementStatus,
        args: [CONFIG.VIDEO_SELECTOR],
      });

      if (results && results[0] && results[0].result) {
        const status = results[0].result;

        if (status.found && !this.videoFound) {
          this.videoFound = true;
          this.videoElementInfo = status.info;
          this.logger.info(
            "popup",
            `🎯 Video element FOUND! Selector: ${CONFIG.VIDEO_SELECTOR}`,
          );
          this.logger.info(
            "popup",
            `   Tag: ${status.info.tagName}, Src: ${status.info.currentSrc || "none"}`,
          );
          this._updatePlayerConnectionStatus("connected", this.activeTabId);
          this._enablePlayerControls(true);
          this._enableDemoControls(true);
          this._updateDemoStatus("Video found - ready for demo", "ready");
        } else if (!status.found && this.videoFound) {
          // Video was found but now disappeared
          this.videoFound = false;
          this.videoElementInfo = null;
          this.logger.warn("popup", "⚠️ Video element no longer available");
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

  /**
   * Open the player in a new tab with the current stream URL
   */
  async _openPlayerInNewTab() {
    // NEW: Detect the best URL
    const streamUrl = await this._detectStreamUrl();

    const playerBaseUrl = chrome.runtime.getURL("player/player.html");
    const playerUrl = `${playerBaseUrl}?url=${encodeURIComponent(streamUrl)}&autorun=false`;

    this.logger.info("popup", `Opening player in new tab: ${playerUrl}`);
    this.logger.info("popup", `📋 Stream URL passed: ${streamUrl}`);

    chrome.tabs.create({ url: playerUrl }, (tab) => {
      this.activeTabId = tab.id;
      this.observerScriptInjected = false;
      this.videoFound = false;
      this.videoElementInfo = null;
      this.logger.info("popup", `Player tab created: #${tab.id}`);
      this._updatePlayerConnectionStatus("connected", tab.id);

      // Pre-load CORS rules for the stream domain
      this.logger.info("popup", "🔧 Pre-loading CORS rules for player tab...");
      chrome.runtime.sendMessage(
        { action: "preloadCorsRules", url: streamUrl },
        (response) => {
          if (chrome.runtime.lastError) {
            this.logger.error("popup", "CORS pre-load error for player tab", {
              error: chrome.runtime.lastError.message,
            });
          } else if (response?.success) {
            this.logger.info(
              "popup",
              "✅ CORS rules pre-loaded for player tab",
            );
          } else {
            this.logger.warn(
              "popup",
              "⚠️ CORS pre-load may have failed for player tab",
            );
          }
        },
      );

      // Enable controls since player page handles its own video
      this._enablePlayerControls(true);
      this._enableDemoControls(false);
    });
  }

  // --------------------------------------------------------------------------
  // Player Connection Status UI
  // --------------------------------------------------------------------------
  _updatePlayerConnectionStatus(state, tabId = null) {
    const statusDiv = this.el.playerStatusText?.parentElement;

    if (state === "connected") {
      if (this.el.playerStatusIcon) this.el.playerStatusIcon.textContent = "🟢";
      if (this.el.playerStatusText) {
        this.el.playerStatusText.textContent = this.videoFound
          ? `Video found (Tab #${tabId})`
          : `Tab connected (Tab #${tabId}) - waiting for video...`;
      }
      if (statusDiv) statusDiv.className = "connected";

      if (this.el.statusDot) {
        this.el.statusDot.className = "status-dot active";
      }
      if (this.el.statusText) {
        this.el.statusText.textContent = this.videoFound
          ? "Video element ready"
          : "Waiting for video element...";
      }
    } else {
      if (this.el.playerStatusIcon) this.el.playerStatusIcon.textContent = "⚪";
      if (this.el.playerStatusText) {
        this.el.playerStatusText.textContent = "No video element found";
      }
      if (statusDiv) statusDiv.className = "";

      if (this.el.statusDot) {
        this.el.statusDot.className = "status-dot";
      }
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

    this.logger.debug(
      "popup",
      `Demo controls ${enabled ? "enabled" : "disabled"} (videoFound: ${this.videoFound})`,
    );
  }

  // ==========================================================================
  // Demo Runner Methods (INDEPENDENT MODE)
  // ==========================================================================

  /**
   * Run all feature demonstrations
   */
  async _runAllDemos() {
    if (this.isDemoRunning) {
      this.logger.warn("popup", "Demo is already running");
      return;
    }
    if (!this.videoFound) {
      this.logger.warn("popup", "No video element found. Waiting for video...");
      this._updateDemoStatus("❌ No video element found", "error");
      return;
    }
    if (!this.demoRunner) {
      this.logger.error("popup", "DemoRunner not available");
      this._updateDemoStatus("❌ DemoRunner not available", "error");
      return;
    }

    this.isDemoRunning = true;
    this._setDemoRunningState(true);
    this._updateDemoStatus("🔄 Running all demos...", "running");
    this._clearDemoResults();

    // NEW: Detect the best stream URL to use
    const streamUrl = await this._detectStreamUrl();

    this.logger.info("popup", "=".repeat(50));
    this.logger.info(
      "popup",
      "🚀 STARTING FULL FEATURE DEMONSTRATION (Independent Mode)",
    );
    this.logger.info("popup", `📋 Video Selector: ${CONFIG.VIDEO_SELECTOR}`);
    this.logger.info("popup", `📋 Active Tab: #${this.activeTabId}`);
    this.logger.info("popup", `📋 Stream URL: ${streamUrl}`);
    this.logger.info("popup", "=".repeat(50));

    try {
      const videoInfo = await this._getVideoElementInfo();
      if (!videoInfo) {
        throw new Error("Could not access video element on page");
      }
      this.logger.info("popup", `📹 Video info: ${JSON.stringify(videoInfo)}`);

      const options = {
        videoElement: null,
        streamUrl: streamUrl, // ← Now uses detected URL
        verbose: true,
        stopOnFailure: false,
        skipLive: document.getElementById("demoSkipLive")?.checked || false,
        skipDRM: document.getElementById("demoSkipDRM")?.checked || true,
        skipCMCD: document.getElementById("demoSkipCMCD")?.checked || false,
        skipIFrame: document.getElementById("demoSkipIFrame")?.checked || false,
        playerProxy: {
          tabId: this.activeTabId,
          executeDemoStep: async (step) => {
            return this._executeDemoStepOnPage(step);
          },
        },
      };

      const results = await this.demoRunner.runAll(options);
      this._displayDemoResults(results);
      this._updateDemoStatus("✅ Complete", "success");
      this.logger.info("popup", "=".repeat(50));
      this.logger.info("popup", "✅ DEMONSTRATION COMPLETE");
      this.logger.info(
        "popup",
        `   ${results.passed}/${results.total} tests passed (${results.total > 0 ? ((results.passed / results.total) * 100).toFixed(1) : 0}%)`,
      );
      this.logger.info("popup", "=".repeat(50));
    } catch (error) {
      this.logger.error("popup", "Demo run failed", { error: error.message });
      this._updateDemoStatus("❌ Failed: " + error.message, "error");
    } finally {
      this.isDemoRunning = false;
      this._setDemoRunningState(false);
    }
  }

  /**
   * Run a quick demo (core + quality + playback only)
   */
  async _runQuickDemo() {
    if (this.isDemoRunning) {
      this.logger.warn("popup", "Demo is already running");
      return;
    }
    if (!this.videoFound) {
      this.logger.warn("popup", "No video element found. Waiting for video...");
      this._updateDemoStatus("❌ No video element found", "error");
      return;
    }
    if (!this.demoRunner) {
      this._updateDemoStatus("❌ DemoRunner not available", "error");
      return;
    }

    this.isDemoRunning = true;
    this._setDemoRunningState(true);
    this._updateDemoStatus("⚡ Running quick test...", "running");
    this._clearDemoResults();

    // NEW: Detect the best stream URL to use
    const streamUrl = await this._detectStreamUrl();

    this.logger.info("popup", "⚡ Running quick demo test...");
    this.logger.info("popup", `📋 Stream URL: ${streamUrl}`);

    try {
      const videoInfo = await this._getVideoElementInfo();
      if (!videoInfo) {
        throw new Error("Could not access video element on page");
      }

      const options = {
        videoElement: null,
        streamUrl: streamUrl, // ← Now uses detected URL
        verbose: true,
        stopOnFailure: false,
        skipLive: true,
        skipDRM: true,
        skipCMCD: true,
        skipIFrame: true,
        playerProxy: {
          tabId: this.activeTabId,
          executeDemoStep: async (step) => {
            return this._executeDemoStepOnPage(step);
          },
        },
      };

      const results = await this.demoRunner.runAll(options);
      this._displayDemoResults(results);
      this._updateDemoStatus("✅ Quick test complete", "success");
    } catch (error) {
      this.logger.error("popup", "Quick demo failed", { error: error.message });
      this._updateDemoStatus("❌ Failed: " + error.message, "error");
    } finally {
      this.isDemoRunning = false;
      this._setDemoRunningState(false);
    }
  }

  /**
   * Stop the currently running demo
   */
  _stopDemo() {
    if (this.isDemoRunning) {
      this.logger.info("popup", "⏹️ Stopping demo...");
      this.isDemoRunning = false;
      this._setDemoRunningState(false);
      this._updateDemoStatus("⏹️ Stopped by user", "stopped");
    }
  }

  // --------------------------------------------------------------------------
  // Page Communication Helpers (INDEPENDENT MODE)
  // --------------------------------------------------------------------------

  /**
   * Get video element information from the active tab
   */
  async _getVideoElementInfo() {
    if (!this.activeTabId) {
      this.logger.warn("popup", "No active tab to query");
      return null;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        func: getVideoElementInfoFromPage,
        args: [CONFIG.VIDEO_SELECTOR],
      });

      if (results && results[0] && results[0].result) {
        this.logger.debug(
          "popup",
          `Video info retrieved: ${JSON.stringify(results[0].result)}`,
        );
        return results[0].result;
      }

      this.logger.warn("popup", "No video info returned from page");
      return null;
    } catch (error) {
      this.logger.error("popup", "Failed to get video info", {
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Execute a single demo step on the active tab page
   */
  async _executeDemoStepOnPage(step) {
    if (!this.activeTabId) {
      return { success: false, error: "No active tab" };
    }

    this.logger.debug(
      "popup",
      `Executing demo step on page: ${step.name || step.action}`,
    );

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        func: executeDemoStepOnPage,
        args: [step, CONFIG.VIDEO_SELECTOR],
      });

      if (results && results[0] && results[0].result) {
        const response = results[0].result;
        this.logger.debug(
          "popup",
          `Demo step result: ${JSON.stringify(response)}`,
        );
        return response;
      }

      return { success: false, error: "No response from page" };
    } catch (error) {
      this.logger.error("popup", "Failed to execute demo step on page", {
        error: error.message,
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Send load stream command to the active tab WITH CORS pre-loading
   */
  async _sendLoadStreamCommand() {
    // NEW: Detect the best URL instead of just reading input
    const url = await this._detectStreamUrl();

    if (!url) {
      this.logger.warn("popup", "No stream URL provided");
      return;
    }

    // Pre-load CORS rules before sending load command
    this.logger.info("popup", "🔧 Pre-loading CORS rules for: " + url);
    chrome.runtime.sendMessage(
      { action: "preloadCorsRules", url: url },
      (response) => {
        if (chrome.runtime.lastError) {
          this.logger.error("popup", "CORS pre-load error", {
            error: chrome.runtime.lastError.message,
          });
        } else if (response?.success) {
          this.logger.info("popup", "✅ CORS rules pre-loaded");
        } else {
          this.logger.warn("popup", "⚠️ CORS pre-load may have failed");
        }
        // Now send the load command
        this._sendLoadCommandToPage(url);
      },
    );
  }

  async _sendLoadCommandToPage(url) {
    if (!this.activeTabId) {
      this.logger.warn("popup", "No active tab. Opening player in new tab...");
      this._openPlayerInNewTab();
      setTimeout(() => this._sendLoadCommandToPage(url), 2000);
      return;
    }

    this.logger.info("popup", `📥 Sending load stream command: ${url}`);

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        func: loadStreamOnPage,
        args: [url, CONFIG.VIDEO_SELECTOR],
      });

      if (results && results[0] && results[0].result) {
        const response = results[0].result;
        if (response.success) {
          this.logger.info("popup", "✓ Load stream command executed");
          this._updateDemoStatus("Stream loading...", "loading");
          setTimeout(() => {
            this._checkVideoStatus();
          }, 2000);
        } else {
          this.logger.error("popup", "Load stream failed", {
            error: response.error,
          });
          this._updateDemoStatus("❌ Load failed: " + response.error, "error");
        }
      }
    } catch (error) {
      this.logger.error("popup", "Failed to send load command", {
        error: error.message,
      });
      this._updateDemoStatus("❌ Cannot execute on this page", "error");
    }
  }

  // ==========================================================================
  // UI Update Methods
  // ==========================================================================

  /**
   * Set UI state for demo running/stopped
   */
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
    this.logger.debug("popup", `Demo running state: ${running}`);
  }

  /**
   * Update demo status text and badge
   */
  _updateDemoStatus(message, type = "info") {
    if (this.el.demoStatusBadge) {
      this.el.demoStatusBadge.textContent = message;
      // Update badge styling based on type
      switch (type) {
        case "success":
          this.el.demoStatusBadge.style.background = "#00ff8822";
          this.el.demoStatusBadge.style.color = "#00ff88";
          this.el.demoStatusBadge.style.border = "1px solid #00ff8844";
          break;
        case "error":
          this.el.demoStatusBadge.style.background = "#ff444422";
          this.el.demoStatusBadge.style.color = "#ff4444";
          this.el.demoStatusBadge.style.border = "1px solid #ff444444";
          break;
        case "running":
          this.el.demoStatusBadge.style.background = "#ffaa0022";
          this.el.demoStatusBadge.style.color = "#ffaa00";
          this.el.demoStatusBadge.style.border = "1px solid #ffaa0044";
          break;
        case "ready":
          this.el.demoStatusBadge.style.background = "#00d4ff22";
          this.el.demoStatusBadge.style.color = "#00d4ff";
          this.el.demoStatusBadge.style.border = "1px solid #00d4ff44";
          break;
        case "loading":
          this.el.demoStatusBadge.style.background = "#ffaa0022";
          this.el.demoStatusBadge.style.color = "#ffaa00";
          this.el.demoStatusBadge.style.border = "1px solid #ffaa0044";
          break;
        case "stopped":
          this.el.demoStatusBadge.style.background = "#88888822";
          this.el.demoStatusBadge.style.color = "#888";
          this.el.demoStatusBadge.style.border = "1px solid #88888844";
          break;
        default:
          this.el.demoStatusBadge.style.background = "#00ff8822";
          this.el.demoStatusBadge.style.color = "#00ff88";
          this.el.demoStatusBadge.style.border = "1px solid #00ff8844";
      }
    }
    this.logger.info("popup", `Demo status: ${message} (${type})`);
  }

  /**
   * Update demo progress bar
   */
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

  /**
   * Clear previous demo results
   */
  _clearDemoResults() {
    if (this.el.demoTotal) this.el.demoTotal.textContent = "--";
    if (this.el.demoPassed) this.el.demoPassed.textContent = "--";
    if (this.el.demoFailed) this.el.demoFailed.textContent = "--";
    if (this.el.demoSkipped) this.el.demoSkipped.textContent = "--";
    if (this.el.demoRate) this.el.demoRate.textContent = "--";
    if (this.el.demoDuration) this.el.demoDuration.textContent = "--";
    if (this.el.demoResultsDetail) this.el.demoResultsDetail.innerHTML = "";
    this._updateDemoProgress(0, "Starting...");
    this.logger.debug("popup", "Demo results cleared");
  }

  /**
   * Display demo results in the UI
   */
  _displayDemoResults(results) {
    if (!results) {
      this.logger.warn("popup", "No results to display");
      return;
    }

    if (this.el.demoTotal) this.el.demoTotal.textContent = results.total || 0;
    if (this.el.demoPassed) {
      this.el.demoPassed.textContent = results.passed || 0;
      this.el.demoPassed.className = results.passed > 0 ? "text-success" : "";
    }
    if (this.el.demoFailed) {
      this.el.demoFailed.textContent = results.failed || 0;
      this.el.demoFailed.className = results.failed > 0 ? "text-danger" : "";
    }
    if (this.el.demoSkipped)
      this.el.demoSkipped.textContent = results.skipped || 0;

    const successRate =
      results.total > 0
        ? ((results.passed / results.total) * 100).toFixed(1) + "%"
        : "0%";
    if (this.el.demoRate) this.el.demoRate.textContent = successRate;

    const duration = results.duration
      ? (results.duration / 1000).toFixed(2) + "s"
      : "--";
    if (this.el.demoDuration) this.el.demoDuration.textContent = duration;

    // Display detailed test results
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

    // Update progress bar
    this._updateDemoProgress(
      100,
      `Complete: ${results.passed}/${results.total} passed`,
    );

    this.logger.info(
      "popup",
      `📊 Demo results displayed: ${results.passed}/${results.total} passed (${successRate})`,
    );
  }

  // ==========================================================================
  // Background Stats
  // ==========================================================================
  _getBackgroundStats() {
    chrome.runtime.sendMessage({ action: "getStats" }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[Popup] Stats error:", chrome.runtime.lastError.message);
        this._updateStatsDisplay({
          requestsIntercepted: 0,
          corsHeadersAdded: 0,
          activeStreams: [],
          recentRequests: [],
          corsRules: { totalRules: 0, domains: [] },
        });
        if (this.el.corsModeBadge) {
          this.el.corsModeBadge.textContent = "Connecting...";
          this.el.corsModeBadge.style.background = "#ff444422";
          this.el.corsModeBadge.style.color = "#ff4444";
          this.el.corsModeBadge.style.border = "1px solid #ff444444";
        }
        return;
      }

      if (response && response.success) {
        this._updateStatsDisplay(response.stats);
        if (this.el.corsModeBadge) {
          this.el.corsModeBadge.textContent = "Auto-Fix Active";
          this.el.corsModeBadge.style.background = "#00ff8822";
          this.el.corsModeBadge.style.color = "#00ff88";
          this.el.corsModeBadge.style.border = "1px solid #00ff8844";
        }
      }
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

    if (
      stats.activeStreams &&
      stats.activeStreams.length > 0 &&
      this.el.domainList
    ) {
      this.el.domainList.style.display = "block";
      const recentDomains = stats.recentRequests || [];
      const domainCorsStatus = {};
      recentDomains.forEach((req) => {
        if (!domainCorsStatus[req.domain]) {
          domainCorsStatus[req.domain] = req.hasCORS;
        }
      });

      const rulesDomains = new Set(stats.corsRules?.domains || []);

      if (this.el.domainListContent) {
        this.el.domainListContent.innerHTML = stats.activeStreams
          .map((domain) => {
            let badgeClass = "ok";
            let badgeText = "OK";
            if (rulesDomains.has(domain)) {
              badgeClass = "fixed";
              badgeText = "Fixed";
            } else if (domainCorsStatus[domain] === false) {
              badgeClass = "error";
              badgeText = "Blocked";
            }
            return `
              <div class="domain-item">
                <span class="domain-name" title="${domain}">${domain}</span>
                <span class="cors-badge ${badgeClass}">${badgeText}</span>
              </div>
            `;
          })
          .join("");
      }
    } else if (this.el.domainList) {
      this.el.domainList.style.display = "none";
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------
  destroy() {
    if (this._statsInterval) clearInterval(this._statsInterval);
    if (this._videoCheckInterval) clearInterval(this._videoCheckInterval);
    this.logger.info("popup", "PopupController destroyed");
  }
}

// ============================================================================
// CONTENT SCRIPTS - Injected into the active tab via chrome.scripting
// ============================================================================

/**
 * Setup MutationObserver on the page to watch for video element.
 * This function is serialized and executed in the page context.
 *
 * @param {string} videoSelector - CSS selector for the video element
 * @param {number} timeout - Maximum time to wait in milliseconds
 */
function setupVideoObserver(videoSelector, timeout) {
  console.log(
    `[ContentScript] 🔍 Setting up MutationObserver for selector: "${videoSelector}"`,
  );
  console.log(`[ContentScript] ⏱️ Timeout: ${timeout}ms`);

  // Store observer state on window to persist across checks
  window.__hlsVideoObserver = window.__hlsVideoObserver || {
    found: false,
    observer: null,
    startTime: Date.now(),
    videoSelector: videoSelector,
  };

  const state = window.__hlsVideoObserver;

  // Check if already found
  const existingVideo = document.querySelector(videoSelector);
  if (existingVideo) {
    console.log(`[ContentScript] ✅ Video element already exists in DOM!`);
    state.found = true;
    return;
  }

  // Check if observer is already running
  if (state.observer) {
    console.log(`[ContentScript] Observer already running...`);
    return;
  }

  // Create MutationObserver
  const observer = new MutationObserver((mutations, obs) => {
    // Check for timeout
    if (Date.now() - state.startTime > timeout) {
      console.log(`[ContentScript] ⏰ Observer timed out after ${timeout}ms`);
      obs.disconnect();
      state.observer = null;
      return;
    }

    // Check if video element exists now
    const videoEl = document.querySelector(videoSelector);
    if (videoEl) {
      console.log(
        `[ContentScript] 🎯 Video element FOUND via MutationObserver!`,
      );
      console.log(`[ContentScript]    Tag: ${videoEl.tagName}`);
      console.log(`[ContentScript]    Src: ${videoEl.currentSrc || "(none)"}`);
      console.log(`[ContentScript]    Duration: ${videoEl.duration}`);

      state.found = true;

      // We can disconnect now since we found the element
      // But keep watching in case it's removed and re-added
      // obs.disconnect();
      // state.observer = null;
    }
  });

  // Start observing
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  state.observer = observer;

  console.log(
    `[ContentScript] 👁️ MutationObserver started watching for "${videoSelector}"`,
  );
}

/**
 * Get current status of the video element.
 * This function is serialized and executed in the page context.
 *
 * @param {string} videoSelector - CSS selector for the video element
 * @returns {Object} Status object with found flag and video info
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

  // If observer timed out, report not found
  if (state.startTime && Date.now() - state.startTime > 30000) {
    return {
      found: false,
      info: null,
      timedOut: true,
    };
  }

  return {
    found: false,
    info: null,
    observerActive: !!state.observer,
  };
}

/**
 * Get detailed video element information from the page.
 *
 * @param {string} videoSelector - CSS selector for the video element
 * @returns {Object|null} Video element information
 */
function getVideoElementInfoFromPage(videoSelector) {
  const videoEl = document.querySelector(videoSelector);

  if (!videoEl) {
    console.log(
      `[ContentScript] ❌ Video element not found: "${videoSelector}"`,
    );
    return null;
  }

  const info = {
    tagName: videoEl.tagName,
    currentSrc: videoEl.currentSrc,
    duration: videoEl.duration,
    paused: videoEl.paused,
    readyState: videoEl.readyState,
    networkState: videoEl.networkState,
    videoWidth: videoEl.videoWidth,
    videoHeight: videoEl.videoHeight,
    hasHlsInstance: !!(window.hls || (window.Hls && window.Hls.instances)),
  };

  console.log(`[ContentScript] 📹 Video info:`, info);
  return info;
}

/**
 * Execute a demo step on the page.
 * This function is serialized and executed in the page context.
 * ALL helper logic must be inline - no external function calls.
 *
 * @param {Object} step - The demo step to execute
 * @param {string} videoSelector - CSS selector for the video element
 * @returns {Object} Result of the demo step execution
 */
function executeDemoStepOnPage(step, videoSelector) {
  console.log(
    `[ContentScript] 🎬 Executing demo step: ${step.name || step.action}`,
  );
  try {
    const videoEl = document.querySelector(videoSelector);
    if (!videoEl) {
      return {
        success: false,
        error: `Video element not found: "${videoSelector}"`,
      };
    }

    // Handle different step actions
    switch (step.action) {
      case "play":
        videoEl.play();
        return { success: true, action: "play" };

      case "pause":
        videoEl.pause();
        return { success: true, action: "pause" };

      case "seek":
        if (step.time !== undefined) {
          videoEl.currentTime = step.time;
          return { success: true, action: "seek", time: step.time };
        }
        return { success: false, error: "No time specified for seek" };

      case "getState":
        return {
          success: true,
          state: {
            currentTime: videoEl.currentTime,
            duration: videoEl.duration,
            paused: videoEl.paused,
            readyState: videoEl.readyState,
            networkState: videoEl.networkState,
            videoWidth: videoEl.videoWidth,
            videoHeight: videoEl.videoHeight,
          },
        };

      case "setVolume":
        if (step.volume !== undefined) {
          videoEl.volume = Math.max(0, Math.min(1, step.volume));
          return { success: true, action: "setVolume", volume: videoEl.volume };
        }
        return { success: false, error: "No volume specified" };

      case "getVolume":
        return { success: true, volume: videoEl.volume, muted: videoEl.muted };

      // ====================================================================
      // loadStream: ALL logic inline (no external function calls)
      // because chrome.scripting.executeScript only serializes THIS function
      // ====================================================================
      case "loadStream": {
        const url = step.streamUrl;
        if (!url) {
          return { success: false, error: "No stream URL provided" };
        }
        console.log(`[ContentScript] 📥 Loading stream: ${url}`);
        console.log(`[ContentScript] 🎯 Target video:`, videoEl);

        // Check if HLS.js is available on the page
        if (typeof Hls !== "undefined" && Hls.isSupported()) {
          console.log(`[ContentScript] ✅ HLS.js available, creating instance`);

          // Destroy existing HLS instance if attached to this video
          if (videoEl._hlsInstance) {
            videoEl._hlsInstance.destroy();
            console.log(`[ContentScript] 🗑️ Destroyed previous HLS instance`);
          }

          const hls = new Hls({
            debug: false,
            enableWorker: true,
          });

          hls.loadSource(url);
          hls.attachMedia(videoEl);
          videoEl._hlsInstance = hls;

          // Store reference globally for cleanup
          window.__hlsDemoInstance = hls;

          console.log(`[ContentScript] ✅ HLS stream loaded via hls.js`);
          return { success: true, method: "hlsjs" };
        } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
          // Native HLS support (Safari)
          console.log(`[ContentScript] Using native HLS support`);
          videoEl.src = url;
          return { success: true, method: "native" };
        } else {
          return {
            success: false,
            error: "HLS playback not supported on this page",
          };
        }
      }

      default:
        // For unknown actions, try to execute as a video method
        if (typeof videoEl[step.action] === "function") {
          const result = videoEl[step.action](...(step.args || []));
          return { success: true, action: step.action, result: result };
        }
        return { success: false, error: `Unknown action: ${step.action}` };
    }
  } catch (error) {
    console.error(`[ContentScript] ❌ Demo step failed:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Load a stream URL into a video element on the page.
 *
 * @param {string} url - The stream URL to load
 * @param {string} videoSelector - CSS selector for the video element
 * @returns {Object} Result of the load operation
 */
function loadStreamOnPage(url, videoSelector) {
  console.log(`[ContentScript] 📥 Loading stream: ${url}`);
  console.log(`[ContentScript] 🎯 Target selector: ${videoSelector}`);

  try {
    // Try to find existing video element
    let videoEl = document.querySelector(videoSelector);

    // If no video element found, try to create one or look for any video
    if (!videoEl) {
      console.log(
        `[ContentScript] ⚠️ Target video not found, looking for any video element...`,
      );
      videoEl = document.querySelector("video");

      if (!videoEl) {
        console.log(`[ContentScript] ❌ No video element found on page`);
        return { success: false, error: "No video element found on page" };
      }

      console.log(`[ContentScript] Found alternative video element:`, videoEl);
    }

    // Check if HLS.js is available
    if (typeof Hls !== "undefined" && Hls.isSupported()) {
      console.log(
        `[ContentScript] ✅ HLS.js is available, creating HLS instance`,
      );

      // Destroy existing HLS instance if any
      if (videoEl._hlsInstance) {
        videoEl._hlsInstance.destroy();
        console.log(`[ContentScript] 🗑️ Destroyed previous HLS instance`);
      }

      const hls = new Hls({
        debug: false,
        enableWorker: true,
      });

      hls.loadSource(url);
      hls.attachMedia(videoEl);

      videoEl._hlsInstance = hls;

      console.log(`[ContentScript] ✅ HLS stream loaded`);
      return { success: true, method: "hlsjs" };
    } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari)
      console.log(`[ContentScript] Using native HLS support`);
      videoEl.src = url;
      return { success: true, method: "native" };
    } else {
      return {
        success: false,
        error: "HLS playback not supported on this page",
      };
    }
  } catch (error) {
    console.error(`[ContentScript] ❌ Failed to load stream:`, error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Initialize
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  console.log("[Popup] 🚀 Popup initializing (Independent Mode)...");
  console.log("[Popup] 📋 VIDEO_SELECTOR:", CONFIG.VIDEO_SELECTOR);
  console.log(
    "[Popup] 📋 DemoRunner available:",
    typeof DemoRunner !== "undefined",
  );

  window.popupController = new PopupController();

  console.log("[Popup] ✓ Popup ready");
  console.log(
    "[Popup] ℹ️  Independent mode: works directly with current page's video element",
  );
  console.log(
    "[Popup] ℹ️  Uses MutationObserver to wait for video element to appear",
  );
});

// Cleanup on unload
window.addEventListener("beforeunload", () => {
  if (window.popupController) {
    window.popupController.destroy();
  }
});
