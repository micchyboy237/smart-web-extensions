// Main content script - orchestrates all modules
console.log("[AWS] Content script loaded on:", window.location.href);
// Global state for content script
if (!window.AWSContent) {
  window.AWSContent = {};
}
Object.assign(window.AWSContent, {
  mutationObserver: null,
  itemObservers: [], // Track individual item observers
  extractionCheckInterval: null, // Polling interval for extraction readiness
  lastItemCount: 0, // Track item count changes
  /**
   * Initialize the extension
   */
  async initialize() {
    console.log("[AWS] Initializing extension");
    // Check if modules are loaded
    if (
      !window.AWSPanel ||
      !window.AWSExtractor ||
      !window.AWSNavigation ||
      !window.AWSAutomation ||
      !window.AWSStorage
    ) {
      console.error("[AWS] Modules not loaded properly");
      return;
    }
    // Inject panel
    window.AWSPanel.inject();
    // Wait for schedule block to be available
    await this.waitForScheduleBlock();
    // Setup MutationObserver
    this.setupMutationObserver();
    // Setup panel listeners
    window.AWSPanel.setupListeners();
    // Load initial data and set default dates
    setTimeout(async () => {
      await window.AWSPanel.loadAndDisplayData();
      await window.AWSPanel.setDefaultDates();
    }, 1000);
  },
  /**
   * Wait for schedule block to exist
   */
  waitForScheduleBlock(retries = 10) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const scheduleBlock = document.querySelector("#schedule-block");
        if (scheduleBlock) {
          console.log("[AWS] Schedule block found");
          resolve();
        } else if (retries > 0) {
          console.log(
            `[AWS] Schedule block not found, retrying... (${retries} attempts left)`,
          );
          setTimeout(() => {
            check();
          }, 500);
        } else {
          console.error("[AWS] Schedule block not found after retries");
          reject(new Error("Schedule block not found"));
        }
      };
      check();
    });
  },
  /**
   * Setup MutationObserver to watch for anime items loading
   * Following reference pattern: observe the FIRST .item element directly
   */
  setupMutationObserver() {
    console.log("[AWS] Setting up MutationObserver");

    // Disconnect any existing observers
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
    }
    this.itemObservers.forEach((obs) => obs.disconnect());
    this.itemObservers = [];

    // CRITICAL: Use the EXACT selector from reference script
    // This observes the first .item element, not the container
    const firstItemElement = document.querySelector(
      "#schedule-block .body .items .item",
    );

    if (!firstItemElement) {
      console.warn(
        "[AWS] First .item element not found with selector: #schedule-block .body .items .item",
      );

      // Fallback: try to find any .item element
      const anyItem = document.querySelector("#schedule-block a.item");
      if (anyItem) {
        console.log("[AWS] Found alternative .item element, using it");
        this.observeItemElement(anyItem);
      } else {
        console.error("[AWS] No .item elements found at all");
        return;
      }
    } else {
      console.log(
        "[AWS] Found first .item element:",
        firstItemElement.className,
      );
      console.log(
        "[AWS] Observing first .item element (following reference pattern)",
      );

      // Observe the first item element exactly like the reference
      this.mutationObserver = new MutationObserver((mutations) => {
        console.log("[AWS] 🔍 Mutation:", mutations.length, "changes");

        mutations.forEach((mutation) => {
          console.log(`[AWS] Mutation type: ${mutation.type}`, mutation);
        });

        // When the item changes, check if we should extract
        this.checkAndExtractIfReady();
      });

      this.mutationObserver.observe(firstItemElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      console.log("[AWS] Observer on first .item element started");
    }

    // Also set up polling as backup since reference shows mutations might be 0
    this.startExtractionPolling();
  },

  /**
   * Start polling to check for extraction readiness
   * This is a backup since MutationObserver might not catch all changes
   */
  startExtractionPolling() {
    console.log("[AWS] Starting extraction readiness polling");

    // Clear any existing interval
    if (this.extractionCheckInterval) {
      clearInterval(this.extractionCheckInterval);
    }

    // Check every 500ms for item count changes
    this.extractionCheckInterval = setInterval(() => {
      if (
        !window.AWSAutomation.autoExtractEnabled ||
        !window.AWSAutomation.isRunning
      ) {
        return;
      }

      const items = document.querySelectorAll(
        "#schedule-block .body .items a.item",
      );
      const currentCount = items.length;

      if (currentCount !== this.lastItemCount) {
        console.log(
          `[AWS] Item count changed: ${this.lastItemCount} -> ${currentCount}`,
        );
        this.lastItemCount = currentCount;

        if (currentCount > 0) {
          console.log(
            `[AWS] Detected ${currentCount} items via polling - triggering extraction`,
          );
          this.checkAndExtractIfReady();
        }
      }
    }, 500);
  },

  /**
   * Stop extraction polling
   */
  stopExtractionPolling() {
    if (this.extractionCheckInterval) {
      clearInterval(this.extractionCheckInterval);
      this.extractionCheckInterval = null;
      console.log("[AWS] Stopped extraction polling");
    }
  },

  /**
   * Set up observer on a single .item element
   */
  observeItemElement(itemElement) {
    const observer = new MutationObserver((mutations) => {
      console.log(`[AWS] Item MutationObserver triggered for item`);
      mutations.forEach((mutation) => {
        console.log(
          `[AWS] Item mutation type: ${mutation.type}, attribute: ${mutation.attributeName}`,
        );
      });
      // When an item changes, check if we should extract
      this.checkAndExtractIfReady();
    });

    observer.observe(itemElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
      childList: true,
      subtree: true,
      characterData: true,
    });

    this.itemObservers.push(observer);
    console.log(`[AWS] Observer set up for .item element`);
  },

  /**
   * Check if items are ready and trigger extraction
   */
  checkAndExtractIfReady() {
    // Find items using the reference selector pattern
    const items = document.querySelectorAll(
      "#schedule-block .body .items a.item",
    );
    const currentCount = items.length;

    console.log(
      "[AWS] Checking extraction readiness - Current item count:",
      currentCount,
    );

    if (currentCount > 0) {
      console.log(
        "[AWS] Found",
        currentCount,
        "anime items - triggering extraction",
      );

      // If automation is running, auto-extract
      if (
        window.AWSAutomation.autoExtractEnabled &&
        window.AWSAutomation.isRunning
      ) {
        console.log("[AWS] Auto-extract enabled, triggering extraction");
        // Small delay to ensure DOM is fully updated
        setTimeout(async () => {
          if (window.AWSAutomation.isRunning) {
            const success = await window.AWSExtractor.extractAndSave();
            if (success) {
              window.AWSPanel.loadAndDisplayData();
              // Signal automation loop that extraction is done (clears timeout)
              window.AWSAutomation.signalExtractionComplete();
            }
          }
        }, 300); // Reduced from 500ms
      }
    }
  },
  /**
   * Start automation
   */
  async startAutomation(config) {
    if (!window.AWSAutomation) {
      console.error("[AWS] Automation module not available");
      return;
    }
    const callbacks = {
      onStatus: (message, type) => window.AWSPanel.updateStatus(message, type),
      onComplete: () => window.AWSPanel.loadAndDisplayData(),
    };

    // Reset item count tracker
    this.lastItemCount = 0;

    const success = await window.AWSAutomation.start(config, callbacks);
    if (success) {
      window.AWSPanel.updateButtonStates(true);
    }
  },
  /**
   * Stop automation
   */
  stopAutomation() {
    if (!window.AWSAutomation) return;
    window.AWSAutomation.stop();
    this.stopExtractionPolling();
    window.AWSPanel.updateButtonStates(false);
    window.AWSPanel.updateStatus("Automation stopped", "info");
  },
  /**
   * Extract current day
   */
  async extractCurrent() {
    window.AWSPanel.updateStatus("Extracting current day...", "info");
    const success = await window.AWSExtractor.extractAndSave();
    if (success) {
      window.AWSPanel.updateStatus("Extraction complete!", "success");
      await window.AWSPanel.loadAndDisplayData();
    } else {
      window.AWSPanel.updateStatus("Extraction failed", "error");
    }
  },
});
// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    window.AWSContent.initialize();
  });
} else {
  window.AWSContent.initialize();
}
console.log("[AWS] Content script ready");
