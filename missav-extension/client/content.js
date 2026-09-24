let observer = null;
let currentData = [];
let retryTimeoutId = null; // Track pending retry to avoid duplicates

// ====================== DOM HELPERS ======================

/**
 * Walk up the DOM from `element` until we find a container that has
 * BOTH a <video> and an <img> inside it (the preview thumbnail card).
 */
function findVideoWithPreviewContainer(element) {
  if (!element || element === document.body) return null;
  const hasVideo = element.querySelector("video") !== null;
  const hasImg = element.querySelector("img") !== null;
  if (hasVideo && hasImg) {
    return element;
  }
  return findVideoWithPreviewContainer(element.parentElement);
}

/**
 * Extract the best available media URL from an <img> or <video> element.
 * Checks multiple attribute fallbacks to handle lazy-loading (Alpine.js, etc.).
 */
function getSrcOrDataSrc(element) {
  if (!element) return null;

  const tagName = element.tagName ? element.tagName.toUpperCase() : "";

  // --- Helper: validate a candidate URL ---
  function isValidMediaUrl(url) {
    if (!url || typeof url !== "string") return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    // Reject Alpine.js expressions
    if (/[()?:]/.test(trimmed) && /\s/.test(trimmed)) {
      return false;
    }
    // Reject javascript: placeholders
    if (trimmed.startsWith("javascript:")) {
      return false;
    }
    // Reject blob URLs
    if (trimmed.startsWith("blob:")) {
      return false;
    }
    // Reject data URIs
    if (trimmed.startsWith("data:")) {
      return false;
    }
    // Must look like a real URL
    if (!/^https?:\/\//i.test(trimmed)) {
      return false;
    }
    return true;
  }

  // --- 1. currentSrc (browser-resolved — bypasses Alpine entirely) ---
  if (element.currentSrc) {
    const cs = element.currentSrc.trim();
    if (isValidMediaUrl(cs)) {
      return cs;
    }
  }

  // --- 2. src attribute ---
  const src = element.getAttribute("src");
  if (src && isValidMediaUrl(src)) {
    return src.trim();
  }

  // --- 3. data-src attribute (lazy-load fallback) ---
  const dataSrc = element.getAttribute("data-src");
  if (dataSrc && isValidMediaUrl(dataSrc)) {
    return dataSrc.trim();
  }

  // --- 4. For <video>: check <source> children ---
  if (tagName === "VIDEO") {
    const sourceEl = element.querySelector("source");
    if (sourceEl) {
      const sourceSrc = sourceEl.getAttribute("src");
      if (sourceSrc && isValidMediaUrl(sourceSrc)) {
        return sourceSrc.trim();
      }
    }
    // --- 5. poster attribute (thumbnail fallback for videos) ---
    const poster = element.getAttribute("poster");
    if (poster && isValidMediaUrl(poster)) {
      return poster.trim();
    }
  }

  return null;
}

// ====================== DATA EXTRACTION ======================

function extractData() {
  const anchors = document.querySelectorAll(".text-secondary");

  const seen = new Map(); // id -> item

  Array.from(anchors).forEach((a) => {
    let url = a.href?.trim() || "";
    const text = a.textContent?.trim() || "";
    const hashIndex = url.indexOf("#");
    if (hashIndex !== -1) {
      url = url.substring(0, hashIndex);
    }
    if (!url || !text) {
      return;
    }

    const { videoId, code, episode } = extractJavInfo(url, text);
    const id = generateIdFromUrl(url, videoId);
    const container = findVideoWithPreviewContainer(a);

    let thumbnail = null;
    let preview = null;

    if (container) {
      const img = container.querySelector("img");
      thumbnail = getSrcOrDataSrc(img);

      const video = container.querySelector("video");
      if (video) {
        preview = getSrcOrDataSrc(video);
      }
    }

    const item = { id, url, text, thumbnail, preview, videoId, code, episode };
    const existing = seen.get(id);

    if (!existing) {
      seen.set(id, item);
    } else {
      // Merge: keep whichever copy has more data
      const merged = {
        ...existing,
        thumbnail: existing.thumbnail || item.thumbnail,
        preview: existing.preview || item.preview,
      };
      seen.set(id, merged);
    }
  });

  const data = Array.from(seen.values());

  // ====================== RETRY: Missing thumbnails ======================
  const missingMedia = data.filter((item) => !item.thumbnail && !item.preview);
  if (missingMedia.length > 0) {
    // Clear any previously scheduled retry to avoid stacking
    if (retryTimeoutId) clearTimeout(retryTimeoutId);
    retryTimeoutId = setTimeout(() => {
      retryTimeoutId = null;
      const freshData = extractData();
      const freshMap = new Map(freshData.map((item) => [item.id, item]));

      let changed = false;
      for (const item of currentData) {
        const fresh = freshMap.get(item.id);
        if (!fresh) continue;
        if (!item.thumbnail && fresh.thumbnail) {
          item.thumbnail = fresh.thumbnail;
          changed = true;
        }
        if (!item.preview && fresh.preview) {
          item.preview = fresh.preview;
          changed = true;
        }
      }
      if (changed) {
        onDataChange(currentData);
      }
    }, 500);
  }

  return data;
}

