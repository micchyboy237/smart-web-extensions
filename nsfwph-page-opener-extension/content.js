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
  const Structure2Strategy = {
    name: "Structure2 (Article Previews)",
    getRows() {
      return document.querySelectorAll(
        "article.message--articlePreview.js-inlineModContainer",
      );
    },
    getForumName(row) {
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
  const StrategyRegistry = {
    strategies: [Structure1Strategy, Structure2Strategy],
    detect() {
      for (const strategy of this.strategies) {
        const rows = strategy.getRows();
        if (rows.length > 0) {
          log(`📋 Detected page structure: ${strategy.name}`);
          return strategy;
        }
      }
      log("⚠️ No rows detected, defaulting to Structure1");
      return Structure1Strategy;
    },
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
  let targetCount = null;
  let useTargetLimit = false;
  let autoCloseIfReacted = false;
  let currentStrategy = null;
  // ============================================================
  // STORAGE HELPERS
  // ============================================================
  const SESSION_KEY_PREFIX = "pto_session_";

  function saveToSession(key, value) {
    try {
      sessionStorage.setItem(SESSION_KEY_PREFIX + key, JSON.stringify(value));
    } catch (e) {
      logWarn("Failed to save to session:", e);
    }
  }

  function loadFromSession(key, defaultValue = null) {
    try {
      const value = sessionStorage.getItem(SESSION_KEY_PREFIX + key);
      return value !== null ? JSON.parse(value) : defaultValue;
    } catch (e) {
      logWarn("Failed to load from session:", e);
      return defaultValue;
    }
  }

  async function saveAutoCloseSetting(enabled) {
    try {
      await chrome.storage.local.set({ pto_autoCloseIfReacted: enabled });
      log(`💾 Saved autoCloseIfReacted=${enabled} to chrome.storage.local`);
    } catch (e) {
      logWarn("Failed to save auto-close setting:", e);
    }
  }

  async function loadAutoCloseSetting() {
    try {
      const result = await chrome.storage.local.get("pto_autoCloseIfReacted");
      const value = result.pto_autoCloseIfReacted ?? false;
      log(`📂 Loaded autoCloseIfReacted=${value} from chrome.storage.local`);
      return value;
    } catch (e) {
      logWarn("Failed to load auto-close setting:", e);
      return false;
    }
  }

  function loadPanelState() {
    return {
      useTargetLimit: loadFromSession("useTargetLimit", false),
      targetCount: loadFromSession("targetCount", 10),
    };
  }

  function savePanelState() {
    saveToSession("useTargetLimit", useTargetLimit);
    saveToSession("targetCount", targetCount);
  }
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
  // REACTION DETECTION (FIXED)
  // ============================================================

  /**
   * Determine if this page is a thread/post page.
   */
  function isThreadOrPostPage() {
    const path = window.location.pathname;
    return (
      /^\/threads\/\d+/.test(path) ||
      /^\/posts\/\d+/.test(path) ||
      /#post-\d+/.test(window.location.hash)
    );
  }

  /**
   * Check if user has reacted to the MAIN POST of the thread.
   * We scope the search to .js-post or .message to avoid sidebar/widgets.
   */
  function hasUserReaction() {
    // Scope 1: Look for the first main post container
    // XenForo usually marks the main post with .js-post or inside .block-body
    const mainPost =
      document.querySelector(".js-post:first-of-type") ||
      document.querySelector(".message:first-of-type");

    if (!mainPost) {
      // Fallback: If we can't find a specific post container, check the whole body
      // but be very strict about the selector
      log("⚠️ Could not find main post container, checking global scope");

      // Method A: Global 'has-reaction' class
      const globalReacted = document.querySelector("a.reaction.has-reaction");
      if (globalReacted) {
        // Double check: Is it inside a message block?
        if (
          globalReacted.closest(".message") ||
          globalReacted.closest(".js-post")
        ) {
          log("✅ Found global reaction inside message block");
          return true;
        }
        log(
          "❌ Found global reaction BUT it's outside a message block (likely widget)",
        );
        return false;
      }
    } else {
      // Method B: Scoped to Main Post
      const reactedBtn = mainPost.querySelector("a.reaction.has-reaction");
      if (reactedBtn) {
        log("✅ Found reaction via 'has-reaction' class in main post");
        return true;
      }

      // Method C: Check image hidden status in main post
      const reactionBtn = mainPost.querySelector(
        'a.reaction[data-xf-init="reaction"]',
      );
      if (
        reactionBtn &&
        !reactionBtn.classList.contains("reaction--imageHidden")
      ) {
        log(
          "✅ Found reaction via missing 'reaction--imageHidden' in main post",
        );
        return true;
      }
    }

    // Method D: Check for specific action bar structure in main post
    const actionBar = document.querySelector(
      ".js-post:first-of-type .message-actionBar.has-reaction",
    );
    if (actionBar) {
      log("✅ Found reaction via action bar class in main post");
      return true;
    }

    log("❌ No reaction detected in main post");
    return false;
  }

  /**
   * Auto-close tab if user has already reacted.
   */
  async function checkAndAutoClose() {
    if (!isThreadOrPostPage()) {
      log("ℹ️ Skipping auto-close check: not a thread/post page");
      return false;
    }

    const autoCloseEnabled = await loadAutoCloseSetting();
    if (!autoCloseEnabled) {
      log("ℹ️ Auto-close feature is disabled");
      return false;
    }

    // Wait a bit more for dynamic content/XF JS to render classes
    await new Promise((r) => setTimeout(r, 500));

    const hasReaction = hasUserReaction();
    if (hasReaction) {
      log("🚫 User has already reacted - closing tab");
      setTimeout(() => {
        window.close();
        if (!window.closed) {
          logWarn("⚠️ Could not close tab via window.close()");
          document.body.innerHTML =
            '<div style="text-align:center;padding:50px;font-family:sans-serif;">' +
            "<h2>Already Reacted ✓</h2>" +
            "<p>This tab can be closed.</p></div>";
        }
      }, 500);
      return true;
    }
    return false;
  }
  // ============================================================
  // AUTO-CLOSE ON PAGE LOAD
  // ============================================================
  (async function autoCloseOnLoad() {
    await new Promise((r) => setTimeout(r, 1000));
    if (!isThreadOrPostPage()) {
      log("ℹ️ Auto-close on load: skipping (not a thread/post page)");
      return;
    }
    log("🔄 Auto-close on load: checking thread/post page...");
    await checkAndAutoClose();
  })();
  // ============================================================
  // UI CREATION
  // ============================================================
  async function createPanel() {
    const savedState = loadPanelState();
    useTargetLimit = savedState.useTargetLimit;
    targetCount = savedState.targetCount || 10;
    autoCloseIfReacted = await loadAutoCloseSetting();

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
          <input type="checkbox" id="pto-limit-toggle" ${useTargetLimit ? "checked" : ""}>
          <span class="slider"></span>
        </label>
      </div>
      <div class="pto-row" id="pto-target-row" style="display:${useTargetLimit ? "flex" : "none"};">
        <label>Target Tabs:</label>
        <input type="number" id="pto-target" value="${targetCount}" min="1" max="100" />
      </div>
      <div class="pto-row">
        <label>Auto-Close If Reacted:</label>
        <label class="switch">
          <input type="checkbox" id="pto-autoclose-toggle" ${autoCloseIfReacted ? "checked" : ""}>
          <span class="slider"></span>
        </label>
      </div>
      <div class="pto-row">
        <span id="pto-status">Ready</span>
      </div>
      <pre id="pto-debug-log" style="display:none;"></pre>
      <button id="pto-start-btn">Start Opening</button>
      <button id="pto-stop-btn" style="display:none; background:#d9534f;">Stop</button>
    `;
    document.body.appendChild(panel);

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

    document
      .getElementById("pto-limit-toggle")
      .addEventListener("change", (e) => {
        useTargetLimit = e.target.checked;
        const targetRow = document.getElementById("pto-target-row");
        targetRow.style.display = useTargetLimit ? "flex" : "none";
        updateAvailableCount();
        savePanelState();
      });

    document
      .getElementById("pto-autoclose-toggle")
      .addEventListener("change", async (e) => {
        autoCloseIfReacted = e.target.checked;
        log(
          `🔄 Auto-close if reacted: ${autoCloseIfReacted ? "ENABLED" : "DISABLED"}`,
        );
        await saveAutoCloseSetting(autoCloseIfReacted);
      });

    document.getElementById("pto-target").addEventListener("change", (e) => {
      targetCount = parseInt(e.target.value, 10);
      savePanelState();
    });

    setTimeout(() => {
      currentStrategy = StrategyRegistry.detect();
      updateStructureDisplay();
      updateAvailableCount();
    }, 500);
  }

  function updateStructureDisplay() {
    const el = document.getElementById("pto-structure-name");
    if (el && currentStrategy) {
      el.textContent = currentStrategy.name;
    }
  }

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

  function highlightRow(rowElement) {
    const prev = document.querySelector(".pto-active-row");
    if (prev) prev.classList.remove("pto-active-row");
    if (rowElement) {
      rowElement.classList.add("pto-active-row");
      rowElement.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function clearHighlight() {
    const active = document.querySelector(".pto-active-row");
    if (active) active.classList.remove("pto-active-row");
  }
  // ============================================================
  // CORE LOGIC
  // ============================================================
  async function startProcess() {
    currentStrategy = StrategyRegistry.detect();
    updateStructureDisplay();
    if (useTargetLimit) {
      const input = document.getElementById("pto-target");
      targetCount = parseInt(input.value, 10);
      if (!targetCount || targetCount <= 0) {
        alert("Please enter a valid target count.");
        return;
      }
    } else {
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
    const logEl = document.getElementById("pto-debug-log");
    if (logEl) logEl.textContent = "";
    const stats = await getStats();
    log("▶️ Starting process", {
      targetCount,
      useTargetLimit,
      autoCloseIfReacted,
      strategy: currentStrategy.name,
      backgroundStats: stats,
    });
    appendDebugLog(
      `START | target=${targetCount} | limit=${useTargetLimit} | autoclose=${autoCloseIfReacted} | strategy=${currentStrategy.name} | bg_opened=${stats.openedCount} | bg_pending=${stats.pendingCount}`,
    );
    updateStatus(
      `Starting... Target: ${targetCount}${useTargetLimit ? " (limited)" : " (all available)"}${autoCloseIfReacted ? " [Auto-Close ON]" : ""}`,
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
    const rows = currentStrategy.getRows();
    log(
      `📄 Processing page: ${rows.length} rows found (${currentStrategy.name})`,
    );
    appendDebugLog(`PAGE | ${rows.length} rows | ${currentStrategy.name}`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!isRunning || (useTargetLimit && openedCount >= targetCount)) break;
      highlightRow(row);
      const forumName = currentStrategy.getForumName(row);
      if (forumName.includes(EXCLUDED_FORUM_TEXT)) {
        skippedExcluded++;
        log(`🚫 Row ${i}: Excluded forum "${forumName}"`);
        appendDebugLog(`SKIP[${i}] | excluded: ${forumName}`);
        continue;
      }
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
      if (href.startsWith("/")) {
        href = window.location.origin + href;
      }
      const titleText = titleLink.textContent.substring(0, 35);
      log(`🔗 Row ${i}: Checking "${titleText}..." → ${href}`);
      appendDebugLog(`CHECK[${i}] | ${titleText}`);
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
