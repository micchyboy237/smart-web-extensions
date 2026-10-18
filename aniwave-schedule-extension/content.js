// Content script for extracting anime schedule data and managing in-page panel

console.log("[AWS] Content script loaded on:", window.location.href);

// Global state
let isRunning = false;
let automationController = null;
let mutationObserver = null;
let autoExtractEnabled = false;

// Listen for messages from panel UI
window.addEventListener("message", (event) => {
  // Only accept messages from our own panel
  if (event.source !== window) return;

  const message = event.data;
  if (!message || message.source !== "aws-panel") return;

  console.log("[AWS] Content received panel message:", message.type);

  switch (message.type) {
    case "EXTRACT_CURRENT":
      extractCurrentSchedule();
      break;

    case "CLICK_DAY":
      const clicked = clickDayElement(message.date);
      window.postMessage(
        {
          source: "aws-panel",
          type: "CLICK_RESULT",
          success: clicked,
        },
        "*",
      );
      break;

    case "GET_AVAILABLE_DAYS":
      getAvailableDays().then((days) => {
        window.postMessage(
          {
            source: "aws-panel",
            type: "AVAILABLE_DAYS",
            days: days,
          },
          "*",
        );
      });
      break;

    case "GET_CURRENT_TYPE":
      window.postMessage(
        {
          source: "aws-panel",
          type: "CURRENT_TYPE",
          type: getCurrentType(),
        },
        "*",
      );
      break;

    case "START_AUTOMATION":
      startAutomation(message.config);
      break;

    case "STOP_AUTOMATION":
      stopAutomation();
      break;

    case "LOAD_DATA":
      loadAndDisplayData();
      break;

    case "CLEAR_DATA":
      clearAllData();
      break;

    default:
      console.warn("[AWS] Content unknown panel message type:", message.type);
  }
});

// Inject panel when page loads
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeExtension);
} else {
  initializeExtension();
}

/**
 * Initialize the extension
 */
function initializeExtension() {
  console.log("[AWS] Initializing extension");

  injectPanel();

  // Wait for schedule block to be available
  waitForScheduleBlock(() => {
    setupMutationObserver();
    // Load initial data after a short delay
    setTimeout(() => {
      loadAndDisplayData();
    }, 1000);
  });
}

/**
 * Wait for schedule block to exist
 */
function waitForScheduleBlock(callback, retries = 10) {
  const scheduleBlock = document.querySelector("#schedule-block");

  if (scheduleBlock) {
    console.log("[AWS] Schedule block found");
    callback();
  } else if (retries > 0) {
    console.log(
      `[AWS] Schedule block not found, retrying... (${retries} attempts left)`,
    );
    setTimeout(() => waitForScheduleBlock(callback, retries - 1), 500);
  } else {
    console.error("[AWS] Schedule block not found after retries");
  }
}

/**
 * Setup MutationObserver to watch for anime items loading in schedule
 */
