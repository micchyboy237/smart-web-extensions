(function () {
  // Prevent double injection
  if (document.getElementById("pto-panel")) return;

  // --- CONFIGURATION ---
  const DELAY_BETWEEN_TABS_MS = 800; // Delay to avoid browser popup blocker
  const DELAY_FOR_PAGE_LOAD_MS = 2000; // Wait time after clicking Next page
  const EXCLUDED_FORUM_TEXT = "Non-Pinay Videos";

  // --- STATE ---
  let isRunning = false;
  let openedCount = 0;
  let targetCount = 0;

  // --- UI CREATION ---
  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "pto-panel";
    panel.innerHTML = `
      <h4>🔗 Thread Opener</h4>
      <div class="pto-row">
        <label>Target Tabs:</label>
        <input type="number" id="pto-target" value="10" min="1" max="100" />
      </div>
      <div class="pto-row">
        <span id="pto-status">Ready</span>
      </div>
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
  }

  // --- CORE LOGIC ---
  async function startProcess() {
    const input = document.getElementById("pto-target");
    targetCount = parseInt(input.value, 10);

    if (!targetCount || targetCount <= 0) {
      alert("Please enter a valid target count.");
      return;
    }

    isRunning = true;
    openedCount = 0;
    toggleButtons(true);
    updateStatus(`Starting... Target: ${targetCount}`);

    await processCurrentPage();
  }

  function stopProcess() {
    isRunning = false;
    updateStatus(`Stopped. Opened: ${openedCount}`);
    toggleButtons(false);
  }

  async function processCurrentPage() {
    if (!isRunning || openedCount >= targetCount) {
      if (openedCount >= targetCount) {
        updateStatus(`✅ Done! Opened ${openedCount} tabs.`);
        stopProcess();
      }
      return;
    }

    // 1. Get all thread rows on current page
    const rows = document.querySelectorAll(
      "li.block-row.js-inlineModContainer",
    );

    for (const row of rows) {
      if (!isRunning || openedCount >= targetCount) break;

      // 2. Check for exclusion
      const forumLink = row.querySelector(
        '.contentRow-minor a[href^="/forums/"]',
      );
      const forumName = forumLink ? forumLink.textContent.trim() : "";

      if (forumName.includes(EXCLUDED_FORUM_TEXT)) {
        continue; // Skip this row
      }

      // 3. Get thread link
      const titleLink = row.querySelector("h3.contentRow-title a");
      if (!titleLink) continue;

      let href = titleLink.getAttribute("href");
      if (!href) continue;

      // Ensure absolute URL
      if (href.startsWith("/")) {
        href = window.location.origin + href;
      }

      // 4. Open tab
      updateStatus(
        `Opening ${openedCount + 1}/${targetCount}: ${titleLink.textContent.substring(0, 30)}...`,
      );
      window.open(href, "_blank");
      openedCount++;

      // Delay between opens to prevent browser blocking
      await sleep(DELAY_BETWEEN_TABS_MS);
    }

    // 5. If we still need more, go to next page
    if (isRunning && openedCount < targetCount) {
      const nextBtn = document.querySelector(
        "a.pageNav-jump--next, a.pageNavSimple-el--next",
      );

      if (nextBtn) {
        updateStatus(
          `Page exhausted. Moving to next page... (${openedCount}/${targetCount})`,
        );
        await sleep(500);
        nextBtn.click();

        // Wait for new page content to load
        await waitForPageLoad();
        await processCurrentPage();
      } else {
        updateStatus(`⚠️ No more pages found. Opened ${openedCount} tabs.`);
        stopProcess();
      }
    }
  }

  // --- UTILITIES ---
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForPageLoad() {
    return new Promise((resolve) => {
      // Simple approach: wait fixed time then check if rows exist
      // For XF forums, DOM replacement happens via AJAX
      const checkInterval = setInterval(() => {
        const rows = document.querySelectorAll(
          "li.block-row.js-inlineModContainer",
        );
        if (rows.length > 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);

      // Fallback timeout
      setTimeout(() => {
        clearInterval(checkInterval);
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
