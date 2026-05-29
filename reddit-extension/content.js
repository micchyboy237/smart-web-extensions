// content.js - Reddit Video Observer with Floating Panel + Buffer Boost
// FIXED: Shadow DOM handling, cleanup logic, and deduplication

let videos = new Map(); // video element → entry
let videoCards = new Map(); // video element → card DOM element
let currentlyPlaying = null;
let videoCounter = 0;
let panel = null;
let isPanelVisible = true;
let chatRoot = null;
let tabIsVisible = !document.hidden;

// ═══════════════════════════════════════════════════════════════
// DEBUG LOGGING SYSTEM
// ═══════════════════════════════════════════════════════════════
const DEBUG = {
  enabled: true,
  levels: {
    INFO: "🔵",
    SUCCESS: "🟢",
    WARN: "🟡",
    ERROR: "🔴",
    BOOST: "🚀",
    PANEL: "📊",
    DOM: "🏗️",
    CLEANUP: "🗑️",
  },
  log(level, message, data = null) {
    if (!this.enabled) return;
    const ts = new Date().toLocaleTimeString();
    const prefix = `[Reddit Panel ${ts}]`;
    console.log(
      `${this.levels[level] || "📝"} ${prefix} ${message}`,
      data || "",
    );
  },
  info(msg, data) {
    this.log("INFO", msg, data);
  },
  success(msg, data) {
    this.log("SUCCESS", msg, data);
  },
  warn(msg, data) {
    this.log("WARN", msg, data);
  },
  error(msg, data) {
    this.log("ERROR", msg, data);
  },
  boost(msg, data) {
    this.log("BOOST", msg, data);
  },
  panel(msg, data) {
    this.log("PANEL", msg, data);
  },
  dom(msg, data) {
    this.log("DOM", msg, data);
  },
  cleanup(msg, data) {
    this.log("CLEANUP", msg, data);
  },
};

// Also log to panel if visible
function logToPanel(message) {
  if (!panel || !tabIsVisible) return;
  const logsEl = panel.querySelector("#logs");
  if (logsEl) {
    const ts = new Date().toLocaleTimeString();
    const entry = document.createElement("div");
    entry.textContent = `[${ts}] ${message}`;
    logsEl.prepend(entry);
    if (logsEl.children.length > 60) logsEl.removeChild(logsEl.lastChild);
  }
}

// ═══════════════════════════════════════════════════════════════
// BUFFER BOOST ENGINE
// ═══════════════════════════════════════════════════════════════
const BOOST_CONFIG = {
  BUFFER_LOW: 5,
  BOOST_DURATION: 8000,
  INITIAL_BUFFER_TARGET: 12,
  SEEK_BOOST_RATE: 1.5,
  SEEK_BOOST_DURATION: 10000,
  SEEK_MIN_EFFECTIVE_RATIO: 0.6,
  SEEK_BOOST_EXTENSION: 5000,
  MAX_BOOST_EXTENSIONS: 3,
  MAX_TOTAL_BOOST_MS: 30000,
  BOOST_RATE_NORMAL: 1.08,
};

const boostTimers = new WeakMap();

function getBufferAhead(video) {
  if (!video || !video.buffered || !video.buffered.length) return 0;
  const ahead =
    video.buffered.end(video.buffered.length - 1) - video.currentTime;
  return ahead < 0 ? 0 : ahead;
}

function getEffectiveBufferRatio(video) {
  if (!video || !video.buffered || !video.buffered.length) return 0;
  let totalBuffered = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    totalBuffered += video.buffered.end(i) - video.buffered.start(i);
  }
  const ahead = getBufferAhead(video);
  return totalBuffered > 0 ? Math.min(1, ahead / totalBuffered) : 1;
}

