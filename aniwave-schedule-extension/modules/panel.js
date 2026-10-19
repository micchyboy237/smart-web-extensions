// Panel module - handles UI injection and display

console.log("[AWS] Panel module loaded");

if (!window.AWSPanel) {
  window.AWSPanel = {};
}

Object.assign(window.AWSPanel, {
  /**
   * Format date for input field (YYYY-MM-DD)
   */
  formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  },

  /**
   * Inject the control panel into the page
   */
  inject() {
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
            <input type="number" id="aws-delay" value="3000" min="1000" max="10000" step="500" />
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
  },

  /**
   * Update status message in panel
   */
  updateStatus(message, type = "info") {
    const statusEl = document.getElementById("aws-status");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `aws-status aws-status-${type}`;
    }
    console.log(`[AWS] Status (${type}):`, message);
  },

  /**
   * Update button states
   */
  updateButtonStates(running) {
    const startBtn = document.getElementById("aws-start-btn");
    const stopBtn = document.getElementById("aws-stop-btn");
    const extractBtn = document.getElementById("aws-extract-btn");

    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
    if (extractBtn) extractBtn.disabled = running;
  },

  /**
   * Display processed days in panel
   */
  displayProcessedDays(days) {
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
        const weekday = dateObj.toLocaleDateString("en-US", {
          weekday: "short",
        });

        return `
          <div class="aws-day-item">
            <span class="aws-day-date">${displayDate}</span>
            <span class="aws-day-weekday">${weekday}</span>
          </div>
        `;
      })
      .join("");

    console.log("[AWS] Displayed", days.length, "processed days");
  },

  /**
   * Display saved anime items in panel
   */
  displaySavedItems(items) {
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
              <span class="aws-anime-time">${this.escapeHtml(item.time)}</span>
              <span class="aws-anime-episode">${this.escapeHtml(item.episode)}</span>
            </div>
            <div class="aws-anime-title">${this.escapeHtml(item.title)}</div>
            ${item.japaneseTitle ? `<div class="aws-anime-jp">${this.escapeHtml(item.japaneseTitle)}</div>` : ""}
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
  },

  /**
   * Set default dates based on available days
   */
  async setDefaultDates() {
    try {
      const days = window.AWSExtractor.getAvailableDays();

      if (days.length > 0) {
        // Sort days by date
        const sortedDays = [...days].sort(
          (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
        );

        const firstDay = sortedDays[0];
        const lastDay = sortedDays[sortedDays.length - 1];

        const startDateInput = document.getElementById("aws-start-date");
        const endDateInput = document.getElementById("aws-end-date");

        if (startDateInput) {
          startDateInput.value = firstDay.date;
          console.log("[AWS] Set start date to:", firstDay.date);
        }

        if (endDateInput) {
          endDateInput.value = lastDay.date;
          console.log("[AWS] Set end date to:", lastDay.date);
        }
      }
    } catch (error) {
      console.error("[AWS] Error setting default dates:", error);
    }
  },

  /**
   * Load and display data from storage
   */
  async loadAndDisplayData() {
    console.log("[AWS] Loading and displaying data");

    try {
      const data = await window.AWSStorage.getData();

      if (data && data.success) {
        console.log("[AWS] Loaded data:", {
          items: data.extractedData?.length || 0,
          processedDays: data.processedDays?.length || 0,
        });

        this.displayProcessedDays(data.processedDays || []);
        this.displaySavedItems(data.extractedData || []);

        if (data.lastUpdated) {
          console.log("[AWS] Last updated:", data.lastUpdated);
        }
      } else {
        console.warn("[AWS] Failed to load data or no data available");
        this.displayProcessedDays([]);
        this.displaySavedItems([]);
      }
    } catch (error) {
      console.error("[AWS] Error loading data:", error);
      this.displayProcessedDays([]);
      this.displaySavedItems([]);
    }
  },

  /**
   * Setup event listeners for panel elements
   */
  setupListeners() {
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
          delay: parseInt(document.getElementById("aws-delay").value) || 3000,
        };

        window.AWSContent.startAutomation(config);
      });
    }

    // Stop button
    const stopBtn = document.getElementById("aws-stop-btn");
    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        window.AWSContent.stopAutomation();
      });
    }

    // Extract current button
    const extractBtn = document.getElementById("aws-extract-btn");
    if (extractBtn) {
      extractBtn.addEventListener("click", () => {
        window.AWSContent.extractCurrent();
      });
    }

    // Clear button
    const clearBtn = document.getElementById("aws-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        if (confirm("[AWS] Are you sure you want to clear all cached data?")) {
          const response = await window.AWSStorage.clearData();
          if (response && response.success) {
            this.displayProcessedDays([]);
            this.displaySavedItems([]);
            this.updateStatus("Cache cleared", "success");
          } else {
            this.updateStatus("Failed to clear cache", "error");
          }
        }
      });
    }

    // Refresh button
    const refreshBtn = document.getElementById("aws-refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        this.loadAndDisplayData();
      });
    }

    // Test button
    const testBtn = document.getElementById("aws-test-btn");
    if (testBtn) {
      testBtn.addEventListener("click", () => {
        console.log("[AWS] === Running selector tests ===");

        // Test selectors
        const scheduleBlock = document.querySelector("#schedule-block");
        console.log(
          "[AWS] #schedule-block:",
          scheduleBlock ? "FOUND" : "NOT FOUND",
        );

        const activeDay = document.querySelector(
          "#schedule-block .day.active .inner[data-time]",
        );
        console.log("[AWS] Active day:", activeDay ? "FOUND" : "NOT FOUND");
        if (activeDay) {
          console.log("[AWS]   Date:", activeDay.getAttribute("data-time"));
        }

        const itemsContainer = document.querySelector(
          "#schedule-block .body .items",
        );
        console.log(
          "[AWS] Items container:",
          itemsContainer ? "FOUND" : "NOT FOUND",
        );

        const allItems = document.querySelectorAll("#schedule-block a.item");
        console.log("[AWS] Total items:", allItems.length);

        const nextBtn = document.querySelector("#schedule-block .days .next");
        const prevBtn = document.querySelector("#schedule-block .days .prev");
        console.log("[AWS] Next button:", nextBtn ? "FOUND" : "NOT FOUND");
        console.log("[AWS] Prev button:", prevBtn ? "FOUND" : "NOT FOUND");

        console.log("[AWS] === Selector tests complete ===");
        this.updateStatus("Check console for test results", "info");
      });
    }
  },
});

console.log("[AWS] Panel module initialized on window");
