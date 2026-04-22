(function () {
  "use strict";
  const LOG_PREFIX = "[MISSAV PANEL]";
  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }
  function logErr(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  let dataCheckInterval = null;
  let currentData = [];
  let filteredData = [];
  let isRandomized = false;
  let isExpanded = false;
  const DISPLAY_LIMIT = 10;
  const DISPLAY_LIMIT_EXPANDED = 40;

  // Filter state — videoId & episode removed; code split into include/exclude
  const filters = {
    text: "",
    includeCodes: [], // string[]
    excludeCodes: [], // string[]
  };

  // ====================== STORAGE ======================
  const STORAGE_KEY = "missav_filters";

  function saveFiltersToStorage() {
    try {
      log("[saveFiltersToStorage] Saving filters to storage...", filters);
      chrome.storage.local.set(
        {
          [STORAGE_KEY]: {
            includeCodes: filters.includeCodes,
            excludeCodes: filters.excludeCodes,
          },
        },
        () => {
          if (chrome.runtime.lastError) {
            logErr(
              "[saveFiltersToStorage] chrome.storage.local.set error:",
              chrome.runtime.lastError,
            );
          } else {
            log("[saveFiltersToStorage] Filters saved successfully:", filters);
          }
        },
      );
    } catch (err) {
      logErr("[saveFiltersToStorage] Failed to save filters:", err);
    }
  }

  function loadFiltersFromStorage() {
    log("[loadFiltersFromStorage] Attempting to load filters...");
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          log("[loadFiltersFromStorage] chrome.storage.local.get result:", res);
          const data = res[STORAGE_KEY];
          if (data) {
            filters.includeCodes = Array.isArray(data.includeCodes)
              ? data.includeCodes
              : [];
            filters.excludeCodes = Array.isArray(data.excludeCodes)
              ? data.excludeCodes
              : [];
            log("[loadFiltersFromStorage] Filters loaded from storage:", data);
          } else {
            log(
              "[loadFiltersFromStorage] No filters found in storage, using defaults.",
            );
          }
          resolve();
        });
      } catch (err) {
        logErr("[loadFiltersFromStorage] Failed to load filters:", err);
        resolve();
      }
    });
  }

  let panel = null;
  let toggleBtn = null;
  let resultsList = null;
  let resultsCount = null;

  // ====================== PANEL HTML ======================
  function createPanel() {
    log("Attempting to create panel ...");
    if (document.getElementById("missav-faststream-panel")) return;
    try {
      const clusterCss = (window.__MISSAV_EXT_URLS__ || {}).clusterCss;
      if (clusterCss) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = clusterCss;
        (document.head || document.documentElement).appendChild(link);
      }

      toggleBtn = document.createElement("button");
      toggleBtn.id = "missav-faststream-toggle";
      toggleBtn.innerHTML = "📋";
      toggleBtn.title = "Show FastStream Panel";
      toggleBtn.onclick = () => togglePanel(true);
      document.body.appendChild(toggleBtn);

      panel = document.createElement("div");
      panel.id = "missav-faststream-panel";
      panel.innerHTML = `
        <div class="panel-header" id="panel-drag-handle">
          <h3>🎬 MissAV FastStream</h3>
          <div style="display:flex;gap:2px;align-items:center">
            <button id="expand-btn"   title="Expand panel">⛶</button>
            <button id="panel-close-btn" title="Collapse">−</button>
          </div>
        </div>
        <div class="filter-section">
          <input type="text" class="filter-input" id="filter-text"
                 placeholder="🔍 Search by title…" style="margin-bottom:6px"/>

          <div class="filter-row">
            <span class="filter-label">Include</span>
            <div class="ms-wrapper" id="ms-include-wrapper">
              <div class="ms-box" id="ms-include-box">
                <input class="ms-input" id="ms-include-input" placeholder="add code…" autocomplete="off"/>
              </div>
              <div class="ms-dropdown" id="ms-include-dropdown"></div>
            </div>
          </div>

          <div class="filter-row">
            <span class="filter-label">Exclude</span>
            <div class="ms-wrapper" id="ms-exclude-wrapper">
              <div class="ms-box" id="ms-exclude-box">
                <input class="ms-input" id="ms-exclude-input" placeholder="add code…" autocomplete="off"/>
              </div>
              <div class="ms-dropdown" id="ms-exclude-dropdown"></div>
            </div>
          </div>

          <div class="action-bar">
            <button class="action-btn" id="clear-filters-btn">🗑 Clear</button>
            <button class="action-btn randomize" id="randomize-btn">🎲 Shuffle</button>
            <button class="action-btn cluster-btn" id="cluster-btn">🗂 Clusters</button>
            <button class="action-btn copy-btn"    id="copy-btn">📋 Copy</button>
          </div>
        </div>
        <div class="results-count" id="results-count">0 results</div>
        <div class="results-list" id="results-list">
          <div class="empty-state">Loading data…</div>
        </div>
      `;
      document.body.appendChild(panel);

      resultsList = document.getElementById("results-list");
      resultsCount = document.getElementById("results-count");

      bindEvents();
      makeDraggable();
      loadData();
    } catch (err) {
      logErr("Error in createPanel:", err);
    }
  }

  // ====================== MULTISELECT WIDGET ======================
  /**
   * Builds a self-contained multiselect tag widget.
   *
   * @param {"include"|"exclude"} kind
   */
  function buildMultiselect(kind) {
    log(`[multiselect][${kind}] Initializing multiselect widget`);
    const box = document.getElementById(`ms-${kind}-box`);
    const input = document.getElementById(`ms-${kind}-input`);
    const dropdown = document.getElementById(`ms-${kind}-dropdown`);
    const tagClass = kind; // css class "include" or "exclude"
    const arr =
      kind === "include" ? filters.includeCodes : filters.excludeCodes;

    // ── render tags ──
    function renderTags() {
      log(`[multiselect][${kind}] Rendering tags`, arr.slice());

      // Update filters
      if (kind === "include") {
        filters.includeCodes = arr.slice();
      } else {
        filters.excludeCodes = arr.slice();
      }
      saveFiltersToStorage();

      // Remove old tags (leave the input)
      box.querySelectorAll(".ms-tag").forEach((t) => t.remove());
      arr.forEach((code) => {
        const tag = document.createElement("span");
        tag.className = `ms-tag ${tagClass}`;
        tag.innerHTML = `${code}<span class="ms-tag-remove" data-code="${code}">×</span>`;
        box.insertBefore(tag, input);
      });
    }

    // ── populate dropdown ──
    function openDropdown(query) {
      log(`[multiselect][${kind}] Opening dropdown with query: "${query}"`);
      const allCodes = [
        ...new Set(
          currentData.map((i) => (i.code || "").toLowerCase()).filter(Boolean),
        ),
      ].sort();
      const q = query.toLowerCase();
      const matches = allCodes.filter(
        (c) => (!q || c.includes(q)) && !arr.includes(c),
      );
      log(`[multiselect][${kind}] Dropdown matches:`, matches);
      if (!matches.length) {
        dropdown.classList.remove("open");
        return;
      }
      dropdown.innerHTML = matches
        .map(
          (c, i) =>
            `<div class="ms-option" data-code="${c}">${c.toUpperCase()}</div>`,
        )
        .join("");
      dropdown.classList.add("open");
    }

    function closeDropdown() {
      log(`[multiselect][${kind}] Closing dropdown`);
      dropdown.classList.remove("open");
    }

    function addCode(code) {
      const c = code.toLowerCase().trim();
      log(`[multiselect][${kind}] addCode called with:`, code, "→", c);
      if (!c || arr.includes(c)) {
        log(
          `[multiselect][${kind}] addCode ignored, empty or already present:`,
          c,
        );
        return;
      }
      // Can't be in both lists simultaneously
      const other =
        kind === "include" ? filters.excludeCodes : filters.includeCodes;
      const otherIdx = other.indexOf(c);
      if (otherIdx !== -1) {
        log(`[multiselect][${kind}] Removing code "${c}" from other list`);
        other.splice(otherIdx, 1);
      }
      arr.push(c);
      input.value = "";
      renderTags();

      closeDropdown();
      log(`[multiselect][${kind}] Tag added:`, c, "; arr now:", arr.slice());
      applyFilters();
      // Re-render the other multiselect's tags in case we removed from it
      const otherKind = kind === "include" ? "exclude" : "include";
      document
        .getElementById(`ms-${otherKind}-box`)
        ?.querySelectorAll(".ms-tag")
        .forEach((t) => t.remove());
      const otherArr =
        otherKind === "include" ? filters.includeCodes : filters.excludeCodes;
      const otherBox = document.getElementById(`ms-${otherKind}-box`);
      const otherInput = document.getElementById(`ms-${otherKind}-input`);
      otherArr.forEach((code2) => {
        const tag = document.createElement("span");
        tag.className = `ms-tag ${otherKind}`;
        tag.innerHTML = `${code2}<span class="ms-tag-remove" data-code="${code2}">×</span>`;
        otherBox.insertBefore(tag, otherInput);
      });
      log(
        `[multiselect][${kind}] Other box "${otherKind}" re-rendered with:`,
        otherArr.slice(),
      );
    }

    function removeCode(code) {
      log(`[multiselect][${kind}] removeCode called for:`, code);
      const idx = arr.indexOf(code);
      if (idx !== -1) {
        arr.splice(idx, 1);
        log(`[multiselect][${kind}] Removed:`, code, "; arr now:", arr.slice());
      } else {
        log(`[multiselect][${kind}] Code not found in list:`, code);
      }
      renderTags();
      applyFilters();
    }

    // ── events ──
    input.addEventListener("input", () => {
      log(`[multiselect][${kind}] input event; value:`, input.value);
      openDropdown(input.value);
    });
    input.addEventListener("focus", () => {
      log(`[multiselect][${kind}] focus event`);
      openDropdown(input.value);
    });
    input.addEventListener("keydown", (e) => {
      log(`[multiselect][${kind}] keydown: ${e.key}`);
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const focused = dropdown.querySelector(".ms-option.focused");
        if (focused) {
          log(
            `[multiselect][${kind}] Enter/Comma with focused option:`,
            focused.dataset.code,
          );
          addCode(focused.dataset.code);
        } else if (input.value.trim()) {
          log(
            `[multiselect][${kind}] Enter/Comma with input value:`,
            input.value.trim(),
          );
          addCode(input.value.trim());
        }
      }
      if (e.key === "Backspace" && !input.value && arr.length) {
        log(
          `[multiselect][${kind}] Backspace with empty input, removing last tag`,
        );
        removeCode(arr[arr.length - 1]);
      }
      if (e.key === "Escape") {
        log(`[multiselect][${kind}] Escape key pressed`);
        closeDropdown();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        log(`[multiselect][${kind}] ArrowUp/ArrowDown key navigation`);
        e.preventDefault();
        const opts = [...dropdown.querySelectorAll(".ms-option")];
        if (!opts.length) return;
        const cur = dropdown.querySelector(".ms-option.focused");
        let idx = opts.indexOf(cur);
        opts.forEach((o) => o.classList.remove("focused"));
        idx =
          e.key === "ArrowDown"
            ? (idx + 1) % opts.length
            : (idx - 1 + opts.length) % opts.length;
        opts[idx].classList.add("focused");
        opts[idx].scrollIntoView({ block: "nearest" });
        log(
          `[multiselect][${kind}] Focused dropdown option:`,
          opts[idx].dataset.code,
        );
      }
    });

    dropdown.addEventListener("mousedown", (e) => {
      const opt = e.target.closest(".ms-option");
      if (opt) {
        log(
          `[multiselect][${kind}] Dropdown mousedown, option picked:`,
          opt.dataset.code,
        );
        e.preventDefault();
        addCode(opt.dataset.code);
      }
    });

    box.addEventListener("mousedown", (e) => {
      const rm = e.target.closest(".ms-tag-remove");
      if (rm) {
        log(`[multiselect][${kind}] Tag remove clicked:`, rm.dataset.code);
        e.preventDefault();
        removeCode(rm.dataset.code);
        return;
      }
      // Click on box but not on input → focus input
      if (e.target !== input) {
        log(`[multiselect][${kind}] Box mousedown, focusing input`);
        e.preventDefault();
        input.focus();
      }
    });

    document.addEventListener("click", (e) => {
      if (!box.contains(e.target) && !dropdown.contains(e.target)) {
        log(`[multiselect][${kind}] Document click outside, closing dropdown`);
        closeDropdown();
      }
    });
    log(`[multiselect][${kind}] Multiselect widget setup complete`);
  }

  // ====================== EVENT BINDING ======================
  function bindEvents() {
    log("Binding panel events …");
    try {
      document
        .getElementById("panel-close-btn")
        .addEventListener("click", () => togglePanel(false));

      document.getElementById("expand-btn").addEventListener("click", () => {
        isExpanded = !isExpanded;
        panel.classList.toggle("panel-expanded", isExpanded);
        // Always set the same icon (⛶); text does not change when expanded
        document.getElementById("expand-btn").textContent = "⛶";
        document.getElementById("expand-btn").title = isExpanded
          ? "Shrink panel"
          : "Expand panel";
        // Re-render to apply DISPLAY_LIMIT change
        renderResults();
        log("Expand toggled:", isExpanded);
      });

      document
        .getElementById("randomize-btn")
        .addEventListener("click", () => randomizeResults());

      document.getElementById("cluster-btn").addEventListener("click", () => {
        if (!window.__toggleClusterMode) {
          logErr("Cluster module not ready.");
          return;
        }
        const isCluster = window.__toggleClusterMode();
        const btn = document.getElementById("cluster-btn");
        btn.classList.toggle("active", isCluster);
        btn.textContent = isCluster ? "📋 List" : "🗂 Clusters";
      });

      document.getElementById("copy-btn").addEventListener("click", () => {
        const btn = document.getElementById("copy-btn");
        try {
          const payload = JSON.stringify(filteredData, null, 2);
          navigator.clipboard.writeText(payload).then(() => {
            btn.textContent = "✅ Copied!";
            btn.classList.add("copied");
            setTimeout(() => {
              btn.textContent = "📋 Copy";
              btn.classList.remove("copied");
            }, 2000);
          });
        } catch (err) {
          logErr("Copy failed:", err);
        }
      });

      // Init both multiselects
      buildMultiselect("include");
      buildMultiselect("exclude");
      document
        .getElementById("ms-include-input")
        .addEventListener("input", (e) => {
          log("Include codes input:", filters.includeCodes);
        });
      document
        .getElementById("ms-exclude-input")
        .addEventListener("input", (e) => {
          log("Exclude codes input:", filters.excludeCodes);
        });

      // Load persisted filters and re-render UI
      loadFiltersFromStorage().then(() => {
        applyFilters();

        ["include", "exclude"].forEach((k) => {
          const box = document.getElementById(`ms-${k}-box`);
          const input = document.getElementById(`ms-${k}-input`);

          // Clear existing tags
          box.querySelectorAll(".ms-tag").forEach((t) => t.remove());

          const arr =
            k === "include" ? filters.includeCodes : filters.excludeCodes;

          // Rebuild tags
          arr.forEach((code) => {
            const tag = document.createElement("span");
            tag.className = `ms-tag ${k}`;
            tag.innerHTML = `${code}<span class="ms-tag-remove" data-code="${code}">×</span>`;
            box.insertBefore(tag, input);
          });
        });
      });
    } catch (err) {
      logErr("Error in bindEvents:", err);
    }
  }

  // ====================== DATA LOADING ======================
  function loadData() {
    window.addEventListener("MISSAV_DATA_UPDATE", (event) => {
      const data = event.detail;
      // if (!Array.isArray(data)) return;
      currentData = data;
      log(
        "[MISSAV_DATA_UPDATE] 🔄 Data CHANGED →",
        currentData.length,
        "items",
      );
      log("[MISSAV_DATA_UPDATE]", currentData);
      filteredData = [...currentData];
      applyFilters();
    });
  }

  // ====================== FILTERING ======================
  function applyFilters() {
    try {
      isRandomized = false;
      filteredData = currentData.filter((item) => {
        if (
          filters.text &&
          !(item.text || "").toLowerCase().includes(filters.text)
        )
          return false;
        const code = (item.code || "").toLowerCase();
        if (filters.includeCodes.length && !filters.includeCodes.includes(code))
          return false;
        if (filters.excludeCodes.length && filters.excludeCodes.includes(code))
          return false;
        return true;
      });
      renderResults();
    } catch (err) {
      logErr("Error in applyFilters:", err);
    }
  }

  // ====================== RANDOMIZE ======================
  function randomizeResults() {
    const shuffled = [...filteredData];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    filteredData = shuffled;
    isRandomized = true;
    renderResults();
  }

  // ====================== RENDERING ======================
  function renderResults() {
    try {
      log("Rendering results...");
      if (!resultsList || !resultsCount) {
        log(
          "renderResults: resultsList or resultsCount missing, aborting render",
        );
        return;
      }
      if (window.__isClusterMode && window.__isClusterMode()) {
        log(
          "renderResults: Cluster mode detected, delegating to window.__renderClusters",
        );
        window.__renderClusters && window.__renderClusters();
        return;
      }
      const limit = isExpanded ? DISPLAY_LIMIT_EXPANDED : DISPLAY_LIMIT;
      const showingCount = Math.min(filteredData.length, limit);
      log(
        `renderResults: Displaying ${showingCount} of ${filteredData.length} result${filteredData.length !== 1 ? "s" : ""}` +
          ` (limit: ${limit}, isExpanded: ${isExpanded})`,
      );
      resultsCount.textContent = `Showing ${showingCount} of ${filteredData.length} result${filteredData.length !== 1 ? "s" : ""}`;

      if (!filteredData.length) {
        log("renderResults: No matching results to show");
        resultsList.innerHTML =
          '<div class="empty-state">No matching results</div>';
        return;
      }
      resultsList.innerHTML = filteredData
        .slice(0, limit)
        .map(createCardHTML)
        .join("");
      log(`renderResults: Rendered ${showingCount} result cards`);
      attachCardEvents();
    } catch (err) {
      logErr("Error in renderResults:", err);
    }
  }

  function createCardHTML(item) {
    try {
      const thumbnail = item.thumbnail || "";
      const preview = item.preview || "";
      const text = item.text || "Untitled";
      const videoId = item.videoId || "N/A";
      const code = item.code || "N/A";
      const episode = item.episode || "N/A";
      const url = item.url || "#";
      const encodedUrl = url.replace(/'/g, "\\'");
      return `
        <div class="result-card" data-url="${encodedUrl}" data-preview="${preview}">
          <div class="thumbnail-container">
            ${
              thumbnail
                ? `<img src="${thumbnail}" alt="${text}" loading="lazy"/>`
                : '<div style="width:100%;height:100%;background:#0f3460;"></div>'
            }
            ${preview ? `<video src="${preview}" muted loop preload="none"></video>` : ""}
          </div>
          <div class="card-info">
            <div class="card-title" title="${text}">${text}</div>
            <div class="card-meta"><strong>ID:</strong> ${videoId}</div>
            <div class="card-meta"><strong>Code:</strong> ${code}</div>
            <div class="card-meta"><strong>Ep:</strong> ${episode}</div>
          </div>
        </div>`;
    } catch (err) {
      logErr("Error in createCardHTML:", err);
      return `<div class="result-card">Error loading card</div>`;
    }
  }

  function attachCardEvents() {
    const cards = resultsList.querySelectorAll(".result-card");
    cards.forEach((card, idx) => {
      const video = card.querySelector("video");
      const previewUrl = card.dataset.preview;
      const targetUrl = card.dataset.url;
      card.addEventListener("click", () => {
        if (targetUrl && targetUrl !== "#") window.open(targetUrl, "_blank");
      });
      if (video && previewUrl) {
        card.addEventListener("mouseenter", () => video.play().catch(() => {}));
        card.addEventListener("mouseleave", () => {
          video.pause();
          video.currentTime = 0;
        });
      }
    });
  }

  // ====================== DRAGGABLE ======================
  function makeDraggable() {
    const header = document.getElementById("panel-drag-handle");
    if (!header) return;
    let isDragging = false,
      offsetX,
      offsetY;
    header.addEventListener("mousedown", (e) => {
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      panel.style.cursor = "grabbing";
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const maxX = window.innerWidth - panel.offsetWidth;
      const maxY = window.innerHeight - panel.offsetHeight;
      panel.style.left =
        Math.max(0, Math.min(e.clientX - offsetX, maxX)) + "px";
      panel.style.right = "auto";
      panel.style.top = Math.max(0, Math.min(e.clientY - offsetY, maxY)) + "px";
    });
    document.addEventListener("mouseup", () => {
      isDragging = false;
      panel.style.cursor = "";
    });
  }

  // ====================== TOGGLE PANEL ======================
  function togglePanel(show) {
    if (show) {
      panel.style.display = "flex";
      toggleBtn.style.display = "none";
      if (window.__MISSAV_DATA__) {
        currentData = window.__MISSAV_DATA__;
        applyFilters();
      }
    } else {
      panel.style.display = "none";
      toggleBtn.style.display = "flex";
    }
  }

  // ====================== DATA WATCHER ======================
  function watchDataChanges() {
    setInterval(() => {
      try {
        if (window.__MISSAV_DATA__ && Array.isArray(window.__MISSAV_DATA__)) {
          const newData = window.__MISSAV_DATA__;
          if (JSON.stringify(newData) !== JSON.stringify(currentData)) {
            currentData = newData;
            if (!isRandomized) applyFilters();
            else renderResults();
          }
        }
      } catch (err) {
        logErr("Error in watcher:", err);
      }
    }, 2000);
  }

  // ====================== INIT ======================
  function init() {
    if (!window.location.href.includes("/search")) return;
    createPanel();
    const clusterJs = (window.__MISSAV_EXT_URLS__ || {}).clusterJs;
    if (!clusterJs) logErr("clusterJs missing — cluster button will not work.");
    if (typeof window.__initCluster === "function") {
      const currentDataRef = {
        get value() {
          return currentData;
        },
      };
      window.__initCluster({
        resultsList,
        resultsCount,
        currentDataRef,
        filtersRef: filters,
        createCardHTML,
        attachCardEvents,
        renderList: renderResults,
      });
    }
    watchDataChanges();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
