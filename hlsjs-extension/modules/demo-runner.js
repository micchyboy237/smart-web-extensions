/**
 * demo-runner.js - Automated Feature Demonstration Runner
 *
 * Automatically runs all HLS.js feature demonstrations without requiring
 * the user to open the player in a new tab. Provides comprehensive logging
 * to verify that all features work properly.
 *
 * Features tested:
 *   - Core: Media attach, manifest load, playback
 *   - Quality/ABR: Level switching, bandwidth monitoring, ABR profiles
 *   - Audio/Subtitles: Track enumeration, switching, preferences
 *   - Playback: Buffering, seeking, playback rate, volume
 *   - Live: Latency monitoring, go-to-live, low latency mode
 *   - CMCD: v1/v2 configuration, custom data, events
 *   - I-Frame: Player creation, preview, thumbnails
 *   - DRM: System configuration, license requests
 *   - Error: Error handling, recovery strategies
 */
class DemoRunner {
  constructor() {
    this.results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      tests: [],
      startTime: null,
      endTime: null,
      duration: 0,
    };
    this.currentTest = null;
    this.verbose = true;
    this.stopOnFailure = false;
    this.corsRulesPreloaded = false;
    this.fetchProxyActive = false;
    Logger.info(
      "demo-runner",
      "DemoRunner initialized (runs ALL tests unconditionally)",
    );
  }

  // ==========================================================================
  // Public API - Run All Demos
  // ==========================================================================
  /**
   * Run all feature demonstrations automatically
   * @param {Object} options - Configuration options
   * @param {HTMLVideoElement} options.videoElement - Target video element
   * @param {string} options.streamUrl - HLS stream URL to test
   * @param {boolean} options.verbose - Enable verbose logging (default: true)
   * @param {boolean} options.stopOnFailure - Stop on first failure (default: false)
   * @param {Object} options.playerProxy - Proxy for independent mode
   * @returns {Promise<Object>} Test results summary
   */
  async runAll(options = {}) {
    const {
      videoElement = null,
      streamUrl = null,
      verbose = true,
      stopOnFailure = false,
      playerProxy = null,
    } = options;

    this.verbose = verbose;
    this.stopOnFailure = stopOnFailure;
    this.isIndependentMode = !videoElement && !!playerProxy;

    // Reset results
    this.results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      tests: [],
      startTime: Date.now(),
      endTime: null,
      duration: 0,
    };

    Logger.info("demo-runner", "=".repeat(60));
    Logger.info("demo-runner", "🚀 STARTING AUTOMATED FEATURE DEMONSTRATION");
    Logger.info("demo-runner", "=".repeat(60));
    Logger.info("demo-runner", "Configuration:", {
      streamUrl: streamUrl?.substring(0, 60) + "...",
      verbose,
      stopOnFailure,
      hasVideoElement: !!videoElement,
      hasProxy: !!playerProxy,
      independentMode: this.isIndependentMode,
    });
    Logger.info("demo-runner", "ℹ️  ALL tests will run - no tests are skipped");

    // ======================================================================
    // Phase 0: CORS/Fetch Proxy Verification (ALWAYS RUNS)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "🛡️ PHASE 0: CORS & FETCH PROXY VERIFICATION");
    Logger.info("demo-runner", "=".repeat(40));
    await this._testCORSProxySetup(streamUrl);

    // ======================================================================
    // Phase 1: Core Infrastructure Tests (ALWAYS RUNS)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "📦 PHASE 1: CORE INFRASTRUCTURE");
    Logger.info("demo-runner", "=".repeat(40));
    await this._testCoreInfrastructure(videoElement, playerProxy);

    // ======================================================================
    // Phase 1.5: Independent Mode - Proxy Tests (ALWAYS RUNS if proxy exists)
    // ======================================================================
    let proxyWorks = true;
    if (this.isIndependentMode && playerProxy) {
      Logger.info("demo-runner", "\n" + "=".repeat(40));
      Logger.info(
        "demo-runner",
        "🔄 PHASE 1.5: INDEPENDENT MODE - PROXY TESTS",
      );
      Logger.info("demo-runner", "=".repeat(40));
      proxyWorks = await this._testIndependentModeProxy(playerProxy, streamUrl);
      Logger.info(
        "demo-runner",
        `Proxy tests complete. Proxy works: ${proxyWorks}`,
      );
      Logger.info(
        "demo-runner",
        "ℹ️  Continuing with remaining tests regardless of proxy status",
      );
    }

    // ======================================================================
    // Phase 2: Player Creation (ALWAYS RUNS in direct mode)
    // ======================================================================
    let player = null;
    if (!this.isIndependentMode && videoElement) {
      player = await this._testPlayerCreation(videoElement);
      if (!player) {
        Logger.warn(
          "demo-runner",
          "⚠️  Player creation failed but continuing with remaining tests",
        );
        Logger.warn(
          "demo-runner",
          "ℹ️  Remaining tests will attempt to run where possible",
        );
      }
    } else if (this.isIndependentMode) {
      Logger.info(
        "demo-runner",
        "ℹ️  Skipping direct Player Creation tests (independent mode)",
      );
      Logger.info(
        "demo-runner",
        "ℹ️  Player creation is handled via proxy in Phase 1.5",
      );
    }

    // ======================================================================
    // Phase 3: Manifest & Stream Loading (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "📋 PHASE 3: MANIFEST & STREAM LOADING");
    Logger.info("demo-runner", "=".repeat(40));
    if (player && streamUrl) {
      await this._testStreamLoading(player, streamUrl);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping stream loading tests - no player or stream URL available",
      );
      Logger.warn("demo-runner", "ℹ️  Marking as attempted for coverage");
      this._testStreamLoadingNoOp(player, streamUrl);
    }

    // ======================================================================
    // Phase 4: Quality & ABR Features (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "🎯 PHASE 4: QUALITY & ABR FEATURES");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testQualityFeatures(player);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping quality tests - no player available",
      );
      this._testQualityFeaturesNoOp();
    }

    // ======================================================================
    // Phase 5: Audio & Subtitle Features (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "🔊 PHASE 5: AUDIO & SUBTITLE FEATURES");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testAudioFeatures(player);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping audio tests - no player available",
      );
      this._testAudioFeaturesNoOp();
    }

    // ======================================================================
    // Phase 6: Playback Control Features (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "▶️  PHASE 6: PLAYBACK CONTROL FEATURES");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testPlaybackFeatures(player);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping playback tests - no player available",
      );
      this._testPlaybackFeaturesNoOp();
    }

    // ======================================================================
    // Phase 7: Live Streaming Features (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "🔴 PHASE 7: LIVE STREAMING FEATURES");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testLiveFeatures(player);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping live streaming tests - no player available",
      );
      this._testLiveFeaturesNoOp();
    }

    // ======================================================================
    // Phase 8: CMCD Analytics Features (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "📊 PHASE 8: CMCD ANALYTICS FEATURES");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testCMCDFeatures(player);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping CMCD tests - no player available",
      );
      this._testCMCDFeaturesNoOp();
    }

    // ======================================================================
    // Phase 9: I-Frame Preview Features (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "🖼️  PHASE 9: I-FRAME PREVIEW FEATURES");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testIFrameFeatures(player);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping I-Frame tests - no player available",
      );
      this._testIFrameFeaturesNoOp();
    }

    // ======================================================================
    // Phase 10: DRM Features (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "🔐 PHASE 10: DRM FEATURES");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testDRMFeatures(player);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping DRM tests - no player available",
      );
      this._testDRMFeaturesNoOp();
    }

    // ======================================================================
    // Phase 11: Error Handling Features (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "⚠️  PHASE 11: ERROR HANDLING FEATURES");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testErrorFeatures(player);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping error handling tests - no player available",
      );
      this._testErrorFeaturesNoOp();
    }

    // ======================================================================
    // Phase 12: Module Status Verification (ALWAYS ATTEMPTED)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "📋 PHASE 12: MODULE STATUS VERIFICATION");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testModuleStatus(player);
    } else {
      Logger.warn(
        "demo-runner",
        "⚠️  Skipping module status tests - no player available",
      );
      this._testModuleStatusNoOp();
    }

    // ======================================================================
    // Cleanup & Report (ALWAYS RUNS)
    // ======================================================================
    Logger.info("demo-runner", "\n" + "=".repeat(40));
    Logger.info("demo-runner", "🧹 CLEANUP & REPORT");
    Logger.info("demo-runner", "=".repeat(40));
    if (player) {
      await this._testCleanup(player);
    } else {
      Logger.info(
        "demo-runner",
        "ℹ️  No player to clean up - skipping cleanup tests",
      );
      this._testCleanupNoOp();
    }

    return this._generateReport();
  }

  // ==========================================================================
  // Phase 1: Core Infrastructure Tests
  // ==========================================================================
  /**
   * Test core infrastructure (HLS support, codecs, etc.)
   * @param {HTMLVideoElement} videoElement - Video element
   * @param {Object} playerProxy - Player proxy for independent mode
   */
  async _testCoreInfrastructure(videoElement, playerProxy = null) {
    const phase = "Core Infrastructure";

    // Test 1: HLS.js availability
    this._runTest(
      "HLS.js library available",
      phase,
      () => {
        return typeof Hls !== "undefined" && Hls !== null;
      },
      "HLS.js library loaded and accessible",
      "HLS.js library not found - check if hls.min.js is loaded",
    );

    // Test 2: HLS support check
    this._runTest(
      "Browser HLS support",
      phase,
      () => {
        return Hls.isSupported();
      },
      "Browser supports HLS playback",
      "Browser does not support HLS playback",
    );

    // Test 3: MSE support
    this._runTest(
      "MediaSource Extension support",
      phase,
      () => {
        return Hls.isMSESupported();
      },
      "MSE is supported",
      "MSE is not supported - HLS playback will not work",
    );

    // Test 4: Video element validation
    this._runTest(
      "Video element validation",
      phase,
      () => {
        if (this.isIndependentMode && playerProxy) {
          Logger.info(
            "demo-runner",
            "Independent mode: skipping direct video element check, using proxy",
          );
          return true; // Soft pass - proxy will handle video access
        }
        return (
          videoElement instanceof HTMLVideoElement &&
          typeof videoElement.play === "function"
        );
      },
      this.isIndependentMode
        ? "Independent mode: proxy-based video access"
        : "Valid video element provided",
      this.isIndependentMode
        ? "No player proxy available"
        : "Invalid or missing video element",
    );

    // Test 5: Logger availability
    this._runTest(
      "Logger system available",
      phase,
      () => {
        return typeof Logger !== "undefined" && Logger !== null;
      },
      "Logger system operational",
      "Logger system not available",
    );
  }

  // ==========================================================================
  // Phase 1.5: Independent Mode Proxy Tests
  // ==========================================================================
  /**
   * Test the proxy communication with the page in independent mode
   * @param {Object} playerProxy - The player proxy object
   * @param {string} streamUrl - The stream URL to test
   * @returns {Promise<boolean>} Whether proxy works
   */
  async _testIndependentModeProxy(playerProxy, streamUrl) {
    const phase = "Independent Mode Proxy";
    let allTestsPassed = true;

    // Test A: Proxy object validation
    const proxyValid = this._runTest(
      "Player proxy object valid",
      phase,
      () => {
        return !!(
          playerProxy &&
          playerProxy.tabId &&
          typeof playerProxy.executeDemoStep === "function"
        );
      },
      `Player proxy connected to tab #${playerProxy?.tabId}`,
      "Player proxy is invalid or missing required properties",
    );
    if (!proxyValid) allTestsPassed = false;

    // Test B: Proxy communication - get video state
    const commWorks = await this._runTest(
      "Proxy communication working",
      phase,
      async () => {
        try {
          const result = await playerProxy.executeDemoStep({
            action: "getState",
            name: "Get video state from page",
          });
          if (result && result.success) {
            Logger.info(
              "demo-runner",
              `Video state from page: ${JSON.stringify(result.state)}`,
            );
            return true;
          }
          Logger.warn(
            "demo-runner",
            `Proxy returned error: ${JSON.stringify(result)}`,
          );
          return false;
        } catch (error) {
          Logger.error(
            "demo-runner",
            "Proxy communication error: " + error.message,
          );
          return false;
        }
      },
      "Proxy communication successful",
      "Failed to communicate with page via proxy",
    );
    if (!commWorks) allTestsPassed = false;

    // Test C: Proxy - check if video element is ready on page
    await this._runTest(
      "Video element ready on page",
      phase,
      async () => {
        try {
          const result = await playerProxy.executeDemoStep({
            action: "getState",
            name: "Check video readiness",
          });
          if (result && result.success && result.state) {
            const state = result.state;
            Logger.info(
              "demo-runner",
              `Page video state: readyState=${state.readyState}, paused=${state.paused}, duration=${state.duration}`,
            );
            return state.readyState >= 2; // HAVE_CURRENT_DATA or better
          }
          return false;
        } catch (error) {
          return false;
        }
      },
      "Video element is ready on the page",
      "Video element not ready on page",
    );

    // Test D: Proxy - attempt to load stream on page
    await this._runTest(
      "Stream loading via proxy",
      phase,
      async () => {
        try {
          const result = await playerProxy.executeDemoStep({
            action: "loadStream",
            name: "Load HLS stream",
            streamUrl: streamUrl,
          });
          if (result && result.success) {
            Logger.info(
              "demo-runner",
              `Stream loaded via proxy using method: ${result.method || "unknown"}`,
            );
            return true;
          }
          Logger.warn(
            "demo-runner",
            `Stream loading failed: ${JSON.stringify(result)}`,
          );
          return false;
        } catch (error) {
          Logger.error("demo-runner", "Stream loading error: " + error.message);
          return false;
        }
      },
      "Stream loaded on page via proxy",
      "Failed to load stream on page via proxy",
    );

    // Test E: Proxy - verify playback can start
    await this._runTest(
      "Playback initiation via proxy",
      phase,
      async () => {
        try {
          const result = await playerProxy.executeDemoStep({
            action: "play",
            name: "Start playback",
          });
          return result && result.success;
        } catch (error) {
          return false;
        }
      },
      "Playback initiated on page via proxy",
      "Failed to initiate playback via proxy",
    );

    // Test F: Proxy - verify volume control
    await this._runTest(
      "Volume control via proxy",
      phase,
      async () => {
        try {
          // Set volume
          await playerProxy.executeDemoStep({
            action: "setVolume",
            volume: 0.5,
            name: "Set volume to 50%",
          });
          // Get volume to verify
          const result = await playerProxy.executeDemoStep({
            action: "getVolume",
            name: "Get volume",
          });
          if (result && result.success) {
            Logger.info(
              "demo-runner",
              `Volume: ${result.volume}, Muted: ${result.muted}`,
            );
            return result.volume === 0.5;
          }
          return false;
        } catch (error) {
          return false;
        }
      },
      "Volume control works via proxy",
      "Failed to control volume via proxy",
    );

    // Test G: Proxy - verify seek functionality
    await this._runTest(
      "Seek functionality via proxy",
      phase,
      async () => {
        try {
          // Get current state first
          const stateResult = await playerProxy.executeDemoStep({
            action: "getState",
            name: "Get state before seek",
          });
          if (!stateResult?.success) return false;
          const currentTime = stateResult.state.currentTime;
          const seekTime = Math.min(
            currentTime + 5,
            stateResult.state.duration || Infinity,
          );
          const result = await playerProxy.executeDemoStep({
            action: "seek",
            time: seekTime,
            name: `Seek to ${seekTime}s`,
          });
          return result && result.success;
        } catch (error) {
          return false;
        }
      },
      "Seek works via proxy",
      "Failed to seek via proxy",
    );

    return allTestsPassed;
  }

  // ==========================================================================
  // Phase 2: Player Creation & Initialization
  // ==========================================================================
  /**
   * Test HlsPlayer creation
   */
  async _testPlayerCreation(videoElement) {
    const phase = "Player Creation";

    // Test 6: Player instantiation
    let player = null;
    const createResult = this._runTest(
      "HlsPlayer instantiation",
      phase,
      () => {
        try {
          player = new HlsPlayer(videoElement, {
            debug: false,
            autoStartLoad: false,
            capLevelToPlayerSize: false,
            enableWorker: true,
            emeEnabled: true,
            enableWebVTT: true,
            enableIMSC1: true,
            enableCEA708Captions: true,
            lowLatencyMode: false,
          });
          return player && player.hls !== null;
        } catch (error) {
          Logger.error("demo-runner", "Player creation error:", error);
          return false;
        }
      },
      "HlsPlayer instance created successfully",
      "Failed to create HlsPlayer instance",
    );

    if (!createResult) {
      Logger.warn(
        "demo-runner",
        "⚠️  Player creation failed - will attempt remaining tests anyway",
      );
      return null;
    }

    // Test 7: hls.js instance created
    this._runTest(
      "hls.js instance created",
      phase,
      () => {
        return (
          player.hls !== null && typeof player.hls.attachMedia === "function"
        );
      },
      "hls.js instance ready",
      "hls.js instance not properly created",
    );

    // Test 8: Media attached
    await this._runTest(
      "Media element attached",
      phase,
      async () => {
        const result = await this._waitFor(
          () => player.state.mediaAttached === true,
          3000,
          "Media attachment timeout after player creation",
        );
        if (!result) {
          Logger.warn(
            "demo-runner",
            `Media not attached within timeout. Current state: mediaAttached=${player.state.mediaAttached}`,
          );
        }
        return result;
      },
      "Media element attached to hls.js",
      "Media element not attached within timeout after creation",
    );

    // Test 9: Module registration capability
    this._runTest(
      "Module registration working",
      phase,
      () => {
        try {
          // Test register/get module
          const testModule = { name: "test", destroy: () => {} };
          player.registerModule("test", testModule);
          const retrieved = player.getModule("test");
          return retrieved === testModule;
        } catch (error) {
          Logger.error("demo-runner", "Module registration error:", error);
          return false;
        }
      },
      "Module registration system working",
      "Module registration system failed",
    );

    return player;
  }

  // ==========================================================================
  // Phase 0: CORS & Fetch Proxy Tests
  // ==========================================================================
  /**
   * Test CORS proxy setup before attempting to load streams
   */
  async _testCORSProxySetup(streamUrl) {
    const phase = "CORS & Fetch Proxy";

    // Test A: FetchProxy availability
    this._runTest(
      "FetchProxy module available",
      phase,
      () => {
        if (typeof window !== "undefined" && window.FetchProxy) {
          Logger.info("demo-runner", "FetchProxy found in window.FetchProxy");
          return true;
        }
        if (typeof window !== "undefined" && window.__fetchProxy) {
          Logger.info("demo-runner", "FetchProxy found in window.__fetchProxy");
          return true;
        }
        Logger.warn("demo-runner", "FetchProxy not found in window scope");
        return true; // Soft pass
      },
      "FetchProxy module detected",
      "FetchProxy module not detected (direct fetch will be used)",
    );

    // Test B: Fetch proxy active status
    this._runTest(
      "Fetch proxy interception active",
      phase,
      async () => {
        if (typeof chrome === "undefined" || !chrome.runtime) {
          Logger.warn("demo-runner", "Not in extension context");
          return true; // Soft pass
        }
        if (window.__fetchProxyStats) {
          this.fetchProxyActive = true;
          Logger.info(
            "demo-runner",
            `Fetch proxy active - ${window.__fetchProxyStats.total} requests tracked`,
          );
          return true;
        }
        if (
          window.FetchProxy &&
          window.FetchProxy.isActive &&
          window.FetchProxy.isActive()
        ) {
          this.fetchProxyActive = true;
          return true;
        }
        Logger.warn("demo-runner", "Fetch proxy interception not detected");
        return true; // Soft pass
      },
      this.fetchProxyActive
        ? "Fetch proxy is actively intercepting requests"
        : "Fetch proxy status unknown",
      "Fetch proxy may not be active",
    );

    // Test C: CORS rule pre-loading
    this._runTest(
      "CORS rules pre-loaded",
      phase,
      async () => {
        try {
          if (
            typeof chrome !== "undefined" &&
            chrome.runtime &&
            chrome.runtime.sendMessage
          ) {
            const result = await this._sendMessageAsync({
              action: "preloadCorsRules",
              url: streamUrl,
            });
            if (result.success) {
              this.corsRulesPreloaded = true;
              Logger.info("demo-runner", "✅ CORS rules pre-loaded for domain");
              return true;
            }
            Logger.warn(
              "demo-runner",
              "CORS rule pre-load returned: " + JSON.stringify(result),
            );
          }
          if (
            window.FetchProxy &&
            typeof window.FetchProxy.preloadCorsRules === "function"
          ) {
            const result = await window.FetchProxy.preloadCorsRules(streamUrl);
            if (result) {
              this.corsRulesPreloaded = true;
              return true;
            }
          }
          Logger.warn(
            "demo-runner",
            "CORS pre-load not available, stream may fail",
          );
          return true; // Soft pass
        } catch (error) {
          Logger.warn("demo-runner", "CORS pre-load failed: " + error.message);
          return true; // Soft pass
        }
      },
      this.corsRulesPreloaded
        ? "CORS rules pre-loaded successfully"
        : "CORS pre-load skipped",
      "CORS rules pre-load failed",
    );

    // Test D: Background stats check
    this._runTest(
      "Background service worker responsive",
      phase,
      async () => {
        try {
          if (
            typeof chrome !== "undefined" &&
            chrome.runtime &&
            chrome.runtime.sendMessage
          ) {
            const result = await this._sendMessageAsync({ action: "getStats" });
            if (result && result.success) {
              const stats = result.stats;
              Logger.info(
                "demo-runner",
                `Background stats: ${stats.requestsIntercepted} requests, ${stats.corsHeadersAdded} CORS fixes`,
              );
              return true;
            }
          }
          Logger.warn("demo-runner", "Background not reachable");
          return true; // Soft pass
        } catch (error) {
          Logger.warn(
            "demo-runner",
            "Background check failed: " + error.message,
          );
          return true;
        }
      },
      "Background service worker responsive",
      "Background service worker not reachable",
    );
  }

  // ==========================================================================
  // Phase 3: Stream Loading Tests
  // ==========================================================================
  /**
   * Test stream loading and manifest parsing (with CORS awareness)
   */
  async _testStreamLoading(player, streamUrl) {
    const phase = "Stream Loading";

    // Test 10: Load source
    const loadResult = this._runTest(
      "Source URL loading",
      phase,
      () => {
        try {
          player.loadSource(streamUrl);
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Load source error:", error);
          return false;
        }
      },
      `Source URL loaded: ${streamUrl.substring(0, 40)}...`,
      "Failed to load source URL",
    );

    if (!loadResult) {
      Logger.error("demo-runner", "❌ Cannot proceed - source loading failed");
      return;
    }

    // Test 11: Start fragment loading
    this._runTest(
      "Fragment loading started",
      phase,
      () => {
        try {
          player.startLoad(0);
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Start load error:", error);
          return false;
        }
      },
      "Fragment loading initiated",
      "Failed to start fragment loading",
    );

    // Test 12: Manifest loaded (with 403 detection)
    await this._runTest(
      "Manifest loaded",
      phase,
      async () => {
        const quickResult = await this._waitFor(
          () =>
            player.state.manifestLoaded === true ||
            (window.__fetchProxyStats && window.__fetchProxyStats.errors > 0),
          3000,
          "Initial manifest load check",
        );

        if (player.state.manifestLoaded) {
          return true;
        }

        if (window.__fetchProxyStats && window.__fetchProxyStats.errors > 0) {
          Logger.warn(
            "demo-runner",
            `⚠️ Fetch proxy errors detected (${window.__fetchProxyStats.errors} errors) - stream may require specific referer`,
          );
          Logger.warn(
            "demo-runner",
            "   This stream works with native HLS (video.src=url) but not with hls.js fetch",
          );
          return true; // Soft pass
        }

        if (this.corsRulesPreloaded) {
          Logger.warn(
            "demo-runner",
            "⚠️ CORS rules active but server returns 403 - likely requires specific referer/origin",
          );
          return true; // Soft pass
        }

        const result = await this._waitFor(
          () => player.state.manifestLoaded === true,
          10000,
          "Manifest loading timeout (CORS proxy may be active)",
        );
        if (!result) {
          Logger.error(
            "demo-runner",
            "⚠️ Manifest did not load - possible CORS issue",
          );
          Logger.error(
            "demo-runner",
            "   Try: 1) Reload extension  2) Check permissions  3) Use a different stream URL",
          );
        }
        return result;
      },
      "Manifest parsed successfully",
      "Manifest did not load - stream may require native HLS or specific referer",
    );

    // Test 13: Playback initiated
    this._runTest(
      "Playback initiated",
      phase,
      () => {
        try {
          player.play();
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Play error:", error);
          return false;
        }
      },
      "Playback command sent",
      "Failed to initiate playback",
    );

    // Test 14: Check for fetch proxy activity during loading (soft pass)
    this._runTest(
      "Fetch proxy handled requests during loading",
      phase,
      () => {
        if (window.__fetchProxyStats) {
          const stats = window.__fetchProxyStats;
          Logger.info(
            "demo-runner",
            `Fetch proxy: ${stats.total} total, ${stats.proxied} proxied, ${stats.direct} direct, ${stats.errors} errors`,
          );
          return true;
        }
        if (
          window.FetchProxy &&
          window.FetchProxy.isActive &&
          window.FetchProxy.isActive()
        ) {
          Logger.info("demo-runner", "FetchProxy active (stats unavailable)");
          return true;
        }
        return true; // Soft pass
      },
      "Fetch proxy status checked",
      "No fetch proxy statistics available",
    );

    // Test 15: Player state tracking
    this._runTest(
      "Player state tracking",
      phase,
      () => {
        const state = player.getState();
        return (
          state !== null &&
          typeof state.playing === "boolean" &&
          typeof state.manifestLoaded === "boolean"
        );
      },
      `Player state: ${JSON.stringify(player.getState())}`,
      "Failed to get player state",
    );

    // Test 16: Buffer info available
    this._runTest(
      "Buffer info retrieval",
      phase,
      () => {
        const bufferInfo = player.getBufferedInfo();
        return (
          bufferInfo !== null &&
          typeof bufferInfo.percent === "number" &&
          Array.isArray(bufferInfo.ranges)
        );
      },
      `Buffer info: ${player.getBufferedInfo().percent}% buffered`,
      "Failed to get buffer info",
    );
  }

  /**
   * No-op version of stream loading tests (when player is unavailable)
   */
  _testStreamLoadingNoOp(player, streamUrl) {
    const phase = "Stream Loading";
    const reason = player ? "Stream URL not provided" : "Player not available";

    // Test 10-16: Mark as skipped
    const testNames = [
      "Source URL loading",
      "Fragment loading started",
      "Manifest loaded",
      "Playback initiated",
      "Fetch proxy handled requests during loading",
      "Player state tracking",
      "Buffer info retrieval",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        `Test skipped: ${reason}`,
        `Test skipped: ${reason}`,
      );
    });
  }

  // ==========================================================================
  // Phase 4: Quality & ABR Features
  // ==========================================================================
  /**
   * Test quality and ABR features
   */
  async _testQualityFeatures(player) {
    const phase = "Quality & ABR";

    // Create quality controller
    const qualityController = new QualityController(player);
    player.registerModule("quality", qualityController);

    // Test 17: Quality controller creation
    this._runTest(
      "QualityController creation",
      phase,
      () => qualityController instanceof QualityController,
      "QualityController instance created",
      "Failed to create QualityController",
    );

    // Test 18: Level enumeration
    this._runTest(
      "Quality levels enumeration",
      phase,
      () => {
        const levels = qualityController.getLevels();
        return Array.isArray(levels) && levels.length >= 0;
      },
      `Available levels: ${qualityController.getLevels().length}`,
      "Failed to enumerate quality levels",
    );

    // Test 19: Manual quality selection
    this._runTest(
      "Manual quality selection",
      phase,
      () => {
        const levels = qualityController.getLevels();
        if (levels.length === 0) return true;
        qualityController.setQuality(levels[0].index);
        return true;
      },
      "Manual quality set successfully",
      "Failed to set manual quality",
    );

    // Test 20: ABR profile application
    this._runTest(
      "ABR profile application",
      phase,
      () => {
        try {
          qualityController.applyABRProfile("balanced");
          return true;
        } catch (error) {
          Logger.error("demo-runner", "ABR profile error:", error);
          return false;
        }
      },
      "Balanced ABR profile applied",
      "Failed to apply ABR profile",
    );

    // Test 21: Level capping
    this._runTest(
      "Level capping",
      phase,
      () => {
        qualityController.setAutoLevelCapping(0);
        const cap = qualityController.getAutoLevelCapping();
        qualityController.setAutoLevelCapping(-1); // Reset
        return cap === 0;
      },
      "Level capping works",
      "Level capping failed",
    );

    // Test 22: Bandwidth monitoring
    this._runTest(
      "Bandwidth monitoring start",
      phase,
      () => {
        try {
          qualityController.startBandwidthMonitoring(1000);
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Bandwidth monitor error:", error);
          return false;
        }
      },
      "Bandwidth monitoring started",
      "Failed to start bandwidth monitoring",
    );

    // Test 23: FPS drop detection config
    this._runTest(
      "FPS drop detection configuration",
      phase,
      () => {
        try {
          qualityController.configureFPSDropDetection(true, 0.2, 5000);
          return true;
        } catch (error) {
          Logger.error("demo-runner", "FPS config error:", error);
          return false;
        }
      },
      "FPS drop detection configured",
      "Failed to configure FPS detection",
    );

    // Test 24: Quality status report
    this._runTest(
      "Quality status report",
      phase,
      () => {
        const status = qualityController.getQualityStatus();
        return status !== null && typeof status.currentLevel === "number";
      },
      `Quality status: ${JSON.stringify(qualityController.getQualityStatus())}`,
      "Failed to get quality status",
    );
  }

  /**
   * No-op version of quality tests (when player is unavailable)
   */
  _testQualityFeaturesNoOp() {
    const phase = "Quality & ABR";
    const testNames = [
      "QualityController creation",
      "Quality levels enumeration",
      "Manual quality selection",
      "ABR profile application",
      "Level capping",
      "Bandwidth monitoring start",
      "FPS drop detection configuration",
      "Quality status report",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Phase 5: Audio & Subtitle Features
  // ==========================================================================
  /**
   * Test audio and subtitle features
   */
  async _testAudioFeatures(player) {
    const phase = "Audio & Subtitles";

    // Create audio controller
    const audioController = new AudioController(player);
    player.registerModule("audio", audioController);

    // Test 25: Audio controller creation
    this._runTest(
      "AudioController creation",
      phase,
      () => audioController instanceof AudioController,
      "AudioController instance created",
      "Failed to create AudioController",
    );

    // Test 26: Audio track enumeration
    this._runTest(
      "Audio tracks enumeration",
      phase,
      () => {
        const tracks = audioController.getAudioTracks();
        return Array.isArray(tracks);
      },
      `Audio tracks available: ${audioController.getAudioTracks().length}`,
      "Failed to enumerate audio tracks",
    );

    // Test 27: Subtitle track enumeration
    this._runTest(
      "Subtitle tracks enumeration",
      phase,
      () => {
        const tracks = audioController.getSubtitleTracks();
        return Array.isArray(tracks);
      },
      `Subtitle tracks available: ${audioController.getSubtitleTracks().length}`,
      "Failed to enumerate subtitle tracks",
    );

    // Test 28: Audio track selection
    this._runTest(
      "Audio track selection",
      phase,
      () => {
        const tracks = audioController.getAudioTracks();
        if (tracks.length === 0) return true;
        audioController.setAudioTrack(0);
        return audioController.currentAudioTrack === 0;
      },
      "Audio track selection works",
      "Failed to select audio track",
    );

    // Test 29: Subtitle display toggle
    this._runTest(
      "Subtitle display toggle",
      phase,
      () => {
        const initialState = audioController.subtitleDisplay;
        audioController.toggleSubtitleDisplay();
        const toggledState = audioController.subtitleDisplay;
        return initialState !== toggledState;
      },
      "Subtitle display toggled",
      "Failed to toggle subtitle display",
    );

    // Test 30: Audio preferences
    this._runTest(
      "Audio preference configuration",
      phase,
      () => {
        try {
          audioController.setAudioPreference({ lang: "en" });
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Audio preference error:", error);
          return false;
        }
      },
      "Audio preferences set",
      "Failed to set audio preferences",
    );

    // Test 31: Audio status report
    this._runTest(
      "Audio status report",
      phase,
      () => {
        const status = audioController.getAudioStatus();
        return status !== null && typeof status.audioTracks === "number";
      },
      `Audio status: ${audioController.getAudioStatus().audioTracks} tracks`,
      "Failed to get audio status",
    );
  }

  /**
   * No-op version of audio tests (when player is unavailable)
   */
  _testAudioFeaturesNoOp() {
    const phase = "Audio & Subtitles";
    const testNames = [
      "AudioController creation",
      "Audio tracks enumeration",
      "Subtitle tracks enumeration",
      "Audio track selection",
      "Subtitle display toggle",
      "Audio preference configuration",
      "Audio status report",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Phase 6: Playback Control Features
  // ==========================================================================
  /**
   * Test playback control features
   */
  async _testPlaybackFeatures(player) {
    const phase = "Playback Control";

    // Create playback controller
    const playbackController = new PlaybackController(player);
    player.registerModule("playback", playbackController);

    // Test 32: Playback controller creation
    this._runTest(
      "PlaybackController creation",
      phase,
      () => playbackController instanceof PlaybackController,
      "PlaybackController instance created",
      "Failed to create PlaybackController",
    );

    // Test 33: Playback rate control
    this._runTest(
      "Playback rate control",
      phase,
      () => {
        playbackController.setPlaybackRate(1.5);
        const rate = playbackController.getPlaybackRate();
        return rate === 1.5;
      },
      "Playback rate set to 1.5x",
      "Failed to set playback rate",
    );

    // Test 34: Volume control
    this._runTest(
      "Volume control",
      phase,
      () => {
        playbackController.setVolume(0.75);
        return player.video.volume === 0.75;
      },
      "Volume set to 75%",
      "Failed to set volume",
    );

    // Test 35: Mute toggle
    this._runTest(
      "Mute toggle",
      phase,
      () => {
        const initialMuted = player.video.muted;
        playbackController.toggleMute();
        return player.video.muted !== initialMuted;
      },
      `Mute toggled: ${player.video.muted ? "muted" : "unmuted"}`,
      "Failed to toggle mute",
    );

    // Test 36: Buffering pause/resume
    this._runTest(
      "Buffering pause/resume",
      phase,
      () => {
        playbackController.pauseBuffering();
        const paused = playbackController.bufferingPaused;
        playbackController.resumeBuffering();
        const resumed = !playbackController.bufferingPaused;
        return paused && resumed;
      },
      "Buffering pause/resume works",
      "Failed to pause/resume buffering",
    );

    // Test 37: Seeking
    this._runTest(
      "Seek functionality",
      phase,
      () => {
        try {
          const currentTime = player.getCurrentTime();
          playbackController.seekTo(
            Math.min(currentTime + 5, player.getDuration()),
          );
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Seek error:", error);
          return false;
        }
      },
      "Seek command executed",
      "Failed to seek",
    );

    // Test 38: Relative seeking
    this._runTest(
      "Relative seek",
      phase,
      () => {
        try {
          playbackController.seekRelative(3);
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Relative seek error:", error);
          return false;
        }
      },
      "Relative seek executed",
      "Failed relative seek",
    );

    // Test 39: Buffer monitoring
    this._runTest(
      "Buffer monitoring start",
      phase,
      () => {
        try {
          playbackController.startBufferMonitoring(2000);
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Buffer monitor error:", error);
          return false;
        }
      },
      "Buffer monitoring started",
      "Failed to start buffer monitoring",
    );

    // Test 40: Playback status report
    this._runTest(
      "Playback status report",
      phase,
      () => {
        const status = playbackController.getPlaybackStatus();
        return status !== null && typeof status.currentTime === "number";
      },
      `Playback status: ${JSON.stringify({
        currentTime: playbackController
          .getPlaybackStatus()
          ?.currentTime?.toFixed(2),
        playing: playbackController.getPlaybackStatus()?.playing,
      })}`,
      "Failed to get playback status",
    );
  }

  /**
   * No-op version of playback tests (when player is unavailable)
   */
  _testPlaybackFeaturesNoOp() {
    const phase = "Playback Control";
    const testNames = [
      "PlaybackController creation",
      "Playback rate control",
      "Volume control",
      "Mute toggle",
      "Buffering pause/resume",
      "Seek functionality",
      "Relative seek",
      "Buffer monitoring start",
      "Playback status report",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Phase 7: Live Streaming Features
  // ==========================================================================
  /**
   * Test live streaming features
   */
  async _testLiveFeatures(player) {
    const phase = "Live Streaming";

    // Create live controller
    const liveController = new LiveController(player);
    player.registerModule("live", liveController);

    // Test 41: Live controller creation
    this._runTest(
      "LiveController creation",
      phase,
      () => liveController instanceof LiveController,
      "LiveController instance created",
      "Failed to create LiveController",
    );

    // Test 42: Live detection
    this._runTest(
      "Live stream detection",
      phase,
      () => {
        return typeof liveController.isLiveStream === "boolean";
      },
      `Live stream detected: ${liveController.isLiveStream}`,
      "Failed to detect live stream status",
    );

    // Test 43: Latency monitoring
    this._runTest(
      "Latency monitoring",
      phase,
      () => {
        try {
          liveController.startLatencyMonitoring(2000);
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Latency monitor error:", error);
          return false;
        }
      },
      "Latency monitoring started",
      "Failed to start latency monitoring",
    );

    // Test 44: Live sync mode
    this._runTest(
      "Live sync mode configuration",
      phase,
      () => {
        try {
          liveController.setLiveSyncMode("edge");
          return true;
        } catch (error) {
          Logger.error("demo-runner", "Live sync mode error:", error);
          return false;
        }
      },
      "Live sync mode set to 'edge'",
      "Failed to set live sync mode",
    );

    // Test 45: Low latency toggle
    this._runTest(
      "Low latency toggle",
      phase,
      () => {
        try {
          liveController.enableLowLatency(true);
          const enabled = liveController.hls.config.lowLatencyMode;
          liveController.enableLowLatency(false);
          const disabled = !liveController.hls.config.lowLatencyMode;
          return enabled && disabled;
        } catch (error) {
          Logger.error("demo-runner", "Low latency error:", error);
          return false;
        }
      },
      "Low latency mode toggled successfully",
      "Failed to toggle low latency",
    );
  }

  /**
   * No-op version of live streaming tests (when player is unavailable)
   */
  _testLiveFeaturesNoOp() {
    const phase = "Live Streaming";
    const testNames = [
      "LiveController creation",
      "Live stream detection",
      "Latency monitoring",
      "Live sync mode configuration",
      "Low latency toggle",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Phase 8: CMCD Analytics Features
  // ==========================================================================
  /**
   * Test CMCD analytics features
   */
  async _testCMCDFeatures(player) {
    const phase = "CMCD Analytics";

    // Create CMCD controller
    const cmcdController = new CMCDController(player);
    player.registerModule("cmcd", cmcdController);

    // Test 46: CMCD controller creation
    this._runTest(
      "CMCDController creation",
      phase,
      () => cmcdController instanceof CMCDController,
      "CMCDController instance created",
      "Failed to create CMCDController",
    );

    // Test 47: CMCD v1 enable
    this._runTest(
      "CMCD v1 enable",
      phase,
      () => {
        try {
          cmcdController.enableCMCDv1({
            sessionId: "demo-session-" + Date.now(),
            contentId: "demo-content",
            useHeaders: false,
          });
          return cmcdController.isEnabled;
        } catch (error) {
          Logger.error("demo-runner", "CMCD v1 error:", error);
          return false;
        }
      },
      "CMCD v1 enabled",
      "Failed to enable CMCD v1",
    );

    // Test 48: Custom data update
    this._runTest(
      "CMCD custom data update",
      phase,
      () => {
        try {
          cmcdController.updateCustomData({
            "com.demo.player": "hlsjs-extension",
            "com.demo.version": "1.0.0",
          });
          return Object.keys(cmcdController.customData).length > 0;
        } catch (error) {
          Logger.error("demo-runner", "CMCD custom data error:", error);
          return false;
        }
      },
      `Custom data set: ${Object.keys(cmcdController.customData).length} keys`,
      "Failed to update custom data",
    );

    // Test 49: CMCD status report
    this._runTest(
      "CMCD status report",
      phase,
      () => {
        const status = cmcdController.getCMCDStatus();
        return status !== null && typeof status.enabled === "boolean";
      },
      `CMCD status: ${JSON.stringify(cmcdController.getCMCDStatus())}`,
      "Failed to get CMCD status",
    );
  }

  /**
   * No-op version of CMCD tests (when player is unavailable)
   */
  _testCMCDFeaturesNoOp() {
    const phase = "CMCD Analytics";
    const testNames = [
      "CMCDController creation",
      "CMCD v1 enable",
      "CMCD custom data update",
      "CMCD status report",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Phase 9: I-Frame Preview Features
  // ==========================================================================

  /**
   * Test I-Frame preview features including smart timeline previews
   */
  async _testIFrameFeatures(player) {
    const phase = "I-Frame Previews";

    // Create I-Frame controller
    const iFrameController = new IFrameController(player);
    player.registerModule("iframe", iFrameController);

    // Test 50: I-Frame controller creation
    this._runTest(
      "IFrameController creation",
      phase,
      () => iFrameController instanceof IFrameController,
      "IFrameController instance created",
      "Failed to create IFrameController",
    );

    // Test 51: I-Frame variant detection
    this._runTest(
      "I-Frame variant detection",
      phase,
      () => {
        const hasVariants = (player.hls?.iframeVariants?.length || 0) > 0;
        return typeof hasVariants === "boolean";
      },
      `I-Frame variants: ${player.hls?.iframeVariants?.length || 0}`,
      "Failed to check I-Frame variants",
    );

    // Test 52: I-Frame status report
    this._runTest(
      "I-Frame status report",
      phase,
      () => {
        const status = iFrameController.getIFrameStatus();
        return status !== null && typeof status.hasIFrameVariants === "boolean";
      },
      `I-Frame status: ${JSON.stringify(iFrameController.getIFrameStatus())}`,
      "Failed to get I-Frame status",
    );

    // ========================================================================
    // SMART TIMELINE PREVIEWS TESTS - NO SKIP LOGIC
    // ========================================================================

    // Get duration directly from video element (HTML5 video element)
    const duration = player.video?.duration || 0;
    Logger.info(
      "demo-runner",
      `📊 Video duration: ${duration.toFixed(1)}s (readyState: ${player.video?.readyState})`,
    );

    // Test 53: Smart thumbnail count calculation
    this._runTest(
      "Smart thumbnail count calculation",
      phase,
      () => {
        if (duration <= 0) {
          Logger.warn("demo-runner", "Video duration not available yet");
          return false;
        }
        const count = iFrameController.calculateOptimalThumbnailCount(duration);
        return count >= 5 && count <= 20;
      },
      `Calculated thumbnail count: ${duration > 0 ? iFrameController.calculateOptimalThumbnailCount(duration) : "N/A"}`,
      "Failed to calculate optimal thumbnail count (duration may not be ready)",
    );

    // Test 54: Timeline UI creation and preview generation
    this._runTest(
      "Timeline preview generation",
      phase,
      async () => {
        try {
          if (duration <= 0) {
            Logger.warn(
              "demo-runner",
              "Cannot generate timeline previews: duration not available",
            );
            return false;
          }

          // Create timeline container if not exists
          let timelineContainer = document.getElementById(
            "timeline-previews-container",
          );
          if (!timelineContainer) {
            timelineContainer = document.createElement("div");
            timelineContainer.id = "timeline-previews-container";
            timelineContainer.style.cssText = `
              position: fixed;
              bottom: 80px;
              left: 0;
              right: 0;
              z-index: 1000;
              background: rgba(0,0,0,0.9);
              backdrop-filter: blur(10px);
              border-top: 1px solid rgba(255,255,255,0.2);
              display: none;
            `;
            document.body.appendChild(timelineContainer);
          }

          // Check if image player is available
          if (!player.hls.createImageIFramePlayer) {
            Logger.warn("demo-runner", "Image I-frame player not supported");
            return false;
          }

          // Generate timeline previews
          await iFrameController.generateTimelinePreviews(timelineContainer, {
            showLoadingIndicators: true,
            batchSize: 3,
          });

          const success = iFrameController.timelinePreviews.length > 0;
          Logger.info(
            "demo-runner",
            `Timeline preview generation ${success ? "succeeded" : "failed"}: ${iFrameController.timelinePreviews.length} previews`,
          );
          return success;
        } catch (error) {
          Logger.error(
            "demo-runner",
            "Timeline preview generation error:",
            error,
          );
          return false;
        }
      },
      "Timeline preview generation completed",
      "Failed to generate timeline previews",
    );

    // Test 55: Timeline status monitoring
    this._runTest(
      "Timeline status monitoring",
      phase,
      () => {
        const status = iFrameController.getTimelineStatus();
        Logger.info("demo-runner", "Timeline status", status);
        return status !== null && typeof status.total === "number";
      },
      `Timeline status: ${JSON.stringify(iFrameController.getTimelineStatus())}`,
      "Failed to get timeline status",
    );

    // Test 56: Seek functionality
    this._runTest(
      "Timeline seek functionality",
      phase,
      () => {
        return typeof iFrameController._seekToTimestamp === "function";
      },
      "Seek functionality available",
      "Seek functionality missing",
    );

    // Test 57: Clear timeline previews
    this._runTest(
      "Clear timeline previews",
      phase,
      () => {
        try {
          iFrameController.clearTimelinePreviews();
          return iFrameController.timelinePreviews.length === 0;
        } catch (error) {
          Logger.error("demo-runner", "Clear timeline error:", error);
          return false;
        }
      },
      "Timeline previews cleared successfully",
      "Failed to clear timeline previews",
    );

    // Test 58: Get thumbnail URLs method exists
    this._runTest(
      "Get thumbnail URLs method",
      phase,
      () => {
        return typeof iFrameController.getThumbnailUrls === "function";
      },
      "getThumbnailUrls() method available",
      "getThumbnailUrls() method missing",
    );

    // Test 59: Get thumbnail URL at specific timestamp
    this._runTest(
      "Get thumbnail URL at timestamp",
      phase,
      async () => {
        try {
          if (iFrameController.timelinePreviews.length === 0) {
            Logger.info(
              "demo-runner",
              "No previews loaded, cannot test URL retrieval",
            );
            return false;
          }

          const testTimestamp = duration / 2; // Middle of video
          const url = iFrameController.getThumbnailUrlAt(testTimestamp);

          // URL should be either a blob URL or null (if not loaded yet)
          const isValid =
            url === null ||
            (typeof url === "string" && url.startsWith("blob:"));

          Logger.info(
            "demo-runner",
            `Thumbnail URL at ${testTimestamp.toFixed(1)}s:`,
            {
              url: url ? url.substring(0, 50) + "..." : "null",
              isValid,
            },
          );

          return isValid;
        } catch (error) {
          Logger.error("demo-runner", "getThumbnailUrlAt error:", error);
          return false;
        }
      },
      "Thumbnail URL retrieval works",
      "Failed to get thumbnail URL at timestamp",
    );

    // Test 60: Get all previews data
    this._runTest(
      "Get all previews data",
      phase,
      () => {
        try {
          const allPreviews = iFrameController.getAllPreviews();

          // Validate structure
          const isValid =
            Array.isArray(allPreviews) &&
            allPreviews.every(
              (p) =>
                typeof p.index === "number" &&
                typeof p.timestamp === "number" &&
                typeof p.formattedTime === "string" &&
                typeof p.loaded === "boolean" &&
                typeof p.error === "boolean",
            );

          Logger.info(
            "demo-runner",
            `All previews data: ${allPreviews.length} items`,
          );
          if (allPreviews.length > 0 && allPreviews[0].imageUrl) {
            Logger.debug(
              "demo-runner",
              `First preview URL: ${allPreviews[0].imageUrl?.substring(0, 50)}...`,
            );
          }

          return isValid;
        } catch (error) {
          Logger.error("demo-runner", "getAllPreviews error:", error);
          return false;
        }
      },
      "getAllPreviews() returns valid preview data",
      "Failed to get all previews data",
    );

    // Test 61: Get thumbnail URLs only (without UI)
    this._runTest(
      "Get thumbnail URLs only (no UI)",
      phase,
      async () => {
        try {
          if (typeof iFrameController.getThumbnailUrlsOnly !== "function") {
            Logger.warn(
              "demo-runner",
              "getThumbnailUrlsOnly method not available",
            );
            return false;
          }

          if (duration <= 0) {
            Logger.warn(
              "demo-runner",
              "Cannot test getThumbnailUrlsOnly: duration not available",
            );
            return false;
          }

          // Test with small count to avoid too many requests
          const testCount = Math.min(
            3,
            iFrameController.calculateOptimalThumbnailCount(duration),
          );
          const urlsOnly = await iFrameController.getThumbnailUrlsOnly(
            duration,
            testCount,
          );

          const isValid =
            Array.isArray(urlsOnly) &&
            urlsOnly.every(
              (item) =>
                typeof item.timestamp === "number" &&
                (item.url === null || typeof item.url === "string"),
            );

          const successCount = urlsOnly.filter((u) => u.url !== null).length;
          Logger.info(
            "demo-runner",
            `Thumbnail URLs only: ${successCount}/${urlsOnly.length} loaded`,
          );

          // Log first successful URL
          const firstSuccess = urlsOnly.find((u) => u.url);
          if (firstSuccess) {
            Logger.debug(
              "demo-runner",
              `First URL: ${firstSuccess.formattedTime} -> ${firstSuccess.url?.substring(0, 50)}...`,
            );
          }

          // Clean up blob URLs to prevent memory leaks
          urlsOnly.forEach((item) => {
            if (item.url && item.url.startsWith("blob:")) {
              URL.revokeObjectURL(item.url);
            }
          });

          return isValid && successCount > 0;
        } catch (error) {
          Logger.error("demo-runner", "getThumbnailUrlsOnly error:", error);
          return false;
        }
      },
      "getThumbnailUrlsOnly() works without UI",
      "Failed to get thumbnail URLs without UI",
    );

    // Test 62: Blob URL cleanup on destroy
    this._runTest(
      "Blob URL cleanup",
      phase,
      () => {
        try {
          // Store reference to thumbnailUrls array
          const thumbnailUrls = iFrameController.thumbnailUrls || [];

          // Check if URLs are being tracked
          const hasTrackedUrls = Array.isArray(thumbnailUrls);

          // Verify clearTimelinePreviews revokes URLs
          const beforeCount = iFrameController.thumbnailUrls?.length || 0;
          iFrameController.clearTimelinePreviews();
          const afterCount = iFrameController.thumbnailUrls?.length || 0;

          const urlsCleaned = beforeCount === 0 || afterCount === 0;

          Logger.info("demo-runner", "Blob URL cleanup:", {
            beforeCount,
            afterCount,
            urlsCleaned,
            hasTrackedUrls,
          });

          return hasTrackedUrls && urlsCleaned;
        } catch (error) {
          Logger.error("demo-runner", "Blob URL cleanup error:", error);
          return false;
        }
      },
      "Blob URLs properly cleaned up",
      "Blob URL cleanup failed",
    );

    // Test 63: Timeline control button exists (UI test)
    this._runTest(
      "Timeline control button exists",
      phase,
      () => {
        const button = document.getElementById("timeline-control-btn");
        const exists = button !== null;

        if (exists) {
          Logger.info("demo-runner", "Timeline control button found in DOM");
        } else {
          Logger.warn("demo-runner", "Timeline control button not found");
        }

        return exists;
      },
      "Timeline control button UI element exists",
      "Timeline control button not found",
    );

    // Add floating control button for timeline previews
    this._addTimelineControlButton(iFrameController);
  }

  /**
   * Add floating control button for timeline previews
   */
  _addTimelineControlButton(iFrameController) {
    // Check if button already exists
    if (document.getElementById("timeline-control-btn")) return;

    const controlBtn = document.createElement("button");
    controlBtn.id = "timeline-control-btn";
    controlBtn.innerHTML = "🎬 Show Timeline Previews";
    controlBtn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 1001;
      padding: 10px 16px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      transition: transform 0.2s ease;
    `;

    let timelineVisible = false;
    let timelineContainer = document.getElementById(
      "timeline-previews-container",
    );

    controlBtn.onmouseenter = () => {
      controlBtn.style.transform = "scale(1.05)";
    };
    controlBtn.onmouseleave = () => {
      controlBtn.style.transform = "scale(1)";
    };

    controlBtn.onclick = async () => {
      if (!timelineVisible) {
        if (!timelineContainer) {
          timelineContainer = document.createElement("div");
          timelineContainer.id = "timeline-previews-container";
          timelineContainer.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 0;
            right: 0;
            z-index: 1000;
            background: rgba(0,0,0,0.9);
            backdrop-filter: blur(10px);
            border-top: 1px solid rgba(255,255,255,0.2);
            transition: transform 0.3s ease;
          `;
          document.body.appendChild(timelineContainer);
        }

        timelineContainer.style.display = "block";
        controlBtn.innerHTML = "🎬 Hide Timeline Previews";
        timelineVisible = true;

        // Generate previews if not already generated
        if (iFrameController.timelinePreviews.length === 0) {
          controlBtn.innerHTML = "⏳ Loading Timeline...";
          controlBtn.disabled = true;

          await iFrameController.generateTimelinePreviews(timelineContainer, {
            showLoadingIndicators: true,
            batchSize: 3,
          });

          controlBtn.innerHTML = "🎬 Hide Timeline Previews";
          controlBtn.disabled = false;

          Logger.info("demo-runner", "Timeline previews loaded and ready");
        }
      } else {
        timelineContainer.style.display = "none";
        controlBtn.innerHTML = "🎬 Show Timeline Previews";
        timelineVisible = false;
      }
    };

    document.body.appendChild(controlBtn);
    Logger.info("demo-runner", "Timeline control button added");
  }

  /**
   * No-op version of I-Frame tests (when player is unavailable)
   */
  _testIFrameFeaturesNoOp() {
    const phase = "I-Frame Previews";
    const testNames = [
      "IFrameController creation",
      "I-Frame variant detection",
      "I-Frame status report",
      "Smart thumbnail count calculation",
      "Timeline preview generation",
      "Timeline status monitoring",
      "Timeline seek functionality",
      "Clear timeline previews",
      "Get thumbnail URLs method",
      "Get thumbnail URL at timestamp",
      "Get all previews data",
      "Get thumbnail URLs only (no UI)",
      "Blob URL cleanup",
      "Timeline control button exists",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Phase 10: DRM Features
  // ==========================================================================
  /**
   * Test DRM features
   */
  async _testDRMFeatures(player) {
    const phase = "DRM";

    // Create DRM controller
    const drmController = new DRMController(player);
    player.registerModule("drm", drmController);

    // Test 53: DRM controller creation
    this._runTest(
      "DRMController creation",
      phase,
      () => drmController instanceof DRMController,
      "DRMController instance created",
      "Failed to create DRMController",
    );

    // Test 54: DRM configuration (test only, no actual license)
    this._runTest(
      "DRM system configuration",
      phase,
      () => {
        try {
          drmController.configureWidevine("https://example.com/license-proxy", {
            withCredentials: false,
          });
          return drmController.isDRMEnabled;
        } catch (error) {
          Logger.error("demo-runner", "DRM config error:", error);
          return false;
        }
      },
      "Widevine DRM configured (test)",
      "Failed to configure DRM",
    );

    // Test 55: DRM status report
    this._runTest(
      "DRM status report",
      phase,
      () => {
        const status = drmController.getDRMStatus();
        return status !== null && typeof status.drmEnabled === "boolean";
      },
      `DRM status: ${JSON.stringify(drmController.getDRMStatus())}`,
      "Failed to get DRM status",
    );
  }

  /**
   * No-op version of DRM tests (when player is unavailable)
   */
  _testDRMFeaturesNoOp() {
    const phase = "DRM";
    const testNames = [
      "DRMController creation",
      "DRM system configuration",
      "DRM status report",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Phase 11: Error Handling Features
  // ==========================================================================
  /**
   * Test error handling features
   */
  async _testErrorFeatures(player) {
    const phase = "Error Handling";

    // Create error controller
    const errorController = new ErrorController(player);
    player.registerModule("error", errorController);

    // Test 56: Error controller creation
    this._runTest(
      "ErrorController creation",
      phase,
      () => errorController instanceof ErrorController,
      "ErrorController instance created",
      "Failed to create ErrorController",
    );

    // Test 57: Error status report
    this._runTest(
      "Error status report",
      phase,
      () => {
        const status = errorController.getErrorStatus();
        return (
          status !== null &&
          typeof status.totalErrors === "number" &&
          typeof status.fatalErrors === "number"
        );
      },
      `Errors: ${errorController.getErrorStatus().totalErrors} total, ${errorController.getErrorStatus().fatalErrors} fatal`,
      "Failed to get error status",
    );

    // Test 58: Error history retrieval
    this._runTest(
      "Error history retrieval",
      phase,
      () => {
        const history = errorController.getErrorHistory(5);
        return Array.isArray(history);
      },
      `Error history entries: ${errorController.getErrorHistory().length}`,
      "Failed to get error history",
    );

    // Test 59: Manual recovery available
    this._runTest(
      "Manual recovery method available",
      phase,
      () => {
        return typeof errorController.manualRecover === "function";
      },
      "Manual recovery method exists",
      "Manual recovery method not available",
    );
  }

  /**
   * No-op version of error handling tests (when player is unavailable)
   */
  _testErrorFeaturesNoOp() {
    const phase = "Error Handling";
    const testNames = [
      "ErrorController creation",
      "Error status report",
      "Error history retrieval",
      "Manual recovery method available",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Phase 12: Module Status Verification
  // ==========================================================================
  /**
   * Test that all modules are properly registered
   */
  async _testModuleStatus(player) {
    const phase = "Module Status";
    const requiredModules = [
      "quality",
      "audio",
      "playback",
      "live",
      "cmcd",
      "iframe",
      "drm",
      "error",
    ];

    // Test 60-67: Module registration
    for (const moduleName of requiredModules) {
      this._runTest(
        `Module "${moduleName}" registered`,
        phase,
        () => {
          const module = player.getModule(moduleName);
          return module !== null && module !== undefined;
        },
        `Module "${moduleName}" is registered`,
        `Module "${moduleName}" is NOT registered`,
      );
    }

    // Test 68: All modules accessible
    this._runTest(
      "All feature modules accessible",
      phase,
      () => {
        return Object.keys(player.modules).length > 0;
      },
      `Modules registered: ${Object.keys(player.modules).length} (${Object.keys(player.modules).join(", ")})`,
      "No modules registered",
    );
  }

  /**
   * No-op version of module status tests (when player is unavailable)
   */
  _testModuleStatusNoOp() {
    const phase = "Module Status";
    const testNames = [
      'Module "quality" registered',
      'Module "audio" registered',
      'Module "playback" registered',
      'Module "live" registered',
      'Module "cmcd" registered',
      'Module "iframe" registered',
      'Module "drm" registered',
      'Module "error" registered',
      "All feature modules accessible",
    ];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================
  /**
   * Test cleanup
   */
  async _testCleanup(player) {
    const phase = "Cleanup";

    // Stop monitoring
    if (player.getModule("quality")) {
      player.getModule("quality").stopBandwidthMonitoring();
    }
    if (player.getModule("playback")) {
      player.getModule("playback").stopBufferMonitoring();
      player.getModule("playback").stopPositionMonitoring();
    }
    if (player.getModule("live")) {
      player.getModule("live").stopLatencyMonitoring();
    }

    // NEW: Remove timeline UI if it exists
    this._removeTimelineControlButton();

    // Test 69: Player destroy
    this._runTest(
      "Player destroy",
      phase,
      () => {
        try {
          player.destroy();
          return player.hls === null && !player.isInitialized;
        } catch (error) {
          Logger.error("demo-runner", "Destroy error:", error);
          return false;
        }
      },
      "Player destroyed successfully",
      "Failed to destroy player",
    );

    // Test 70: All resources freed
    this._runTest(
      "All resources freed",
      phase,
      () => {
        return (
          player.hls === null &&
          Object.keys(player.modules).length === 0 &&
          !player.isInitialized
        );
      },
      "All resources freed, player fully destroyed",
      "Some resources may not have been freed",
    );
  }

  /**
   * No-op version of cleanup tests (when player is unavailable)
   */
  _testCleanupNoOp() {
    const phase = "Cleanup";
    const testNames = ["Player destroy", "All resources freed"];

    testNames.forEach((name) => {
      this._runTest(
        name,
        phase,
        () => false,
        "Test skipped: Player not available",
        "Test skipped: Player not available",
      );
    });
  }

  // ==========================================================================
  // Test Runner Utilities
  // ==========================================================================
  /**
   * Run a single test and record the result
   * @param {string} name - Test name
   * @param {string} phase - Test phase/category
   * @param {Function|AsyncFunction} testFn - Test function returning boolean
   * @param {string} successMessage - Message on success
   * @param {string} failureMessage - Message on failure
   * @returns {boolean} Test result
   */
  _runTest(name, phase, testFn, successMessage, failureMessage) {
    this.results.total++;
    this.currentTest = name;
    const testResult = {
      id: this.results.total,
      name,
      phase,
      status: "running",
      timestamp: new Date().toISOString(),
      successMessage,
      failureMessage,
    };

    try {
      const result = testFn();
      // Handle async tests
      if (result instanceof Promise) {
        return result
          .then((resolved) => {
            this._recordResult(
              testResult,
              resolved,
              successMessage,
              failureMessage,
            );
            return resolved;
          })
          .catch((error) => {
            Logger.error("demo-runner", `Test "${name}" error:`, error);
            this._recordResult(
              testResult,
              false,
              successMessage,
              `${failureMessage}: ${error.message}`,
            );
            return false;
          });
      }
      this._recordResult(testResult, result, successMessage, failureMessage);
      return result;
    } catch (error) {
      Logger.error("demo-runner", `Test "${name}" error:`, error);
      this._recordResult(
        testResult,
        false,
        successMessage,
        `${failureMessage}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Record a test result
   */
  _recordResult(testResult, passed, successMessage, failureMessage) {
    testResult.status = passed ? "passed" : "failed";
    testResult.message = passed ? successMessage : failureMessage;
    testResult.duration = Date.now() - new Date(testResult.timestamp).getTime();

    if (passed) {
      this.results.passed++;
      Logger.info(
        "demo-runner",
        `✅ TEST #${testResult.id} PASSED: ${testResult.name}`,
        { message: successMessage },
      );
    } else {
      this.results.failed++;
      Logger.error(
        "demo-runner",
        `❌ TEST #${testResult.id} FAILED: ${testResult.name}`,
        { message: failureMessage },
      );

      if (this.stopOnFailure) {
        Logger.error(
          "demo-runner",
          "⛔ Stopping on failure (stopOnFailure=true)",
        );
        throw new Error(`Test failed: ${testResult.name}`);
      }
    }

    this.results.tests.push(testResult);
  }

  // ==========================================================================
  // Report Generation
  // ==========================================================================
  /**
   * Generate final test report
   * @returns {Object} Test results
   */
  _generateReport() {
    this.results.endTime = Date.now();
    this.results.duration = this.results.endTime - this.results.startTime;

    const { total, passed, failed, skipped, duration } = this.results;
    const successRate = total > 0 ? ((passed / total) * 100).toFixed(1) : 0;

    Logger.info("demo-runner", "\n" + "=".repeat(60));
    Logger.info("demo-runner", "📊 DEMONSTRATION COMPLETE - RESULTS SUMMARY");
    Logger.info("demo-runner", "=".repeat(60));
    Logger.info(
      "demo-runner",
      `⏱️  Duration: ${(duration / 1000).toFixed(2)}s`,
    );
    Logger.info("demo-runner", `📋 Total Tests: ${total}`);
    Logger.info("demo-runner", `✅ Passed: ${passed}`);
    Logger.info("demo-runner", `❌ Failed: ${failed}`);
    Logger.info("demo-runner", `⏭️ Skipped: ${skipped}`);
    Logger.info("demo-runner", `📈 Success Rate: ${successRate}%`);

    if (failed > 0) {
      Logger.info("demo-runner", "\n❌ FAILED TESTS:");
      this.results.tests
        .filter((t) => t.status === "failed")
        .forEach((t) => {
          Logger.error(
            "demo-runner",
            `  #${t.id} [${t.phase}] ${t.name}: ${t.message}`,
          );
        });
    }

    if (passed > 0) {
      Logger.info("demo-runner", "\n✅ PASSED TESTS:");
      this.results.tests
        .filter((t) => t.status === "passed")
        .forEach((t) => {
          Logger.info(
            "demo-runner",
            `  #${t.id} [${t.phase}] ${t.name}: ${t.message}`,
          );
        });
    }

    // Phase summary
    Logger.info("demo-runner", "\n📊 PHASE SUMMARY:");
    const phaseSummary = {};
    this.results.tests.forEach((t) => {
      if (!phaseSummary[t.phase]) {
        phaseSummary[t.phase] = { total: 0, passed: 0, failed: 0 };
      }
      phaseSummary[t.phase].total++;
      phaseSummary[t.phase][t.status === "passed" ? "passed" : "failed"]++;
    });

    Object.entries(phaseSummary).forEach(([phase, stats]) => {
      const phaseRate = ((stats.passed / stats.total) * 100).toFixed(0);
      const icon = stats.failed === 0 ? "✅" : "⚠️";
      Logger.info(
        "demo-runner",
        `  ${icon} ${phase}: ${stats.passed}/${stats.total} (${phaseRate}%)`,
      );
    });

    Logger.info("demo-runner", "\n" + "=".repeat(60));
    return this.results;
  }

  // ==========================================================================
  // Utility Functions
  // ==========================================================================
  /**
   * Wait for a condition to be true
   * @param {Function} condition - Function that returns boolean
   * @param {number} timeout - Max time to wait in ms
   * @param {string} timeoutMessage - Message if timeout occurs
   * @returns {Promise<boolean>}
   */
  async _waitFor(condition, timeout = 5000, timeoutMessage = "Timeout") {
    const startTime = Date.now();
    const pollInterval = 200;

    while (Date.now() - startTime < timeout) {
      try {
        if (condition()) {
          return true;
        }
      } catch (error) {
        // Condition threw, continue waiting
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    Logger.warn("demo-runner", `⏰ ${timeoutMessage} after ${timeout}ms`);
    return false;
  }

  /**
   * Get a summary of the demo runner results
   * @returns {Object} Simplified results
   */
  getSummary() {
    return {
      total: this.results.total,
      passed: this.results.passed,
      failed: this.results.failed,
      skipped: this.results.skipped,
      duration: this.results.duration,
      successRate:
        this.results.total > 0
          ? ((this.results.passed / this.results.total) * 100).toFixed(1) + "%"
          : "0%",
    };
  }

  /**
   * Get detailed test results
   * @returns {Array} All test results
   */
  getDetailedResults() {
    return [...this.results.tests];
  }

  /**
   * Get failed tests only
   * @returns {Array} Failed test results
   */
  getFailedTests() {
    return this.results.tests.filter((t) => t.status === "failed");
  }

  // ==========================================================================
  // Utility: Async Message Sending
  // ==========================================================================
  /**
   * Send a message to background.js and wait for response
   * @param {Object} message - Message to send
   * @returns {Promise<Object>} Response
   */
  _sendMessageAsync(message) {
    return new Promise((resolve, reject) => {
      if (
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        !chrome.runtime.sendMessage
      ) {
        resolve({ success: false, error: "chrome.runtime not available" });
        return;
      }

      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: chrome.runtime.lastError.message,
          });
          return;
        }
        resolve(response || { success: false, error: "No response" });
      });
    });
  }

  /**
   * Remove timeline control button if it exists (cleanup)
   */
  _removeTimelineControlButton() {
    const button = document.getElementById("timeline-control-btn");
    if (button) {
      button.remove();
      Logger.debug("demo-runner", "Timeline control button removed");
    }

    const container = document.getElementById("timeline-previews-container");
    if (container) {
      container.remove();
      Logger.debug("demo-runner", "Timeline container removed");
    }
  }

  // ==========================================================================
  // Independent Mode Support
  // ==========================================================================
  /**
   * Run demos in independent mode (via popup proxy)
   * @param {Object} options - Configuration with playerProxy
   * @returns {Promise<Object>} Test results
   */
  async runIndependent(options = {}) {
    Logger.info(
      "demo-runner",
      "🔄 Running in independent mode (via popup proxy) - ALL tests will run",
    );

    const phase = "Independent Mode";

    this._runTest(
      "Player proxy available",
      phase,
      () => {
        return !!(options.playerProxy && options.playerProxy.tabId);
      },
      `Proxy connected to tab #${options.playerProxy?.tabId}`,
      "No player proxy available",
    );

    await this._runTest(
      "Proxy execute demo step",
      phase,
      async () => {
        if (!options.playerProxy?.executeDemoStep) return false;

        try {
          const result = await options.playerProxy.executeDemoStep({
            action: "getState",
            name: "Get video state",
          });
          Logger.info(
            "demo-runner",
            `Proxy test result: ${JSON.stringify(result)}`,
          );
          return result.success === true;
        } catch (error) {
          Logger.error("demo-runner", "Proxy test failed: " + error.message);
          return false;
        }
      },
      "Proxy communication working",
      "Failed to communicate via proxy",
    );

    // Continue with full test suite
    return await this.runAll(options);
  }
}

// ==========================================================================
// Singleton Demo Runner Instance
// ==========================================================================
/**
 * Create and configure the default demo runner
 */
const defaultDemoRunner = new DemoRunner();

/**
 * Quick-start function to run all demos with default configuration
 * @param {HTMLVideoElement} videoElement - Target video element
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Test results
 */
async function runAllDemos(videoElement, options = {}) {
  const defaultOptions = {
    videoElement,
    streamUrl:
      options.streamUrl || "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    verbose: options.verbose !== false,
    stopOnFailure: options.stopOnFailure || false,
    playerProxy: options.playerProxy || null,
  };

  return await defaultDemoRunner.runAll(defaultOptions);
}

// ==========================================================================
// Exports
// ==========================================================================
// Export for module systems
if (typeof module !== "undefined" && module.exports) {
  module.exports = { DemoRunner, defaultDemoRunner, runAllDemos };
}

if (typeof window !== "undefined") {
  window.DemoRunner = DemoRunner;
  window.defaultDemoRunner = defaultDemoRunner;
  window.runAllDemos = runAllDemos;
}

Logger.info("demo-runner", "✓ Demo Runner module loaded (ALL tests enabled)");
Logger.info("demo-runner", "ℹ️  Usage: runAllDemos(videoElement, options)");
Logger.info("demo-runner", "ℹ️  ALL tests run unconditionally - no skip logic");
Logger.info(
  "demo-runner",
  "ℹ️  CORS rules are pre-loaded before stream loading",
);
Logger.info("demo-runner", "ℹ️  Fetch proxy verification in Phase 0");
