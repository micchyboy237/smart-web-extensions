// Automation module - handles automated extraction loop
console.log("[AWS] Automation module loaded");
// Ensure the object exists on window
if (!window.AWSAutomation) {
  window.AWSAutomation = {};
}
Object.assign(window.AWSAutomation, {
  isRunning: false,
  autoExtractEnabled: false,
  controller: null,
  extractionPromiseResolver: null, // Hook to resolve when extraction is done
  extractionTimeoutId: null, // Track timeout ID so we can clear it
  extractionTimedOut: false, // Track if current day timed out
  /**
   * Start automation loop
   */
  async start(config, callbacks) {
    if (this.isRunning) {
      console.warn("[AWS] Automation already running");
      return false;
    }
    const { startDate, endDate, delay } = config;
    console.log("[AWS] Starting automation with config:", config);
    if (!startDate || !endDate) {
      console.error("[AWS] Missing start or end date");
      return false;
    }
    if (new Date(startDate) > new Date(endDate)) {
      console.error("[AWS] Start date must be before end date");
      return false;
    }
    this.isRunning = true;
    this.autoExtractEnabled = true;
    if (callbacks.onStatus) {
      callbacks.onStatus("Starting auto-extraction...", "info");
    }
    try {
      // Get available days
      const days = window.AWSExtractor.getAvailableDays();
      console.log("[AWS] Available days:", days.length);
      // Filter days based on date range
      const targetDates = days
        .filter((day) => {
          const dayDate = new Date(day.date);
          const start = new Date(startDate);
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          return dayDate >= start && dayDate <= end;
        })
        .map((day) => day.date);
      console.log("[AWS] Target dates:", targetDates);
      if (targetDates.length === 0) {
        if (callbacks.onStatus) {
          callbacks.onStatus("No matching days found in range", "error");
        }
        this.stop();
        return false;
      }
      // Get already processed days
      const data = await window.AWSStorage.getData();
      const processedDays = data?.processedDays || [];
      // Filter out already processed days
      const unprocessedDates = targetDates.filter(
        (date) => !processedDays.includes(date),
      );
      console.log("[AWS] Unprocessed dates:", unprocessedDates);
      if (unprocessedDates.length === 0) {
        if (callbacks.onStatus) {
          callbacks.onStatus("All matching days already processed", "success");
        }
        this.stop();
        if (callbacks.onComplete) {
          callbacks.onComplete();
        }
        return true;
      }
      if (callbacks.onStatus) {
        callbacks.onStatus(
          `Processing ${unprocessedDates.length} days...`,
          "info",
        );
      }
      // Process each unprocessed day sequentially
      let currentIndex = 0;
      const processNext = async () => {
        if (!this.isRunning || currentIndex >= unprocessedDates.length) {
          this.stop();
          if (currentIndex >= unprocessedDates.length) {
            if (callbacks.onStatus) {
              callbacks.onStatus("All days processed!", "success");
            }
            if (callbacks.onComplete) {
              callbacks.onComplete();
            }
          }
          return;
        }
        const currentDate = unprocessedDates[currentIndex];
        console.log(
          `[AWS] === Processing day ${currentIndex + 1}/${unprocessedDates.length}: ${currentDate} ===`,
        );
        if (callbacks.onStatus) {
          callbacks.onStatus(
            `Processing: ${currentDate} (${currentIndex + 1}/${unprocessedDates.length})`,
            "info",
          );
        }
        try {
          // Navigate to and select the day
          console.log("[AWS] Navigating to day:", currentDate);
          const navigated =
            await window.AWSNavigation.navigateToDate(currentDate);
          if (!navigated) {
            console.warn("[AWS] Failed to navigate to day:", currentDate);
            currentIndex++;
            await window.AWSNavigation.sleep(delay);
            processNext();
            return;
          }
          console.log(
            "[AWS] Day selected, waiting for extraction to complete...",
          );

          // Reset timeout flag
          this.extractionTimedOut = false;

          // Create a promise that resolves when the MutationObserver triggers extraction
          await new Promise((resolve) => {
            this.extractionPromiseResolver = resolve;

            // Safety timeout: Reduced to 10 seconds since extraction should be fast
            // If extraction doesn't happen by then, move on anyway to prevent hanging
            this.extractionTimeoutId = setTimeout(() => {
              if (this.extractionPromiseResolver) {
                console.warn(
                  `[AWS] Extraction timeout reached for ${currentDate} (10s limit)`,
                );
                this.extractionTimedOut = true;
                this.extractionPromiseResolver();
                this.extractionPromiseResolver = null;
                this.extractionTimeoutId = null;
              }
            }, 10000); // Reduced from 20000 to 10000
          });

          // Only mark as processed if extraction succeeded (not timed out)
          if (this.extractionTimedOut) {
            console.warn(
              `[AWS] Skipping ${currentDate} due to timeout - NOT marked as processed`,
            );
            if (callbacks.onStatus) {
              callbacks.onStatus(`Skipped ${currentDate} (timeout)`, "warning");
            }
          } else {
            console.log("[AWS] Day processing complete, moving to next");
          }

          // Small additional wait to ensure UI stability
          await window.AWSNavigation.sleep(500);
          currentIndex++;
          processNext();
        } catch (error) {
          console.error("[AWS] Error processing day:", error);
          currentIndex++;
          await window.AWSNavigation.sleep(delay);
          processNext();
        }
      };
      // Store controller for stopping
      this.controller = {
        stop: () => {
          this.isRunning = false;
          this.autoExtractEnabled = false;
          // Resolve any pending promise to prevent hanging
          if (this.extractionPromiseResolver) {
            this.extractionPromiseResolver();
            this.extractionPromiseResolver = null;
          }
          // Clear timeout
          if (this.extractionTimeoutId) {
            clearTimeout(this.extractionTimeoutId);
            this.extractionTimeoutId = null;
          }
        },
      };
      // Start processing
      processNext();
      return true;
    } catch (error) {
      console.error("[AWS] Automation error:", error);
      if (callbacks.onStatus) {
        callbacks.onStatus("Error: " + error.message, "error");
      }
      this.stop();
      return false;
    }
  },
  /**
   * Signal that extraction is complete
   */
  signalExtractionComplete() {
    if (this.extractionPromiseResolver) {
      console.log(
        "[AWS] Extraction complete signal received - clearing timeout",
      );
      // Clear the timeout immediately so we don't wait
      if (this.extractionTimeoutId) {
        clearTimeout(this.extractionTimeoutId);
        this.extractionTimeoutId = null;
        console.log("[AWS] Timeout cleared");
      }
      // Resolve the promise to continue to next day
      this.extractionPromiseResolver();
      this.extractionPromiseResolver = null;
    }
  },
  /**
   * Stop automation
   */
  stop() {
    console.log("[AWS] Stopping automation");
    this.isRunning = false;
    this.autoExtractEnabled = false;
    if (this.controller) {
      this.controller.stop();
      this.controller = null;
    }
    // Clear any pending resolver
    if (this.extractionPromiseResolver) {
      this.extractionPromiseResolver();
      this.extractionPromiseResolver = null;
    }
    // Clear timeout
    if (this.extractionTimeoutId) {
      clearTimeout(this.extractionTimeoutId);
      this.extractionTimeoutId = null;
    }
  },
});
console.log("[AWS] Automation module initialized on window");
