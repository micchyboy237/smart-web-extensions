/**
 * error.js - Error Handling & Recovery Features
 *
 * Comprehensive error handling for network, media, DRM, and other errors.
 * Implements recovery strategies with cooldown and retry logic.
 */

class ErrorController {
  constructor(player) {
    this.player = player;
    this.hls = player.hls;
    this.video = player.video;

    // Recovery state
    this.lastRecoveryAttempt = null;
    this.recoveryCooldown = 5000; // 5 seconds between recovery attempts
    this.errorCount = 0;
    this.fatalErrorCount = 0;
    this.errorHistory = [];
    this.maxErrorHistory = 100;

    Logger.info("error", "ErrorController initialized");
    this._setupEvents();
  }

  // --------------------------------------------------------------------------
  // Event Setup
  // --------------------------------------------------------------------------

  _setupEvents() {
    if (!this.hls) {
      Logger.warn("error", "hls instance not available for event setup");
      return;
    }

    // Main error handler
    this.hls.on(Hls.Events.ERROR, (event, data) => {
      this._handleError(data);
    });

    // Video element errors
    if (this.video) {
      this.video.addEventListener("error", (event) => {
        this._handleVideoError(event);
      });
    }

    Logger.info("error", "✓ Error events setup");
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  _handleError(data) {
    this.errorCount++;

    // Add to error history
    this.errorHistory.push({
      timestamp: new Date().toISOString(),
      type: data.type,
      details: data.details,
      fatal: data.fatal,
      error: data.error?.message || null,
      errorCount: this.errorCount,
    });

    // Trim history
    if (this.errorHistory.length > this.maxErrorHistory) {
      this.errorHistory.shift();
    }

    const errorMessage = `ERROR [${data.type}]: ${data.details} (fatal: ${data.fatal})`;

    if (data.fatal) {
      this.fatalErrorCount++;
      Logger.error("error", `❌ FATAL ${errorMessage}`, {
        error: data.error?.message,
        stack: data.error?.stack,
        fatalErrorCount: this.fatalErrorCount,
        totalErrors: this.errorCount,
      });

      this._handleFatalError(data);
    } else {
      Logger.warn("error", `⚠️ ${errorMessage}`, {
        error: data.error?.message,
        totalErrors: this.errorCount,
      });

      // Handle specific non-fatal errors
      this._handleNonFatalError(data);
    }
  }

  // --------------------------------------------------------------------------
  // Fatal Error Handler
  // --------------------------------------------------------------------------

  _handleFatalError(data) {
    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        this._handleFatalNetworkError(data);
        break;
      case Hls.ErrorTypes.MEDIA_ERROR:
        this._handleFatalMediaError(data);
        break;
      case Hls.ErrorTypes.KEY_SYSTEM_ERROR:
        this._handleFatalKeySystemError(data);
        break;
      case Hls.ErrorTypes.MUX_ERROR:
        this._handleFatalMuxError(data);
        break;
      case Hls.ErrorTypes.OTHER_ERROR:
        this._handleFatalOtherError(data);
        break;
      default:
        Logger.error(
          "error",
          `❌ Unknown fatal error type: ${data.type}`,
          data,
        );
        this._showErrorUI("Playback failed due to an unexpected error");
        break;
    }
  }

  _handleFatalNetworkError(data) {
    Logger.error("error", "🔌 Fatal network error", {
      details: data.details,
      url: data.url,
      httpCode: data.response?.code,
      error: data.error?.message,
    });

    switch (data.details) {
      case Hls.ErrorDetails.MANIFEST_LOAD_ERROR:
        Logger.error(
          "error",
          "Manifest failed to load - stream may be unavailable",
        );
        this._showErrorUI("Stream unavailable - please check the URL");
        break;
      case Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT:
        Logger.error("error", "Manifest load timed out");
        this._showErrorUI("Stream timed out - please try again");
        break;
      case Hls.ErrorDetails.LEVEL_LOAD_ERROR:
        Logger.error("error", "Level playlist failed to load");
        this._attemptRecovery("level");
        break;
      case Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT:
        Logger.error("error", "Level playlist load timed out");
        this._attemptRecovery("level");
        break;
      default:
        Logger.error("error", `Unhandled network error: ${data.details}`);
        this._showErrorUI("Network error occurred");
        break;
    }
  }