function cleanupBoost(video) {
  if (!video) return;
  DEBUG.boost(
    `Cleaning up boost for ${video.dataset.videoObserverId || "unknown"}`,
  );

  const timers = boostTimers.get(video);
  if (timers) {
    if (timers.boostTimeout) clearTimeout(timers.boostTimeout);
    if (timers.monitorInterval) clearInterval(timers.monitorInterval);
    boostTimers.delete(video);
  }
  if (video.__boostTimeout) {
    clearTimeout(video.__boostTimeout);
    delete video.__boostTimeout;
  }
  if (video.__boostState) {
    video.__boostState.active = false;
    video.__boostState.paused = true;
  }
  if (
    video.__originalPlaybackRate &&
    video.playbackRate === video.__boostTargetRate
  ) {
    video.playbackRate = video.__originalPlaybackRate;
    DEBUG.boost(`Restored playback rate to ${video.__originalPlaybackRate}x`);
  }
  delete video.__originalPlaybackRate;
  delete video.__boostTargetRate;
  delete video.__boostStartTime;
  delete video.__boostExtensionCount;
  delete video.__boostBaseDuration;
  delete video.__hasBoostedOnLoad;
}

function boostBufferAfterSeek(video, isSeek = false, options = {}) {
  if (!video || !tabIsVisible) return;
  const { extendDuration = false } = options;

  let timers = boostTimers.get(video);
  if (!timers) {
    timers = { boostTimeout: null, monitorInterval: null };
    boostTimers.set(video, timers);
  }

  let rate = isSeek
    ? BOOST_CONFIG.SEEK_BOOST_RATE
    : BOOST_CONFIG.BOOST_RATE_NORMAL;

  if (isSeek) {
    const initialAhead = getBufferAhead(video);
    if (initialAhead < 2) {
      rate = Math.min(rate, 1.25);
    }
  }

  let duration = isSeek
    ? BOOST_CONFIG.SEEK_BOOST_DURATION
    : BOOST_CONFIG.BOOST_DURATION;

  if (extendDuration && isSeek) {
    duration = Math.min(
      duration + BOOST_CONFIG.SEEK_BOOST_EXTENSION,
      BOOST_CONFIG.SEEK_BOOST_DURATION + BOOST_CONFIG.SEEK_BOOST_EXTENSION,
    );
  }

  if (!video.__originalPlaybackRate) {
    video.__originalPlaybackRate = video.playbackRate || 1.0;
  }

  const targetRate = rate;
  video.__boostTargetRate = targetRate;
  video.playbackRate = targetRate;
  video.__boostStartTime = Date.now();
  video.__boostExtensionCount = 0;
  video.__boostBaseDuration = duration;
  video.__boostState = {
    active: true,
    extensionCount: 0,
    paused: video.paused,
  };

  DEBUG.boost(
    `Boost activated: ${targetRate}x for ${duration}ms | Buffer ahead: ${getBufferAhead(video).toFixed(1)}s`,
  );

  function evaluateBoost() {
    if (!video.__boostState?.active || !tabIsVisible) return;
    if (video.paused) {
      video.__boostState.paused = true;
      return;
    }
    video.__boostState.paused = false;

    const currentAhead = getBufferAhead(video);
    const elapsed = Date.now() - video.__boostStartTime;
    let endReason = null;

    if (currentAhead >= BOOST_CONFIG.BUFFER_LOW * 1.5) {
      endReason = "buffer healthy";
    } else if (
      video.__boostState.extensionCount >= BOOST_CONFIG.MAX_BOOST_EXTENSIONS
    ) {
      endReason = `max extensions (${BOOST_CONFIG.MAX_BOOST_EXTENSIONS})`;
    } else if (elapsed > BOOST_CONFIG.MAX_TOTAL_BOOST_MS) {
      endReason = `max total time (${BOOST_CONFIG.MAX_TOTAL_BOOST_MS / 1000}s)`;
    } else if (
      elapsed >
      video.__boostBaseDuration +
        video.__boostState.extensionCount * BOOST_CONFIG.SEEK_BOOST_EXTENSION
    ) {
      if (
        video.__boostState.extensionCount < BOOST_CONFIG.MAX_BOOST_EXTENSIONS &&
        elapsed <= BOOST_CONFIG.MAX_TOTAL_BOOST_MS
      ) {
        video.__boostState.extensionCount++;
        DEBUG.boost(
          `Extension ${video.__boostState.extensionCount}/${BOOST_CONFIG.MAX_BOOST_EXTENSIONS}`,
        );
        if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
        video.__boostTimeout = setTimeout(
          evaluateBoost,
          BOOST_CONFIG.SEEK_BOOST_EXTENSION,
        );
        if (timers) timers.boostTimeout = video.__boostTimeout;
        return;
      } else {
        endReason = "max limits reached";
      }
    }

    if (endReason) {
      DEBUG.boost(
        `Boost ended: ${endReason} | Buffer ahead: ${currentAhead.toFixed(1)}s`,
      );
      if (video.playbackRate === targetRate) {
        video.playbackRate = video.__originalPlaybackRate || 1.0;
      }
      video.__boostState.active = false;
    }

    if (video.__boostTimeout) {
      clearTimeout(video.__boostTimeout);
      video.__boostTimeout = null;
      if (timers) timers.boostTimeout = null;
    }
  }

  if (timers.boostTimeout) clearTimeout(timers.boostTimeout);
  if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
  video.__boostTimeout = setTimeout(evaluateBoost, duration);
  timers.boostTimeout = video.__boostTimeout;
}

