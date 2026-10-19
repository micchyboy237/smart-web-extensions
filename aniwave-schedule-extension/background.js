// Background service worker for managing cache
console.log("[AWS] Background service worker started");

// Initialize storage on install ONLY if it doesn't exist yet
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[AWS] Extension installed/updated. Reason:", details.reason);

  // Only initialize if it's a fresh install or if storage is empty
  // This prevents wiping data during updates
  chrome.storage.local.get(["extractedData"], (result) => {
    if (!result.extractedData || result.extractedData.length === 0) {
      console.log("[AWS] Initializing empty storage (Fresh Install or Empty)");
      chrome.storage.local.set({
        extractedData: [],
        processedDays: [],
        lastUpdated: null,
        favorites: [],
        watchHistory: {},
      });
    } else {
      console.log("[AWS] Storage already exists. Preserving data.");
    }
  });
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[AWS] Background received message:", message.type);
  switch (message.type) {
    case "SAVE_DATA":
      handleSaveData(message.data, sendResponse);
      return true;
    case "GET_DATA":
      handleGetData(sendResponse);
      return true;
    case "MARK_DAY_PROCESSED":
      handleMarkDayProcessed(message.day, sendResponse);
      return true;
    case "CLEAR_DATA":
      handleClearData(sendResponse);
      return true;
    case "UPDATE_FAVORITES":
      handleUpdateFavorites(message.favorites, sendResponse);
      return true;
    case "UPDATE_WATCH_HISTORY":
      handleUpdateWatchHistory(message.watchHistory, sendResponse);
      return true;
    default:
      console.warn("[AWS] Background unknown message type:", message.type);
  }
});

async function handleSaveData(data, sendResponse) {
  try {
    console.log(
      "[AWS] Background saving extracted data:",
      data.length,
      "items",
    );
    const existing = await chrome.storage.local.get("extractedData");
    const currentData = existing.extractedData || [];

    // Merge new data, avoiding duplicates by href
    const existingHrefs = new Set(currentData.map((item) => item.href));
    const newData = data.filter((item) => !existingHrefs.has(item.href));
    const updatedData = [...currentData, ...newData];

    await chrome.storage.local.set({
      extractedData: updatedData,
      lastUpdated: new Date().toISOString(),
    });

    console.log(
      "[AWS] Background data saved successfully. Total items:",
      updatedData.length,
    );
    sendResponse({ success: true, count: updatedData.length });
  } catch (error) {
    console.error("[AWS] Background error saving data:", error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleGetData(sendResponse) {
  try {
    const data = await chrome.storage.local.get([
      "extractedData",
      "processedDays",
      "lastUpdated",
      "favorites",
      "watchHistory",
    ]);

    console.log("[AWS] Background retrieved data:", {
      items: data.extractedData?.length || 0,
      processedDays: data.processedDays?.length || 0,
      favorites: data.favorites?.length || 0,
    });

    sendResponse({
      success: true,
      extractedData: data.extractedData || [],
      processedDays: data.processedDays || [],
      lastUpdated: data.lastUpdated,
      favorites: data.favorites || [],
      watchHistory: data.watchHistory || {},
    });
  } catch (error) {
    console.error("[AWS] Background error getting data:", error);
    sendResponse({ success: false, error: message });
  }
}

async function handleMarkDayProcessed(day, sendResponse) {
  try {
    console.log("[AWS] Background marking day as processed:", day);
    const existing = await chrome.storage.local.get("processedDays");
    const processedDays = existing.processedDays || [];

    if (!processedDays.includes(day)) {
      processedDays.push(day);
      await chrome.storage.local.set({ processedDays });
      console.log("[AWS] Background day marked as processed:", day);
    }

    sendResponse({ success: true, processedDays });
  } catch (error) {
    console.error("[AWS] Background error marking day processed:", error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleClearData(sendResponse) {
  try {
    console.log("[AWS] Background clearing all cached data");
    await chrome.storage.local.set({
      extractedData: [],
      processedDays: [],
      lastUpdated: null,
      favorites: [],
      watchHistory: {},
    });
    console.log("[AWS] Background data cleared successfully");
    sendResponse({ success: true });
  } catch (error) {
    console.error("[AWS] Background error clearing data:", error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleUpdateFavorites(favorites, sendResponse) {
  try {
    console.log("[AWS] Background updating favorites:", favorites.length);
    await chrome.storage.local.set({ favorites });
    sendResponse({ success: true });
  } catch (error) {
    console.error("[AWS] Background error updating favorites:", error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleUpdateWatchHistory(watchHistory, sendResponse) {
  try {
    console.log("[AWS] Background updating watch history");
    await chrome.storage.local.set({ watchHistory });
    sendResponse({ success: true });
  } catch (error) {
    console.error("[AWS] Background error updating watch history:", error);
    sendResponse({ success: false, error: error.message });
  }
}
