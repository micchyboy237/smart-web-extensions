// ============================================================
// DEBUG CONFIGURATION
// ============================================================
const DEBUG = true;
function log(...args) {
  if (DEBUG) console.log("[PTO-BG]", ...args);
}
function logWarn(...args) {
  if (DEBUG) console.warn("[PTO-BG]", ...args);
}
function logError(...args) {
  console.error("[PTO-BG]", ...args);
}
// ============================================================
// STATE
// ============================================================
let openedCount = 0;
const pendingOpens = new Set();
// ============================================================
// MESSAGE HANDLER
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_AND_OPEN") {
    log("📨 Received CHECK_AND_OPEN:", message.url);
    handleCheckAndOpen(message.url)
      .then((result) => {
        log("📤 Sending response:", result);
        sendResponse(result);
      })
      .catch((err) => {
        logError("❌ Error in CHECK_AND_OPEN:", err.message);
        sendResponse({ opened: false, error: err.message });
      });
    return true; // Keep channel open for async response
  }
  if (message.type === "GET_STATS") {
    const stats = {
      openedCount,
      pendingCount: pendingOpens.size,
      pendingUrls: [...pendingOpens],
    };
    log("📊 Stats requested:", stats);
    sendResponse(stats);
    return false;
  }
  return false;
});
// ============================================================
// CORE LOGIC
// ============================================================
async function handleCheckAndOpen(url) {
  const normalized = normalizeUrl(url);
  log("🔍 Checking URL:", { original: url, normalized });

  // --- Check 1: Pending opens (race condition guard) ---
  if (pendingOpens.has(normalized)) {
    log("⏳ DUPLICATE (pending):", normalized);
    return { opened: false, duplicate: true, reason: "pending" };
  }

  try {
    // --- Check 2: Already open in any tab ---
    const tabs = await chrome.tabs.query({});
    log(`📋 Queried ${tabs.length} open tabs`);

    let matchedTabId = null;
    const isDuplicate = tabs.some((tab) => {
      if (!tab.url) return false;
      const tabNormalized = normalizeUrl(tab.url);
      const match = tabNormalized === normalized;
      if (match) {
        matchedTabId = tab.id;
        log("  ✅ MATCH found:", { tabId: tab.id, tabUrl: tab.url });
      }
      return match;
    });

    if (isDuplicate) {
      log("🚫 DUPLICATE (open tab):", { normalized, matchedTabId });
      return {
        opened: false,
        duplicate: true,
        reason: "open_tab",
        matchedTabId,
      };
    }

    // --- Open new tab ---
    log("🆕 Opening new tab:", normalized);
    pendingOpens.add(normalized);

    // Open in background (active: false)
    const newTab = await chrome.tabs.create({ url, active: false });
    openedCount++;
    log("✅ Tab created:", { tabId: newTab.id, openedCount });

    // --- Setup Auto-Close Listener ---
    const onUpdatedListener = async (tabId, changeInfo, tab) => {
      if (tabId === newTab.id && changeInfo.status === "complete") {
        // Remove listener once handled
        chrome.tabs.onUpdated.removeListener(onUpdatedListener);
        pendingOpens.delete(normalized);

        log(`🔄 Tab ${tabId} loaded. Checking auto-close settings...`);

        // Check if auto-close is enabled in storage
        const settings = await chrome.storage.local.get(
          "pto_autoCloseIfReacted",
        );
        if (settings.pto_autoCloseIfReacted) {
          await checkAndCloseIfReacted(newTab.id, normalized);
        } else {
          log("ℹ️ Auto-close disabled. Keeping tab open.");
        }
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdatedListener);

    // Safety net: remove from pending after 15s regardless
    setTimeout(() => {
      if (pendingOpens.has(normalized)) {
        pendingOpens.delete(normalized);
        chrome.tabs.onUpdated.removeListener(onUpdatedListener);
        logWarn("⏰ Safety timeout: removed from pendingOpens:", normalized);
      }
    }, 15000);

    return { opened: true, duplicate: false, tabId: newTab.id };
  } catch (err) {
    pendingOpens.delete(normalized);
    logError("💥 Failed to open tab:", { url: normalized, error: err.message });
    throw new Error(`Failed to open tab: ${err.message}`);
  }
}

/**
 * Injects a lightweight script to check for reactions and closes the tab if found.
 */
async function checkAndCloseIfReacted(tabId, url) {
  try {
    // We only want to check thread/post pages, not forum lists
    if (!/\/threads\/\d+/.test(url) && !/\/posts\/\d+/.test(url)) {
      log("ℹ️ Skipping reaction check: Not a thread/post URL");
      return;
    }

    log(`🔍 Injecting reaction check into tab ${tabId}...`);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        // This code runs inside the page context
        // Scope to main post to avoid sidebar widgets
        const mainPost =
          document.querySelector(".js-post:first-of-type") ||
          document.querySelector(".message:first-of-type");

        if (mainPost) {
          // Method 1: has-reaction class
          if (mainPost.querySelector("a.reaction.has-reaction")) {
            return true;
          }

          // Method 2: Missing imageHidden class
          const btn = mainPost.querySelector(
            'a.reaction[data-xf-init="reaction"]',
          );
          if (btn && !btn.classList.contains("reaction--imageHidden")) {
            return true;
          }
        }
        return false;
      },
    });

    if (results && results[0] && results[0].result === true) {
      log(`🚫 Reaction detected in tab ${tabId}. Closing tab.`);
      chrome.tabs.remove(tabId);
    } else {
      log(`✅ No reaction detected in tab ${tabId}. Keeping open.`);
    }
  } catch (e) {
    logWarn("Failed to check reaction in background:", e);
  }
}

// ============================================================
// URL NORMALIZATION
// ============================================================
function normalizeUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.origin + parsed.pathname + parsed.hash;
  } catch {
    logWarn("⚠️ Could not parse URL, returning raw:", u);
    return u;
  }
}
