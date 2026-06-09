/**
 * Single playback controller - ensures only one video plays at a time
 */
import { AppState } from "../core/state.js";
import { DebugLogger as debug } from "../core/debug.js";

export const PlaybackController = {
  /**
   * Play a video, pausing any currently playing video
   */
  enforceSinglePlayback(videoToPlay) {
    const currentlyPlaying = AppState.getCurrentlyPlaying();
    if (currentlyPlaying && currentlyPlaying !== videoToPlay) {
      debug.log("INFO", "Pausing previous video");
      currentlyPlaying.pause();
    }
    AppState.setCurrentlyPlaying(videoToPlay);
    // Auto-clear when video ends
    const onEnded = () => {
      if (AppState.getCurrentlyPlaying() === videoToPlay) {
        AppState.setCurrentlyPlaying(null);
      }
    };
    videoToPlay.addEventListener("ended", onEnded, { once: true });
  },

  /** Pause the currently playing video */
  pauseCurrent() {
    const current = AppState.getCurrentlyPlaying();
    if (current) {
      current.pause();
    }
  },

  /** Play a video with error handling */
  async playVideo(video) {
    if (!video) return false;
    try {
      this.enforceSinglePlayback(video);
      await video.play();
      return true;
    } catch (err) {
      // ✅ Only log if it's not an abort error (expected when pausing)
      if (err.name === "AbortError") {
        debug.log("INFO", "Play aborted (expected)");
      } else {
        debug.log("ERROR", `Play failed: ${err.message}`);
      }
      return false;
    }
  },
};
