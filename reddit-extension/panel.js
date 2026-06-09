// panel.js - Floating Panel Creation and Management
// Creates the Video Observer floating panel with tabs and controls

(function () {
  "use strict";

  console.log("[Panel] Module loading...");

  let panel = null;
  let isPanelVisible = true;

  /**
   * Create the floating video observer panel
   */
  function createFloatingPanel() {
    if (panel) return panel;

    console.log("[Panel] Creating floating panel...");

    panel = document.createElement("div");
    panel.id = "video-observer-panel";

    panel.innerHTML = `
      <header>
        🎥 Video Observer 
        <button class="close-btn" id="toggle-panel">✕</button>
      </header>
      <div class="tabs">
        <div class="tab active" data-tab="videos">
          Videos (<span id="video-count">0</span>)
        </div>
        <div class="tab" data-tab="logs">
          Logs
        </div>
      </div>
      <div id="videos-tab" class="content">
        <div id="videos-list"></div>
        <div id="empty-videos">
          No videos detected yet<br>
          <small>Click card to toggle play/pause + scroll</small>
        </div>
      </div>
      <div id="logs-tab" class="content" style="display:none">
        <div id="logs" class="log-container"></div>
      </div>
      <div class="status">
        Observing <strong>.message-inner video</strong> • 
        ${new Date().toLocaleTimeString()}
      </div>
    `;

    document.body.appendChild(panel);

    // Tab switching
    panel.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        panel
          .querySelectorAll(".tab")
          .forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");

        panel.querySelector("#videos-tab").style.display =
          tab.dataset.tab === "videos" ? "block" : "none";
        panel.querySelector("#logs-tab").style.display =
          tab.dataset.tab === "logs" ? "block" : "none";

        console.log(`[Panel] Switched to ${tab.dataset.tab} tab`);
      });
    });

    // Toggle panel visibility
    panel.querySelector("#toggle-panel").addEventListener("click", () => {
      isPanelVisible = !isPanelVisible;
      panel.style.display = isPanelVisible ? "flex" : "none";

      if (!isPanelVisible) {
        const currentlyPlaying = window.__getCurrentlyPlaying();
        if (currentlyPlaying) {
          currentlyPlaying.pause();
          window.__setCurrentlyPlaying(null);
        }
      }

      console.log(
        `[Panel] Visibility toggled: ${isPanelVisible ? "visible" : "hidden"}`,
      );
    });

    // Initialize scroll tracking after panel is in DOM
    if (window.CardManager && window.CardManager.initCardVisibilityObserver) {
      window.CardManager.initCardVisibilityObserver();
    }

    // Perform initial update after a short delay
    setTimeout(() => {
      if (window.CardManager && window.CardManager.performPanelUpdate) {
        window.CardManager.performPanelUpdate();
      }
    }, 100);

    console.log("[Panel] Floating panel created successfully ✅");
    return panel;
  }

  /**
   * Get the panel element
   */
  function getPanel() {
    return panel;
  }

  /**
   * Check if panel is visible
   */
  function isPanelCurrentlyVisible() {
    return isPanelVisible;
  }

  /**
   * Log a message to the panel's log tab
   */
  function logToPanel(message, data = null) {
    const ts = new Date().toLocaleTimeString();

    // Console log
    console.log(`[nsfwPH ${ts}] ${message}`, data || "");

    // Panel log
    if (panel && window.__tabIsVisible) {
      const logsEl = panel.querySelector("#logs");
      if (logsEl) {
        const entry = document.createElement("div");
        entry.textContent = `[${ts}] ${message}`;
        logsEl.prepend(entry);

        // Keep only last 60 entries
        if (logsEl.children.length > 60) {
          logsEl.removeChild(logsEl.lastChild);
        }
      }
    }
  }

  /**
   * Update the panel status bar
   */
  function updateStatus(text) {
    if (!panel) return;

    const statusEl = panel.querySelector(".status");
    if (statusEl) {
      statusEl.innerHTML = text;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPORT TO GLOBAL SCOPE
  // ═══════════════════════════════════════════════════════════════

  window.PanelManager = {
    createFloatingPanel,
    getPanel,
    isPanelVisible: isPanelCurrentlyVisible,
    logToPanel,
    updateStatus,
  };

  console.log("[Panel] Module loaded successfully ✅");
})();
