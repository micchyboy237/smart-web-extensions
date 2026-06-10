/**
 * drm.js - DRM & Content Protection Features
 *
 * Manages DRM configuration, license requests, key system handling,
 * and HDCP restrictions.
 */

class DRMController {
  constructor(player) {
    this.player = player;
    this.hls = player.hls;
    this.video = player.video;

    // DRM state
    this.isDRMEnabled = false;
    this.configuredSystems = [];
    this.licenseRequestCount = 0;
    this.licenseSuccessCount = 0;
    this.licenseFailCount = 0;

    Logger.info("drm", "DRMController initialized");
    this._setupEvents();
  }

  // --------------------------------------------------------------------------
  // Event Setup
  // --------------------------------------------------------------------------

  _setupEvents() {
    if (!this.hls) {
      Logger.warn("drm", "hls instance not available for event setup");
      return;
    }

    // Key system errors
    this.hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.type === Hls.ErrorTypes.KEY_SYSTEM_ERROR) {
        this._handleKeySystemError(data);
      }
    });

    // Key loading
    this.hls.on(Hls.Events.KEY_LOADING, (event, data) => {
      Logger.debug("drm", "🔑 Key loading...", {
        frag: data.frag?.relurl,
      });
    });

    this.hls.on(Hls.Events.KEY_LOADED, (event, data) => {
      Logger.info("drm", "✓ Key loaded successfully", {
        frag: data.frag?.relurl,
      });
    });

    Logger.info("drm", "✓ DRM events setup");
  }

  // ==========================================================================
  // DRM Configuration
  // ==========================================================================

  /**
   * Configure Widevine DRM
   */
  configureWidevine(licenseUrl, options = {}) {
    if (!this.hls) {
      Logger.error("drm", "Cannot configure Widevine: hls not available");
      return;
    }

    Logger.info("drm", "Configuring Widevine DRM", {
      licenseUrl: licenseUrl.substring(0, 50) + "...",
      withCredentials: options.withCredentials || false,
    });

    const drmConfig = {
      emeEnabled: true,
      drmSystems: {
        ...this.hls.config.drmSystems,
        "com.widevine.alpha": {
          licenseUrl,
          ...options,
        },
      },
    };

    // Apply configuration
    this.hls.config.emeEnabled = true;
    if (!this.hls.config.drmSystems) {
      this.hls.config.drmSystems = {};
    }
    this.hls.config.drmSystems["com.widevine.alpha"] = {
      licenseUrl,
      ...options,
    };

    this.isDRMEnabled = true;
    this.configuredSystems.push("widevine");

    Logger.info("drm", "✓ Widevine DRM configured");
  }

  /**
   * Configure PlayReady DRM
   */
  configurePlayReady(licenseUrl, options = {}) {
    if (!this.hls) {
      Logger.error("drm", "Cannot configure PlayReady: hls not available");
      return;
    }

    Logger.info("drm", "Configuring PlayReady DRM", {
      licenseUrl: licenseUrl.substring(0, 50) + "...",
    });

    this.hls.config.emeEnabled = true;
    if (!this.hls.config.drmSystems) {
      this.hls.config.drmSystems = {};
    }
    this.hls.config.drmSystems["com.microsoft.playready"] = {
      licenseUrl,
      ...options,
    };

    this.isDRMEnabled = true;
    this.configuredSystems.push("playready");

    Logger.info("drm", "✓ PlayReady DRM configured");
  }

  /**
   * Configure FairPlay DRM
   */
  configureFairPlay(certificateUrl, licenseUrl, options = {}) {
    if (!this.hls) {
      Logger.error("drm", "Cannot configure FairPlay: hls not available");
      return;
    }

    Logger.info("drm", "Configuring FairPlay DRM", {
      certificateUrl: certificateUrl.substring(0, 50) + "...",
      licenseUrl: licenseUrl.substring(0, 50) + "...",
    });

    this.hls.config.emeEnabled = true;
    if (!this.hls.config.drmSystems) {
      this.hls.config.drmSystems = {};
    }
    this.hls.config.drmSystems["com.apple.fps.1_0"] = {
      certificateUrl,
      licenseUrl,
      ...options,
    };

    this.isDRMEnabled = true;
    this.configuredSystems.push("fairplay");

    Logger.info("drm", "✓ FairPlay DRM configured");
  }

  // --------------------------------------------------------------------------
  // License Request Configuration
  // --------------------------------------------------------------------------

  /**
   * Configure custom license request handling
   */
  configureLicenseRequest(options) {
    if (!this.hls) return;

    Logger.info("drm", "Configuring custom license request handling");

    if (options.licenseXhrSetup) {
      this.hls.config.licenseXhrSetup = (
        xhr,
        url,
        keyContext,
        licenseChallenge,
      ) => {
        Logger.info("drm", "📤 License XHR request", {
          url: url.substring(0, 50) + "...",
          keyContext,
        });

        return options.licenseXhrSetup(xhr, url, keyContext, licenseChallenge);
      };
      Logger.info("drm", "✓ Custom license XHR setup configured");
    }

    if (options.licenseResponseCallback) {
      this.hls.config.licenseResponseCallback = (xhr, url, keyContext) => {
        Logger.info("drm", "📥 License response received", {
          url: url.substring(0, 50) + "...",
          status: xhr.status,
        });

        this.licenseSuccessCount++;
        return options.licenseResponseCallback(xhr, url, keyContext);
      };
      Logger.info("drm", "✓ Custom license response callback configured");
    }
  }

  // --------------------------------------------------------------------------
  // DRM System Options
  // --------------------------------------------------------------------------

  /**
   * Set DRM system options (robustness, persistent state, etc.)
   */
  setDRMSystemOptions(options) {
    if (!this.hls) return;

    Logger.info("drm", "Setting DRM system options", options);

    this.hls.config.drmSystemOptions = {
      ...this.hls.config.drmSystemOptions,
      ...options,
    };

    Logger.info("drm", "✓ DRM system options updated");
  }

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  _handleKeySystemError(data) {
    this.licenseFailCount++;

    Logger.error("drm", "🔐 DRM/Key system error", {
      details: data.details,
      fatal: data.fatal,
      error: data.error?.message,
    });

    switch (data.details) {
      case Hls.ErrorDetails.KEY_SYSTEM_NO_KEYS:
        Logger.error("drm", "No decryption keys available");
        break;
      case Hls.ErrorDetails.KEY_SYSTEM_NO_ACCESS:
        Logger.error("drm", "No access to key system");
        break;
      case Hls.ErrorDetails.KEY_SYSTEM_NO_SESSION:
        Logger.error("drm", "Failed to create media key session");
        break;
      case Hls.ErrorDetails.KEY_SYSTEM_LICENSE_REQUEST_FAILED:
        Logger.error("drm", "License request failed");
        break;
      case Hls.ErrorDetails.KEY_SYSTEM_STATUS_OUTPUT_RESTRICTED:
        Logger.warn("drm", "HDCP output restricted - capping level", {
          maxHdcpLevel: this.hls?.maxHdcpLevel,
        });
        break;
      default:
        Logger.error("drm", `Unhandled key system error: ${data.details}`);
        break;
    }
  }

  // --------------------------------------------------------------------------
  // HDCP
  // --------------------------------------------------------------------------

  getHDCPStatus() {
    if (!this.hls) return null;

    return {
      maxHdcpLevel: this.hls.maxHdcpLevel,
      currentHdcpLevel: this.video?.mediaKeys?.getStatus?.() || "unknown",
    };
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------

  getDRMStatus() {
    const status = {
      drmEnabled: this.isDRMEnabled,
      configuredSystems: this.configuredSystems,
      licenseRequests: this.licenseRequestCount,
      licenseSuccesses: this.licenseSuccessCount,
      licenseFailures: this.licenseFailCount,
      hdcp: this.getHDCPStatus(),
    };

    Logger.info("drm", "DRM status", status);
    return status;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy() {
    Logger.info("drm", "Destroying DRMController...");
    this.configuredSystems = [];
    Logger.info("drm", "✓ DRMController destroyed");
  }
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = DRMController;
}
if (typeof window !== "undefined") {
  window.DRMController = DRMController;
}

Logger.info("drm", "✓ DRM module loaded");