function setupMutationObserver() {
  console.log("[AWS] Setting up MutationObserver");

  // Watch the schedule body items container
  const itemsContainer = document.querySelector("#schedule-block .body .items");

  if (!itemsContainer) {
    console.warn("[AWS] Schedule items container not found");
    return;
  }

  console.log("[AWS] Found items container:", itemsContainer);

  // Create observer instance
  mutationObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.addedNodes.length > 0 || mutation.type === "childList") {
        console.log("[AWS] Mutation detected in schedule items");

        // Check if anime items exist
        const currentItems = document.querySelectorAll(
          "#schedule-block .body .items > a.item",
        );
        if (currentItems.length > 0) {
          console.log(
            "[AWS] Found",
            currentItems.length,
            "anime items after mutation",
          );

          // If automation is running, auto-extract
          if (autoExtractEnabled && isRunning) {
            console.log("[AWS] Auto-extracting after mutation");
            // Small delay to ensure DOM is fully updated
            setTimeout(() => {
              extractCurrentSchedule();
            }, 800);
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
    attributeFilter: ["class"],
  };

  // Start observing
  mutationObserver.observe(itemsContainer, config);
  console.log(
    "[AWS] MutationObserver started, watching schedule items container",
  );
}

/**
 * Inject the control panel into the page
 */
function injectPanel() {
  console.log("[AWS] Injecting panel into page");

  // Check if panel already exists
  if (document.getElementById("aws-panel")) {
    console.log("[AWS] Panel already exists, skipping injection");
    return;
  }

  // Create panel container
  const panel = document.createElement("div");
  panel.id = "aws-panel";
  panel.className = "aws-panel aws-panel-collapsed";

  panel.innerHTML = `
    <div class="aws-panel-header">
      <div class="aws-panel-title">
        <span class="aws-icon">📅</span>
        <span>AniWave Scheduler</span>
      </div>
      <button class="aws-toggle-btn" title="Toggle Panel">▼</button>
    </div>
    
    <div class="aws-panel-body">
      <!-- Configuration Section -->
      <div class="aws-section">
        <h3 class="aws-section-title">Configuration</h3>
        
        <div class="aws-form-row">
          <label for="aws-start-date">Start Date:</label>
          <input type="date" id="aws-start-date" />
        </div>
        
        <div class="aws-form-row">
          <label for="aws-end-date">End Date:</label>
          <input type="date" id="aws-end-date" />
        </div>
        
        <div class="aws-form-row">
          <label for="aws-type-filter">Type:</label>
          <select id="aws-type-filter">
            <option value="all">All (SUB + DUB)</option>
            <option value="sub" selected>SUB Only</option>
            <option value="dub">DUB Only</option>
          </select>
        </div>
        
        <div class="aws-form-row">
          <label for="aws-delay">Click Delay (ms):</label>
          <input type="number" id="aws-delay" value="2000" min="500" max="10000" step="500" />
        </div>
        
        <div class="aws-button-group">
          <button id="aws-start-btn" class="aws-btn aws-btn-primary">Start Auto-Extract</button>
          <button id="aws-stop-btn" class="aws-btn aws-btn-danger" disabled>Stop</button>
          <button id="aws-extract-btn" class="aws-btn aws-btn-success">Extract Current</button>
        </div>
        
        <div id="aws-status" class="aws-status"></div>
      </div>
      
      <!-- Processed Days Section -->
      <div class="aws-section">
        <h3 class="aws-section-title">
          Processed Days (<span id="aws-processed-count">0</span>)
        </h3>
        <div id="aws-processed-days" class="aws-list">
          <p class="aws-empty">No days processed yet</p>
        </div>
      </div>
      
      <!-- Saved Items Section -->
      <div class="aws-section">
        <h3 class="aws-section-title">
          Saved Items (<span id="aws-items-count">0</span>)
        </h3>
        <div id="aws-saved-items" class="aws-list">
          <p class="aws-empty">No items saved yet</p>
        </div>
      </div>
      
      <!-- Actions -->
      <div class="aws-section">
        <button id="aws-clear-btn" class="aws-btn aws-btn-secondary aws-btn-full">Clear Cache</button>
        <button id="aws-refresh-btn" class="aws-btn aws-btn-secondary aws-btn-full">Refresh Data</button>
        <button id="aws-test-btn" class="aws-btn aws-btn-secondary aws-btn-full">Test Selectors</button>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  console.log("[AWS] Panel injected successfully");

  // Setup panel event listeners
  setupPanelListeners();
}

/**
 * Setup event listeners for panel elements
 */
function setupPanelListeners() {
  console.log("[AWS] Setting up panel listeners");

  // Toggle panel
  const toggleBtn = document.querySelector(".aws-toggle-btn");
  const panel = document.getElementById("aws-panel");

  if (toggleBtn && panel) {
    toggleBtn.addEventListener("click", () => {
      panel.classList.toggle("aws-panel-collapsed");
      toggleBtn.textContent = panel.classList.contains("aws-panel-collapsed")
        ? "▼"
        : "▲";
    });
  }

  // Start button
  const startBtn = document.getElementById("aws-start-btn");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      const config = {
        startDate: document.getElementById("aws-start-date").value,
        endDate: document.getElementById("aws-end-date").value,
        typeFilter: document.getElementById("aws-type-filter").value,
        delay: parseInt(document.getElementById("aws-delay").value) || 2000,
      };

      window.postMessage(
        {
          source: "aws-panel",
          type: "START_AUTOMATION",
          config: config,
        },
        "*",
      );
    });
  }

  // Stop button
  const stopBtn = document.getElementById("aws-stop-btn");
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      window.postMessage(
        {
          source: "aws-panel",
          type: "STOP_AUTOMATION",
        },
        "*",
      );
    });
  }

  // Extract current button
  const extractBtn = document.getElementById("aws-extract-btn");
  if (extractBtn) {
    extractBtn.addEventListener("click", () => {
      window.postMessage(
        {
          source: "aws-panel",
          type: "EXTRACT_CURRENT",
        },
        "*",
      );
    });
  }

  // Clear button
  const clearBtn = document.getElementById("aws-clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("[AWS] Are you sure you want to clear all cached data?")) {
        window.postMessage(
          {
            source: "aws-panel",
            type: "CLEAR_DATA",
          },
          "*",
        );
      }
    });
  }

  // Refresh button
  const refreshBtn = document.getElementById("aws-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      window.postMessage(
        {
          source: "aws-panel",
          type: "LOAD_DATA",
        },
        "*",
      );
    });
  }

  // Test button (Test Selectors UI tool)
  const testBtn = document.getElementById("aws-test-btn");
  if (testBtn) {
    testBtn.addEventListener("click", () => {
      console.log("[AWS] === Running selector tests ===");

      // Test 1: Schedule block
      const scheduleBlock = document.querySelector("#schedule-block");
      console.log(
        "[AWS] Test 1 - #schedule-block:",
        scheduleBlock ? "FOUND" : "NOT FOUND",
      );

      // Test 2: Active day
      const activeDay = document.querySelector(
        "#schedule-block .day.active .inner[data-time]",
      );
      console.log(
        "[AWS] Test 2 - Active day:",
        activeDay ? "FOUND" : "NOT FOUND",
      );
      if (activeDay) {
        console.log("[AWS]   Date:", activeDay.getAttribute("data-time"));
      }

      // Test 3: Items container
      const itemsContainer = document.querySelector(
        "#schedule-block .body .items",
      );
      console.log(
        "[AWS] Test 3 - #schedule-block .body .items:",
        itemsContainer ? "FOUND" : "NOT FOUND",
      );

      // Test 4: Alternative items container
      const itemsAlt = document.querySelector("#schedule-block .items");
      console.log(
        "[AWS] Test 4 - #schedule-block .items:",
        itemsAlt ? "FOUND" : "NOT FOUND",
      );

      // Test 5: Anime items count
      const allItems = document.querySelectorAll("#schedule-block a.item");
      console.log("[AWS] Test 5 - Total a.item elements:", allItems.length);

      // Test 6: Type tabs
      const activeTab = document.querySelector(
        "#schedule-block .tabs .tab.active",
      );
      console.log(
        "[AWS] Test 6 - Active tab:",
        activeTab ? "FOUND" : "NOT FOUND",
      );
      if (activeTab) {
        console.log("[AWS]   Type:", activeTab.getAttribute("data-name"));
      }

      // Test 7: First item details
      if (allItems.length > 0) {
        const firstItem = allItems[0];
        const timeEl = firstItem.querySelector(".time");
        const epEl = firstItem.querySelector(".ep span");
        const titleEl = firstItem.querySelector(".title.d-title");

        console.log("[AWS] Test 7 - First item:");
        console.log(
          "[AWS]   Time:",
          timeEl ? timeEl.textContent.trim() : "NOT FOUND",
        );
        console.log(
          "[AWS]   Episode:",
          epEl ? epEl.textContent.trim() : "NOT FOUND",
        );
        console.log(
          "[AWS]   Title:",
          titleEl ? titleEl.textContent.trim() : "NOT FOUND",
        );
        console.log(
          "[AWS]   JP Title:",
          titleEl ? titleEl.getAttribute("data-jp") : "NOT FOUND",
        );
      }

      console.log("[AWS] === Selector tests complete ===");
      updateStatus("Check console for test results", "info");
    });
  }

  // Set default dates
  const today = new Date();
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 7);

  const startDateInput = document.getElementById("aws-start-date");
  const endDateInput = document.getElementById("aws-end-date");

  if (startDateInput) startDateInput.value = formatDateForInput(today);
  if (endDateInput) endDateInput.value = formatDateForInput(nextWeek);
}

/**
 * Format date for input field (YYYY-MM-DD)
 */
function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Update status message in panel
 */
function updateStatus(message, type = "info") {
  const statusEl = document.getElementById("aws-status");
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = `aws-status aws-status-${type}`;
  }
  console.log(`[AWS] Status (${type}):`, message);
}

/**
 * Update button states
 */
function updateButtonStates(running) {
  const startBtn = document.getElementById("aws-start-btn");
  const stopBtn = document.getElementById("aws-stop-btn");
  const extractBtn = document.getElementById("aws-extract-btn");

  if (startBtn) startBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;
  if (extractBtn) extractBtn.disabled = running;
}

/**
 * Start automation loop
 */
async function startAutomation(config) {
  if (isRunning) {
    updateStatus("Already running", "error");
    return;
  }

  const { startDate, endDate, typeFilter, delay } = config;

  console.log("[AWS] Starting automation with config:", config);

  if (!startDate || !endDate) {
    updateStatus("Please select start and end dates", "error");
    return;
  }

  if (new Date(startDate) > new Date(endDate)) {
    updateStatus("Start date must be before end date", "error");
    return;
  }

  isRunning = true;
  autoExtractEnabled = true;
  updateButtonStates(true);
  updateStatus("Starting auto-extraction...", "info");

  try {
    // Get available days
    const days = await getAvailableDays();
    console.log("[AWS] Available days:", days);

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
      updateStatus("No matching days found in range", "error");
      stopAutomation();
      return;
    }

    // Get already processed days
    const data = await getDataFromStorage();
    const processedDays = data?.processedDays || [];

    // Filter out already processed days
    const unprocessedDates = targetDates.filter(
      (date) => !processedDays.includes(date),
    );

    console.log("[AWS] Unprocessed dates:", unprocessedDates);

    if (unprocessedDates.length === 0) {
      updateStatus("All matching days already processed", "success");
      stopAutomation();
      loadAndDisplayData();
      return;
    }

    updateStatus(`Processing ${unprocessedDates.length} days...`, "info");

    // Process each unprocessed day
    let currentIndex = 0;

    const processNext = async () => {
      if (!isRunning || currentIndex >= unprocessedDates.length) {
        stopAutomation();
        if (currentIndex >= unprocessedDates.length) {
          updateStatus("All days processed!", "success");
          loadAndDisplayData();
        }
        return;
      }

      const currentDate = unprocessedDates[currentIndex];
      console.log(
        `[AWS] Processing day ${currentIndex + 1}/${unprocessedDates.length}:`,
        currentDate,
      );

      updateStatus(
        `Processing: ${currentDate} (${currentIndex + 1}/${unprocessedDates.length})`,
        "info",
      );

      try {
        // Click the day
        const clicked = clickDayElement(currentDate);

        if (!clicked) {
          console.warn("[AWS] Failed to click day:", currentDate);
          currentIndex++;
          setTimeout(processNext, delay);
          return;
        }

        // Wait for MutationObserver to detect changes and auto-extract
        // The MutationObserver will handle extraction automatically
        await new Promise((resolve) => setTimeout(resolve, delay));

        currentIndex++;
        processNext();
      } catch (error) {
        console.error("[AWS] Error processing day:", error);
        currentIndex++;
        setTimeout(processNext, delay);
      }
    };

    // Store controller for stopping
    automationController = {
      stop: () => {
        isRunning = false;
        autoExtractEnabled = false;
      },
    };

    // Start processing
    processNext();
  } catch (error) {
    console.error("[AWS] Automation error:", error);
    updateStatus("Error: " + error.message, "error");
    stopAutomation();
  }
}

/**
 * Stop automation
 */
function stopAutomation() {
  console.log("[AWS] Stopping automation");

  isRunning = false;
  autoExtractEnabled = false;

  if (automationController) {
    automationController.stop();
    automationController = null;
  }

  updateButtonStates(false);
  updateStatus("Automation stopped", "info");
}

/**
 * Extract anime schedule from current page view
 */
function extractCurrentSchedule() {
  console.log("[AWS] === Starting extraction ===");

  try {
    // Debug: Show what we're looking for
    console.log("[AWS] Looking for active day in #schedule-block...");
    const allDays = document.querySelectorAll("#schedule-block .day");
    console.log("[AWS] Found", allDays.length, "total day elements");

    const activeDay = document.querySelector(
      "#schedule-block .day.active .inner[data-time]",
    );
    if (!activeDay) {
      console.warn("[AWS] No active day found in schedule block");

      // Fallback: try to find any day with active class
      const fallbackActive = document.querySelector(
        ".day.active .inner[data-time]",
      );
      if (fallbackActive) {
        console.log("[AWS] Found active day using fallback selector");
        // Use fallback but continue
      } else {
        updateStatus("No active day found", "error");
        return;
      }
    }

    const currentDate = activeDay ? activeDay.getAttribute("data-time") : null;
    console.log("[AWS] Current date:", currentDate);

    // Debug: Show items container
    console.log("[AWS] Looking for items container...");
    const itemsContainer = document.querySelector(
      "#schedule-block .body .items",
    );

    if (!itemsContainer) {
      console.warn(
        "[AWS] Schedule items container not found with #schedule-block .body .items",
      );

      // Fallback selectors
      const fallback1 = document.querySelector("#schedule-block .items");
      const fallback2 = document.querySelector(".body .items");
      const fallback3 = document.querySelector("#schedule .items");

      if (fallback1) {
        console.log("[AWS] Using fallback selector: #schedule-block .items");
        // Continue with fallback1
      } else if (fallback2) {
        console.log("[AWS] Using fallback selector: .body .items");
        // Continue with fallback2
      } else if (fallback3) {
        console.log("[AWS] Using fallback selector: #schedule .items");
        // Continue with fallback3
      } else {
        console.error("[AWS] No items container found with any selector");
        updateStatus("Schedule items container not found", "error");
        return;
      }
    }

    // Use the found container (original or fallback)
    const container =
      itemsContainer ||
      document.querySelector("#schedule-block .items") ||
      document.querySelector(".body .items") ||
      document.querySelector("#schedule .items");

    console.log("[AWS] Items container found:", container);

    // Get all anime items
    const items = container.querySelectorAll("a.item");
    console.log("[AWS] Found", items.length, "anime items (a.item)");

    // Debug: Show first item structure
    if (items.length > 0) {
      const firstItem = items[0];
      console.log(
        "[AWS] First item HTML:",
        firstItem.outerHTML.substring(0, 200),
      );

      const timeEl = firstItem.querySelector(".time");
      const epEl = firstItem.querySelector(".ep span");
      const titleEl = firstItem.querySelector(".title.d-title");

      console.log("[AWS] First item elements:", {
        time: timeEl ? timeEl.textContent.trim() : "NOT FOUND",
        episode: epEl ? epEl.textContent.trim() : "NOT FOUND",
        title: titleEl ? titleEl.textContent.trim() : "NOT FOUND",
        jpTitle: titleEl ? titleEl.getAttribute("data-jp") : "NOT FOUND",
      });
    }

    if (items.length === 0) {
      console.warn("[AWS] No anime items found to extract");
      updateStatus("No anime items found", "error");
      return;
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
        type: getCurrentType(),
        extractedAt: new Date().toISOString(),
      };
    });

    console.log("[AWS] Extracted", extractedData.length, "items");
    console.log("[AWS] Sample extracted item:", extractedData[0]);

    // Send to background for caching
    chrome.runtime
      .sendMessage({
        type: "SAVE_DATA",
        data: extractedData,
      })
      .then((response) => {
        console.log("[AWS] Save response:", response);

        // Mark day as processed
        if (response && response.success) {
          console.log(
            "[AWS] Data saved successfully, marking day as processed",
          );
          chrome.runtime
            .sendMessage({
              type: "MARK_DAY_PROCESSED",
              day: currentDate,
            })
            .then(() => {
              console.log("[AWS] Day marked as processed:", currentDate);
              // Reload display after save
              setTimeout(() => {
                loadAndDisplayData();
              }, 300);
            });
        } else {
          console.error("[AWS] Save failed:", response);
        }
      })
      .catch((error) => {
        console.error("[AWS] Error sending message:", error);
      });

    updateStatus(
      `Extracted ${extractedData.length} items for ${currentDate}`,
      "success",
    );
  } catch (error) {
    console.error("[AWS] Extraction error:", error);
    console.error("[AWS] Error stack:", error.stack);
    updateStatus("Extraction failed: " + error.message, "error");
  }
}

/**
 * Click on a specific day element
 */
function clickDayElement(date) {
  console.log("[AWS] Attempting to click day:", date);

  try {
    // Look for day in schedule block
    const dayElement = document.querySelector(
      `#schedule-block .day .inner[data-time="${date}"]`,
    );

    if (!dayElement) {
      console.warn("[AWS] Day element not found:", date);
      return false;
    }

    // Click the parent .day element
    const dayContainer = dayElement.closest(".day");
    if (dayContainer) {
      console.log("[AWS] Clicking day element");
      dayContainer.click();

      // Also dispatch a custom event in case the site uses event listeners
      dayContainer.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );

      return true;
    }

    return false;
  } catch (error) {
    console.error("[AWS] Error clicking day:", error);
    return false;
  }
}

