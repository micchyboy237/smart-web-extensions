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

  const DataListStrategy = {
    name: "DataList (Quick Search Results)",
    getRows() {
      return document.querySelectorAll(".dataList-row");
    },
    getForumName(row) {
      return "";
    },
    getTitleLink(row) {
      const cells = row.querySelectorAll("td.dataList-cell");
      if (cells.length >= 2) {
        const links = cells[1].querySelectorAll("a[href^='/threads/']");
        for (const link of links) {
          if (link.textContent.trim()) {
            return link;
          }
        }
        return links.length > 0 ? links[0] : null;
      }
      return null;
    },
    getNextButton() {
      return null;
    },
    isValidRow(row) {
      const titleLink = this.getTitleLink(row);
      return titleLink && titleLink.getAttribute("href");
    },
  };

  const StrategyRegistry = {
    strategies: [Structure1Strategy, Structure2Strategy, DataListStrategy],
    detect() {
      const dataListRows = DataListStrategy.getRows();
      if (dataListRows.length > 0) {
        log(
          `📋 Detected page structure: ${DataListStrategy.name} (${dataListRows.length} rows)`,
        );
        return DataListStrategy;
      }

      const blockRows = Structure1Strategy.getRows();
      if (blockRows.length > 0) {
        log(`📋 Detected page structure: ${Structure1Strategy.name}`);
        return Structure1Strategy;
      }

      const articleRows = Structure2Strategy.getRows();
      if (articleRows.length > 0) {
        log(`📋 Detected page structure: ${Structure2Strategy.name}`);
        return Structure2Strategy;
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
  let hasProcessedDataList = false;
  let currentPanelType = "structured"; // 'structured' or 'threads'

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
    log("📡 [REQ] Sending CHECK_AND_OPEN to background:", url);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "CHECK_AND_OPEN", url },
        (response) => {
          if (chrome.runtime.lastError) {
            logWarn("📡 Message error:", chrome.runtime.lastError.message);
            resolve({ opened: false, error: chrome.runtime.lastError.message });
          } else {
            log("📡 [RES] Response received:", response);
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
  // PANEL DETECTION & CREATION
  // ============================================================
  function isThreadsPage() {
    return (
      /\/threads\/\d+/.test(window.location.href) ||
      /\/posts\/\d+/.test(window.location.href)
    );
  }

  async function createPanel() {
    const savedState = loadPanelState();
    useTargetLimit = savedState.useTargetLimit;
    targetCount = savedState.targetCount || 10;
    autoCloseIfReacted = await loadAutoCloseSetting();

    const panel = document.createElement("div");
    panel.id = "pto-panel";

    if (isThreadsPage()) {
      currentPanelType = "threads";
      panel.innerHTML = await loadThreadsPanelHTML();
      setupThreadsPanel(panel);
    } else {
      currentPanelType = "structured";
      panel.innerHTML = await loadStructuredPanelHTML();
      setupStructuredPanel(panel);
    }

    document.body.appendChild(panel);
  }

  async function loadStructuredPanelHTML() {
    // In production, this would fetch from panel-structured.html
    // For now, we'll use inline HTML
    return `
      <div class="pto-panel-content">
        <h4>🔗 Thread Opener <span class="pto-debug-toggle" style="cursor:pointer;font-size:11px;color:#666;margin-left:6px;">[debug]</span></h4>
        
        <div class="pto-row">
          <label>Page Structure:</label>
          <span class="pto-structure-name" style="color:#0f3460;font-weight:bold;font-size:11px;">Detecting...</span>
        </div>
        
        <div class="pto-row">
          <label>Current Page Available:</label>
          <span class="pto-available-count" style="color:#e94560;font-weight:bold;">-</span>
        </div>
        
        <div class="pto-row">
          <label>Use Target Limit:</label>
          <label class="switch">
            <input type="checkbox" class="pto-limit-toggle" ${useTargetLimit ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>
        
        <div class="pto-row pto-target-row" style="display:${useTargetLimit ? "flex" : "none"};">
          <label>Target Tabs:</label>
          <input type="number" class="pto-target-input" value="${targetCount}" min="1" max="100" />
        </div>
        
        <div class="pto-row">
          <label>Auto-Close If Reacted:</label>
          <label class="switch">
            <input type="checkbox" class="pto-autoclose-toggle" ${autoCloseIfReacted ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>
        
        <div class="pto-row">
          <span class="pto-status">Ready</span>
        </div>
        
        <pre class="pto-debug-log" style="display:none;"></pre>
        
        <button class="pto-start-btn">Start Opening</button>
        <button class="pto-stop-btn" style="display:none; background:#d9534f;">Stop</button>
      </div>
    `;
  }

  async function loadThreadsPanelHTML() {
    // In production, this would fetch from panel-threads.html
    // For now, we'll use inline HTML
    return `
      <div class="pto-panel-content">
        <h4>📖 Opened Thread</h4>
        
        <div class="pto-thread-info">
          <div class="pto-section">
            <h5>BBCode Blocks</h5>
            <div class="pto-bbcode-list"></div>
          </div>
          
          <div class="pto-section">
            <h5>Reactions</h5>
            <div class="pto-reaction-info"></div>
            <div class="pto-reaction-actions"></div>
          </div>
        </div>
        
        <div class="pto-row">
          <span class="pto-status">Analyzing thread...</span>
        </div>
      </div>
    `;
  }

  function setupStructuredPanel(panel) {
    panel
      .querySelector(".pto-start-btn")
      .addEventListener("click", startProcess);
    panel.querySelector(".pto-stop-btn").addEventListener("click", stopProcess);
    panel.querySelector(".pto-debug-toggle").addEventListener("click", () => {
      const logEl = panel.querySelector(".pto-debug-log");
      logEl.style.display = logEl.style.display === "none" ? "block" : "none";
    });
    panel.querySelector(".pto-limit-toggle").addEventListener("change", (e) => {
      useTargetLimit = e.target.checked;
      const targetRow = panel.querySelector(".pto-target-row");
      targetRow.style.display = useTargetLimit ? "flex" : "none";
      updateAvailableCount();
      savePanelState();
    });
    panel
      .querySelector(".pto-autoclose-toggle")
      .addEventListener("change", async (e) => {
        autoCloseIfReacted = e.target.checked;
        log(
          `🔄 Auto-close if reacted: ${autoCloseIfReacted ? "ENABLED" : "DISABLED"}`,
        );
        await saveAutoCloseSetting(autoCloseIfReacted);
      });
    panel.querySelector(".pto-target-input").addEventListener("change", (e) => {
      targetCount = parseInt(e.target.value, 10);
      savePanelState();
    });

    setTimeout(() => {
      currentStrategy = StrategyRegistry.detect();
      updateStructureDisplay();
      updateAvailableCount();
    }, 500);
  }

  function setupThreadsPanel(panel) {
    // Fire and forget, or handle promise if needed
    analyzeThreadContent(panel).catch((err) => {
      logError("Failed to analyze thread:", err);
      updateStatus("Error analyzing thread");
    });
  }

  // ============================================================
  // THREADS PANEL FUNCTIONALITY
  // ============================================================
  async function analyzeThreadContent(panel) {
    // 1. Set initial status
    updateStatus("Analyzing thread content...");
    try {
      // 2. Perform the heavy lifting (includes the 3s tooltip wait)
      const reactionInfo = await getReactionInfo();

      // 3. Render the UI components
      updateBbCodeBlocks(panel, null); // ✅ This is already correct - no changes needed
      updateReactionInfo(panel, reactionInfo);

      // ✅ FIX: Only show reactions that are required by remaining hidden blocks
      // Changed from reactionInfo.availableReactions to reactionInfo.requiredReactions
      const reactionsToShow = reactionInfo.hasReaction
        ? reactionInfo.requiredReactions.filter(
            (r) => r.id !== reactionInfo.currentReaction.id,
          )
        : reactionInfo.requiredReactions;

      showReactionButtons(panel, reactionsToShow, reactionInfo.currentReaction);

      // Update status
      if (reactionInfo.hasReaction) {
        updateStatus(`Ready (Reacted: ${reactionInfo.currentReaction.title})`);
      } else {
        updateStatus("Ready (Select a reaction above)");
      }
    } catch (error) {
      logError("❌ [UI] Error during thread analysis:", error);
      updateStatus("Error analyzing thread");
    }
  }

  /**
   * Dynamically waits for the .reactTooltip to appear using MutationObserver.
   * This is significantly faster and more reliable than a static setTimeout.
   */
  async function findReactTooltipDynamic(triggerBtn, maxWaitMs = 5000) {
    if (!triggerBtn) {
      logWarn(`⚠️ [TOOLTIP-DYNAMIC] No trigger button provided.`);
      return null;
    }

    return new Promise((resolve) => {
      // 1. Check if it already exists (edge case)
      const existingTooltip = document.querySelector(".reactTooltip");
      if (existingTooltip) {
        log(`✅ [TOOLTIP-DYNAMIC] Tooltip already present in DOM.`);
        resolve(existingTooltip);
        return;
      }

      // 2. Setup MutationObserver to watch for DOM changes
      const observer = new MutationObserver((mutations, obs) => {
        const tooltip = document.querySelector(".reactTooltip");
        if (tooltip) {
          log(`✅ [TOOLTIP-DYNAMIC] Tooltip detected via MutationObserver!`);
          obs.disconnect(); // Stop watching
          clearTimeout(timeoutId); // Clear safety net
          resolve(tooltip);
        }
      });

      // Start observing the entire document body for child list changes
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      // 3. Trigger the hover events (same sequence as before)
      const rect = triggerBtn.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      const eventTypes = [
        "mouseenter",
        "mouseover",
        "mousemove",
        "pointerenter",
        "pointerover",
      ];
      eventTypes.forEach((type) => {
        const evt = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        });
        triggerBtn.dispatchEvent(evt);
      });
      log(
        `⚡ [TOOLTIP-DYNAMIC] Hover events dispatched. Watching for DOM mutation...`,
      );

      // 4. Safety Net: If tooltip doesn't appear within maxWaitMs, give up
      const timeoutId = setTimeout(() => {
        observer.disconnect();
        logWarn(
          `⚠️ [TOOLTIP-DYNAMIC] Timeout after ${maxWaitMs}ms. Tooltip did not appear.`,
        );
        resolve(null);
      }, maxWaitMs);
    });
  }

  async function getReactionInfo() {
    // Find the main post element
    const mainPost =
      document.querySelector(".js-post:first-of-type") ||
      document.querySelector(".message:first-of-type");
    let hasReaction = false;
    let currentReaction = null;
    let availableReactions = [];
    let requiredReactions = [];
    log(`🔍 [THREAD-ANALYSIS] Main post element found: ${!!mainPost}`);
    if (!mainPost) {
      return {
        hasReaction,
        currentReaction,
        availableReactions,
        requiredReactions,
      };
    }

    // --- Check if user has already reacted ---
    const reactedButton = mainPost.querySelector("a.reaction.has-reaction");
    if (reactedButton) {
      hasReaction = true;
      currentReaction = {
        id: reactedButton.dataset.reactionId,
        title: reactedButton.querySelector("img")?.alt || "Unknown",
      };
      log(
        `✅ [THREAD-ANALYSIS] Existing reaction detected: ID=${currentReaction.id}`,
      );
    }

    // ✅ FIX: Try to find ANY reaction button (reacted or not) to trigger tooltip
    // First try non-reacted buttons, then fall back to reacted button
    let triggerBtn = mainPost.querySelector("a.reaction:not(.has-reaction)");
    if (!triggerBtn && reactedButton) {
      // If user has reacted, use the reacted button to trigger tooltip
      triggerBtn = reactedButton;
      log(`ℹ️ [THREAD-ANALYSIS] Using reacted button to trigger tooltip`);
    }

    // --- Find Tooltip with Dynamic Logic ---
    const reactTooltip = await findReactTooltipDynamic(triggerBtn, 5000);
    if (reactTooltip) {
      const reactionLinks = reactTooltip.querySelectorAll("a.reaction");
      reactionLinks.forEach((link) => {
        const img = link.querySelector("img");
        if (img) {
          availableReactions.push({
            id: link.dataset.reactionId,
            title: img.alt,
            href: link.href,
            element: link,
          });
        }
      });
      log(
        `ℹ️ [THREAD-ANALYSIS] Scraped ${availableReactions.length} reactions from tooltip`,
      );
    } else {
      // ⚠️ FALLBACK: If tooltip fails, try to get data from visible action bar buttons
      logWarn(
        `⚠️ [THREAD-ANALYSIS] Tooltip failed. Falling back to action bar scraping.`,
      );

      // ✅ FIX: Get ALL reaction buttons (both reacted and non-reacted)
      const actionBarBtns = mainPost.querySelectorAll(
        ".actionBar-action--reaction.reaction",
      );
      actionBarBtns.forEach((btn) => {
        const img = btn.querySelector("img");
        if (img) {
          availableReactions.push({
            id: btn.dataset.reactionId,
            title: img.alt,
            // Construct URL manually as fallback
            href:
              btn.href ||
              `${window.location.origin}/posts/${btn.dataset.checkHidePostId}/react?reaction_id=${btn.dataset.reactionId}`,
            element: btn,
          });
        }
      });
      log(
        `ℹ️ [THREAD-ANALYSIS] Fallback scraped ${availableReactions.length} reactions from action bar`,
      );
    }

    // --- Get Hidden Content Requirements ---
    const mainArticle = document.querySelector(".message--article");
    if (mainArticle) {
      const hiddenBlocks = mainArticle.querySelectorAll(
        ".bbCodeBlock--hide.hideBlock--hidden",
      );
      if (hiddenBlocks.length > 0) {
        hiddenBlocks.forEach((block) => {
          const reactions = block.querySelectorAll(
            ".reaction[data-reaction-id]",
          );
          reactions.forEach((reaction) => {
            const id = reaction.dataset.reactionId;
            const title = reaction.querySelector("img")?.alt || "Unknown";
            if (!requiredReactions.some((r) => r.id === id)) {
              const match = availableReactions.find((a) => a.id === id);
              requiredReactions.push({
                id: id,
                title: title,
                href: match ? match.href : "#",
              });
            }
          });
        });
        log(
          `🔒 [THREAD-ANALYSIS] Hidden content requires: [${requiredReactions.map((r) => r.title).join(", ")}]`,
        );
      }
    }

    if (requiredReactions.length === 0 && availableReactions.length > 0) {
      requiredReactions = [...availableReactions];
    }

    log(
      `📊 [THREAD-ANALYSIS] Summary: hasReaction=${hasReaction}, required=${requiredReactions.length}, available=${availableReactions.length}`,
    );
    return {
      hasReaction,
      currentReaction,
      availableReactions,
      requiredReactions,
    };
  }

  function updateBbCodeBlocks(panel, bbCodeBlocks) {
    const container = panel.querySelector(".pto-bbcode-list");
    if (!container) return;

    // ✅ FIX: Re-query specifically for hidden blocks within .message--article
    // This ensures we only show what the analysis found, not every block on the page
    const mainArticle = document.querySelector(".message--article");
    let targetBlocks = [];

    if (mainArticle) {
      // Select only the hidden blocks that are actually requiring a reaction
      targetBlocks = Array.from(
        mainArticle.querySelectorAll(".bbCodeBlock--hide.hideBlock--hidden"),
      );
    }

    if (targetBlocks.length === 0) {
      container.innerHTML =
        '<p style="color:#aaa;font-size:12px;">No hidden BBCode blocks requiring reaction</p>';
      return;
    }

    let html = "";
    targetBlocks.forEach((block, index) => {
      // Get the text content to show a preview
      const content = block.textContent.substring(0, 150);

      // Extract required reactions for this specific block
      const reactions = block.querySelectorAll(".reaction[data-reaction-id]");
      const reqTitles = Array.from(reactions)
        .map((r) => r.querySelector("img")?.alt || "Unknown")
        .join(", ");

      html += `
            <div class="pto-bbcode-item" style="margin-bottom:8px;padding:8px;background:#16213e;border-radius:4px;border-left: 3px solid #e94560;">
                <div style="font-size:11px;color:#e94560;margin-bottom:4px;font-weight:bold;">
                    Hidden Block #${index + 1}
                </div>
                <div style="font-size:10px;color:#ffd700;margin-bottom:4px;">
                    🔒 Requires: ${reqTitles}
                </div>
                <div style="font-size:10px;color:#aaa;word-break:break-word;line-height:1.4;">
                    ${escapeHtml(content)}...
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
  }

  function updateReactionInfo(panel, reactionInfo) {
    const container = panel.querySelector(".pto-reaction-info");
    if (!container) return;

    if (reactionInfo.hasReaction) {
      container.innerHTML = `
        <div style="padding:8px;background:#16213e;border-radius:4px;">
          <div style="font-size:12px;color:#4caf50;">✓ Already reacted with: ${reactionInfo.currentReaction.title}</div>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div style="padding:8px;background:#16213e;border-radius:4px;">
          <div style="font-size:12px;color:#ffa500;">⚠ No reaction yet</div>
          <div style="font-size:10px;color:#aaa;margin-top:4px;">Required: ${reactionInfo.requiredReactions.map((r) => r.title).join(", ")}</div>
        </div>
      `;
    }
  }

  function showReactionButtons(
    panel,
    availableReactions,
    currentReaction = null,
  ) {
    const container = panel.querySelector(".pto-reaction-actions");
    if (!container) return;

    if (availableReactions.length === 0) {
      const message = currentReaction
        ? '<p style="color:#aaa;font-size:12px;">No other reactions available</p>'
        : '<p style="color:#aaa;font-size:12px;">No reactions available</p>';
      container.innerHTML = message;
      return;
    }

    let html =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">';
    availableReactions.forEach((reaction) => {
      html += `
        <button class="pto-reaction-btn" data-reaction-id="${reaction.id}" data-href="${reaction.href}" 
                style="padding:6px 12px;background:#0f3460;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">
          ${reaction.title}
        </button>
      `;
    });
    html += "</div>";
    container.innerHTML = html;

    // Add click handlers
    container.querySelectorAll(".pto-reaction-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const reactionId = btn.dataset.reactionId;
        const href = btn.dataset.href;
        await triggerReaction(href, reactionId);
      });
    });
  }

  async function triggerReaction(href, reactionId) {
    log(`🎯 Triggering reaction: ${reactionId} via ${href}`);
    updateStatus("Triggering reaction...");

    try {
      // Find the actual reaction button in the page and click it
      const reactionButton = document.querySelector(
        `a.reaction[data-reaction-id="${reactionId}"]:not(.has-reaction)`,
      );

      if (reactionButton) {
        reactionButton.click();
        log("✅ Reaction button clicked");
        updateStatus("Reaction triggered! Refreshing...");

        // Wait a bit then refresh to see the result
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      } else {
        // Fallback: try to navigate to the reaction URL
        log("⚠️ Button not found, trying direct navigation");
        window.location.href = href;
      }
    } catch (error) {
      logError("❌ Failed to trigger reaction:", error);
      updateStatus("Failed to trigger reaction");
    }
  }

  // ============================================================
  // STRUCTURED PANEL FUNCTIONS (existing logic)
  // ============================================================
  function updateStructureDisplay() {
    const el = document.querySelector(".pto-structure-name");
    if (el && currentStrategy) {
      el.textContent = currentStrategy.name;
    }
  }

  function countAvailableRows() {
    if (!currentStrategy) {
      currentStrategy = StrategyRegistry.detect();
    }

    const dataListRows = Array.from(DataListStrategy.getRows());
    const dataListAvailable = dataListRows.filter(
      (row) =>
        DataListStrategy.isValidRow(row) &&
        !DataListStrategy.getForumName(row).includes(EXCLUDED_FORUM_TEXT),
    ).length;

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

    const totalAvailable = dataListAvailable + available;
    const totalExcluded = excluded;

    return {
      total: rows.length + dataListRows.length,
      available: totalAvailable,
      excluded: totalExcluded,
      dataListAvailable: dataListAvailable,
      mainStrategyAvailable: available,
    };
  }

  function updateAvailableCount() {
    const countEl = document.querySelector(".pto-available-count");
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
    const logEl = document.querySelector(".pto-debug-log");
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
  // CORE LOGIC (existing)
  // ============================================================
  async function startProcess() {
    currentStrategy = StrategyRegistry.detect();
    updateStructureDisplay();
    hasProcessedDataList = false;

    if (useTargetLimit) {
      const input = document.querySelector(".pto-target-input");
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

    const logEl = document.querySelector(".pto-debug-log");
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

    // First, process data list rows if they exist
    const dataListRows = DataListStrategy.getRows();
    if (dataListRows.length > 0) {
      log(`📋 Processing ${dataListRows.length} data list rows first...`);
      appendDebugLog(`DATALIST | Processing ${dataListRows.length} rows`);
      updateStatus(
        `Processing data list rows... (${openedCount}/${targetCount})`,
      );
      await processDataListRows();
      hasProcessedDataList = true;
    }

    // Then process main strategy rows
    if (isRunning && (!useTargetLimit || openedCount < targetCount)) {
      await processCurrentPage();
    }
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

  async function processDataListRows() {
    if (!isRunning) return;

    const rows = DataListStrategy.getRows();
    log(`📄 Processing data list: ${rows.length} rows found`);
    appendDebugLog(`DATALIST | ${rows.length} rows`);

    for (let i = 0; i < rows.length; i++) {
      if (!isRunning || (useTargetLimit && openedCount >= targetCount)) break;

      const row = rows[i];
      highlightRow(row);

      const forumName = DataListStrategy.getForumName(row);
      if (forumName.includes(EXCLUDED_FORUM_TEXT)) {
        skippedExcluded++;
        log(`🚫 DataList Row ${i}: Excluded forum "${forumName}"`);
        appendDebugLog(`SKIP-DL[${i}] | excluded: ${forumName}`);
        continue;
      }

      const titleLink = DataListStrategy.getTitleLink(row);
      if (!titleLink) {
        logWarn(`⚠️ DataList Row ${i}: No title link found`);
        appendDebugLog(`WARN-DL[${i}] | no title link`);
        continue;
      }

      let href = titleLink.getAttribute("href");
      if (!href) {
        logWarn(`⚠️ DataList Row ${i}: Empty href`);
        appendDebugLog(`WARN-DL[${i}] | empty href`);
        continue;
      }

      if (href.startsWith("/")) {
        href = window.location.origin + href;
      }

      const titleText = titleLink.textContent.substring(0, 35);
      log(`🔗 DataList Row ${i}: Checking "${titleText}..." → ${href}`);
      appendDebugLog(`CHECK-DL[${i}] | ${titleText}`);
      updateStatus(
        `Checking DL ${openedCount + skippedDuplicates + skippedExcluded + 1}: ${titleText}...`,
      );

      const result = await checkAndOpenTab(href);

      if (result.opened) {
        openedCount++;
        log(
          `✅ [OPENED-DL] ${openedCount}/${targetCount}: tabId=${result.tabId}`,
        );
        appendDebugLog(
          `OPEN-DL[${i}] | #${openedCount}/${targetCount} | tab=${result.tabId}`,
        );
        updateStatus(`Opened ${openedCount}/${targetCount}: ${titleText}...`);
      } else if (result.duplicate) {
        skippedDuplicates++;
        log(`⏭️ [DUPE-SKIP-DL] Reason: ${result.reason} | "${titleText}..."`);
        appendDebugLog(`DUPE-DL[${i}] | ${result.reason} | ${titleText}`);
        updateStatus(`⏭️ Dupe (${result.reason}): ${titleText}...`);
      } else {
        logError(`❌ [ERROR-DL] ${result.error}`);
        appendDebugLog(`ERR-DL[${i}] | ${result.error}`);
        updateStatus(`❌ Error: ${result.error || "Unknown"}`);
      }

      await sleep(DELAY_BETWEEN_TABS_MS);
    }

    log(`✅ Data list processing complete. Opened: ${openedCount}`);
    appendDebugLog(`DATALIST | Complete | opened=${openedCount}`);
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
        log(`✅ [OPENED] ${openedCount}/${targetCount}: tabId=${result.tabId}`);
        appendDebugLog(
          `OPEN[${i}] | #${openedCount}/${targetCount} | tab=${result.tabId}`,
        );
        updateStatus(`Opened ${openedCount}/${targetCount}: ${titleText}...`);
      } else if (result.duplicate) {
        skippedDuplicates++;
        log(`⏭️ [DUPE-SKIP] Reason: ${result.reason} | "${titleText}..."`);
        appendDebugLog(`DUPE[${i}] | ${result.reason} | ${titleText}`);
        updateStatus(`⏭️ Dupe (${result.reason}): ${titleText}...`);
      } else {
        logError(`❌ [ERROR] ${result.error}`);
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
    // Try to find the status element within the pto-panel specifically
    const panel = document.getElementById("pto-panel");
    if (panel) {
      const el = panel.querySelector(".pto-status");
      if (el) {
        el.textContent = msg;
        // Optional: Change color based on status
        if (msg.includes("Error")) {
          el.style.color = "#ff4d4d";
        } else if (msg.includes("Ready")) {
          el.style.color = "#4caf50"; // Green for ready
        } else {
          el.style.color = "#aaa"; // Default gray
        }
      }
    }
  }

  function toggleButtons(running) {
    const startBtn = document.querySelector(".pto-start-btn");
    const stopBtn = document.querySelector(".pto-stop-btn");

    if (startBtn) startBtn.style.display = running ? "none" : "inline-block";
    if (stopBtn) stopBtn.style.display = running ? "inline-block" : "none";
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Initialize
  createPanel();
})();
