// content.js - Reddit Video Observer with Floating Panel + Buffer Boost
// FIXED v2: Track by shreddit-player, not by video element

let players = new Map(); // shreddit-player → entry (NOT video → entry)
let videoCards = new Map(); // shreddit-player → card DOM element
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
    console.log(
      `${this.levels[level] || "📝"} [Reddit ${ts}] ${message}`,
      data || "",
    );
  },
};

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
  }
  if (
    video.__originalPlaybackRate &&
    video.playbackRate === video.__boostTargetRate
  ) {
    video.playbackRate = video.__originalPlaybackRate;
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

  DEBUG.log(
    "BOOST",
    `Boost: ${targetRate}x for ${duration}ms | Buffer: ${getBufferAhead(video).toFixed(1)}s`,
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
      endReason = "max extensions";
    } else if (elapsed > BOOST_CONFIG.MAX_TOTAL_BOOST_MS) {
      endReason = "max time";
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
        if (video.__boostTimeout) clearTimeout(video.__boostTimeout);
        video.__boostTimeout = setTimeout(
          evaluateBoost,
          BOOST_CONFIG.SEEK_BOOST_EXTENSION,
        );
        if (timers) timers.boostTimeout = video.__boostTimeout;
        return;
      } else {
        endReason = "limits reached";
      }
    }

    if (endReason) {
      DEBUG.log(
        "BOOST",
        `Boost end: ${endReason} | Buffer: ${currentAhead.toFixed(1)}s`,
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

  DEBUG.log(
    "BOOST",
    `Attached to ${video.dataset.videoObserverId || "unknown"}`,
  );

  const initialCheck = setTimeout(() => {
    if (!tabIsVisible) return;
    const ahead = getBufferAhead(video);
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
    boostBufferAfterSeek(video, true, {
      extendDuration: ratio < BOOST_CONFIG.SEEK_MIN_EFFECTIVE_RATIO,
    });
  };

  const onPlay = () => {
    if (video.__boostState?.active && video.__boostState.paused) {
      video.__boostState.paused = false;
    }
  };

  video.addEventListener("seeked", onSeeked);
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", () => {
    if (video.__boostState?.active) video.__boostState.paused = true;
  });

  return () => {
    clearTimeout(initialCheck);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("play", onPlay);
    cleanupBoost(video);
    delete video.dataset.boostAttached;
  };
}

// ═══════════════════════════════════════════════════════════════
// REDDIT SHADOW DOM HELPER
// ═══════════════════════════════════════════════════════════════
function getVideoFromPlayer(player) {
  if (!player) return null;
  if (player.shadowRoot) {
    return player.shadowRoot.querySelector("video");
  }
  return player.querySelector("video");
}

function getPlayerId(player) {
  // Use the post ID from the parent shreddit-post
  const post = player.closest("shreddit-post");
  if (post) {
    return post.getAttribute("post-id") || post.id || `player-${videoCounter}`;
  }
  return player.id || `player-${videoCounter}`;
}

// ═══════════════════════════════════════════════════════════════
// VIDEO INFO
// ═══════════════════════════════════════════════════════════════
function getVideoInfo(video) {
  if (!video)
    return {
      id: "no-video",
      src: "No source",
      currentTime: 0,
      duration: 0,
      paused: true,
      playbackRate: 1,
      bufferAhead: 0,
      muted: true,
      readyState: 0,
    };
  return {
    id: video.dataset.videoObserverId || "unknown",
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
    currentlyPlaying.pause();
  }
  currentlyPlaying = videoToPlay;
  const onEnded = () => {
    if (currentlyPlaying === videoToPlay) currentlyPlaying = null;
  };
  videoToPlay.addEventListener("ended", onEnded, { once: true });
}

