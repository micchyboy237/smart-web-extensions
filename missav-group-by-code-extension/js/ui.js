/**
 * ui.js - UI Rendering & Event Handlers
 */

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
  currentState.selectedCode = null;
  currentState.expandedGroup = null;

  const panel = document.getElementById(config.containerId);
  if (!panel) return;

  panel.querySelectorAll(".jav-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  const chipsContainer = panel.querySelector(".jav-chips-container");
  const label = panel.querySelector(".jav-panel-label");

  if (chipsContainer) {
    chipsContainer.style.display = mode === "group" ? "flex" : "none";
  }
  if (label) {
    label.style.display = mode === "group" ? "block" : "none";
  }

  if (mode === "group") {
    renderChips(panel, currentState.groups, config, null);
    hideResultsList();
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
    currentState.expandedGroup = null;
    saveOriginalOrder();
    renderEnhancedPanel(groups, config);
  }
}

function toggleGroupExpansion(groupCode, config) {
  const panel = document.getElementById(config.containerId);
  if (!panel) return;

  const resultsList = panel.querySelector(".jav-results-list");
  const groupHeader = panel.querySelector(
    `.jav-group-header[data-code="${groupCode}"]`,
  );

  if (!resultsList || !groupHeader) return;

  // Toggle expansion
  if (currentState.expandedGroup === groupCode) {
    currentState.expandedGroup = null;
    hideResultsList();

    // Update chevron
    const chevron = groupHeader.querySelector(".jav-chevron");
    if (chevron) chevron.innerHTML = ICONS.chevronDown;
  } else {
    currentState.expandedGroup = groupCode;
    showResultsListForGroup(groupCode, config);

    // Update chevron
    const chevron = groupHeader.querySelector(".jav-chevron");
    if (chevron) chevron.innerHTML = ICONS.chevronUp;
  }
}

function showResultsListForGroup(groupCode, config) {
  const panel = document.getElementById(config.containerId);
  if (!panel) return;

  const group = currentState.groups.find((g) => g.code === groupCode);
  if (!group) return;

  const resultsList = panel.querySelector(".jav-results-list");
  if (!resultsList) return;

  // Clear previous content
  resultsList.innerHTML = "";

  // Add header
  const header = document.createElement("div");
  header.className = "jav-results-header";
  header.innerHTML = `
    <span class="jav-results-title">${groupCode.toUpperCase()} (${group.count} items)</span>
    <button class="jav-copy-code-btn" title="Copy code">
      ${ICONS.copy}
    </button>
  `;

  header.querySelector(".jav-copy-code-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(groupCode.toUpperCase());
    showToast("Code copied!");
  });

  resultsList.appendChild(header);

  // Add items
  const itemsContainer = document.createElement("div");
  itemsContainer.className = "jav-results-items";

  group.elements.forEach((element, index) => {
    const itemCard = createResultCard(element, config, index + 1);
    itemsContainer.appendChild(itemCard);
  });

  resultsList.appendChild(itemsContainer);
  resultsList.style.display = "block";
}

function createResultCard(element, config, index) {
  const card = document.createElement("div");
  card.className = "jav-result-card";

  // Extract data from element
  const videoAnchor = element.querySelector(config.videoAnchorSelector);
  const titleEl = element.querySelector(config.titleSelector);
  const img = element.querySelector("img");
  const durationEl = element.querySelector(".absolute.bottom-1.right-1");

  const href = videoAnchor?.href || "#";
  const title = titleEl?.textContent?.trim() || "Untitled";
  const imgSrc = img?.src || "";
  const duration = durationEl?.textContent?.trim() || "";
  const dvdId = videoAnchor?.getAttribute("alt") || "";

  card.innerHTML = `
    <div class="jav-result-index">${index}</div>
    <div class="jav-result-thumbnail">
      <img src="${imgSrc}" alt="${title}" loading="lazy">
      ${duration ? `<span class="jav-result-duration">${duration}</span>` : ""}
    </div>
    <div class="jav-result-info">
      <a href="${href}" class="jav-result-title" target="_blank">${title}</a>
      <span class="jav-result-id">${dvdId}</span>
    </div>
  `;

  // Click to highlight on page
  card.addEventListener("click", (e) => {
    if (e.target.tagName === "A") return; // Don't interfere with link clicks

    // Remove previous highlights
    document.querySelectorAll(".jav-grouped-highlight").forEach((el) => {
      el.classList.remove("jav-grouped-highlight");
    });

    // Highlight this item
    element.classList.add("jav-grouped-highlight");
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  return card;
}

function hideResultsList() {
  const panel = document.getElementById(DEFAULT_CONFIG.containerId);
  if (!panel) return;

  const resultsList = panel.querySelector(".jav-results-list");
  if (resultsList) {
    resultsList.style.display = "none";
    resultsList.innerHTML = "";
  }
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "jav-toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("jav-toast-show");
  }, 10);

  setTimeout(() => {
    toast.classList.remove("jav-toast-show");
    setTimeout(() => toast.remove(), 300);
  }, 2000);
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

  // "All" chip
  const isAllActive = currentSelectedCode === null;
  const allChip = document.createElement("span");
  allChip.className = `jav-chip ${isAllActive ? config.activeChipClass : ""}`;
  allChip.textContent = "All";
  allChip.addEventListener("click", () => {
    resetAll(config);
  });
  chipsContainer.appendChild(allChip);

  // Group chips with expand functionality
  groups.forEach((group) => {
    if (
      group.count < config.dynamicMinCount &&
      group.code !== currentSelectedCode
    ) {
      return;
    }
    if (group.code === currentSelectedCode && group.count < 1) return;

    const chipWrapper = document.createElement("div");
    chipWrapper.className = "jav-chip-wrapper";

    const chip = document.createElement("span");
    const isActive = group.code === currentSelectedCode;
    chip.className = `jav-chip ${isActive ? config.activeChipClass : ""}`;
    chip.textContent = `${group.code.toUpperCase()} (${group.count})`;
    chip.dataset.code = group.code;

    chip.addEventListener("click", () => {
      currentState.selectedCode = group.code;
      setActiveChip(chip, config);
      applyCombinedFilter(config);
    });

    const expandBtn = document.createElement("button");
    expandBtn.className = "jav-expand-btn";
    expandBtn.innerHTML = ICONS.chevronDown;
    expandBtn.title = "Show results list";
    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleGroupExpansion(group.code, config);
    });

    chipWrapper.appendChild(chip);
    chipWrapper.appendChild(expandBtn);
    chipsContainer.appendChild(chipWrapper);
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
    expandedGroup: null,
  };

  saveOriginalOrder();

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

  // Results List Panel
  const resultsList = document.createElement("div");
  resultsList.className = "jav-results-list";
  resultsList.style.display = "none";
  panel.appendChild(resultsList);

  document.body.appendChild(panel);
  applyCombinedFilter(config);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    setActiveChip,
    handleSearchInput,
    handleAddFilter,
    removeFilter,
    renderFilters,
    handleModeToggle,
    handleRefresh,
    toggleGroupExpansion,
    showResultsListForGroup,
    hideResultsList,
    renderChips,
    renderEnhancedPanel,
  };
}
