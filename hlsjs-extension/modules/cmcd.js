/**
 * cmcd.js - CMCD Reporting & Analytics Features
 *
 * Manages Common Media Client Data (CMCD) reporting for analytics.
 * Configures CMCD v1/v2 parameters, custom data, and event targets.
 */

class CMCDController {
  constructor(player) {
    this.player = player;
    this.hls = player.hls;
    this.video = player.video;

    // CMCD state
    this.isEnabled = false;
    this.reporter = null;
    this.customData = {};

    Logger.info("cmcd", "CMCDController initialized");
  }

  // ==========================================================================
  // CMCD Configuration
  // ==========================================================================

  /**
   * Enable CMCD v1 (query string based)
   */
  enableCMCDv1(config = {}) {
    if (!this.hls) {
      Logger.error("cmcd", "Cannot enable CMCD: hls not available");
      return;
    }

    Logger.info("cmcd", "Enabling CMCD v1 reporting");

    this.hls.config.cmcd = {
      sessionId: config.sessionId || this._generateUUID(),
      contentId: config.contentId || `content-${Date.now()}`,
      useHeaders: config.useHeaders || false,
      includeKeys: config.includeKeys || ["br", "bl", "cid", "sid", "sf"],
    };

    this.isEnabled = true;

    Logger.info("cmcd", "✓ CMCD v1 enabled", {
      sessionId: this.hls.config.cmcd.sessionId,
      contentId: this.hls.config.cmcd.contentId,
      useHeaders: this.hls.config.cmcd.useHeaders,
      includeKeys: this.hls.config.cmcd.includeKeys,
    });
  }

  /**
   * Enable CMCD v2 (with event targets)
   */
  enableCMCDv2(config = {}) {
    if (!this.hls) {
      Logger.error("cmcd", "Cannot enable CMCD: hls not available");
      return;
    }

    Logger.info("cmcd", "Enabling CMCD v2 reporting");

    this.hls.config.cmcd = {
      version: 2,
      contentId: config.contentId || `content-${Date.now()}`,
      includeKeys: config.includeKeys || [
        "sid",
        "cid",
        "sf",
        "st",
        "su",
        "bl",
        "br",
        "mtp",
      ],
      eventTargets: config.eventTargets || [],
      reporterCallback: (reporter) => {
        this.reporter = reporter;
        Logger.info("cmcd", "✓ CMCD reporter initialized");

        // Set custom data if provided
        if (config.customData) {
          reporter.updateCustomData(config.customData);
          Logger.info("cmcd", "Custom data set", config.customData);
        }

        // Store reporter for external use
        if (config.onReporterReady) {
          config.onReporterReady(reporter);
        }
      },
    };

    this.isEnabled = true;

    Logger.info("cmcd", "✓ CMCD v2 enabled", {
      contentId: this.hls.config.cmcd.contentId,
      eventTargets: this.hls.config.cmcd.eventTargets?.length || 0,
    });
  }

  /**
   * Configure CMCD with analytics endpoint
   */
  configureAnalyticsEndpoint(endpointUrl, options = {}) {
    if (!this.reporter) {
      Logger.warn(
        "cmcd",
        "CMCD reporter not initialized - cannot configure endpoint",
      );
      return;
    }

    Logger.info("cmcd", "Configuring CMCD analytics endpoint", {
      url: endpointUrl,
      events: options.events || ["ps", "bc", "e", "ce", "t"],
      interval: options.interval || 30,
      batchSize: options.batchSize || 5,
    });

    // Note: This would typically be done during initialization
    // Here we log the configuration intent
    Logger.info("cmcd", "Analytics endpoint configuration logged");
  }

  // ==========================================================================
  // Custom Data Management
  // ==========================================================================

  /**
   * Update custom CMCD data at runtime
   */
  updateCustomData(data) {
    if (!this.reporter) {
      Logger.warn(
        "cmcd",
        "CMCD reporter not initialized - storing data locally",
      );
      this.customData = { ...this.customData, ...data };
      return;
    }

    Logger.info("cmcd", "Updating CMCD custom data", data);
    this.reporter.updateCustomData(data);
    this.customData = { ...this.customData, ...data };
  }

  /**
   * Set content chapter
   */
  setChapter(chapterName) {
    Logger.info("cmcd", `Setting chapter: ${chapterName}`);
    this.updateCustomData({
      "com.myco-chapter": chapterName,
    });
  }

  /**
   * Set ad break status
   */
  setAdBreakStatus(isAdBreak) {
    const status = String(isAdBreak);
    Logger.info("cmcd", `Setting ad break status: ${status}`);
    this.updateCustomData({
      "com.myco-adBreak": status,
    });
  }

  // --------------------------------------------------------------------------
  // Custom Event Recording
  // --------------------------------------------------------------------------

  /**
   * Record a custom CMCD event
   */
  recordCustomEvent(eventType, eventData = {}) {
    if (!this.reporter) {
      Logger.warn(
        "cmcd",
        "CMCD reporter not initialized - cannot record event",
      );
      return;
    }

    Logger.info("cmcd", `Recording custom CMCD event: ${eventType}`, eventData);
    this.reporter.recordCustomEvent(eventType, eventData);
  }

  /**
   * Track user action
   */
  trackUserAction(action) {
    Logger.info("cmcd", `Tracking user action: ${action}`);
    this.recordCustomEvent("user-action", {
      "action-type": action,
      timestamp: new Date().toISOString(),
    });
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  _generateUUID() {
    const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      },
    );

    Logger.debug("cmcd", `Generated CMCD session ID: ${uuid}`);
    return uuid;
  }

  /**
   * Get CMCD status
   */
  getCMCDStatus() {
    const status = {
      enabled: this.isEnabled,
      version: this.hls?.config?.cmcd?.version || "N/A",
      contentId: this.hls?.config?.cmcd?.contentId || "N/A",
      sessionId: this.hls?.config?.cmcd?.sessionId || "N/A",
      reporterInitialized: !!this.reporter,
      customData: { ...this.customData },
    };

    Logger.info("cmcd", "CMCD status", status);
    return status;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy() {
    Logger.info("cmcd", "Destroying CMCDController...");
    this.reporter = null;
    this.customData = {};
    this.isEnabled = false;
    Logger.info("cmcd", "✓ CMCDController destroyed");
  }
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = CMCDController;
}
if (typeof window !== "undefined") {
  window.CMCDController = CMCDController;
}

Logger.info("cmcd", "✓ CMCD module loaded");
