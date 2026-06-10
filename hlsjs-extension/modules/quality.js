/**
 * quality.js - Quality & Adaptive Bitrate (ABR) Features
 *
 * Manages quality level selection, level capping, bandwidth monitoring,
 * ABR configuration, and frame drop detection.
 */

class QualityController {
  constructor(player) {
    this.player = player;
    this.hls = player.hls;
    this.video = player.video;

    // Monitoring
    this.bandwidthMonitorInterval = null;
    this.fpsMonitorActive = false;

    Logger.info("quality", "QualityController initialized");
    this._setupEvents();
  }

  // --------------------------------------------------------------------------
  // Event Setup
  // --------------------------------------------------------------------------

  _setupEvents() {
    if (!this.hls) {
      Logger.warn("quality", "hls instance not available for event setup");
      return;
    }

    // Level switched
    this.hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      const level = this.hls.levels[data.level];
      if (level) {
        Logger.info(
          "quality",
          `🔄 Level switched to ${data.level}: ${level.height}p @ ${(level.bitrate / 1000000).toFixed(1)} Mbps`,
          {
            level: data.level,
            height: level.height,
            width: level.width,
            bitrate: level.bitrate,
            auto: this.hls.autoLevelEnabled,
          },
        );
        this.player.state.currentQuality = data.level;
      }
    });

    // Level switching
    this.hls.on(Hls.Events.LEVEL_SWITCHING, (event, data) => {
      Logger.debug("quality", `Switching to level ${data.level}...`);
    });

    // Level updated
    this.hls.on(Hls.Events.LEVELS_UPDATED, (event, data) => {
      Logger.info("quality", "Levels updated", {
        count: data.levels.length,
      });
    });

    // FPS drop events
    this.hls.on(Hls.Events.FPS_DROP, (event, data) => {
      const totalFrames = data.currentDropped + data.currentDecoded;
      const dropPercent =
        totalFrames > 0
          ? ((data.currentDropped / totalFrames) * 100).toFixed(1)
          : "0";
      Logger.warn(
        "quality",
        `⚠️ FPS drop detected: ${dropPercent}% frames dropped`,
        {
          dropped: data.currentDropped,
          decoded: data.currentDecoded,
          dropPercent: dropPercent + "%",
        },
      );
    });

    this.hls.on(Hls.Events.FPS_DROP_LEVEL_CAPPING, (event, data) => {
      Logger.info(
        "quality",
        `Level ${data.droppedLevel} capped due to FPS drop`,
      );
    });

    Logger.info("quality", "✓ Quality events setup");
  }

  // ==========================================================================
  // Quality Level Management
  // ==========================================================================

  /**
   * Get all available quality levels
   */
  getLevels() {
    if (!this.hls || !this.hls.levels) {
      Logger.warn("quality", "No levels available");
      return [];
    }

    const levels = this.hls.levels.map((level, index) => ({
      index,
      height: level.height,
      width: level.width,
      bitrate: level.bitrate,
      bitrateMbps: (level.bitrate / 1000000).toFixed(1),
      frameRate: level.frameRate,
      codecs: level.codecSet || "unknown",
      name: level.name || `Level ${index}`,
      isCurrent: index === this.hls.currentLevel,
      isEnabled: !level.attrs?.RESOLUTION?.includes("0x0"),
    }));

    Logger.info("quality", "Available quality levels", {
      count: levels.length,
      levels: levels.map((l) => `${l.height}p @ ${l.bitrateMbps} Mbps`),
    });

    return levels;
  }

  // --------------------------------------------------------------------------
  // Set Quality Level
  // --------------------------------------------------------------------------

  /**
   * Set current quality level
   * @param {number} levelIndex - Level index, -1 for auto
   */
  setQuality(levelIndex) {
    if (!this.hls) return;

    const maxLevel = this.hls.levels.length - 1;

    if (levelIndex === -1) {
      Logger.info("quality", "🔄 Setting quality to AUTO (ABR enabled)");
      this.hls.currentLevel = -1;
    } else if (levelIndex >= 0 && levelIndex <= maxLevel) {
      const level = this.hls.levels[levelIndex];
      Logger.info(
        "quality",
        `🔒 Setting quality to level ${levelIndex}: ${level.height}p @ ${(level.bitrate / 1000000).toFixed(1)} Mbps`,
      );
      this.hls.currentLevel = levelIndex;
    } else {
      Logger.error(
        "quality",
        `Invalid level index: ${levelIndex} (valid range: -1 to ${maxLevel})`,
      );
    }
  }

  /**
   * Set quality for next fragment (smoother transition)
   */
  setNextQuality(levelIndex) {
    if (!this.hls) return;

    const maxLevel = this.hls.levels.length - 1;

    if (levelIndex >= 0 && levelIndex <= maxLevel) {
      const level = this.hls.levels[levelIndex];
      Logger.info(
        "quality",
        `🔜 Setting next fragment quality to level ${levelIndex}: ${level.height}p`,
      );
      this.hls.nextLevel = levelIndex;
    } else {
      Logger.error("quality", `Invalid next level index: ${levelIndex}`);
    }
  }

  /**
   * Return to automatic quality selection
   */
  enableAutoQuality() {
    if (!this.hls) return;

    Logger.info("quality", "🔄 Enabling automatic quality selection (ABR)");
    this.hls.currentLevel = -1;
    this.hls.nextLevel = -1;
    this.hls.loadLevel = -1;
    this.hls.autoLevelCapping = -1;

    Logger.debug("quality", "ABR settings reset", {
      currentLevel: this.hls.currentLevel,
      nextLevel: this.hls.nextLevel,
      loadLevel: this.hls.loadLevel,
      autoLevelCapping: this.hls.autoLevelCapping,
    });
  }

  // --------------------------------------------------------------------------
  // Level Capping
  // --------------------------------------------------------------------------

  /**
   * Cap maximum quality level
   */
  setAutoLevelCapping(maxLevel) {
    if (!this.hls) return;

    this.hls.autoLevelCapping = maxLevel;

    if (maxLevel === -1) {
      Logger.info("quality", "🔄 Level capping removed");
    } else {
      const level = this.hls.levels[maxLevel];
      if (level) {
        Logger.info(
          "quality",
          `🔒 Level capped at ${maxLevel}: ${level.height}p`,
        );
      } else {
        Logger.warn(
          "quality",
          `Level cap set to ${maxLevel}, but level not found`,
        );
      }
    }
  }

  /**
   * Get current level cap
   */
  getAutoLevelCapping() {
    return this.hls ? this.hls.autoLevelCapping : -1;
  }

  // --------------------------------------------------------------------------
  // Bandwidth Monitoring
  // --------------------------------------------------------------------------

  startBandwidthMonitoring(intervalMs = 3000) {
    Logger.info(
      "quality",
      `Starting bandwidth monitoring (interval: ${intervalMs}ms)`,
    );

    this.stopBandwidthMonitoring();

    this.bandwidthMonitorInterval = setInterval(() => {
      this._reportBandwidth();
    }, intervalMs);

    this._reportBandwidth(); // Immediate first report
  }

  stopBandwidthMonitoring() {
    if (this.bandwidthMonitorInterval) {
      clearInterval(this.bandwidthMonitorInterval);
      this.bandwidthMonitorInterval = null;
      Logger.info("quality", "Bandwidth monitoring stopped");
    }
  }

  _reportBandwidth() {
    if (!this.hls) return;

    const bwEstimate = this.hls.bandwidthEstimate;
    const currentLevel = this.hls.currentLevel;
    const levelInfo =
      currentLevel >= 0 && this.hls.levels[currentLevel]
        ? this.hls.levels[currentLevel]
        : null;

    if (isNaN(bwEstimate)) {
      Logger.debug("quality", "📊 Bandwidth estimate: not yet available");
      return;
    }

    Logger.debug("quality", "📊 Bandwidth estimate", {
      estimate: `${(bwEstimate / 1000000).toFixed(2)} Mbps`,
      estimateBps: bwEstimate,
      currentLevel: currentLevel === -1 ? "AUTO" : currentLevel,
      currentLevelBitrate: levelInfo
        ? `${(levelInfo.bitrate / 1000000).toFixed(1)} Mbps`
        : "N/A",
      autoLevelEnabled: this.hls.autoLevelEnabled,
    });
  }

  // --------------------------------------------------------------------------
  // ABR Configuration
  // --------------------------------------------------------------------------

  /**
   * Apply ABR profile
   */
  applyABRProfile(profile) {
    if (!this.hls) return;

    const profiles = {
      aggressive: {
        abrEwmaFastLive: 2.0,
        abrEwmaSlowLive: 6.0,
        abrBandWidthFactor: 0.8,
        abrBandWidthUpFactor: 0.5,
        maxStarvationDelay: 2,
        maxLoadingDelay: 2,
      },
      conservative: {
        abrEwmaFastLive: 5.0,
        abrEwmaSlowLive: 15.0,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.8,
        maxStarvationDelay: 6,
        maxLoadingDelay: 6,
      },
      balanced: {
        abrEwmaFastLive: 3.0,
        abrEwmaSlowLive: 9.0,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.7,
        maxStarvationDelay: 4,
        maxLoadingDelay: 4,
      },
    };

    const settings = profiles[profile];
    if (!settings) {
      Logger.error(
        "quality",
        `Unknown ABR profile: ${profile}. Available: ${Object.keys(profiles).join(", ")}`,
      );
      return;
    }

    Logger.info("quality", `Applying ABR profile: ${profile}`, settings);

    Object.entries(settings).forEach(([key, value]) => {
      this.hls.config[key] = value;
    });

    Logger.info("quality", `✓ ABR profile "${profile}" applied`);
  }

  // --------------------------------------------------------------------------
  // Frame Drop Configuration
  // --------------------------------------------------------------------------

  configureFPSDropDetection(enabled = true, threshold = 0.2, period = 5000) {
    if (!this.hls) return;

    Logger.info("quality", "Configuring FPS drop detection", {
      enabled,
      threshold: `${(threshold * 100).toFixed(0)}%`,
      period: `${period}ms`,
    });

    this.hls.config.capLevelOnFPSDrop = enabled;
    this.hls.config.fpsDroppedMonitoringPeriod = period;
    this.hls.config.fpsDroppedMonitoringThreshold = threshold;

    this.fpsMonitorActive = enabled;
  }

  // --------------------------------------------------------------------------
  // Mobile Optimization
  // --------------------------------------------------------------------------

  applyMobileOptimization() {
    if (!this.hls) return;

    Logger.info("quality", "Applying mobile optimization settings");

    this.hls.config.capLevelToPlayerSize = true;
    this.hls.config.maxDevicePixelRatio = 2;
    this.hls.config.minAutoBitrate = 500000;
    this.hls.config.fpsDroppedMonitoringPeriod = 3000;
    this.hls.config.fpsDroppedMonitoringThreshold = 0.15;

    Logger.info("quality", "✓ Mobile optimization applied");
  }

  // --------------------------------------------------------------------------
  // HDR/Video Preference
  // --------------------------------------------------------------------------

  setVideoPreference(preferences) {
    if (!this.hls) return;

    Logger.info("quality", "Setting video preferences", preferences);

    if (preferences.preferHDR !== undefined) {
      this.hls.config.videoPreference = {
        ...this.hls.config.videoPreference,
        preferHDR: preferences.preferHDR,
      };
    }

    if (preferences.allowedVideoRanges) {
      this.hls.config.videoPreference = {
        ...this.hls.config.videoPreference,
        allowedVideoRanges: preferences.allowedVideoRanges,
      };
    }

    if (preferences.videoCodec) {
      this.hls.config.videoPreference = {
        ...this.hls.config.videoPreference,
        videoCodec: preferences.videoCodec,
      };
    }

    Logger.info("quality", "✓ Video preferences updated");
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------

  getQualityStatus() {
    if (!this.hls) return null;

    const currentLevel = this.hls.currentLevel;
    const status = {
      currentLevel: currentLevel,
      currentLevelName:
        currentLevel >= 0
          ? `${this.hls.levels[currentLevel]?.height}p`
          : "AUTO",
      autoLevelEnabled: this.hls.autoLevelEnabled,
      autoLevelCapping: this.hls.autoLevelCapping,
      bandwidthEstimate: this.hls.bandwidthEstimate,
      bandwidthEstimateMbps: isNaN(this.hls.bandwidthEstimate)
        ? "N/A"
        : (this.hls.bandwidthEstimate / 1000000).toFixed(2),
      maxAutoLevel: this.hls.maxAutoLevel,
      levelsAvailable: this.hls.levels?.length || 0,
    };

    Logger.info("quality", "Quality status", status);
    return status;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy() {
    Logger.info("quality", "Destroying QualityController...");

    this.stopBandwidthMonitoring();
    this.fpsMonitorActive = false;

    Logger.info("quality", "✓ QualityController destroyed");
  }
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = QualityController;
}
if (typeof window !== "undefined") {
  window.QualityController = QualityController;
}

Logger.info("quality", "✓ Quality module loaded");
