/**
 * cluster.js
 * Owns all cluster-mode logic for the MissAV FastStream panel.
 *
 * Called by panel.js via:
 *   window.__initCluster({ resultsList, resultsCount,
 *                           currentDataRef, filtersRef,
 *                           createCardHTML, attachCardEvents })
 */
(function () {
  "use strict";

  const LOG_PREFIX = "[MISSAV CLUSTER]";
  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }
  function logErr(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  // ====================== STATE ======================
  let clusterMode = false;
  // We track which clusters the user has explicitly OPENED.
  // Everything else is collapsed by default.
  const expandedClusters = new Set();

  // Injected by panel.js at init time
  let _resultsList = null;
  let _resultsCount = null;
  let _currentDataRef = null; // { value: JAVItem[] } — live reference
  let _filtersRef = null; // { text, videoId, code, episode } — live reference
  let _createCardHTML = null;
  let _attachCardEvents = null;

  // ====================== PIPELINE ======================
  /**
   * Stage 1 — Bucket each item by its code key.
   * Stage 2 — Sort items within each bucket by episode ascending.
   * Stage 3 — Sort cluster keys alphabetically; "unknown" last.
   *
   * @param   {object[]}              items  Pre-filtered JAV items
   * @returns {Map<string, object[]>}        Ordered code → items map
   */
  function buildClusterMap(items) {
    log("buildClusterMap: start - items count:", items.length);
    const map = new Map();

    // Stage 1: bucket
    for (const item of items) {
      const key = (item.code || "").toLowerCase().trim() || "unknown";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
      log("Bucketing item", item, "into cluster", key);
    }

    // Stage 2: sort within each bucket by episode number
    for (const [key, bucket] of map) {
      log("Sorting bucket for key:", key, "items:", bucket.length);
      bucket.sort((a, b) => {
        const ea = parseInt(a.episode, 10) || 0;
        const eb = parseInt(b.episode, 10) || 0;
        return ea - eb;
      });
    }

    // Stage 3: sort clusters — most items first, "unknown" last
    const sortedMap = new Map(
      [...map.entries()].sort(([a, buckA], [b, buckB]) => {
        if (a === "unknown") return 1;
        if (b === "unknown") return -1;
        return buckB.length - buckA.length;
      }),
    );
    log("buildClusterMap: complete - clusters:", [...sortedMap.keys()]);
    return sortedMap;
  }

  // ====================== FILTER (local copy) ======================
  function applyFiltersLocally(items) {
    log(
      "applyFiltersLocally: start - items:",
      items.length,
      "filters:",
      _filtersRef,
    );
    const f = _filtersRef;
    const filtered = items.filter((item) => {
      if (f.text && !(item.text || "").toLowerCase().includes(f.text)) {
        log("Filter out on text:", item);
        return false;
      }
      if (
        f.videoId &&
        !(item.videoId || "").toLowerCase().includes(f.videoId)
      ) {
        log("Filter out on videoId:", item);
        return false;
      }
      if (f.code && !(item.code || "").toLowerCase().includes(f.code)) {
        log("Filter out on code:", item);
        return false;
      }
      if (
        f.episode &&
        !(item.episode || "").toLowerCase().includes(f.episode)
      ) {
        log("Filter out on episode:", item);
        return false;
      }
      return true;
    });
    log("applyFiltersLocally: complete - filtered count:", filtered.length);
    return filtered;
  }

  // ====================== RENDER ======================
  function renderClusters() {
    log("renderClusters: start");
    try {
      if (!_currentDataRef || !_currentDataRef.value) {
        logErr("renderClusters: _currentDataRef or .value is missing!");
        return;
      }
      const filtered = applyFiltersLocally(_currentDataRef.value);
      log("renderClusters: filtered result count:", filtered.length);

      const clusterMap = buildClusterMap(filtered);
      log("renderClusters: clusterMap size:", clusterMap.size);

      const totalClusters = clusterMap.size;
      const totalItems = filtered.length;

      _resultsCount.textContent =
        `${totalClusters} cluster${totalClusters !== 1 ? "s" : ""} · ` +
        `${totalItems} item${totalItems !== 1 ? "s" : ""}`;

      if (totalItems === 0) {
        log("renderClusters: No items after filtering.");
        _resultsList.innerHTML =
          '<div class="empty-state">No matching results</div>';
        return;
      }

      let html = "";
      for (const [code, items] of clusterMap) {
        // Collapsed unless the user has explicitly expanded it
        const isCollapsed = !expandedClusters.has(code);
        const label =
          code === "unknown" ? "Unknown / No code" : code.toUpperCase();
        log(
          "renderClusters: cluster",
          code,
          "- items:",
          items.length,
          "- isCollapsed:",
          isCollapsed,
        );

        html += `
            <div class="cluster-section">
              <div class="cluster-header" data-code="${code}">
                <span class="cluster-label">${label}</span>
                <span class="cluster-badge">${items.length}</span>
                <span class="cluster-chevron">${isCollapsed ? "▶" : "▼"}</span>
              </div>
              ${
                isCollapsed
                  ? ""
                  : `<div class="cluster-body">${items.map(_createCardHTML).join("")}</div>`
              }
            </div>`;
      }

      _resultsList.innerHTML = html;
      log("renderClusters: HTML injected");
      _attachCardEvents();
      log("Rendered", totalClusters, "clusters,", totalItems, "items.");
    } catch (err) {
      logErr("Error in renderClusters:", err);
    }
    log("renderClusters: end");
  }

  // ====================== COLLAPSE / EXPAND ======================
  /**
   * Delegated click handler attached once to resultsList.
   * Toggling a cluster header re-renders in place without
   * rebuilding the full cluster map.
   */
  function bindClusterToggle() {
    log("bindClusterToggle: binding...");
    _resultsList.addEventListener("click", (e) => {
      if (!clusterMode) {
        log("bindClusterToggle: Ignored click - clusterMode OFF");
        return;
      }
      const header = e.target.closest(".cluster-header");
      if (!header) {
        // log("bindClusterToggle: Click not on cluster-header");
        return;
      }
      const code = header.dataset.code;
      log("bindClusterToggle: toggling cluster", code);
      if (expandedClusters.has(code)) {
        expandedClusters.delete(code);
        log("Cluster collapsed:", code);
      } else {
        expandedClusters.add(code);
        log("Cluster expanded:", code);
      }
      renderClusters();
    });
    log("bindClusterToggle: bound");
  }

  // ====================== TOGGLE (panel.js is now the click handler) ======================
  // Instead of binding the click in this module, we export a toggle
  // function for panel.js to call in response to its #cluster-btn click.
  function toggleClusterMode(renderListFn) {
    clusterMode = !clusterMode;
    log("Cluster mode:", clusterMode ? "ON" : "OFF");
    if (clusterMode) {
      renderClusters();
    } else {
      renderListFn();
    }
    return clusterMode;
  }

  // ====================== PUBLIC API ======================
  /**
   * Called once by panel.js after the panel DOM is ready.
   *
   * @param {object} deps
   * @param {HTMLElement}      deps.resultsList
   * @param {HTMLElement}      deps.resultsCount
   * @param {{ value: [] }}    deps.currentDataRef   - live-updated object reference
   * @param {object}           deps.filtersRef       - live-updated filters object
   * @param {Function}         deps.createCardHTML
   * @param {Function}         deps.attachCardEvents
   * @param {Function__toggleClusterMode}         deps.renderList       - panel's own renderResults()
   */
  function initCluster(deps) {
    log("initCluster: initializing with deps", deps);
    _resultsList = deps.resultsList;
    _resultsCount = deps.resultsCount;
    _currentDataRef = deps.currentDataRef;
    _filtersRef = deps.filtersRef;
    _createCardHTML = deps.createCardHTML;
    _attachCardEvents = deps.attachCardEvents;

    bindClusterToggle();
    // No longer bind our own button events — panel.js owns the #cluster-btn click.
    // Instead, export a toggle handler it can call directly:
    window.__toggleClusterMode = () => toggleClusterMode(deps.renderList);

    log("Cluster module initialised.");
  }

  // Expose on window so panel.js can call it after script injection
  window.__initCluster = initCluster;

  // Let panel.js ask whether cluster mode is currently active,
  // so it can skip its own renderResults when cluster owns the view.
  window.__isClusterMode = () => clusterMode;

  // Allow panel.js to trigger a cluster re-render (e.g. on data refresh)
  window.__renderClusters = renderClusters;
})();
