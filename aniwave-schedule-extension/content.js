// Main content script - orchestrates all modules

console.log("[AWS] Content script loaded on:", window.location.href);

// Global state for content script
window.AWSContent = {
  mutationObserver: null,

  /**
   * Initialize the extension
   */
  async initialize() {
    console.log("[AWS] Initializing extension");

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
   */
  setupMutationObserver() {
    console.log("[AWS] Setting up MutationObserver");

    // Try multiple selectors for items container
    let itemsContainer = document.querySelector("#schedule-block .body .items");
    if (!itemsContainer) {
      console.log("[AWS] Primary selector failed, trying alternatives...");
      itemsContainer = document.querySelector("#schedule-block .items");
    }

    if (!itemsContainer) {
      console.warn(
        "[AWS] Schedule items container not found with any selector",
      );
      return;
    }

    console.log("[AWS] Found items container:", itemsContainer.className);

    // Create observer instance
    this.mutationObserver = new MutationObserver((mutations) => {
      console.log(
        "[AWS] MutationObserver triggered!",
        mutations.length,
        "mutations",
      );

      mutations.forEach((mutation) => {
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          console.log("[AWS] Nodes added to schedule items");

          // Check if anime items exist
          const currentItems = itemsContainer.querySelectorAll("a.item");
          console.log("[AWS] Current item count:", currentItems.length);

          if (currentItems.length > 0) {
            console.log(
              "[AWS] Found",
              currentItems.length,
              "anime items after mutation",
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
                  }
                }
              }, 1000);
            }
          }
        }
      });
    });

    // Configure observer
    const config = {
      childList: true,
      subtree: true,
      characterData: false,
      attributes: true,
      attributeFilter: ["class", "style"],
    };

    // Start observing
    this.mutationObserver.observe(itemsContainer, config);
    console.log(
      "[AWS] MutationObserver started, watching schedule items container",
    );
  },

  /**
   * Start automation
   */
  async startAutomation(config) {
    const callbacks = {
      onStatus: (message, type) => window.AWSPanel.updateStatus(message, type),
      onComplete: () => window.AWSPanel.loadAndDisplayData(),
    };

    const success = await window.AWSAutomation.start(config, callbacks);

    if (success) {
      window.AWSPanel.updateButtonStates(true);
    }
  },

  /**
   * Stop automation
   */
  stopAutomation() {
    window.AWSAutomation.stop();
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
};

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    window.AWSContent.initialize();
  });
} else {
  window.AWSContent.initialize();
}

console.log("[AWS] Content script ready");
