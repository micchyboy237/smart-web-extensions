// background.js
const LOG_PREFIX = "[VidMon-BG]";
const DEBUG = true;

function log(...args) {
  if (DEBUG) console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  if (DEBUG) console.warn(LOG_PREFIX, ...args);
}

function error(...args) {
  console.error(LOG_PREFIX, ...args);
}

let activeDownloads = {};
let activeFetches = {};

log("🚀 Service worker starting...");

// --- Toolbar Click Handler ---
chrome.action.onClicked.addListener((tab) => {
  log(`🖱️ [ACTION] Icon clicked on tab: ${tab.id}`);
  log(`   → Tab URL: ${tab.url}`);
  log(`   → Tab status: ${tab.status}`);

  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" }, (response) => {
    if (chrome.runtime.lastError) {
      warn(
        `❌ [ACTION] Failed to send message to tab ${tab.id}:`,
        chrome.runtime.lastError.message,
      );
      warn(
        `   → This is normal if content script hasn't loaded yet or panel already exists`,
      );
    } else {
      log(`✅ [ACTION] Message sent successfully to tab ${tab.id}`);
      log(`   → Response:`, response);
    }
  });
});

// --- Message Router ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log(`📨 [MSG] Received message:`);
  log(`   → Type: ${message.type}`);
  log(`   → From: ${sender.tab ? `Tab ${sender.tab.id}` : "Background"}`);
  log(`   → Sender URL: ${sender.url || "N/A"}`);
  log(`   → Full message:`, JSON.stringify(message, null, 2));

  switch (message.type) {
    case "VIDEO_PROGRESS":
      log(`📊 [PROGRESS] Updating download progress`);
      log(`   → Video ID: ${message.data.id?.substring(0, 8)}...`);
      log(`   → Progress: ${message.data.percent}%`);
      log(
        `   → Buffered: ${message.data.bufferedSeconds}s / ${message.data.duration}s`,
      );

      activeDownloads[message.data.id] = message.data;
      log(
        `   → Active downloads count: ${Object.keys(activeDownloads).length}`,
      );

      chrome.runtime
        .sendMessage({ type: "UPDATE_DOWNLOADS", data: activeDownloads })
        .catch((err) => {
          warn(`⚠️ [PROGRESS] Failed to broadcast update:`, err.message);
        });
      break;

    case "FETCH_STARTED":
      log(`🔄 [FETCH] Fetch started`);
      log(`   → Fetch ID: ${message.data.fetchId?.substring(0, 8)}...`);
      log(`   → URL: ${message.data.url?.substring(0, 100)}...`);

      activeFetches[message.data.fetchId] = message.data;
      log(`   → Active fetches count: ${Object.keys(activeFetches).length}`);

      chrome.runtime
        .sendMessage({ type: "UPDATE_FETCHES", data: activeFetches })
        .catch((err) => {
          warn(`⚠️ [FETCH] Failed to broadcast update:`, err.message);
        });
      break;

    case "FETCH_COMPLETED":
      log(`✅ [FETCH] Fetch completed`);
      log(`   → Fetch ID: ${message.data.fetchId?.substring(0, 8)}...`);

      delete activeFetches[message.data.fetchId];
      log(
        `   → Remaining active fetches: ${Object.keys(activeFetches).length}`,
      );

      chrome.runtime
        .sendMessage({ type: "UPDATE_FETCHES", data: activeFetches })
        .catch((err) => {
          warn(`⚠️ [FETCH] Failed to broadcast update:`, err.message);
        });
      break;

    case "FETCH_CANCELLED":
      log(`🚫 [FETCH] Fetch cancelled`);
      log(`   → Fetch ID: ${message.data.fetchId?.substring(0, 8)}...`);

      delete activeFetches[message.data.fetchId];
      log(
        `   → Remaining active fetches: ${Object.keys(activeFetches).length}`,
      );

      chrome.runtime
        .sendMessage({ type: "UPDATE_FETCHES", data: activeFetches })
        .catch((err) => {
          warn(`⚠️ [FETCH] Failed to broadcast update:`, err.message);
        });
      break;

    case "GET_STATE":
      log(`📋 [STATE] State requested`);
      log(`   → Downloads: ${Object.keys(activeDownloads).length}`);
      log(`   → Fetches: ${Object.keys(activeFetches).length}`);

      const stateResponse = {
        downloads: activeDownloads,
        fetches: activeFetches,
      };
      log(`   → Sending state response`);
      sendResponse(stateResponse);
      break;

    case "GET_CACHE_INFO":
      log(`💾 [CACHE] Cache info requested`);
      getCacheInfo()
        .then((info) => {
          log(`   → Cache info:`, info);
          sendResponse(info);
        })
        .catch((err) => {
          error(`❌ [CACHE] Failed to get cache info:`, err);
          sendResponse({ error: err.message });
        });
      return true; // Keep channel open for async

    case "CLEAR_CACHE":
      log(`🗑️ [CACHE] Clear cache requested`);
      clearAllCaches()
        .then((result) => {
          log(`   → Clear result:`, result);
          sendResponse(result);
        })
        .catch((err) => {
          error(`❌ [CACHE] Failed to clear cache:`, err);
          sendResponse({ success: false, error: err.message });
        });
      return true; // Keep channel open for async

    case "ENFORCE_CACHE_LIMIT":
      log(`⚖️ [CACHE] Enforce cache limit requested`);
      enforceCacheLimit()
        .then((result) => {
          log(`   → Enforce result:`, result);
          sendResponse(result);
        })
        .catch((err) => {
          error(`❌ [CACHE] Failed to enforce limit:`, err);
          sendResponse({ withinLimit: false, error: err.message });
        });
      return true; // Keep channel open for async

    case "SAVE_VIDEO_OFFLINE":
      log(`💾 [SAVE] Save video requested`);
      log(`   → URL: ${message.data.url?.substring(0, 100)}...`);
      saveVideoToCache(message.data.url)
        .then((result) => {
          log(`   → Save result:`, result);
          sendResponse(result);
        })
        .catch((err) => {
          error(`❌ [SAVE] Failed to save video:`, err);
          sendResponse({ success: false, error: err.message });
        });
      return true; // Keep channel open for async

    default:
      warn(`⚠️ [MSG] Unknown message type: ${message.type}`);
      break;
  }
});

