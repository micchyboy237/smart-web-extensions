let observer = null;
let currentData = [];

// ====================== ID GENERATOR ======================
// Generates a stable, deterministic ID from a URL.
// Same URL always returns the exact same ID.
// DIFFERENT URLs with same videoId will generate DIFFERENT IDs.
function generateIdFromUrl(url, videoId) {
  console.log("[ID GEN] 🏷️ Generating ID for:", { url, videoId });

  if (!url && !videoId) {
    const fallbackId = "unknown-" + Date.now();
    console.log("[ID GEN] ⚠️ No URL or videoId, using fallback:", fallbackId);
    return fallbackId;
  }

  // Use the FULL URL as the basis for ID generation
  // This ensures juq-373-uncensored-leak and juq-373 get different IDs
  const input = url || videoId;
  console.log("[ID GEN] 📝 Input for hashing:", input);

  try {
    // Normalize the URL but keep the FULL path
    let normalized;
    if (url) {
      try {
        const urlObj = new URL(url);
        // Keep the full pathname to differentiate variants
        normalized = urlObj.origin + urlObj.pathname;
        console.log("[ID GEN] 🔗 Normalized URL:", normalized);
      } catch (e) {
        normalized = url;
        console.log("[ID GEN] ⚠️ URL parse failed, using raw URL");
      }
    } else {
      normalized = videoId;
    }

    // FNV-1a hash (32-bit) for consistent, unique IDs
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0; // FNV prime, keep 32-bit
    }

    const generatedId = "jav-" + hash.toString(36);
    console.log("[ID GEN] ✅ Generated ID:", generatedId);
    return generatedId;
  } catch (e) {
    console.error("[ID GEN] ❌ Error generating ID:", e);
    // Fallback to base64 of the input
    const fallback =
      "jav-" +
      btoa(input)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 16);
    console.log("[ID GEN] ⚠️ Using fallback ID:", fallback);
    return fallback;
  }
}

