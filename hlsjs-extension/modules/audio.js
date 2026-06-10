/**
 * audio.js - Audio & Subtitle Track Features
 *
 * Manages audio track selection, subtitle track selection,
 * track switching, and caption rendering configuration.
 */

class AudioController {
  constructor(player) {
    this.player = player;
    this.hls = player.hls;
    this.video = player.video;

    // Track state
    this.audioTracks = [];
    this.subtitleTracks = [];
    this.currentAudioTrack = -1;
    this.currentSubtitleTrack = -1;
    this.subtitleDisplay = true;

    Logger.info("audio", "AudioController initialized");
    this._setupEvents();
  }

  // --------------------------------------------------------------------------
  // Event Setup
  // --------------------------------------------------------------------------

  _setupEvents() {
    if (!this.hls) {
      Logger.warn("audio", "hls instance not available for event setup");
      return;
    }

    // Manifest parsed - populate tracks
    this.hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      this._processTracks(data);
    });

    // Audio track switched
    this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
      this.currentAudioTrack = data.id;
      const track = this.audioTracks[data.id];
      Logger.info(
        "audio",
        `🔊 Audio track switched to ${data.id}: ${track?.name || "Unknown"}`,
        {
          id: data.id,
          name: track?.name,
          lang: track?.lang,
          codec: track?.audioCodec,
        },
      );
    });

    // Audio track loading
    this.hls.on(Hls.Events.AUDIO_TRACK_LOADING, (event, data) => {
      Logger.debug("audio", `Loading audio track: ${data.url}`);
    });

    this.hls.on(Hls.Events.AUDIO_TRACK_LOADED, (event, data) => {
      Logger.debug("audio", "Audio track loaded", {
        id: data.id,
        details: data.details ? "Available" : "None",
      });
    });

    // Subtitle track switched
    this.hls.on(Hls.Events.SUBTITLE_TRACK_SWITCHED, (event, data) => {
      this.currentSubtitleTrack = data.id;
      const track = this.subtitleTracks[data.id];
      Logger.info(
        "audio",
        `📝 Subtitle track switched to ${data.id}: ${track?.name || "Off"}`,
        {
          id: data.id,
          name: track?.name,
          lang: track?.lang,
        },
      );
    });

    // Subtitle track loading
    this.hls.on(Hls.Events.SUBTITLE_TRACK_LOADING, (event, data) => {
      Logger.debug("audio", `Loading subtitle track: ${data.url}`);
    });

    this.hls.on(Hls.Events.SUBTITLE_TRACK_LOADED, (event, data) => {
      Logger.debug("audio", "Subtitle track loaded", {
        id: data.id,
        details: data.details ? "Available" : "None",
      });
    });

    // Non-native text tracks
    this.hls.on(Hls.Events.NON_NATIVE_TEXT_TRACKS_FOUND, (event, data) => {
      Logger.info("audio", "Non-native text tracks found", {
        count: data.tracks.length,
        tracks: data.tracks.map((t) => ({
          label: t.label,
          kind: t.kind,
          lang: t.lang,
        })),
      });
    });

    // Cues parsed
    this.hls.on(Hls.Events.CUES_PARSED, (event, data) => {
      Logger.debug("audio", "Cues parsed", {
        cuesCount: data.cues.length,
        track: data.track,
      });
    });

    Logger.info("audio", "✓ Audio/Subtitle events setup");
  }

  // --------------------------------------------------------------------------
  // Track Processing
  // --------------------------------------------------------------------------

  _processTracks(data) {
    // Process audio tracks
    this.audioTracks = (data.audioTracks || []).map((track, index) => ({
      index,
      id: track.id || index,
      name: track.name || `${track.lang || "Unknown"} - Track ${index + 1}`,
      lang: track.lang || "und",
      audioCodec: track.audioCodec,
      groupId: track.groupId,
      default: track.default || false,
      autoselect: track.autoselect || false,
      characteristics: track.characteristics,
    }));

    Logger.info("audio", "Audio tracks processed", {
      count: this.audioTracks.length,
      tracks: this.audioTracks.map((t) => ({
        name: t.name,
        lang: t.lang,
        default: t.default,
      })),
    });

    // Process subtitle tracks
    this.subtitleTracks = (data.subtitleTracks || []).map((track, index) => ({
      index,
      id: track.id || index,
      name: track.name || track.lang || `Track ${index + 1}`,
      lang: track.lang || "und",
      groupId: track.groupId,
      default: track.default || false,
      autoselect: track.autoselect || false,
      forced: track.forced || false,
    }));

    Logger.info("audio", "Subtitle tracks processed", {
      count: this.subtitleTracks.length,
      tracks: this.subtitleTracks.map((t) => ({
        name: t.name,
        lang: t.lang,
        forced: t.forced,
      })),
    });

    // Set initial audio track
    if (this.audioTracks.length > 0 && this.hls.audioTrack === -1) {
      const defaultTrack = this.audioTracks.find((t) => t.default);
      if (defaultTrack) {
        this.hls.audioTrack = defaultTrack.index;
        this.currentAudioTrack = defaultTrack.index;
      }
    } else {
      this.currentAudioTrack = this.hls.audioTrack;
    }

    // Set initial subtitle track
    this.currentSubtitleTrack = this.hls.subtitleTrack;
  }

  // ==========================================================================
  // Audio Track Management
  // ==========================================================================

  /**
   * Get all audio tracks
   */
  getAudioTracks() {
    Logger.debug("audio", "Getting audio tracks", {
      count: this.audioTracks.length,
    });
    return this.audioTracks;
  }

  /**
   * Set audio track by index
   */
  setAudioTrack(index) {
    if (!this.hls) {
      Logger.error("audio", "Cannot set audio track: hls not available");
      return;
    }

    if (index < 0 || index >= this.audioTracks.length) {
      Logger.error(
        "audio",
        `Invalid audio track index: ${index} (valid: 0-${this.audioTracks.length - 1})`,
      );
      return;
    }

    const track = this.audioTracks[index];
    Logger.info("audio", `🔊 Setting audio track to ${index}: ${track.name}`, {
      lang: track.lang,
      codec: track.audioCodec,
    });

    this.hls.audioTrack = index;
    this.currentAudioTrack = index;
  }

  /**
   * Set audio track by criteria
   */
  setAudioTrackByCriteria(criteria) {
    if (!this.hls) return null;

    Logger.info("audio", "Setting audio track by criteria", criteria);

    const result = this.hls.setAudioOption(criteria);

    if (result) {
      Logger.info("audio", "✓ Audio track selected", {
        name: result.name,
        lang: result.lang,
      });
      this.currentAudioTrack = this.hls.audioTrack;
    } else {
      Logger.warn("audio", "No matching audio track found for criteria");
    }

    return result;
  }

  /**
   * Get current audio track
   */
  getCurrentAudioTrack() {
    if (
      this.currentAudioTrack >= 0 &&
      this.currentAudioTrack < this.audioTracks.length
    ) {
      return this.audioTracks[this.currentAudioTrack];
    }
    return null;
  }

  // ==========================================================================
  // Subtitle Track Management
  // ==========================================================================

  /**
   * Get all subtitle tracks
   */
  getSubtitleTracks() {
    Logger.debug("audio", "Getting subtitle tracks", {
      count: this.subtitleTracks.length,
    });
    return this.subtitleTracks;
  }

  /**
   * Set subtitle track by index (-1 = off)
   */
  setSubtitleTrack(index) {
    if (!this.hls) {
      Logger.error("audio", "Cannot set subtitle track: hls not available");
      return;
    }

    if (index === -1) {
      Logger.info("audio", "📝 Turning subtitles off");
      this.hls.subtitleTrack = -1;
      this.currentSubtitleTrack = -1;
      return;
    }

    if (index < 0 || index >= this.subtitleTracks.length) {
      Logger.error(
        "audio",
        `Invalid subtitle track index: ${index} (valid: -1 to ${this.subtitleTracks.length - 1})`,
      );
      return;
    }

    const track = this.subtitleTracks[index];
    Logger.info(
      "audio",
      `📝 Setting subtitle track to ${index}: ${track.name}`,
      {
        lang: track.lang,
        forced: track.forced,
      },
    );

    this.hls.subtitleTrack = index;
    this.currentSubtitleTrack = index;
  }

  /**
   * Set subtitle track by criteria
   */
  setSubtitleTrackByCriteria(criteria) {
    if (!this.hls) return null;

    Logger.info("audio", "Setting subtitle track by criteria", criteria);

    const result = this.hls.setSubtitleOption(criteria);

    if (result) {
      Logger.info("audio", "✓ Subtitle track selected", {
        name: result.name,
        lang: result.lang,
      });
      this.currentSubtitleTrack = this.hls.subtitleTrack;
    } else {
      Logger.warn("audio", "No matching subtitle track found for criteria");
    }

    return result;
  }

  /**
   * Toggle subtitle display
   */
  toggleSubtitleDisplay() {
    if (!this.hls) return;

    this.subtitleDisplay = !this.subtitleDisplay;
    this.hls.subtitleDisplay = this.subtitleDisplay;

    Logger.info(
      "audio",
      `📝 Subtitles ${this.subtitleDisplay ? "shown" : "hidden"}`,
    );
  }

  /**
   * Get current subtitle track
   */
  getCurrentSubtitleTrack() {
    if (
      this.currentSubtitleTrack >= 0 &&
      this.currentSubtitleTrack < this.subtitleTracks.length
    ) {
      return this.subtitleTracks[this.currentSubtitleTrack];
    }
    return null;
  }

  // ==========================================================================
  // Audio Preference Configuration
  // ==========================================================================

  /**
   * Set audio preference for automatic track selection
   */
  setAudioPreference(preferences) {
    if (!this.hls) return;

    Logger.info("audio", "Setting audio preferences", preferences);

    if (preferences.lang) {
      this.hls.config.audioPreference = {
        ...this.hls.config.audioPreference,
        lang: preferences.lang,
      };
    }

    if (preferences.name) {
      this.hls.config.audioPreference = {
        ...this.hls.config.audioPreference,
        name: preferences.name,
      };
    }

    if (preferences.characteristics) {
      this.hls.config.audioPreference = {
        ...this.hls.config.audioPreference,
        characteristics: preferences.characteristics,
      };
    }

    Logger.info("audio", "✓ Audio preferences updated");
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------

  getAudioStatus() {
    const status = {
      audioTracks: this.audioTracks.length,
      subtitleTracks: this.subtitleTracks.length,
      currentAudioTrack: this.getCurrentAudioTrack(),
      currentSubtitleTrack: this.getCurrentSubtitleTrack(),
      subtitleDisplay: this.subtitleDisplay,
      subtitleTrackIndex: this.currentSubtitleTrack,
      audioTrackIndex: this.currentAudioTrack,
    };

    Logger.info("audio", "Audio/Subtitle status", status);
    return status;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy() {
    Logger.info("audio", "Destroying AudioController...");
    this.audioTracks = [];
    this.subtitleTracks = [];
    Logger.info("audio", "✓ AudioController destroyed");
  }
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = AudioController;
}
if (typeof window !== "undefined") {
  window.AudioController = AudioController;
}

Logger.info("audio", "✓ Audio/Subtitle module loaded");
