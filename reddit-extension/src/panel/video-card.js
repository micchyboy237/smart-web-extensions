/**
 * Video card component - creates and updates individual video cards
 * with smart preview loading based on boost window priority
 */
import { createCardHTML } from "./templates.js";
import { AppState } from "../core/state.js";
import { PlaybackController } from "../controllers/playback-controller.js";
import { getVideoFromPlayer, getVideoInfo } from "../engine/video-utils.js";
import { DebugLogger as debug } from "../core/debug.js";

// Track which cards have their preview loaded
const loadedPreviews = new WeakSet();
// Track visible cards for lazy loading
let previewObserver = null;

/**
 * Set up intersection observer for lazy-loading preview videos
 */
function setupPreviewObserver() {
  if (previewObserver) return;

  previewObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const card = entry.target;
          const previewVideo = card.querySelector(".preview-container video");
          if (previewVideo && !loadedPreviews.has(previewVideo)) {
            // Load the preview
            loadPreview(previewVideo);
            loadedPreviews.add(previewVideo);
          }
        }
      });
    },
    {
      root: document.querySelector("#videos-list"),
      rootMargin: "200px", // Load 200px before visible
      threshold: 0.1,
    },
  );
}

/**
 * Load a preview video (only metadata + first frame)
 */
function loadPreview(video) {
  if (!video || video.dataset.previewLoaded === "true") return;

  video.dataset.previewLoaded = "true";

  // Only preload metadata, don't autoplay
  video.preload = "metadata";

  // Load just enough to show first frame
  video.addEventListener(
    "loadedmetadata",
    () => {
      // Seek to 1 second for thumbnail
      if (video.duration > 1) {
        video.currentTime = 1;
      }
    },
    { once: true },
  );

  // Prevent the preview from buffering the whole video
  video.addEventListener("suspend", () => {
    // Browser suspended loading - good, we have enough
  });

  // Stop loading after getting the poster frame
  let stopped = false;
  video.addEventListener(
    "seeked",
    () => {
      if (!stopped && video.currentTime >= 1) {
        stopped = true;
        // Remove src to stop further buffering, but keep the frame
        const src = video.src;
        video.removeAttribute("src");
        // Use the current frame as poster
        video.poster = src + "#t=1";
      }
    },
    { once: true },
  );
}

/**
 * Create a video card with lazy preview loading
 */
export function createVideoCard(entry) {
  debug.log("PANEL", `Creating card for ${entry.id}`);

  const card = document.createElement("div");
  card.className = "video-card";
  card.dataset.playerId = entry.id;
  card.innerHTML = createCardHTML(entry);

  // ✅ Highlight if this is the currently selected video
  const currentVideo = getVideoFromPlayer(entry.player);
  if (currentVideo === AppState.getCurrentlyPlaying()) {
    card.classList.add("selected");
    card.dataset.priority = "playing";
  }

  // ✅ Add priority data attribute for styling
  card.dataset.priority = "background";

  // Set up lazy preview loading
  setupPreviewObserver();
  const previewVideo = card.querySelector(".preview-container video");
  if (previewVideo) {
    // Don't load yet - let intersection observer handle it
    previewVideo.removeAttribute("src");
    previewVideo.dataset.src = entry.info.src; // Store for later
    previewObserver.observe(card);
  }

  // Click handler
  card.addEventListener("click", (e) => {
    e.stopImmediatePropagation();
    const video = getVideoFromPlayer(entry.player);
    if (!video) {
      debug.log("WARN", `No video for ${entry.id}`);
      return;
    }
    if (video.paused) {
      PlaybackController.playVideo(video);
    } else {
      if (AppState.getCurrentlyPlaying() === video) {
        video.pause();
      } else {
        PlaybackController.playVideo(video);
      }
    }
    entry.player.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  return card;
}

/**
 * Update video card - now also manages preview loading based on priority
 */
export function updateVideoCard(card, entry) {
  const info = entry.info;

  // ✅ Update selected state
  const currentVideo = getVideoFromPlayer(entry.player);
  if (currentVideo === AppState.getCurrentlyPlaying()) {
    card.classList.add("selected");
  } else {
    card.classList.remove("selected");
  }

  // ✅ Update priority indicator
  if (currentVideo === AppState.getCurrentlyPlaying()) {
    card.dataset.priority = "playing";
  } else {
    // Check if this card is in the boost window
    card.dataset.priority = entry.boostPriority || "background";
  }

  // Update status
  const statusEl = card.querySelector(".video-status");
  if (statusEl) {
    statusEl.className = `video-status ${info.paused ? "paused" : "playing"}`;
    statusEl.textContent = info.paused ? "⏸ Paused" : "▶ Playing";
  }

  // Update time display
  const timeEl = card.querySelector(".video-meta");
  if (timeEl) {
    timeEl.textContent = `${Math.floor(info.currentTime)}/${Math.floor(info.duration)}s`;
  }

  // Update boost indicator
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

  // ✅ Smart preview loading
  const previewVideo = card.querySelector(".preview-container video");
  if (previewVideo && !loadedPreviews.has(previewVideo)) {
    const priority = card.dataset.priority;

    // Immediately load previews for playing/nearby, lazy load for others
    if (priority === "playing" || priority === "nearby") {
      previewVideo.src = previewVideo.dataset.src || info.src;
      loadPreview(previewVideo);
      loadedPreviews.add(previewVideo);
      previewObserver?.unobserve(card);
    }
    // Background cards: left to intersection observer
  }
}

/**
 * Force load preview for a specific card
 */
export function loadCardPreview(card) {
  const previewVideo = card.querySelector(".preview-container video");
  if (previewVideo && !loadedPreviews.has(previewVideo)) {
    previewVideo.src = previewVideo.dataset.src;
    loadPreview(previewVideo);
    loadedPreviews.add(previewVideo);
    previewObserver?.unobserve(card);
  }
}

/**
 * Unload preview to free memory
 */
export function unloadCardPreview(card) {
  const previewVideo = card.querySelector(".preview-container video");
  if (previewVideo) {
    previewVideo.removeAttribute("src");
    loadedPreviews.delete(previewVideo);
    // Re-observe for later
    previewObserver?.observe(card);
  }
}
