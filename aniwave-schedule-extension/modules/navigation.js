// Navigation module - handles day selection and swiper navigation

console.log("[AWS] Navigation module loaded");

window.AWSNavigation = {
  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  /**
   * Trigger day selection using proven event sequence
   */
  triggerDaySelection(date) {
    console.log("[AWS] Triggering day selection for:", date);

    try {
      const dayInner = document.querySelector(
        `#schedule-block .day .inner[data-time="${date}"]`,
      );

      if (!dayInner) {
        console.warn("[AWS] Day element not found:", date);
        return false;
      }

      // Fire the complete event sequence that works
      const eventsToFire = [
        "mousedown",
        "mouseup",
        "click",
        "pointerdown",
        "pointerup",
      ];

      eventsToFire.forEach((eventType) => {
        const event = new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
        });
        dayInner.dispatchEvent(event);
      });

      console.log("[AWS] Day selection triggered successfully");
      return true;
    } catch (error) {
      console.error("[AWS] Error triggering day selection:", error);
      return false;
    }
  },

  /**
   * Navigate to a specific date using swiper buttons if needed
   */
  async navigateToDate(targetDate) {
    console.log("[AWS] Navigating to date:", targetDate);

    try {
      // Check if date is already visible
      const dayInner = document.querySelector(
        `#schedule-block .day .inner[data-time="${targetDate}"]`,
      );

      if (!dayInner) {
        console.warn("[AWS] Target date element not found:", targetDate);
        return false;
      }

      // Date is visible, trigger selection
      console.log("[AWS] Date visible, triggering selection");
      return this.triggerDaySelection(targetDate);
    } catch (error) {
      console.error("[AWS] Error navigating to date:", error);
      return false;
    }
  },
};