  _handleFatalMediaError(data) {
    Logger.error("error", "📺 Fatal media error", {
      details: data.details,
      error: data.error?.message,
    });

    switch (data.details) {
      case Hls.ErrorDetails.BUFFER_APPEND_ERROR:
        Logger.error("error", "Buffer append error");
        this._attemptMediaRecovery();
        break;
      case Hls.ErrorDetails.BUFFER_APPENDING_ERROR:
        Logger.error("error", "Buffer appending error");
        this._attemptMediaRecovery();
        break;
      case Hls.ErrorDetails.BUFFER_STALLED_ERROR:
        Logger.error("error", "Buffer stalled - attempting recovery");
        this._attemptMediaRecovery();
        break;
      default:
        Logger.error("error", "Unhandled media error - attempting recovery");
        this._attemptMediaRecovery();
        break;
    }
  }

  _handleFatalKeySystemError(data) {
    Logger.error("error", "🔐 Fatal DRM/Key System error", {
      details: data.details,
      error: data.error?.message,
    });

    switch (data.details) {
      case Hls.ErrorDetails.KEY_SYSTEM_NO_KEYS:
        Logger.error("error", "DRM: No keys available");
        this._showErrorUI("DRM error: No decryption keys available");
        break;
      case Hls.ErrorDetails.KEY_SYSTEM_NO_ACCESS:
        Logger.error("error", "DRM: No access to key system");
        this._showErrorUI("DRM error: Key system not accessible");
        break;
      case Hls.ErrorDetails.KEY_SYSTEM_NO_SESSION:
        Logger.error("error", "DRM: No session");
        this._showErrorUI("DRM error: Session creation failed");
        break;
      case Hls.ErrorDetails.KEY_SYSTEM_LICENSE_REQUEST_FAILED:
        Logger.error("error", "DRM: License request failed");
        this._showErrorUI("DRM error: License acquisition failed");
        break;
      default:
        Logger.error("error", "Unhandled key system error");
        this._showErrorUI("DRM playback failed");
        break;
    }
  }

  _handleFatalMuxError(data) {
    Logger.error("error", "🔀 Fatal mux/transmux error", {
      details: data.details,
      error: data.error?.message,
    });
    this._attemptMediaRecovery();
  }

  _handleFatalOtherError(data) {
    Logger.error("error", "❓ Fatal other error", {
      details: data.details,
      error: data.error?.message,
    });

    // Try recovery, but only once
    if (this.fatalErrorCount <= 1) {
      this._attemptMediaRecovery();
    } else {
      this._showErrorUI("Playback failed - too many errors");
    }
  }

  // --------------------------------------------------------------------------
  // Non-Fatal Error Handler
  // --------------------------------------------------------------------------

