/**
 * core.js - HlsPlayer Core Class
 *
 * Central orchestrator that manages the hls.js instance and coordinates
 * all feature modules. Provides base initialization, event routing,
 * and cleanup functionality.
 */

// ============================================================================
// HlsPlayer Core Class
// ============================================================================
class HlsPlayer {
  constructor(videoElement, config = {}) {
    this.video = videoElement;
    this.hls = null;
    this.modules = {};
    this.isInitialized = false;

    // Player state
    this.state = {
      playing: false,
      currentQuality: -1,
      currentAudioTrack: -1,
      currentSubtitleTrack: -1,
      latency: 0,
      errors: 0,
      streamType: "unknown", // 'vod', 'live', 'event'
      manifestLoaded: false,
      mediaAttached: false,
    };

    Logger.info("core", "HlsPlayer constructor called", {
      videoId: videoElement.id || "unnamed",
      configKeys: Object.keys(config),
    });

    this.init(config);
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Custom loader with CORS bypass
   *
   * This loader ensures all HLS requests use mode: 'cors'
   * and don't send problematic headers that trigger preflight.
   */
  _initCustomLoader() {
    if (!this.hls) return;

    Logger.info("core", "🔧 Configuring custom fetch loader for CORS bypass");

    // Override fetch setup to handle CORS
    this.hls.config.fetchSetup = (context, initParams) => {
      const url = context.url;
      const isHlsResource =
        url.includes(".m3u8") ||
        url.includes(".ts") ||
        url.includes(".m4s") ||
        url.includes("/hls/");

      if (isHlsResource) {
        Logger.debug("core", "📡 Custom fetch for HLS resource", {
          url: url.substring(0, 60) + "...",
          type: context.type,
        });

        // Force CORS mode
        initParams.mode = "cors";
        initParams.credentials = "omit";
        initParams.cache = "no-cache";

        // Strip problematic headers
        if (initParams.headers) {
          delete initParams.headers["Origin"];
          delete initParams.headers["Referer"];
        }

        // Add minimal headers
        initParams.headers = {
          ...initParams.headers,
          Accept: "*/*",
        };
      }

      return new Request(url, initParams);
    };

    // Override XHR setup as fallback
    this.hls.config.xhrSetup = (xhr, url) => {
      const isHlsResource =
        url.includes(".m3u8") ||
        url.includes(".ts") ||
        url.includes(".m4s") ||
        url.includes("/hls/");

      if (isHlsResource) {
        Logger.debug("core", "📡 Custom XHR for HLS resource", {
          url: url.substring(0, 60) + "...",
        });

        // Don't send credentials
        xhr.withCredentials = false;
      }
    };

    Logger.info("core", "✓ Custom CORS-bypass loader configured");
  }

  init(config) {
    Logger.debug("core", "Initializing HlsPlayer...");

    // Check browser support
    if (!Hls.isSupported()) {
      Logger.error("core", "❌ HLS is not supported in this browser");
      this._showFatalError("HLS playback is not supported in this browser");
      return;
    }

    Logger.info("core", "✓ HLS is supported");
    Logger.debug("core", "MediaSource support check", {
      mseSupported: Hls.isMSESupported(),
      mediaSource: Hls.getMediaSource() ? "Available" : "Not available",
    });

    // Check codec support
    this._checkCodecSupport();

    // Default configuration
    const defaultConfig = {
      debug: false,
      autoStartLoad: false,
      capLevelToPlayerSize: false,
      enableWorker: true,
      emeEnabled: true,
      enableWebVTT: true,
      enableIMSC1: true,
      enableCEA708Captions: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      maxBufferLength: 30,
      maxMaxBufferLength: 600,
      maxBufferSize: 60 * 1000 * 1000,
      progressive: false,
      renderTextTracksNatively: true,
      enableDateRangeMetadataCues: true,
      enableEmsgMetadataCues: true,
      enableID3MetadataCues: true,
    };

    // Merge configs
    const mergedConfig = { ...defaultConfig, ...config };

    Logger.debug("core", "Creating hls.js instance with config", {
      autoStartLoad: mergedConfig.autoStartLoad,
      lowLatencyMode: mergedConfig.lowLatencyMode,
      maxBufferLength: mergedConfig.maxBufferLength,
      emeEnabled: mergedConfig.emeEnabled,
    });

    // Create hls.js instance
    this.hls = new Hls(mergedConfig);

    // Setup custom loader for CORS bypass
    this._initCustomLoader();

    // Attach media element
    this.hls.attachMedia(this.video);

    Logger.info("core", "hls.js instance created and media attached");

    // Setup core events
    this._setupCoreEvents();

    // Initialize feature modules
    this._initModules();

    this.isInitialized = true;
    Logger.info("core", "✓ HlsPlayer initialization complete");
  }

  // --------------------------------------------------------------------------
  // Codec Support Check
  // --------------------------------------------------------------------------

  _checkCodecSupport() {
    if (!Hls.isMSESupported()) {
      Logger.warn("core", "MSE is not supported");
      return;
    }

    const mediaSource = Hls.getMediaSource();
    if (!mediaSource) {
      Logger.warn("core", "Could not get MediaSource object");
      return;
    }

    const codecs = [
      { name: "AV1", codec: 'video/mp4;codecs="av01.0.01M.08"' },
      { name: "HEVC", codec: 'video/mp4;codecs="hvc1.1.6.L150"' },
      { name: "AVC/H.264", codec: 'video/mp4;codecs="avc1.42E01E"' },
      { name: "AAC", codec: 'audio/mp4;codecs="mp4a.40.2"' },
      { name: "Opus", codec: 'audio/mp4;codecs="opus"' },
    ];

    const supportResults = {};
    codecs.forEach(({ name, codec }) => {
      const supported = mediaSource.isTypeSupported(codec);
      supportResults[name] = supported;
      Logger.debug("core", `Codec support check: ${name}`, { supported });
    });

    this.codecSupport = supportResults;
  }

  // ==========================================================================
  // Core Event Setup
  // ==========================================================================

  _setupCoreEvents() {
    if (!this.hls) return;

    // Media attached
    this.hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      this.state.mediaAttached = true;
      Logger.info("core", "🎬 MediaSource attached to video element");
    });

