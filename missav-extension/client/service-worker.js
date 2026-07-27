// Jet_Apps/web-extensions/smart-web-extensions/missav-extension/service-worker.js
//
// All calls to the local Python server live here, in the extension's own
// privileged context (chrome-extension://<id>). Chrome's Local Network
// Access (LNA) permission is granted per-origin: running fetches from
// content.js meant the permission was tied to whatever site injected it
// (https://missav.ws) — a permission you don't control. Running them here
// ties the permission to your own extension instead, which you CAN grant
// via chrome://settings/content/siteDetails?site=chrome-extension://<id>.
//
// importScripts works because the manifest does NOT set "type": "module"
// on the background entry — this is a classic (non-module) service worker.
importScripts("server-client.js");

// ====================== VIEWER WINDOW MANAGEMENT ======================
let viewerWindowId = null;
let viewerSourceTabId = null;

chrome.action.onClicked.addListener(async (tab) => {
  console.log("[SW] 🖱️ Action clicked, source tab:", tab.id);
  // Reuse an already-open viewer window instead of stacking new ones
  if (viewerWindowId !== null) {
    try {
      await chrome.windows.update(viewerWindowId, { focused: true });
      console.log("[SW] 🔎 Focused existing viewer window:", viewerWindowId);
      return;
    } catch (err) {
      console.log(
        "[SW] ⚠️ Stale viewer window ref, opening fresh:",
        err.message,
      );
      viewerWindowId = null;
    }
  }
  viewerSourceTabId = tab.id;
  const url = chrome.runtime.getURL(`popup.html?tabId=${tab.id}`);
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 1200,
    height: 800,
    focused: true,
  });
  viewerWindowId = win.id;
  console.log(
    "[SW] 🪟 Opened viewer window",
    viewerWindowId,
    "for tab",
    tab.id,
  );
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === viewerWindowId) {
    console.log("[SW] 🪟 Viewer window closed, clearing refs");
    viewerWindowId = null;
    viewerSourceTabId = null;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[SW] ✅ Service worker installed, server-client.js loaded");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // ====================== VIDEO SYNC ======================
  if (request.action === "syncVideos") {
    console.log(
      `[SW] 📤 Relaying ${request.videos?.length || 0} videos to server`,
    );
    serverClient
      .ingestVideos(request.videos || [])
      .then((result) => {
        console.log("[SW] ✅ Sync complete:", {
          ingested: result.ingested,
          total: result.total,
          time_ms: result.time_ms,
        });
        sendResponse({ success: true, ...result });
      })
      .catch((err) => {
        console.error("[SW] ❌ Sync failed:", err.message);
        const syncState = serverClient.getSyncState();
        console.log(
          "[SW] 📦 Pending videos for retry:",
          syncState.pendingCount,
        );
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // ====================== SMART SEARCH ======================
  if (request.action === "smartSearch") {
    console.log("[SW] 🔍 Smart search:", request.params);
    serverClient
      .search(request.params || {})
      .then((results) => {
        console.log(
          "[SW] ✅ Smart search complete:",
          results.results?.length,
          "results",
        );
        sendResponse({ success: true, ...results });
      })
      .catch((err) => {
        console.error("[SW] ❌ Smart search failed:", err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // ====================== FIND SIMILAR ======================
  if (request.action === "findSimilar") {
    console.log("[SW] 🔍 Find similar:", {
      videoId: request.params?.videoId,
      options: request.params?.options,
    });
    serverClient
      .findSimilar(request.params.videoId, request.params.options || {})
      .then((results) => sendResponse({ success: true, ...results }))
      .catch((err) => {
        console.error("[SW] ❌ Find similar failed:", err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // ====================== FORCE SYNC ======================
  if (request.action === "forceSync") {
    console.log("[SW] 🔄 Force sync requested");
    serverClient
      .syncNow()
      .then((state) => {
        console.log("[SW] ✅ Force sync complete:", state);
        sendResponse({ success: true, syncState: state });
      })
      .catch((err) => {
        console.error("[SW] ❌ Force sync failed:", err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // ====================== PREFERENCES ======================
  if (request.action === "updatePreferences") {
    console.log("[SW] 📝 Updating preferences:", request.preferences);
    serverClient
      .updatePreferences(request.preferences)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => {
        console.error("[SW] ❌ Update preferences failed:", err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});
