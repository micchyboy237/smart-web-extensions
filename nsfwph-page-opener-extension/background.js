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
  log("🔍 [DUPE-CHECK] Normalizing URL:", { original: url, normalized });

  // --- Check 1: Pending opens (race condition guard) ---
  if (pendingOpens.has(normalized)) {
    log(
      "🚫 [DUPE-DETECTED] Reason: PENDING (Already being opened by another process)",
    );
    log("   -> URL:", normalized);
    return { opened: false, duplicate: true, reason: "pending" };
  }

  try {
    // --- Check 2: Already open in any tab ---
    log("🔎 [DUPE-CHECK] Querying all open tabs...");
    const tabs = await chrome.tabs.query({});
    log(`   -> Found ${tabs.length} total tabs.`);

    let matchedTabId = null;
    let matchReason = "";

    const isDuplicate = tabs.some((tab) => {
      if (!tab.url) {
        // log("   -> Skipping tab", tab.id, "(no URL yet)");
        return false;
      }

      const tabNormalized = normalizeUrl(tab.url);

      // Exact Match
      if (tabNormalized === normalized) {
        matchedTabId = tab.id;
        matchReason = "EXACT_MATCH";
        log("   -> ✅ MATCH FOUND! Tab ID:", tab.id, "| URL:", tab.url);
        return true;
      }

      // Partial/Hash Match (for debugging near-misses)
      if (DEBUG && tabNormalized.includes(normalized.split("/").pop())) {
        log(
          "   -> ⚠️ Near-match detected (ignoring): Tab",
          tab.id,
          tabNormalized,
        );
      }

      return false;
    });

    if (isDuplicate) {
      log("🚫 [DUPE-DETECTED] Reason: OPEN_TAB (" + matchReason + ")");
      log("   -> Conflicting Tab ID:", matchedTabId);
      return {
        opened: false,
        duplicate: true,
        reason: "open_tab",
        matchedTabId,
      };
    } else {
      log("✅ [DUPE-CHECK] No duplicates found. Proceeding to open.");
    }

    // --- Open new tab ---
    log("🆕 [ACTION] Opening new tab:", normalized);
    pendingOpens.add(normalized);
    log("   -> Added to pendingOpens. Current size:", pendingOpens.size);

    // Open in background (active: false)
    const newTab = await chrome.tabs.create({ url, active: false });
    openedCount++;
    log(
      "✅ [SUCCESS] Tab created. ID:",
      newTab.id,
      "| Total Opened:",
      openedCount,
    );

    // --- Setup Auto-Close Listener ---
    const onUpdatedListener = async (tabId, changeInfo, tab) => {
      if (tabId === newTab.id && changeInfo.status === "complete") {
        log("🔄 [LOAD] Tab", tabId, "finished loading. Checking auto-close...");

        // Remove listener once handled
        chrome.tabs.onUpdated.removeListener(onUpdatedListener);
        pendingOpens.delete(normalized);
        log("   -> Removed from pendingOpens. Remaining:", pendingOpens.size);

        // Check if auto-close is enabled in storage
        const settings = await chrome.storage.local.get(
          "pto_autoCloseIfReacted",
        );
        if (settings.pto_autoCloseIfReacted) {
          log("   -> Auto-Close is ENABLED. Injecting check script...");
          await checkAndCloseIfReacted(newTab.id, normalized);
        } else {
          log("   -> Auto-Close is DISABLED. Keeping tab open.");
        }
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdatedListener);

    // Safety net: remove from pending after 15s regardless
    setTimeout(() => {
      if (pendingOpens.has(normalized)) {
        pendingOpens.delete(normalized);
        chrome.tabs.onUpdated.removeListener(onUpdatedListener);
        logWarn(
          "⏰ [TIMEOUT] Safety timeout: removed from pendingOpens:",
          normalized,
        );
      }
    }, 15000);

    return { opened: true, duplicate: false, tabId: newTab.id };
  } catch (err) {
    pendingOpens.delete(normalized);
    logError("💥 [ERROR] Failed to open tab:", {
      url: normalized,
      error: err.message,
    });
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
      log("ℹ️ [AUTO-CLOSE] Skipping reaction check: Not a thread/post URL");
      return;
    }

    log(`🔍 [AUTO-CLOSE] Injecting reaction check into tab ${tabId}...`);

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
      log(`🚫 [AUTO-CLOSE] Reaction detected in tab ${tabId}. Closing tab.`);
      chrome.tabs.remove(tabId);
    } else {
      log(
        `✅ [AUTO-CLOSE] No reaction detected in tab ${tabId}. Keeping open.`,
      );
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
    // Include hash fragment — XF uses #profile-post-XXXXX to identify specific posts
    return parsed.origin + parsed.pathname + parsed.hash;
  } catch {
    logWarn("⚠️ Could not parse URL, returning raw:", u);
    return u;
  }
}
