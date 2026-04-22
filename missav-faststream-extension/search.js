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
  console.log("[MISSAV SEARCH] 🔄 Data CHANGED →", newData.length, "items");
  // console.table(newData);
  console.log(newData);

  // Keep the global in sync so panel.js watchDataChanges() and togglePanel() see fresh data.
  window.__MISSAV_DATA__ = newData;

  // Emit data to page context (panel.js)
  try {
    window.dispatchEvent(
      new CustomEvent("MISSAV_DATA_UPDATE", {
        detail: newData,
      }),
    );
  } catch (err) {
    console.error("[MISSAV SEARCH] Failed to dispatch data event:", err);
  }
}

// ====================== PANEL INJECTION ======================
function injectPanel() {
  if (document.getElementById("missav-faststream-panel")) return;

  function doInject() {
    try {
      if (document.getElementById("missav-faststream-panel")) return;

      // Resolve ALL extension resource URLs here in the content-script world,
      // because chrome.runtime is NOT available in the injected page-context scripts.
      // We stash them on window so panel.js can read them without calling chrome.runtime.
      window.__MISSAV_EXT_URLS__ = {
        panel: chrome.runtime.getURL("panel.js"),
        clusterJs: chrome.runtime.getURL("cluster.js"),
        clusterCss: chrome.runtime.getURL("cluster.css"),
      };
      if (window.__MISSAV_EXT_URLS__.panel) {
        console.log(
          "[MISSAV SEARCH] panel.js URL resolved:",
          window.__MISSAV_EXT_URLS__.panel,
        );
      }
      if (window.__MISSAV_EXT_URLS__.clusterJs) {
        console.log(
          "[MISSAV SEARCH] cluster.js URL resolved:",
          window.__MISSAV_EXT_URLS__.clusterJs,
        );
      }
      if (window.__MISSAV_EXT_URLS__.clusterCss) {
        console.log(
          "[MISSAV SEARCH] cluster.css URL resolved:",
          window.__MISSAV_EXT_URLS__.clusterCss,
        );
      }

      const script = document.createElement("script");
      script.src = window.__MISSAV_EXT_URLS__.panel;
      script.onload = () => {
        console.log("[MISSAV SEARCH] Panel script injected");
        script.remove();
      };

      (document.head || document.documentElement).appendChild(script);
    } catch (err) {
      console.error("[MISSAV SEARCH] Failed to inject panel:", err);
    }
  }

  // Ensure DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", doInject);
  } else {
    doInject();
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
async function init() {
  startObserving();
  // Store data globally for panel access
  window.__MISSAV_DATA__ = currentData;
  // Inject the floating panel
  injectPanel();
}

// chrome.storage.onChanged.addListener((changes) => {
//   if (changes.config) {
//     window.__MISSAV_DATA__ = currentData;
//     startObserving();
//   }
// });

// // ====================== POPUP COMMUNICATION ======================
// chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
//   if (request.action === "getData") {
//     sendResponse({ data: currentData });
//     window.__MISSAV_DATA__ = currentData;
//     return true;
//   }
// });

// Start
init();

// Debug helper
window.getCurrentData = () => currentData;
