const HLS_EVENTS = [
  "ASSET_LIST_LOADED",
  "ASSET_LIST_LOADING",
  "AUDIO_TRACK_LOADED",
  "AUDIO_TRACK_LOADING",
  "AUDIO_TRACK_SWITCHED",
  "AUDIO_TRACK_SWITCHING",
  "AUDIO_TRACK_UPDATED",
  "AUDIO_TRACKS_UPDATED",
  "BACK_BUFFER_REACHED",
  "BUFFER_APPENDED",
  "BUFFER_APPENDING",
  "BUFFER_CODECS",
  "BUFFER_CREATED",
  "BUFFER_EOS",
  "BUFFER_FLUSHED",
  "BUFFER_FLUSHING",
  "BUFFER_RESET",
  "BUFFERED_TO_END",
  "CUES_PARSED",
  "DESTROYING",
  "ERROR",
  "EVENT_CUE_ENTER",
  "FPS_DROP",
  "FPS_DROP_LEVEL_CAPPING",
  "FRAG_BUFFERED",
  "FRAG_CHANGED",
  "FRAG_DECRYPTED",
  "FRAG_LOAD_EMERGENCY_ABORTED",
  "FRAG_LOADED",
  "FRAG_LOADING",
  "FRAG_PARSED",
  "FRAG_PARSING_INIT_SEGMENT",
  "FRAG_PARSING_METADATA",
  "FRAG_PARSING_USERDATA",
  "INIT_PTS_FOUND",
  "INTERSTITIAL_ASSET_ENDED",
  "INTERSTITIAL_ASSET_ERROR",
  "INTERSTITIAL_ASSET_PLAYER_CREATED",
  "INTERSTITIAL_ASSET_STARTED",
  "INTERSTITIAL_ENDED",
  "INTERSTITIAL_STARTED",
  "INTERSTITIALS_BUFFERED_TO_BOUNDARY",
  "INTERSTITIALS_PRIMARY_RESUMED",
  "INTERSTITIALS_UPDATED",
  "KEY_LOADED",
  "KEY_LOADING",
  "LEVEL_LOADED",
  "LEVEL_LOADING",
  "LEVEL_PTS_UPDATED",
  "LEVEL_SWITCHED",
  "LEVEL_SWITCHING",
  "LEVEL_UPDATED",
  "LEVELS_UPDATED",
  "LIVE_BACK_BUFFER_REACHED",
  "MANIFEST_LOADED",
  "MANIFEST_LOADING",
  "MANIFEST_PARSED",
  "MAX_AUTO_LEVEL_UPDATED",
  "MEDIA_ATTACHED",
  "MEDIA_ATTACHING",
  "MEDIA_DETACHED",
  "MEDIA_DETACHING",
  "MEDIA_ENDED",
  "NON_NATIVE_TEXT_TRACKS_FOUND",
  "PLAYOUT_LIMIT_REACHED",
  "STALL_RESOLVED",
  "STEERING_MANIFEST_LOADED",
  "SUBTITLE_FRAG_PROCESSED",
  "SUBTITLE_TRACK_LOADED",
  "SUBTITLE_TRACK_LOADING",
  "SUBTITLE_TRACK_SWITCH",
  "SUBTITLE_TRACK_UPDATED",
  "SUBTITLE_TRACKS_CLEARED",
  "SUBTITLE_TRACKS_UPDATED",
];

/**
 * Attaches listeners to all HLS.js events with smart logging
 * @param {Hls} hls - HLS.js instance
 * @param {string} [prefix='HLS'] - Custom prefix for logs
 */
function attachHlsEventLogger(hls, prefix = "HLS") {
  HLS_EVENTS.forEach((eventName) => {
    hls.on(eventName, (event, data) => {
      // Rich grouped log for important events
      console.groupCollapsed(
        `%c${timestamp} %c[${prefix}] %c${key}`,
        "color: #666; font-size: 10px;",
        "color: #3b82f6; font-weight: bold;",
        style,
      );

      console.log("Event:", event);
      if (data) {
        console.log("Data:", data);

        // Highlight useful fields
        if (data.level !== undefined) console.log("→ Level:", data.level);
        if (data.id !== undefined) console.log("→ ID:", data.id);
        if (data.frag?.url) console.log("→ Fragment URL:", data.frag.url);
        if (data.url) console.log("→ URL:", data.url);
        if (data.details) console.log("→ Details:", data.details);
        if (data.error) console.error("→ Error:", data.error);
        if (data.type) console.log("→ Type:", data.type);
        if (data.reason) console.log("→ Reason:", data.reason);
      }
      console.groupEnd();
    });
  });
}
