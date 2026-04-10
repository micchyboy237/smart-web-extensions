// content.js - Stable DOM + better preview + detailed logs
let videos = new Map(); // video element → entry
let videoCards = new Map(); // video element → card DOM element
let videoCounter = 0;
const SELECTOR = ".message-inner video";
let panel = null;
let isPanelVisible = true;
let updateTimeout = null;

function log(message, data = null) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[VideoObserver ${ts}] ${message}`, data || "");

  if (panel) {
    const logsEl = panel.querySelector("#logs");
    if (logsEl) {
      const entry = document.createElement("div");
      entry.textContent = `[${ts}] ${message}`;
      logsEl.prepend(entry);
      if (logsEl.children.length > 60) logsEl.removeChild(logsEl.lastChild);
    }
  }
}

function getVideoInfo(video) {
  return {
    id: video.dataset.videoObserverId || `video-${++videoCounter}`,
    src: video.currentSrc || video.src || "No source",
    currentTime: video.currentTime || 0,
    duration: video.duration || 0,
    paused: video.paused,
  };
}

function createSinglePreview(originalVideo, entryId) {
  log(`Creating preview video element for ${entryId}`);

  let videoUrl = originalVideo.currentSrc || originalVideo.src;
  if (videoUrl) {
    videoUrl += (videoUrl.includes("?") ? "&" : "?") + "t=0.8"; // skip more black frames
  }

  const preview = document.createElement("video");
  preview.src = videoUrl;
  preview.muted = true;
  preview.preload = "auto";
  preview.style.width = "100%";
  preview.style.height = "auto";
  preview.style.maxHeight = "96px";
  preview.style.objectFit = "cover";
  preview.style.borderRadius = "4px";
  preview.style.background = "#1a1a2e";
  preview.style.display = "block";

  let frameShown = false;

  const tryShowFrame = () => {
    if (frameShown) return;
    frameShown = true;
    preview.currentTime = 0.8;
    preview
      .play()
      .then(() => {
        setTimeout(() => {
          preview.pause();
          log(`Preview frame successfully forced for ${entryId}`);
        }, 280);
      })
      .catch((err) => {
        log(
          `Play failed for preview ${entryId}, falling back to seek`,
          err.message,
        );
        preview.currentTime = 1.5;
      });
  };

  preview.addEventListener(
    "loadeddata",
    () => {
      log(`loadeddata fired for preview ${entryId} - attempting frame`);
      tryShowFrame();
    },
    { once: true },
  );

  preview.addEventListener(
    "loadedmetadata",
    () => {
      log(`loadedmetadata for preview ${entryId}`);
    },
    { once: true },
  );

  // Safety timeout - replace placeholder if still loading after 4s
  setTimeout(() => {
    if (!frameShown) {
      log(`Preview timeout reached for ${entryId} - showing unavailable`);
      // We will handle replacement in update logic
    }
  }, 4200);

  return preview;
}

function createVideoCard(entry) {
  log(`Creating stable card DOM for ${entry.id}`);
  const card = document.createElement("div");
  card.className = "video-card";
  card.dataset.videoId = entry.id;

  card.innerHTML = `
     <div class="video-header">
       <strong>${entry.id}</strong>
       <span class="video-status ${entry.info.paused ? "paused" : "playing"}">
         ${entry.info.paused ? "⏸ Paused" : "▶ Playing"}
       </span>
     </div>
     <div class="preview-container">
       <div class="thumb-placeholder">Loading preview...</div>
     </div>
     <div class="video-src">
       ${entry.info.src.length > 70 ? entry.info.src.substring(0, 67) + "..." : entry.info.src}
     </div>
     <div class="video-meta">
       <span>Time: ${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s</span>
     </div>
   `;

  card.addEventListener("click", () => {
    const videoEl = entry.element;
    if (videoEl) {
      if (videoEl.paused) videoEl.play().catch(() => {});
      else videoEl.pause();
      videoEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  return card;
}

function updateExistingCard(card, entry) {
  // Update status
  const statusEl = card.querySelector(".video-status");
  if (statusEl) {
    statusEl.className = `video-status ${entry.info.paused ? "paused" : "playing"}`;
    statusEl.textContent = entry.info.paused ? "⏸ Paused" : "▶ Playing";
  }

  // Update time
  const timeSpan = card.querySelector(".video-meta span");
  if (timeSpan) {
    timeSpan.textContent = `Time: ${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s`;
  }

  // Replace placeholder with preview ONLY ONCE when ready
  const placeholder = card.querySelector(".thumb-placeholder");
  if (placeholder && entry.preview) {
    log(`Replacing placeholder with real preview for ${entry.id}`);
    const container = card.querySelector(".preview-container");
    if (container) {
      container.innerHTML = "";
      container.appendChild(entry.preview);
    }
  }
}

function trackVideo(video) {
  if (videos.has(video)) return;

  const id = `video-${++videoCounter}`;
  video.dataset.videoObserverId = id;

  const entry = {
    id,
    element: video,
    info: getVideoInfo(video),
    preview: null,
  };
  videos.set(video, entry);

  if (!video.dataset.volumeSet) {
    video.volume = 0.5;
    video.dataset.volumeSet = "true";
  }

  log(`New video detected`, {
    id,
    srcShort: (video.currentSrc || "").substring(0, 80) + "...",
  });

  const startPreview = () => {
    entry.preview = createSinglePreview(video, id);
    log(`Preview element created for ${id} - waiting for loadeddata`);
    throttledUpdatePanel();
  };

  if (video.readyState >= 2) {
    startPreview();
  } else {
    video.addEventListener("loadedmetadata", startPreview, { once: true });
  }

  const events = ["play", "pause", "ended", "timeupdate", "loadedmetadata"];
  events.forEach((ev) => {
    video.addEventListener(
      ev,
      () => {
        entry.info = getVideoInfo(video);
        throttledUpdatePanel();
      },
      { passive: true },
    );
  });
}

function throttledUpdatePanel() {
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = setTimeout(performPanelUpdate, 350);
}

function performPanelUpdate() {
  if (!panel) return;
  log("performPanelUpdate called");

  const list = panel.querySelector("#videos-list");
  const countEl = panel.querySelector("#video-count");
  const empty = panel.querySelector("#empty-videos");

  countEl.textContent = videos.size;
  if (videos.size === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  Array.from(videos.values()).forEach((entry) => {
    if (!videoCards.has(entry.element)) {
      const card = createVideoCard(entry);
      videoCards.set(entry.element, card);
      list.appendChild(card);
      log(`Added new stable card for ${entry.id}`);
    } else {
      const card = videoCards.get(entry.element);
      updateExistingCard(card, entry);
    }
  });
}

function observeVideos() {
  document.querySelectorAll(SELECTOR).forEach(trackVideo);
  throttledUpdatePanel();
}

function waitForBody(callback) {
  if (document.body) return callback();
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect();
      callback();
    }
  });
  observer.observe(document.documentElement, { childList: true });
  setTimeout(() => {
    if (document.body) callback();
  }, 1500);
}

function createFloatingPanel() {
  if (panel) return;
  panel = document.createElement("div");
  panel.id = "video-observer-panel";
  panel.innerHTML = `
     <header>🎥 Video Observer <button class="close-btn" id="toggle-panel">✕</button></header>
     <div class="tabs">
       <div class="tab active" data-tab="videos">Videos (<span id="video-count">0</span>)</div>
       <div class="tab" data-tab="logs">Logs</div>
     </div>
     <div id="videos-tab" class="content">
       <div id="videos-list"></div>
       <div id="empty-videos">No videos detected yet<br><small>Click card to toggle play/pause + scroll</small></div>
     </div>
     <div id="logs-tab" class="content" style="display:none">
       <div id="logs" class="log-container"></div>
     </div>
     <div class="status">Observing <strong>.message-inner video</strong> • ${new Date().toLocaleTimeString()}</div>
   `;
  document.body.appendChild(panel);

  // Tab logic (unchanged)
  panel.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      panel
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      panel.querySelector("#videos-tab").style.display =
        tab.dataset.tab === "videos" ? "block" : "none";
      panel.querySelector("#logs-tab").style.display =
        tab.dataset.tab === "logs" ? "block" : "none";
    });
  });

  panel.querySelector("#toggle-panel").addEventListener("click", () => {
    isPanelVisible = !isPanelVisible;
    panel.style.display = isPanelVisible ? "flex" : "none";
  });

  performPanelUpdate();
}

function init() {
  log("Video Observer initialized – stable cards + detailed preview logging");
  createFloatingPanel();
  observeVideos();

  let debounceTimer = null;
  new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(observeVideos, 500);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(observeVideos, 8000);
}

waitForBody(init);