function attachBoostToVideo(video) {
  if (!video || video.dataset.boostAttached === "true") return () => {};
  video.dataset.boostAttached = "true";

  DEBUG.boost(
    `Boost attached to ${video.dataset.videoObserverId || "unknown"}`,
  );

  const initialCheck = setTimeout(() => {
    if (!tabIsVisible) return;
    const ahead = getBufferAhead(video);
    DEBUG.boost(
      `Initial buffer check: ${ahead.toFixed(1)}s ahead (target: ${BOOST_CONFIG.INITIAL_BUFFER_TARGET}s)`,
    );
    if (
      ahead < BOOST_CONFIG.INITIAL_BUFFER_TARGET &&
      !video.__hasBoostedOnLoad
    ) {
      boostBufferAfterSeek(video, false);
      video.__hasBoostedOnLoad = true;
    }
  }, 600);

  const onSeeked = () => {
    if (!tabIsVisible) return;
    const ratio = getEffectiveBufferRatio(video);
    const needsExtension = ratio < BOOST_CONFIG.SEEK_MIN_EFFECTIVE_RATIO;
    DEBUG.boost(
      `Seek detected | Buffer ratio: ${ratio.toFixed(2)} | Extension needed: ${needsExtension}`,
    );
    boostBufferAfterSeek(video, true, { extendDuration: needsExtension });
  };

  const onPlay = () => {
    if (!tabIsVisible) return;
    if (video.__boostState?.active && video.__boostState.paused) {
      video.__boostState.paused = false;
      DEBUG.boost("Play resumed during boost");
      const timers = boostTimers.get(video);
      if (timers?.boostTimeout) {
        clearTimeout(timers.boostTimeout);
        const remaining = Math.max(
          1000,
          (video.__boostBaseDuration || BOOST_CONFIG.BOOST_DURATION) -
            (Date.now() - (video.__boostStartTime || Date.now())),
        );
        if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
        video.__boostTimeout = setTimeout(
          () => {
            if (video.__boostState?.active) {
              const ahead = getBufferAhead(video);
              if (ahead >= BOOST_CONFIG.BUFFER_LOW * 1.5) {
                video.playbackRate = video.__originalPlaybackRate || 1.0;
                video.__boostState.active = false;
              }
            }
          },
          Math.min(remaining, 5000),
        );
        timers.boostTimeout = video.__boostTimeout;
      }
    }
  };

  const onPause = () => {
    if (video.__boostState?.active) {
      video.__boostState.paused = true;
    }
  };

  video.addEventListener("seeked", onSeeked);
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);

  return () => {
    clearTimeout(initialCheck);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    cleanupBoost(video);
    delete video.dataset.boostAttached;
  };
}

