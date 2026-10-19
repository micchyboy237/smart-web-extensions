// Main content script - orchestrates all modules
console.log("[AWS] Content script loaded on:", window.location.href);
if (!window.AWSContent) {
  window.AWSContent = {};
}
Object.assign(window.AWSContent, {
  mutationObserver: null,
  itemObservers: [],
  extractionCheckInterval: null,
  lastItemCount: 0,
  isExtracting: false,
  extractionDebounceTimer: null,

  async initialize() {
    console.log("[AWS] Initializing extension");
    if (
      !window.AWSPanel ||
      !window.AWSExtractor ||
      !window.AWSNavigation ||
      !window.AWSAutomation ||
      !window.AWSStorage ||
      !window.AWSTracker || // NEW
      !window.AWSFavoritesUI // NEW
    ) {
      console.error("[AWS] Modules not loaded properly");
      return;
    }

    window.AWSPanel.inject();
    await this.waitForScheduleBlock();
    this.setupMutationObserver();
    window.AWSPanel.setupListeners();

    setTimeout(async () => {
      await window.AWSPanel.loadAndDisplayData();
      await window.AWSPanel.setDefaultDates();
    }, 1000);
  },

  waitForScheduleBlock(retries = 10) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const scheduleBlock = document.querySelector("#schedule-block");
        if (scheduleBlock) {
          console.log("[AWS] Schedule block found");
          resolve();
        } else if (retries > 0) {
          setTimeout(() => check(), 500);
        } else {
          console.error("[AWS] Schedule block not found after retries");
          reject(new Error("Schedule block not found"));
        }
      };
      check();
    });
  },

  setupMutationObserver() {
    console.log("[AWS] Setting up MutationObserver");
    if (this.mutationObserver) this.mutationObserver.disconnect();
    this.itemObservers.forEach((obs) => obs.disconnect());
    this.itemObservers = [];

    this.startExtractionPolling();

    const firstItemElement = document.querySelector(
      "#schedule-block .body .items .item",
    );

    if (!firstItemElement) {
      console.warn("[AWS] First .item element not found");
      const anyItem = document.querySelector("#schedule-block a.item");
      if (anyItem) {
        this.observeItemElement(anyItem);
      }
    } else {
      console.log("[AWS] Observing first .item element");
      this.mutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === "childList" || mutation.type === "attributes") {
            this.triggerExtractionWithDebounce();
          }
        });
      });

      this.mutationObserver.observe(firstItemElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }
  },

  startExtractionPolling() {
    console.log("[AWS] Starting extraction readiness polling");
    if (this.extractionCheckInterval)
      clearInterval(this.extractionCheckInterval);

    this.extractionCheckInterval = setInterval(() => {
      if (
        !window.AWSAutomation.autoExtractEnabled ||
        !window.AWSAutomation.isRunning
      )
        return;

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
          this.triggerExtractionWithDebounce();
        }
      }
    }, 500);
  },

  triggerExtractionWithDebounce() {
    if (this.extractionDebounceTimer)
      clearTimeout(this.extractionDebounceTimer);
    this.extractionDebounceTimer = setTimeout(() => {
      this.checkAndExtractIfReady();
    }, 500);
  },

  stopExtractionPolling() {
    if (this.extractionCheckInterval) {
      clearInterval(this.extractionCheckInterval);
      this.extractionCheckInterval = null;
    }
    if (this.extractionDebounceTimer) {
      clearTimeout(this.extractionDebounceTimer);
      this.extractionDebounceTimer = null;
    }
  },

  observeItemElement(itemElement) {
    const observer = new MutationObserver(() => {
      this.triggerExtractionWithDebounce();
    });

    observer.observe(itemElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });

    this.itemObservers.push(observer);
  },

  async checkAndExtractIfReady() {
    if (this.isExtracting) return;

    const items = document.querySelectorAll(
      "#schedule-block .body .items a.item",
    );
    const currentCount = items.length;

    if (
      currentCount > 0 &&
      window.AWSAutomation.autoExtractEnabled &&
      window.AWSAutomation.isRunning
    ) {
      this.isExtracting = true;
      console.log("[AWS] Starting extraction");

      try {
        const success = await window.AWSExtractor.extractAndSave();
        if (success) {
          window.AWSPanel.loadAndDisplayData();
          window.AWSAutomation.signalExtractionComplete();
        }
      } catch (error) {
        console.error("[AWS] Extraction error:", error);
      } finally {
        this.isExtracting = false;
      }
    }
  },

  async startAutomation(config) {
    if (!window.AWSAutomation) return;
    const callbacks = {
      onStatus: (message, type) => window.AWSPanel.updateStatus(message, type),
      onComplete: () => window.AWSPanel.loadAndDisplayData(),
    };
    this.lastItemCount = 0;
    const success = await window.AWSAutomation.start(config, callbacks);
    if (success) window.AWSPanel.updateButtonStates(true);
  },

  stopAutomation() {
    if (!window.AWSAutomation) return;
    window.AWSAutomation.stop();
    this.stopExtractionPolling();
    window.AWSPanel.updateButtonStates(false);
    window.AWSPanel.updateStatus("Automation stopped", "info");
  },

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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () =>
    window.AWSContent.initialize(),
  );
} else {
  window.AWSContent.initialize();
}
console.log("[AWS] Content script ready");
