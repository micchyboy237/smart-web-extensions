/**
 * Video card component - creates and updates individual video cards
 */
import { createCardHTML } from "./templates.js";
import { AppState } from "../core/state.js";
import { PlaybackController } from "../controllers/playback-controller.js";
import { getVideoFromPlayer } from "../engine/video-utils.js";
import { DebugLogger as debug } from "../core/debug.js";

export function createVideoCard(entry) {
  debug.log("PANEL", `Creating card for ${entry.id}`);

  const card = document.createElement("div");
  card.className = "video-card";
  card.dataset.playerId = entry.id;
  card.innerHTML = createCardHTML(entry);

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

export function updateVideoCard(card, entry) {
  const info = entry.info;

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

  // Update preview video src if changed
  const previewVideo = card.querySelector(".preview-container video");
  if (previewVideo && previewVideo.src !== info.src) {
    previewVideo.src = info.src;
  }
}
