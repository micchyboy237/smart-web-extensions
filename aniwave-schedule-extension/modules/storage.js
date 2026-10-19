// Storage module - handles all chrome.storage operations
console.log("[AWS] Storage module loaded");
if (!window.AWSStorage) {
  window.AWSStorage = {};
}
Object.assign(window.AWSStorage, {
  /**
   * Get data from chrome storage
   */
  getData() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_DATA" }, (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[AWS] Chrome runtime error:",
            chrome.runtime.lastError,
          );
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
  },
  /**
   * Save extracted data
   */
  saveData(data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "SAVE_DATA",
          data: data,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error(
              "[AWS] Chrome runtime error:",
              chrome.runtime.lastError,
            );
            resolve(null);
          } else {
            resolve(response);
          }
        },
      );
    });
  },
  /**
   * Mark day as processed
   */
  markDayProcessed(day) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "MARK_DAY_PROCESSED",
          day: day,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error(
              "[AWS] Chrome runtime error:",
              chrome.runtime.lastError,
            );
            resolve(null);
          } else {
            resolve(response);
          }
        },
      );
    });
  },
  /**
   * Clear all cached data
   */
  clearData() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA" }, (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[AWS] Chrome runtime error:",
            chrome.runtime.lastError,
          );
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
  },
});
console.log("[AWS] Storage module initialized on window");
