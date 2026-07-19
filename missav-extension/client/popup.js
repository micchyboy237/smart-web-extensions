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
const findSimilarBtn = document.getElementById("findSimilarBtn");
const resultsContainer = document.getElementById("resultsContainer");
const loadingOverlay = document.getElementById("loadingOverlay");
const toast = document.getElementById("toast");
const themeToggle = document.getElementById("themeToggle");
const clearQueryBtn = document.getElementById("clearQuery");
const resultCount = document.getElementById("resultCount");
const copyAllIds = document.getElementById("copyAllIds");
const limitToPageCheckbox = document.getElementById("limitToPage");
const pageVideoCount = document.getElementById("pageVideoCount");

// ====================== STATE ======================
let availableCodes = new Set();
let currentTheme = "light";
let currentResults = [];
let toastTimer = null;
let defaultSimilarId = null; // Auto-detected video ID for prompt()

// ====================== INITIALIZATION ======================
document.addEventListener("DOMContentLoaded", async () => {
  await loadTheme();
  await loadAvailableCodes();
  queryInput.focus();
  setupEventListeners();
  updateSliderVisuals();
  await updatePageVideoIds();
  await detectDefaultSimilarId();
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
  showToast(
    `${currentTheme === "dark" ? "🌙" : "☀️"} ${currentTheme} mode`,
    "success",
  );
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
  themeToggle.addEventListener("click", toggleTheme);
  clearQueryBtn.addEventListener("click", () => {
    queryInput.value = "";
    queryInput.focus();
  });
  diversityFactorInput.addEventListener("input", () => {
    diversityValueSpan.textContent = diversityFactorInput.value;
    updateSliderVisuals();
  });
  smartSearchBtn.addEventListener("click", () => performSmartSearch());
  findSimilarBtn.addEventListener("click", () => {
    const defaultId = defaultSimilarId || "";
    const videoId = prompt("Enter Video ID to find similar videos:", defaultId);
    if (videoId) performFindSimilar(videoId);
  });
  copyAllIds.addEventListener("click", copyAllVideoIds);
  queryInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") performSmartSearch();
  });
  limitToPageCheckbox.addEventListener("change", () => {
    updatePageVideoCount();
  });
}

// ====================== SLIDER VISUALS ======================
function updateSliderVisuals() {
  const progress =
    (diversityFactorInput.value / diversityFactorInput.max) * 100;
  diversityFactorInput.style.setProperty("--progress", `${progress}%`);
}

// ====================== PAGE-LIMIT MODE ======================
let pageVideoIds = [];

/**
 * Fetch video IDs currently visible on the page from the content script.
 * Updates pageVideoIds and refreshes the count display.
 */
async function updatePageVideoIds() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) return;

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "getPageVideoIds",
    });
    if (response?.videoIds) {
      pageVideoIds = response.videoIds;
      console.log(`[POPUP] 📄 Got ${pageVideoIds.length} video IDs from page`);
      updatePageVideoCount();
    }
  } catch (err) {
    console.log("[POPUP] ⚠️ Could not fetch page video IDs:", err.message);
    pageVideoIds = [];
    updatePageVideoCount();
  }
}

function updatePageVideoCount() {
  if (limitToPageCheckbox.checked) {
    pageVideoCount.style.display = "block";
    pageVideoCount.textContent = `Found ${pageVideoIds.length} videos on this page`;
  } else {
    pageVideoCount.style.display = "none";
  }
}

async function detectDefaultSimilarId() {
  console.log("[POPUP] 🔍 Detecting default similar video ID...");
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab || !tab.url) {
      console.log("[POPUP] ⚠️ No active tab URL found");
      return;
    }

    // Uses the shared function from utils.js — returns the DB hashed ID
    const dbId = detectDbIdFromUrl(tab.url);

    if (dbId) {
      defaultSimilarId = dbId;
      console.log(`[POPUP] 🎯 Default similar DB ID set: "${dbId}"`);
    } else {
      defaultSimilarId = null;
      console.log("[POPUP] ⚠️ No DB ID detected on current page");
    }
  } catch (err) {
    console.log("[POPUP] ⚠️ Could not detect video ID:", err.message);
    defaultSimilarId = null;
  }
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
      currentResults = response.results || [];
      displayResults(currentResults, "Smart Search");
      showToast(`Found ${currentResults.length} results`, "success");
    } else {
      showToast(response.error || "Smart search failed", "error");
    }
  } catch (err) {
    showToast(`Smart search error: ${err.message}`, "error");
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
      currentResults = response.results || [];
      displayResults(currentResults, `Similar to ${videoId}`);
      showToast(`Found ${currentResults.length} similar videos`, "success");
    } else {
      showToast(response.error || "Find similar failed", "error");
    }
  } catch (err) {
    showToast(`Find similar error: ${err.message}`, "error");
  } finally {
    showLoading(false);
  }
}

