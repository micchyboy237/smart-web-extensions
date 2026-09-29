/**
 * content.js - MissAV Group by Code Extension (Entry Point)
 */

function checkForUpdates(config) {
  if (!currentState.isActive || currentState.isRearranging) {
    console.log(
      "[GroupByCode] ⏭️ Skipping update check (inactive or rearranging)",
    );
    return;
  }

  // Skip if filters/search are active to prevent overwriting filtered state
  const hasActiveFilters =
    (currentState.mode === "group" && currentState.selectedCode !== null) ||
    (currentState.searchTerm && currentState.searchTerm.trim() !== "") ||
    currentState.filters.length > 0;

  if (hasActiveFilters) {
    console.log("[GroupByCode] ⏭️ Skipping update check (filters active)");
    return;
  }

  console.log("[GroupByCode] 🔍 Checking for content updates...");

  const { groups, totalItems } = extractGroupedCodes(config);
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
    saveOriginalOrder();

    const panel = document.getElementById(config.containerId);
    if (panel && currentState.mode === "group") {
      renderChips(panel, groups, config, currentState.selectedCode);
      applyCombinedFilter(config);
    }
  } else {
    console.log("[GroupByCode] No significant changes detected");
  }
}

function initExtension() {
  console.log("[GroupByCode] 🚀 Extension initializing on missav.ws");

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", activateExtension);
  } else {
    activateExtension();
  }
}

function activateExtension() {
  console.log("[GroupByCode] Activating extension...");
  const config = { ...DEFAULT_CONFIG };
  currentState.config = config;

  const items = document.querySelectorAll(config.itemSelector);
  console.log(`[GroupByCode] Found ${items.length} items on page`);

  if (items.length === 0) {
    console.log("[GroupByCode] ⚠️ No items found, retrying in 2s...");
    setTimeout(() => activateExtension(), 2000);
    return;
  }

  saveOriginalOrder();
  const { groups, totalItems } = extractGroupedCodes(config);

  if (groups.length > 0) {
    currentState.lastItemCount = totalItems;
    renderEnhancedPanel(groups, config);
    console.log("[GroupByCode] ✅ Extension activated successfully!");
  } else {
    console.warn("[GroupByCode] ⚠️ No code groups found initially");
  }
}

initExtension();

// Live Update Observer
console.log("[GroupByCode] Setting up MutationObserver");
const observer = new MutationObserver(() => {
  if (currentState.isRearranging) {
    console.log("[GroupByCode] ⏭️ Skipping mutation (rearranging)");
    return;
  }

  if (!currentState.isActive) {
    const items = document.querySelectorAll(DEFAULT_CONFIG.itemSelector);
    if (
      items.length > 0 &&
      !document.getElementById(DEFAULT_CONFIG.containerId)
    ) {
      console.log(
        "[GroupByCode] Items detected but panel not active, scheduling activation",
      );
      clearTimeout(updateTimer);
      updateTimer = setTimeout(activateExtension, 1000);
    }
  } else {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => checkForUpdates(currentState.config), 1500);
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

let updateTimer = null;
