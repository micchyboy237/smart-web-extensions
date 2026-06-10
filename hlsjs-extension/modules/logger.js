/**
 * logger.js - Centralized Logging System
 *
 * Provides structured, timestamped logging across all feature modules.
 * Supports log levels, module tagging, and persistent log history.
 */

// ============================================================================
// Logger Class - Singleton
// ============================================================================
class HlsExtensionLogger {
  constructor() {
    if (HlsExtensionLogger.instance) {
      return HlsExtensionLogger.instance;
    }
    HlsExtensionLogger.instance = this;

    this.logHistory = [];
    this.maxHistorySize = 500;
    this.listeners = [];
    this.logLevel = "debug"; // debug, info, warn, error

    console.log("[Logger] ✓ Centralized logging system initialized");
    this._log("system", "info", "Logger initialized successfully");
  }

  // --------------------------------------------------------------------------
  // Log Level Methods
  // --------------------------------------------------------------------------

  debug(module, message, data = null) {
    this._log(module, "debug", message, data);
  }

  info(module, message, data = null) {
    this._log(module, "info", message, data);
  }

  warn(module, message, data = null) {
    this._log(module, "warn", message, data);
  }

  error(module, message, data = null) {
    this._log(module, "error", message, data);
  }

  // --------------------------------------------------------------------------
  // Core Logging Method
  // --------------------------------------------------------------------------

  _log(module, level, message, data = null) {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      module,
      level,
      message,
      data: data ? JSON.parse(JSON.stringify(data)) : null,
      id: this.logHistory.length + 1,
    };

    // Add to history
    this.logHistory.push(entry);

    // Trim history if needed
    if (this.logHistory.length > this.maxHistorySize) {
      this.logHistory.shift();
    }

    // Console output with styling
    const prefix = `[${timestamp.split("T")[1].split(".")[0]}] [${module}]`;
    const formattedMessage = `${prefix} ${message}`;

    switch (level) {
      case "debug":
        console.debug(formattedMessage, data || "");
        break;
      case "info":
        console.info(formattedMessage, data || "");
        break;
      case "warn":
        console.warn(formattedMessage, data || "");
        break;
      case "error":
        console.error(formattedMessage, data || "");
        break;
    }

    // Notify listeners
    this._notifyListeners(entry);
  }

  // --------------------------------------------------------------------------
  // Listener Management for Real-time Log Display
  // --------------------------------------------------------------------------

  addListener(callback) {
    this.listeners.push(callback);
    console.log(
      `[Logger] Listener added. Total listeners: ${this.listeners.length}`,
    );
    return () => this.removeListener(callback);
  }

  removeListener(callback) {
    this.listeners = this.listeners.filter((cb) => cb !== callback);
    console.log(
      `[Logger] Listener removed. Total listeners: ${this.listeners.length}`,
    );
  }

  _notifyListeners(entry) {
    this.listeners.forEach((callback) => {
      try {
        callback(entry);
      } catch (e) {
        console.error("[Logger] Listener error:", e);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  getHistory(module = null, level = null, limit = 100) {
    let filtered = [...this.logHistory];

    if (module) {
      filtered = filtered.filter((entry) => entry.module === module);
    }
    if (level) {
      filtered = filtered.filter((entry) => entry.level === level);
    }

    return filtered.slice(-limit);
  }

  clear() {
    const count = this.logHistory.length;
    this.logHistory = [];
    console.log(`[Logger] Cleared ${count} log entries`);
    return count;
  }

  getModuleSummary(module) {
    const entries = this.getHistory(module);
    return {
      total: entries.length,
      debug: entries.filter((e) => e.level === "debug").length,
      info: entries.filter((e) => e.level === "info").length,
      warn: entries.filter((e) => e.level === "warn").length,
      error: entries.filter((e) => e.level === "error").length,
      lastEntry: entries.length > 0 ? entries[entries.length - 1] : null,
    };
  }

  setLogLevel(level) {
    this.logLevel = level;
    console.log(`[Logger] Log level set to: ${level}`);
  }
}

// Create and export singleton instance
const Logger = new HlsExtensionLogger();

// Export for use in other modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = Logger;
}
// For Chrome extension (global scope)
if (typeof window !== "undefined") {
  window.HlsExtensionLogger = HlsExtensionLogger;
  window.Logger = Logger;
}

console.log("[Logger] ✓ Module loaded");
Logger.info("logger", "Logger module initialized and ready");
