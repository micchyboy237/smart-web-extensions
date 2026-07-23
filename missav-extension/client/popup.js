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
const autoShuffleCheckbox = document.getElementById("autoShuffle");
const smartSearchBtn = document.getElementById("smartSearchBtn");
const findSimilarBtn = document.getElementById("findSimilarBtn");
const refreshResultsBtn = document.getElementById("refreshResults");
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
let favorites = new Set(); // Client-side favorites (stored in chrome.storage.local)
let lastSearchParams = null; // Cache for refresh button
let hoverPreviewTimers = new Map(); // Track preview video timers per card

// ====================== DIVERSITY MAPPING ======================
/**
 * Maps the 0-1 slider value to server's diversity enum.
 *   0.0 - 0.2  → "low"
 *   0.3 - 0.7  → "medium"
 *   0.8 - 1.0  → "high"
 */
function sliderToDiversityEnum(value) {
  if (value <= 0.2) return "low";
  if (value <= 0.7) return "medium";
  return "high";
}

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
  refreshResultsBtn.addEventListener("click", () => refreshLastSearch());
  copyAllIds.addEventListener("click", copyAllVideoIds);
  queryInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") performSmartSearch();
  });
  limitToPageCheckbox.addEventListener("change", () => {
    updatePageVideoCount();
  });

  // ====================== AUTO-SAVE STATE ON FORM CHANGES ======================
  const formElements = [
    queryInput,
    topKInput,
    searchTypeSelect,
    includeCodesSelect,
    excludeCodesSelect,
    includeCodesFilter,
    excludeCodesFilter,
    episodeMinInput,
    episodeMaxInput,
    diversityFactorInput,
    maxPerCodeInput,
    autoShuffleCheckbox,
    limitToPageCheckbox,
  ];
  const formRefs = getFormRefs();

  formElements.forEach((el) => {
    if (!el) return;
    const eventType =
      el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(eventType, () => {
      PopupState.save({
        formRefs,
        currentResults,
        lastSearchParams,
      });
    });
  });
}

// ====================== FAVORITES ======================
async function loadFavorites() {
  try {
    const { favIds } = await chrome.storage.local.get("favIds");
    favorites = new Set(favIds || []);
    console.log(`[POPUP] ⭐ Loaded ${favorites.size} favorites`);
  } catch (err) {
    console.error("[POPUP] Failed to load favorites:", err);
    favorites = new Set();
  }
}
async function saveFavorites() {
  try {
    await chrome.storage.local.set({ favIds: Array.from(favorites) });
    console.log(`[POPUP] ⭐ Saved ${favorites.size} favorites`);
  } catch (err) {
    console.error("[POPUP] Failed to save favorites:", err);
  }
}
function toggleFavorite(videoId) {
  if (favorites.has(videoId)) {
    favorites.delete(videoId);
  } else {
    favorites.add(videoId);
  }
  saveFavorites();
  // Update heart icon in the DOM
  const card = document.querySelector(
    `.result-card[data-video-id="${CSS.escape(videoId)}"]`,
  );
  if (card) {
    const favBtn = card.querySelector(".fav-btn");
    if (favBtn) {
      favBtn.classList.toggle("active", favorites.has(videoId));
      favBtn.querySelector("i").className = favorites.has(videoId)
        ? "fas fa-heart"
        : "far fa-heart";
    }
  }
  console.log(
    `[POPUP] ⭐ Favorite toggled: ${videoId} → ${favorites.has(videoId)}`,
  );
}

// ====================== SLIDER VISUALS ======================
function updateSliderVisuals() {
  const progress =
    (diversityFactorInput.value / diversityFactorInput.max) * 100;
  diversityFactorInput.style.setProperty("--progress", `${progress}%`);
}

// ====================== PAGE-LIMIT MODE ======================
let pageVideoIds = [];
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
  lastSearchParams = params; // Cache for refresh
  await executeSearch(params, "Smart Search");
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
async function refreshLastSearch() {
  if (!lastSearchParams) {
    showToast("No previous search to refresh", "error");
    return;
  }
  console.log("[POPUP] 🔄 Refreshing last search with auto_shuffle...");
  // Force auto_shuffle on refresh for fresh ordering
  const refreshParams = { ...lastSearchParams, autoShuffle: true };
  await executeSearch(refreshParams, "Smart Search (refreshed)");
}
async function executeSearch(params, label) {
  // Clear previous results immediately
  currentResults = [];
  lastSearchParams = null;
  await PopupState.save({
    formRefs: getFormRefs(),
    currentResults: [],
    lastSearchParams: null,
  });

  showLoading(true);
  try {
    const response = await chrome.runtime.sendMessage({
      action: "smartSearch",
      params,
    });
    if (response.success) {
      currentResults = response.results || [];
      displayResults(currentResults, label);
      const seedInfo = response.shuffle_seed
        ? ` (seed: ${response.shuffle_seed})`
        : "";
      showToast(`Found ${currentResults.length} results${seedInfo}`, "success");
    } else {
      showToast(response.error || "Smart search failed", "error");
    }
  } catch (err) {
    showToast(`Smart search error: ${err.message}`, "error");
  } finally {
    showLoading(false);
  }
}

