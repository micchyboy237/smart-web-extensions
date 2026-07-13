// ====================== DOM ELEMENTS ======================
const queryInput = document.getElementById("query");
const topKInput = document.getElementById("topK");
const includeCodesSelect = document.getElementById("includeCodes");
const excludeCodesSelect = document.getElementById("excludeCodes");
const episodeMinInput = document.getElementById("episodeMin");
const episodeMaxInput = document.getElementById("episodeMax");
const diversityFactorInput = document.getElementById("diversityFactor");
const diversityValueSpan = document.getElementById("diversityValue");
const maxPerCodeInput = document.getElementById("maxPerCode");
const searchTypeSelect = document.getElementById("searchType");
const smartSearchBtn = document.getElementById("smartSearchBtn");
const quickSearchBtn = document.getElementById("quickSearchBtn");
const findSimilarBtn = document.getElementById("findSimilarBtn");
const serverStatusBtn = document.getElementById("serverStatusBtn");
const resultsContainer = document.getElementById("resultsContainer");

// ====================== STATE ======================
let availableCodes = new Set();

// ====================== INITIALIZATION ======================
document.addEventListener("DOMContentLoaded", async () => {
  // Load available codes from IndexedDB
  await loadAvailableCodes();
  // Set up event listeners
  setupEventListeners();
});

// ====================== LOAD DATA ======================
async function loadAvailableCodes() {
  try {
    const response = await chrome.runtime.sendMessage({ action: "getAll" });
    if (response.success) {
      const codes = new Set();
      response.items.forEach((item) => {
        if (item.code) codes.add(item.code);
      });
      availableCodes = codes;
      populateCodeSelects();
    }
  } catch (err) {
    console.error("[POPUP] Failed to load codes:", err);
  }
}

function populateCodeSelects() {
  const sortedCodes = Array.from(availableCodes).sort();
  [includeCodesSelect, excludeCodesSelect].forEach((select) => {
    select.innerHTML = "";
    sortedCodes.forEach((code) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = code;
      select.appendChild(option);
    });
  });
}

// ====================== EVENT LISTENERS ======================
function setupEventListeners() {
  // Update diversity value display
  diversityFactorInput.addEventListener("input", () => {
    diversityValueSpan.textContent = diversityFactorInput.value;
  });

  // Smart Search
  smartSearchBtn.addEventListener("click", () => performSmartSearch());

  // Quick Search
  quickSearchBtn.addEventListener("click", () => performQuickSearch());

  // Find Similar (requires a selected video)
  findSimilarBtn.addEventListener("click", () => {
    const videoId = prompt("Enter Video ID to find similar videos:");
    if (videoId) performFindSimilar(videoId);
  });

  // Server Status
  serverStatusBtn.addEventListener("click", () => checkServerStatus());
}

// ====================== API CALLS ======================
async function performSmartSearch() {
  const params = buildSearchParams();
  try {
    const response = await chrome.runtime.sendMessage({
      action: "smartSearch",
      params,
    });
    if (response.success) {
      displayResults(response.results || [], "Smart Search Results");
    } else {
      displayError(response.error || "Smart search failed");
    }
  } catch (err) {
    displayError(`Smart search error: ${err.message}`);
  }
}

async function performQuickSearch() {
  const query = queryInput.value.trim();
  if (!query) {
    displayError("Please enter a search query");
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      action: "quickSearch",
      query,
      options: {
        topK: parseInt(topKInput.value) || 10,
        searchType: searchTypeSelect.value,
        diversityFactor: parseFloat(diversityFactorInput.value),
      },
    });
    if (response.success) {
      displayResults(response.results || [], "Quick Search Results");
    } else {
      displayError(response.error || "Quick search failed");
    }
  } catch (err) {
    displayError(`Quick search error: ${err.message}`);
  }
}

async function performFindSimilar(videoId) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "findSimilar",
      videoId,
      options: {
        topK: parseInt(topKInput.value) || 10,
      },
    });
    if (response.success) {
      displayResults(response.results || [], `Similar to ${videoId}`);
    } else {
      displayError(response.error || "Find similar failed");
    }
  } catch (err) {
    displayError(`Find similar error: ${err.message}`);
  }
}

async function checkServerStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "getServerStatus",
    });
    if (response.success) {
      const status = response.syncState;
      resultsContainer.innerHTML = `
        <div class="status">
          <p><strong>Server Status:</strong> ${status.isOnline ? "Online" : "Offline"}</p>
          <p><strong>Pending Videos:</strong> ${status.pendingCount || 0}</p>
          <p><strong>Last Sync:</strong> ${status.lastSyncTime || "Never"}</p>
        </div>
      `;
    } else {
      displayError(response.error || "Failed to check server status");
    }
  } catch (err) {
    displayError(`Server status error: ${err.message}`);
  }
}

// ====================== HELPERS ======================
function buildSearchParams() {
  const episodeRange = getEpisodeRange();
  return {
    query: queryInput.value.trim(),
    topK: parseInt(topKInput.value) || 20,
    includeCodes: getSelectedOptions(includeCodesSelect),
    excludeCodes: getSelectedOptions(excludeCodesSelect),
    includeEpisodes: [], // Not implemented in UI yet
    episodeRange: episodeRange,
    excludeIds: [], // Not implemented in UI yet
    diversityFactor: parseFloat(diversityFactorInput.value),
    maxPerCode: maxPerCodeInput.value ? parseInt(maxPerCodeInput.value) : null,
    searchType: searchTypeSelect.value,
  };
}

function getSelectedOptions(selectElement) {
  return Array.from(selectElement.selectedOptions).map((opt) => opt.value);
}

function getEpisodeRange() {
  const min = episodeMinInput.value ? parseInt(episodeMinInput.value) : null;
  const max = episodeMaxInput.value ? parseInt(episodeMaxInput.value) : null;
  if (min !== null && max !== null) {
    return [min, max];
  }
  return null;
}

function displayResults(results, title) {
  if (!results.length) {
    resultsContainer.innerHTML = `<p class="status">No results found.</p>`;
    return;
  }
  let html = `<h3>${title} (${results.length})</h3>`;
  results.forEach((result, index) => {
    const metadata = result.metadata || {};
    html += `
      <div class="result-item">
        <p><strong>${index + 1}.</strong> ${metadata.text || "No title"}</p>
        <p><small>Code: ${metadata.code || "N/A"} | Episode: ${
          metadata.episode || "N/A"
        } | Score: ${result.score?.toFixed(2)}</small></p>
      </div>
    `;
  });
  resultsContainer.innerHTML = html;
}

function displayError(message) {
  resultsContainer.innerHTML = `<p class="status" style="color: #e74c3c;">❌ ${message}</p>`;
}
