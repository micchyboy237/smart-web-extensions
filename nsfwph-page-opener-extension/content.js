(function () {
  if (document.getElementById("pto-panel")) return;
  // ============================================================
  // DEBUG CONFIGURATION
  // ============================================================
  const DEBUG = true;
  function log(...args) {
    if (DEBUG) console.log("[PTO-CS]", ...args);
  }
  function logWarn(...args) {
    if (DEBUG) console.warn("[PTO-CS]", ...args);
  }
  // ============================================================
  // CONFIGURATION
  // ============================================================
  const DELAY_BETWEEN_TABS_MS = 800;
  const DELAY_FOR_PAGE_LOAD_MS = 2000;
  const EXCLUDED_FORUM_TEXT = "Non-Pinay Videos";

  // ============================================================
  // PAGE STRUCTURE STRATEGIES
  // ============================================================

  /**
   * Strategy for Structure 1: Search results / block-row layout
   */
  const Structure1Strategy = {
    name: "Structure1 (Block Rows)",

    getRows() {
      return document.querySelectorAll("li.block-row.js-inlineModContainer");
    },

    getForumName(row) {
      const forumLink = row.querySelector(
        '.contentRow-minor a[href^="/forums/"]',
      );
      return forumLink ? forumLink.textContent.trim() : "";
    },

    getTitleLink(row) {
      return row.querySelector("h3.contentRow-title a");
    },

    getNextButton() {
      return document.querySelector(
        "a.pageNav-jump--next, a.pageNavSimple-el--next",
      );
    },

    isValidRow(row) {
      const titleLink = this.getTitleLink(row);
      return titleLink && titleLink.getAttribute("href");
    },
  };

  /**
   * Strategy for Structure 2: Article/message preview layout
   */
  const Structure2Strategy = {
    name: "Structure2 (Article Previews)",

    getRows() {
      return document.querySelectorAll(
        "article.message--articlePreview.js-inlineModContainer",
      );
    },

    getForumName(row) {
      // In structure 2, forum info might be in different location
      // Try multiple selectors
      const forumLink =
        row.querySelector('.labelLink a[href^="/forums/"]') ||
        row.querySelector(".articlePreview-headline .labelLink a");
      return forumLink ? forumLink.textContent.trim() : "";
    },

    getTitleLink(row) {
      return row.querySelector(".articlePreview-title a:not(.labelLink)");
    },

    getNextButton() {
      return document.querySelector(
        "a.pageNav-jump--next, a.pageNavSimple-el--next",
      );
    },

    isValidRow(row) {
      const titleLink = this.getTitleLink(row);
      return titleLink && titleLink.getAttribute("href");
    },
  };

  /**
   * Strategy Registry - detects and returns appropriate strategy
   */
  const StrategyRegistry = {
    strategies: [Structure1Strategy, Structure2Strategy],

    detect() {
      // Try each strategy to see which one finds rows
      for (const strategy of this.strategies) {
        const rows = strategy.getRows();
        if (rows.length > 0) {
          log(`📋 Detected page structure: ${strategy.name}`);
          return strategy;
        }
      }

      // Fallback to Structure1 if no rows found yet (page might still be loading)
      log("⚠️ No rows detected, defaulting to Structure1");
      return Structure1Strategy;
    },

    // Allow manual override if needed
    setStrategy(strategyName) {
      const strategy = this.strategies.find((s) =>
        s.name.includes(strategyName),
      );
      if (strategy) {
        log(`🔧 Manual strategy set to: ${strategy.name}`);
        return strategy;
      }
      return this.detect();
    },
  };

  // ============================================================
  // STATE
  // ============================================================
  let isRunning = false;
  let openedCount = 0;
  let skippedDuplicates = 0;
  let skippedExcluded = 0;
  let targetCount = null; // null means process all available rows
  let useTargetLimit = false; // toggle for using target limit
  let currentStrategy = null; // Will be set on initialization

  // ============================================================
  // COMMUNICATION WITH BACKGROUND WORKER
  // ============================================================
  async function checkAndOpenTab(url) {
    log("📡 Sending CHECK_AND_OPEN to background:", url);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "CHECK_AND_OPEN", url },
        (response) => {
          if (chrome.runtime.lastError) {
            logWarn("📡 Message error:", chrome.runtime.lastError.message);
            resolve({ opened: false, error: chrome.runtime.lastError.message });
          } else {
            log("📡 Response received:", response);
            resolve(
              response || {
                opened: false,
                error: "No response from background",
              },
            );
          }
        },
      );
    });
  }
  async function getStats() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
        resolve(response || {});
      });
    });
  }
  // ============================================================
  // UI CREATION
  // ============================================================
  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "pto-panel";
    panel.innerHTML = `
      <h4>🔗 Thread Opener <span id="pto-debug-toggle" style="cursor:pointer;font-size:11px;color:#666;margin-left:6px;">[debug]</span></h4>
      <div class="pto-row">
        <label>Page Structure:</label>
        <span id="pto-structure-name" style="color:#0f3460;font-weight:bold;font-size:11px;">Detecting...</span>
      </div>
      <div class="pto-row">
        <label>Current Page Available:</label>
        <span id="pto-available-count" style="color:#e94560;font-weight:bold;">-</span>
      </div>
      <div class="pto-row">
        <label>Use Target Limit:</label>
        <label class="switch">
          <input type="checkbox" id="pto-limit-toggle">
          <span class="slider"></span>
        </label>
      </div>
      <div class="pto-row" id="pto-target-row" style="display:none;">
        <label>Target Tabs:</label>
        <input type="number" id="pto-target" value="10" min="1" max="100" />
      </div>
      <div class="pto-row">
        <span id="pto-status">Ready</span>
      </div>
      <pre id="pto-debug-log" style="display:none;"></pre>
      <button id="pto-start-btn">Start Opening</button>
      <button id="pto-stop-btn" style="display:none; background:#d9534f;">Stop</button>
    `;
    document.body.appendChild(panel);

    // Add event listeners
    document
      .getElementById("pto-start-btn")
      .addEventListener("click", startProcess);
    document
      .getElementById("pto-stop-btn")
      .addEventListener("click", stopProcess);
    document
      .getElementById("pto-debug-toggle")
      .addEventListener("click", () => {
        const logEl = document.getElementById("pto-debug-log");
        logEl.style.display = logEl.style.display === "none" ? "block" : "none";
      });

    // Toggle switch for target limit
    document
      .getElementById("pto-limit-toggle")
      .addEventListener("change", (e) => {
        useTargetLimit = e.target.checked;
        const targetRow = document.getElementById("pto-target-row");
        targetRow.style.display = useTargetLimit ? "flex" : "none";
        updateAvailableCount(); // Refresh count display
      });

    // Initial detection and count update
    setTimeout(() => {
      currentStrategy = StrategyRegistry.detect();
      updateStructureDisplay();
      updateAvailableCount();
    }, 500);
  }

  // NEW: Update structure name display
  function updateStructureDisplay() {
    const el = document.getElementById("pto-structure-name");
    if (el && currentStrategy) {
      el.textContent = currentStrategy.name;
    }
  }

  // NEW: Count available rows on current page using current strategy
  function countAvailableRows() {
    if (!currentStrategy) {
      currentStrategy = StrategyRegistry.detect();
    }

    const rows = currentStrategy.getRows();
    let available = 0;
    let excluded = 0;

    rows.forEach((row) => {
      const forumName = currentStrategy.getForumName(row);

      if (forumName.includes(EXCLUDED_FORUM_TEXT)) {
        excluded++;
      } else if (currentStrategy.isValidRow(row)) {
        available++;
      }
    });

    return { total: rows.length, available, excluded };
  }

  // NEW: Update the available count display
  function updateAvailableCount() {
    const countEl = document.getElementById("pto-available-count");
    if (!countEl) return;

    const counts = countAvailableRows();

    if (useTargetLimit) {
      countEl.textContent = `${counts.available} (excl: ${counts.excluded})`;
    } else {
      countEl.textContent = `${counts.available} / ${counts.total}`;
    }
  }

  function appendDebugLog(msg) {
    if (!DEBUG) return;
    const logEl = document.getElementById("pto-debug-log");
    if (!logEl) return;
    const time = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      fractionalSecondDigits: 3,
    });
    logEl.textContent += `[${time}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Helper to highlight and scroll to active row
  function highlightRow(rowElement) {
    // Remove previous highlight
    const prev = document.querySelector(".pto-active-row");
    if (prev) prev.classList.remove("pto-active-row");
    // Add new highlight and scroll
    if (rowElement) {
      rowElement.classList.add("pto-active-row");
      rowElement.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // Cleanup helper
  function clearHighlight() {
    const active = document.querySelector(".pto-active-row");
    if (active) active.classList.remove("pto-active-row");
  }

  // ============================================================
  // CORE LOGIC
  // ============================================================
  async function startProcess() {
    // Re-detect strategy in case page structure changed
    currentStrategy = StrategyRegistry.detect();
    updateStructureDisplay();

    // Determine target count based on toggle
    if (useTargetLimit) {
      const input = document.getElementById("pto-target");
      targetCount = parseInt(input.value, 10);
      if (!targetCount || targetCount <= 0) {
        alert("Please enter a valid target count.");
        return;
      }
    } else {
      // Process all available rows
      const counts = countAvailableRows();
      targetCount = counts.available;
      if (targetCount === 0) {
        alert("No available threads to open on this page.");
        return;
      }
    }

    isRunning = true;
    openedCount = 0;
    skippedDuplicates = 0;
    skippedExcluded = 0;
    toggleButtons(true);

    // Clear debug log on new run
    const logEl = document.getElementById("pto-debug-log");
    if (logEl) logEl.textContent = "";

    const stats = await getStats();
    log("▶️ Starting process", {
      targetCount,
      useTargetLimit,
      strategy: currentStrategy.name,
      backgroundStats: stats,
    });

    appendDebugLog(
      `START | target=${targetCount} | limit=${useTargetLimit} | strategy=${currentStrategy.name} | bg_opened=${stats.openedCount} | bg_pending=${stats.pendingCount}`,
    );

    updateStatus(
      `Starting... Target: ${targetCount}${useTargetLimit ? " (limited)" : " (all available)"}`,
    );
    await processCurrentPage();
  }

  function stopProcess() {
    isRunning = false;
    clearHighlight();
    const summary = `Stopped. Opened: ${openedCount} | Dupes: ${skippedDuplicates} | Excluded: ${skippedExcluded}`;
    log("⏹️ Process stopped:", summary);
    appendDebugLog(`STOP | ${summary}`);
    updateStatus(summary);
    toggleButtons(false);
  }

  async function processCurrentPage() {
    if (!isRunning || (useTargetLimit && openedCount >= targetCount)) {
      if (useTargetLimit && openedCount >= targetCount) {
        clearHighlight();
        const summary = `✅ Done! Opened: ${openedCount} | Dupes: ${skippedDuplicates} | Excluded: ${skippedExcluded}`;
        log("✅ Target reached:", summary);
        appendDebugLog(`DONE | ${summary}`);
        updateStatus(summary);
        stopProcess();
      }
      return;
    }

    // Use current strategy to get rows
    const rows = currentStrategy.getRows();
    log(
      `📄 Processing page: ${rows.length} rows found (${currentStrategy.name})`,
    );
    appendDebugLog(`PAGE | ${rows.length} rows | ${currentStrategy.name}`);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!isRunning || (useTargetLimit && openedCount >= targetCount)) break;

      // Highlight current row and scroll into view
      highlightRow(row);

      // --- Exclusion check ---
      const forumName = currentStrategy.getForumName(row);
      if (forumName.includes(EXCLUDED_FORUM_TEXT)) {
        skippedExcluded++;
        log(`🚫 Row ${i}: Excluded forum "${forumName}"`);
        appendDebugLog(`SKIP[${i}] | excluded: ${forumName}`);
        continue;
      }

      // --- Get thread link ---
      const titleLink = currentStrategy.getTitleLink(row);
      if (!titleLink) {
        logWarn(`⚠️ Row ${i}: No title link found`);
        appendDebugLog(`WARN[${i}] | no title link`);
        continue;
      }

      let href = titleLink.getAttribute("href");
      if (!href) {
        logWarn(`⚠️ Row ${i}: Empty href`);
        appendDebugLog(`WARN[${i}] | empty href`);
        continue;
      }

      // Normalize to absolute URL
      if (href.startsWith("/")) {
        href = window.location.origin + href;
      }

      const titleText = titleLink.textContent.substring(0, 35);
      log(`🔗 Row ${i}: Checking "${titleText}..." → ${href}`);
      appendDebugLog(`CHECK[${i}] | ${titleText}`);

      // --- Ask background to check & open ---
      updateStatus(
        `Checking ${openedCount + skippedDuplicates + skippedExcluded + 1}: ${titleText}...`,
      );

      const result = await checkAndOpenTab(href);

      if (result.opened) {
        openedCount++;
        log(`✅ OPENED ${openedCount}/${targetCount}: tabId=${result.tabId}`);
        appendDebugLog(
          `OPEN[${i}] | #${openedCount}/${targetCount} | tab=${result.tabId}`,
        );
        updateStatus(`Opened ${openedCount}/${targetCount}: ${titleText}...`);
      } else if (result.duplicate) {
        skippedDuplicates++;
        log(`⏭️ DUPLICATE (${result.reason}): "${titleText}..."`);
        appendDebugLog(`DUPE[${i}] | ${result.reason} | ${titleText}`);
        updateStatus(`⏭️ Dupe (${result.reason}): ${titleText}...`);
      } else {
        logError(`❌ ERROR: ${result.error}`);
        appendDebugLog(`ERR[${i}] | ${result.error}`);
        updateStatus(`❌ Error: ${result.error || "Unknown"}`);
      }

      await sleep(DELAY_BETWEEN_TABS_MS);
    }

    // --- Paginate if target not yet reached ---
    if (isRunning && (!useTargetLimit || openedCount < targetCount)) {
      const nextBtn = currentStrategy.getNextButton();
      if (nextBtn) {
        log(`📃 Navigating to next page... (${openedCount}/${targetCount})`);
        appendDebugLog(
          `NEXT | moving to next page | ${openedCount}/${targetCount}`,
        );
        updateStatus(`Next page... (${openedCount}/${targetCount})`);
        await sleep(500);
        nextBtn.click();
        await waitForPageLoad();
        log("📃 New page loaded");
        appendDebugLog(`LOADED | new page ready`);

        // Re-detect strategy after page load (structure might change)
        currentStrategy = StrategyRegistry.detect();
        updateStructureDisplay();
        updateAvailableCount();

        await processCurrentPage();
      } else {
        const summary = `⚠️ No more pages. Opened: ${openedCount} | Dupes: ${skippedDuplicates} | Excluded: ${skippedExcluded}`;
        log("⚠️ Pagination ended:", summary);
        appendDebugLog(`END | ${summary}`);
        updateStatus(summary);
        stopProcess();
      }
    }
  }

  // ============================================================
  // UTILITIES
  // ============================================================
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForPageLoad() {
    return new Promise((resolve) => {
      let checks = 0;
      const checkInterval = setInterval(() => {
        checks++;
        // Check for both possible row types
        const rows1 = document.querySelectorAll(
          "li.block-row.js-inlineModContainer",
        );
        const rows2 = document.querySelectorAll(
          "article.message--articlePreview.js-inlineModContainer",
        );

        if (rows1.length > 0 || rows2.length > 0) {
          log(`📃 Page load confirmed after ${checks} checks`);
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);

      setTimeout(() => {
        clearInterval(checkInterval);
        logWarn(`📃 Page load timeout after ${checks} checks`);
        resolve();
      }, DELAY_FOR_PAGE_LOAD_MS * 2);
    });
  }

  function updateStatus(msg) {
    const el = document.getElementById("pto-status");
    if (el) el.textContent = msg;
  }

  function toggleButtons(running) {
    document.getElementById("pto-start-btn").style.display = running
      ? "none"
      : "inline-block";
    document.getElementById("pto-stop-btn").style.display = running
      ? "inline-block"
      : "none";
  }

  // Initialize
  createPanel();
})();
