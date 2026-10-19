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
  isExtracting: false, // Lock to prevent concurrent extractions
  extractionDebounceTimer: null, // Timer for debouncing extraction triggers
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

    // CRITICAL: Start polling FIRST (before any early returns)
    // This ensures polling works even if no items exist at initialization
    this.startExtractionPolling();

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
        console.warn(
          "[AWS] No .item elements found at initialization - relying on polling",
        );
        // Don't return early - polling is already running!
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

        // When the item changes, check if we should extract (with debounce)
        this.triggerExtractionWithDebounce();
      });

      this.mutationObserver.observe(firstItemElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      console.log("[AWS] Observer on first .item element started");
    }
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
          // Use debounced trigger to prevent multiple extractions
          this.triggerExtractionWithDebounce();
        }
      }
    }, 500);
  },

  /**
   * Trigger extraction with debounce to prevent rapid-fire calls
   */
  triggerExtractionWithDebounce() {
    // Clear any pending debounce timer
    if (this.extractionDebounceTimer) {
      clearTimeout(this.extractionDebounceTimer);
    }

    // Wait 500ms before extracting to let DOM stabilize
    this.extractionDebounceTimer = setTimeout(() => {
      this.checkAndExtractIfReady();
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
    // Clear any pending debounce timer
    if (this.extractionDebounceTimer) {
      clearTimeout(this.extractionDebounceTimer);
      this.extractionDebounceTimer = null;
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
      // When an item changes, check if we should extract (with debounce)
      this.triggerExtractionWithDebounce();
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
   * Uses lock to prevent concurrent extractions
   */
  async checkAndExtractIfReady() {
    // Prevent concurrent extractions
    if (this.isExtracting) {
      console.log("[AWS] Extraction already in progress, skipping");
      return;
    }

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
        // Set lock
        this.isExtracting = true;
        console.log("[AWS] Auto-extract enabled, starting extraction");

        try {
          const success = await window.AWSExtractor.extractAndSave();
          if (success) {
            window.AWSPanel.loadAndDisplayData();
            // Signal automation loop that extraction is done (clears timeout)
            window.AWSAutomation.signalExtractionComplete();
          }
        } catch (error) {
          console.error("[AWS] Extraction error:", error);
        } finally {
          // Release lock
          this.isExtracting = false;
          console.log("[AWS] Extraction lock released");
        }
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
