(function () {
  "use strict";

  const LOG_PREFIX = "[PANEL]";

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }
  function logErr(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  // Wait for data to be available
  let dataCheckInterval = null;
  let currentData = [];
  let filteredData = [];
  let isRandomized = false;
  const DISPLAY_LIMIT = 10;

  // Filter state
  const filters = {
    text: "",
    videoId: "",
    code: "",
    episode: "",
  };

  // Panel elements
  let panel = null;
  let toggleBtn = null;
  let resultsList = null;
  let resultsCount = null;

  // ====================== PANEL CREATION ======================
  function createPanel() {
    log("Attempting to create panel ...");
    if (document.getElementById("missav-faststream-panel")) {
      log("Panel already exists, skipping creation.");
      return;
    }

    try {
      // Create toggle button
      toggleBtn = document.createElement("button");
      toggleBtn.id = "missav-faststream-toggle";
      toggleBtn.innerHTML = "📋";
      toggleBtn.title = "Show FastStream Panel";
      toggleBtn.onclick = () => togglePanel(true);
      document.body.appendChild(toggleBtn);
      log("Toggle button created and appended.");

      // Create panel
      panel = document.createElement("div");
      panel.id = "missav-faststream-panel";
      panel.innerHTML = `
          <div class="panel-header" id="panel-drag-handle">
            <h3>🎬 MissAV FastStream</h3>
            <button id="panel-close-btn" title="Collapse">−</button>
          </div>
          <div class="filter-section">
            <input type="text" class="filter-input" id="filter-text" placeholder="🔍 Search by title..." />
            <div class="filter-row">
              <input type="text" class="filter-input" id="filter-videoid" placeholder="Video ID (e.g., mxgs-893)" />
              <input type="text" class="filter-input" id="filter-code" placeholder="Code (e.g., mxgs)" />
            </div>
            <div class="filter-row">
              <input type="text" class="filter-input" id="filter-episode" placeholder="Episode (e.g., 893)" />
            </div>
            <div class="action-bar">
              <button class="action-btn" id="clear-filters-btn">🗑️ Clear</button>
              <button class="action-btn randomize" id="randomize-btn">🎲 Randomize</button>
            </div>
          </div>
          <div class="results-count" id="results-count">0 results</div>
          <div class="results-list" id="results-list">
            <div class="empty-state">Loading data...</div>
          </div>
        `;
      document.body.appendChild(panel);
      log("Panel created and appended.");

      // Store references
      resultsList = document.getElementById("results-list");
      resultsCount = document.getElementById("results-count");
      if (!resultsList || !resultsCount) {
        logErr("Could not get resultsList or resultsCount elements.");
      }

      // Bind events
      bindEvents();

      // Make panel draggable
      makeDraggable();

      // Initial data load
      loadData();
    } catch (err) {
      logErr("Error in createPanel:", err);
    }
  }

  // ====================== EVENT BINDING ======================
  function bindEvents() {
    log("Binding panel events ...");
    try {
      // Close/collapse button
      document
        .getElementById("panel-close-btn")
        .addEventListener("click", () => {
          log("Close/collapse button clicked");
          togglePanel(false);
        });

      // Filter inputs
      document.getElementById("filter-text").addEventListener("input", (e) => {
        filters.text = e.target.value.toLowerCase();
        log("Text filter input:", filters.text);
        applyFilters();
      });

      document
        .getElementById("filter-videoid")
        .addEventListener("input", (e) => {
          filters.videoId = e.target.value.toLowerCase();
          log("Video ID filter input:", filters.videoId);
          applyFilters();
        });

      document.getElementById("filter-code").addEventListener("input", (e) => {
        filters.code = e.target.value.toLowerCase();
        log("Code filter input:", filters.code);
        applyFilters();
      });

      document
        .getElementById("filter-episode")
        .addEventListener("input", (e) => {
          filters.episode = e.target.value.toLowerCase();
          log("Episode filter input:", filters.episode);
          applyFilters();
        });

      // Clear filters
      document
        .getElementById("clear-filters-btn")
        .addEventListener("click", () => {
          document.getElementById("filter-text").value = "";
          document.getElementById("filter-videoid").value = "";
          document.getElementById("filter-code").value = "";
          document.getElementById("filter-episode").value = "";
          filters.text = "";
          filters.videoId = "";
          filters.code = "";
          filters.episode = "";
          isRandomized = false;
          log("Clear filters button clicked. All filters cleared.");
          applyFilters();
        });

      // Randomize button
      document.getElementById("randomize-btn").addEventListener("click", () => {
        log("Randomize button clicked.");
        randomizeResults();
      });
    } catch (err) {
      logErr("Error in bindEvents:", err);
    }
  }

  // ====================== DATA LOADING ======================
  function loadData() {
    log("Loading data ...");
    try {
      log("Listening for MISSAV data events...");

      window.addEventListener("MISSAV_DATA_UPDATE", (event) => {
        const data = event.detail;
        if (!Array.isArray(data)) return;

        log("Received MISSAV data via event:", data.length, "items");

        currentData = data;
        filteredData = [...currentData];
        renderResults();
      });
    } catch (err) {
      logErr("Error in loadData:", err);
    }
  }

  function waitForData() {
    log("Starting data wait interval...");
    let attempts = 0;
    const maxAttempts = 50;

    dataCheckInterval = setInterval(() => {
      try {
        if (window.__MISSAV_DATA__ && Array.isArray(window.__MISSAV_DATA__)) {
          clearInterval(dataCheckInterval);
          log("MISSAV data found after waiting", attempts + 1, "attempt(s).");
          currentData = window.__MISSAV_DATA__;
          filteredData = [...currentData];
          renderResults();
        } else if (attempts++ > maxAttempts) {
          clearInterval(dataCheckInterval);
          logErr("No MISSAV data found after", maxAttempts, "attempts.");
          if (resultsList) {
            resultsList.innerHTML =
              '<div class="empty-state">No data found. Try refreshing the page.</div>';
          }
        } else {
          if (attempts % 10 === 0)
            log("Waiting for data... Attempt:", attempts);
        }
      } catch (err) {
        logErr("Error during data wait interval:", err);
        clearInterval(dataCheckInterval);
      }
    }, 200);
  }

  // ====================== FILTERING ======================
  function applyFilters() {
    try {
      log("Applying filters:", JSON.stringify(filters));

      // Reset randomization when filters change
      isRandomized = false;

      filteredData = currentData.filter((item) => {
        // Text filter (searches in title/text field)
        if (
          filters.text &&
          !(item.text || "").toLowerCase().includes(filters.text)
        ) {
          return false;
        }

        // Video ID filter
        if (
          filters.videoId &&
          !(item.videoId || "").toLowerCase().includes(filters.videoId)
        ) {
          return false;
        }

        // Code filter
        if (
          filters.code &&
          !(item.code || "").toLowerCase().includes(filters.code)
        ) {
          return false;
        }

        // Episode filter
        if (
          filters.episode &&
          !(item.episode || "").toLowerCase().includes(filters.episode)
        ) {
          return false;
        }

        return true;
      });

      log("Filter result count:", filteredData.length);
      renderResults();
    } catch (err) {
      logErr("Error in applyFilters:", err);
    }
  }

  // ====================== RANDOMIZE ======================
  function randomizeResults() {
    try {
      log("Randomizing current filtered results. Count:", filteredData.length);
      // Create a fresh shuffled copy (no mutation bugs)
      const shuffled = [...filteredData];

      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      filteredData = shuffled;
      isRandomized = true;

      log("Results randomized (fresh shuffle).");
      renderResults();
    } catch (err) {
      logErr("Error in randomizeResults:", err);
    }
  }

  // ====================== RENDERING ======================
  function renderResults() {
    try {
      if (!resultsList || !resultsCount) {
        logErr(
          "renderResults: elements missing. resultsList:",
          !!resultsList,
          "resultsCount:",
          !!resultsCount,
        );
        return;
      }

      const showingCount = Math.min(filteredData.length, DISPLAY_LIMIT);
      resultsCount.textContent = `Showing ${showingCount} of ${filteredData.length} result${filteredData.length !== 1 ? "s" : ""}`;

      if (filteredData.length === 0) {
        resultsList.innerHTML =
          '<div class="empty-state">No matching results</div>';
        log("No matching results to display.");
        return;
      }

      const displayData = filteredData.slice(0, DISPLAY_LIMIT);
      const html = displayData.map((item) => createCardHTML(item)).join("");

      resultsList.innerHTML = html;
      log("Rendered", filteredData.length, "results.");

      // Attach event listeners to each card
      attachCardEvents();
    } catch (err) {
      logErr("Error while rendering results:", err);
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

      // Escape URL for data attribute
      const encodedUrl = url.replace(/'/g, "\\'");

      return `
          <div class="result-card" data-url="${encodedUrl}" data-preview="${preview}">
            <div class="thumbnail-container">
              ${thumbnail ? `<img src="${thumbnail}" alt="${text}" loading="lazy" />` : '<div style="width:100%;height:100%;background:#0f3460;"></div>'}
              ${preview ? `<video src="${preview}" muted loop preload="none"></video>` : ""}
            </div>
            <div class="card-info">
              <div class="card-title" title="${text}">${text}</div>
              <div class="card-meta"><strong>ID:</strong> ${videoId}</div>
              <div class="card-meta"><strong>Code:</strong> ${code}</div>
              <div class="card-meta"><strong>Ep:</strong> ${episode}</div>
            </div>
          </div>
        `;
    } catch (err) {
      logErr("Error in createCardHTML:", err);
      return `<div class="result-card">Error loading card</div>`;
    }
  }

  function attachCardEvents() {
    try {
      const cards = resultsList.querySelectorAll(".result-card");
      log("Attaching events to", cards.length, "result cards.");

      cards.forEach((card, idx) => {
        const video = card.querySelector("video");
        const previewUrl = card.dataset.preview;
        const targetUrl = card.dataset.url;

        // Click to open URL
        card.addEventListener("click", (e) => {
          // Don't trigger if clicking on video controls (not applicable here)
          if (targetUrl && targetUrl !== "#") {
            log("Card", idx, "clicked, opening URL:", targetUrl);
            window.open(targetUrl, "_blank");
          }
        });

        // Hover to play preview MP4
        if (video && previewUrl) {
          card.addEventListener("mouseenter", () => {
            log("Card", idx, "mouseenter: playing preview");
            video.play().catch((err) => {
              logErr("Autoplay blocked or error:", err);
            });
          });

          card.addEventListener("mouseleave", () => {
            log("Card", idx, "mouseleave: pausing preview");
            video.pause();
            video.currentTime = 0;
          });
        }
      });
    } catch (err) {
      logErr("Error in attachCardEvents:", err);
    }
  }

  // ====================== DRAGGABLE PANEL ======================
  function makeDraggable() {
    try {
      const header = document.getElementById("panel-drag-handle");
      if (!header) {
        logErr("Panel drag handle not found!");
        return;
      }

      let isDragging = false;
      let offsetX, offsetY;

      header.addEventListener("mousedown", (e) => {
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        panel.style.cursor = "grabbing";
        log("Panel drag started.");
      });

      document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;

        const x = e.clientX - offsetX;
        const y = e.clientY - offsetY;

        // Keep panel within viewport
        const maxX = window.innerWidth - panel.offsetWidth;
        const maxY = window.innerHeight - panel.offsetHeight;

        panel.style.left = Math.max(0, Math.min(x, maxX)) + "px";
        panel.style.right = "auto";
        panel.style.top = Math.max(0, Math.min(y, maxY)) + "px";
      });

      document.addEventListener("mouseup", () => {
        if (isDragging) {
          log("Panel drag ended.");
        }
        isDragging = false;
        panel.style.cursor = "";
      });
    } catch (err) {
      logErr("Error in makeDraggable:", err);
    }
  }

  // ====================== TOGGLE PANEL ======================
  function togglePanel(show) {
    try {
      if (show) {
        panel.style.display = "flex";
        toggleBtn.style.display = "none";
        log("Panel shown.");
        // Refresh data when showing
        if (window.__MISSAV_DATA__) {
          currentData = window.__MISSAV_DATA__;
          log("Reloading data on panel show.");
          applyFilters();
        }
      } else {
        panel.style.display = "none";
        toggleBtn.style.display = "flex";
        log("Panel hidden/collapsed.");
      }
    } catch (err) {
      logErr("Error in togglePanel:", err);
    }
  }

  // ====================== DATA WATCHER ======================
  function watchDataChanges() {
    try {
      log("Setting up data watcher interval.");
      // Check for data updates every 2 seconds
      setInterval(() => {
        try {
          if (window.__MISSAV_DATA__ && Array.isArray(window.__MISSAV_DATA__)) {
            const newData = window.__MISSAV_DATA__;
            // Simple length check to detect changes
            if (JSON.stringify(newData) !== JSON.stringify(currentData)) {
              log("MISSAV_DATA changed. Will refresh panel data.");
              currentData = newData;
              if (!isRandomized) {
                applyFilters();
              } else {
                // Keep randomization but update with new data
                log("Re-applying filters and re-randomizing results.");
                filteredData = currentData.filter((item) => {
                  if (
                    filters.text &&
                    !(item.text || "").toLowerCase().includes(filters.text)
                  )
                    return false;
                  if (
                    filters.videoId &&
                    !(item.videoId || "")
                      .toLowerCase()
                      .includes(filters.videoId)
                  )
                    return false;
                  if (
                    filters.code &&
                    !(item.code || "").toLowerCase().includes(filters.code)
                  )
                    return false;
                  if (
                    filters.episode &&
                    !(item.episode || "")
                      .toLowerCase()
                      .includes(filters.episode)
                  )
                    return false;
                  return true;
                });
                renderResults();
              }
            }
          }
        } catch (err) {
          logErr("Error in data watcher interval:", err);
        }
      }, 2000);
    } catch (err) {
      logErr("Error in watchDataChanges:", err);
    }
  }

  // ====================== INITIALIZATION ======================
  function init() {
    try {
      // Only run on search pages
      if (!window.location.href.includes("/search")) {
        log("Not a search page, panel will not initialize.");
        return;
      }
      log("Initializing MissAV FastStream panel ...");
      createPanel();
      watchDataChanges();
    } catch (err) {
      logErr("Error in init:", err);
    }
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
    log("Waiting for DOMContentLoaded event ...");
  } else {
    init();
  }
})();
