/**
 * filter.js - Filtering & Rearrangement Logic
 */

function saveOriginalOrder() {
  const allItems = document.querySelectorAll(DEFAULT_CONFIG.itemSelector);
  currentState.originalOrder = Array.from(allItems);
}

function restoreOriginalOrder(config) {
  if (currentState.originalOrder.length === 0) return;

  const parentContainer = currentState.originalOrder[0]?.parentElement;
  if (!parentContainer) return;

  const currentItems = Array.from(
    parentContainer.querySelectorAll(config.itemSelector),
  );

  const isAlreadyOrdered =
    currentItems.length === currentState.originalOrder.length &&
    currentItems.every((el, i) => el === currentState.originalOrder[i]);

  if (isAlreadyOrdered) return;

  currentState.isRearranging = true;
  try {
    currentState.originalOrder.forEach((item) => {
      if (
        document.body.contains(item) &&
        item.parentElement === parentContainer
      ) {
        parentContainer.appendChild(item);
      }
    });
  } finally {
    requestAnimationFrame(() => {
      currentState.isRearranging = false;
    });
  }
}

function rearrangeItems(prioritizedItems, unprioritizedItems, config) {
  if (prioritizedItems.length === 0 && unprioritizedItems.length === 0) return;

  const firstItem = prioritizedItems[0] || unprioritizedItems[0];
  if (!firstItem) return;

  const parentContainer = firstItem.parentElement;
  if (!parentContainer) return;

  const desiredOrder = [...prioritizedItems, ...unprioritizedItems];
  const currentItems = Array.from(
    parentContainer.querySelectorAll(config.itemSelector),
  );

  const isAlreadyOrdered =
    currentItems.length === desiredOrder.length &&
    currentItems.every((el, i) => el === desiredOrder[i]);

  if (isAlreadyOrdered) return;

  currentState.isRearranging = true;
  try {
    desiredOrder.forEach((item) => {
      if (item.parentElement === parentContainer) {
        parentContainer.appendChild(item);
      }
    });
  } finally {
    requestAnimationFrame(() => {
      currentState.isRearranging = false;
    });
  }
}

function applyCombinedFilter(config) {
  const allItems = document.querySelectorAll(config.itemSelector);

  // Clear visual classes
  allItems.forEach((el) => {
    el.classList.remove(config.hiddenItemClass);
    el.classList.remove(config.highlightClass);
  });

  const { selectedCode, searchTerm, filters, mode, groups } = currentState;
  const hasActiveFilters =
    (mode === "group" && selectedCode !== null) ||
    (searchTerm && searchTerm.trim() !== "") ||
    filters.length > 0;

  // No filters → restore original order
  if (!hasActiveFilters) {
    restoreOriginalOrder(config);

    // Re-render chips with full original groups
    const panel = document.getElementById(config.containerId);
    if (panel && currentState.mode === "group") {
      renderChips(panel, groups, config, null);
    }
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
      allItems.forEach((el) => elementsToShow.add(el));
    }
  } else {
    allItems.forEach((el) => elementsToShow.add(el));
  }

  const prioritizedItems = [];
  const unprioritizedItems = [];
  const activeCodeCounts = new Map();

  allItems.forEach((container) => {
    // Group filter exclusion
    if (mode === "group" && selectedCode && !elementsToShow.has(container)) {
      unprioritizedItems.push(container);
      return;
    }

    const titleEl = container.querySelector(config.titleSelector);
    const titleText = titleEl?.textContent?.trim() || "";

    // Primary search filter
    if (primaryRegex && !primaryRegex.test(titleText)) {
      unprioritizedItems.push(container);
      return;
    }

    // Additional tag filters
    const failedFilters = filterRegexes.filter(
      ({ regex }) => !regex.test(titleText),
    );
    if (failedFilters.length > 0) {
      unprioritizedItems.push(container);
      return;
    }

    // Item passed all filters
    container.classList.add(config.highlightClass);
    prioritizedItems.push(container);

    // Track code counts for dynamic chips
    if (mode === "group") {
      const videoAnchor = container.querySelector(config.videoAnchorSelector);
      if (videoAnchor) {
        const rawAlt = videoAnchor.getAttribute(config.altAttr);
        const code = extractCode(rawAlt);
        if (code) {
          activeCodeCounts.set(code, (activeCodeCounts.get(code) || 0) + 1);
        }
      }
    }
  });

  rearrangeItems(prioritizedItems, unprioritizedItems, config);

  // Update chips dynamically if in group mode
  if (mode === "group") {
    const panel = document.getElementById(config.containerId);
    if (panel) {
      const dynamicGroups = groups
        .filter((g) => {
          const count = activeCodeCounts.get(g.code) || 0;
          if (g.code === selectedCode) return count >= 1;
          return count >= config.dynamicMinCount;
        })
        .map((g) => ({
          ...g,
          count: activeCodeCounts.get(g.code) || 0,
        }));

      dynamicGroups.sort((a, b) => b.count - a.count);
      renderChips(panel, dynamicGroups, config, selectedCode);
    }
  }
}

function resetAll(config) {
  currentState.selectedCode = null;
  currentState.searchTerm = "";
  currentState.filters = [];
  currentState.expandedGroup = null;

  const panel = document.getElementById(config.containerId);
  if (panel) {
    const searchInput = panel.querySelector(".jav-search-input");
    if (searchInput) searchInput.value = "";

    const filtersContainer = panel.querySelector(".jav-filters-container");
    if (filtersContainer) {
      const existingTags = filtersContainer.querySelectorAll(".jav-filter-tag");
      existingTags.forEach((tag) => tag.remove());
    }
  }

  const allItems = document.querySelectorAll(config.itemSelector);
  allItems.forEach((el) => {
    el.classList.remove(config.hiddenItemClass);
    el.classList.remove(config.highlightClass);
  });

  restoreOriginalOrder(config);

  if (currentState.mode === "group") {
    const panel = document.getElementById(config.containerId);
    if (panel) {
      renderChips(panel, currentState.groups, config, null);
      hideResultsList();
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    saveOriginalOrder,
    restoreOriginalOrder,
    rearrangeItems,
    applyCombinedFilter,
    resetAll,
  };
}
