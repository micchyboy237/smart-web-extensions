/**
 * Background Service Worker
 * Owns the lifecycle of the detached "panel" window (one per tab) and
 * relays HTTP requests that a normal page/content script can't make cleanly.
 */

// tabId -> windowId of that tab's currently-open panel window
const openPanels = new Map();

chrome.action.onClicked.addListener(async (tab) => {
  if (openPanels.has(tab.id)) {
    await _closePanel(tab.id);
  } else {
    await _openPanel(tab);
  }
});

// User closed the panel window with the OS close button (not our Disable button,
// which also just calls window.close() — this listener catches both cases).
chrome.windows.onRemoved.addListener((closedWindowId) => {
  for (const [tabId, windowId] of openPanels.entries()) {
    if (windowId === closedWindowId) {
      openPanels.delete(tabId);
      _setPickerActive(tabId, false);
      chrome.action.setBadgeText({ tabId, text: "" });
      console.log(`[BG] Panel window closed for tab ${tabId}`);
    }
  }
});

// If the source tab itself closes, take its panel window down too.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const windowId = openPanels.get(tabId);
  if (!windowId) return;
  openPanels.delete(tabId);
  try {
    await chrome.windows.remove(windowId);
  } catch (_) {
    /* window may already be gone */
  }
  console.log(`[BG] Source tab ${tabId} closed, panel window removed`);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "REQUEST_DISABLE" && sender.tab) {
    _closePanel(sender.tab.id);
    return false;
  }

  if (msg.type === "SEND_TO_ENDPOINT") {
    fetch(msg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.data),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return {
          success: true,
          status: r.status,
          data: await r.json().catch(() => ({})),
        };
      })
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }

  return false;
});

async function _openPanel(tab) {
  console.log(`[BG] Opening panel for tab ${tab.id}`);
  let left, top;
  try {
    const sourceWindow = await chrome.windows.get(tab.windowId);
    left = (sourceWindow.left ?? 0) + (sourceWindow.width ?? 1200) - 420;
    top = sourceWindow.top ?? 40;
  } catch (_) {
    left = 100;
    top = 100;
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`panel.html?tabId=${tab.id}`),
    type: "popup",
    width: 420,
    height: 720,
    left,
    top,
  });
  openPanels.set(tab.id, win.id);
  chrome.action.setBadgeText({ tabId: tab.id, text: "ON" });
  chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#34a853" });
  await _setPickerActive(tab.id, true);
}

async function _closePanel(tabId) {
  console.log(`[BG] Closing panel for tab ${tabId}`);
  const windowId = openPanels.get(tabId);
  openPanels.delete(tabId);
  await _setPickerActive(tabId, false);
  chrome.action.setBadgeText({ tabId, text: "" });
  if (windowId) {
    try {
      await chrome.windows.remove(windowId);
    } catch (_) {
      /* already closed */
    }
  }
}

async function _setPickerActive(tabId, active) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PICKER", active });
  } catch (err) {
    console.warn(
      `[BG] Could not reach content script on tab ${tabId}:`,
      err.message,
    );
  }
}
