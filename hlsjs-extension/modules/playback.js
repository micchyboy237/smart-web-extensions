/**
 * playback.js - Playback Control Features
 *
 * Handles manual start/stop, seeking, buffering state monitoring,
 * pause/resume buffering, and playback position tracking.
 */

class PlaybackController {
  constructor(player) {
    this.player = player;
    this.hls = player.hls;
    this.video = player.video;
    this.isActive = false;

    // Buffering state
    this.bufferingEnabled = true;
    this.bufferingPaused = false;

    // Buffer monitoring interval
    this.bufferMonitorInterval = null;
    this.positionMonitorInterval = null;

    Logger.info("playback", "PlaybackController initialized");
    this._setupEvents();
  }

  // --------------------------------------------------------------------------
  // Event Setup
  // --------------------------------------------------------------------------

  _setupEvents() {
    if (!this.hls) {
      Logger.warn("playback", "hls instance not available for event setup");
      return;
    }

    // Buffer full event
    this.hls.on(Hls.Events.BUFFER_EOS, (event, data) => {
      Logger.info("playback", "📊 Buffer reached end of stream", {
        type: data.type,
      });
    });

    // Buffer flushed
    this.hls.on(Hls.Events.BUFFER_FLUSHED, (event, data) => {
      Logger.info("playback", "🧹 Buffer flushed (back-buffer eviction)");
    });

    // STALL detected (hls.js internal stall)
    this.hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
        Logger.warn("playback", "⚠️ Playback stalled - buffer empty", {
          buffer: data.buffer,
        });
      }
    });

    Logger.info("playback", "✓ Playback events setup");
  }

  // ==========================================================================
  // Manual Start/Stop Loading
  // ==========================================================================

  startLoading(position = 0) {
    if (!this.hls) {
      Logger.error("playback", "Cannot start loading: hls not available");
      return;
    }

    Logger.info(
      "playback",
      `🔄 Starting fragment loading from position ${position}s`,
    );
    this.hls.startLoad(position);
    this.isActive = true;
    this.bufferingPaused = false;
  }

  stopLoading() {
    if (!this.hls) {
      Logger.error("playback", "Cannot stop loading: hls not available");
      return;
    }

    Logger.info("playback", "⏹️ Stopping fragment loading");
    this.hls.stopLoad();
    this.isActive = false;
  }

  // --------------------------------------------------------------------------
  // Pause/Resume Buffering
  // --------------------------------------------------------------------------

  pauseBuffering() {
    if (!this.hls) return;

    Logger.info("playback", "⏸️ Pausing fragment buffering");
    this.hls.pauseBuffering();
    this.bufferingPaused = true;

    // Log current state
    Logger.debug("playback", "Buffering state", {
      bufferingEnabled: this.hls.bufferingEnabled,
      bufferingPaused: this.bufferingPaused,
    });
  }

  resumeBuffering() {
    if (!this.hls) return;

    Logger.info("playback", "▶️ Resuming fragment buffering");
    this.hls.resumeBuffering();
    this.bufferingPaused = false;

    Logger.debug("playback", "Buffering state", {
      bufferingEnabled: this.hls.bufferingEnabled,
      bufferingPaused: this.bufferingPaused,
    });
  }

  toggleBuffering() {
    if (this.bufferingPaused) {
      this.resumeBuffering();
    } else {
      this.pauseBuffering();
    }
  }

  // --------------------------------------------------------------------------
  // Seeking
  // --------------------------------------------------------------------------

  seekTo(seconds) {
    if (!this.video) {
      Logger.error("playback", "Cannot seek: video element not available");
      return;
    }

    const targetTime = Math.max(
      0,
      Math.min(seconds, this.video.duration || Infinity),
    );

    Logger.info("playback", `🎯 Seeking to ${targetTime.toFixed(2)}s`, {
      requestedSeconds: seconds,
      clampedSeconds: targetTime.toFixed(2),
      duration: this.video.duration?.toFixed(2) || "unknown",
    });

    this.video.currentTime = targetTime;
  }

  seekRelative(offsetSeconds) {
    if (!this.video) return;

    const currentTime = this.video.currentTime;
    const targetTime = currentTime + offsetSeconds;

    Logger.info(
      "playback",
      `🎯 Relative seek: ${offsetSeconds > 0 ? "+" : ""}${offsetSeconds.toFixed(1)}s`,
      {
        from: currentTime.toFixed(2),
        to: targetTime.toFixed(2),
      },
    );

    this.seekTo(targetTime);
  }

  // --------------------------------------------------------------------------
  // Buffer Monitoring
  // --------------------------------------------------------------------------

  startBufferMonitoring(intervalMs = 2000) {
    Logger.info(
      "playback",
      `Starting buffer monitoring (interval: ${intervalMs}ms)`,
    );

    this.stopBufferMonitoring();

    this.bufferMonitorInterval = setInterval(() => {
      this._reportBufferStatus();
    }, intervalMs);

    this._reportBufferStatus(); // Immediate first report
  }

  stopBufferMonitoring() {
    if (this.bufferMonitorInterval) {
      clearInterval(this.bufferMonitorInterval);
      this.bufferMonitorInterval = null;
      Logger.info("playback", "Buffer monitoring stopped");
    }
  }

  _reportBufferStatus() {
    if (!this.video) return;

    const buffered = this.video.buffered;
    if (buffered.length === 0) {
      Logger.debug("playback", "📊 Buffer: empty");
      return;
    }

    const ranges = [];
    for (let i = 0; i < buffered.length; i++) {
      ranges.push({
        start: buffered.start(i).toFixed(2),
        end: buffered.end(i).toFixed(2),
      });
    }

    const bufferedEnd = buffered.end(buffered.length - 1);
    const duration = this.video.duration || 1;
    const percent = ((bufferedEnd / duration) * 100).toFixed(1);
    const bufferAhead = bufferedEnd - this.video.currentTime;

    Logger.debug("playback", "📊 Buffer status", {
      ranges,
      bufferedEnd: bufferedEnd.toFixed(2),
      currentTime: this.video.currentTime.toFixed(2),
      bufferAhead: bufferAhead.toFixed(2) + "s",
      percentComplete: percent + "%",
      duration: duration.toFixed(2),
    });

    // Check if buffered to end
    if (this.hls?.bufferedToEnd) {
      Logger.debug("playback", "✓ Stream buffered to end");
    }
  }

  // --------------------------------------------------------------------------
  // Position Monitoring
  // --------------------------------------------------------------------------

  startPositionMonitoring(intervalMs = 1000) {
    Logger.info(
      "playback",
      `Starting position monitoring (interval: ${intervalMs}ms)`,
    );

    this.stopPositionMonitoring();

    this.positionMonitorInterval = setInterval(() => {
      if (this.video && !this.video.paused) {
        Logger.debug("playback", "⏱️ Playback position", {
          currentTime: this.video.currentTime.toFixed(2),
          duration: this.video.duration?.toFixed(2) || "unknown",
          playbackRate: this.video.playbackRate,
        });
      }
    }, intervalMs);
  }

  stopPositionMonitoring() {
    if (this.positionMonitorInterval) {
      clearInterval(this.positionMonitorInterval);
      this.positionMonitorInterval = null;
      Logger.info("playback", "Position monitoring stopped");
    }
  }

  // --------------------------------------------------------------------------
  // Playback Rate Control
  // --------------------------------------------------------------------------

  setPlaybackRate(rate) {
    if (!this.video) return;

    const clampedRate = Math.max(0.25, Math.min(4.0, rate));
    this.video.playbackRate = clampedRate;

    Logger.info("playback", `⏩ Playback rate set to ${clampedRate}x`, {
      requestedRate: rate,
      clampedRate,
    });
  }

  getPlaybackRate() {
    return this.video ? this.video.playbackRate : 1;
  }

  // --------------------------------------------------------------------------
  // Volume Control
  // --------------------------------------------------------------------------

  setVolume(volume) {
    if (!this.video) return;

    const clampedVolume = Math.max(0, Math.min(1, volume));
    this.video.volume = clampedVolume;

    Logger.info(
      "playback",
      `🔊 Volume set to ${Math.round(clampedVolume * 100)}%`,
    );
  }

  toggleMute() {
    if (!this.video) return;

    this.video.muted = !this.video.muted;
    Logger.info("playback", `🔇 ${this.video.muted ? "Muted" : "Unmuted"}`);
  }

  // --------------------------------------------------------------------------
  // Status Report
  // --------------------------------------------------------------------------

  getPlaybackStatus() {
    if (!this.video) return null;

    const status = {
      playing: !this.video.paused,
      currentTime: this.video.currentTime,
      duration: this.video.duration,
      playbackRate: this.video.playbackRate,
      volume: this.video.volume,
      muted: this.video.muted,
      bufferingPaused: this.bufferingPaused,
      bufferedRanges: [],
      bufferPercent: 0,
    };

    const buffered = this.video.buffered;
    for (let i = 0; i < buffered.length; i++) {
      status.bufferedRanges.push({
        start: buffered.start(i),
        end: buffered.end(i),
      });
    }

    if (buffered.length > 0) {
      const bufferedEnd = buffered.end(buffered.length - 1);
      status.bufferPercent = (bufferedEnd / (this.video.duration || 1)) * 100;
    }

    Logger.info("playback", "Playback status requested", status);
    return status;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy() {
    Logger.info("playback", "Destroying PlaybackController...");

    this.stopBufferMonitoring();
    this.stopPositionMonitoring();

    this.isActive = false;

    Logger.info("playback", "✓ PlaybackController destroyed");
  }
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = PlaybackController;
}
if (typeof window !== "undefined") {
  window.PlaybackController = PlaybackController;
}

Logger.info("playback", "✓ Playback module loaded");
