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

// ====================== JAV ID EXTRACTOR ======================
// Extracts videoId, code, and episode from URL or text
// URL pattern examples:
// - https://missav.ws/dm14/en/mxgs-893  → videoId: "mxgs-893", code: "mxgs", episode: "893"
// - https://missav.ws/en/nsps-467       → videoId: "nsps-467", code: "nsps", episode: "467"
// - https://missav.ws/dm13/en/bnsps-314 → videoId: "bnsps-314", code: "bnsps", episode: "314"
function extractJavInfo(url, text) {
  // Pattern: word characters (letters, maybe numbers) followed by hyphen and digits
  // Handles prefixes with multiple letters: mxgs, nsps, bnsps, etc.
  const videoIdPattern = /\b([a-z]{2,})-(\d+)\b/i;
  
  // Try to extract from URL first (most reliable)
  let match = url.match(videoIdPattern);
  
  // If URL doesn't match, try the text (fallback)
  if (!match && text) {
    match = text.match(videoIdPattern);
  }
  
  if (match) {
    const videoId = match[0].toLowerCase();
    const code = match[1].toLowerCase();
    const episode = match[2];
    return { videoId, code, episode };
  }
  
  // No match found
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

      // Extract JAV info from URL and text
      const { videoId, code, episode } = extractJavInfo(url, text);

      const container = findVideoWithPreviewContainer(a);

      if (!container) {
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

      return {
        url,
        text,
        thumbnail,
        preview,
        videoId,
        code,
        episode,
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
  // console.table(newData);
  console.log(newData);

  // Persist to IndexedDB with deterministic ID based on URL
  newData.forEach((item) => {
    const itemWithId = {
      ...item,
      id: generateIdFromUrl(item.url), // ← this makes it unique & stable
    };
  });
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
async function init() {
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
init();

// Debug helper
window.getCurrentData = () => currentData;
