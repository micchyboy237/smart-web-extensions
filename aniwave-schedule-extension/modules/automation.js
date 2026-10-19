// Automation module - handles automated extraction loop

console.log("[AWS] Automation module loaded");

window.AWSAutomation = {
  isRunning: false,
  autoExtractEnabled: false,
  controller: null,

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

          console.log("[AWS] Day selected, waiting for content to load...");

          // Wait for MutationObserver to detect changes and trigger extraction
          // The observer will call extractAndSave automatically
          await window.AWSNavigation.sleep(delay);

          console.log("[AWS] Day processing complete, moving to next");

          // Small additional wait before next day
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
  },
};
