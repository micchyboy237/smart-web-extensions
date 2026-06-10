/**
 * player.js - Main Player Controller
 *
 * Orchestrates all feature modules, manages UI interactions,
 * and connects the hls.js instance to the DOM.
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
    this._setupLogListener();

    Logger.info("app", "✓ PlayerApp initialized. Ready to load stream.");
  }

  // --------------------------------------------------------------------------
  // UI Event Setup
  // --------------------------------------------------------------------------

  _setupUIEvents() {
    // Load button
    document.getElementById("loadBtn").addEventListener("click", () => {
      this._loadStream();
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
  // Stream Loading
  // ==========================================================================

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

    // Create player
    try {
      this._createPlayer(url);
    } catch (error) {
      Logger.error("app", "Failed to create player", { error: error.message });
      document.getElementById("loadingOverlay").style.display = "none";
    }
  }

  _createPlayer(url) {
    Logger.info("app", "Creating HlsPlayer instance...");

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

    // Enable controls
    this._enableControls();

    Logger.info("app", "✓ Player created and source loading");
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

    Logger.debug("app", "Controls enabled");
  }

  _disableControls() {
    const controls = [
      "destroyBtn",
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
  window.app = new PlayerApp();
  Logger.info("system", "✓ Application ready");
});

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  Logger.info("system", "Page unloading - cleaning up...");
  if (window.app) {
    window.app._destroyPlayer();
  }
});
