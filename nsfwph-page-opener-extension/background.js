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
      if (!tab.url) {
        log("  ⚠️ Tab", tab.id, "has no URL (loading/restricted)");
        return false;
      }
      const tabNormalized = normalizeUrl(tab.url);
      const match = tabNormalized === normalized;
      if (match) {
        matchedTabId = tab.id;
        log("  ✅ MATCH found:", {
          tabId: tab.id,
          tabUrl: tab.url,
          normalized: tabNormalized,
        });
      } else if (DEBUG && tabNormalized.includes(normalized.split("/").pop())) {
        // Log near-matches for debugging
        log("  🔶 Near-match:", {
          tabId: tab.id,
          tabUrl: tab.url,
          normalized: tabNormalized,
        });
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
    log("📌 Added to pendingOpens. Size:", pendingOpens.size);

    const newTab = await chrome.tabs.create({ url, active: false });
    openedCount++;
    log("✅ Tab created:", { tabId: newTab.id, openedCount });

    // Clean up pending when tab finishes loading
    const cleanupListener = (tabId, changeInfo) => {
      if (changeInfo.status === "complete") {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) {
            logWarn(
              "⚠️ Could not get tab for cleanup:",
              chrome.runtime.lastError.message,
            );
            return;
          }
          if (tab && normalizeUrl(tab.url || "") === normalized) {
            pendingOpens.delete(normalized);
            log(
              "🧹 Removed from pendingOpens after load:",
              normalized,
              "| Remaining:",
              pendingOpens.size,
            );
            chrome.tabs.onUpdated.removeListener(cleanupListener);
          }
        });
      }
    };
    chrome.tabs.onUpdated.addListener(cleanupListener);

    // Safety net: remove from pending after 15s regardless
    setTimeout(() => {
      if (pendingOpens.has(normalized)) {
        pendingOpens.delete(normalized);
        logWarn(
          "⏰ Safety timeout: removed from pendingOpens:",
          normalized,
          "| Remaining:",
          pendingOpens.size,
        );
      }
    }, 15000);

    return { opened: true, duplicate: false, tabId: newTab.id };
  } catch (err) {
    pendingOpens.delete(normalized);
    logError("💥 Failed to open tab:", { url: normalized, error: err.message });
    throw new Error(`Failed to open tab: ${err.message}`);
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
