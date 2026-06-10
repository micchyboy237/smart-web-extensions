/**
 * live.js - Live Streaming Features
 *
 * Manages live stream latency monitoring, go-to-live functionality,
 * live sync modes, and playback rate adjustments for live content.
 */

class LiveController {
  constructor(player) {
    this.player = player;
    this.hls = player.hls;
    this.video = player.video;

    // Live monitoring
    this.latencyMonitorInterval = null;
    this.isLiveStream = false;

    Logger.info("live", "LiveController initialized");
    this._setupEvents();
  }

  // --------------------------------------------------------------------------
  // Event Setup
  // --------------------------------------------------------------------------

  _setupEvents() {
    if (!this.hls) {
      Logger.warn("live", "hls instance not available for event setup");
      return;
    }

    // Manifest parsed - check if live
    this.hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      this._detectLiveStream(data);
    });

    // Level updated (for live playlist refreshes)
    this.hls.on(Hls.Events.LEVELS_UPDATED, (event, data) => {
      if (this.isLiveStream) {
        Logger.debug("live", "Live playlist levels updated");
      }
    });

    // Back buffer reached (live catchup)
    this.hls.on(Hls.Events.BACK_BUFFER_REACHED, () => {
      Logger.info("live", "Back buffer reached - live stream is at edge");
    });

    Logger.info("live", "✓ Live events setup");
  }

  // --------------------------------------------------------------------------
  // Live Detection
  // --------------------------------------------------------------------------

  _detectLiveStream(data) {
    const hasLiveLevels = data.levels.some((level) => level.details?.live);

    this.isLiveStream = hasLiveLevels;

    if (this.isLiveStream) {
      Logger.info("live", "🔴 Live stream detected!", {
        levelCount: data.levels.length,
        firstLevel: data.firstLevel,
      });

      // Log live stream details
      const firstLevel = data.levels[0];
      if (firstLevel?.details) {
        Logger.info("live", "Live stream details", {
          targetDuration: firstLevel.details.targetduration,
          totalDuration: firstLevel.details.totalduration,
          fragments: firstLevel.details.fragments?.length,
          partTarget: firstLevel.details.partTarget,
          liveStartPosition: firstLevel.details.liveStartPosition,
        });
      }
    } else {
      Logger.info("live", "VOD stream detected - live features not applicable");
    }
  }

  // ==========================================================================
  // Latency Monitoring
  // ==========================================================================

  startLatencyMonitoring(intervalMs = 1000) {
    if (!this.isLiveStream) {
      Logger.warn("live", "Cannot monitor latency: not a live stream");
      return;
    }

    Logger.info(
      "live",
      `Starting latency monitoring (interval: ${intervalMs}ms)`,
    );

    this.stopLatencyMonitoring();

    this.latencyMonitorInterval = setInterval(() => {
      this._reportLatency();
    }, intervalMs);

    this._reportLatency(); // Immediate first report
  }

  stopLatencyMonitoring() {
    if (this.latencyMonitorInterval) {
      clearInterval(this.latencyMonitorInterval);
      this.latencyMonitorInterval = null;
      Logger.info("live", "Latency monitoring stopped");
    }
  }

  _reportLatency() {
    if (!this.hls || !this.isLiveStream) return;

    const latency = this.hls.latency;
    const targetLatency = this.hls.targetLatency;
    const maxLatency = this.hls.maxLatency;
    const drift = this.hls.drift;
    const liveSyncPosition = this.hls.liveSyncPosition;

    if (latency === undefined || latency === null) {
      Logger.debug("live", "⏱️ Latency: not yet available");
      return;
    }

    Logger.debug("live", "⏱️ Live latency status", {
      latency: `${latency.toFixed(1)}s`,
      targetLatency: `${targetLatency?.toFixed(1) || "N/A"}s`,
      maxLatency: `${maxLatency?.toFixed(1) || "N/A"}s`,
      drift: drift?.toFixed(3) || "N/A",
      liveSyncPosition: liveSyncPosition?.toFixed(1) || "N/A",
      behindLive: targetLatency
        ? `${(latency - targetLatency).toFixed(1)}s behind target`
        : "N/A",
    });

    this.player.state.latency = latency;
  }

  // --------------------------------------------------------------------------
  // Get Latency
  // --------------------------------------------------------------------------

  getLatency() {
    if (!this.hls || !this.isLiveStream) return null;

    return {
      latency: this.hls.latency,
      targetLatency: this.hls.targetLatency,
      maxLatency: this.hls.maxLatency,
      drift: this.hls.drift,
      liveSyncPosition: this.hls.liveSyncPosition,
    };
  }

  // ==========================================================================
  // Go To Live
  // ==========================================================================

  goToLive() {
    if (!this.hls || !this.isLiveStream) {
      Logger.warn("live", "Cannot go to live: not a live stream");
      return;
    }

    const liveSyncPosition = this.hls.liveSyncPosition;

    if (liveSyncPosition !== undefined && this.video) {
      Logger.info(
        "live",
        `🎯 Jumping to live position: ${liveSyncPosition.toFixed(1)}s`,
        {
          currentPosition: this.video.currentTime.toFixed(1),
          newPosition: liveSyncPosition.toFixed(1),
          jumpBack:
            (liveSyncPosition - this.video.currentTime).toFixed(1) + "s",
        },
      );

      this.video.currentTime = liveSyncPosition;
    } else {
      Logger.warn("live", "Live sync position not available");
    }
  }

  // ==========================================================================
  // Live Sync Mode Configuration
  // ==========================================================================

  /**
   * Set live sync mode
   * @param {string} mode - 'edge' or 'buffered'
   */
  setLiveSyncMode(mode) {
    if (!this.hls) return;

    const validModes = ["edge", "buffered"];

    if (!validModes.includes(mode)) {
      Logger.error(
        "live",
        `Invalid live sync mode: ${mode}. Valid: ${validModes.join(", ")}`,
      );
      return;
    }

    Logger.info("live", `Setting live sync mode to: ${mode}`, {
      description:
        mode === "edge"
          ? "Jump immediately to live edge"
          : "Wait for buffered content at live position",
    });

    this.hls.config.liveSyncMode = mode;
  }

  // ==========================================================================
  // Low Latency Configuration
  // ==========================================================================

  enableLowLatency(enable = true) {
    if (!this.hls) return;

    Logger.info(
      "live",
      `${enable ? "Enabling" : "Disabling"} low latency mode`,
    );

    if (enable) {
      this.hls.config.lowLatencyMode = true;
      this.hls.config.liveSyncDurationCount = 3;
      this.hls.config.liveMaxLatencyDurationCount = 10;
      this.hls.config.liveSyncOnStallIncrease = 1;
      this.hls.config.maxLiveSyncPlaybackRate = 1.05;
      this.hls.config.initialLiveManifestSize = 3;

      Logger.info("live", "Low latency configuration applied", {
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        maxLiveSyncPlaybackRate: 1.05,
        initialLiveManifestSize: 3,
      });
    } else {
      this.hls.config.lowLatencyMode = false;
      Logger.info("live", "Low latency mode disabled");
    }
  }

  // --------------------------------------------------------------------------
  // Live Stream Status
  // --------------------------------------------------------------------------

  getLiveStatus() {
    if (!this.isLiveStream) {
      return { isLive: false };
    }

    const status = {
      isLive: true,
      latency: this.hls?.latency,
      targetLatency: this.hls?.targetLatency,
      maxLatency: this.hls?.maxLatency,
      drift: this.hls?.drift,
      liveSyncPosition: this.hls?.liveSyncPosition,
      lowLatencyMode: this.hls?.config?.lowLatencyMode || false,
      liveSyncMode: this.hls?.config?.liveSyncMode || "undefined",
    };

    Logger.info("live", "Live stream status", status);
    return status;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy() {
    Logger.info("live", "Destroying LiveController...");
    this.stopLatencyMonitoring();
    this.isLiveStream = false;
    Logger.info("live", "✓ LiveController destroyed");
  }
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = LiveController;
}
if (typeof window !== "undefined") {
  window.LiveController = LiveController;
}

Logger.info("live", "✓ Live streaming module loaded");