    // Media detached
    this.hls.on(Hls.Events.MEDIA_DETACHED, () => {
      this.state.mediaAttached = false;
      Logger.info("core", "🔌 MediaSource detached from video element");
    });

    // Manifest parsed
    this.hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      this.state.manifestLoaded = true;
      Logger.info("core", "📋 Manifest parsed successfully", {
        levels: data.levels.length,
        audioTracks: data.audioTracks?.length || 0,
        subtitleTracks: data.subtitleTracks?.length || 0,
        hasIFrameVariants: (data.iFrameVariants?.length || 0) > 0,
        firstLevel: data.firstLevel,
        audioAndTextInSameStream: data.audioAndTextInSameStream,
      });

      // Log each quality level
      data.levels.forEach((level, index) => {
        Logger.debug("core", `Level ${index}`, {
          height: level.height,
          width: level.width,
          bitrate: `${(level.bitrate / 1000000).toFixed(1)} Mbps`,
          codecs: level.codecSet || level.audioCodec,
          frameRate: level.frameRate,
          name: level.name,
        });
      });

      // Determine stream type
      const { levels } = data;
      if (levels.length > 0) {
        const firstLevel = levels[0];
        this.state.streamType = firstLevel.details?.live ? "live" : "vod";
        Logger.info("core", `Stream type detected: ${this.state.streamType}`);
      }
    });

    // Manifest loading
    this.hls.on(Hls.Events.MANIFEST_LOADING, (event, data) => {
      Logger.info("core", "📥 Loading manifest...", { url: data.url });
    });

    this.hls.on(Hls.Events.MANIFEST_LOADED, (event, data) => {
      Logger.info("core", "📥 Manifest loaded", {
        networkDetails: data.networkDetails ? "Available" : "None",
      });
    });

    // Level loaded
    this.hls.on(Hls.Events.LEVEL_LOADING, (event, data) => {
      Logger.debug("core", `📥 Loading level playlist: ${data.url}`);
    });

    this.hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
      Logger.debug("core", "Level playlist loaded", {
        level: data.level,
        details: data.details ? "Available" : "None",
      });
    });

    // Fragment events
    this.hls.on(Hls.Events.FRAG_LOADING, (event, data) => {
      Logger.debug(
        "core",
        `📥 Loading fragment: ${data.frag.relurl || data.frag.url}`,
        {
          type: data.frag.type,
          level: data.frag.level,
        },
      );
    });

    this.hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
      Logger.debug(
        "core",
        `✓ Fragment loaded: ${data.frag.relurl || "unknown"}`,
        {
          loadTime: data.stats?.loading ? `${data.stats.loading}ms` : "N/A",
          totalTime: data.stats?.total ? `${data.stats.total}ms` : "N/A",
        },
      );
    });

    this.hls.on(Hls.Events.FRAG_BUFFERED, (event, data) => {
      const video = this.video;
      if (video && video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        const duration = video.duration || 1;
        const percent = ((bufferedEnd / duration) * 100).toFixed(1);
        Logger.debug(
          "core",
          `📊 Buffer: ${percent}% (${bufferedEnd.toFixed(1)}s)`,
          {
            fragments: data.fragments?.length || 1,
            stats: data.stats,
          },
        );
      }
    });

    // Buffer events
    this.hls.on(Hls.Events.BUFFER_APPENDING, (event, data) => {
      Logger.debug("core", "Buffer appending...", {
        type: data.type,
        size: data.data?.byteLength,
      });
    });

    this.hls.on(Hls.Events.BUFFER_APPENDED, (event, data) => {
      Logger.debug("core", "Buffer appended", {
        timeRanges: data.timeRanges,
      });
    });

    // Buffer flushing
    this.hls.on(Hls.Events.BUFFER_FLUSHING, (event, data) => {
      Logger.debug("core", "Buffer flushing", {
        startOffset: data.startOffset,
        endOffset: data.endOffset,
      });
    });

    this.hls.on(Hls.Events.BUFFER_FLUSHED, (event, data) => {
      Logger.debug("core", "Buffer flushed");
    });

    // Video element events
    this.video.addEventListener("loadstart", () => {
      Logger.debug("core", "Video event: loadstart");
    });

    this.video.addEventListener("canplay", () => {
      Logger.info("core", "Video event: canplay - Video is ready to play");
    });

    this.video.addEventListener("playing", () => {
      this.state.playing = true;
      Logger.info("core", "▶️ Video is playing", {
        currentTime: this.video.currentTime.toFixed(2),
        duration: this.video.duration?.toFixed(2),
      });
    });

    this.video.addEventListener("pause", () => {
      this.state.playing = false;
      Logger.info("core", "⏸️ Video paused", {
        currentTime: this.video.currentTime.toFixed(2),
      });
    });

    this.video.addEventListener("waiting", () => {
      Logger.warn("core", "⏳ Video buffering/waiting...", {
        currentTime: this.video.currentTime.toFixed(2),
      });
    });

    this.video.addEventListener("seeking", () => {
      Logger.debug("core", `Seeking to ${this.video.currentTime.toFixed(2)}s`);
    });

    this.video.addEventListener("seeked", () => {
      Logger.debug("core", `Seeked to ${this.video.currentTime.toFixed(2)}s`);
    });

    this.video.addEventListener("ended", () => {
      this.state.playing = false;
      Logger.info("core", "⏹️ Video ended");
    });

    this.video.addEventListener("error", (event) => {
      const mediaError = event.currentTarget.error;
      this._handleVideoError(mediaError);
    });

    // Destroy event
    this.hls.on(Hls.Events.DESTROYING, () => {
      Logger.info("core", "🗑️ hls.js instance destroying...");
    });

    // Stream state transitions
    this.hls.on(Hls.Events.STREAM_STATE_TRANSITION, (event, data) => {
      Logger.debug("core", "Stream state transition", {
        previousState: data.previousState,
        nextState: data.nextState,
      });
    });

    Logger.info("core", "✓ Core events setup complete");
  }

  // --------------------------------------------------------------------------
  // Video Error Handler
  // --------------------------------------------------------------------------

  _handleVideoError(mediaError) {
    if (!mediaError) return;

    const errorMap = {
      1: "MEDIA_ERR_ABORTED - Fetch aborted",
      2: "MEDIA_ERR_NETWORK - Network error",
      3: "MEDIA_ERR_DECODE - Decode error",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED - Source not supported",
    };

    const errorDescription =
      errorMap[mediaError.code] || `Unknown error code: ${mediaError.code}`;
    Logger.error("core", `❌ Video element error: ${errorDescription}`, {
      code: mediaError.code,
      message: mediaError.message,
    });

    this.state.errors++;
  }

  // ==========================================================================
  // Module Initialization
  // ==========================================================================

  _initModules() {
    Logger.debug("core", "Initializing feature modules...");

    // Modules will be registered by external files
    // This allows each feature to be self-contained

    Logger.info(
      "core",
      `Feature modules ready: ${Object.keys(this.modules).length} loaded`,
    );
  }

  registerModule(name, moduleInstance) {
    this.modules[name] = moduleInstance;
    Logger.info("core", `Module registered: ${name}`);
  }

  getModule(name) {
    return this.modules[name] || null;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  loadSource(url) {
    Logger.info("core", `🔄 Loading source: ${url}`);

    if (!this.hls) {
      Logger.error("core", "Cannot load source: hls instance not available");
      return;
    }

    this.hls.loadSource(url);
  }

  startLoad(position) {
    if (!this.hls) return;

    Logger.info(
      "core",
      `Starting fragment loading${position !== undefined ? ` from ${position}s` : ""}`,
    );
    this.hls.startLoad(position);
  }

  play() {
    if (!this.video) return;

    Logger.info("core", "▶️ Initiating playback");
    this.video
      .play()
      .then(() => {
        Logger.info("core", "✓ Playback started successfully");
      })
      .catch((err) => {
        Logger.error("core", "❌ Playback failed", {
          error: err.message,
          name: err.name,
        });
      });
  }

  pause() {
    if (!this.video) return;

    Logger.info("core", "⏸️ Pausing playback");
    this.video.pause();
  }

  seekTo(seconds) {
    if (!this.video) return;

    Logger.info("core", `Seeking to ${seconds.toFixed(2)}s`);
    this.video.currentTime = seconds;
  }

  getCurrentTime() {
    return this.video ? this.video.currentTime : 0;
  }

  getDuration() {
    return this.video ? this.video.duration : 0;
  }

  getBufferedInfo() {
    if (!this.video || this.video.buffered.length === 0) {
      return { ranges: [], percent: 0, end: 0 };
    }

    const ranges = [];
    for (let i = 0; i < this.video.buffered.length; i++) {
      ranges.push({
        start: this.video.buffered.start(i),
        end: this.video.buffered.end(i),
      });
    }

    const bufferedEnd = this.video.buffered.end(this.video.buffered.length - 1);
    const duration = this.video.duration || 1;
    const percent = ((bufferedEnd / duration) * 100).toFixed(1);

    return { ranges, percent: parseFloat(percent), end: bufferedEnd };
  }

  getState() {
    return { ...this.state };
  }

  // ==========================================================================
  // Error Display
  // ==========================================================================

  _showFatalError(message) {
    Logger.error("core", `FATAL: ${message}`);

    const errorEl = document.getElementById("fatalError");
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = "block";
    }
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  destroy() {
    Logger.info("core", "🗑️ Destroying HlsPlayer...");

    // Destroy all modules
    Object.keys(this.modules).forEach((name) => {
      if (
        this.modules[name] &&
        typeof this.modules[name].destroy === "function"
      ) {
        Logger.debug("core", `Destroying module: ${name}`);
        this.modules[name].destroy();
      }
    });

    this.modules = {};

    // Destroy hls.js instance
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
      Logger.info("core", "hls.js instance destroyed");
    }

    this.isInitialized = false;
    this.state.mediaAttached = false;
    this.state.manifestLoaded = false;

    Logger.info("core", "✓ HlsPlayer fully destroyed, resources freed");
  }
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = HlsPlayer;
}
if (typeof window !== "undefined") {
  window.HlsPlayer = HlsPlayer;
}

Logger.info("core", "✓ Core module loaded");