// ====================== HELPERS ======================
function buildSearchParams() {
  const episodeRange = getEpisodeRange();
  const diversityValue = parseFloat(diversityFactorInput.value);
  const params = {
    query: queryInput.value.trim(),
    topK: parseInt(topKInput.value) || 20,
    includeCodes: getSelectedOptions(includeCodesSelect),
    excludeCodes: getSelectedOptions(excludeCodesSelect),
    includeEpisodes: [],
    episodeRange: episodeRange,
    excludeIds: [],
    // NEW: diversity is now a string enum ("low"/"medium"/"high")
    diversity: sliderToDiversityEnum(diversityValue),
    maxPerCode: maxPerCodeInput.value ? parseInt(maxPerCodeInput.value) : null,
    searchType: searchTypeSelect.value,
    // NEW: auto_shuffle flag
    autoShuffle: autoShuffleCheckbox.checked,
  };
  // Add limit_to_ids if toggle is enabled
  if (limitToPageCheckbox.checked && pageVideoIds.length > 0) {
    params.limitToIds = pageVideoIds;
  }
  console.log("[POPUP] 📦 Search params:", params);
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
  // Clean up any lingering preview timers
  hoverPreviewTimers.forEach((timer) => clearTimeout(timer));
  hoverPreviewTimers.clear();

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
    // Score is now 0-1 from server, convert to percentage for display
    const score = result.score != null ? (result.score * 100).toFixed(0) : null;
    const thumbnail = getThumbnailUrl(metadata);
    const previewUrl = getPreviewUrl(metadata);
    const isFav = favorites.has(videoId);
    const favIconClass = isFav ? "fas fa-heart" : "far fa-heart";
    const favActiveClass = isFav ? " active" : "";

    html += `
      <div class="result-card" data-video-id="${escapeHtml(videoId)}" data-url="${escapeHtml(metadata.url || "")}">
        <!-- Favorite button -->
        <button class="fav-btn${favActiveClass}" data-video-id="${escapeHtml(videoId)}" title="${isFav ? "Remove from favorites" : "Add to favorites"}">
          <i class="${favIconClass}"></i>
        </button>
        <!-- Thumbnail with preview overlay -->
        <div class="result-thumbnail" data-preview="${escapeHtml(previewUrl || "")}">
          ${
            thumbnail
              ? `<img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(text)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
                 <div class="no-thumb" style="display:none;"><i class="fas fa-image"></i></div>`
              : `<div class="no-thumb"><i class="fas fa-image"></i></div>`
          }
          <div class="preview-overlay">
            <span class="play-icon"><i class="fas fa-play-circle"></i></span>
          </div>
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

  // --- Attach event listeners ---
  resultsContainer.querySelectorAll(".result-card").forEach((card) => {
    const videoId = card.getAttribute("data-video-id");
    const url = card.getAttribute("data-url");

    // 1) Click on card → open URL in new tab
    card.addEventListener("click", (e) => {
      // Don't open if clicking the fav button
      if (e.target.closest(".fav-btn")) return;
      if (url && url.startsWith("http")) {
        console.log(`[POPUP] 🔗 Opening in new tab: ${url}`);
        chrome.tabs.create({ url, active: false });
      } else {
        // Fallback: construct MissAV URL from videoId
        const fallbackUrl = `https://missav.ws/en/${videoId}`;
        console.log(`[POPUP] 🔗 Opening fallback URL: ${fallbackUrl}`);
        chrome.tabs.create({ url: fallbackUrl, active: false });
      }
    });

    // 2) Hover → preview video
    const thumbnailDiv = card.querySelector(".result-thumbnail");
    const previewOverlay = thumbnailDiv?.querySelector(".preview-overlay");
    if (thumbnailDiv && previewOverlay) {
      card.addEventListener("mouseenter", () => {
        startPreview(thumbnailDiv, previewOverlay, videoId);
      });
      card.addEventListener("mouseleave", () => {
        stopPreview(thumbnailDiv, previewOverlay, videoId);
      });
    }

    // 3) Favorite button click
    const favBtn = card.querySelector(".fav-btn");
    if (favBtn) {
      favBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // Don't trigger card click
        toggleFavorite(videoId);
      });
    }
  });

  // --- Auto-save state after displaying results ---
  setTimeout(() => {
    PopupState.save({
      formRefs: getFormRefs(),
      currentResults,
      lastSearchParams,
    });
  }, 0);
}

/**
 * Start playing the preview video on hover (300ms delay to avoid flicker).
 */
