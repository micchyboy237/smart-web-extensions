// content.js - Stable DOM + SINGLE PLAYBACK + LIGHTWEIGHT CHUNK PREVIEWS + RAM optimized

let videos = new Map(); // video element → entry
let videoCards = new Map(); // video element → card DOM element
let currentlyPlaying = null; // Global: only one video plays at a time
let videoCounter = 0;
const MAX_GALLERY_ITEMS = 6;
const SELECTOR = ".message-inner video";

// Settings for lightweight chunk preview (2-3 second moving clips that loop)
const NUM_PREVIEW_CHUNKS = 5;
const CHUNK_PLAY_DURATION_MS = 400; // 0.4s per chunk → ~2s full cycle

// Global single playback controller - Only one video plays at any time
function enforceSinglePlayback(videoToPlay) {
  if (currentlyPlaying && currentlyPlaying !== videoToPlay) {
    currentlyPlaying.pause();
    log(
      `Paused previous video to enforce single playback`,
      currentlyPlaying ? currentlyPlaying.dataset.videoObserverId : "",
    );
  }
  currentlyPlaying = videoToPlay;

  // Auto-pause when this video ends
  const onEnded = () => {
    if (currentlyPlaying === videoToPlay) currentlyPlaying = null;
  };
  videoToPlay.addEventListener("ended", onEnded, { once: true });
}

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

// New: Play preview chunks WITHOUT interfering with main video playback
function playPreviewChunk(
  previewVideo,
  chunkTimeoutRef,
  currentChunkIndexRef,
  entryId,
  getChunkStarts,
) {
  const chunkStarts = getChunkStarts();
  if (!chunkStarts) return;

  const startTime = chunkStarts[currentChunkIndexRef.current];
  previewVideo.currentTime = startTime;

  // CRITICAL: Do NOT call enforceSinglePlayback for previews!
  // Previews should not pause the main video the user clicked.
  previewVideo
    .play()
    .then(() => {
      chunkTimeoutRef.current = setTimeout(() => {
        previewVideo.pause();
        currentChunkIndexRef.current =
          (currentChunkIndexRef.current + 1) % NUM_PREVIEW_CHUNKS;
        // Small delay to reduce fighting
        setTimeout(
          () =>
            playPreviewChunk(
              previewVideo,
              chunkTimeoutRef,
              currentChunkIndexRef,
              entryId,
              getChunkStarts,
            ),
          30,
        );
      }, CHUNK_PLAY_DURATION_MS);
    })
    .catch((err) => {
      log(`Chunk preview play failed for ${entryId}`, err.message);
      currentChunkIndexRef.current =
        (currentChunkIndexRef.current + 1) % NUM_PREVIEW_CHUNKS;
      chunkTimeoutRef.current = setTimeout(
        () =>
          playPreviewChunk(
            previewVideo,
            chunkTimeoutRef,
            currentChunkIndexRef,
            entryId,
            getChunkStarts,
          ),
        150,
      );
    });
}

// Lightweight automatic chunk preview (looping short clips) - respects single playback
function setupLightChunkPreview(previewVideo, entryId) {
  // Use ref objects so inner functions can mutate safely, to avoid bugs with closures/timeouts
  const chunkTimeoutRef = { current: null };
  const currentChunkIndexRef = { current: 0 };

  const getChunkStarts = () => {
    const duration = previewVideo.duration || 0;
    if (!duration || isNaN(duration) || duration < 1) return null;
    const chunkDurationSec = CHUNK_PLAY_DURATION_MS / 1000;
    const chunkStarts = [];
    const spacing =
      (duration - chunkDurationSec) /
      (NUM_PREVIEW_CHUNKS > 1 ? NUM_PREVIEW_CHUNKS - 1 : 1);
    for (let i = 0; i < NUM_PREVIEW_CHUNKS; i++) {
      let start = i * spacing;
      if (start + chunkDurationSec > duration)
        start = duration - chunkDurationSec;
      chunkStarts.push(Math.max(0, start));
    }
    return chunkStarts;
  };

  // Use the new playPreviewChunk that does NOT pause the user's main video
  const playNextChunk = () => {
    playPreviewChunk(
      previewVideo,
      chunkTimeoutRef,
      currentChunkIndexRef,
      entryId,
      getChunkStarts,
    );
  };

  // Only start loop when video can determine duration
  const tryStartLoop = () => {
    if (
      previewVideo.duration &&
      !isNaN(previewVideo.duration) &&
      previewVideo.duration > 1
    ) {
      log(`Light chunk preview loop started for ${entryId}`);
      playNextChunk();
    }
  };

  if (previewVideo.readyState >= 1) {
    tryStartLoop();
  } else {
    previewVideo.addEventListener("loadedmetadata", tryStartLoop, {
      once: true,
    });
    previewVideo.addEventListener("canplay", tryStartLoop, { once: true });
  }

  // Stop chunk loop when mouse leaves (saves RAM + prevents multiple playing)
  previewVideo.addEventListener(
    "mouseleave",
    () => {
      if (chunkTimeoutRef.current) clearTimeout(chunkTimeoutRef.current);
      previewVideo.pause();
      if (currentlyPlaying === previewVideo) currentlyPlaying = null;
    },
    { once: false },
  );
}

