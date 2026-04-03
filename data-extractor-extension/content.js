// ==================== CONFIG ====================
const DEFAULT_CONFIG = {
  containerSelector: ".text-secondary",
  urlSelector: "",
  textSelector: "",
};
let currentConfig = { ...DEFAULT_CONFIG };
let observer = null;
let currentData = [];

// Extract data using the three selectors
function extractData() {
  const containers = document.querySelectorAll(currentConfig.containerSelector);

  return Array.from(containers)
    .map((container) => {
      const urlEl = currentConfig.urlSelector
        ? container.querySelector(currentConfig.urlSelector)
        : container;

      const textEl = currentConfig.textSelector
        ? container.querySelector(currentConfig.textSelector)
        : container;

      // === FLEXIBLE URL EXTRACTION (no longer hardcoded to href) ===
      let url = "";
      if (urlEl) {
        url =
          urlEl.href ||
          urlEl.src ||
          urlEl.value ||
          urlEl.getAttribute("href") ||
          urlEl.getAttribute("data-href") ||
          urlEl.getAttribute("data-url") ||
          urlEl.getAttribute("src") ||
          "";
      }

      const text = (textEl?.textContent || "").trim();

      if (!url || !text) return null;
      return { url: url.trim(), text };
    })
    .filter(Boolean);
}

// Deep comparison
function dataEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function onDataChange(newData) {
  console.log("🔄 Data CHANGED →", newData.length, "items");
  console.table(newData);
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
  currentConfig = config || { ...DEFAULT_CONFIG };
  startObserving();
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.config) {
    currentConfig = changes.config.newValue || { ...DEFAULT_CONFIG };
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
