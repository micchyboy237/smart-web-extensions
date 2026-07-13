// ====================== DOM ELEMENTS ======================
const queryInput = document.getElementById("query");
const topKInput = document.getElementById("topK");
const includeCodesSelect = document.getElementById("includeCodes");
const excludeCodesSelect = document.getElementById("excludeCodes");
const includeCodesFilter = document.getElementById("includeCodesFilter");
const excludeCodesFilter = document.getElementById("excludeCodesFilter");
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
const loadingOverlay = document.getElementById("loadingOverlay");
const toast = document.getElementById("toast");
const themeToggle = document.getElementById("themeToggle");
const clearQueryBtn = document.getElementById("clearQuery");

// ====================== STATE ======================
let availableCodes = new Set();
let currentTheme = "light";

// ====================== INITIALIZATION ======================
document.addEventListener("DOMContentLoaded", async () => {
  // Load theme
  await loadTheme();
  // Load available codes from IndexedDB
  await loadAvailableCodes();
  // Auto-focus search input
  queryInput.focus();
  // Set up event listeners
  setupEventListeners();
  // Update slider visuals
  updateSliderVisuals();
});

// ====================== THEME ======================
async function loadTheme() {
  const { theme } = await chrome.storage.sync.get("theme");
  currentTheme = theme || "light";
  document.documentElement.setAttribute("data-theme", currentTheme);
  updateThemeIcon();
}

function toggleTheme() {
  currentTheme = currentTheme === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", currentTheme);
  chrome.storage.sync.set({ theme: currentTheme });
  updateThemeIcon();
  showToast(`Switched to ${currentTheme} mode`, "success");
}

function updateThemeIcon() {
  const icon = themeToggle.querySelector("i");
  icon.className = currentTheme === "light" ? "fas fa-moon" : "fas fa-sun";
}

// ====================== LOAD DATA ======================
async function loadAvailableCodes() {
  showLoading(true);
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
    showToast("Failed to load codes", "error");
  } finally {
    showLoading(false);
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
  // Add filter event listeners
  includeCodesFilter.addEventListener("input", () =>
    filterOptions(includeCodesSelect, includeCodesFilter.value),
  );
  excludeCodesFilter.addEventListener("input", () =>
    filterOptions(excludeCodesSelect, excludeCodesFilter.value),
  );
}

function filterOptions(selectElement, filterText) {
  const options = selectElement.options;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const text = option.textContent.toLowerCase();
    const show = text.includes(filterText.toLowerCase());
    option.style.display = show ? "block" : "none";
  }
}

// ====================== EVENT LISTENERS ======================
function setupEventListeners() {
  // Theme toggle
  themeToggle.addEventListener("click", toggleTheme);

  // Clear query
  clearQueryBtn.addEventListener("click", () => {
    queryInput.value = "";
    queryInput.focus();
  });

  // Update diversity value display
  diversityFactorInput.addEventListener("input", () => {
    diversityValueSpan.textContent = diversityFactorInput.value;
    updateSliderVisuals();
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

  // Keyboard shortcuts
  queryInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") performSmartSearch();
  });
}

// ====================== SLIDER VISUALS ======================
function updateSliderVisuals() {
  // Update diversity slider track fill
  const progress =
    (diversityFactorInput.value / diversityFactorInput.max) * 100;
  diversityFactorInput.style.setProperty("--progress", `${progress}%`);
}

// ====================== API CALLS ======================
async function performSmartSearch() {
  const params = buildSearchParams();
  if (!params.query) {
    showToast("Please enter a search query", "error");
    return;
  }
  showLoading(true);
  try {
    const response = await chrome.runtime.sendMessage({
      action: "smartSearch",
      params,
    });
    if (response.success) {
      displayResults(response.results || [], "Smart Search Results");
      showToast(`Found ${response.results?.length || 0} results`, "success");
    } else {
      showToast(response.error || "Smart search failed", "error");
    }
  } catch (err) {
    showToast(`Smart search error: ${err.message}`, "error");
  } finally {
    showLoading(false);
  }
}

