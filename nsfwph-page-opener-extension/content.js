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
  // STATE
  // ============================================================
  let isRunning = false;
  let openedCount = 0;
  let skippedDuplicates = 0;
  let skippedExcluded = 0;
  let targetCount = 0;

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

  // NEW: Helper to highlight and scroll to active row
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

  // NEW: Cleanup helper
  function clearHighlight() {
    const active = document.querySelector(".pto-active-row");
    if (active) active.classList.remove("pto-active-row");
  }

  // ============================================================
  // CORE LOGIC
  // ============================================================
  async function startProcess() {
    const input = document.getElementById("pto-target");
    targetCount = parseInt(input.value, 10);

    if (!targetCount || targetCount <= 0) {
      alert("Please enter a valid target count.");
      return;
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
    log("▶️ Starting process", { targetCount, backgroundStats: stats });
    appendDebugLog(
      `START | target=${targetCount} | bg_opened=${stats.openedCount} | bg_pending=${stats.pendingCount}`,
    );
    updateStatus(`Starting... Target: ${targetCount}`);

    await processCurrentPage();
  }

  function stopProcess() {
    isRunning = false;
    clearHighlight(); // NEW: Clean up visual indicator on stop
    const summary = `Stopped. Opened: ${openedCount} | Dupes: ${skippedDuplicates} | Excluded: ${skippedExcluded}`;
    log("⏹️ Process stopped:", summary);
    appendDebugLog(`STOP | ${summary}`);
    updateStatus(summary);
    toggleButtons(false);
  }

  async function processCurrentPage() {
    if (!isRunning || openedCount >= targetCount) {
      if (openedCount >= targetCount) {
        clearHighlight(); // NEW: Clean up on completion
        const summary = `✅ Done! Opened: ${openedCount} | Dupes: ${skippedDuplicates} | Excluded: ${skippedExcluded}`;
        log("✅ Target reached:", summary);
        appendDebugLog(`DONE | ${summary}`);
        updateStatus(summary);
        stopProcess();
      }
      return;
    }

    const rows = document.querySelectorAll(
      "li.block-row.js-inlineModContainer",
    );
    log(`📄 Processing page: ${rows.length} rows found`);
    appendDebugLog(`PAGE | ${rows.length} rows found`);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!isRunning || openedCount >= targetCount) break;

      // NEW: Highlight current row and scroll into view
      highlightRow(row);

      // --- Exclusion check ---
      const forumLink = row.querySelector(
        '.contentRow-minor a[href^="/forums/"]',
      );
      const forumName = forumLink ? forumLink.textContent.trim() : "";

      if (forumName.includes(EXCLUDED_FORUM_TEXT)) {
        skippedExcluded++;
        log(`🚫 Row ${i}: Excluded forum "${forumName}"`);
        appendDebugLog(`SKIP[${i}] | excluded: ${forumName}`);
        continue;
      }

      // --- Get thread link ---
      const titleLink = row.querySelector("h3.contentRow-title a");
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
    if (isRunning && openedCount < targetCount) {
      const nextBtn = document.querySelector(
        "a.pageNav-jump--next, a.pageNavSimple-el--next",
      );

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
        const rows = document.querySelectorAll(
          "li.block-row.js-inlineModContainer",
        );
        if (rows.length > 0) {
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
