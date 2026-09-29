/**
 * ui.js - UI Rendering & Event Handlers
 */

function setActiveChip(activeChip, config) {
  console.log("[GroupByCode] 🎯 Setting active chip");
  const panel = document.getElementById(config.containerId);
  if (!panel) {
    console.log("[GroupByCode] ⚠️ Panel not found for setActiveChip");
    return;
  }

  panel.querySelectorAll(".jav-chip").forEach((c) => {
    c.classList.remove(config.activeChipClass);
  });

  if (activeChip) {
    activeChip.classList.add(config.activeChipClass);
  }
}

function handleSearchInput(event, config) {
  currentState.searchTerm = event.target.value;
  console.log(`[GroupByCode] 🔍 Search term: "${currentState.searchTerm}"`);
  applyCombinedFilter(config);
}

function handleAddFilter(event, config) {
  if (event.key === "Enter" && event.target.value.trim()) {
    const newFilter = event.target.value.trim();
    console.log(`[GroupByCode] ➕ Adding filter: "${newFilter}"`);
    if (!currentState.filters.includes(newFilter)) {
      currentState.filters.push(newFilter);
      renderFilters(config);
      applyCombinedFilter(config);
    }
    event.target.value = "";
  }
}

function removeFilter(filterTerm, config) {
  console.log(`[GroupByCode] ➖ Removing filter: "${filterTerm}"`);
  currentState.filters = currentState.filters.filter((f) => f !== filterTerm);
  renderFilters(config);
  applyCombinedFilter(config);
}

function renderFilters(config) {
  console.log("[GroupByCode] 🏷️ Rendering filters:", currentState.filters);
  const panel = document.getElementById(config.containerId);
  if (!panel) {
    console.log("[GroupByCode] ⚠️ Panel not found for renderFilters");
    return;
  }

  const filtersContainer = panel.querySelector(".jav-filters-container");
  if (!filtersContainer) {
    console.log("[GroupByCode] ⚠️ Filters container not found");
    return;
  }

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
  console.log(`[GroupByCode] 🔄 Toggling mode to: ${mode}`);
  currentState.mode = mode;
  currentState.selectedCode = null;
  currentState.expandedGroup = null;

  const panel = document.getElementById(config.containerId);
  if (!panel) {
    console.log("[GroupByCode] ⚠️ Panel not found for mode toggle");
    return;
  }

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
  console.log("[GroupByCode] 🔄 Manual Refresh triggered");
  const { groups, totalItems } = extractGroupedCodes(config);

  if (groups.length > 0) {
    currentState.groups = groups;
    currentState.lastItemCount = totalItems;
    currentState.selectedCode = null;
    currentState.expandedGroup = null;
    saveOriginalOrder();
    renderEnhancedPanel(groups, config);
  } else {
    console.log("[GroupByCode] ⚠️ No groups found after refresh");
  }
}

function toggleGroupExpansion(groupCode, config) {
  console.log(`[GroupByCode] 📂 Toggling expansion for group: ${groupCode}`);
  const panel = document.getElementById(config.containerId);
  if (!panel) {
    console.log("[GroupByCode] ⚠️ Panel not found for toggleGroupExpansion");
    return;
  }

  const resultsList = panel.querySelector(".jav-results-list");
  if (!resultsList) {
    console.log("[GroupByCode] ⚠️ Results list element not found in panel");
    console.log(
      "[GroupByCode] Panel children:",
      Array.from(panel.children).map((c) => c.className),
    );
    return;
  }

  if (currentState.expandedGroup === groupCode) {
    console.log(`[GroupByCode] Closing results for ${groupCode}`);
    currentState.expandedGroup = null;
    hideResultsList();

    const groupHeader = panel.querySelector(
      `.jav-group-header[data-code="${groupCode}"]`,
    );
    if (groupHeader) {
      const chevron = groupHeader.querySelector(".jav-chevron");
      if (chevron) chevron.innerHTML = ICONS.chevronDown;
    }
  } else {
    console.log(`[GroupByCode] Opening results for ${groupCode}`);
    currentState.expandedGroup = groupCode;
    showResultsListForGroup(groupCode, config);

    const groupHeader = panel.querySelector(
      `.jav-group-header[data-code="${groupCode}"]`,
    );
    if (groupHeader) {
      const chevron = groupHeader.querySelector(".jav-chevron");
      if (chevron) chevron.innerHTML = ICONS.chevronUp;
    }
  }
}