// ====================== HELPERS ======================
function buildSearchParams() {
  const episodeRange = getEpisodeRange();
  const params = {
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

  // Add limit_to_ids if toggle is enabled
  if (limitToPageCheckbox.checked && pageVideoIds.length > 0) {
    params.limitToIds = pageVideoIds;
  }

  return params;
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

// ====================== DISPLAY RESULTS ======================
function displayResults(results, title) {
  updateResultBadge(results.length);
  if (!results.length) {
    resultsContainer.innerHTML = `
      <div class="empty-results">
        <div class="empty-icon"><i class="fas fa-search"></i></div>
        <p class="empty-title">No results found</p>
        <p class="empty-subtitle">Try adjusting your search query or filters</p>
      </div>
    `;
    return;
  }
  let html = '<div class="results-grid">';
  results.forEach((result, index) => {
    const metadata = result.metadata || {};
    const videoId = metadata.video_id || metadata.videoId || "N/A";
    const code = metadata.code || "";
    const episode = metadata.episode || "";
    const text = metadata.text || "No title";
    const score = result.score ? (result.score * 100).toFixed(0) : null;
    const thumbnail = getThumbnailUrl(metadata);
    html += `
      <div class="result-card" data-video-id="${escapeHtml(videoId)}" title="Click to copy ID: ${escapeHtml(videoId)}">
        <div class="result-thumbnail">
          ${
            thumbnail
              ? `<img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(text)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'no-thumb\\'><i class=\\'fas fa-image\\'></i></div>'" />`
              : `<div class="no-thumb"><i class="fas fa-image"></i></div>`
          }
        </div>
        <div class="result-content">
          <div class="result-title" title="${escapeHtml(text)}">${escapeHtml(text)}</div>
          <div class="result-meta">
            ${code ? `<span class="meta-tag code"><i class="fas fa-tag"></i> ${escapeHtml(code)}</span>` : ""}
            ${episode ? `<span class="meta-tag episode"><i class="fas fa-hashtag"></i> ${escapeHtml(episode)}</span>` : ""}
            ${score !== null ? `<span class="meta-tag score"><i class="fas fa-star"></i> ${score}%</span>` : ""}
            <span class="meta-tag rank">#${index + 1}</span>
          </div>
        </div>
      </div>
    `;
  });
  html += "</div>";
  resultsContainer.innerHTML = html;

  // Click handler: copy video ID
  resultsContainer.querySelectorAll(".result-card").forEach((card) => {
    card.addEventListener("click", () => {
      const videoId = card.getAttribute("data-video-id");
      navigator.clipboard
        .writeText(videoId)
        .then(() => {
          showToast(`📋 Copied: ${videoId}`, "success");
        })
        .catch(() => {
          showToast(`ID: ${videoId}`, "success");
        });
    });
  });
}

/**
 * Extract the best available thumbnail URL from result metadata.
 * Checks thumbnail field first, then falls back to preview (video).
 */
function getThumbnailUrl(metadata) {
  if (!metadata) return null;
  // Check thumbnail field
  if (metadata.thumbnail && isValidHttpUrl(metadata.thumbnail)) {
    return metadata.thumbnail;
  }
  // Fallback: preview video (less ideal but better than nothing)
  if (metadata.preview && isValidHttpUrl(metadata.preview)) {
    return metadata.preview;
  }
  return null;
}

/**
 * Validate that a URL is a real HTTP(S) URL, not base64/blob/javascript.
 */
function isValidHttpUrl(str) {
  if (!str || typeof str !== "string") return false;
  return /^https?:\/\//i.test(str.trim());
}

function updateResultBadge(count) {
  if (count > 0) {
    resultCount.textContent = `${count} result${count !== 1 ? "s" : ""}`;
    resultCount.classList.remove("hidden");
  } else {
    resultCount.classList.add("hidden");
  }
}

async function copyAllVideoIds() {
  if (!currentResults.length) {
    showToast("No results to copy", "error");
    return;
  }
  const ids = currentResults
    .map((r) => (r.metadata || {}).video_id || r.metadata?.videoId || "")
    .filter(Boolean);
  if (!ids.length) {
    showToast("No video IDs found", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(ids.join("\n"));
    showToast(`📋 Copied ${ids.length} video IDs`, "success");
  } catch {
    showToast("Failed to copy IDs", "error");
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showLoading(show) {
  loadingOverlay.classList.toggle("hidden", !show);
}

function showToast(message, type = "info") {
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}
