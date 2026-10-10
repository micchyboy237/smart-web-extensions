// content.js
const LOG_PREFIX = "[VidMon-CS]";
const DEBUG = true;

function log(...args) {
  if (DEBUG) console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  if (DEBUG) console.warn(LOG_PREFIX, ...args);
}

function error(...args) {
  console.error(LOG_PREFIX, ...args);
}

const trackedVideos = new Map();
const activeFetchControllers = new Map();
let observer;

// --- Panel State ---
let panelContainer = null;
let panelInitialized = false;

log("🚀 Content script loading...");
log(`   → Page URL: ${window.location.href}`);
log(`   → Document readyState: ${document.readyState}`);

// --- Feature 1: Live Download Progress via MutationObserver ---
function initObserver() {
  log("🔍 [OBSERVER] Initializing MutationObserver...");
  observer = new MutationObserver((mutations) => {
    // log(`🔍 [OBSERVER] Mutation detected: ${mutations.length} mutations`); // Reduced noise
    let videosFound = 0;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === "VIDEO") {
          // log(`🎥 [OBSERVER] Direct video element added`);
          trackVideo(node);
          videosFound++;
        }
        const nestedVideos = node.querySelectorAll?.("video");
        if (nestedVideos && nestedVideos.length > 0) {
          // log(`🎥 [OBSERVER] Found ${nestedVideos.length} nested video(s)`);
          nestedVideos.forEach((video) => {
            trackVideo(video);
            videosFound++;
          });
        }
      }
    }
    if (videosFound > 0) {
      log(`✅ [OBSERVER] Tracked ${videosFound} new video(s)`);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  log("✅ [OBSERVER] MutationObserver initialized");

  // Track existing videos
  const existingVideos = document.querySelectorAll("video");
  log(`📊 [OBSERVER] Found ${existingVideos.length} existing video(s) on page`);
  existingVideos.forEach((video, index) => {
    trackVideo(video);
  });
}

function trackVideo(video) {
  if (trackedVideos.has(video)) {
    return;
  }
  const id = crypto.randomUUID();
  trackedVideos.set(video, id);
  log(`🎥 [TRACK] Started tracking video ID: ${id.substring(0, 8)}...`);

  const getSourceName = () => {
    if (video.currentSrc) return video.currentSrc;
    if (video.src) return video.src;
    const sources = video.querySelectorAll("source");
    if (sources.length > 0) return sources[0].src;
    return "Unknown Source";
  };

  const sourceName = getSourceName();
  log(`   → Source: ${sourceName.substring(0, 100)}...`);

  const onProgress = () => {
    if (!video.buffered.length) {
      return;
    }
    const bufferedEnd = video.buffered.end(video.buffered.length - 1);
    const duration = video.duration || 0;
    const percent =
      duration > 0 ? ((bufferedEnd / duration) * 100).toFixed(2) : 0;
    const currentSource = getSourceName();

    // Throttle logging if needed, but for now keep it
    // log(`📊 [PROGRESS] ${percent}% | ${bufferedEnd.toFixed(1)}s / ${duration.toFixed(1)}s`);

    chrome.runtime
      .sendMessage({
        type: "VIDEO_PROGRESS",
        data: {
          id,
          src: currentSource,
          percent,
          bufferedSeconds: bufferedEnd,
          duration,
        },
      })
      .catch((err) => {
        // Ignore errors if background is gone
      });
  };

  video.addEventListener("progress", onProgress);
  video.addEventListener("loadedmetadata", onProgress);
  video.addEventListener("loadstart", onProgress);

  // Initial progress check
  onProgress();
}

// --- Feature 2: Cancel Ongoing Fetch Downloads ---
log(`🔄 [FETCH] Intercepting window.fetch...`);
const originalFetch = window.fetch;
window.fetch = async function (...args) {
  const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
  const isVideo =
    /\.(mp4|webm|mov|m3u8|ts)(\?|$)/i.test(url) || url.includes("video");

  if (isVideo) {
    log(`🎬 [FETCH] Video fetch detected: ${url.substring(0, 100)}...`);
    const controller = new AbortController();
    const fetchId = crypto.randomUUID();
    activeFetchControllers.set(fetchId, controller);

    chrome.runtime
      .sendMessage({
        type: "FETCH_STARTED",
        data: { fetchId, url },
      })
      .catch(() => {});

    const options = args[1] || {};
    options.signal = controller.signal;

    try {
      const response = await originalFetch(args[0], options);
      activeFetchControllers.delete(fetchId);

      chrome.runtime
        .sendMessage({
          type: "FETCH_COMPLETED",
          data: { fetchId },
        })
        .catch(() => {});

      return response;
    } catch (err) {
      activeFetchControllers.delete(fetchId);
      if (err.name === "AbortError") {
        log(`🚫 [FETCH] Fetch aborted: ${fetchId.substring(0, 8)}...`);
        chrome.runtime
          .sendMessage({
            type: "FETCH_CANCELLED",
            data: { fetchId },
          })
          .catch(() => {});
      }
      throw err;
    }
  }
  return originalFetch.apply(this, args);
};
log(`✅ [FETCH] Fetch interception setup complete`);