  _handleNonFatalError(data) {
    // Log and track, but don't interrupt playback
    switch (data.details) {
      case Hls.ErrorDetails.FRAG_LOAD_ERROR:
        Logger.warn("error", "Fragment load error - will retry");
        break;
      case Hls.ErrorDetails.FRAG_LOAD_TIMEOUT:
        Logger.warn("error", "Fragment load timeout - will retry");
        break;
      case Hls.ErrorDetails.FRAG_PARSING_ERROR:
        Logger.warn("error", "Fragment parsing error - skipping");
        break;
      case Hls.ErrorDetails.KEY_LOAD_ERROR:
        Logger.warn("error", "Key load error - will retry");
        break;
      case Hls.ErrorDetails.KEY_LOAD_TIMEOUT:
        Logger.warn("error", "Key load timeout - will retry");
        break;
      case Hls.ErrorDetails.KEY_SYSTEM_STATUS_OUTPUT_RESTRICTED:
        Logger.warn("error", "HDCP output restricted - capping quality");
        break;
      default:
        Logger.warn("error", `Unhandled non-fatal error: ${data.details}`);
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Video Element Error Handler
  // --------------------------------------------------------------------------

  _handleVideoError(event) {
    const mediaError = event.currentTarget?.error;
    if (!mediaError) return;

    const errorMap = {
      [MediaError.MEDIA_ERR_ABORTED]: "Fetch aborted by user",
      [MediaError.MEDIA_ERR_NETWORK]: "Network error",
      [MediaError.MEDIA_ERR_DECODE]: "Decode error",
      [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: "Source not supported",
    };

    const description =
      errorMap[mediaError.code] || `Unknown error (${mediaError.code})`;

    Logger.error("error", `🎬 Video element error: ${description}`, {
      code: mediaError.code,
      message: mediaError.message,
    });

    // Attempt recovery for decode errors
    if (mediaError.code === MediaError.MEDIA_ERR_DECODE) {
      Logger.info("error", "Attempting recovery from decode error");
      this._attemptMediaRecovery();
    }
  }

  // ==========================================================================
  // Recovery Strategies
  // ==========================================================================

  _attemptMediaRecovery() {
    const now = Date.now();

    if (
      this.lastRecoveryAttempt &&
      now - this.lastRecoveryAttempt < this.recoveryCooldown
    ) {
      const remainingCooldown = Math.ceil(
        (this.recoveryCooldown - (now - this.lastRecoveryAttempt)) / 1000,
      );
      Logger.warn(
        "error",
        `Recovery on cooldown - ${remainingCooldown}s remaining before next attempt`,
      );
      return;
    }

    this.lastRecoveryAttempt = now;

    Logger.info("error", "🔄 Attempting media error recovery...", {
      attemptTime: new Date().toISOString(),
      previousAttempt:
        this.errorHistory.length > 0
          ? this.errorHistory[this.errorHistory.length - 1]?.details
          : "none",
    });

    if (this.hls) {
      this.hls.recoverMediaError();
      Logger.info("error", "✓ Media recovery initiated");
    } else {
      Logger.error("error", "Cannot recover: hls instance not available");
    }
  }

  _attemptRecovery(source) {
    const now = Date.now();

    if (
      this.lastRecoveryAttempt &&
      now - this.lastRecoveryAttempt < this.recoveryCooldown
    ) {
      Logger.warn("error", `Recovery on cooldown for ${source}`);
      return;
    }

    this.lastRecoveryAttempt = now;

    Logger.info("error", `🔄 Attempting ${source} recovery...`);

    switch (source) {
      case "level":
        if (this.hls) {
          // Try to reload the current level
          this.hls.startLoad();
          Logger.info(
            "error",
            "✓ Level recovery initiated - restarting loading",
          );
        }
        break;
      case "manifest":
        // Manifest recovery would need to reload the source
        Logger.info("error", "Manifest recovery requires source reload");
        break;
      case "network":
        if (this.hls) {
          this.hls.startLoad();
          Logger.info("error", "✓ Network recovery initiated");
        }
        break;
      default:
        Logger.info("error", `No specific recovery for: ${source}`);
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Error UI
  // --------------------------------------------------------------------------

  _showErrorUI(message) {
    Logger.error("error", `Showing error UI: ${message}`);

    const errorOverlay = document.getElementById("errorOverlay");
    const errorMessage = document.getElementById("errorMessage");

    if (errorOverlay && errorMessage) {
      errorMessage.textContent = message;
      errorOverlay.style.display = "flex";
      Logger.debug("error", "Error overlay displayed");
    } else {
      Logger.warn("error", "Error UI elements not found in DOM");
    }
  }

  hideErrorUI() {
    const errorOverlay = document.getElementById("errorOverlay");
    if (errorOverlay) {
      errorOverlay.style.display = "none";
      Logger.debug("error", "Error overlay hidden");
    }
  }

  // --------------------------------------------------------------------------
  // Manual Recovery
  // --------------------------------------------------------------------------

  manualRecover() {
    Logger.info("error", "🔄 Manual recovery requested by user");
    this.hideErrorUI();
    this._attemptMediaRecovery();
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------

  getErrorStatus() {
    const status = {
      totalErrors: this.errorCount,
      fatalErrors: this.fatalErrorCount,
      lastRecoveryAttempt: this.lastRecoveryAttempt
        ? new Date(this.lastRecoveryAttempt).toISOString()
        : null,
      recentErrors: this.errorHistory.slice(-5),
    };

    Logger.info("error", "Error status", status);
    return status;
  }

  getErrorHistory(limit = 20) {
    return this.errorHistory.slice(-limit);
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy() {
    Logger.info("error", "Destroying ErrorController...");
    this.errorHistory = [];
    Logger.info("error", "✓ ErrorController destroyed");
  }
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = ErrorController;
}
if (typeof window !== "undefined") {
  window.ErrorController = ErrorController;
}

Logger.info("error", "✓ Error handling module loaded");
