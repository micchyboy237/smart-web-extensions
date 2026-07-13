let observer = null;
let currentData = [];
let retryTimeoutId = null; // Track pending retry to avoid duplicates

// ====================== ID GENERATOR ======================
// Generates a stable, deterministic ID from a URL.
// Same URL always returns the exact same ID.
// DIFFERENT URLs with same videoId will generate DIFFERENT IDs.
function generateIdFromUrl(url, videoId) {
  if (!url && !videoId) {
    const fallbackId = "unknown-" + Date.now();
    return fallbackId;
  }
  const input = url || videoId;
  try {
    let normalized;
    if (url) {
      try {
        const urlObj = new URL(url);
        normalized = urlObj.origin + urlObj.pathname;
      } catch (e) {
        normalized = url;
      }
    } else {
      normalized = videoId;
    }
    // FNV-1a hash (32-bit) for consistent, unique IDs
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    const generatedId = "jav-" + hash.toString(36);
    return generatedId;
  } catch (e) {
    const fallback =
      "jav-" +
      btoa(input)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 16);
    return fallback;
  }
}

// ====================== JAV ID EXTRACTOR ======================
// Extracts videoId, code, and episode from URL or text
//
// Supported formats:
//   With hyphen:
//     - "mxgs-893"              → videoId: "mxgs-893",    code: "mxgs",  episode: "893"
//     - "juq-373-uncensored"    → videoId: "juq-373-uncensored", code: "juq", episode: "373"
//     - "fc2-ppv-4909847"       → videoId: "fc2-ppv-4909847",   code: "fc2-ppv", episode: "4909847"
//   Without hyphen:
//     - "mcs0261"               → videoId: "mcs0261",     code: "mcs",   episode: "0261"
//     - "abp123"                → videoId: "abp123",      code: "abp",   episode: "123"
//     - "1pondo456"             → videoId: "1pondo456",   code: "1pondo", episode: "456"
//     - "heyzo1234"             → videoId: "heyzo1234",   code: "heyzo", episode: "1234"
//     - "carib5678"             → videoId: "carib5678",   code: "carib", episode: "5678"
function extractJavInfo(url, text) {
  console.log("[MISSAV EXT] 🔍 extractJavInfo called");
  console.log("  URL:", url);
  console.log("  text:", text);

  // ---------------------------------------------------------
  // Pattern 1: Three-part codes with hyphens + optional suffix
  // Examples: fc2-ppv-4909847, fc2-ppv-4909847-uncensored
  // ---------------------------------------------------------
  const threePartWithSuffix = /\b([a-z]+\d*-[a-z]+)-(\d+)(-[a-z0-9-]+)?\b/i;

  // ---------------------------------------------------------
  // Pattern 2: Two-part codes with hyphens + optional suffix
  // Examples: mxgs-893, juq-373, juq-373-uncensored-leak, club-914
  // ---------------------------------------------------------
  const twoPartWithSuffix = /\b([a-z0-9]+)-(\d+)(-[a-z0-9-]+)?\b/i;

  // ---------------------------------------------------------
  // Pattern 3: Letters followed by digits (NO hyphen)
  // Examples: mcs0261, abp123, heyzo1234, carib5678
  // Captures: group 1 = letters (code), group 2 = digits (episode)
  // ---------------------------------------------------------
  const lettersThenDigits = /\b([a-z]+)(\d{3,6})\b/i;

  // ---------------------------------------------------------
  // Pattern 4: Digits then letters (NO hyphen)
  // Examples: 1pondo456
  // Captures: group 1 = digits+letters (code), group 2 = digits (episode)
  // ---------------------------------------------------------
  const digitsThenLetters = /\b(\d+[a-z]+)(\d{3,6})\b/i;

  let match = null;
  let patternUsed = "";

  // --- Try URL first ---
  match = url.match(threePartWithSuffix);
  if (match) patternUsed = "threePartWithSuffix (URL)";

  if (!match) {
    match = url.match(twoPartWithSuffix);
    if (match) patternUsed = "twoPartWithSuffix (URL)";
  }

  if (!match) {
    match = url.match(lettersThenDigits);
    if (match) patternUsed = "lettersThenDigits (URL)";
  }

  if (!match) {
    match = url.match(digitsThenLetters);
    if (match) patternUsed = "digitsThenLetters (URL)";
  }

  // --- Text fallback ---
  if (!match && text) {
    match =
      text.match(threePartWithSuffix) ||
      text.match(twoPartWithSuffix) ||
      text.match(lettersThenDigits) ||
      text.match(digitsThenLetters);
    if (match) patternUsed = "text fallback";
  }

  // --- Build result ---
  if (match) {
    let videoId, code, episode;

    if (patternUsed.includes("threePart") || patternUsed.includes("twoPart")) {
      // Hyphenated formats: full match is the videoId, group 1 is code, group 2 is episode
      videoId = match[0].toLowerCase();
      code = match[1].toLowerCase();
      episode = match[2];
    } else if (patternUsed.includes("lettersThenDigits")) {
      // No-hyphen format: "mcs0261" → group 1 = "mcs", group 2 = "0261"
      videoId = match[0].toLowerCase();
      code = match[1].toLowerCase();
      episode = match[2];
    } else if (patternUsed.includes("digitsThenLetters")) {
      // No-hyphen format: "1pondo456" → group 1 = "1pondo" (code), group 2 = "456" (episode)
      videoId = match[0].toLowerCase();
      code = match[1].toLowerCase();
      episode = match[2];
    } else {
      // Fallback for any other match
      videoId = match[0].toLowerCase();
      code = match[1] ? match[1].toLowerCase() : null;
      episode = match[2] || null;
    }

    console.log(`  ✅ Match via ${patternUsed}:`, match[0]);
    console.log(
      "  📦 Result -> videoId:",
      videoId,
      "| code:",
      code,
      "| episode:",
      episode,
    );
    return { videoId, code, episode };
  }

  console.log("  ⚠️ No match found for any pattern");
  return { videoId: null, code: null, episode: null };
}

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
 *
 * CRITICAL: Validates that extracted URLs are real HTTP(S) URLs, not:
 *   - Alpine.js expressions (e.g., "item.dvd_id ? cdnUrl(...) : '...'")
 *   - base64 data URIs (data:image/...)
 *   - blob URLs (blob:...)
 *   - javascript: placeholders
 *
 * Priority for <img>:
 *   1. currentSrc (browser-resolved URL — bypasses Alpine entirely)
 *   2. src attribute (if it passes validation)
 *   3. data-src attribute (lazy-load fallback, if it passes validation)
 *
 * Priority for <video>:
 *   1. currentSrc
 *   2. src attribute (validated)
 *   3. data-src attribute (validated)
 *   4. <source> child element's src
 *   5. poster attribute (static thumbnail fallback)
 */