// ═══════════════════════════════════════════════════════════════
// REDDIT SHADOW DOM HELPER
// ═══════════════════════════════════════════════════════════════
function getVideoFromRedditPlayer(player) {
  if (!player) return null;
  // Reddit shreddit-player uses shadow DOM
  if (player.shadowRoot) {
    return player.shadowRoot.querySelector("video");
  }
  return player.querySelector("video");
}

function getAllRedditVideoPlayers() {
  return Array.from(document.querySelectorAll("shreddit-player")).filter(
    (player) => {
      const video = getVideoFromRedditPlayer(player);
      return video !== null;
    },
  );
}

// ═══════════════════════════════════════════════════════════════
// VIDEO INFO
// ═══════════════════════════════════════════════════════════════
function getVideoInfo(video) {
  return {
    id: video.dataset.videoObserverId || `video-${++videoCounter}`,
    src: video.currentSrc || video.src || "No source",
    currentTime: video.currentTime || 0,
    duration: video.duration || 0,
    paused: video.paused,
    playbackRate: video.playbackRate || 1.0,
    bufferAhead: getBufferAhead(video),
    muted: video.muted,
    readyState: video.readyState,
  };
}

// ═══════════════════════════════════════════════════════════════
// SINGLE PLAYBACK CONTROLLER
// ═══════════════════════════════════════════════════════════════
function enforceSinglePlayback(videoToPlay) {
  if (currentlyPlaying && currentlyPlaying !== videoToPlay) {
    DEBUG.info(
      `Pausing previous video: ${currentlyPlaying.dataset.videoObserverId}`,
    );
    currentlyPlaying.pause();
  }
  currentlyPlaying = videoToPlay;

  const onEnded = () => {
    if (currentlyPlaying === videoToPlay) {
      DEBUG.info(`Video ended: ${videoToPlay.dataset.videoObserverId}`);
      currentlyPlaying = null;
    }
  };
  videoToPlay.addEventListener("ended", onEnded, { once: true });
}

