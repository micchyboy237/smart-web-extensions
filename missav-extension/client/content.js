// Jet_Apps/web-extensions/smart-web-extensions/missav-extension/client/content.js
let observer = null;
let currentData = [];
let retryTimeoutId = null; // Track pending retry to avoid duplicates
let extractionTimeoutId = null; // Track debounce timeout for extraction

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
 */
function getSrcOrDataSrc(element) {
  if (!element) return null;
  const tagName = element.tagName ? element.tagName.toUpperCase() : "";

  function isValidMediaUrl(url) {
    if (!url || typeof url !== "string") return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (/[()?:]/.test(trimmed) && /\s/.test(trimmed)) return false;
    if (
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("data:")
    )
      return false;
    if (!/^https?:\/\//i.test(trimmed)) return false;
    return true;
  }

  if (element.currentSrc) {
    const cs = element.currentSrc.trim();
    if (isValidMediaUrl(cs)) return cs;
  }

  const src = element.getAttribute("src");
  if (src && isValidMediaUrl(src)) return src.trim();

  const dataSrc = element.getAttribute("data-src");
  if (dataSrc && isValidMediaUrl(dataSrc)) return dataSrc.trim();

  if (tagName === "VIDEO") {
    const sourceEl = element.querySelector("source");
    if (sourceEl) {
      const sourceSrc = sourceEl.getAttribute("src");
      if (sourceSrc && isValidMediaUrl(sourceSrc)) return sourceSrc.trim();
    }
    const poster = element.getAttribute("poster");
    if (poster && isValidMediaUrl(poster)) return poster.trim();
  }

  return null;
}

// ====================== NEW: EXTRACTION HELPERS FOR DETAILS & DATE ======================
/**
 * Checks if the current page is a single video watch page.
 */
function isSingleVideoPage() {
  const pathPattern = /\/(?:dm\d+\/)?(?:en|ja|zh|ko|th)\/([a-z0-9]+-\d+)/i;
  const isMatch = pathPattern.test(window.location.pathname);
  console.log(
    `[CONTENT] 📄 Page Type Check: ${isMatch ? "Single Video" : "List/Other"} (${window.location.pathname})`,
  );
  return isMatch;
}

/**
 * Extracts the video description/details from the page.
 */
function extractDetails() {
  // Try multiple selectors to be robust
  const selectors = [
    ".order-first .text-secondary.break-all", // Specific to provided HTML
    ".mt-4.text-secondary.break-all", // Alternative common class
    "div[data-tab-content='details'] .text-secondary", // If tab-based
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.innerText.trim().length > 0) {
      console.log(`[CONTENT] 📝 Details found via selector: ${selector}`);
      return el.innerText.trim();
    }
  }
  console.log("[CONTENT] ⚠️ Details not found in DOM");
  return null;
}

/**
 * Extracts the release date from the <time> tag.
 */
function extractReleaseDate() {
  // Look for time tag near "Release date" label
  const timeEl = document.querySelector(".order-first time[datetime]");
  if (timeEl) {
    const dt = timeEl.getAttribute("datetime");
    console.log(`[CONTENT] 📅 Release Date found: ${dt}`);
    return dt;
  }
  console.log("[CONTENT] ⚠️ Release Date not found in DOM");
  return null;
}