function getSrcOrDataSrc(element) {
  if (!element) return null;

  const tagName = element.tagName ? element.tagName.toUpperCase() : "";

  // --- Helper: validate a candidate URL ---
  function isValidMediaUrl(url) {
    if (!url || typeof url !== "string") return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    // Reject Alpine.js expressions (contain spaces, parentheses, question marks with spaces, etc.)
    if (/[()?:]/.test(trimmed) && /\s/.test(trimmed)) {
      console.log(
        `[MISSAV EXT] 🚫 Rejected Alpine expression: "${trimmed.substring(0, 80)}"`,
      );
      return false;
    }
    // Reject javascript: placeholders
    if (trimmed.startsWith("javascript:")) {
      console.log(`[MISSAV EXT] 🚫 Rejected javascript: placeholder`);
      return false;
    }
    // Reject blob URLs (temporary, not persistable)
    if (trimmed.startsWith("blob:")) {
      console.log(
        `[MISSAV EXT] 🚫 Rejected blob URL: "${trimmed.substring(0, 60)}"`,
      );
      return false;
    }
    // Reject data URIs (base64 inline — too large for DB, not a real thumbnail)
    if (trimmed.startsWith("data:")) {
      console.log(
        `[MISSAV EXT] 🚫 Rejected data URI (base64) — length: ${trimmed.length}`,
      );
      return false;
    }
    // Must look like a real URL: starts with http:// or https://
    if (!/^https?:\/\//i.test(trimmed)) {
      console.log(
        `[MISSAV EXT] 🚫 Rejected non-HTTP URL: "${trimmed.substring(0, 80)}"`,
      );
      return false;
    }
    return true;
  }

  // --- 1. currentSrc (browser-resolved — bypasses Alpine entirely) ---
  if (element.currentSrc) {
    const cs = element.currentSrc.trim();
    if (isValidMediaUrl(cs)) {
      console.log(`[MISSAV EXT] 🖼️ Got currentSrc from <${tagName}>:`, cs);
      return cs;
    }
  }

  // --- 2. src attribute ---
  const src = element.getAttribute("src");
  if (src && isValidMediaUrl(src)) {
    console.log(`[MISSAV EXT] 🖼️ Got src from <${tagName}>:`, src.trim());
    return src.trim();
  }

  // --- 3. data-src attribute (lazy-load fallback) ---
  const dataSrc = element.getAttribute("data-src");
  if (dataSrc && isValidMediaUrl(dataSrc)) {
    console.log(
      `[MISSAV EXT] 🖼️ Got data-src from <${tagName}>:`,
      dataSrc.trim(),
    );
    return dataSrc.trim();
  }

  // --- 4. For <video>: check <source> children ---
  if (tagName === "VIDEO") {
    const sourceEl = element.querySelector("source");
    if (sourceEl) {
      const sourceSrc = sourceEl.getAttribute("src");
      if (sourceSrc && isValidMediaUrl(sourceSrc)) {
        console.log(
          "[MISSAV EXT] 🖼️ Got src from <source> child:",
          sourceSrc.trim(),
        );
        return sourceSrc.trim();
      }
    }
    // --- 5. poster attribute (thumbnail fallback for videos) ---
    const poster = element.getAttribute("poster");
    if (poster && isValidMediaUrl(poster)) {
      console.log("[MISSAV EXT] 🖼️ Got poster from <video>:", poster.trim());
      return poster.trim();
    }
  }

  console.log(`[MISSAV EXT] ⚠️ No valid media URL found for <${tagName}>`);
  return null;
}