// ====================== DEEP COMPARISON ======================

function dataEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ====================== DATA CHANGE HANDLER ======================

/**
 * Handle data changes - sync to IndexedDB and Python server.
 * Server sync is relayed through the background service worker.
 */
async function onDataChange(newData) {
  console.log("🔄 Data CHANGED →", newData.length, "items");

  // STEP 1: Sync to Python Server (via background) — fire-and-forget
  syncToServer(newData);

  // STEP 2: Save to Local IndexedDB
  newData.forEach((item) => {
    const itemWithId = {
      ...item,
      id: generateIdFromUrl(item.url, item.videoId),
    };
    createItem(itemWithId).catch((err) => {
      if (err.name === "ConstraintError") {
        updateItem(itemWithId).catch((updateErr) =>
          console.error("❌ Update failed:", updateErr),
        );
      } else {
        console.error("❌ DB write failed for", item.url, err);
      }
    });
  });
}

/**
 * Sync scraped videos to the Python server via the background service worker.
 */
async function syncToServer(videos) {
  if (!videos || videos.length === 0) {
    return;
  }
  const videosWithIds = videos.map((video) => ({
    ...video,
    id: video.id || generateIdFromUrl(video.url, video.videoId),
  }));
  chrome.runtime.sendMessage(
    { action: "syncVideos", videos: videosWithIds },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error(
          "[MISSAV EXT] ❌ Background relay failed:",
          chrome.runtime.lastError.message,
        );
        return;
      }
      if (response?.success) {
        console.log("[MISSAV EXT] ✅ Server sync complete:", {
          ingested: response.ingested,
          total: response.total,
          time_ms: response.time_ms || "N/A",
        });
      } else {
        console.error("[MISSAV EXT] ❌ Server sync failed:", response?.error);
      }
    },
  );
}

// ====================== INITIAL DB LOAD & LOG ======================

async function logExistingItems() {
  try {
    const allItems = await getAll();
    const count = await getCount();
    console.log(
      `📚 Loaded ${allItems.length} existing items from MissAVExtensionDB`,
    );
    console.log(`📊 Database contains ${count} total records`);
    if (allItems.length > 0) {
      const withJavInfo = allItems.filter((item) => item.videoId);
      console.log(
        `📊 ${withJavInfo.length}/${allItems.length} items have JAV info`,
      );
    } else {
      console.log("📭 Database is currently empty.");
    }
  } catch (err) {
    console.error("❌ Failed to read from IndexedDB:", err);
  }
}

// ====================== OBSERVER ======================

function startObserving() {
  if (observer) observer.disconnect();
  currentData = extractData();
  onDataChange(currentData);
  observer = new MutationObserver(() => {
    const newData = extractData();
    if (!dataEquals(newData, currentData)) {
      currentData = newData;
      onDataChange(newData);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
}

// ====================== STORAGE ======================

async function loadConfig() {
  const { config } = await chrome.storage.sync.get("config");
  await logExistingItems();
  startObserving();
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.config) {
    startObserving();
  }
});

// ====================== POPUP COMMUNICATION ======================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getData") {
    sendResponse({ data: currentData });
    return true;
  }
  if (request.action === "getItem") {
    getItem(request.id)
      .then((item) => {
        sendResponse({ success: true, item });
      })
      .catch((err) => {
        console.error("❌ Failed to get item:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
  if (request.action === "getAll") {
    getAll(request.options || {})
      .then((items) => {
        sendResponse({ success: true, items });
      })
      .catch((err) => {
        console.error("❌ Failed to get all items:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
  if (request.action === "getCount") {
    getCount()
      .then((count) => {
        sendResponse({ success: true, count });
      })
      .catch((err) => {
        console.error("❌ Failed to get count:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
  if (request.action === "deleteItem") {
    deleteItem(request.id)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("❌ Failed to delete item:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
  if (request.action === "deleteAll") {
    deleteAll()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("❌ Failed to delete all items:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
  if (request.action === "getPageVideoIds") {
    const videoIds = currentData.map((item) => item.id).filter(Boolean);
    sendResponse({ videoIds });
    return true;
  }
});

// Start
loadConfig();

// Debug helpers
window.getCurrentData = () => currentData;
window.getItemFromDB = async (id) => await getItem(id);
window.getAllFromDB = async (options) => await getAll(options);
window.deleteAllData = async () => {
  await deleteAll();
};
window.getDBCount = async () => await getCount();