// --- Panel Injection Logic (Merged from panel-injector.js) ---

function getPanelHTML() {
  return `
    <div class="panel-header">
      <span>📺 VidMon Live</span>
      <button id="panel-close-btn" aria-label="Close panel">&times;</button>
    </div>
    <div class="panel-content">
      <!-- Section 1: Live Downloads -->
      <div>
        <h4 class="section-title">Live Downloads</h4>
        <div id="panel-video-list">
          <div class="empty-state">Scanning for videos...</div>
        </div>
      </div>
      <!-- Section 2: Actions -->
      <div class="action-buttons">
        <button id="btn-save-active" class="action-btn">Save Active</button>
        <button id="btn-play-offline" class="action-btn">Play Offline</button>
      </div>
      <div id="panel-status"></div>
      <!-- Section 3: Cache Info -->
      <div class="cache-info">
        <div class="cache-row">
          <span class="cache-label">Cache Used:</span>
          <strong id="panel-cache-used" class="cache-value">0 Bytes</strong>
        </div>
        <div class="cache-row">
          <button id="btn-clear-cache">Clear Cache</button>
        </div>
      </div>
    </div>
  `;
}

async function togglePanel() {
  log(`🔄 [TOGGLE] togglePanel() called`);

  if (panelContainer) {
    const isVisible = panelContainer.classList.contains("visible");
    if (isVisible) {
      panelContainer.classList.remove("visible");
      log(`✅ [TOGGLE] Panel hidden`);
    } else {
      panelContainer.classList.add("visible");
      log(`✅ [TOGGLE] Panel shown`);
      if (!panelInitialized) {
        initializePanelLogic();
      }
    }
  } else {
    log(`⚠️ [TOGGLE] Panel container not found, injecting new panel...`);
    await injectPanel();
  }
}

async function injectPanel() {
  log(`💉 [INJECT] Starting panel injection...`);
  try {
    if (!document.body) {
      log(`⏳ [INJECT] document.body not ready, waiting...`);
      await new Promise((resolve) => {
        const checkBody = () => {
          if (document.body) {
            resolve();
          } else {
            setTimeout(checkBody, 50);
          }
        };
        checkBody();
      });
    }

    panelContainer = document.createElement("div");
    panelContainer.id = "vidmon-floating-panel";
    panelContainer.innerHTML = getPanelHTML();

    document.body.appendChild(panelContainer);
    panelContainer.classList.add("visible");

    log(`✅ [INJECT] Panel appended to DOM`);

    // Setup close button
    const closeBtn = panelContainer.querySelector("#panel-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        panelContainer.classList.remove("visible");
      });
    }

    // Make draggable
    makeDraggable(panelContainer);

    // Initialize logic
    initializePanelLogic();
  } catch (err) {
    error(`❌ [INJECT] Failed to inject panel:`, err);
  }
}

function initializePanelLogic() {
  if (panelInitialized) return;
  log(`⚙️ [INIT] Setting up panel event listeners...`);

  // Save Active
  const saveBtn = document.getElementById("btn-save-active");
  if (saveBtn) saveBtn.addEventListener("click", handleSaveActive);

  // Play Offline
  const playBtn = document.getElementById("btn-play-offline");
  if (playBtn) playBtn.addEventListener("click", handlePlayOffline);

  // Clear Cache
  const clearBtn = document.getElementById("btn-clear-cache");
  if (clearBtn) clearBtn.addEventListener("click", handleClearCache);

  // Listen for updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "UPDATE_DOWNLOADS") {
      renderVideos(msg.data);
    }
  });

  // Initial Load
  loadState();
  loadCacheInfo();

  panelInitialized = true;
  log(`✅ [INIT] Panel initialization complete`);
}

async function handleSaveActive() {
  const statusEl = document.getElementById("panel-status");
  if (!statusEl) return;

  statusEl.textContent = "⏳ Getting state...";
  statusEl.className = "loading";

  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) =>
        resolve(response),
      );
    });

    if (!res || !res.downloads || Object.keys(res.downloads).length === 0) {
      statusEl.textContent = "❌ No videos detected.";
      statusEl.className = "error";
      return;
    }

    const firstKey = Object.keys(res.downloads)[0];
    const url = res.downloads[firstKey].src;

    if (!url) {
      statusEl.textContent = "❌ No URL found.";
      statusEl.className = "error";
      return;
    }

    statusEl.textContent = "💾 Saving...";
    statusEl.className = "loading";

    chrome.runtime.sendMessage(
      { type: "SAVE_VIDEO_OFFLINE", data: { url } },
      (response) => {
        if (response?.success) {
          statusEl.textContent = "✅ Saved!";
          statusEl.className = "success";
          loadCacheInfo();
          setTimeout(() => {
            statusEl.textContent = "";
            statusEl.className = "";
          }, 3000);
        } else {
          statusEl.textContent = "❌ Failed: " + (response?.error || "Unknown");
          statusEl.className = "error";
        }
      },
    );
  } catch (err) {
    error(`❌ [SAVE] Error:`, err);
    statusEl.textContent = "❌ Error: " + err.message;
    statusEl.className = "error";
  }
}

