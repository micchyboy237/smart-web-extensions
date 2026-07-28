// ====================== STATE ======================
let availableCodes = new Set();
let currentTheme = "light";
let currentResults = [];
let toastTimer = null;
let defaultSimilarId = null;
let favorites = new Set();
let lastSearchParams = null;
let hoverPreviewTimers = new Map();
let openTabUrls = new Set(); // Store URLs of currently open tabs

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
const enableDiversityCheckbox = document.getElementById("enableDiversity");
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
const excludeOpenTabsCheckbox = document.getElementById("excludeOpenTabs");

// ====================== SOURCE TAB (extended-page mode) ======================
const urlParams = new URLSearchParams(window.location.search);
const sourceTabId = urlParams.get("tabId")
  ? parseInt(urlParams.get("tabId"), 10)
  : null;
console.log("[POPUP] 🪟 Extended page mode. sourceTabId:", sourceTabId);

async function getSourceTab() {
  if (sourceTabId !== null) {
    try {
      return await chrome.tabs.get(sourceTabId);
    } catch (err) {
      console.warn("[POPUP] ⚠️ Source tab gone:", err.message);
      return null;
    }
  }
  // Legacy fallback if popup.html is ever opened without ?tabId (e.g. manual dev testing)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ====================== OPEN TABS MANAGEMENT ======================
async function refreshOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://missav.ws/*" });
    openTabUrls.clear();
    tabs.forEach((tab) => {
      if (tab.url) openTabUrls.add(tab.url);
    });
    console.log(`[POPUP] 🪟 Refreshed ${openTabUrls.size} open MissAV tabs`);
  } catch (err) {
    console.error("[POPUP] ⚠️ Failed to query tabs:", err);
  }
}

function isUrlOpen(url) {
  if (!url) return false;
  // Normalize URL by removing hash/fragments for comparison
  const cleanUrl = url.split("#")[0];
  return openTabUrls.has(cleanUrl) || openTabUrls.has(url);
}

// ====================== DIVERSITY MAPPING ======================
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
  limitToPageCheckbox.addEventListener("change", async () => {
    await updatePageVideoIds(); // Fetch fresh video IDs from active tab
    updatePageVideoCount(); // Then update the display
  });

  limitToPageCheckbox.addEventListener("change", async () => {
    await updatePageVideoIds();
    updatePageVideoCount();
  });

  excludeOpenTabsCheckbox.addEventListener("change", () => {
    refreshOpenTabs(); // Ensure we have the latest tab list
    if (currentResults.length > 0) {
      displayResults(currentResults, "Filtered Results"); // Re-display with filtering
    }
  });

  // Auto-save state on form changes
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
    enableDiversityCheckbox,
    limitToPageCheckbox,
    excludeOpenTabsCheckbox,
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

  // **UI/UX addition** — a way to jump back to the MissAV tab, since the viewer is now a standalone window. Add a handler:
  const focusSourceTabBtn = document.getElementById("focusSourceTab");
  focusSourceTabBtn?.addEventListener("click", async () => {
    const tab = await getSourceTab();
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      showToast("Source tab was closed", "error");
    }
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
    const tab = await getSourceTab();
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
    const tab = await getSourceTab();
    if (!tab || !tab.url) {
      console.log("[POPUP] ⚠️ No source tab URL found");
      return;
    }
    const dbId = detectDbIdFromUrl(tab.url);
    defaultSimilarId = dbId || null;
    console.log(
      dbId
        ? `[POPUP] 🎯 Default similar DB ID: "${dbId}"`
        : "[POPUP] ⚠️ No DB ID on source tab",
    );
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
  await executeSearch({ action: "smartSearch", params }, "Smart Search");
}

async function performFindSimilar(videoId) {
  const options = {
    topK: parseInt(topKInput.value) || 10,
    autoShuffle: autoShuffleCheckbox.checked,
    enableDiversity: enableDiversityCheckbox.checked,
    diversity: sliderToDiversityEnum(parseFloat(diversityFactorInput.value)),
  };

  // Pass candidate_ids if "Limit to Current Page" is enabled
  if (limitToPageCheckbox.checked && pageVideoIds.length > 0) {
    options.limitToIds = pageVideoIds;
    console.log(
      `[POPUP] 📄 FindSimilar: limiting to ${pageVideoIds.length} page videos`,
      pageVideoIds.slice(0, 5),
    );
  } else if (limitToPageCheckbox.checked && pageVideoIds.length === 0) {
    console.warn(
      "[POPUP] ⚠️ FindSimilar: limitToPage is ON but pageVideoIds is empty — no filtering applied",
    );
  }

  // Add excludeIds from open tabs
  if (excludeOpenTabsCheckbox.checked) {
    const excludeIdsFromTabs = Array.from(openTabUrls)
      .map((url) => {
        const info = extractJavInfo(url, null);
        return info.videoId;
      })
      .filter(Boolean);

    // Ensure we don't exclude the video we are searching for itself
    options.excludeIds = excludeIdsFromTabs.filter((id) => id !== videoId);
    console.log(
      `[POPUP] 🪟 FindSimilar: excluding ${options.excludeIds.length} open tab IDs`,
    );
  }

  console.log("[POPUP] 🔍 FindSimilar options:", options);
  await executeSearch(
    { action: "findSimilar", params: { videoId, options } },
    `Similar to ${videoId}`,
  );
}