/**
 * Get all available days from the schedule
 */
async function getAvailableDays() {
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
}

/**
 * Get current selected type (SUB/DUB)
 */
function getCurrentType() {
  const activeTab = document.querySelector("#schedule-block .tabs .tab.active");
  return activeTab ? activeTab.getAttribute("data-name") || "sub" : "sub";
}

/**
 * Load data from storage and display in panel
 */
async function loadAndDisplayData() {
  console.log("[AWS] Loading and displaying data");

  try {
    const data = await getDataFromStorage();

    if (data && data.success) {
      console.log("[AWS] Loaded data:", {
        items: data.extractedData?.length || 0,
        processedDays: data.processedDays?.length || 0,
      });

      displayProcessedDays(data.processedDays || []);
      displaySavedItems(data.extractedData || []);

      if (data.lastUpdated) {
        console.log("[AWS] Last updated:", data.lastUpdated);
      }
    } else {
      console.warn("[AWS] Failed to load data or no data available");
      // Still display empty lists
      displayProcessedDays([]);
      displaySavedItems([]);
    }
  } catch (error) {
    console.error("[AWS] Error loading data:", error);
    // Display empty lists on error
    displayProcessedDays([]);
    displaySavedItems([]);
  }
}

/**
 * Get data from chrome storage
 */
