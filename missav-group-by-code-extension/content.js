/**
 * content.js - MissAV Group by Code Extension
 * Automatically activates on missav.ws pages with live updates
 */

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const DEFAULT_CONFIG = {
  minCount: 2,
  topN: 10,
  itemSelector: ".thumbnail.group",
  videoAnchorSelector: "a:has(video)",
  altAttr: "alt",
  titleSelector: 'a[x-text="item.full_title"], .my-2.text-sm a',
  containerId: "jav-group-by-code-panel",
  activeChipClass: "jav-chip-active",
  hiddenItemClass: "jav-grouped-hidden",
  highlightClass: "jav-grouped-highlight",
  mode: "group",
};

// SVG Icons
const ICONS = {
  group: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  flat: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  close: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  refresh: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================
let currentState = {
  groups: [],
  selectedCode: null,
  searchTerm: "",
  filters: [],
  mode: "group",
  config: null,
  isActive: false,
  lastItemCount: 0, // Track item count to detect significant changes
};

// Debounce timer for live updates
let updateTimer = null;

// ============================================================================
// CORE LOGIC: EXTRACTION & AGGREGATION
// ============================================================================
function extractCode(text) {
  if (!text) return null;
  const patterns = [
    /\b([a-z]+\d*-[a-z]+)-\d+(?:-[a-z0-9-]+)?\b/i,
    /\b([a-z0-9]+)-\d+(?:-[a-z0-9-]+)?\b/i,
    /\b([a-z]+)\d{3,6}\b/i,
    /\b(\d+[a-z]+)\d{3,6}\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function extractGroupedCodes(config) {
  const items = document.querySelectorAll(config.itemSelector);
  const codeMap = new Map();
  let skipped = 0;

  items.forEach((item) => {
    const videoAnchor = item.querySelector(config.videoAnchorSelector);
    if (!videoAnchor) {
      skipped++;
      return;
    }
    const rawAlt = videoAnchor.getAttribute(config.altAttr);
    const code = extractCode(rawAlt);
    if (!code) {
      skipped++;
      return;
    }
    if (!codeMap.has(code)) {
      codeMap.set(code, { code, count: 0, urls: [], elements: [] });
    }
    const entry = codeMap.get(code);
    entry.count++;
    entry.urls.push(videoAnchor.href || "");
    entry.elements.push(item);
  });

  const result = Array.from(codeMap.values())
    .filter((g) => g.count >= config.minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, config.topN);

  return { groups: result, totalItems: items.length };
}

// ============================================================================
// FILTERING LOGIC
// ============================================================================
function applyCombinedFilter(config) {
  const allItems = document.querySelectorAll(config.itemSelector);

  allItems.forEach((el) => {
    el.classList.remove(config.hiddenItemClass);
    el.classList.remove(config.highlightClass);
  });

  const { selectedCode, searchTerm, filters, mode, groups } = currentState;

  const hasActiveFilters =
    (mode === "group" && selectedCode !== null) ||
    (searchTerm && searchTerm.trim() !== "") ||
    filters.length > 0;

  if (!hasActiveFilters) {
    return;
  }

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const primaryRegex = searchTerm.trim()
    ? new RegExp(escapeRegex(searchTerm), "i")
    : null;
  const filterRegexes = filters
    .filter((f) => typeof f === "string" && f.trim() !== "")
    .map((f) => ({ term: f, regex: new RegExp(escapeRegex(f), "i") }));

  let elementsToShow = new Set();

  if (mode === "group" && selectedCode) {
    const group = groups.find((g) => g.code === selectedCode);
    if (group) {
      elementsToShow = new Set(group.elements);
    } else {
      // If group no longer exists (e.g. after update), show all
      allItems.forEach((el) => elementsToShow.add(el));
    }
  } else {
    allItems.forEach((el) => elementsToShow.add(el));
  }

  let highlightedCount = 0;
  let hiddenCount = 0;

  allItems.forEach((container) => {
    if (mode === "group" && selectedCode && !elementsToShow.has(container)) {
      container.classList.add(config.hiddenItemClass);
      hiddenCount++;
      return;
    }

    const titleEl = container.querySelector(config.titleSelector);
    const titleText = titleEl?.textContent?.trim() || "";

    if (primaryRegex && !primaryRegex.test(titleText)) {
      container.classList.add(config.hiddenItemClass);
      hiddenCount++;
      return;
    }

    const failedFilters = filterRegexes.filter(
      ({ regex }) => !regex.test(titleText),
    );
    if (failedFilters.length > 0) {
      container.classList.add(config.hiddenItemClass);
      hiddenCount++;
      return;
    }

    container.classList.add(config.highlightClass);
    highlightedCount++;
  });
}

function resetAll(config) {
  currentState.selectedCode = null;
  currentState.searchTerm = "";
  currentState.filters = [];

  const panel = document.getElementById(config.containerId);
  if (panel) {
    const searchInput = panel.querySelector(".jav-search-input");
    if (searchInput) searchInput.value = "";

    const filtersContainer = panel.querySelector(".jav-filters-container");
    if (filtersContainer) {
      const existingTags = filtersContainer.querySelectorAll(".jav-filter-tag");
      existingTags.forEach((tag) => tag.remove());
    }

    if (currentState.mode === "group") {
      const allChip = panel.querySelector(
        ".jav-chips-container .jav-chip:first-child",
      );
      if (allChip) setActiveChip(allChip, config);
    }
  }

  const allItems = document.querySelectorAll(config.itemSelector);
  allItems.forEach((el) => {
    el.classList.remove(config.hiddenItemClass);
    el.classList.remove(config.highlightClass);
  });
}

// ============================================================================
// UI RENDERING & HANDLERS
// ============================================================================
function setActiveChip(activeChip, config) {
  const panel = document.getElementById(config.containerId);
  if (!panel) return;

  panel.querySelectorAll(".jav-chip").forEach((c) => {
    c.classList.remove(config.activeChipClass);
  });

  if (activeChip) {
    activeChip.classList.add(config.activeChipClass);
  }
}

function handleSearchInput(event, config) {
  currentState.searchTerm = event.target.value;
  applyCombinedFilter(config);
}

function handleAddFilter(event, config) {
  if (event.key === "Enter" && event.target.value.trim()) {
    const newFilter = event.target.value.trim();
    if (!currentState.filters.includes(newFilter)) {
      currentState.filters.push(newFilter);
      renderFilters(config);
      applyCombinedFilter(config);
    }
    event.target.value = "";
  }
}

function removeFilter(filterTerm, config) {
  currentState.filters = currentState.filters.filter((f) => f !== filterTerm);
  renderFilters(config);
  applyCombinedFilter(config);
}

function renderFilters(config) {
  const panel = document.getElementById(config.containerId);
  if (!panel) return;

  const filtersContainer = panel.querySelector(".jav-filters-container");
  if (!filtersContainer) return;

  const existingTags = filtersContainer.querySelectorAll(".jav-filter-tag");
  existingTags.forEach((tag) => tag.remove());

  const inputField = filtersContainer.querySelector(".jav-add-filter-input");

  currentState.filters.forEach((filter) => {
    const tag = document.createElement("div");
    tag.className = "jav-filter-tag";
    tag.innerHTML = `
      <span>${filter}</span>
      <span class="jav-filter-remove">${ICONS.close}</span>
    `;
    tag.querySelector(".jav-filter-remove").addEventListener("click", () => {
      removeFilter(filter, config);
    });
    filtersContainer.insertBefore(tag, inputField);
  });
}

function handleModeToggle(mode, config) {
  currentState.mode = mode;
  currentState.selectedCode = null; // Reset to "All" when changing modes

  const panel = document.getElementById(config.containerId);
  if (!panel) return;

  panel.querySelectorAll(".jav-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  const chipsContainer = panel.querySelector(".jav-chips-container");
  const label = panel.querySelector(".jav-panel-label");

  if (chipsContainer)
    chipsContainer.style.display = mode === "group" ? "flex" : "none";
  if (label) label.style.display = mode === "group" ? "block" : "none";

  if (mode === "group") {
    // Pass null to ensure "All" is active on mode switch
    renderChips(panel, currentState.groups, config, null);
  }

  applyCombinedFilter(config);
}

function handleRefresh(config) {
  console.log("[GroupByCode] 🔄 Manual Refresh...");
  const { groups, totalItems } = extractGroupedCodes(config);
  if (groups.length > 0) {
    currentState.groups = groups;
    currentState.lastItemCount = totalItems;
    currentState.selectedCode = null;
    renderEnhancedPanel(groups, config);
  }
}

function renderChips(panel, groups, config, currentSelectedCode = null) {
  const existingChips = panel.querySelector(".jav-chips-container");
  if (existingChips) existingChips.remove();

  const existingLabel = panel.querySelector(".jav-panel-label");
  if (existingLabel) existingLabel.remove();

  const label = document.createElement("span");
  label.className = "jav-panel-label";
  label.textContent = "Filter by Code";
  panel.appendChild(label);

  const chipsContainer = document.createElement("div");
  chipsContainer.className = "jav-chips-container";

  // Determine if "All" should be active
  // "All" is active if currentSelectedCode is null OR if the selected code is not in the new groups
  const isAllActive =
    currentSelectedCode === null ||
    !groups.find((g) => g.code === currentSelectedCode);

  const allChip = document.createElement("span");
  // Apply active class if isAllActive is true
  allChip.className = `jav-chip ${isAllActive ? config.activeChipClass : ""}`;
  allChip.textContent = "All";
  allChip.addEventListener("click", () => {
    currentState.selectedCode = null;
    currentState.searchTerm = "";
    currentState.filters = [];

    const searchInput = panel.querySelector(".jav-search-input");
    if (searchInput) searchInput.value = "";

    const filtersContainer = panel.querySelector(".jav-filters-container");
    if (filtersContainer) {
      const tags = filtersContainer.querySelectorAll(".jav-filter-tag");
      tags.forEach((t) => t.remove());
    }

    setActiveChip(allChip, config);
    applyCombinedFilter(config);
  });
  chipsContainer.appendChild(allChip);

  groups.forEach((group) => {
    const chip = document.createElement("span");
    // Apply active class if this group matches the currentSelectedCode
    const isActive = group.code === currentSelectedCode;
    chip.className = `jav-chip ${isActive ? config.activeChipClass : ""}`;
    chip.textContent = `${group.code.toUpperCase()} (${group.count})`;
    chip.dataset.code = group.code;
    chip.addEventListener("click", () => {
      currentState.selectedCode = group.code;
      setActiveChip(chip, config);
      applyCombinedFilter(config);
    });
    chipsContainer.appendChild(chip);
  });

  panel.appendChild(chipsContainer);
}

function renderEnhancedPanel(groups, config) {
  const existing = document.getElementById(config.containerId);
  if (existing) existing.remove();

  currentState = {
    ...currentState,
    groups,
    selectedCode: null,
    isActive: true,
  };

  const panel = document.createElement("div");
  panel.id = config.containerId;

  // Header
  const header = document.createElement("div");
  header.className = "jav-panel-header";

  const modeToggle = document.createElement("div");
  modeToggle.className = "jav-mode-toggle";

  const groupBtn = document.createElement("button");
  groupBtn.className = `jav-mode-btn ${currentState.mode === "group" ? "active" : ""}`;
  groupBtn.dataset.mode = "group";
  groupBtn.innerHTML = ICONS.group;
  groupBtn.title = "Group by Code";
  groupBtn.addEventListener("click", () => handleModeToggle("group", config));

  const flatBtn = document.createElement("button");
  flatBtn.className = `jav-mode-btn ${currentState.mode === "flat" ? "active" : ""}`;
  flatBtn.dataset.mode = "flat";
  flatBtn.innerHTML = ICONS.flat;
  flatBtn.title = "Flat List";
  flatBtn.addEventListener("click", () => handleModeToggle("flat", config));

  modeToggle.appendChild(groupBtn);
  modeToggle.appendChild(flatBtn);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "jav-panel-toggle jav-refresh-btn";
  refreshBtn.innerHTML = ICONS.refresh;
  refreshBtn.title = "Refresh data";
  refreshBtn.addEventListener("click", () => handleRefresh(config));

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "jav-panel-toggle jav-collapse-btn";
  toggleBtn.textContent = "−";
  toggleBtn.title = "Collapse / Expand panel";
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isCollapsed = panel.classList.toggle("jav-panel-collapsed");
    toggleBtn.textContent = isCollapsed ? "+" : "−";
    toggleBtn.title = isCollapsed ? "Expand panel" : "Collapse panel";
  });

  header.appendChild(modeToggle);
  header.appendChild(refreshBtn);
  header.appendChild(toggleBtn);
  panel.appendChild(header);

  // Search Bar
  const searchContainer = document.createElement("div");
  searchContainer.className = "jav-search-container";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "jav-search-input";
  searchInput.placeholder = "Search titles...";
  searchInput.addEventListener("input", (e) => handleSearchInput(e, config));
  searchContainer.appendChild(searchInput);
  panel.appendChild(searchContainer);

  // Filters
  const filtersContainer = document.createElement("div");
  filtersContainer.className = "jav-filters-container";
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.className = "jav-add-filter-input";
  filterInput.placeholder = "+ Add filter (Enter)";
  filterInput.addEventListener("keydown", (e) => handleAddFilter(e, config));
  filtersContainer.appendChild(filterInput);
  panel.appendChild(filtersContainer);

  // Chips
  if (currentState.mode === "group") {
    renderChips(panel, groups, config);
  }

  document.body.appendChild(panel);
  applyCombinedFilter(config);
}

// ============================================================================
// LIVE UPDATE LOGIC
// ============================================================================
function checkForUpdates(config) {
  if (!currentState.isActive) return;

  const { groups, totalItems } = extractGroupedCodes(config);

  // Only update if item count changed significantly or groups are different
  const itemCountChanged =
    Math.abs(totalItems - currentState.lastItemCount) > 5;
  const hasNewGroups =
    groups.length !== currentState.groups.length ||
    JSON.stringify(groups.map((g) => g.code)) !==
      JSON.stringify(currentState.groups.map((g) => g.code));

  if (itemCountChanged || hasNewGroups) {
    console.log(
      `[GroupByCode] 📄 Content change detected. Items: ${currentState.lastItemCount} -> ${totalItems}`,
    );
    currentState.groups = groups;
    currentState.lastItemCount = totalItems;

    const panel = document.getElementById(config.containerId);
    if (panel && currentState.mode === "group") {
      // PASS the current selectedCode so the correct chip stays highlighted
      renderChips(panel, groups, config, currentState.selectedCode);

      // Re-apply filter to include new items in the current selection
      applyCombinedFilter(config);
    }
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================
function initExtension() {
  console.log("[GroupByCode] 🚀 Extension initializing on missav.ws");

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", activateExtension);
  } else {
    activateExtension();
  }
}

function activateExtension() {
  const config = { ...DEFAULT_CONFIG };
  currentState.config = config;

  const items = document.querySelectorAll(config.itemSelector);
  if (items.length === 0) {
    setTimeout(() => activateExtension(), 2000);
    return;
  }

  const { groups, totalItems } = extractGroupedCodes(config);
  if (groups.length > 0) {
    currentState.lastItemCount = totalItems;
    renderEnhancedPanel(groups, config);
    console.log("[GroupByCode] ✅ Extension activated!");
  } else {
    console.warn("[GroupByCode] ⚠️ No code groups found initially");
  }
}

// Auto-initialize
initExtension();

// Live Update Observer
const observer = new MutationObserver(() => {
  if (!currentState.isActive) {
    // If not active, check if we should start
    const items = document.querySelectorAll(DEFAULT_CONFIG.itemSelector);
    if (
      items.length > 0 &&
      !document.getElementById(DEFAULT_CONFIG.containerId)
    ) {
      clearTimeout(updateTimer);
      updateTimer = setTimeout(activateExtension, 1000);
    }
  } else {
    // If active, debounce updates
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => checkForUpdates(currentState.config), 1500);
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});