// ═══════════════════════════════════════════════════════════════
// CARD CREATION & MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function createVideoCard(entry) {
  DEBUG.panel(`Creating card for ${entry.id}`);

  const card = document.createElement("div");
  card.className = "video-card";
  card.dataset.videoId = entry.id;

  const buffPercent = entry.info.duration
    ? Math.round((getBufferAhead(entry.element) / entry.info.duration) * 100)
    : 0;
  const isBoosting = entry.info.playbackRate > 1;

  card.innerHTML = `
    <div class="preview-container">
      <video 
        src="${entry.info.src}" 
        muted 
        preload="metadata"
        style="width:100%;height:100%;object-fit:cover;border-radius:4px;background:#1a1a2e;"
      ></video>
    </div>
    <div class="video-info-row">
      <div class="video-id-meta">
        <span class="video-id">${entry.id}</span>
        <span class="video-meta">${Math.floor(entry.info.currentTime)}/${Math.floor(entry.info.duration)}s</span>
      </div>
      <span class="video-status ${entry.info.paused ? "paused" : "playing"}">
        ${entry.info.paused ? "⏸ Paused" : "▶ Playing"}
      </span>
    </div>
    <div class="boost-indicator" style="
      font-size:10px;
      color:#4CAF50;
      text-align:center;
      padding:2px;
      display:${isBoosting ? "block" : "none"};
    ">
      🚀 Boost ${entry.info.playbackRate.toFixed(2)}x | Buffer: ${buffPercent}%
    </div>
  `;

  const previewVideo = card.querySelector("video");
  entry.cardPreview = previewVideo;

  // Click handler
  card.addEventListener("click", (e) => {
    e.stopImmediatePropagation();
    const videoEl = entry.element;
    if (!videoEl) {
      DEBUG.warn(`No element for ${entry.id}`);
      return;
    }

    DEBUG.panel(`Card clicked: ${entry.id} | paused: ${videoEl.paused}`);

    if (videoEl.paused) {
      enforceSinglePlayback(videoEl);
      videoEl.play().catch((err) => {
        DEBUG.error(`Play failed: ${err.message}`);
      });
    } else {
      if (currentlyPlaying === videoEl) {
        videoEl.pause();
      } else {
        enforceSinglePlayback(videoEl);
        videoEl.play().catch((err) => {
          DEBUG.error(`Play failed: ${err.message}`);
        });
      }
    }

    // Scroll to the actual video
    const redditPlayer = videoEl.closest("shreddit-player");
    if (redditPlayer) {
      redditPlayer.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

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

  const boostEl = card.querySelector(".boost-indicator");
  if (boostEl) {
    const isBoosting = entry.info.playbackRate > 1;
    const buffPercent = entry.info.duration
      ? Math.round((getBufferAhead(entry.element) / entry.info.duration) * 100)
      : 0;

    boostEl.style.display = isBoosting ? "block" : "none";
    boostEl.innerHTML = isBoosting
      ? `🚀 Boost ${entry.info.playbackRate.toFixed(2)}x | Buffer: ${buffPercent}%`
      : "";
  }
}

// ═══════════════════════════════════════════════════════════════
// FIXED: PANEL UPDATE - Checks video existence properly
// ═══════════════════════════════════════════════════════════════
function isVideoStillInDOM(video) {
  if (!video) return false;

  // Check if video is still in any document
  if (!document.contains(video)) {
    // Video might be in shadow DOM
    const shredditPlayer = document.querySelector("shreddit-player");
    if (shredditPlayer && shredditPlayer.shadowRoot) {
      return shredditPlayer.shadowRoot.contains(video);
    }
    return false;
  }
  return true;
}

function performPanelUpdate() {
  if (!panel) {
    DEBUG.warn("Panel not created yet, skipping update");
    return;
  }

  DEBUG.panel(`Panel update - Videos tracked: ${videos.size}`);

  const list = panel.querySelector("#videos-list");
  const countEl = panel.querySelector("#video-count");
  const empty = panel.querySelector("#empty-videos");

  if (!list || !countEl || !empty) {
    DEBUG.error("Panel DOM elements missing!");
    return;
  }

  countEl.textContent = videos.size;

  if (videos.size === 0) {
    empty.style.display = "block";
    DEBUG.panel("No videos to show");
    return;
  }

  empty.style.display = "none";

  // FIXED: Only cleanup videos that are truly gone
  const videosToRemove = [];

  for (let [videoEl, entry] of Array.from(videos.entries())) {
    if (!isVideoStillInDOM(videoEl)) {
      DEBUG.cleanup(`Video ${entry.id} no longer in DOM - marking for removal`);
      videosToRemove.push([videoEl, entry]);
    }
  }

  // Remove dead videos
  for (let [videoEl, entry] of videosToRemove) {
    cleanupVideoEntry(entry);
    videos.delete(videoEl);
    const card = videoCards.get(videoEl);
    if (card) {
      card.remove();
      videoCards.delete(videoEl);
      DEBUG.cleanup(`Removed card for ${entry.id}`);
    }
  }

  // Update count after cleanup
  countEl.textContent = videos.size;

  if (videos.size === 0) {
    empty.style.display = "block";
    return;
  }

  // Create or update cards
  Array.from(videos.values()).forEach((entry) => {
    let card;
    if (!videoCards.has(entry.element)) {
      card = createVideoCard(entry);
      videoCards.set(entry.element, card);
      list.appendChild(card);
      DEBUG.panel(`Added card for ${entry.id}`);
    } else {
      card = videoCards.get(entry.element);
      updateExistingCard(card, entry);
    }
  });

  DEBUG.panel(`Panel updated: ${videos.size} videos, ${videoCards.size} cards`);
}

function updateAllCards() {
  if (!panel || !tabIsVisible) return;

  for (const [videoEl, entry] of videos) {
    entry.info = getVideoInfo(videoEl);
    const card = videoCards.get(videoEl);
    if (card) {
      updateExistingCard(card, entry);
    }
  }

  // Schedule next update
  setTimeout(updateAllCards, 1000);
}

function cleanupVideoEntry(entry) {
  if (!entry) return;
  DEBUG.cleanup(`Cleaning up entry: ${entry.id}`);

  if (entry.boostCleanup) {
    entry.boostCleanup();
    entry.boostCleanup = null;
  }

  if (entry.cleanups && entry.cleanups.length > 0) {
    entry.cleanups.forEach((cleanupFn) => cleanupFn());
    entry.cleanups = null;
  }

  if (entry.cardPreview) {
    entry.cardPreview.pause();
    entry.cardPreview.src = "";
    entry.cardPreview.load();
    entry.cardPreview = null;
  }

  if (entry.element && entry.element === currentlyPlaying) {
    currentlyPlaying = null;
  }

  // Clear observer data
  if (entry.element) {
    delete entry.element.dataset.videoObserverAttached;
    delete entry.element.dataset.videoObserverId;
  }
}

// ═══════════════════════════════════════════════════════════════
// FLOATING PANEL CREATION
// ═══════════════════════════════════════════════════════════════
function createFloatingPanel() {
  if (panel) {
    DEBUG.warn("Panel already exists");
    return;
  }

  panel = document.createElement("div");
  panel.id = "video-observer-panel";
  panel.innerHTML = `
    <header>
      🎥 Reddit Video Observer 
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
        <small>Scroll to load Reddit video posts</small>
      </div>
    </div>
    <div id="logs-tab" class="content" style="display:none">
      <div id="logs" class="log-container"></div>
    </div>
    <div class="status">
      Observing <strong>shreddit-player</strong> • ${new Date().toLocaleTimeString()}
    </div>
  `;

  document.body.appendChild(panel);
  DEBUG.success("Floating panel created and appended to body");

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

  // Toggle panel visibility
  panel.querySelector("#toggle-panel").addEventListener("click", () => {
    isPanelVisible = !isPanelVisible;
    panel.style.display = isPanelVisible ? "flex" : "none";
    DEBUG.info(`Panel ${isPanelVisible ? "shown" : "hidden"}`);
    if (!isPanelVisible && currentlyPlaying) {
      currentlyPlaying.pause();
      currentlyPlaying = null;
    }
  });

  // Start periodic card updates
  updateAllCards();
}

// ═══════════════════════════════════════════════════════════════
// FIXED: VIDEO TRACKING with deduplication
// ═══════════════════════════════════════════════════════════════
function trackVideo(video, player) {
  // Skip if already tracked
  if (video.dataset.videoObserverAttached === "true") {
    DEBUG.dom(
      `Video already tracked, skipping: ${video.dataset.videoObserverId}`,
    );
    return;
  }

  // Skip if we already have this exact video element
  if (videos.has(video)) {
    DEBUG.dom(`Video already in Map, skipping`);
    return;
  }

  video.dataset.videoObserverAttached = "true";

  const id = `reddit-video-${++videoCounter}`;
  video.dataset.videoObserverId = id;

  // Ensure Reddit videos start muted (we'll unmute on interaction)
  video.muted = true;
  video.volume = 0.5;

  const entry = {
    id,
    element: video,
    player: player,
    info: getVideoInfo(video),
    cardPreview: null,
    cleanups: [],
    boostCleanup: null,
  };

  videos.set(video, entry);

  DEBUG.dom(`Video tracked: ${id}`, {
    src: (video.currentSrc || video.src || "").substring(0, 60) + "...",
    duration: video.duration || "unknown",
    readyState: video.readyState,
    totalTracked: videos.size,
  });

  logToPanel(`Video detected: ${id}`);

  // Attach buffer boost
  entry.boostCleanup = attachBoostToVideo(video);

  // Track all video events
  const events = [
    "loadstart",
    "progress",
    "suspend",
    "abort",
    "error",
    "emptied",
    "stalled",
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "canplaythrough",
    "durationchange",
    "play",
    "playing",
    "pause",
    "ended",
    "waiting",
    "seeking",
    "seeked",
    "ratechange",
    "volumechange",
    "resize",
  ];

  events.forEach((ev) => {
    const handler = () => {
      entry.info = getVideoInfo(video);
      if (ev === "ratechange") {
        const card = videoCards.get(video);
        if (card) updateExistingCard(card, entry);
      }
    };
    video.addEventListener(ev, handler, { passive: true });
    entry.cleanups.push(() => video.removeEventListener(ev, handler));
  });

  // Unmute on first user interaction
  const unmuteOnInteraction = () => {
    if (video.muted) {
      video.muted = false;
      video.volume = 0.5;
      DEBUG.info(`Unmuted video: ${id}`);
      logToPanel(`Unmuted: ${id}`);
    }
    document.removeEventListener("click", unmuteOnInteraction);
    document.removeEventListener("keydown", unmuteOnInteraction);
  };
  document.addEventListener("click", unmuteOnInteraction, { once: true });
  document.addEventListener("keydown", unmuteOnInteraction, { once: true });
}

// FIXED: Observe function with proper deduplication
let lastObserveTime = 0;
const OBSERVE_DEBOUNCE_MS = 500;

function observeVideos() {
  const now = Date.now();
  if (now - lastObserveTime < OBSERVE_DEBOUNCE_MS) {
    DEBUG.dom(`Debouncing video scan (${now - lastObserveTime}ms since last)`);
    return;
  }
  lastObserveTime = now;

  DEBUG.dom("Scanning for Reddit video players...");

  const players = getAllRedditVideoPlayers();
  DEBUG.dom(`Found ${players.length} players with videos`);

  let newVideos = 0;
  let existingVideos = 0;

  players.forEach((player) => {
    const video = getVideoFromRedditPlayer(player);
    if (video) {
      if (video.dataset.videoObserverAttached === "true") {
        existingVideos++;
      } else {
        trackVideo(video, player);
        newVideos++;
      }
    }
  });

  DEBUG.dom(
    `Scan results: ${newVideos} new, ${existingVideos} existing, ${videos.size} total tracked`,
  );

  performPanelUpdate();
}

// ═══════════════════════════════════════════════════════════════
// FIXED: MutationObserver with better debouncing
// ═══════════════════════════════════════════════════════════════
let mutationDebounceTimer = null;

function setupMutationObserver() {
  const observer = new MutationObserver((mutations) => {
    if (!tabIsVisible) return;

    let hasNewPlayers = false;

    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;

      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const players = node.matches?.("shreddit-player") ? [node] : [];
        players.push(...(node.querySelectorAll?.("shreddit-player") || []));

        if (players.length > 0) {
          hasNewPlayers = true;
        }
      });
    }

    if (hasNewPlayers) {
      DEBUG.dom("New shreddit-player elements detected by MutationObserver");
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = setTimeout(() => {
        observeVideos();
      }, 1000); // Wait 1 second for shadow DOM to render
    }
  });

  // Find the feed container
  chatRoot =
    document.querySelector("shreddit-feed") ||
    document.querySelector('[data-testid="post-container"]') ||
    document.querySelector("main") ||
    document.body;

  observer.observe(chatRoot, {
    childList: true,
    subtree: true,
  });

  DEBUG.dom(
    `MutationObserver watching: ${chatRoot.tagName || "body"}.${chatRoot.className || ""}`,
  );
  return observer;
}