// ═══════════════════════════════════════════════════════════════
// CARD CREATION
// ═══════════════════════════════════════════════════════════════
function createVideoCard(entry) {
  DEBUG.log("PANEL", `Creating card for ${entry.id}`);

  const card = document.createElement("div");
  card.className = "video-card";
  card.dataset.playerId = entry.id;

  const info = entry.info;
  const buffPercent = info.duration
    ? Math.round((info.bufferAhead / info.duration) * 100)
    : 0;

  card.innerHTML = `
    <div class="preview-container">
      <video src="${info.src}" muted preload="metadata"
        style="width:100%;height:100%;object-fit:cover;border-radius:4px;background:#1a1a2e;"></video>
    </div>
    <div class="video-info-row">
      <div class="video-id-meta">
        <span class="video-id">${entry.id}</span>
        <span class="video-meta">${Math.floor(info.currentTime)}/${Math.floor(info.duration)}s</span>
      </div>
      <span class="video-status ${info.paused ? "paused" : "playing"}">${info.paused ? "⏸ Paused" : "▶ Playing"}</span>
    </div>
    <div class="boost-indicator" style="font-size:10px;color:#4CAF50;text-align:center;padding:2px;display:none;">
      🚀 Boost 1.00x | Buffer: 0%
    </div>
  `;

  // Click handler
  card.addEventListener("click", (e) => {
    e.stopImmediatePropagation();

    // Get current video from player
    const video = getVideoFromPlayer(entry.player);
    if (!video) {
      DEBUG.log("WARN", `No video for ${entry.id}`);
      return;
    }

    if (video.paused) {
      enforceSinglePlayback(video);
      video
        .play()
        .catch((err) => DEBUG.log("ERROR", `Play failed: ${err.message}`));
    } else {
      if (currentlyPlaying === video) {
        video.pause();
      } else {
        enforceSinglePlayback(video);
        video
          .play()
          .catch((err) => DEBUG.log("ERROR", `Play failed: ${err.message}`));
      }
    }

    entry.player.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  return card;
}

function updateExistingCard(card, entry) {
  const info = entry.info;
  const statusEl = card.querySelector(".video-status");
  if (statusEl) {
    statusEl.className = `video-status ${info.paused ? "paused" : "playing"}`;
    statusEl.textContent = info.paused ? "⏸ Paused" : "▶ Playing";
  }

  const timeEl = card.querySelector(".video-meta");
  if (timeEl) {
    timeEl.textContent = `${Math.floor(info.currentTime)}/${Math.floor(info.duration)}s`;
  }

  const boostEl = card.querySelector(".boost-indicator");
  if (boostEl) {
    const isBoosting = info.playbackRate > 1;
    const buffPercent = info.duration
      ? Math.round((info.bufferAhead / info.duration) * 100)
      : 0;
    boostEl.style.display = isBoosting ? "block" : "none";
    boostEl.innerHTML = isBoosting
      ? `🚀 Boost ${info.playbackRate.toFixed(2)}x | Buffer: ${buffPercent}%`
      : "";
  }

  // Update preview video src if it changed
  const previewVideo = card.querySelector(".preview-container video");
  if (previewVideo && previewVideo.src !== info.src) {
    previewVideo.src = info.src;
  }
}

// ═══════════════════════════════════════════════════════════════
// FIXED: Panel update - track by PLAYER, not video element
// ═══════════════════════════════════════════════════════════════
function performPanelUpdate() {
  if (!panel) return;

  const list = panel.querySelector("#videos-list");
  const countEl = panel.querySelector("#video-count");
  const empty = panel.querySelector("#empty-videos");

  if (!list || !countEl || !empty) return;

  // FIXED: Remove players that are no longer in the DOM
  const playersToRemove = [];
  for (const [player, entry] of players) {
    if (!document.contains(player)) {
      DEBUG.log("CLEANUP", `Player ${entry.id} removed from DOM`);
      playersToRemove.push([player, entry]);
    }
  }

  for (const [player, entry] of playersToRemove) {
    cleanupPlayerEntry(entry);
    players.delete(player);
    const card = videoCards.get(player);
    if (card) {
      card.remove();
      videoCards.delete(player);
    }
  }

  countEl.textContent = players.size;

  if (players.size === 0) {
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";

  // Create/update cards for each player
  for (const [player, entry] of players) {
    // Always get fresh video reference from shadow DOM
    const video = getVideoFromPlayer(player);

    // Update info with current video state
    if (video) {
      entry.info = getVideoInfo(video);
      // Re-attach boost if video element changed
      if (video.dataset.boostAttached !== "true" && video.readyState >= 1) {
        entry.boostCleanup?.();
        entry.boostCleanup = attachBoostToVideo(video);
      }
    }

    let card;
    if (!videoCards.has(player)) {
      card = createVideoCard(entry);
      videoCards.set(player, card);
      list.appendChild(card);
    } else {
      card = videoCards.get(player);
      updateExistingCard(card, entry);
    }
  }

  DEBUG.log(
    "PANEL",
    `Panel: ${players.size} players, ${videoCards.size} cards`,
  );
}

function updateAllCards() {
  if (!panel || !tabIsVisible) return;

  for (const [player, entry] of players) {
    const video = getVideoFromPlayer(player);
    if (video) {
      entry.info = getVideoInfo(video);
    }
    const card = videoCards.get(player);
    if (card) {
      updateExistingCard(card, entry);
    }
  }

  setTimeout(updateAllCards, 1000);
}

function cleanupPlayerEntry(entry) {
  if (!entry) return;
  DEBUG.log("CLEANUP", `Cleaning: ${entry.id}`);

  const video = getVideoFromPlayer(entry.player);
  if (video && entry.boostCleanup) {
    entry.boostCleanup();
    entry.boostCleanup = null;
  }

  if (entry.cleanups) {
    entry.cleanups.forEach((fn) => fn());
    entry.cleanups = null;
  }

  if (currentlyPlaying) {
    const currentVideo = getVideoFromPlayer(entry.player);
    if (currentVideo && currentVideo === currentlyPlaying) {
      currentlyPlaying = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// FLOATING PANEL
// ═══════════════════════════════════════════════════════════════
function createFloatingPanel() {
  if (panel) return;

  panel = document.createElement("div");
  panel.id = "video-observer-panel";
  panel.innerHTML = `
    <header>
      🎥 Reddit Videos 
      <button class="close-btn" id="toggle-panel">✕</button>
    </header>
    <div class="tabs">
      <div class="tab active" data-tab="videos">Videos (<span id="video-count">0</span>)</div>
      <div class="tab" data-tab="logs">Logs</div>
    </div>
    <div id="videos-tab" class="content">
      <div id="videos-list"></div>
      <div id="empty-videos">No videos detected yet<br><small>Scroll to load posts</small></div>
    </div>
    <div id="logs-tab" class="content" style="display:none">
      <div id="logs" class="log-container"></div>
    </div>
    <div class="status">shreddit-player • ${new Date().toLocaleTimeString()}</div>
  `;

  document.body.appendChild(panel);
  DEBUG.log("SUCCESS", "Panel created");

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

  updateAllCards();
}

// ═══════════════════════════════════════════════════════════════
// FIXED: Track by SHREDDIT-PLAYER, not video element
// ═══════════════════════════════════════════════════════════════
function trackPlayer(player) {
  const playerId = getPlayerId(player);

  // Skip if already tracked
  if (players.has(player)) {
    return;
  }

  const video = getVideoFromPlayer(player);
  if (!video) {
    DEBUG.log("DOM", `No video in player ${playerId} yet`);
    return;
  }

  const id = `video-${++videoCounter}`;
  video.dataset.videoObserverId = id;
  video.muted = true;
  video.volume = 0.5;

  const entry = {
    id,
    player: player, // Track the PLAYER, not the video
    info: getVideoInfo(video),
    boostCleanup: null,
    cleanups: [],
    cardPreview: null,
  };

  players.set(player, entry);

  DEBUG.log("DOM", `Tracked: ${id}`, {
    playerId,
    src: (video.currentSrc || video.src || "").substring(0, 50) + "...",
    totalTracked: players.size,
  });

  // Attach buffer boost to current video
  entry.boostCleanup = attachBoostToVideo(video);

  // Watch for video element changes inside the shadow DOM
  if (player.shadowRoot) {
    const shadowObserver = new MutationObserver(() => {
      const newVideo = getVideoFromPlayer(player);
      if (newVideo && newVideo.dataset.boostAttached !== "true") {
        // Clean old boost
        if (entry.boostCleanup) entry.boostCleanup();
        // Attach to new video
        newVideo.dataset.videoObserverId = id;
        newVideo.muted = true;
        newVideo.volume = 0.5;
        entry.boostCleanup = attachBoostToVideo(newVideo);
        entry.info = getVideoInfo(newVideo);
        DEBUG.log("DOM", `Video element changed in ${id}, reattached boost`);
      }
    });

    shadowObserver.observe(player.shadowRoot, {
      childList: true,
      subtree: true,
    });
    entry.cleanups.push(() => shadowObserver.disconnect());
  }

  // Unmute on interaction
  const unmuteHandler = () => {
    const currentVideo = getVideoFromPlayer(player);
    if (currentVideo && currentVideo.muted) {
      currentVideo.muted = false;
      currentVideo.volume = 0.5;
    }
  };
  player.addEventListener("click", unmuteHandler, { once: true });
}

function observeVideos() {
  DEBUG.log("DOM", "Scanning for players...");

  const allPlayers = document.querySelectorAll("shreddit-player");
  let newCount = 0;
  let existingCount = 0;

  allPlayers.forEach((player) => {
    const video = getVideoFromPlayer(player);
    if (video) {
      if (!players.has(player)) {
        trackPlayer(player);
        newCount++;
      } else {
        existingCount++;
      }
    }
  });

  DEBUG.log(
    "DOM",
    `Scan: ${newCount} new, ${existingCount} existing, ${players.size} total`,
  );

  performPanelUpdate();
}

// ═══════════════════════════════════════════════════════════════
// MUTATION OBSERVER
// ═══════════════════════════════════════════════════════════════
function setupMutationObserver() {
  let debounceTimer = null;

  const observer = new MutationObserver((mutations) => {
    if (!tabIsVisible) return;

    let hasNewPlayers = false;
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (
          node.matches?.("shreddit-player") ||
          node.querySelectorAll?.("shreddit-player")?.length > 0
        ) {
          hasNewPlayers = true;
        }
      });
    }

    if (hasNewPlayers) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(observeVideos, 1000);
    }
  });

  chatRoot =
    document.querySelector("shreddit-feed") ||
    document.querySelector("main") ||
    document.body;
  observer.observe(chatRoot, { childList: true, subtree: true });

  DEBUG.log("DOM", `Observer watching: ${chatRoot.tagName}`);
}

// ═══════════════════════════════════════════════════════════════
// KEYBOARD NAVIGATION
// ═══════════════════════════════════════════════════════════════
function setupKeyboardNavigation() {
  document.addEventListener("keydown", (e) => {
    if (
      e.target.tagName === "INPUT" ||
      e.target.tagName === "TEXTAREA" ||
      e.target.isContentEditable
    )
      return;

    const playerEntries = Array.from(players.entries());
    if (playerEntries.length === 0) return;

    let currentIndex = -1;
    if (currentlyPlaying) {
      for (let i = 0; i < playerEntries.length; i++) {
        const video = getVideoFromPlayer(playerEntries[i][0]);
        if (video === currentlyPlaying) {
          currentIndex = i;
          break;
        }
      }
    }

    let targetIndex;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      targetIndex =
        currentIndex === -1
          ? 0
          : Math.min(currentIndex + 1, playerEntries.length - 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      targetIndex = currentIndex === -1 ? 0 : Math.max(currentIndex - 1, 0);
    } else return;

    e.preventDefault();
    const [targetPlayer] = playerEntries[targetIndex];
    targetPlayer.scrollIntoView({ behavior: "smooth", block: "center" });

    setTimeout(() => {
      const video = getVideoFromPlayer(targetPlayer);
      if (video) {
        enforceSinglePlayback(video);
        video.muted = false;
        video.volume = 0.5;
        video.play().catch(() => {});
      }
    }, 400);
  });

  DEBUG.log("INFO", "Arrow keys enabled");
}

// ═══════════════════════════════════════════════════════════════
// PAGE VISIBILITY
// ═══════════════════════════════════════════════════════════════
function onTabHidden() {
  tabIsVisible = false;
  for (const entry of players.values()) {
    const video = getVideoFromPlayer(entry.player);
    if (video && entry.boostCleanup) {
      cleanupBoost(video);
    }
  }
  if (currentlyPlaying) currentlyPlaying.pause();
}

function onTabVisible() {
  tabIsVisible = true;
  observeVideos();
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════
function init() {
  if (window.__REDDIT_OBSERVER_INIT__) return;
  window.__REDDIT_OBSERVER_INIT__ = true;

  DEBUG.log("SUCCESS", "=== Init: Panel + Boost ===");

  createFloatingPanel();

  // Delay scan for Reddit to render
  setTimeout(observeVideos, 3000);

  setupMutationObserver();
  setupKeyboardNavigation();

  document.addEventListener("visibilitychange", () => {
    document.hidden ? onTabHidden() : onTabVisible();
  });

  DEBUG.log("SUCCESS", "=== Ready ===");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
