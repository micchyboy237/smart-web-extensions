/**
 * groupByCode.js (Updated)
 * Groups MissAV search results by JAV code with enhanced filtering capabilities.
 * Features: search bar, dynamic multi-input filters, dual display modes (by group / flat list).
 *
 * Usage:
 *   groupByCode()
 *   groupByCode({ minCount: 3, topN: 5 })
 *   groupByCode.reset()
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
  mode: "group", // "group" or "flat"
};

// SVG Icons for mode toggle
const ICONS = {
  group: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  flat: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  close: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
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
};

// ============================================================================
// CORE LOGIC: EXTRACTION & AGGREGATION
// ============================================================================
/**
 * Lightweight JAV code extractor matching utils.js patterns.
 * @param {string} text - Raw alt text or URL
 * @returns {string|null} Normalized lowercase code or null
 */
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

/**
 * Scans DOM and extracts grouped code data.
 * @param {Object} config
 * @returns {Array<{code: string, count: number, urls: string[], elements: Element[]}>}
 */
function extractGroupedCodes(config) {
  console.log("[GroupByCode] 🔍 Extracting items...");
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

  console.log(
    `[GroupByCode] 📦 Found ${items.length} items, ${skipped} skipped, ${codeMap.size} unique codes`,
  );

  const result = Array.from(codeMap.values())
    .filter((g) => g.count >= config.minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, config.topN);

  console.log(
    `[GroupByCode] ✅ Top groups (min=${config.minCount}, topN=${config.topN}):`,
    result.map((g) => `${g.code}(${g.count})`).join(", "),
  );

  return result;
}

// ============================================================================
// FILTERING LOGIC: COMBINED GROUP + SEARCH + FILTERS
// ============================================================================
/**
 * Applies combined filtering: group selection + search term + AND filters.
 * Follows searchTerm.js pattern with regex-based matching.
 */
function applyCombinedFilter(config) {
  const allItems = document.querySelectorAll(config.itemSelector);

  // Cleanup: remove both hidden and highlight classes from ALL items
  allItems.forEach((el) => {
    el.classList.remove(config.hiddenItemClass);
    el.classList.remove(config.highlightClass);
  });

  const { selectedCode, searchTerm, filters, mode, groups } = currentState;

  // Reset mode: show everything unhighlighted
  if (!selectedCode && !searchTerm.trim() && filters.length === 0) {
    console.log("[GroupByCode] 🔄 Reset: showing all items, no highlights");
    return;
  }

  // Build filter logic
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const primaryRegex = searchTerm.trim()
    ? new RegExp(escapeRegex(searchTerm), "i")
    : null;
  const filterRegexes = filters
    .filter((f) => typeof f === "string" && f.trim() !== "")
    .map((f) => ({ term: f, regex: new RegExp(escapeRegex(f), "i") }));

  // Get elements to show based on mode
  let elementsToShow = new Set();

  if (mode === "group" && selectedCode) {
    const group = groups.find((g) => g.code === selectedCode);
    if (group) {
      elementsToShow = new Set(group.elements);
    }
  } else {
    // Flat mode or no group selected: start with all items
    allItems.forEach((el) => elementsToShow.add(el));
  }

  // Apply search and filter constraints
  let highlightedCount = 0;
  let hiddenCount = 0;

  allItems.forEach((container, index) => {
    // Check if item is in the allowed set (from group selection)
    if (mode === "group" && selectedCode && !elementsToShow.has(container)) {
      container.classList.add(config.hiddenItemClass);
      hiddenCount++;
      return;
    }

    // Get title text for search/filter matching
    const titleEl = container.querySelector(config.titleSelector);
    const titleText = titleEl?.textContent?.trim() || "";

    // Apply primary search term
    if (primaryRegex && !primaryRegex.test(titleText)) {
      container.classList.add(config.hiddenItemClass);
      hiddenCount++;
      return;
    }

    // Apply AND filters
    const failedFilters = filterRegexes.filter(
      ({ regex }) => !regex.test(titleText),
    );
    if (failedFilters.length > 0) {
      container.classList.add(config.hiddenItemClass);
      hiddenCount++;
      return;
    }

    // ✅ Passed all checks
    container.classList.add(config.highlightClass);
    highlightedCount++;
  });

  console.log(
    `[GroupByCode] 🔽 Filter applied: ✨ ${highlightedCount} highlighted, 🚫 ${hiddenCount} hidden | Mode: ${mode}, Code: ${selectedCode || "none"}, Search: "${searchTerm}", Filters: [${filters.join(", ")}]`,
  );
}

