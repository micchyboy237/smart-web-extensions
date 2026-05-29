/**
 * Video card component - creates and updates individual video cards
 * with chunk preview loading integrated with boost window priority
 */
import { createCardHTML } from "./templates.js";
import { AppState } from "../core/state.js";
import { PlaybackController } from "../controllers/playback-controller.js";
import { getVideoFromPlayer, getVideoInfo } from "../engine/video-utils.js";
import { ChunkPreviewEngine } from "../engine/chunk-preview.js";
import { DebugLogger as debug } from "../core/debug.js";

// Track which cards have their preview initialized
const initializedPreviews = new WeakSet();
// Track preview cleanups for proper teardown
const previewCleanups = new WeakMap();

/**
 * Initialize chunk preview for a video element
 */
async function initializeChunkPreview(previewVideo, entryId, card) {
  if (initializedPreviews.has(previewVideo)) {
    console.log(`[VideoCard] Preview already initialized for ${entryId}`);
    return;
  }

  console.log(`[VideoCard] Initializing chunk preview for ${entryId}`);

  // Ensure video has a source
  if (!previewVideo.src && previewVideo.dataset.src) {
    previewVideo.src = previewVideo.dataset.src;
  }

  // Set up chunk preview
  const cleanup = await ChunkPreviewEngine.setup(previewVideo, entryId, card);

  // Store cleanup function
  if (cleanup) {
    previewCleanups.set(previewVideo, cleanup);
  }

  initializedPreviews.add(previewVideo);
  console.log(`[VideoCard] Preview ready: ${entryId}`);
}

/**
 * Create a video card with chunk preview support
 */
export function createVideoCard(entry) {
  debug.log("PANEL", `Creating card for ${entry.id}`);

  const card = document.createElement("div");
  card.className = "video-card";
  card.dataset.playerId = entry.id;
  card.innerHTML = createCardHTML(entry);

  // Set initial priority
  card.dataset.priority = "background";

  // Get the preview video element
  const previewVideo = card.querySelector(".preview-container video");

  if (previewVideo) {
    // ✅ Store original src and set up for chunk preview
    const originalSrc = previewVideo.src;

    if (originalSrc) {
      previewVideo.dataset.src = originalSrc;
      // Keep src for metadata loading, chunk engine will manage it
    }

    // Initialize preview when video is ready or card becomes visible
    const tryInit = () => {
      if (
        previewVideo.readyState >= 1 &&
        !initializedPreviews.has(previewVideo)
      ) {
        initializeChunkPreview(previewVideo, entry.id, card);
      }
    };

    // Try immediately if metadata is loaded
    if (previewVideo.readyState >= 1) {
      tryInit();
    } else {
      // Wait for metadata
      previewVideo.addEventListener("loadedmetadata", tryInit, { once: true });

      // Fallback: try after a delay
      setTimeout(() => {
        if (!initializedPreviews.has(previewVideo) && previewVideo.src) {
          tryInit();
        }
      }, 3000);
    }
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
 * Update video card with priority-based preview management
 */
export function updateVideoCard(card, entry) {
  const info = entry.info;

  // Update selected state
  const currentVideo = getVideoFromPlayer(entry.player);
  if (currentVideo === AppState.getCurrentlyPlaying()) {
    card.classList.add("selected");
    card.dataset.priority = "playing";
  } else {
    card.classList.remove("selected");
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
    const isBoosting = info.playbackRate > 1.05;
    const buffPercent = info.duration
      ? Math.round((info.bufferAhead / info.duration) * 100)
      : 0;
    boostEl.style.display = isBoosting ? "block" : "none";
    boostEl.innerHTML = isBoosting
      ? `🚀 Boost ${info.playbackRate.toFixed(2)}x | Buffer: ${buffPercent}%`
      : "";
  }

  // ✅ Smart preview initialization based on priority
  const previewVideo = card.querySelector(".preview-container video");
  if (previewVideo && !initializedPreviews.has(previewVideo)) {
    const priority = card.dataset.priority;

    // Initialize previews for playing/nearby priority
    if (priority === "playing" || priority === "nearby") {
      // Ensure video has source
      if (!previewVideo.src && previewVideo.dataset.src) {
        previewVideo.src = previewVideo.dataset.src;
      }

      if (previewVideo.src) {
        initializeChunkPreview(previewVideo, entry.id, card);
      }
    }
    // Background cards: don't initialize until hovered or scrolled into view
  }
}

/**
 * Force load preview for a specific card
 */
export function loadCardPreview(card) {
  const previewVideo = card.querySelector(".preview-container video");
  if (previewVideo && !initializedPreviews.has(previewVideo)) {
    if (!previewVideo.src && previewVideo.dataset.src) {
      previewVideo.src = previewVideo.dataset.src;
    }
    if (previewVideo.src) {
      const entryId = card.dataset.playerId || "unknown";
      initializeChunkPreview(previewVideo, entryId, card);
    }
  }
}

/**
 * Unload preview to free memory
 */
export function unloadCardPreview(card) {
  const previewVideo = card.querySelector(".preview-container video");
  if (previewVideo && initializedPreviews.has(previewVideo)) {
    const cleanup = previewCleanups.get(previewVideo);
    if (cleanup) {
      cleanup();
      previewCleanups.delete(previewVideo);
    }

    ChunkPreviewEngine.cleanup(previewVideo);
    initializedPreviews.delete(previewVideo);

    // Save src for later reload
    if (previewVideo.src) {
      previewVideo.dataset.src = previewVideo.src;
    }

    // Release memory
    previewVideo.removeAttribute("src");
    previewVideo.load();

    console.log(
      `[VideoCard] Unloaded preview for ${card.dataset.playerId || "unknown"}`,
    );
  }
}

/**
 * Clean up all previews (for extension unload)
 */
export function cleanupAllPreviews() {
  for (const [video, cleanup] of previewCleanups) {
    try {
      cleanup();
    } catch (e) {
      console.warn("[VideoCard] Cleanup error:", e);
    }
  }
  previewCleanups.clear();
  initializedPreviews.clear();
}
