/**
 * filter.js - Filtering & Rearrangement Logic
 */

function saveOriginalOrder() {
  console.log("[GroupByCode] 💾 Saving original order...");
  const allItems = document.querySelectorAll(DEFAULT_CONFIG.itemSelector);
  currentState.originalOrder = Array.from(allItems);
  console.log(
    `[GroupByCode] Saved ${currentState.originalOrder.length} items in original order`,
  );
}

function restoreOriginalOrder(config) {
  console.log("[GroupByCode] ↩️ Restoring original order");
  if (currentState.originalOrder.length === 0) {
    console.log("[GroupByCode] ⚠️ No original order saved");
    return;
  }

  const parentContainer = currentState.originalOrder[0]?.parentElement;
  if (!parentContainer) {
    console.log("[GroupByCode] ⚠️ No parent container found");
    return;
  }

  const currentItems = Array.from(
    parentContainer.querySelectorAll(config.itemSelector),
  );

  const isAlreadyOrdered =
    currentItems.length === currentState.originalOrder.length &&
    currentItems.every((el, i) => el === currentState.originalOrder[i]);

  if (isAlreadyOrdered) {
    console.log("[GroupByCode] Already in original order, skipping");
    return;
  }

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
    console.log(
      `[GroupByCode] Restored ${currentState.originalOrder.length} items`,
    );
  } finally {
    requestAnimationFrame(() => {
      currentState.isRearranging = false;
    });
  }
}

function rearrangeItems(prioritizedItems, unprioritizedItems, config) {
  if (prioritizedItems.length === 0 && unprioritizedItems.length === 0) {
    console.log("[GroupByCode] ⚠️ No items to rearrange");
    return;
  }

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

  if (isAlreadyOrdered) {
    console.log("[GroupByCode] Already in desired order, skipping rearrange");
    return;
  }

  console.log(
    `[GroupByCode] 🔄 Rearranging: ${prioritizedItems.length} prioritized, ${unprioritizedItems.length} unprioritized`,
  );
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
  console.log("[GroupByCode] 🔎 Applying combined filter...", {
    mode: currentState.mode,
    selectedCode: currentState.selectedCode,
    searchTerm: currentState.searchTerm,
    filters: currentState.filters,
    expandedGroup: currentState.expandedGroup,
  });
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
  console.log(`[GroupByCode] Has active filters: ${hasActiveFilters}`);
  // No filters → restore original order
  if (!hasActiveFilters) {
    console.log("[GroupByCode] No filters, restoring original order");
    restoreOriginalOrder(config);
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
      console.log(
        `[GroupByCode] Group filter: showing ${group.elements.length} items for ${selectedCode}`,
      );
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
    if (mode === "group" && selectedCode && !elementsToShow.has(container)) {
      unprioritizedItems.push(container);
      return;
    }
    const titleEl = container.querySelector(config.titleSelector);
    const titleText = titleEl?.textContent?.trim() || "";
    if (primaryRegex && !primaryRegex.test(titleText)) {
      unprioritizedItems.push(container);
      return;
    }
    const failedFilters = filterRegexes.filter(
      ({ regex }) => !regex.test(titleText),
    );
    if (failedFilters.length > 0) {
      unprioritizedItems.push(container);
      return;
    }
    container.classList.add(config.highlightClass);
    prioritizedItems.push(container);
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
  console.log(
    `[GroupByCode] Filter result: ${prioritizedItems.length} matched, ${unprioritizedItems.length} unmatched`,
  );

  // Sort prioritized items by code count (descending) for consistent ordering
  if (mode === "group" && prioritizedItems.length > 0) {
    prioritizedItems.sort((a, b) => {
      const anchorA = a.querySelector(config.videoAnchorSelector);
      const anchorB = b.querySelector(config.videoAnchorSelector);
      const codeA = anchorA
        ? extractCode(anchorA.getAttribute(config.altAttr))
        : null;
      const codeB = anchorB
        ? extractCode(anchorB.getAttribute(config.altAttr))
        : null;
      const countA = codeA ? activeCodeCounts.get(codeA) || 0 : 0;
      const countB = codeB ? activeCodeCounts.get(codeB) || 0 : 0;
      return countB - countA;
    });
  }

  rearrangeItems(prioritizedItems, unprioritizedItems, config);
  if (mode === "group") {
    const panel = document.getElementById(config.containerId);
    if (panel) {
      // When a group is selected, build chips from ALL items matching search/filters
      // (not just the selected group's items) so users can see other available codes
      const itemsForChipCalculation = selectedCode
        ? [...prioritizedItems, ...unprioritizedItems].filter((item) => {
            // Only include items that match search/filter criteria
            const titleEl = item.querySelector(config.titleSelector);
            const titleText = titleEl?.textContent?.trim() || "";
            if (primaryRegex && !primaryRegex.test(titleText)) return false;
            const failedFilters = filterRegexes.filter(
              ({ regex }) => !regex.test(titleText),
            );
            return failedFilters.length === 0;
          })
        : prioritizedItems;

      const dynamicGroupMap = new Map();
      itemsForChipCalculation.forEach((container) => {
        const videoAnchor = container.querySelector(config.videoAnchorSelector);
        if (videoAnchor) {
          const rawAlt = videoAnchor.getAttribute(config.altAttr);
          const code = extractCode(rawAlt);
          if (code) {
            if (!dynamicGroupMap.has(code)) {
              dynamicGroupMap.set(code, {
                code,
                count: 0,
                urls: [],
                elements: [],
              });
            }
            const entry = dynamicGroupMap.get(code);
            entry.count++;
            entry.urls.push(videoAnchor.href || "");
            entry.elements.push(container);
          }
        }
      });
      const dynamicGroups = Array.from(dynamicGroupMap.values())
        .filter((g) => {
          if (g.code === selectedCode) return g.count >= 1;
          return g.count >= config.dynamicMinCount;
        })
        .sort((a, b) => b.count - a.count);
      console.log(
        `[GroupByCode] Dynamic groups from matched items: ${dynamicGroups.length} codes`,
      );
      renderChips(panel, dynamicGroups, config, selectedCode);
    }
  }
}

function resetAll(config) {
  console.log("[GroupByCode] 🔄 Resetting all filters");
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

  // Ensure no residual filter state
  applyCombinedFilter(config);
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
