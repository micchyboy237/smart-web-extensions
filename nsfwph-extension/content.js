// content.js
let videos = new Map();
let videoCounter = 0;
const SELECTOR = ".message-inner video";
let panel = null;
let isPanelVisible = true;

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, type: "VIDEO_OBSERVER", message, data };
  console.log(`[VideoObserver] ${message}`, data || "");
  // Send to panel if it exists
  if (panel) {
    const logsEl = panel.querySelector("#logs");
    if (logsEl) {
      const time = new Date().toLocaleTimeString();
      const entry = document.createElement("div");
      entry.textContent = `[${time}] ${message}`;
      logsEl.prepend(entry);
      if (logsEl.children.length > 50) logsEl.removeChild(logsEl.lastChild);
    }
  }
}

function getVideoInfo(video) {
  return {
    id: video.dataset.videoObserverId || `video-${++videoCounter}`,
    src: video.currentSrc || video.src || "No source",
    poster: video.poster || "",
    currentTime: video.currentTime,
    duration: video.duration || 0,
    paused: video.paused,
    muted: video.muted,
    volume: video.volume,
    playbackRate: video.playbackRate,
    width: video.videoWidth,
    height: video.videoHeight,
  };
}

function trackVideo(video) {
  if (videos.has(video)) return;
  const id = `video-${++videoCounter}`;
  video.dataset.videoObserverId = id;
  videos.set(video, {
    id,
    element: video,
    info: getVideoInfo(video),
    tracked: true,
  });

  // Set default volume to 50% when first detected (only once)
  if (!video.dataset.volumeSet) {
    video.volume = 0.5;
    video.dataset.volumeSet = "1";
  }

  log(`New video detected`, {
    id,
    src: (video.currentSrc || "").substring(0, 80) + "...",
  });

  // IMPORTANT: Only listen to video state events — do NOT touch mouse/click events
  // This prevents conflicts with the site's original video player behavior
  const events = [
    "play",
    "pause",
    "ended",
    "timeupdate",
    "loadedmetadata",
    "volumechange",
    "ratechange",
    "seeking",
    "seeked",
    "error",
  ];
  events.forEach((ev) => {
    video.addEventListener(
      ev,
      (e) => {
        const info = getVideoInfo(video);
        videos.get(video).info = info;
        log(`Video event: ${ev}`, {
          id,
          time: info.currentTime.toFixed(1),
          paused: info.paused,
        });
        updatePanelVideos();
      },
      { passive: true },
    ); // Passive = does not call preventDefault(), safer for site
  });

  // Optional: Log if site mouse events are firing (for debugging only)
  // Uncomment the next block only if you still see conflicts
  /*
  ["click", "mousedown", "mouseup", "contextmenu"].forEach(ev => {
    video.addEventListener(ev, () => log(`Original mouse event passed through: ${ev}`), { passive: true });
  });
  */
}

function observeVideos() {
  document.querySelectorAll(SELECTOR).forEach(trackVideo);
  if (panel) updatePanelVideos();
}

// Safe way to wait for document.body
function waitForBody(callback) {
  if (document.body) {
    callback();
    return;
  }
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect();
      callback();
    }
  });
  observer.observe(document.documentElement, { childList: true });

  setTimeout(() => {
    if (document.body) callback();
  }, 2000);
}

// Create and inject the floating panel
function createFloatingPanel() {
  if (panel) return;
  panel = document.createElement("div");
  panel.id = "video-observer-panel";

  panel.innerHTML = `
     <header>
       🎥 Video Observer
       <button class="close-btn" id="toggle-panel">✕</button>
     </header>
     <div class="tabs">
       <div class="tab active" data-tab="videos">Videos (<span id="video-count">0</span>)</div>
       <div class="tab" data-tab="logs">Logs</div>
     </div>
     <div id="videos-tab" class="content">
       <div id="videos-list"></div>
       <div id="empty-videos">
         No videos detected yet<br>
         <small>Click any video card to toggle play/pause and scroll to it</small>
       </div> 
     </div>
     <div id="logs-tab" class="content" style="display:none">
       <div id="logs" class="log-container"></div>
     </div>
     <div class="status">Observing <strong>.message-inner video</strong> • ${new Date().toLocaleTimeString()}</div>
   `;

  document.body.appendChild(panel);

  // Tab switching
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

  // Toggle / close button
  panel.querySelector("#toggle-panel").addEventListener("click", () => {
    isPanelVisible = !isPanelVisible;
    panel.style.display = isPanelVisible ? "flex" : "none";
  });

  updatePanelVideos();
}

// Update videos list in the panel
function updatePanelVideos() {
  if (!panel) return;
  const list = panel.querySelector("#videos-list");
  const countEl = panel.querySelector("#video-count");
  const empty = panel.querySelector("#empty-videos");

  list.innerHTML = "";
  countEl.textContent = videos.size;

  if (videos.size === 0) {
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";

  Array.from(videos.values()).forEach((v) => {
    const info = v.info;
    const card = document.createElement("div");
    card.className = "video-card";

    card.innerHTML = `
       <div class="video-header">
         <strong>${v.id}</strong>
         <span class="video-status ${info.paused ? "paused" : "playing"}">
           ${info.paused ? "⏸ Paused" : "▶ Playing"}
         </span>
       </div>
       <div class="video-src">
         ${info.src.length > 70 ? info.src.substring(0, 67) + "..." : info.src}
       </div>
       <div class="video-meta">
         <span>Time: ${Math.floor(info.currentTime)}/${Math.floor(info.duration)}s</span>
         <span>${info.width}×${info.height}</span>
       </div>
     `;

    // Clean & minimal click handler - only does what user asked for
    card.addEventListener("click", (e) => {
      const videoEl = v.element;
      if (!videoEl) return;

      // Toggle play/pause
      if (videoEl.paused) {
        videoEl.play().catch((err) => {
          console.warn("[VideoObserver] Play failed:", err);
        });
      } else {
        videoEl.pause();
      }

      // Smooth scroll to video (this is the useful part)
      videoEl.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });

    list.appendChild(card);
  });
}

// Start everything
function init() {
  log("Video Observer initialized – floating panel mode");
  createFloatingPanel();
  observeVideos();

  // Mutation observer for dynamic content
  new MutationObserver(() => {
    setTimeout(observeVideos, 400);
  }).observe(document.body, { childList: true, subtree: true });

  // Periodic scan
  setInterval(observeVideos, 1500);
}

// Start only after body is ready
waitForBody(() => {
  init();
});