async function refreshLastSearch() {
  if (!lastSearchParams) {
    showToast("No previous search to refresh", "error");
    return;
  }

  console.log(
    `[POPUP] 🔄 Refreshing last ${lastSearchParams.action} with auto_shuffle...`,
  );

  if (lastSearchParams.action === "findSimilar") {
    const refreshParams = {
      ...lastSearchParams.params,
      options: {
        ...lastSearchParams.params.options,
        autoShuffle: true,
      },
    };
    await executeSearch(
      { action: "findSimilar", params: refreshParams },
      `Similar to ${refreshParams.videoId} (refreshed)`,
    );
  } else {
    const refreshParams = {
      ...lastSearchParams.params,
      autoShuffle: true,
    };
    await executeSearch(
      { action: "smartSearch", params: refreshParams },
      "Smart Search (refreshed)",
    );
  }
}

async function executeSearch(actionParams, label) {
  // Clear previous results immediately
  currentResults = [];
  showLoading(true);

  try {
    const response = await chrome.runtime.sendMessage(actionParams);

    if (response.success) {
      currentResults = response.results || [];
      displayResults(currentResults, label);
      const seedInfo = response.shuffle_seed
        ? ` (seed: ${response.shuffle_seed})`
        : "";
      showToast(`Found ${currentResults.length} results${seedInfo}`, "success");

      // Save for refresh — only on success
      lastSearchParams = actionParams;
    } else {
      lastSearchParams = null;
      showToast(response.error || "Search failed", "error");
    }
  } catch (err) {
    lastSearchParams = null;
    showToast(`Search error: ${err.message}`, "error");
  } finally {
    showLoading(false);
    // Persist state after results are displayed
    setTimeout(() => {
      PopupState.save({
        formRefs: getFormRefs(),
        currentResults,
        lastSearchParams,
      });
    }, 0);
  }
}

// ====================== HELPERS ======================
function buildSearchParams() {
  const episodeRange = getEpisodeRange();
  const diversityValue = parseFloat(diversityFactorInput.value);

  // Extract video IDs from open tabs to exclude them on the server side
  let excludeIdsFromTabs = [];
  if (excludeOpenTabsCheckbox.checked) {
    // We need to map the open URLs back to their video IDs.
    // Since we only have URLs in openTabUrls, we'll rely on the server's
    // ability to handle URL-based exclusion or convert them if possible.
    // However, the server expects video_id (e.g., "mxgs-893").

    // For now, we will keep the client-side filtering as the primary method
    // because mapping arbitrary MissAV URLs back to IDs reliably in the popup
    // without a DB lookup is complex.

    // BUT, if we want to send them, we can try to extract IDs from the URLs:
    excludeIdsFromTabs = Array.from(openTabUrls)
      .map((url) => {
        const info = extractJavInfo(url, null);
        return info.videoId;
      })
      .filter(Boolean);

    console.log(
      `[POPUP] 🪟 Excluding ${excludeIdsFromTabs.length} video IDs from open tabs`,
    );
  }

  const params = {
    query: queryInput.value.trim(),
    topK: parseInt(topKInput.value) || 20,
    includeCodes: getSelectedOptions(includeCodesSelect),
    excludeCodes: getSelectedOptions(excludeCodesSelect),
    includeEpisodes: [],
    episodeRange: episodeRange,
    // Merge existing excludeIds with tab IDs
    excludeIds: [...excludeIdsFromTabs],
    enableDiversity: enableDiversityCheckbox.checked,
    diversity: sliderToDiversityEnum(diversityValue),
    maxPerCode: maxPerCodeInput.value ? parseInt(maxPerCodeInput.value) : null,
    searchType: searchTypeSelect.value,
    autoShuffle: autoShuffleCheckbox.checked,
  };

  // Add candidate_ids if toggle is enabled
  console.log("[POPUP] 📦 Building search params");
  console.log("  limitToPage checked:", limitToPageCheckbox.checked);
  console.log("  pageVideoIds length:", pageVideoIds.length);
  if (limitToPageCheckbox.checked && pageVideoIds.length > 0) {
    params.limitToIds = pageVideoIds;
    console.log(`  ✅ Adding ${pageVideoIds.length} candidate IDs to payload`);
  } else if (limitToPageCheckbox.checked) {
    console.warn("  ⚠️ Toggle is ON but no video IDs available");
  }

  console.log("[POPUP] 📦 Final params:", params);
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
  hoverPreviewTimers.forEach((timer) => clearTimeout(timer));
  hoverPreviewTimers.clear();

  // Filter out open tabs if the toggle is checked
  let filteredResults = results;
  if (excludeOpenTabsCheckbox.checked) {
    filteredResults = results.filter((r) => !isUrlOpen(r.metadata?.url));
    console.log(
      `[POPUP] 🪟 Excluded ${results.length - filteredResults.length} open tabs`,
    );
  }

  updateResultBadge(filteredResults.length);

  if (!filteredResults.length) {
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
  filteredResults.forEach((result, index) => {
    const metadata = result.metadata || {};
    const videoId = metadata.video_id || metadata.videoId || "N/A";
    const code = metadata.code || "";
    const episode = metadata.episode || "";
    const text = metadata.text || "No title";
    const score = result.score != null ? (result.score * 100).toFixed(0) : null;
    const thumbnail = getThumbnailUrl(metadata);
    const previewUrl = getPreviewUrl(metadata);
    const isFav = favorites.has(videoId);
    const isOpen = isUrlOpen(metadata.url); // Check if this specific result is open

    const favIconClass = isFav ? "fas fa-heart" : "far fa-heart";
    const favActiveClass = isFav ? " active" : "";

    html += `
      <div class="result-card" data-video-id="${escapeHtml(videoId)}" data-url="${escapeHtml(metadata.url || "")}">
        ${isOpen ? `<div class="open-tab-badge"><i class="fas fa-external-link-alt"></i> Open</div>` : ""}
        <button class="fav-btn${favActiveClass}" data-video-id="${escapeHtml(videoId)}" title="${isFav ? "Remove from favorites" : "Add to favorites"}">
          <i class="${favIconClass}"></i>
        </button>
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

  // Attach event listeners
  resultsContainer.querySelectorAll(".result-card").forEach((card) => {
    const videoId = card.getAttribute("data-video-id");
    const url = card.getAttribute("data-url");

    // Click on card → open URL in new tab
    card.addEventListener("click", (e) => {
      if (e.target.closest(".fav-btn")) return;
      if (url && url.startsWith("http")) {
        console.log(`[POPUP] 🔗 Opening in new tab: ${url}`);
        chrome.tabs.create({ url, active: false });
      } else {
        const fallbackUrl = `https://missav.ws/en/${videoId}`;
        console.log(`[POPUP] 🔗 Opening fallback URL: ${fallbackUrl}`);
        chrome.tabs.create({ url: fallbackUrl, active: false });
      }
    });

    // Hover → preview video
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

    // Favorite button click
    const favBtn = card.querySelector(".fav-btn");
    if (favBtn) {
      favBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(videoId);
      });
    }
  });
}