/**
 * Full reset: removes panel, styles, shows all items, clears highlights.
 */
function resetAll(config) {
  console.log("[GroupByCode] 🗑️ Full reset triggered");
  currentState = {
    groups: [],
    selectedCode: null,
    searchTerm: "",
    filters: [],
    mode: config.mode || "group",
    config: null,
  };

  const allItems = document.querySelectorAll(config.itemSelector);
  allItems.forEach((el) => {
    el.classList.remove(config.hiddenItemClass);
    el.classList.remove(config.highlightClass);
  });

  const panel = document.getElementById(config.containerId);
  if (panel) panel.remove();
  const style = document.getElementById("jav-group-by-code-style");
  if (style) style.remove();

  console.log("[GroupByCode] ✅ Reset complete");
}

// ============================================================================
// DOM MANIPULATION: FLOATING UI INJECTION
// ============================================================================
/**
 * Injects styles for floating panel, chips, search bar, highlights, and hidden items.
 */
function injectStyles(config) {
  if (document.getElementById("jav-group-by-code-style")) return;

  const style = document.createElement("style");
  style.id = "jav-group-by-code-style";
  style.textContent = `
    /* ── Floating Panel ─────────────────────────────────── */
    #${config.containerId} {
      position: fixed !important;
      top: 12px !important;
      right: 12px !important;
      z-index: 2147483647 !important;
      background: rgba(30, 30, 46, 0.97);
      backdrop-filter: blur(12px);
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      align-items: stretch;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      max-width: 90vw;
      max-height: 80vh;
      overflow-y: auto;
      font-family: system-ui, -apple-system, sans-serif;
      min-width: 280px;
    }
    
    #${config.containerId} .jav-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    
    #${config.containerId} .jav-panel-toggle {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #fbbf24;
      color: #1e1e2e;
      font-size: 14px;
      font-weight: bold;
      line-height: 22px;
      text-align: center;
      cursor: pointer;
      border: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      user-select: none;
      flex-shrink: 0;
    }
    
    #${config.containerId}.jav-panel-collapsed {
      padding: 0 !important; 
      gap: 0 !important;
      border: none !important; 
      background: transparent !important;
      backdrop-filter: none !important; 
      box-shadow: none !important;
      max-width: unset !important; 
      max-height: unset !important;
      overflow: visible !important;
      min-width: unset !important;
    }
    
    #${config.containerId}.jav-panel-collapsed > *:not(.jav-panel-toggle) {
      display: none !important;
    }
    
    #${config.containerId} .jav-mode-toggle {
      display: flex;
      gap: 4px;
      background: rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 2px;
    }
    
    #${config.containerId} .jav-mode-btn {
      padding: 4px 8px;
      border: none;
      background: transparent;
      color: #ccc;
      cursor: pointer;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }
    
    #${config.containerId} .jav-mode-btn:hover {
      background: rgba(255,255,255,0.15);
      color: #fff;
    }
    
    #${config.containerId} .jav-mode-btn.active {
      background: #fbbf24;
      color: #1e1e2e;
    }
    
    /* ── Search Bar ─────────────────────────────────────── */
    #${config.containerId} .jav-search-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    
    #${config.containerId} .jav-search-input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(255,255,255,0.08);
      color: #fff;
      font-size: 13px;
      outline: none;
      transition: all 0.15s ease;
    }
    
    #${config.containerId} .jav-search-input:focus {
      border-color: #fbbf24;
      background: rgba(255,255,255,0.12);
    }
    
    #${config.containerId} .jav-search-input::placeholder {
      color: rgba(255,255,255,0.4);
    }
    
    /* ── Filter Tags ────────────────────────────────────── */
    #${config.containerId} .jav-filters-container {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    
    #${config.containerId} .jav-filter-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    
    #${config.containerId} .jav-filter-remove {
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.15s ease;
      display: flex;
      align-items: center;
    }
    
    #${config.containerId} .jav-filter-remove:hover {
      opacity: 1;
    }
    
    #${config.containerId} .jav-add-filter-input {
      flex: 1;
      min-width: 100px;
      padding: 4px 8px;
      border: 1px dashed rgba(255,255,255,0.2);
      border-radius: 6px;
      background: transparent;
      color: #fff;
      font-size: 11px;
      outline: none;
    }
    
    #${config.containerId} .jav-add-filter-input:focus {
      border-color: #60a5fa;
      background: rgba(255,255,255,0.05);
    }
    
    #${config.containerId} .jav-add-filter-input::placeholder {
      color: rgba(255,255,255,0.3);
    }
    
    /* ── Group Chips ────────────────────────────────────── */
    #${config.containerId} .jav-panel-label {
      font-size: 11px; 
      font-weight: 700; 
      color: #fbbf24;
      text-transform: uppercase; 
      letter-spacing: 0.5px;
    }
    
    #${config.containerId} .jav-chips-container {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    
    #${config.containerId} .jav-chip {
      padding: 4px 12px; 
      border-radius: 999px;
      font-size: 12px; 
      font-weight: 600; 
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.08); 
      color: #ccc;
      transition: all 0.15s ease; 
      user-select: none; 
      white-space: nowrap;
    }
    
    #${config.containerId} .jav-chip:hover {
      background: rgba(255,255,255,0.18); 
      color: #fff;
    }
    
    #${config.containerId} .jav-chip.${config.activeChipClass} {
      background: #fbbf24; 
      color: #1e1e2e; 
      border-color: #fbbf24;
    }
    
    /* ── Highlight (modeled after searchTerm.js ACTIVE_CLASS) ── */
    .${config.highlightClass} {
      outline: 3px solid #fbbf24 !important;
      outline-offset: 2px;
      border-radius: 0.5rem;
      position: relative;
      transition: outline 0.15s ease, box-shadow 0.15s ease;
      box-shadow: 0 0 16px rgba(251, 191, 36, 0.25);
    }
    
    .${config.highlightClass}::after {
      content: '';
      position: absolute;
      inset: 0;
      background: rgba(251, 191, 36, 0.10);
      border-radius: inherit;
      pointer-events: none;
      z-index: 10;
    }
    
    /* ── Hidden Items ───────────────────────────────────── */
    .${config.hiddenItemClass} {
      display: none !important;
    }
  `;

  document.head.appendChild(style);
  console.log(
    "[GroupByCode] 🎨 Styles injected (panel + search + filters + highlight + hidden)",
  );
}

