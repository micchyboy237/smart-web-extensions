/**
 * All configurable constants in one place
 */
export const BOOST_CONFIG = Object.freeze({
  BUFFER_LOW: 5,
  BOOST_DURATION: 8000,
  INITIAL_BUFFER_TARGET: 12,
  SEEK_BOOST_RATE: 1.5,
  SEEK_BOOST_DURATION: 10000,
  SEEK_MIN_EFFECTIVE_RATIO: 0.6,
  SEEK_BOOST_EXTENSION: 5000,
  MAX_BOOST_EXTENSIONS: 3,
  MAX_TOTAL_BOOST_MS: 30000,
  BOOST_RATE_NORMAL: 1.08,
});

export const DOM_CONFIG = Object.freeze({
  PLAYER_SELECTOR: "shreddit-player", // ✅ FIXED: was "shreddit-post"
  FEED_SELECTOR: "shreddit-feed",
  FALLBACK_SELECTOR: "main",
  INITIAL_SCAN_DELAY: 3000,
  DEBOUNCE_DELAY: 1000,
  PANEL_UPDATE_INTERVAL: 1000,
  // Retry scan if no players found (Reddit loads async)
  MAX_SCAN_RETRIES: 5,
  SCAN_RETRY_DELAY: 2000,
});

export const PANEL_CONFIG = Object.freeze({
  Z_INDEX: 2147483646,
  DEFAULT_WIDTH: 320,
  MAX_HEIGHT_VH: 80,
  MIN_HEIGHT: 100,
});
