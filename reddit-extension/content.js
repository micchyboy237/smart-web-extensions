/**
 * content.js - Reddit Video Extension Entry Point
 * Uses dynamic import() to work as a classic MV3 content script.
 */
(async () => {
  const { DebugLogger: debug } = await import(
    chrome.runtime.getURL("src/core/debug.js")
  );
  const { AppState } = await import(chrome.runtime.getURL("src/core/state.js"));
  const { DOM_CONFIG } = await import(
    chrome.runtime.getURL("src/core/config.js")
  );
  const { scanForPlayers } = await import(
    chrome.runtime.getURL("src/tracker/player-tracker.js")
  );
  const { DOMObserver } = await import(
    chrome.runtime.getURL("src/tracker/dom-observer.js")
  );
  const { FloatingPanel } = await import(
    chrome.runtime.getURL("src/panel/floating-panel.js")
  );
  const { PlaybackController } = await import(
    chrome.runtime.getURL("src/controllers/playback-controller.js")
  );
  const { KeyboardController } = await import(
    chrome.runtime.getURL("src/controllers/keyboard-controller.js")
  );
  const { BoostEngine } = await import(
    chrome.runtime.getURL("src/engine/boost-engine.js")
  );

  // Debounced scroll handler
  let scrollTimer = null;
  function onScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      BoostEngine.recalculateWindow();
    }, 500); // Recalculate 500ms after scrolling stops
  }

  function onTabHidden() {
    AppState.setTabVisible(false);
    BoostEngine.stopAll();
    PlaybackController.pauseCurrent();
    FloatingPanel.stopAutoUpdate();
    debug.log("INFO", "Tab hidden - paused");
  }

  function onTabVisible() {
    AppState.setTabVisible(true);
    scanForPlayers();
    setTimeout(() => {
      FloatingPanel.performUpdate();
      BoostEngine.recalculateWindow(); // Recalculate boosts
    }, 200);
    FloatingPanel.startAutoUpdate();
    debug.log("INFO", "Tab visible - resumed");
  }

  function init() {
    if (window.__REDDIT_OBSERVER_INIT__) return;
    window.__REDDIT_OBSERVER_INIT__ = true;

    debug.log("SUCCESS", "=== Init: Panel + Boost ===");

    FloatingPanel.create();

    setTimeout(() => {
      scanForPlayers();
      setTimeout(() => {
        FloatingPanel.performUpdate();
        BoostEngine.recalculateWindow(); // Initial boost calculation
      }, 200);
      FloatingPanel.startAutoUpdate();
    }, DOM_CONFIG.INITIAL_SCAN_DELAY);

    DOMObserver.start();
    KeyboardController.init();

    // Listen for scroll events to recalculate boost window
    window.addEventListener("scroll", onScroll, { passive: true });

    document.addEventListener("visibilitychange", () => {
      document.hidden ? onTabHidden() : onTabVisible();
    });

    debug.log("SUCCESS", "=== Ready ===");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
