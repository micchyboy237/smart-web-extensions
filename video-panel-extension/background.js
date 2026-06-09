// background.js - Service Worker for HLS/DASH manifest detection
// Uses chrome.webRequest to intercept .m3u8 and .mpd requests
// before they reach the page, solving the timing problem.

console.log("[Background] Service Worker starting...");

// ═══════════════════════════════════════════════════════════
// STORAGE FOR CAPTURED MANIFEST URLS
// ═══════════════════════════════════════════════════════════
// Map: tabId → { manifests: Set<string>, timestamp: number }
const tabManifests = new Map();

const MAX_AGE_MS = 5 * 60 * 1000; // Keep manifests for 5 minutes per tab

/**
 * Clean up old manifest data for closed tabs or expired entries.
 */
function cleanupStaleData() {
  const now = Date.now();
  for (const [tabId, data] of tabManifests.entries()) {
    if (now - data.timestamp > MAX_AGE_MS) {
      tabManifests.delete(tabId);
      console.log(`[Background] 🧹 Cleaned up stale data for tab ${tabId}`);
    }
  }
}

// Run cleanup every 2 minutes
setInterval(cleanupStaleData, 2 * 60 * 1000);

/**
 * Check if a URL is an HLS manifest (.m3u8) or DASH manifest (.mpd).
 */
function isStreamingManifest(url) {
  const lower = url.toLowerCase();
  return (
    lower.includes(".m3u8") ||
    lower.includes("m3u8") ||
    lower.includes(".mpd") ||
    lower.includes("mpd")
  );
}

/**
 * Determine if this is a "master" playlist (points to variants) vs "media" playlist (contains segments).
 * We prefer the media playlist for preview because it has a simpler structure.
 * But we capture both and let the content script decide.
 */
function classifyManifest(url) {
  const lower = url.toLowerCase();
  // Master playlists often have "master", "playlist", "index" in the URL
  if (
    lower.includes("master") ||
    lower.includes("playlist") ||
    lower.includes("index")
  ) {
    return "master";
  }
  // Media/variant playlists often have resolution markers like "720p", "1080p"
  if (
    /\d+p/.test(lower) ||
    lower.includes("video") ||
    lower.includes("stream")
  ) {
    return "media";
  }
  return "unknown";
}

/**
 * Store a captured manifest URL for a specific tab.
 */
function storeManifest(tabId, url) {
  if (tabId < 0) return; // Skip non-tab requests (e.g., extension background)

  if (!tabManifests.has(tabId)) {
    tabManifests.set(tabId, {
      manifests: new Set(),
      timestamp: Date.now(),
      urlsByType: { master: [], media: [], unknown: [] },
    });
  }

  const data = tabManifests.get(tabId);
  data.manifests.add(url);
  data.timestamp = Date.now();

  const type = classifyManifest(url);
  if (!data.urlsByType[type].includes(url)) {
    data.urlsByType[type].push(url);
  }

  console.log(
    `[Background] 📡 Captured ${type} manifest for tab ${tabId}: ${url.substring(0, 100)}...`,
  );
}

/**
 * Get all captured manifest URLs for a tab.
 * Returns them sorted: media playlists first (better for preview), then master.
 */
function getManifestsForTab(tabId) {
  const data = tabManifests.get(tabId);
  if (!data) return [];

  // Prefer media playlists for preview (they're simpler and contain segment info)
  const allUrls = [
    ...data.urlsByType.media,
    ...data.urlsByType.master,
    ...data.urlsByType.unknown,
  ];

  return [...new Set(allUrls)]; // Deduplicate
}

// ═══════════════════════════════════════════════════════════
// MESSAGE HANDLERS (Communication with content scripts)
// ═══════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script requesting manifests for its tab
  if (message.action === "getManifests") {
    const tabId = message.tabId || (sender.tab ? sender.tab.id : -1);
    const manifests = getManifestsForTab(tabId);
    console.log(
      `[Background] 📤 Sending ${manifests.length} manifests to tab ${tabId}`,
    );
    sendResponse({ manifests, success: true });
    return true; // Keep channel open for async response
  }

  // Content script requesting latest manifest for a specific pattern
  if (message.action === "getLatestManifest") {
    const tabId = message.tabId || (sender.tab ? sender.tab.id : -1);
    const manifests = getManifestsForTab(tabId);

    // If a pattern is provided, filter by it
    let filtered = manifests;
    if (message.pattern) {
      filtered = manifests.filter((url) => url.includes(message.pattern));
    }

    const latest = filtered.length > 0 ? filtered[0] : null;
    sendResponse({ manifest: latest, allManifests: manifests, success: true });
    return true;
  }

  return false;
});