function createSinglePreview(originalVideo, entryId) {
  log(`Creating preview video element for ${entryId}`);
  let videoUrl = originalVideo.currentSrc || originalVideo.src;
  if (videoUrl) {
    videoUrl += (videoUrl.includes("?") ? "&" : "?") + "t=0.8";
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
        setTimeout(() => preview.pause(), 280);
        log(`Initial preview frame shown for ${entryId}`);
      })
      .catch((err) => {
        log(`Initial frame play failed for ${entryId}`, err.message);
        preview.currentTime = 1.5;
      });
  };

  preview.addEventListener(
    "loadeddata",
    () => {
      log(`loadeddata fired for preview ${entryId}`);
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

  // Attach lightweight chunk preview (this brings back the moving clips)
  setupLightChunkPreview(preview, entryId);

  return preview;
}

function createVideoCard(entry) {
  // ... (unchanged - same as your last version) ...
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
    <div class="time-selections">
      <small>Time selections</small>
      <div class="time-strip"></div>
    </div>
  `;

  card.addEventListener("click", (e) => {
    e.stopImmediatePropagation(); // Prevent any other listeners or bubbling issues

    const videoEl = entry.element;
    if (!videoEl) return;

    // Small guard to avoid rapid re-clicks during state transition
    if (videoEl.dataset.clickInProgress === "true") return;
    videoEl.dataset.clickInProgress = "true";

    setTimeout(() => {
      delete videoEl.dataset.clickInProgress;
    }, 300); // enough for play/pause promise to settle

    if (videoEl.paused) {
      enforceSinglePlayback(videoEl);
      videoEl.play().catch((err) => {
        console.warn("Play failed on card click", err);
        delete videoEl.dataset.clickInProgress;
      });
    } else {
      videoEl.pause();
      if (currentlyPlaying === videoEl) currentlyPlaying = null;
    }

    videoEl.scrollIntoView({ behavior: "smooth", block: "center" });
  });

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
  const statusEl = card.querySelector(".video-status");
  if (statusEl) {
    statusEl.className = `video-status ${entry.info.paused ? "paused" : "playing"}`;
    statusEl.textContent = entry.info.paused ? "⏸ Paused" : "▶ Playing";
  }

  const timeEl = card.querySelector(".video-meta");
  if (timeEl) {
    timeEl.textContent = `${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s`;
  }

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

// Cleanup helper (still used)
function cleanupVideoEntry(entry) {
  if (!entry) return;
  log(`Cleaning up video entry for RAM optimization: ${entry.id}`);

  if (entry.preview) {
    entry.preview.pause();
    if (currentlyPlaying === entry.preview) currentlyPlaying = null;
    entry.preview.src = "";
    entry.preview.load();
    entry.preview = null;
  }

  if (entry.element && entry.element === currentlyPlaying) {
    currentlyPlaying = null;
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
    framesPopulated: false,
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
        // performPanelUpdate();
      },
      { passive: true },
    );
  });

  // ─────────────────────────────────────────────────────────────
  // BEAUTIFUL SIZE BOOST FOR THE MAIN VIDEO
  // When the video plays → add special class (makes it bigger + glow)
  // When it stops     → remove class (smoothly returns to normal size)
  // ─────────────────────────────────────────────────────────────
  video.addEventListener(
    "play",
    () => {
      video.classList.add("video-observer-playing");
    },
    { passive: true },
  );

  video.addEventListener(
    "pause",
    () => video.classList.remove("video-observer-playing"),
    { passive: true },
  );

  video.addEventListener(
    "ended",
    () => video.classList.remove("video-observer-playing"),
    { passive: true },
  );

  // If a video was already playing when we first detected it
  if (!video.paused) {
    video.classList.add("video-observer-playing");
  }
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
    let card;
    if (!videoCards.has(entry.element)) {
      card = createVideoCard(entry);
      videoCards.set(entry.element, card);
      list.appendChild(card);
      log(`Added new stable card for ${entry.id}`);
    } else {
      card = videoCards.get(entry.element);
      updateExistingCard(card, entry);
    }

    if (card && !entry.framesPopulated && entry.info.duration > 2) {
      entry.framesPopulated = true;
      populateTimeSelections(card, entry);
    }
  });

  // Cleanup stale videos (frees RAM)
  for (let [videoEl, entry] of Array.from(videos.entries())) {
    if (!document.body.contains(videoEl)) {
      cleanupVideoEntry(entry);
      videos.delete(videoEl);
      const card = videoCards.get(videoEl);
      if (card) {
        card.remove();
        videoCards.delete(videoEl);
      }
      log(`Removed stale video entry: ${entry.id}`);
    }
  }
}

function populateTimeSelections(card, entry) {
  const strip = card.querySelector(".time-strip");
  if (!strip) return;
  strip.innerHTML = "";
  const div = document.createElement("div");
  div.textContent = "⏱ Time frames";
  div.style.fontSize = "10px";
  div.style.color = "#666";
  strip.appendChild(div);
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
    if (!isPanelVisible && currentlyPlaying) {
      currentlyPlaying.pause();
      currentlyPlaying = null;
    }
  });

  performPanelUpdate();
}

function init() {
  log(
    "Video Observer initialized – SINGLE PLAYBACK + LIGHTWEIGHT CHUNK PREVIEWS",
  );
  createFloatingPanel();
  observeVideos();

  let debounceTimer = null;
  new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(observeVideos, 600);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(observeVideos, 10000);
}

waitForBody(init);
