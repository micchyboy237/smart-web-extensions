/**
 * content.js - MissAV Group by Code Extension (Entry Point)
 */

// ============================================================================
// LIVE UPDATE LOGIC
// ============================================================================

function checkForUpdates(config) {
  if (!currentState.isActive || currentState.isRearranging) return;

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

  saveOriginalOrder();
  const { groups, totalItems } = extractGroupedCodes(config);

  if (groups.length > 0) {
    currentState.lastItemCount = totalItems;
    renderEnhancedPanel(groups, config);
    console.log("[GroupByCode] ✅ Extension activated!");
  } else {
    console.warn("[GroupByCode] ⚠️ No code groups found initially");
  }
}

initExtension();

// Live Update Observer
const observer = new MutationObserver(() => {
  if (currentState.isRearranging) return;

  if (!currentState.isActive) {
    const items = document.querySelectorAll(DEFAULT_CONFIG.itemSelector);
    if (
      items.length > 0 &&
      !document.getElementById(DEFAULT_CONFIG.containerId)
    ) {
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