function getDataFromStorage() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_DATA" }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[AWS] Chrome runtime error:", chrome.runtime.lastError);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Display processed days in panel
 */
function displayProcessedDays(days) {
  const container = document.getElementById("aws-processed-days");
  const countEl = document.getElementById("aws-processed-count");

  if (!container || !countEl) {
    console.warn(
      "[AWS] Panel elements not found for displaying processed days",
    );
    return;
  }

  countEl.textContent = days.length;

  if (!days || days.length === 0) {
    container.innerHTML = '<p class="aws-empty">No days processed yet</p>';
    console.log("[AWS] Displayed empty processed days list");
    return;
  }

  container.innerHTML = days
    .map((day) => {
      const dateObj = new Date(day);
      const displayDate = dateObj.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const weekday = dateObj.toLocaleDateString("en-US", { weekday: "short" });

      return `
      <div class="aws-day-item">
        <span class="aws-day-date">${displayDate}</span>
        <span class="aws-day-weekday">${weekday}</span>
      </div>
    `;
    })
    .join("");

  console.log("[AWS] Displayed", days.length, "processed days");
}

/**
 * Display saved anime items in panel
 */
function displaySavedItems(items) {
  const container = document.getElementById("aws-saved-items");
  const countEl = document.getElementById("aws-items-count");

  if (!container || !countEl) {
    console.warn("[AWS] Panel elements not found for displaying saved items");
    return;
  }

  countEl.textContent = items ? items.length : 0;

  if (!items || items.length === 0) {
    container.innerHTML = '<p class="aws-empty">No items saved yet</p>';
    console.log("[AWS] Displayed empty saved items list");
    return;
  }

  // Sort by date and time
  const sortedItems = [...items].sort((a, b) => {
    if (a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }
    return a.time.localeCompare(b.time);
  });

  container.innerHTML = sortedItems
    .map((item) => {
      const dateObj = new Date(item.date);
      const displayDate = dateObj.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });

      return `
      <div class="aws-anime-item">
        <div class="aws-anime-header">
          <span class="aws-anime-time">${escapeHtml(item.time)}</span>
          <span class="aws-anime-episode">${escapeHtml(item.episode)}</span>
        </div>
        <div class="aws-anime-title">${escapeHtml(item.title)}</div>
        ${item.japaneseTitle ? `<div class="aws-anime-jp">${escapeHtml(item.japaneseTitle)}</div>` : ""}
        <div class="aws-anime-meta">
          <span>${displayDate}</span>
          <span class="aws-badge">${item.type.toUpperCase()}</span>
          ${item.isOld ? '<span class="aws-badge aws-badge-old">OLD</span>' : ""}
        </div>
      </div>
    `;
    })
    .join("");

  console.log("[AWS] Displayed", items.length, "saved items");
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Clear all cached data
 */
async function clearAllData() {
  console.log("[AWS] Clearing all data");

  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA" }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[AWS] Chrome runtime error:",
            chrome.runtime.lastError,
          );
          resolve(null);
        } else {
          resolve(resp);
        }
      });
    });

    if (response && response.success) {
      displayProcessedDays([]);
      displaySavedItems([]);
      updateStatus("Cache cleared", "success");
    } else {
      updateStatus("Failed to clear cache", "error");
    }
  } catch (error) {
    console.error("[AWS] Error clearing data:", error);
    updateStatus("Error: " + error.message, "error");
  }
}

console.log("[AWS] Content script ready");