// ====================== JAV ID EXTRACTOR ======================
// Extracts videoId, code, and episode from URL or text
// URL pattern examples:
// - https://missav.ws/dm14/en/mxgs-893  → videoId: "mxgs-893", code: "mxgs", episode: "893"
// - https://missav.ws/en/nsps-467       → videoId: "nsps-467", code: "nsps", episode: "467"
// - https://missav.ws/dm13/en/bnsps-314 → videoId: "bnsps-314", code: "bnsps", episode: "314"
// - https://missav.ws/en/juq-373-uncensored-leak → videoId: "juq-373-uncensored-leak", code: "juq", episode: "373"
function extractJavInfo(url, text) {
  console.log("[MISSAV EXT] 🔍 extractJavInfo called");
  console.log("  URL:", url);
  console.log("  text:", text);

  // Pattern for three-part codes with optional suffix: letters+optional-digits + hyphen + letters + hyphen + digits + optional suffix
  // Examples: fc2-ppv-4909847, heyzo-1234, carib-5678-com, juq-373-uncensored-leak
  const threePartWithSuffix = /\b([a-z]+\d*-[a-z]+)-(\d+)(-[a-z0-9-]+)?\b/i;

  // Pattern for simple two-part codes with optional suffix
  // Examples: mxgs-893, club-914, sdde-123, 1pondo-456, juq-373, juq-373-uncensored
  const twoPartWithSuffix = /\b([a-z0-9]+)-(\d+)(-[a-z0-9-]+)?\b/i;

  // Try URL first with three-part (more specific)
  let match = url.match(threePartWithSuffix);
  if (match) {
    console.log("  ✅ Three-part URL match:", match[0]);
  }

  // Try URL with two-part
  if (!match) {
    match = url.match(twoPartWithSuffix);
    if (match) {
      console.log("  ✅ Two-part URL match:", match[0]);
    }
  }

  // Text fallback
  if (!match && text) {
    match = text.match(threePartWithSuffix) || text.match(twoPartWithSuffix);
    if (match) {
      console.log("  ✅ Text fallback match:", match[0]);
    }
  }

  if (match) {
    // videoId = full match (e.g., "juq-373-uncensored-leak" or "juq-373")
    const videoId = match[0].toLowerCase();
    // code = first part only (e.g., "juq")
    const code = match[1].toLowerCase();
    // episode = the digits (e.g., "373")
    const episode = match[2];

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

  console.log("  ⚠️ No match found");
  return { videoId: null, code: null, episode: null };
}

// Data extraction helpers
function findVideoWithPreviewContainer(element) {
  if (!element || element === document.body) return null;
  const hasVideo = element.querySelector("video") !== null;
  const hasImg = element.querySelector("img") !== null;
  if (hasVideo && hasImg) {
    return element;
  }
  return findVideoWithPreviewContainer(element.parentElement);
}

function getSrcOrDataSrc(element) {
  if (!element) return null;
  const src = element.getAttribute("src")?.trim();
  const dataSrc = element.getAttribute("data-src")?.trim();
  return src || dataSrc || null;
}

function extractData() {
  console.log("[MISSAV EXT] 📥 extractData() called");
  const anchors = document.querySelectorAll(".text-secondary");
  console.log("[MISSAV EXT] Found", anchors.length, ".text-secondary anchors");

  const data = Array.from(anchors)
    .map((a, index) => {
      let url = a.href?.trim() || "";
      const text = a.textContent?.trim() || "";
      const hashIndex = url.indexOf("#");
      if (hashIndex !== -1) {
        url = url.substring(0, hashIndex);
      }

      if (!url || !text) {
        return null;
      }

      // Extract JAV info from URL and text
      const { videoId, code, episode } = extractJavInfo(url, text);

      const container = findVideoWithPreviewContainer(a);
      if (!container) {
        console.log("[MISSAV EXT] ⚠️ No preview container for:", text);
        return {
          url,
          text,
          thumbnail: null,
          preview: null,
          videoId,
          code,
          episode,
        };
      }

      const img = container.querySelector("img");
      const thumbnail = img ? getSrcOrDataSrc(img) : null;

      const video = container.querySelector("video");
      let preview = null;
      if (video) {
        preview =
          getSrcOrDataSrc(video) ||
          video.querySelector("source")?.getAttribute("src")?.trim() ||
          null;
      }

      const result = {
        url,
        text,
        thumbnail,
        preview,
        videoId,
        code,
        episode,
      };

      console.log("[MISSAV EXT] 📦 Extracted item", index, ":", result);
      return result;
    })
    .filter((item) => item !== null);

  console.log("[MISSAV EXT] 📊 Total extracted items:", data.length);
  return data;
}

// Deep comparison
function dataEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function onDataChange(newData) {
  console.log("🔄 Data CHANGED →", newData.length, "items");
  console.table(newData);

  newData.forEach((item) => {
    // Generate unique ID using FULL URL (not just videoId)
    const itemWithId = {
      ...item,
      id: generateIdFromUrl(item.url, item.videoId),
    };

    console.log("[MISSAV EXT] 💾 Saving to DB:", {
      id: itemWithId.id,
      url: itemWithId.url,
      text: itemWithId.text,
      videoId: itemWithId.videoId,
      code: itemWithId.code,
      episode: itemWithId.episode,
    });

    createItem(itemWithId)
      .then((key) => console.log("✅ Saved item with key:", key))
      .catch((err) => {
        if (err.name === "ConstraintError") {
          console.log("→ Duplicate ID, updating:", itemWithId.id);
          updateItem(itemWithId)
            .then(() => console.log("✅ Updated item:", itemWithId.id))
            .catch((updateErr) =>
              console.error("❌ Update failed:", updateErr),
            );
        } else {
          console.error("❌ DB write failed for", item.url, err);
        }
      });
  });
}

// ====================== INITIAL DB LOAD & LOG ======================
async function logExistingItems() {
  try {
    // Updated to use getAll() instead of readAllItems()
    const allItems = await getAll();
    const count = await getCount();

    console.log(
      `📚 Loaded ${allItems.length} existing items from MissAVExtensionDB`,
    );
    console.log(`📊 Database contains ${count} total records`);

    if (allItems.length > 0) {
      console.table(allItems);

      // Show JAV info summary for existing items
      const withJavInfo = allItems.filter((item) => item.videoId);
      console.log(
        `📊 ${withJavInfo.length}/${allItems.length} items have JAV info (videoId/code/episode)`,
      );

      // Show example of different IDs for same code
      const groupedByCode = {};
      allItems.forEach((item) => {
        if (item.code) {
          if (!groupedByCode[item.code]) groupedByCode[item.code] = [];
          groupedByCode[item.code].push(item.videoId);
        }
      });

      Object.entries(groupedByCode).forEach(([code, videoIds]) => {
        if (videoIds.length > 1) {
          console.log(`🔑 Code "${code}" has multiple videoIds:`, videoIds);
        }
      });

      // Get items sorted by episode for better overview
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
