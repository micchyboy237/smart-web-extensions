// content.js - Stable DOM + better preview + detailed logs

let videos = new Map(); // video element → entry
let videoCards = new Map(); // video element → card DOM element
let videoCounter = 0;
const MAX_GALLERY_ITEMS = 6;
const SELECTOR = ".message-inner video";

// NEW: Hover preview settings (2-3 second running chunks spread throughout the video)
const NUM_PREVIEW_CHUNKS = 5;
const CHUNK_PLAY_DURATION_MS = 400; // 0.4s per chunk → ~2s full cycle that loops

let panel = null;
let isPanelVisible = true;

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

// NEW helper: makes the preview play multiple short chunks from different parts of the video when you hover
function setupHoverPreview(previewVideo, originalVideo) {
  let isHovering = false;
  let chunkTimeout = null;
  let currentChunkIndex = 0;

  const getChunkStarts = () => {
    const duration = originalVideo.duration || previewVideo.duration || 0;
    if (!duration || isNaN(duration) || duration < 1) return null;

    const chunkDurationSec = CHUNK_PLAY_DURATION_MS / 1000;
    const numChunks = NUM_PREVIEW_CHUNKS;
    const chunkStarts = [];
    // Spread chunks evenly across the whole video, making sure they fit
    const spacing =
      (duration - chunkDurationSec) / (numChunks > 1 ? numChunks - 1 : 1);
    for (let i = 0; i < numChunks; i++) {
      let start = i * spacing;
      // Never go past the end of the video
      if (start + chunkDurationSec > duration)
        start = duration - chunkDurationSec;
      chunkStarts.push(Math.max(0, start));
    }
    return chunkStarts;
  };

  const playNextChunk = (chunkStarts) => {
    if (!isHovering || !chunkStarts) return;

    const startTime = chunkStarts[currentChunkIndex];
    previewVideo.currentTime = startTime;

    previewVideo
      .play()
      .then(() => {
        chunkTimeout = setTimeout(() => {
          if (!isHovering) return;
          previewVideo.pause();
          currentChunkIndex = (currentChunkIndex + 1) % NUM_PREVIEW_CHUNKS;
          playNextChunk(chunkStarts);
        }, CHUNK_PLAY_DURATION_MS);
      })
      .catch((err) => {
        log(`Chunk play failed (hover preview)`, err.message);
        currentChunkIndex = (currentChunkIndex + 1) % NUM_PREVIEW_CHUNKS;
        chunkTimeout = setTimeout(() => playNextChunk(chunkStarts), 100);
      });
  };

  previewVideo.addEventListener("mouseenter", () => {
    isHovering = true;
    currentChunkIndex = 0;
    const chunkStarts = getChunkStarts();

    if (!chunkStarts) {
      // Very short video or still loading → simple fallback
      previewVideo.currentTime = 0.8;
      previewVideo.play();
      setTimeout(() => {
        if (isHovering) previewVideo.pause();
      }, 2000);
      return;
    }

    log(
      `Hover preview started – playing ${NUM_PREVIEW_CHUNKS} chunks spread throughout the video`,
    );
    playNextChunk(chunkStarts);
  });

  previewVideo.addEventListener("mouseleave", () => {
    isHovering = false;
    if (chunkTimeout) {
      clearTimeout(chunkTimeout);
      chunkTimeout = null;
    }
    previewVideo.pause();
    // Return to the nice initial frame so the card looks clean again
    if (previewVideo.readyState >= 2) {
      previewVideo.currentTime = 0.8;
    }
    log(`Hover preview stopped`);
  });
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

  // NEW: Attach the hover-chunk feature (this is what gives you the 2-3 second running preview)
  setupHoverPreview(preview, originalVideo);

  return preview;
}

function createVideoCard(entry) {
  log(`Creating stable card DOM for ${entry.id}`);
  const card = document.createElement("div");
  card.className = "video-card";
  card.dataset.videoId = entry.id;

  card.innerHTML = `
     <div class="video-row">
       <div class="preview-container">
         <div class="thumb-placeholder"></div>
       </div>
       <div class="video-info">
         <div class="video-header">
           <strong>${entry.id}</strong>
           <div class="video-actions">
             <span class="video-status ${entry.info.paused ? "paused" : "playing"}">
               ${entry.info.paused ? "⏸" : "▶"}
             </span>
             <button class="gallery-btn" title="Open preview gallery">📷</button>
           </div>
         </div>
         <div class="video-src" title="${entry.info.src}">
           ${entry.info.src}
         </div>
         <div class="video-meta">
           ${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s
         </div>
       </div>
     </div>
   `;

  // Add click handler for entire card: play/pause and scroll into view
  card.addEventListener("click", () => {
    const videoEl = entry.element;
    if (videoEl) {
      if (videoEl.paused) videoEl.play().catch(() => {});
      else videoEl.pause();
      videoEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  // Gallery button handler - prevents card click
  const galleryBtn = card.querySelector(".gallery-btn");
  if (galleryBtn) {
    galleryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openGallery(entry);
    });
  }

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
    performPanelUpdate();
  };

  if (video.readyState >= 2) {
    startPreview();
  } else {
    video.addEventListener("loadedmetadata", startPreview, { once: true });
  }

  const events = [
    // Loading / Network
    "loadstart",
    "progress",
    "suspend",
    "abort",
    "error",
    "emptied",
    "stalled",

    // Metadata / Data readiness
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "canplaythrough",
    "durationchange",

    // Playback state
    "play",
    "playing",
    "pause",
    "ended",
    "waiting",

    // Time / Seeking
    "timeupdate",
    "seeking",
    "seeked",

    // Playback rate / volume
    "ratechange",
    "volumechange",

    // Misc
    "resize",
  ];
  events.forEach((ev) => {
    video.addEventListener(
      ev,
      () => {
        const info = getVideoInfo(video);
        entry.info = info;
        log(`Video event: ${ev}`, {
          id,
          time: info.currentTime.toFixed(1),
          paused: info.paused,
        });
        performPanelUpdate();
      },
      { passive: true },
    );
  });
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
  performPanelUpdate();
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