// ═══════════════════════════════════════════════════════════
// WEB REQUEST LISTENERS
// ═══════════════════════════════════════════════════════════
// Listen for XMLHttpRequest and fetch calls to .m3u8/.mpd URLs
// Using onBeforeRequest to catch requests before they're sent
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;

    if (isStreamingManifest(url)) {
      console.log(`[Background] 🎬 Intercepted streaming manifest request:`);
      console.log(`[Background]    URL: ${url.substring(0, 100)}...`);
      console.log(`[Background]    Tab: ${details.tabId}`);
      console.log(`[Background]    Type: ${details.type}`);
      console.log(
        `[Background]    Initiator: ${details.initiator || "unknown"}`,
      );

      storeManifest(details.tabId, url);
    }

    // Don't block - just observe
    return {};
  },
  {
    urls: ["*://*/*.m3u8*", "*://*/*.mpd*", "*://*/*m3u8*", "*://*/*mpd*"],
    types: ["xmlhttprequest"], // HLS.js and DASH.js use XHR
  },
  [], // No blocking - observation only
);

// Also listen for fetch requests (some players use fetch instead of XHR)
// Note: In MV3, webRequest handles both XHR and fetch under "xmlhttprequest" type,
// but we add an additional broad listener as a fallback
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;

    if (isStreamingManifest(url) && !tabManifests.has(details.tabId)) {
      console.log(
        `[Background] 🎬 Fallback: Intercepted ${details.type} manifest request:`,
      );
      console.log(`[Background]    URL: ${url.substring(0, 100)}...`);
      console.log(`[Background]    Tab: ${details.tabId}`);

      storeManifest(details.tabId, url);
    }

    return {};
  },
  {
    urls: ["*://*/*.m3u8*", "*://*/*.mpd*", "*://*/*m3u8*", "*://*/*mpd*"],
    types: ["script", "other"], // Some sites load manifests via script or other means
  },
  [],
);

// Listen for completed requests to catch any redirects
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;

    if (isStreamingManifest(url)) {
      console.log(`[Background] ✅ Manifest request completed:`);
      console.log(`[Background]    URL: ${url.substring(0, 100)}...`);
      console.log(`[Background]    Status: ${details.statusCode}`);
      console.log(`[Background]    Tab: ${details.tabId}`);

      // Store if not already captured
      storeManifest(details.tabId, url);
    }
  },
  {
    urls: ["*://*/*.m3u8*", "*://*/*.mpd*", "*://*/*m3u8*", "*://*/*mpd*"],
    types: ["xmlhttprequest", "script", "other"],
  },
  ["responseHeaders"],
);

// Listen for redirects to catch when a manifest URL is redirected
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (isStreamingManifest(details.redirectUrl)) {
      console.log(`[Background] 🔄 Manifest redirect detected:`);
      console.log(`[Background]    From: ${details.url.substring(0, 80)}...`);
      console.log(
        `[Background]    To: ${details.redirectUrl.substring(0, 80)}...`,
      );

      storeManifest(details.tabId, details.redirectUrl);
    }
  },
  {
    urls: ["*://*/*.m3u8*", "*://*/*.mpd*", "*://*/*m3u8*", "*://*/*mpd*"],
    types: ["xmlhttprequest", "script", "other"],
  },
);

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabManifests.has(tabId)) {
    const count = tabManifests.get(tabId).manifests.size;
    tabManifests.delete(tabId);
    console.log(
      `[Background] 🗑️ Cleaned up ${count} manifests for closed tab ${tabId}`,
    );
  }
});

console.log("[Background] ✅ Service Worker ready");
console.log(
  "[Background] Monitoring for HLS (.m3u8) and DASH (.mpd) manifest requests",
);