// ============================================================================
// UI RENDERING: PANEL WITH SEARCH, FILTERS, AND MODE TOGGLE
// ============================================================================
/**
 * Updates visual active state on chips (single-select).
 */
function setActiveChip(activeChip, config) {
  const panel = document.getElementById(config.containerId);
  if (!panel) return;
  panel
    .querySelectorAll(".jav-chip")
    .forEach((c) => c.classList.remove(config.activeChipClass));
  if (activeChip) {
    activeChip.classList.add(config.activeChipClass);
  }
}

/**
 * Handles search input changes.
 */
function handleSearchInput(event, config) {
  currentState.searchTerm = event.target.value;
  applyCombinedFilter(config);
}

/**
 * Handles adding a new filter tag.
 */
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

/**
 * Removes a filter tag.
 */
function removeFilter(filterTerm, config) {
  currentState.filters = currentState.filters.filter((f) => f !== filterTerm);
  renderFilters(config);
  applyCombinedFilter(config);
}

/**
 * Renders filter tags dynamically.
 */
function renderFilters(config) {
  const panel = document.getElementById(config.containerId);
  if (!panel) return;

  const filtersContainer = panel.querySelector(".jav-filters-container");
  if (!filtersContainer) return;

  // Clear existing filter tags (keep the input)
  const existingTags = filtersContainer.querySelectorAll(".jav-filter-tag");
  existingTags.forEach((tag) => tag.remove());

  // Add filter tags before the input
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

/**
 * Handles mode toggle between "group" and "flat".
 */
function handleModeToggle(mode, config) {
  currentState.mode = mode;
  currentState.selectedCode = null; // Reset selection when changing modes

  // Update button states
  const panel = document.getElementById(config.containerId);
  if (!panel) return;

  panel.querySelectorAll(".jav-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  // Update chip visibility based on mode
  const chipsContainer = panel.querySelector(".jav-chips-container");
  const label = panel.querySelector(".jav-panel-label");

  if (chipsContainer) {
    chipsContainer.style.display = mode === "group" ? "flex" : "none";
  }
  if (label) {
    label.style.display = mode === "group" ? "block" : "none";
  }

  // Re-apply filter with new mode
  applyCombinedFilter(config);
}

/**
 * Creates and mounts the enhanced floating panel.
 */
function renderEnhancedPanel(groups, config) {
  const existing = document.getElementById(config.containerId);
  if (existing) existing.remove();

  currentState = {
    groups,
    selectedCode: groups.length > 0 ? groups[0].code : null,
    searchTerm: "",
    filters: [],
    mode: config.mode || "group",
    config,
  };

  const panel = document.createElement("div");
  panel.id = config.containerId;

  // ── Header with collapse toggle and mode buttons ──
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

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "jav-panel-toggle";
  toggleBtn.textContent = "−";
  toggleBtn.title = "Collapse / Expand panel";
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isCollapsed = panel.classList.toggle("jav-panel-collapsed");
    toggleBtn.textContent = isCollapsed ? "+" : "−";
    toggleBtn.title = isCollapsed ? "Expand panel" : "Collapse panel";
  });

  header.appendChild(modeToggle);
  header.appendChild(toggleBtn);
  panel.appendChild(header);

  // ── Search Bar ──
  const searchContainer = document.createElement("div");
  searchContainer.className = "jav-search-container";

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "jav-search-input";
  searchInput.placeholder = "Search titles...";
  searchInput.addEventListener("input", (e) => handleSearchInput(e, config));

  searchContainer.appendChild(searchInput);
  panel.appendChild(searchContainer);

  // ── Dynamic Filters ──
  const filtersContainer = document.createElement("div");
  filtersContainer.className = "jav-filters-container";

  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.className = "jav-add-filter-input";
  filterInput.placeholder = "+ Add filter (Enter)";
  filterInput.addEventListener("keydown", (e) => handleAddFilter(e, config));

  filtersContainer.appendChild(filterInput);
  panel.appendChild(filtersContainer);

  // ── Group Chips (only visible in "group" mode) ──
  if (currentState.mode === "group") {
    const label = document.createElement("span");
    label.className = "jav-panel-label";
    label.textContent = "Filter by Code";
    panel.appendChild(label);

    const chipsContainer = document.createElement("div");
    chipsContainer.className = "jav-chips-container";

    // "All" reset chip
    const allChip = document.createElement("span");
    allChip.className = "jav-chip";
    allChip.textContent = "All";
    allChip.addEventListener("click", () => {
      currentState.selectedCode = null;
      setActiveChip(null, config);
      applyCombinedFilter(config);
    });
    chipsContainer.appendChild(allChip);

    // Code chips
    groups.forEach((group, index) => {
      const chip = document.createElement("span");
      chip.className = `jav-chip ${index === 0 ? config.activeChipClass : ""}`;
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

  document.body.appendChild(panel);

  // Initial filter application
  applyCombinedFilter(config);

  console.log(
    `[GroupByCode] 🏷️ Enhanced panel rendered with ${groups.length} groups, mode: ${currentState.mode}`,
  );
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================
/**
 * Main function: Extract codes, build enhanced panel with search/filters/modes, apply filtering.
 * @param {Object} [options={}] - Override default config
 */
function groupByCode(options = {}) {
  console.log("[GroupByCode] ▶️ Starting with options:", options);
  const config = { ...DEFAULT_CONFIG, ...options };

  if (config.minCount < 1) config.minCount = 1;
  if (config.topN < 1) config.topN = 1;

  const groups = extractGroupedCodes(config);

  if (groups.length === 0) {
    console.warn("[GroupByCode] ⚠️ No groups found. Try lowering minCount.");
    alert(
      `[GroupByCode] No code groups found with count >= ${config.minCount}.\nTry: groupByCode({ minCount: 1 })`,
    );
    return;
  }

  injectStyles(config);
  renderEnhancedPanel(groups, config);
  console.log("[GroupByCode] ✅ Done!");
}

/**
 * Reset helper: removes all UI, clears highlights, shows all items.
 */
groupByCode.reset = function () {
  resetAll(DEFAULT_CONFIG);
};

console.log(
  "[GroupByCode] ✅ Script loaded. Run: groupByCode() | groupByCode({ minCount: 3, topN: 5 }) | groupByCode.reset()",
);
