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
    const box = document.getElementById(`ms-${kind}-box`);
    const input = document.getElementById(`ms-${kind}-input`);
    const dropdown = document.getElementById(`ms-${kind}-dropdown`);
    const tagClass = kind; // css class "include" or "exclude"
    const arr =
      kind === "include" ? filters.includeCodes : filters.excludeCodes;

    // ── render tags ──
    function renderTags() {
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
      const allCodes = [
        ...new Set(
          currentData.map((i) => (i.code || "").toLowerCase()).filter(Boolean),
        ),
      ].sort();
      const q = query.toLowerCase();
      const matches = allCodes.filter(
        (c) => (!q || c.includes(q)) && !arr.includes(c),
      );
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
      dropdown.classList.remove("open");
    }

    function addCode(code) {
      const c = code.toLowerCase().trim();
      if (!c || arr.includes(c)) return;
      // Can't be in both lists simultaneously
      const other =
        kind === "include" ? filters.excludeCodes : filters.includeCodes;
      const otherIdx = other.indexOf(c);
      if (otherIdx !== -1) other.splice(otherIdx, 1);
      arr.push(c);
      input.value = "";
      renderTags();
      closeDropdown();
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
    }

    function removeCode(code) {
      const idx = arr.indexOf(code);
      if (idx !== -1) arr.splice(idx, 1);
      renderTags();
      applyFilters();
    }

    // ── events ──
    input.addEventListener("input", () => openDropdown(input.value));
    input.addEventListener("focus", () => openDropdown(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const focused = dropdown.querySelector(".ms-option.focused");
        if (focused) addCode(focused.dataset.code);
        else if (input.value.trim()) addCode(input.value.trim());
      }
      if (e.key === "Backspace" && !input.value && arr.length) {
        removeCode(arr[arr.length - 1]);
      }
      if (e.key === "Escape") closeDropdown();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
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
      }
    });

    dropdown.addEventListener("mousedown", (e) => {
      const opt = e.target.closest(".ms-option");
      if (opt) {
        e.preventDefault();
        addCode(opt.dataset.code);
      }
    });

    box.addEventListener("mousedown", (e) => {
      const rm = e.target.closest(".ms-tag-remove");
      if (rm) {
        e.preventDefault();
        removeCode(rm.dataset.code);
        return;
      }
      // Click on box but not on input → focus input
      if (e.target !== input) {
        e.preventDefault();
        input.focus();
      }
    });

    document.addEventListener("click", (e) => {
      if (!box.contains(e.target) && !dropdown.contains(e.target)) {
        closeDropdown();
      }
    });
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
        document.getElementById("expand-btn").textContent = isExpanded
          ? "⛶"
          : "⛶";
        document.getElementById("expand-btn").title = isExpanded
          ? "Shrink panel"
          : "Expand panel";
        // Re-render to apply DISPLAY_LIMIT change
        renderResults();
        log("Expand toggled:", isExpanded);
      });

      document.getElementById("filter-text").addEventListener("input", (e) => {
        filters.text = e.target.value.toLowerCase();
        applyFilters();
      });

      document
        .getElementById("clear-filters-btn")
        .addEventListener("click", () => {
          document.getElementById("filter-text").value = "";
          filters.text = "";
          filters.includeCodes.length = 0;
          filters.excludeCodes.length = 0;
          // Re-render both multiselect tag areas
          ["include", "exclude"].forEach((k) => {
            const box = document.getElementById(`ms-${k}-box`);
            const input = document.getElementById(`ms-${k}-input`);
            box.querySelectorAll(".ms-tag").forEach((t) => t.remove());
            input.value = "";
          });
          isRandomized = false;
          applyFilters();
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
    } catch (err) {
      logErr("Error in bindEvents:", err);
    }
  }

  // ====================== DATA LOADING ======================
  function loadData() {
    window.addEventListener("MISSAV_DATA_UPDATE", (event) => {
      const data = event.detail;
      if (!Array.isArray(data)) return;
      currentData = data;
      filteredData = [...currentData];
      renderResults();
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
      if (!resultsList || !resultsCount) return;
      if (window.__isClusterMode && window.__isClusterMode()) {
        window.__renderClusters && window.__renderClusters();
        return;
      }
      const limit = isExpanded ? DISPLAY_LIMIT_EXPANDED : DISPLAY_LIMIT;
      const showingCount = Math.min(filteredData.length, limit);
      resultsCount.textContent = `Showing ${showingCount} of ${filteredData.length} result${filteredData.length !== 1 ? "s" : ""}`;

      if (!filteredData.length) {
        resultsList.innerHTML =
          '<div class="empty-state">No matching results</div>';
        return;
      }
      resultsList.innerHTML = filteredData
        .slice(0, limit)
        .map(createCardHTML)
        .join("");
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