async function saveVideoToCache(url) {
  const cacheName = "offline-videos";
  log(`💾 [SAVE] Starting save for: ${url?.substring(0, 100)}...`);

  try {
    const cache = await caches.open(cacheName);
    log(`   → Cache opened: ${cacheName}`);

    const existing = await cache.match(url);
    if (existing) {
      log(`   → ✅ Already cached, skipping`);
      return { success: true, message: "Already saved" };
    }

    log(`   → 🔄 Fetching with no-cors mode...`);
    const response = await fetch(url, { mode: "no-cors" });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    log(`   → 💾 Storing in cache...`);
    await cache.put(url, response);
    log(`   → ✅ Successfully cached`);

    return { success: true };
  } catch (err) {
    warn(`❌ [SAVE] Failed:`, err.message);
    return { success: false, error: err.message };
  }
}

async function getCacheInfo() {
  log(`💾 [CACHE] Getting cache info...`);
  try {
    const estimate = await navigator.storage.estimate();
    const cacheUsage = estimate.usageDetails?.caches || 0;

    const info = {
      quota: estimate.quota,
      usage: estimate.usage,
      cacheUsage,
      formattedCache: formatBytes(cacheUsage),
      formattedQuota: formatBytes(estimate.quota),
    };

    log(`   → Quota: ${info.formattedQuota}`);
    log(`   → Usage: ${formatBytes(estimate.usage)}`);
    log(`   → Cache: ${info.formattedCache}`);

    return info;
  } catch (err) {
    error(`❌ [CACHE] Failed to get info:`, err);
    return { error: err.message };
  }
}

async function clearAllCaches() {
  log(`🗑️ [CACHE] Clearing all caches...`);
  const names = await caches.keys();
  log(`   → Found ${names.length} caches:`, names);

  await Promise.all(
    names.map((n) => {
      log(`   → Deleting cache: ${n}`);
      return caches.delete(n);
    }),
  );

  log(`   → ✅ Cleared ${names.length} caches`);
  return { success: true, clearedCount: names.length };
}

async function enforceCacheLimit() {
  log(`⚖️ [CACHE] Enforcing cache limit...`);
  const estimate = await navigator.storage.estimate();
  const cacheUsage = estimate.usageDetails?.caches || 0;
  const MAX = 100 * 1024 * 1024; // 100MB

  log(`   → Current cache usage: ${formatBytes(cacheUsage)}`);
  log(`   → Limit: ${formatBytes(MAX)}`);

  if (cacheUsage <= MAX) {
    log(`   → ✅ Within limit, no action needed`);
    return { withinLimit: true };
  }

  log(`   → ⚠️ Over limit, cleaning up...`);
  const names = await caches.keys();
  log(`   → Found ${names.length} caches to potentially delete`);

  for (const name of names) {
    log(`   → Deleting cache: ${name}`);
    await caches.delete(name);

    const newEst = await navigator.storage.estimate();
    const newUsage = newEst.usageDetails?.caches || 0;
    log(`   → New usage: ${formatBytes(newUsage)}`);

    if (newUsage <= MAX) {
      log(`   → ✅ Now within limit`);
      break;
    }
  }

  return { withinLimit: false, cleaned: true };
}

function formatBytes(bytes, decimals = 2) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (
    parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i]
  );
}

log("✅ Service worker started successfully");
