let observer = null;
let currentData = [];

// ====================== ID GENERATOR ======================
// Generates a stable, deterministic ID from a URL.
// Same URL always returns the exact same ID.
function generateIdFromUrl(url) {
  if (!url) return "unknown-" + Date.now();
  try {
    const normalized = new URL(url).href;
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return "url-" + hash.toString(36);
  } catch (e) {
    return (
      "url-" +
      btoa(url)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 16)
    );
  }
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
  const anchors = document.querySelectorAll(".text-secondary");

  const data = Array.from(anchors)
    .map((a) => {
      let url = a.href?.trim() || "";
      const text = a.textContent?.trim() || "";

      const hashIndex = url.indexOf("#");
      if (hashIndex !== -1) {
        url = url.substring(0, hashIndex);
      }

      if (!url || !text) {
        return null;
      }

      const container = findVideoWithPreviewContainer(a);

      if (!container) {
        return {
          url,
          text,
          thumbnail: null,
          preview: null,
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

      return {
        url,
        text,
        thumbnail,
        preview,
      };
    })
    .filter((item) => item !== null);

  return data;
}

// Deep comparison
function dataEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function onDataChange(newData) {
  console.log("🔄 Data CHANGED →", newData.length, "items");
  console.table(newData);

  // Persist to IndexedDB with deterministic ID based on URL
  newData.forEach((item) => {
    const itemWithId = {
      ...item,
      id: generateIdFromUrl(item.url), // ← this makes it unique & stable
    };

    createItem(itemWithId)
      .then((key) => console.log("✅ Saved item with key:", key))
      .catch((err) => {
        if (err.name === "ConstraintError") {
          console.log("→ Duplicate URL skipped:", item.url);
        } else {
          console.error("❌ DB write failed for", item.url, err);
        }
      });
  });
}

// ====================== INITIAL DB LOAD & LOG ======================
async function logExistingItems() {
  try {
    const allItems = await readAllItems();
    console.log(
      `📚 Loaded ${allItems.length} existing items from MissAVExtensionDB`,
    );
    if (allItems.length > 0) {
      console.table(allItems);
      // Optional: also show a summary
      console.log("Sample item:", allItems[0]);
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

  // === Call logging FIRST, before starting observer or extracting data ===
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
});

// Start
loadConfig();

// Debug helper
window.getCurrentData = () => currentData;
