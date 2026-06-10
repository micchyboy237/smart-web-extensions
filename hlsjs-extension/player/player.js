/**
 * player.js - Main Player Controller
 *
 * Orchestrates all feature modules, manages UI interactions,
 * connects the hls.js instance to the DOM, and integrates
 * the automated demo runner for feature verification.
 */
// ============================================================================
// Main Application Controller
// ============================================================================
class PlayerApp {
  constructor() {
    this.player = null;
    this.playbackCtrl = null;
    this.qualityCtrl = null;
    this.audioCtrl = null;
    this.liveCtrl = null;
    this.errorCtrl = null;
    this.iframeCtrl = null;
    this.drmCtrl = null;
    this.cmcdCtrl = null;

    // Demo runner
    this.demoRunner = null;
    this.isDemoRunning = false;

    // DOM elements
    this.videoEl = document.getElementById("video");
    this.iframeVideoEl = document.getElementById("iframeVideo");
    this.thumbnailEl = document.getElementById("thumbnailPreview");

    // UI state
    this.logRemoveListener = null;

    Logger.info("app", "PlayerApp initializing...");
    this._init();
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================
  _init() {
    Logger.debug("app", "Setting up UI event listeners...");
    this._setupUIEvents();
    this._setupDemoRunner();
    this._setupLogListener();

    // Check for auto-run parameter
    this._checkAutoRun();

    Logger.info("app", "✓ PlayerApp initialized. Ready to load stream.");
  }

  /**
   * Check if ?autorun=true is in the URL, and auto-load + auto-demo
   */
  _checkAutoRun() {
    const urlParams = new URLSearchParams(window.location.search);
    const autoUrl = urlParams.get("url"); // ✅ Reads ?url= parameter

    if (autoUrl) {
      document.getElementById("streamUrl").value = autoUrl;
      Logger.info("app", `Auto-run URL set: ${autoUrl}`);
    }
  }

  /**
   * Set up listener to auto-run demos once manifest is loaded
   */
  _autoRunOnManifestLoad() {
    // Poll for manifest load
    const checkInterval = setInterval(() => {
      if (this.player && this.player.state.manifestLoaded) {
        clearInterval(checkInterval);
        Logger.info("app", "📋 Manifest loaded, auto-running demos...");
        setTimeout(() => this._runAllDemos(), 2000); // Give a moment to buffer
      }
    }, 500);

    // Timeout after 30 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      if (
        !this.isDemoRunning &&
        (!this.player || !this.player.state.manifestLoaded)
      ) {
        Logger.warn(
          "app",
          "⏰ Auto-run timeout - manifest didn't load in time",
        );
      }
    }, 30000);
  }

  // --------------------------------------------------------------------------
  // UI Event Setup
  // --------------------------------------------------------------------------
  _setupUIEvents() {
    // Load button
    document.getElementById("loadBtn").addEventListener("click", () => {
      this._loadStream();
    });

    // Run Demo button (header)
    document.getElementById("runDemoBtn").addEventListener("click", () => {
      this._runAllDemos();
    });

    // Destroy button
    document.getElementById("destroyBtn").addEventListener("click", () => {
      this._destroyPlayer();
    });

    // Enter key in URL field
    document.getElementById("streamUrl").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._loadStream();
    });

    // Play/Pause
    document.getElementById("playBtn").addEventListener("click", () => {
      if (this.player) this.player.play();
    });
    document.getElementById("pauseBtn").addEventListener("click", () => {
      if (this.player) this.player.pause();
    });

    // Seek
    document.getElementById("seekBackBtn").addEventListener("click", () => {
      if (this.playbackCtrl) this.playbackCtrl.seekRelative(-10);
    });
    document.getElementById("seekForwardBtn").addEventListener("click", () => {
      if (this.playbackCtrl) this.playbackCtrl.seekRelative(10);
    });

    // Playback rate
    document
      .getElementById("playbackRateSelect")
      .addEventListener("change", (e) => {
        if (this.playbackCtrl) {
          this.playbackCtrl.setPlaybackRate(parseFloat(e.target.value));
        }
      });

    // Volume
    document.getElementById("volumeSlider").addEventListener("input", (e) => {
      if (this.playbackCtrl) {
        this.playbackCtrl.setVolume(parseInt(e.target.value) / 100);
      }
    });
    document.getElementById("muteBtn").addEventListener("click", () => {
      if (this.playbackCtrl) this.playbackCtrl.toggleMute();
    });

    // Quality tab
    document.getElementById("qualitySelect").addEventListener("change", (e) => {
      if (this.qualityCtrl)
        this.qualityCtrl.setQuality(parseInt(e.target.value));
    });
    document.getElementById("enableAutoBtn").addEventListener("click", () => {
      if (this.qualityCtrl) this.qualityCtrl.enableAutoQuality();
    });
    document
      .getElementById("abrAggressiveBtn")
      .addEventListener("click", () => {
        if (this.qualityCtrl) this.qualityCtrl.applyABRProfile("aggressive");
      });
    document
      .getElementById("abrConservativeBtn")
      .addEventListener("click", () => {
        if (this.qualityCtrl) this.qualityCtrl.applyABRProfile("conservative");
      });

    // Audio tab
    document
      .getElementById("audioTrackSelect")
      .addEventListener("change", (e) => {
        if (this.audioCtrl)
          this.audioCtrl.setAudioTrack(parseInt(e.target.value));
      });
    document
      .getElementById("subtitleTrackSelect")
      .addEventListener("change", (e) => {
        if (this.audioCtrl)
          this.audioCtrl.setSubtitleTrack(parseInt(e.target.value));
      });
    document
      .getElementById("toggleSubtitlesBtn")
      .addEventListener("click", () => {
        if (this.audioCtrl) this.audioCtrl.toggleSubtitleDisplay();
      });

    // Playback tab
    document.getElementById("pauseBufferBtn").addEventListener("click", () => {
      if (this.playbackCtrl) this.playbackCtrl.pauseBuffering();
    });
    document.getElementById("resumeBufferBtn").addEventListener("click", () => {
      if (this.playbackCtrl) this.playbackCtrl.resumeBuffering();
    });
    document.getElementById("seekToBtn").addEventListener("click", () => {
      if (this.playbackCtrl) this.playbackCtrl.seekTo(60);
    });

    // Live tab
    document.getElementById("goLiveBtn").addEventListener("click", () => {
      if (this.liveCtrl) this.liveCtrl.goToLive();
    });
    document.getElementById("enableLLHLSBtn").addEventListener("click", () => {
      if (this.liveCtrl) this.liveCtrl.enableLowLatency(true);
    });

    // I-Frame tab
    document.getElementById("showPreviewBtn").addEventListener("click", () => {
      if (this.iframeCtrl) this.iframeCtrl.showPreviewAtTime(30);
    });
    document.getElementById("hidePreviewBtn").addEventListener("click", () => {
      if (this.iframeCtrl) this.iframeCtrl.hidePreview();
    });

    // DRM tab
    document
      .getElementById("configWidevineBtn")
      .addEventListener("click", () => {
        if (this.drmCtrl) {
          this.drmCtrl.configureWidevine(
            "https://license.example.com/widevine",
          );
        }
      });

    // CMCD tab
    document.getElementById("enableCMCDBtn").addEventListener("click", () => {
      if (this.cmcdCtrl) this.cmcdCtrl.enableCMCDv2();
    });
    document.getElementById("trackActionBtn").addEventListener("click", () => {
      if (this.cmcdCtrl) this.cmcdCtrl.trackUserAction("button-click");
    });

    // Error tab
    document.getElementById("clearErrorsBtn").addEventListener("click", () => {
      if (this.errorCtrl) this.errorCtrl.getErrorHistory();
      document.getElementById("errorList").innerHTML = "";
    });

    // Retry button
    document.getElementById("retryBtn").addEventListener("click", () => {
      if (this.errorCtrl) this.errorCtrl.manualRecover();
    });

    // Log tab
    document.getElementById("clearLogsBtn").addEventListener("click", () => {
      Logger.clear();
      document.getElementById("logContainer").innerHTML = "";
    });
    document.getElementById("logFilter").addEventListener("change", (e) => {
      this._refreshLogDisplay();
    });

    // Tab switching
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        this._switchTab(tab.dataset.tab);
      });
    });

    Logger.debug("app", "✓ UI events setup complete");
  }

  // --------------------------------------------------------------------------
  // Demo Runner Setup
  // --------------------------------------------------------------------------
  _setupDemoRunner() {
    // Create demo runner instance
    if (typeof DemoRunner !== "undefined") {
      this.demoRunner = new DemoRunner();
      Logger.info("app", "✓ DemoRunner instance created");
    } else {
      Logger.warn(
        "app",
        "DemoRunner class not available - demo features disabled",
      );
    }

    // Demo tab buttons
    document.getElementById("demoRunBtn")?.addEventListener("click", () => {
      this._runAllDemos();
    });

    document.getElementById("demoQuickBtn")?.addEventListener("click", () => {
      this._runQuickDemo();
    });

    document.getElementById("demoStopBtn")?.addEventListener("click", () => {
      this._stopDemo();
    });
  }

  // --------------------------------------------------------------------------
  // Log Listener Setup
  // --------------------------------------------------------------------------
  _setupLogListener() {
    this.logRemoveListener = Logger.addListener((entry) => {
      this._appendLogEntry(entry);
    });
  }

  _appendLogEntry(entry) {
    const container = document.getElementById("logContainer");
    if (!container) return;
    const filter = document.getElementById("logFilter")?.value || "all";
    // Filter
    if (filter !== "all" && entry.level !== filter) return;
    const div = document.createElement("div");
    div.className = `log-entry ${entry.level}`;
    const time = entry.timestamp.split("T")[1].split(".")[0];
    div.innerHTML = `<span class="timestamp">${time}</span><span class="module">[${entry.module}]</span>${entry.message}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    // Trim old entries
    while (container.children.length > 200) {
      container.removeChild(container.firstChild);
    }
  }

  _refreshLogDisplay() {
    const container = document.getElementById("logContainer");
    if (!container) return;
    container.innerHTML = "";
    const history = Logger.getHistory();
    const filter = document.getElementById("logFilter")?.value || "all";
    history.forEach((entry) => {
      if (filter !== "all" && entry.level !== filter) return;
      const div = document.createElement("div");
      div.className = `log-entry ${entry.level}`;
      const time = entry.timestamp.split("T")[1].split(".")[0];
      div.innerHTML = `<span class="timestamp">${time}</span><span class="module">[${entry.module}]</span>${entry.message}`;
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  }

  // --------------------------------------------------------------------------
  // Tab Switching
  // --------------------------------------------------------------------------
  _switchTab(tabId) {
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));
    document.querySelector(`[data-tab="${tabId}"]`)?.classList.add("active");
    document.getElementById(tabId)?.classList.add("active");
    if (tabId === "tab-logs") {
      this._refreshLogDisplay();
    }
  }

  // ==========================================================================
  // Demo Runner Methods
  // ==========================================================================

  /**
   * Run all feature demonstrations
   */
  async _runAllDemos() {
    if (this.isDemoRunning) {
      Logger.warn("app", "Demo is already running");
      return;
    }

    if (!this.player) {
      Logger.warn("app", "No player loaded. Please load a stream first.");
      this._updateDemoStatus("❌ Load a stream first");
      return;
    }

    if (!this.demoRunner) {
      Logger.error("app", "DemoRunner not available");
      this._updateDemoStatus("❌ DemoRunner not available");
      return;
    }

    this.isDemoRunning = true;
    this._setDemoRunningState(true);
    this._updateDemoStatus("🔄 Running all demos...");
    this._clearDemoResults();

    const streamUrl = document.getElementById("streamUrl").value.trim();

    Logger.info("app", "=".repeat(50));
    Logger.info("app", "🚀 STARTING FULL FEATURE DEMONSTRATION");
    Logger.info("app", "=".repeat(50));

    try {
      const options = {
        videoElement: this.videoEl,
        streamUrl: streamUrl,
        verbose: true,
        stopOnFailure: false,
        skipLive: document.getElementById("demoSkipLive")?.checked || false,
        skipDRM: document.getElementById("demoSkipDRM")?.checked || true,
        skipCMCD: document.getElementById("demoSkipCMCD")?.checked || false,
        skipIFrame: document.getElementById("demoSkipIFrame")?.checked || false,
      };

      const results = await this.demoRunner.runAll(options);
      this._displayDemoResults(results);
      this._updateDemoStatus("✅ Complete");

      Logger.info("app", "=".repeat(50));
      Logger.info("app", "✅ DEMONSTRATION COMPLETE");
      Logger.info(
        "app",
        `   ${results.passed}/${results.total} tests passed (${results.total > 0 ? ((results.passed / results.total) * 100).toFixed(1) : 0}%)`,
      );
      Logger.info("app", "=".repeat(50));
    } catch (error) {
      Logger.error("app", "Demo run failed", { error: error.message });
      this._updateDemoStatus("❌ Failed: " + error.message);
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
      Logger.warn("app", "Demo is already running");
      return;
    }

    if (!this.player) {
      Logger.warn("app", "No player loaded. Please load a stream first.");
      this._updateDemoStatus("❌ Load a stream first");
      return;
    }

    if (!this.demoRunner) {
      this._updateDemoStatus("❌ DemoRunner not available");
      return;
    }

    this.isDemoRunning = true;
    this._setDemoRunningState(true);
    this._updateDemoStatus("⚡ Running quick test...");
    this._clearDemoResults();

    const streamUrl = document.getElementById("streamUrl").value.trim();

    Logger.info("app", "⚡ Running quick demo test...");

    try {
      const options = {
        videoElement: this.videoEl,
        streamUrl: streamUrl,
        verbose: true,
        stopOnFailure: false,
        skipLive: true,
        skipDRM: true,
        skipCMCD: true,
        skipIFrame: true,
      };

      const results = await this.demoRunner.runAll(options);
      this._displayDemoResults(results);
      this._updateDemoStatus("✅ Quick test complete");
    } catch (error) {
      Logger.error("app", "Quick demo failed", { error: error.message });
      this._updateDemoStatus("❌ Failed: " + error.message);
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
      Logger.info("app", "⏹️ Stopping demo...");
      this.isDemoRunning = false;
      this._setDemoRunningState(false);
      this._updateDemoStatus("⏹️ Stopped by user");

      // Clean up by destroying and recreating player
      if (this.player) {
        this._destroyPlayer();
        Logger.info("app", "Player destroyed after demo stop");
      }
    }
  }

  /**
   * Set UI state for demo running/stopped
   */
  _setDemoRunningState(running) {
    const demoRunBtn = document.getElementById("demoRunBtn");
    const demoQuickBtn = document.getElementById("demoQuickBtn");
    const demoStopBtn = document.getElementById("demoStopBtn");
    const runDemoBtn = document.getElementById("runDemoBtn");
    const demoProgress = document.getElementById("demoProgress");

    if (demoRunBtn) demoRunBtn.disabled = running;
    if (demoQuickBtn) demoQuickBtn.disabled = running;
    if (demoStopBtn)
      demoStopBtn.style.display = running ? "inline-block" : "none";
    if (runDemoBtn) runDemoBtn.disabled = running;
    if (demoProgress) demoProgress.style.display = running ? "block" : "none";

    // Auto-switch to demo tab when running
    if (running) {
      this._switchTab("tab-demo");
    }
  }

  /**
   * Update demo status text
   */
  _updateDemoStatus(message) {
    const statusEl = document.getElementById("demoRate");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = message.includes("✅")
        ? "text-success"
        : message.includes("❌")
          ? "text-danger"
          : "";
    }
  }

  /**
   * Clear previous demo results
   */
  _clearDemoResults() {
    document.getElementById("demoTotal").textContent = "--";
    document.getElementById("demoPassed").textContent = "--";
    document.getElementById("demoFailed").textContent = "--";
    document.getElementById("demoSkipped").textContent = "--";
    document.getElementById("demoRate").textContent = "--";
    document.getElementById("demoDuration").textContent = "--";
    document.getElementById("demoResultsDetail").innerHTML = "";
  }

  /**
   * Display demo results in the UI
   */
  _displayDemoResults(results) {
    if (!results) return;

    document.getElementById("demoTotal").textContent = results.total || 0;
    document.getElementById("demoPassed").textContent = results.passed || 0;
    document.getElementById("demoFailed").textContent = results.failed || 0;
    document.getElementById("demoSkipped").textContent = results.skipped || 0;

    const successRate =
      results.total > 0
        ? ((results.passed / results.total) * 100).toFixed(1) + "%"
        : "0%";
    document.getElementById("demoRate").textContent = successRate;

    const duration = results.duration
      ? (results.duration / 1000).toFixed(2) + "s"
      : "--";
    document.getElementById("demoDuration").textContent = duration;

    // Display detailed test results
    const detailEl = document.getElementById("demoResultsDetail");
    if (detailEl && results.tests) {
      detailEl.innerHTML = results.tests
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

    // Update progress bar if available
    const progressFill = document.getElementById("demoProgressFill");
    const progressText = document.getElementById("demoProgressText");
    if (progressFill && progressText) {
      progressFill.style.width = "100%";
      progressText.textContent = `Complete: ${results.passed}/${results.total} passed`;
    }

    Logger.info(
      "app",
      `📊 Demo results displayed: ${results.passed}/${results.total} passed (${successRate})`,
    );
  }

  // ==========================================================================
  // Stream Loading with CORS Pre-loading
  // ==========================================================================

  /**
   * Load stream with CORS pre-loading
   */
  _loadStream() {
    const url = document.getElementById("streamUrl").value.trim();
    if (!url) {
      Logger.warn("app", "No stream URL provided");
      return;
    }
    Logger.info("app", `🔄 Loading stream: ${url}`);

    // Destroy existing player if any
    this._destroyPlayer();

    // Show loading
    document.getElementById("loadingOverlay").style.display = "flex";
    document.getElementById("errorOverlay").style.display = "none";

    // Pre-load CORS rules BEFORE creating the player
    this._preloadCorsThenCreatePlayer(url);
  }

  /**
   * Pre-load CORS rules, then create the player
   */
  async _preloadCorsThenCreatePlayer(url) {
    Logger.info("app", "🔧 Step 1: Pre-loading CORS bypass rules...");

    // Check if FetchProxy is available (content script or injected)
    let corsPreloaded = false;

    if (
      window.FetchProxy &&
      typeof window.FetchProxy.preloadCorsRules === "function"
    ) {
      corsPreloaded = await window.FetchProxy.preloadCorsRules(url);
    } else {
      // Fall back to direct message to background
      corsPreloaded = await this._preloadCorsRulesDirect(url);
    }

    if (corsPreloaded) {
      Logger.info("app", "✅ CORS rules pre-loaded successfully");
    } else {
      Logger.warn("app", "⚠️ CORS rules not pre-loaded, stream may fail");
    }

    Logger.info("app", "🔧 Step 2: Creating HLS player...");

    try {
      this._createPlayer(url);
    } catch (error) {
      Logger.error("app", "Failed to create player", { error: error.message });
      document.getElementById("loadingOverlay").style.display = "none";
    }
  }

  /**
   * Direct pre-load of CORS rules via background message
   */
  async _preloadCorsRulesDirect(url) {
    return new Promise((resolve) => {
      if (
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        !chrome.runtime.sendMessage
      ) {
        Logger.warn("app", "chrome.runtime.sendMessage not available");
        resolve(false);
        return;
      }

      chrome.runtime.sendMessage(
        {
          action: "preloadCorsRules",
          url: url,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            Logger.error("app", "Pre-load CORS rules error:", {
              error: chrome.runtime.lastError.message,
            });
            resolve(false);
            return;
          }

          if (response && response.success) {
            Logger.info("app", "✅ CORS rules pre-loaded via background");
            resolve(true);
          } else {
            Logger.warn(
              "app",
              "⚠️ CORS rules pre-load failed:",
              response?.error || "unknown",
            );
            resolve(false);
          }
        },
      );
    });
  }

  /**
   * Create player with fetch proxy awareness
   */
  _createPlayer(url) {
    Logger.info("app", "Creating HlsPlayer instance...");

    // Log fetch proxy status
    if (window.__fetchProxyStats) {
      Logger.info(
        "app",
        `📊 Fetch proxy stats: ${JSON.stringify(window.__fetchProxyStats)}`,
      );
    }

    // Custom loader that logs requests (for debugging)
    const customLoader = {
      ...Hls.DefaultConfig.loader,
      load: function (context, config, callbacks) {
        Logger.debug(
          "app",
          `📡 HLS loading: ${context.type} - ${context.url.substring(0, 100)}`,
        );

        // Track if this is going through proxy
        if (window.__fetchProxyStats) {
          const statsBefore = window.__fetchProxyStats.proxied;

          // Call original loader
          Hls.DefaultConfig.loader.load.call(this, context, config, {
            ...callbacks,
            onSuccess: (response, stats, context, networkDetails) => {
              const statsAfter = window.__fetchProxyStats.proxied;
              if (statsAfter > statsBefore) {
                Logger.debug("app", `  ✅ Proxy used for: ${context.type}`);
              }
              if (callbacks.onSuccess) {
                callbacks.onSuccess(response, stats, context, networkDetails);
              }
            },
            onError: (error, context, networkDetails, stats) => {
              Logger.error(
                "app",
                `  ❌ Load error for ${context.type}: ${error.message || error}`,
              );
              if (callbacks.onError) {
                callbacks.onError(error, context, networkDetails, stats);
              }
            },
          });
        } else {
          // Use default loader
          Hls.DefaultConfig.loader.load.call(this, context, config, callbacks);
        }
      },
    };

    // Create player with configuration
    this.player = new HlsPlayer(this.videoEl, {
      autoStartLoad: true,
      debug: false,
      capLevelToPlayerSize: false,
      enableWorker: true,
      enableWebVTT: true,
      enableCEA708Captions: true,
      enableID3MetadataCues: true,
      backBufferLength: 90,
      maxBufferLength: 30,
      // Use custom loader for debugging
      // loader: customLoader,  // Uncomment to enable detailed request logging
    });

    // Initialize feature controllers
    this.playbackCtrl = new PlaybackController(this.player);
    this.qualityCtrl = new QualityController(this.player);
    this.audioCtrl = new AudioController(this.player);
    this.liveCtrl = new LiveController(this.player);
    this.errorCtrl = new ErrorController(this.player);
    this.iframeCtrl = new IFrameController(this.player);
    this.drmCtrl = new DRMController(this.player);
    this.cmcdCtrl = new CMCDController(this.player);

    // Register modules with player
    this.player.registerModule("playback", this.playbackCtrl);
    this.player.registerModule("quality", this.qualityCtrl);
    this.player.registerModule("audio", this.audioCtrl);
    this.player.registerModule("live", this.liveCtrl);
    this.player.registerModule("error", this.errorCtrl);
    this.player.registerModule("iframe", this.iframeCtrl);
    this.player.registerModule("drm", this.drmCtrl);
    this.player.registerModule("cmcd", this.cmcdCtrl);

    // Setup UI updates
    this._setupPlayerEvents();

    // Load source
    this.player.loadSource(url);

    // Enable controls (including demo button)
    this._enableControls();

    Logger.info("app", "✓ Player created and source loading");
    Logger.info(
      "app",
      "ℹ️  Click 'Run All Demos' to test all features automatically",
    );
  }

  // --------------------------------------------------------------------------
  // Player Event Handlers for UI Updates
  // --------------------------------------------------------------------------
  _setupPlayerEvents() {
    if (!this.player || !this.player.hls) return;

    this.player.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      document.getElementById("loadingOverlay").style.display = "none";

      // Update quality select
      this._updateQualityUI();
      // Update audio/subtitle selects
      this._updateTrackUI();
      // Update stream type
      this._updateLiveUI();

      Logger.info("app", "📋 Manifest parsed - all UI updated");
    });

    // Start monitoring
    this.playbackCtrl?.startBufferMonitoring(3000);
    this.qualityCtrl?.startBandwidthMonitoring(5000);

    if (this.player.state.streamType === "live") {
      this.liveCtrl?.startLatencyMonitoring(2000);
    }

    // Regular status updates
    setInterval(() => {
      this._updatePlaybackUI();
      this._updateQualityInfo();
      this._updateErrorUI();
      this._updateLiveInfoUI();
    }, 2000);
  }

  // --------------------------------------------------------------------------
  // UI Updates
  // --------------------------------------------------------------------------
  _updateQualityUI() {
    if (!this.qualityCtrl) return;
    const levels = this.qualityCtrl.getLevels();
    const select = document.getElementById("qualitySelect");
    select.innerHTML = '<option value="-1">Auto</option>';
    levels.forEach((level) => {
      const option = document.createElement("option");
      option.value = level.index;
      option.text = `${level.height}p @ ${level.bitrateMbps} Mbps`;
      select.appendChild(option);
    });
    Logger.debug("app", `Quality UI updated: ${levels.length} levels`);
  }

  _updateTrackUI() {
    if (!this.audioCtrl) return;
    // Audio tracks
    const audioTracks = this.audioCtrl.getAudioTracks();
    const audioSelect = document.getElementById("audioTrackSelect");
    audioSelect.innerHTML = '<option value="-1">-- Select --</option>';
    audioTracks.forEach((track) => {
      const option = document.createElement("option");
      option.value = track.index;
      option.text = track.name;
      audioSelect.appendChild(option);
    });
    // Subtitle tracks
    const subTracks = this.audioCtrl.getSubtitleTracks();
    const subSelect = document.getElementById("subtitleTrackSelect");
    subSelect.innerHTML = '<option value="-1">Off</option>';
    subTracks.forEach((track) => {
      const option = document.createElement("option");
      option.value = track.index;
      option.text = track.name;
      subSelect.appendChild(option);
    });
    Logger.debug(
      "app",
      `Track UI updated: ${audioTracks.length} audio, ${subTracks.length} subs`,
    );
  }

  _updateLiveUI() {
    if (!this.player) return;
    document.getElementById("streamType").textContent =
      this.player.state.streamType.toUpperCase();
    const isLive = this.player.state.streamType === "live";
    document.getElementById("goLiveBtn").disabled = !isLive;
    document.getElementById("enableLLHLSBtn").disabled = !isLive;
  }

  _updateLiveInfoUI() {
    if (!this.liveCtrl || !this.player) return;
    const liveStatus = this.liveCtrl.getLiveStatus();
    if (liveStatus && liveStatus.isLive) {
      document.getElementById("liveLatency").textContent = liveStatus.latency
        ? `${liveStatus.latency.toFixed(1)}s`
        : "--";
      document.getElementById("targetLatency").textContent =
        liveStatus.targetLatency
          ? `${liveStatus.targetLatency.toFixed(1)}s`
          : "--";
    }
  }

  _updatePlaybackUI() {
    if (!this.player || !this.playbackCtrl) return;
    const status = this.playbackCtrl.getPlaybackStatus();
    if (!status) return;
    document.getElementById("playbackState").textContent = status.playing
      ? "▶ Playing"
      : "⏸ Paused";
    document.getElementById("playbackPosition").textContent = this._formatTime(
      status.currentTime,
    );
    document.getElementById("playbackDuration").textContent = this._formatTime(
      status.duration,
    );
    document.getElementById("bufferPercent").textContent =
      `${status.bufferPercent.toFixed(1)}%`;
  }

  _updateQualityInfo() {
    if (!this.qualityCtrl) return;
    const status = this.qualityCtrl.getQualityStatus();
    if (!status) return;
    document.getElementById("currentQuality").textContent =
      status.currentLevelName;
    document.getElementById("bandwidthEstimate").textContent =
      `${status.bandwidthEstimateMbps} Mbps`;
  }

  _updateErrorUI() {
    if (!this.errorCtrl) return;
    const status = this.errorCtrl.getErrorStatus();
    document.getElementById("totalErrors").textContent = status.totalErrors;
    document.getElementById("fatalErrors").textContent = status.fatalErrors;
    // Update recent errors list
    const errorList = document.getElementById("errorList");
    if (errorList && status.recentErrors.length > 0) {
      errorList.innerHTML = status.recentErrors
        .slice(-5)
        .map(
          (e) => `
              <div class="error-item ${e.fatal ? "fatal" : ""}">
                  <strong>${e.type}</strong>: ${e.details}
                  <br><small>${e.timestamp}</small>
              </div>
          `,
        )
        .join("");
    }
  }

  // --------------------------------------------------------------------------
  // Control Enabling
  // --------------------------------------------------------------------------
  _enableControls() {
    const controls = [
      "destroyBtn",
      "runDemoBtn",
      "playBtn",
      "pauseBtn",
      "seekBackBtn",
      "seekForwardBtn",
      "playbackRateSelect",
      "volumeSlider",
      "muteBtn",
    ];
    controls.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });

    // Enable demo tab buttons
    const demoRunBtn = document.getElementById("demoRunBtn");
    const demoQuickBtn = document.getElementById("demoQuickBtn");
    if (demoRunBtn) demoRunBtn.disabled = false;
    if (demoQuickBtn) demoQuickBtn.disabled = false;

    Logger.debug("app", "Controls enabled (including demo buttons)");
  }

  _disableControls() {
    const controls = [
      "destroyBtn",
      "runDemoBtn",
      "playBtn",
      "pauseBtn",
      "seekBackBtn",
      "seekForwardBtn",
      "playbackRateSelect",
      "volumeSlider",
      "muteBtn",
    ];
    controls.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------
  _formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================
  _destroyPlayer() {
    Logger.info("app", "🗑️ Destroying player...");

    if (this.playbackCtrl) {
      this.playbackCtrl.destroy();
      this.playbackCtrl = null;
    }
    if (this.qualityCtrl) {
      this.qualityCtrl.destroy();
      this.qualityCtrl = null;
    }
    if (this.audioCtrl) {
      this.audioCtrl.destroy();
      this.audioCtrl = null;
    }
    if (this.liveCtrl) {
      this.liveCtrl.destroy();
      this.liveCtrl = null;
    }
    if (this.errorCtrl) {
      this.errorCtrl.destroy();
      this.errorCtrl = null;
    }
    if (this.iframeCtrl) {
      this.iframeCtrl.destroy();
      this.iframeCtrl = null;
    }
    if (this.drmCtrl) {
      this.drmCtrl.destroy();
      this.drmCtrl = null;
    }
    if (this.cmcdCtrl) {
      this.cmcdCtrl.destroy();
      this.cmcdCtrl = null;
    }
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }

    this._disableControls();
    document.getElementById("loadingOverlay").style.display = "none";
    document.getElementById("errorOverlay").style.display = "none";
    document.getElementById("qualitySelect").innerHTML =
      '<option value="-1">Auto</option>';
    document.getElementById("audioTrackSelect").innerHTML =
      '<option value="-1">-- Select --</option>';
    document.getElementById("subtitleTrackSelect").innerHTML =
      '<option value="-1">Off</option>';
    document.getElementById("streamType").textContent = "Unknown";
    document.getElementById("currentQuality").textContent = "--";
    document.getElementById("bandwidthEstimate").textContent = "--";

    Logger.info("app", "✓ Player fully destroyed");
  }
}

// ============================================================================
// Initialize Application
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  Logger.info("system", "🚀 Application starting...");
  Logger.info("system", `📋 Hls available: ${typeof Hls !== "undefined"}`);
  Logger.info(
    "system",
    `📋 HlsPlayer available: ${typeof HlsPlayer !== "undefined"}`,
  );
  Logger.info(
    "system",
    `📋 DemoRunner available: ${typeof DemoRunner !== "undefined"}`,
  );
  Logger.info(
    "system",
    `📋 runAllDemos available: ${typeof runAllDemos !== "undefined"}`,
  );

  window.app = new PlayerApp();

  Logger.info("system", "✓ Application ready");
  Logger.info(
    "system",
    "ℹ️  Load a stream, then click 'Run All Demos' to test all features",
  );
  Logger.info(
    "system",
    "ℹ️  Or open with ?autorun=true to auto-load and auto-demo",
  );
});

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  Logger.info("system", "Page unloading - cleaning up...");
  if (window.app) {
    window.app._destroyPlayer();
  }
});