function handlePlayOffline() {
  const playerUrl = chrome.runtime.getURL("player.html");
  chrome.tabs.create({ url: playerUrl });
}

function handleClearCache() {
  const statusEl = document.getElementById("panel-status");
  if (statusEl) {
    statusEl.textContent = "🗑️ Clearing cache...";
    statusEl.className = "loading";
  }

  chrome.runtime.sendMessage({ type: "CLEAR_CACHE" }, (response) => {
    loadCacheInfo();
    if (statusEl) {
      statusEl.textContent = "✅ Cache Cleared";
      statusEl.className = "success";
      setTimeout(() => {
        statusEl.textContent = "";
        statusEl.className = "";
      }, 2000);
    }
  });
}

function loadState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
    if (res && res.downloads) {
      renderVideos(res.downloads);
    }
  });
}

function loadCacheInfo() {
  chrome.runtime.sendMessage({ type: "GET_CACHE_INFO" }, (info) => {
    const cacheUsedEl = document.getElementById("panel-cache-used");
    if (cacheUsedEl) {
      if (info && !info.error) {
        cacheUsedEl.textContent = info.formattedCache;
      } else {
        cacheUsedEl.textContent = "Error";
      }
    }
  });
}

function renderVideos(videos) {
  const el = document.getElementById("panel-video-list");
  if (!el) return;

  const entries = Object.values(videos || {});
  if (!entries.length) {
    el.innerHTML = '<div class="empty-state">No active downloads</div>';
    return;
  }

  el.innerHTML = entries
    .map((v) => {
      const filename = v.src ? v.src.split("/").pop().split("?")[0] : "Unknown";
      const displayName =
        filename.length > 30 ? filename.substring(0, 27) + "..." : filename;
      return `
      <div class="video-item">
        <div class="video-name">${escapeHtml(displayName)}</div>
        <div class="video-progress-text">
          ${v.percent}% · ${formatTime(v.bufferedSeconds)}/${formatTime(v.duration)}
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar-fill" style="width: ${Math.min(v.percent, 100)}%;"></div>
        </div>
      </div>
    `;
    })
    .join("");
}

function formatTime(s) {
  if (!s || !isFinite(s)) return "0:00";
  const minutes = Math.floor(s / 60);
  const seconds = Math.floor(s % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function makeDraggable(elmnt) {
  let pos1 = 0,
    pos2 = 0,
    pos3 = 0,
    pos4 = 0;
  const header = elmnt.querySelector(".panel-header");
  if (header) {
    header.onmousedown = dragMouseDown;
    header.ontouchstart = dragTouchStart;
  }

  function dragMouseDown(e) {
    e = e || window.event;
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function dragTouchStart(e) {
    const touch = e.touches[0];
    pos3 = touch.clientX;
    pos4 = touch.clientY;
    document.ontouchend = closeDragElement;
    document.ontouchmove = elementTouchDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    elmnt.style.top = elmnt.offsetTop - pos2 + "px";
    elmnt.style.left = elmnt.offsetLeft - pos1 + "px";
    elmnt.style.right = "auto";
  }

  function elementTouchDrag(e) {
    const touch = e.touches[0];
    pos1 = pos3 - touch.clientX;
    pos2 = pos4 - touch.clientY;
    pos3 = touch.clientX;
    pos4 = touch.clientY;
    elmnt.style.top = elmnt.offsetTop - pos2 + "px";
    elmnt.style.left = elmnt.offsetLeft - pos1 + "px";
    elmnt.style.right = "auto";
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
    document.ontouchend = null;
    document.ontouchmove = null;
  }
}

// --- Message Listener for Panel Toggle and Fetch Cancellation ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TOGGLE_PANEL") {
    log(`🎯 [MSG] TOGGLE_PANEL command received`);
    togglePanel();
    sendResponse({ received: true });
  }
  if (msg.type === "CANCEL_FETCH") {
    log(`🚫 [MSG] CANCEL_FETCH command received`);
    const controller = activeFetchControllers.get(msg.fetchId);
    if (controller) {
      controller.abort();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "Controller not found" });
    }
  }
});

// Initialize observer
initObserver();
log("✅ Content script loaded successfully");