// ═══════════════════════════════════════════════════════════════
// KEYBOARD NAVIGATION
// ═══════════════════════════════════════════════════════════════
function setupKeyboardNavigation() {
  document.addEventListener("keydown", (e) => {
    // Don't capture when typing
    if (
      e.target.tagName === "INPUT" ||
      e.target.tagName === "TEXTAREA" ||
      e.target.isContentEditable
    )
      return;

    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      navigateToVideo("next");
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      navigateToVideo("prev");
    }
  });

  DEBUG.info("⌨️ Arrow key navigation enabled (← → ↑ ↓)");
}

function navigateToVideo(direction) {
  const videoEntries = Array.from(videos.entries());
  if (videoEntries.length === 0) {
    DEBUG.warn("No videos to navigate");
    return;
  }

  let currentIndex = -1;

  if (currentlyPlaying) {
    currentIndex = videoEntries.findIndex(
      ([video]) => video === currentlyPlaying,
    );
  }

  let targetIndex;
  if (currentIndex === -1) {
    targetIndex = 0;
  } else if (direction === "next") {
    targetIndex = Math.min(currentIndex + 1, videoEntries.length - 1);
  } else {
    targetIndex = Math.max(currentIndex - 1, 0);
  }

  const [targetVideo] = videoEntries[targetIndex];

  if (targetVideo) {
    DEBUG.info(
      `⌨️ Navigating ${direction} to video ${targetIndex + 1}/${videoEntries.length}`,
    );

    const player = targetVideo.closest("shreddit-player");
    if (player) {
      player.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    setTimeout(() => {
      enforceSinglePlayback(targetVideo);
      targetVideo.muted = false;
      targetVideo.volume = 0.5;
      targetVideo.play().catch((err) => {
        DEBUG.error(`Navigation play failed: ${err.message}`);
      });
    }, 400);
  }
}

// ═══════════════════════════════════════════════════════════════
// PAGE VISIBILITY
// ═══════════════════════════════════════════════════════════════
function onTabHidden() {
  tabIsVisible = false;
  DEBUG.info("Tab hidden — pausing boosts");

  for (const entry of videos.values()) {
    if (entry.boostCleanup) {
      cleanupBoost(entry.element);
    }
  }

  if (currentlyPlaying) {
    currentlyPlaying.pause();
  }
}

function onTabVisible() {
  tabIsVisible = true;
  DEBUG.info("Tab visible — resuming");

  for (const entry of videos.values()) {
    if (entry.element && entry.element.dataset.boostAttached !== "true") {
      entry.boostCleanup = attachBoostToVideo(entry.element);
    }
  }

  observeVideos();
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════
function waitForBody(callback) {
  if (document.body) return callback();

  DEBUG.info("Waiting for document.body...");
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect();
      DEBUG.info("document.body found");
      callback();
    }
  });
  observer.observe(document.documentElement, { childList: true });

  setTimeout(() => {
    if (document.body) callback();
  }, 1500);
}

function init() {
  if (window.__REDDIT_VIDEO_OBSERVER_INITIALIZED__) {
    DEBUG.warn("Already initialized, skipping");
    return;
  }
  window.__REDDIT_VIDEO_OBSERVER_INITIALIZED__ = true;

  DEBUG.success("=== Reddit Video Observer Initializing ===");
  DEBUG.info("Features: Floating Panel + Buffer Boost");

  createFloatingPanel();

  // Initial scan with longer delay for Reddit to fully render
  setTimeout(() => {
    DEBUG.info("Running initial video scan...");
    observeVideos();
  }, 3000);

  // Watch for new posts
  setupMutationObserver();

  // Keyboard navigation
  setupKeyboardNavigation();

  // Tab visibility
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      onTabHidden();
    } else {
      onTabVisible();
    }
  });

  DEBUG.success("=== Initialization Complete ===");
  logToPanel("✅ Extension loaded - Panel + Buffer Boost active");
}

waitForBody(init);