// ====================== DATA EXTRACTION ======================

function extractData() {
  console.log("[MISSAV EXT] 📥 extractData() called");
  const anchors = document.querySelectorAll(".text-secondary");
  console.log("[MISSAV EXT] Found", anchors.length, ".text-secondary anchors");

  const seen = new Map(); // id -> item

  Array.from(anchors).forEach((a, index) => {
    let url = a.href?.trim() || "";
    const text = a.textContent?.trim() || "";
    const hashIndex = url.indexOf("#");
    if (hashIndex !== -1) {
      url = url.substring(0, hashIndex);
    }
    if (!url || !text) {
      console.log(
        `[MISSAV EXT] ⏭️ Skipping anchor #${index}: missing url or text`,
      );
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
      console.log(
        `[MISSAV EXT] 📸 Item #${index} "${text.substring(0, 50)}..." → thumb: ${!!thumbnail}, preview: ${!!preview}`,
      );
    } else {
      console.log(
        "[MISSAV EXT] ⚠️ No preview container for:",
        text.substring(0, 50),
      );
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
      console.log("[MISSAV EXT] 🔁 Duplicate id merged:", id);
    }
  });

  const data = Array.from(seen.values());
  console.log("[MISSAV EXT] 📊 Total extracted items (deduped):", data.length);

  // ====================== RETRY: Missing thumbnails ======================
  // Alpine.js lazy-loading may not have resolved src/data-src yet on first
  // paint. Schedule a ONE-SHOT retry ~500ms later for any items missing
  // both thumbnail AND preview.
  const missingMedia = data.filter((item) => !item.thumbnail && !item.preview);
  if (missingMedia.length > 0) {
    console.log(
      `[MISSAV EXT] ⏳ ${missingMedia.length} items missing both thumbnail & preview — scheduling retry in 500ms`,
    );
    // Clear any previously scheduled retry to avoid stacking
    if (retryTimeoutId) clearTimeout(retryTimeoutId);
    retryTimeoutId = setTimeout(() => {
      retryTimeoutId = null;
      console.log("[MISSAV EXT] 🔄 Running lazy-load retry...");
      const freshData = extractData();
      const freshMap = new Map(freshData.map((item) => [item.id, item]));

      let changed = false;
      for (const item of currentData) {
        const fresh = freshMap.get(item.id);
        if (!fresh) continue;
        if (!item.thumbnail && fresh.thumbnail) {
          item.thumbnail = fresh.thumbnail;
          changed = true;
          console.log(`[MISSAV EXT] 🔄 Retry: got thumbnail for ${item.id}`);
        }
        if (!item.preview && fresh.preview) {
          item.preview = fresh.preview;
          changed = true;
          console.log(`[MISSAV EXT] 🔄 Retry: got preview for ${item.id}`);
        }
      }
      if (changed) {
        console.log(
          "[MISSAV EXT] 🔄 Lazy-load retry found new media — syncing",
        );
        onDataChange(currentData);
      } else {
        console.log("[MISSAV EXT] 🔄 Lazy-load retry: no new media found");
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
  console.table(newData);

  // STEP 1: Sync to Python Server (via background) — fire-and-forget
  syncToServer(newData);

  // STEP 2: Save to Local IndexedDB
  newData.forEach((item) => {
    const itemWithId = {
      ...item,
      id: generateIdFromUrl(item.url, item.videoId),
    };
    console.log("[MISSAV EXT] 💾 Saving to DB:", {
      id: itemWithId.id,
      url: itemWithId.url,
      text: itemWithId.text?.substring(0, 60),
      videoId: itemWithId.videoId,
      code: itemWithId.code,
      episode: itemWithId.episode,
    });
    createItem(itemWithId).catch((err) => {
      if (err.name === "ConstraintError") {
        console.log("→ Duplicate ID, updating:", itemWithId.id);
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
 * See service-worker.js for the actual serverClient.ingestVideos() call.
 */
async function syncToServer(videos) {
  if (!videos || videos.length === 0) {
    console.log("[MISSAV EXT] 📭 No videos to sync");
    return;
  }
  console.log(
    `[MISSAV EXT] 📤 Relaying ${videos.length} videos to background for sync...`,
  );
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
      const sortedByEpisode = await getAll({
        sortBy: "episode",
        sortOrder: "asc",
      });
      console.log(
        "📋 Items sorted by episode:",
        sortedByEpisode.map((i) => `${i.code}-${i.episode}`),
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
        console.log("✅ Retrieved item via popup:", item);
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
        console.log("✅ Retrieved items via popup:", items.length);
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
        console.log("✅ Item count:", count);
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
        console.log("✅ Item deleted via popup:", request.id);
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
        console.log("✅ All items deleted via popup request");
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("❌ Failed to delete all items:", err);
        sendResponse({ success: false, error: err.message });
      });
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
  console.log("🧹 Manual deleteAll triggered");
  await deleteAll();
  console.log("✅ Manual deleteAll complete");
};
window.getDBCount = async () => await getCount();
