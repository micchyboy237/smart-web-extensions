/**
 * Centralized debug logging system
 * Supports multiple log levels with visual indicators
 */
export const DebugLogger = (() => {
  const levels = {
    INFO: "🔵",
    SUCCESS: "🟢",
    WARN: "🟡",
    ERROR: "🔴",
    BOOST: "🚀",
    PANEL: "📊",
    DOM: "🏗️",
    CLEANUP: "🗑️",
    STATE: "📦",
  };

  let enabled = true;

  return {
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
    },
    isEnabled() {
      return enabled;
    },

    log(level, message, data = null) {
      if (!enabled) return;
      const ts = new Date().toLocaleTimeString();
      const prefix = levels[level] || "📝";
      console.log(`${prefix} [Reddit ${ts}] ${message}`, data || "");
    },

    error(message, error) {
      this.log("ERROR", message);
      if (error) console.error(error);
    },

    group(label, fn) {
      if (!enabled) {
        fn?.();
        return;
      }
      console.group(`📦 [Reddit] ${label}`);
      fn?.();
      console.groupEnd();
    },
  };
})();