function showResultsListForGroup(groupCode, config) {
  console.log(`[GroupByCode] 📋 Showing results list for: ${groupCode}`);
  const panel = document.getElementById(config.containerId);
  if (!panel) {
    console.log("[GroupByCode] ⚠️ Panel not found");
    return;
  }

  const group = currentState.groups.find((g) => g.code === groupCode);
  if (!group) {
    console.log(`[GroupByCode] ⚠️ Group not found for code: ${groupCode}`);
    console.log(
      "[GroupByCode] Available groups:",
      currentState.groups.map((g) => g.code),
    );
    return;
  }

  console.log(
    `[GroupByCode] Found group with ${group.elements.length} elements`,
  );

  const resultsList = panel.querySelector(".jav-results-list");
  if (!resultsList) {
    console.log("[GroupByCode] ⚠️ Results list container not found in panel");
    console.log(
      "[GroupByCode] Panel HTML structure:",
      panel.innerHTML.substring(0, 500),
    );
    return;
  }

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
  console.log("[GroupByCode] Added results header");

  // Add items
  const itemsContainer = document.createElement("div");
  itemsContainer.className = "jav-results-items";

  group.elements.forEach((element, index) => {
    const itemCard = createResultCard(element, config, index + 1);
    itemsContainer.appendChild(itemCard);
  });

  resultsList.appendChild(itemsContainer);
  resultsList.style.display = "block";
  console.log(
    `[GroupByCode] ✅ Results list displayed with ${group.elements.length} items`,
  );
}

function createResultCard(element, config, index) {
  console.log(`[GroupByCode] 🃏 Creating result card #${index}`);
  const card = document.createElement("div");
  card.className = "jav-result-card";

  const videoAnchor = element.querySelector(config.videoAnchorSelector);
  const titleEl = element.querySelector(config.titleSelector);
  const img = element.querySelector("img");
  const durationEl = element.querySelector(".absolute.bottom-1.right-1");

  const href = videoAnchor?.href || "#";
  const title = titleEl?.textContent?.trim() || "Untitled";
  const imgSrc = img?.src || "";
  const duration = durationEl?.textContent?.trim() || "";
  // dvdId is no longer needed for display

  console.log(
    `[GroupByCode] Card data: title="${title.substring(0, 30)}...", img="${imgSrc ? "yes" : "no"}"`,
  );

  card.innerHTML = `
    <div class="jav-result-index">${index}</div>
    <div class="jav-result-thumbnail">
      <img src="${imgSrc}" alt="${title}" loading="lazy">
      ${duration ? `<span class="jav-result-duration">${duration}</span>` : ""}
    </div>
    <div class="jav-result-info">
      <a href="${href}" class="jav-result-title" target="_blank">${title}</a>
    </div>
  `;

  card.addEventListener("click", (e) => {
    if (e.target.tagName === "A") return;

    console.log(`[GroupByCode] 👆 Result card clicked, highlighting item`);
    document.querySelectorAll(".jav-grouped-highlight").forEach((el) => {
      el.classList.remove("jav-grouped-highlight");
    });

    element.classList.add("jav-grouped-highlight");
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  return card;
}

function hideResultsList() {
  console.log("[GroupByCode] 🙈 Hiding results list");
  const panel = document.getElementById(DEFAULT_CONFIG.containerId);
  if (!panel) {
    console.log("[GroupByCode] ⚠️ Panel not found for hideResultsList");
    return;
  }

  const resultsList = panel.querySelector(".jav-results-list");
  if (resultsList) {
    resultsList.style.display = "none";
    resultsList.innerHTML = "";
    console.log("[GroupByCode] Results list hidden and cleared");
  } else {
    console.log("[GroupByCode] ⚠️ Results list element not found");
  }
}

function showToast(message) {
  console.log(`[GroupByCode] 🍞 Toast: ${message}`);
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
  console.log(`[GroupByCode] 🏷️ Rendering ${groups.length} chips`);
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
  const isAllActive = currentSelectedCode === null;
  const allChip = document.createElement("span");
  allChip.className = `jav-chip ${isAllActive ? config.activeChipClass : ""}`;
  allChip.textContent = "All";
  allChip.addEventListener("click", () => {
    console.log(
      "[GroupByCode] 'All' chip clicked - clearing code selection only",
    );
    currentState.selectedCode = null;
    setActiveChip(allChip, config);
    applyCombinedFilter(config);
  });
  chipsContainer.appendChild(allChip);
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
      console.log(`[GroupByCode] Chip clicked: ${group.code}`);
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
      console.log(`[GroupByCode] Expand button clicked for: ${group.code}`);
      toggleGroupExpansion(group.code, config);
    });
    chipWrapper.appendChild(chip);
    chipWrapper.appendChild(expandBtn);
    chipsContainer.appendChild(chipWrapper);
  });
  panel.appendChild(chipsContainer);
  console.log("[GroupByCode] ✅ Chips rendered");
}

function renderEnhancedPanel(groups, config) {
  console.log("[GroupByCode] 🎨 Rendering enhanced panel");
  const existing = document.getElementById(config.containerId);
  if (existing) {
    console.log("[GroupByCode] Removing existing panel");
    existing.remove();
  }
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
  console.log("[GroupByCode] Creating results list container");
  const resultsList = document.createElement("div");
  resultsList.className = "jav-results-list";
  resultsList.style.display = "none";
  panel.appendChild(resultsList);
  console.log("[GroupByCode] Results list container added to panel");
  document.body.appendChild(panel);
  console.log("[GroupByCode] Panel appended to body");
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
