/**
 * Keyboard navigation controller for arrow key video switching
 * ✅ UPDATED: Fires AppState playback change so panel pointer updates
 */
import { AppState } from "../core/state.js";
import { PlaybackController } from "./playback-controller.js";
import { getVideoFromPlayer } from "../engine/video-utils.js";
import { DebugLogger as debug } from "../core/debug.js";

export const KeyboardController = {
  init() {
    document.addEventListener("keydown", this._handleKeyDown.bind(this));
    debug.log("INFO", "Arrow keys enabled (with panel pointer sync)");
  },

  _handleKeyDown(e) {
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

    // ✅ Don't do anything if already on this video
    if (targetIndex === currentIndex) return;

    e.preventDefault();
    const [targetPlayer, targetEntry] = entries[targetIndex];

    // ✅ Scroll the page body to the target video
    targetPlayer.scrollIntoView({ behavior: "smooth", block: "center" });

    setTimeout(() => {
      const video = getVideoFromPlayer(targetPlayer);
      if (video) {
        video.muted = false;
        video.volume = 0.5;
        // ✅ Use PlaybackController which fires AppState playback change
        // This triggers the panel pointer update
        PlaybackController.playVideo(video);
        debug.log(
          "INFO",
          `Arrow key: switched to ${targetEntry.id} (${targetIndex + 1}/${entries.length})`,
        );
      }
    }, 400);
  },
};