// ====================== DATA EXTRACTION ======================
function extractData() {
  console.log("[CONTENT] 🔄 Starting data extraction...");
  const seen = new Map(); // id -> item

  // 1. Determine Context
  const isSinglePage = isSingleVideoPage();

  // 2. Extract Global Properties (Only if Single Page)
  let pageDetails = null;
  let pageReleaseDate = null;
  let currentVideoId = null;

  if (isSinglePage) {
    pageDetails = extractDetails();
    pageReleaseDate = extractReleaseDate();

    // Identify the ID of the video currently in the address bar
    const pathMatch = window.location.pathname.match(
      /\/(?:dm\d+\/)?(?:en|ja|zh|ko|th)\/([a-z0-9]+-\d+)/i,
    );
    if (pathMatch) {
      currentVideoId = pathMatch[1].toLowerCase();
      console.log(`[CONTENT] 🎯 Current Video ID detected: ${currentVideoId}`);

      // --- EXPLICIT MAIN VIDEO EXTRACTION ---
      const h1 = document.querySelector("h1.text-base, h1.lg\\:text-lg");
      if (h1) {
        const text = h1.innerText.trim();
        const url = window.location.href.split("#")[0]; // Clean URL
        const { videoId, code, episode } = extractJavInfo(url, text);

        // Only process if the extracted ID matches the URL ID (safety check)
        if (videoId && videoId.startsWith(currentVideoId)) {
          const id = generateIdFromUrl(url, videoId);

          // Extract Thumbnail from Video Player Poster
          const videoPlayer = document.querySelector("video.player");
          let thumbnail = null;
          if (videoPlayer) {
            thumbnail =
              videoPlayer.getAttribute("data-poster") ||
              videoPlayer.getAttribute("poster");
          }

          // Fallback: Look for any img in the order-first container if poster is missing
          if (!thumbnail) {
            const fallbackImg = document.querySelector(".order-first img");
            if (fallbackImg) thumbnail = getSrcOrDataSrc(fallbackImg);
          }

          // Generate Preview URL from Thumbnail
          const preview = generatePreviewUrl(thumbnail);

          const item = {
            id,
            url,
            text,
            thumbnail,
            preview, // Added generated preview
            videoId,
            code,
            episode,
            details: pageDetails,
            releaseDate: pageReleaseDate,
          };
          console.log("[CONTENT] ✅ Main video extracted:", {
            id,
            code,
            hasThumb: !!thumbnail,
            previewUrl: preview,
          });
          seen.set(id, item);
        }
      }
    }
  }

  // 3. Extract Related Videos (Anchors)
  const anchors = document.querySelectorAll(".text-secondary");
  console.log(
    `[CONTENT] 🔍 Found ${anchors.length} potential related video anchors`,
  );

  Array.from(anchors).forEach((a) => {
    let url = a.href?.trim() || "";
    const text = a.textContent?.trim() || "";

    // Clean hash from URL
    const hashIndex = url.indexOf("#");
    if (hashIndex !== -1) {
      url = url.substring(0, hashIndex);
    }

    if (!url || !text) return;

    const { videoId, code, episode } = extractJavInfo(url, text);
    if (!videoId) return;

    const id = generateIdFromUrl(url, videoId);

    // Skip if we already extracted this as the main video
    if (seen.has(id)) return;

    const container = findVideoWithPreviewContainer(a);
    let thumbnail = null;
    let preview = null;

    if (container) {
      const img = container.querySelector("img");
      thumbnail = getSrcOrDataSrc(img);

      // For related videos, we can also try to generate a preview if we have a thumbnail
      // but usually related videos might have their own preview logic or none.
      // If you want to apply the same rule to related videos, uncomment below:
      // if (thumbnail) preview = generatePreviewUrl(thumbnail);

      const video = container.querySelector("video");
      if (video) {
        // If a video tag exists in the container, use its source as preview
        preview = getSrcOrDataSrc(video);
      }
    }

    // STRICT MODE: Only attach details/date if this anchor matches the current URL's video ID
    const isCurrentVideo = currentVideoId && videoId === currentVideoId;

    const item = {
      id,
      url,
      text,
      thumbnail,
      preview,
      videoId,
      code,
      episode,
      details: isCurrentVideo ? pageDetails : null,
      releaseDate: isCurrentVideo ? pageReleaseDate : null,
    };
    seen.set(id, item);
  });

  const data = Array.from(seen.values());
  console.log(`[CONTENT] ✅ Extraction complete. ${data.length} unique items.`);

  // ====================== RETRY: Missing thumbnails ======================
  const missingMedia = data.filter((item) => !item.thumbnail && !item.preview);
  if (missingMedia.length > 0) {
    if (retryTimeoutId) clearTimeout(retryTimeoutId);
    retryTimeoutId = setTimeout(() => {
      retryTimeoutId = null;
      console.log(
        "[CONTENT] 🔄 Retrying media extraction for missing thumbnails...",
      );
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

/**
 * Converts a thumbnail URL to a preview URL by replacing the filename.
 * Example: https://fourhoi.com/jukd-593/cover-n.jpg -> https://fourhoi.com/jukd-593/preview.mp4
 */
function generatePreviewUrl(thumbnailUrl) {
  if (!thumbnailUrl || typeof thumbnailUrl !== "string") return null;

  // Check if it already looks like a preview or if we can safely replace the end
  if (thumbnailUrl.endsWith("/preview.mp4")) return thumbnailUrl;

  // Replace the last segment (filename) with preview.mp4
  // This handles cases like cover-n.jpg, cover.jpg, etc.
  const lastSlashIndex = thumbnailUrl.lastIndexOf("/");
  if (lastSlashIndex === -1) return null;

  const baseUrl = thumbnailUrl.substring(0, lastSlashIndex + 1);
  return `${baseUrl}preview.mp4`;
}

// ====================== DEEP COMPARISON ======================
function dataEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ====================== DATA CHANGE HANDLER ======================
async function onDataChange(newData) {
  console.log(
    `[CONTENT] 📤 Data Change Detected. Sending ${newData.length} items to sync.`,
  );

  // STEP 1: Sync to Python Server (via background)
  // We don't await this because it's non-critical for local display,
  // but we should handle errors gracefully.
  syncToServer(newData);

  // STEP 2: Save to Local IndexedDB - WAIT FOR COMPLETION
  const savePromises = newData.map((item) => {
    const itemWithId = {
      ...item,
      id: generateIdFromUrl(item.url, item.videoId),
    };
    return createItem(itemWithId).catch((err) => {
      if (err.name === "ConstraintError") {
        // If it exists, update it
        return updateItem(itemWithId).catch((updateErr) => {
          console.error("❌ Update failed:", updateErr);
        });
      } else {
        console.error("❌ DB write failed for", item.url, err);
      }
    });
  });

  // Wait for all DB operations to finish
  try {
    await Promise.all(savePromises);
    console.log("[CONTENT] ✅ All items saved to IndexedDB");
  } catch (err) {
    console.error("[CONTENT] ❌ Error saving batch to IndexedDB:", err);
  }
}

async function syncToServer(videos) {
  if (!videos || videos.length === 0) return;

  const videosWithIds = videos.map((video) => ({
    ...video,
    id: video.id || generateIdFromUrl(video.url, video.videoId),
  }));

  console.log("[CONTENT] 📡 Relaying to Background Service Worker...");
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
  } catch (err) {
    console.error("❌ Failed to read from IndexedDB:", err);
  }
}

// ====================== OBSERVER ======================
function startObserving() {
  if (observer) observer.disconnect();

  // Initial extraction
  currentData = extractData();
  onDataChange(currentData);

  observer = new MutationObserver(() => {
    // Clear any pending extraction timeout
    if (extractionTimeoutId) clearTimeout(extractionTimeoutId);

    // Debounce: Wait 500ms after the last DOM change before extracting again
    extractionTimeoutId = setTimeout(() => {
      const newData = extractData();
      if (!dataEquals(newData, currentData)) {
        console.log("[CONTENT] 👁️ Mutation detected: Data changed");
        currentData = newData;
        onDataChange(newData);
      }
    }, 500);
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
  if (request.action === "getPageVideoIds") {
    const videoIds = currentData.map((item) => item.id).filter(Boolean);
    sendResponse({ videoIds });
    return true;
  }
  // ... other handlers remain same ...
  if (request.action === "getItem") {
    getItem(request.id)
      .then((item) => sendResponse({ success: true, item }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === "getAll") {
    getAll(request.options || {})
      .then((items) => sendResponse({ success: true, items }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === "getCount") {
    getCount()
      .then((count) => sendResponse({ success: true, count }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === "deleteItem") {
    deleteItem(request.id)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === "deleteAll") {
    deleteAll()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
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