async function performQuickSearch() {
  const query = queryInput.value.trim();
  if (!query) {
    showToast("Please enter a search query", "error");
    return;
  }
  showLoading(true);
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
      showToast(`Found ${response.results?.length || 0} results`, "success");
    } else {
      showToast(response.error || "Quick search failed", "error");
    }
  } catch (err) {
    showToast(`Quick search error: ${err.message}`, "error");
  } finally {
    showLoading(false);
  }
}

async function performFindSimilar(videoId) {
  showLoading(true);
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
      showToast(
        `Found ${response.results?.length || 0} similar videos`,
        "success",
      );
    } else {
      showToast(response.error || "Find similar failed", "error");
    }
  } catch (err) {
    showToast(`Find similar error: ${err.message}`, "error");
  } finally {
    showLoading(false);
  }
}

async function checkServerStatus() {
  showLoading(true);
  try {
    const response = await chrome.runtime.sendMessage({
      action: "getServerStatus",
    });
    if (response.success) {
      const status = response.syncState;
      resultsContainer.innerHTML = `
        <div class="status-info">
          <h4><i class="fas fa-server"></i> Server Status</h4>
          <p><strong>Status:</strong> <span class="${status.isOnline ? "online" : "offline"}">
            ${status.isOnline ? "Online ✅" : "Offline ❌"}
          </span></p>
          <p><strong>Pending Videos:</strong> ${status.pendingCount || 0}</p>
          <p><strong>Last Sync:</strong> ${status.lastSyncTime || "Never"}</p>
        </div>
      `;
      showToast("Server status updated", "success");
    } else {
      showToast(response.error || "Failed to check server status", "error");
    }
  } catch (err) {
    showToast(`Server status error: ${err.message}`, "error");
  } finally {
    showLoading(false);
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
    includeEpisodes: [],
    episodeRange: episodeRange,
    excludeIds: [],
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
    resultsContainer.innerHTML = `
      <div class="empty-results">
        <i class="fas fa-search"></i>
        <p>No results found</p>
      </div>
    `;
    return;
  }
  let html = `<h4><i class="fas fa-list"></i> ${title} (${results.length})</h4>`;
  results.forEach((result, index) => {
    const metadata = result.metadata || {};
    const videoId = metadata.video_id || metadata.videoId || "N/A";
    const code = metadata.code || "N/A";
    const episode = metadata.episode || "N/A";
    const text = metadata.text || "No title";
    const score = result.score ? result.score.toFixed(2) : "N/A";
    const diversityScore = result.diversity_score
      ? result.diversity_score.toFixed(2)
      : "N/A";

    html += `
      <div class="result-item" data-video-id="${videoId}">
        <h4>${text}</h4>
        <div class="metadata">
          <span><i class="fas fa-tag"></i> ${code}</span>
          <span><i class="fas fa-hashtag"></i> ${episode}</span>
          <span><i class="fas fa-star"></i> ${score}</span>
          <span><i class="fas fa-palette"></i> ${diversityScore}</span>
          <span class="score">#${index + 1}</span>
        </div>
      </div>
    `;
  });
  resultsContainer.innerHTML = html;

  // Add click to copy video ID
  resultsContainer.querySelectorAll(".result-item").forEach((item) => {
    item.addEventListener("click", () => {
      const videoId = item.getAttribute("data-video-id");
      navigator.clipboard.writeText(videoId);
      showToast(`Copied: ${videoId}`, "success");
    });
  });
}

function showLoading(show) {
  loadingOverlay.classList.toggle("hidden", !show);
}

function showToast(message, type = "info") {
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

// ====================== STYLES FOR STATUS INFO ======================
const style = document.createElement("style");
style.textContent = `
  .status-info {
    padding: 12px;
  }
  .status-info h4 {
    margin: 0 0 12px 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
  }
  .status-info p {
    margin: 6px 0;
    font-size: 13px;
  }
  .online {
    color: var(--success-color);
    font-weight: 600;
  }
  .offline {
    color: var(--error-color);
    font-weight: 600;
  }
`;
document.head.appendChild(style);