function startPreview(thumbnailDiv, previewOverlay, videoId) {
  const previewUrl = thumbnailDiv.getAttribute("data-preview");
  if (!previewUrl) return;

  // Clear any existing timer for this card
  if (hoverPreviewTimers.has(videoId)) {
    clearTimeout(hoverPreviewTimers.get(videoId));
  }

  const timer = setTimeout(() => {
    // Check if video already exists
    let videoEl = previewOverlay.querySelector("video");
    if (!videoEl) {
      videoEl = document.createElement("video");
      videoEl.muted = true;
      videoEl.loop = true;
      videoEl.playsInline = true;
      videoEl.setAttribute("playsinline", "");
      // Hide the play icon when video loads
      const playIcon = previewOverlay.querySelector(".play-icon");
      videoEl.addEventListener("loadeddata", () => {
        if (playIcon) playIcon.style.display = "none";
      });
      videoEl.addEventListener("error", () => {
        console.log(`[POPUP] ⚠️ Preview video failed to load: ${previewUrl}`);
        if (playIcon) playIcon.style.display = "flex";
        videoEl.remove();
      });
      previewOverlay.appendChild(videoEl);
    }
    videoEl.src = previewUrl;
    videoEl.play().catch((err) => {
      console.log(`[POPUP] ⚠️ Preview play failed: ${err.message}`);
    });
    console.log(`[POPUP] ▶️ Preview started for: ${videoId}`);
  }, 300);

  hoverPreviewTimers.set(videoId, timer);
}

/**
 * Stop preview video and clean up.
 */
function stopPreview(thumbnailDiv, previewOverlay, videoId) {
  // Clear the pending timer
  if (hoverPreviewTimers.has(videoId)) {
    clearTimeout(hoverPreviewTimers.get(videoId));
    hoverPreviewTimers.delete(videoId);
  }

  const videoEl = previewOverlay.querySelector("video");
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load(); // Reset the video element
    videoEl.remove();
  }
  // Show play icon again
  const playIcon = previewOverlay.querySelector(".play-icon");
  if (playIcon) playIcon.style.display = "flex";
}

/**
 * Extract the best available thumbnail URL from result metadata.
 */
function getThumbnailUrl(metadata) {
  if (!metadata) return null;
  if (metadata.thumbnail && isValidHttpUrl(metadata.thumbnail)) {
    return metadata.thumbnail;
  }
  return null;
}

/**
 * Extract preview video URL from metadata.
 */
function getPreviewUrl(metadata) {
  if (!metadata) return null;
  if (metadata.preview && isValidHttpUrl(metadata.preview)) {
    return metadata.preview;
  }
  return null;
}

/**
 * Validate that a URL is a real HTTP(S) URL.
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

// ====================== FORM REFS (for state persistence) ======================
/**
 * Collect all form DOM references into one object.
 * Passed to PopupState.save() / .load() so state-persistence.js
 * never touches the DOM directly.
 */
function getFormRefs() {
  return {
    query: queryInput,
    topK: topKInput,
    searchType: searchTypeSelect,
    includeCodes: includeCodesSelect,
    excludeCodes: excludeCodesSelect,
    includeCodesFilter: includeCodesFilter,
    excludeCodesFilter: excludeCodesFilter,
    episodeMin: episodeMinInput,
    episodeMax: episodeMaxInput,
    diversityFactor: diversityFactorInput,
    maxPerCode: maxPerCodeInput,
    autoShuffle: autoShuffleCheckbox,
    limitToPage: limitToPageCheckbox,
  };
}

// ====================== INITIALIZATION ======================
document.addEventListener("DOMContentLoaded", async () => {
  // 1. Init persistence layer (detects tab ID)
  await PopupState.init();

  // 2. Load theme & favorites (lightweight, no dependencies)
  await loadTheme();
  await loadFavorites();

  // 3. Load available codes (populates multi-select <option>s)
  await loadAvailableCodes();

  // 4. Try to restore saved state (requires options to be populated first)
  const formRefs = getFormRefs();
  const saved = await PopupState.load({ formRefs });

  if (saved) {
    // State was restored — re-apply slider visuals + results
    if (diversityFactorInput.value) {
      diversityValueSpan.textContent = diversityFactorInput.value;
      updateSliderVisuals();
    }
    if (saved.results && saved.results.length > 0) {
      currentResults = saved.results;
      displayResults(currentResults, "Restored Results");
    }
    if (saved.lastSearchParams) {
      lastSearchParams = saved.lastSearchParams;
    }
    console.log("[POPUP] ✅ State restored from session storage");
  } else {
    // Fresh open — focus the query input
    queryInput.focus();
    console.log("[POPUP] 🆕 Fresh popup open (no saved state)");
  }

  // 5. Setup event listeners
  setupEventListeners();

  // 6. Update page-specific data
  updateSliderVisuals();
  await updatePageVideoIds();
  await detectDefaultSimilarId();

  console.log("[POPUP] ✅ Initialization complete");
});