function startPreview(thumbnailDiv, previewOverlay, videoId) {
  const previewUrl = thumbnailDiv.getAttribute("data-preview");
  if (!previewUrl) return;

  if (hoverPreviewTimers.has(videoId)) {
    clearTimeout(hoverPreviewTimers.get(videoId));
  }

  const timer = setTimeout(() => {
    let videoEl = previewOverlay.querySelector("video");
    if (!videoEl) {
      videoEl = document.createElement("video");
      videoEl.muted = true;
      videoEl.loop = true;
      videoEl.playsInline = true;
      videoEl.setAttribute("playsinline", "");
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

function stopPreview(thumbnailDiv, previewOverlay, videoId) {
  if (hoverPreviewTimers.has(videoId)) {
    clearTimeout(hoverPreviewTimers.get(videoId));
    hoverPreviewTimers.delete(videoId);
  }

  const videoEl = previewOverlay.querySelector("video");
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load();
    videoEl.remove();
  }

  const playIcon = previewOverlay.querySelector(".play-icon");
  if (playIcon) playIcon.style.display = "flex";
}

function getThumbnailUrl(metadata) {
  if (!metadata) return null;
  if (metadata.thumbnail && isValidHttpUrl(metadata.thumbnail)) {
    return metadata.thumbnail;
  }
  return null;
}

function getPreviewUrl(metadata) {
  if (!metadata) return null;
  if (metadata.preview && isValidHttpUrl(metadata.preview)) {
    return metadata.preview;
  }
  return null;
}

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
    enableDiversity: enableDiversityCheckbox,
    limitToPage: limitToPageCheckbox,
    excludeOpenTabs: excludeOpenTabsCheckbox,
  };
}

// ====================== INITIALIZATION ======================
document.addEventListener("DOMContentLoaded", async () => {
  await PopupState.init(sourceTabId);
  await loadTheme();
  await loadFavorites();
  await loadAvailableCodes();
  await refreshOpenTabs();

  const formRefs = getFormRefs();
  const saved = await PopupState.load({ formRefs });
  if (saved) {
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
    queryInput.focus();
    console.log("[POPUP] 🆕 Fresh popup open (no saved state)");
  }

  setupEventListeners();
  updateSliderVisuals();
  await updatePageVideoIds();
  await detectDefaultSimilarId();
  console.log("[POPUP] ✅ Initialization complete");
});
