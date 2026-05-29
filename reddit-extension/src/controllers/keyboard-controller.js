/**
 * Keyboard navigation controller for arrow key video switching
 */
import { AppState } from "../core/state.js";
import { PlaybackController } from "./playback-controller.js";
import { getVideoFromPlayer } from "../engine/video-utils.js";
import { DebugLogger as debug } from "../core/debug.js";

export const KeyboardController = {
  /** Initialize keyboard listeners */
  init() {
    document.addEventListener("keydown", this._handleKeyDown.bind(this));
    debug.log("INFO", "Arrow keys enabled");
  },

  _handleKeyDown(e) {
    // Ignore when typing in inputs
    if (
      e.target.tagName === "INPUT" ||
      e.target.tagName === "TEXTAREA" ||
      e.target.isContentEditable
    )
      return;

    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key))
      return;

    const entries = AppState.getPlayerEntries();
    if (entries.length === 0) return;

    // Find current index
    let currentIndex = -1;
    const currentlyPlaying = AppState.getCurrentlyPlaying();
    if (currentlyPlaying) {
      for (let i = 0; i < entries.length; i++) {
        const video = getVideoFromPlayer(entries[i][0]);
        if (video === currentlyPlaying) {
          currentIndex = i;
          break;
        }
      }
    }

    // Calculate target
    let targetIndex;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      targetIndex =
        currentIndex === -1
          ? 0
          : Math.min(currentIndex + 1, entries.length - 1);
    } else {
      targetIndex = currentIndex === -1 ? 0 : Math.max(currentIndex - 1, 0);
    }

    e.preventDefault();
    const [targetPlayer] = entries[targetIndex];
    targetPlayer.scrollIntoView({ behavior: "smooth", block: "center" });

    setTimeout(() => {
      const video = getVideoFromPlayer(targetPlayer);
      if (video) {
        video.muted = false;
        video.volume = 0.5;
        PlaybackController.playVideo(video);
      }
    }, 400);
  },
};
