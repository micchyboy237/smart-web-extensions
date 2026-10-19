// Extractor module - handles anime schedule data extraction

console.log("[AWS] Extractor module loaded");

window.AWSExtractor = {
  /**
   * Get currently selected type (SUB/DUB)
   */
  getCurrentType() {
    const activeTab = document.querySelector(
      "#schedule-block .tabs .tab.active",
    );
    return activeTab ? activeTab.getAttribute("data-name") || "sub" : "sub";
  },

  /**
   * Get all available days from the schedule
   */
  getAvailableDays() {
    console.log("[AWS] Getting available days...");
    try {
      const dayElements = document.querySelectorAll(
        "#schedule-block .day .inner[data-time]",
      );
      const days = Array.from(dayElements).map((el) => ({
        date: el.getAttribute("data-time"),
        displayDate: el.querySelector(".date")?.textContent.trim() || "",
        weekday: el.querySelector(".wday")?.textContent.trim() || "",
        isActive: el.closest(".day")?.classList.contains("active") || false,
      }));
      console.log("[AWS] Available days:", days.length);
      return days;
    } catch (error) {
      console.error("[AWS] Error getting days:", error);
      return [];
    }
  },

  /**
   * Extract anime schedule from current page view
   */
  extractCurrentSchedule() {
    console.log("[AWS] === Starting extraction ===");
    try {
      // Find active day
      const activeDay = document.querySelector(
        "#schedule-block .day.active .inner[data-time]",
      );

      if (!activeDay) {
        console.warn("[AWS] No active day found in schedule block");
        return null;
      }

      const currentDate = activeDay.getAttribute("data-time");
      console.log("[AWS] Current date:", currentDate);

      // Find items container
      let itemsContainer = document.querySelector(
        "#schedule-block .body .items",
      );
      if (!itemsContainer) {
        itemsContainer = document.querySelector("#schedule-block .items");
      }

      if (!itemsContainer) {
        console.error("[AWS] No items container found");
        return null;
      }

      // Get all anime items
      const items = itemsContainer.querySelectorAll("a.item");
      console.log("[AWS] Found", items.length, "anime items");

      if (items.length === 0) {
        console.warn("[AWS] No anime items found to extract");
        return null;
      }

      const extractedData = Array.from(items).map((item) => {
        const timeEl = item.querySelector(".time");
        const epEl = item.querySelector(".ep span");
        const titleEl = item.querySelector(".title.d-title");

        return {
          date: currentDate,
          time: timeEl ? timeEl.textContent.trim() : "",
          episode: epEl ? epEl.textContent.trim() : "",
          title: titleEl ? titleEl.textContent.trim() : "",
          japaneseTitle: titleEl ? titleEl.getAttribute("data-jp") || "" : "",
          href: item.getAttribute("href") || "",
          id: timeEl ? timeEl.getAttribute("data-tip") || "" : "",
          isOld: item.classList.contains("old"),
          type: this.getCurrentType(),
          extractedAt: new Date().toISOString(),
        };
      });

      console.log("[AWS] Extracted", extractedData.length, "items");
      return extractedData;
    } catch (error) {
      console.error("[AWS] Extraction error:", error);
      return null;
    }
  },

  /**
   * Extract and save current schedule
   */
  async extractAndSave() {
    const extractedData = this.extractCurrentSchedule();

    if (!extractedData || extractedData.length === 0) {
      console.warn("[AWS] No data to save");
      return false;
    }

    // Save to storage
    const saveResponse = await window.AWSStorage.saveData(extractedData);

    if (saveResponse && saveResponse.success) {
      console.log("[AWS] Data saved successfully");

      // Get current date and mark as processed
      const activeDay = document.querySelector(
        "#schedule-block .day.active .inner[data-time]",
      );

      if (activeDay) {
        const currentDate = activeDay.getAttribute("data-time");
        await window.AWSStorage.markDayProcessed(currentDate);
        console.log("[AWS] Day marked as processed:", currentDate);
      }

      return true;
    } else {
      console.error("[AWS] Failed to save data");
      return false;
    }
  },
};
