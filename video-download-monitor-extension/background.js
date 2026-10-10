// background.js

// Store active video downloads and fetch requests
let activeDownloads = {};
let activeFetches = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VIDEO_PROGRESS") {
    activeDownloads[message.data.id] = message.data;
    // Notify popup if open
    chrome.runtime
      .sendMessage({ type: "UPDATE_DOWNLOADS", data: activeDownloads })
      .catch(() => {});
  }

  if (message.type === "FETCH_STARTED") {
    activeFetches[message.data.url] = true;
    chrome.runtime
      .sendMessage({ type: "UPDATE_FETCHES", data: activeFetches })
      .catch(() => {});
  }

  if (message.type === "GET_CACHE_INFO") {
    getCacheInfo().then((info) => {
      sendResponse(info);
    });
    return true; // Keep channel open for async response
  }

  if (message.type === "CLEAR_CACHE") {
    clearCache().then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// Feature 3: See how much data is stored in cache
async function getCacheInfo() {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    const cacheUsage = estimate.usageDetails?.caches || 0;
    return {
      quota: estimate.quota,
      usage: estimate.usage,
      cacheUsage: cacheUsage,
      formattedCache: formatBytes(cacheUsage),
    };
  }
  return { error: "Storage API not available" };
}

// Feature 4 (Partial): Auto-cleanup logic (Manual trigger via popup)
async function clearCache() {
  const cacheNames = await caches.keys();
  for (const name of cacheNames) {
    await caches.delete(name);
  }
  return true;
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}
