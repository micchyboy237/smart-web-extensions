// injector.js - Persistent Lead Buffer Engine (v2 - Netflix-style)

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

(() => {
  if (window.__FASTSTREAM_INITIALIZED__) return;
  window.__FASTSTREAM_INITIALIZED__ = true;

  let hlsInstance = null;
  let workerUrl = null;
  let masterPlaylistUrl = null;
  let playerCreated = false;

  let controllerInterval = null;

  const cleanupListeners = [];

  // 🆕 JPEG detection + boost state
  let lastJpegUrl = null;
  let lastJpegTime = 0;
  let jpegBoostUntil = 0;

  let perfObserver = null;

  // 🎯 Buffer model - More aggressive & consistent leading buffer
  const BUFFER_TARGET = 65; // Desired leading buffer while playing
  const BUFFER_MIN = 40; // Below this = increase pressure
  const BUFFER_MAX = 150; // Hard cap to prevent runaway memory use

  // 🎯 Pressure tuning
  const PRESSURE_GAIN = 25; // Slightly more aggressive expansion
  const JPEG_BOOST_DURATION = 4000;
  const JPEG_DEDUPE_WINDOW = 2000;

  function addListener(target, type, handler) {
    target.addEventListener(type, handler);
    cleanupListeners.push(() => target.removeEventListener(type, handler));
  }

  function getBufferAhead(video) {
    if (!video || !video.buffered.length) return 0;
    return video.buffered.end(0) - video.currentTime;
  }

  // 🧠 Core Controller (continuous, no toggling)
  function startController(video) {
    if (controllerInterval) return;
    controllerInterval = setInterval(() => {
      if (!hlsInstance || !video || video.paused) return; // Skip when paused to save resources
      const bufferAhead = getBufferAhead(video);
      controlBuffer(bufferAhead);
    }, 200); // More frequent updates for better responsiveness
  }

  function controlBuffer(bufferAhead) {
    const config = hlsInstance.config;

    // 🎯 Enhanced pressure calculation with smoother curve
    const deficit = Math.max(0, BUFFER_TARGET - bufferAhead);
    const pressure = Math.min(1, deficit / BUFFER_TARGET);
    const smoothPressure = pressure * pressure; // Quadratic for gentler low-end response

    // 🆕 Apply JPEG-triggered boost (no reset, just more pressure)
    const now = Date.now();
    const boostActive = now < jpegBoostUntil;
    const boostGain = boostActive ? PRESSURE_GAIN * 1.5 : PRESSURE_GAIN;

    // 🎯 Stronger buffer window expansion for consistent lead
    let dynamicBuffer = BUFFER_TARGET + smoothPressure * boostGain;
    if (bufferAhead < BUFFER_MIN * 0.6) dynamicBuffer = BUFFER_MAX; // Emergency max on very low buffer

    config.maxBufferLength = Math.min(dynamicBuffer, BUFFER_MAX);
    config.maxMaxBufferLength = BUFFER_MAX + 40; // More headroom

    // 🔥 AGGRESSIVE prefetch settings
    config.startFragPrefetch = true;
    config.testBandwidth = true;

    // 🚀 Boost fragment loading speed
    config.maxFragLookUpTolerance = 0.4; // Increased from 0.2
    config.fragLoadingTimeOut = 20000; // Longer timeout for larger downloads
    config.fragLoadingMaxRetry = 6; // More retry attempts
    config.fragLoadingMaxRetryTimeout = 8000;
    config.fragLoadingRetryDelay = 1000;
    config.maxStarvationDelay = 4; // Increased from 2
    config.maxLoadingDelay = 4;
    config.maxBufferHole = 0.3; // Tighter gap tolerance for faster recovery

    // 🧠 Enhanced ABR Coupling
    adaptBitrate(bufferAhead, smoothPressure, boostActive);
  }

  function adaptBitrate(bufferAhead, smoothPressure, boostActive) {
    if (!hlsInstance) return;

    const levels = hlsInstance.levels;
    if (!levels || levels.length === 0) return;

    // 🟢 Very healthy buffer → aggressive quality upgrade
    if (bufferAhead > BUFFER_TARGET * 1.5) {
      hlsInstance.autoLevelCapping = -1; // No cap, max quality
      // Force quality check more often
      if (hlsInstance.currentLevel < levels.length - 1) {
        hlsInstance.nextLevel = Math.min(
          levels.length - 1,
          hlsInstance.currentLevel + 1,
        );
      }
      return;
    }

    // 🟢 Healthy buffer → allow quality upgrades
    if (bufferAhead > BUFFER_MIN * 1.2) {
      hlsInstance.autoLevelCapping = -1;
      return;
    }

    // 🟡 Moderate buffer → stabilize at current quality
    if (bufferAhead > BUFFER_MIN) {
      hlsInstance.autoLevelCapping = hlsInstance.currentLevel;
      return;
    }

    // 🔴 Low buffer → aggressive quality reduction
    const safeLevel = Math.max(0, hlsInstance.currentLevel - 2);
    hlsInstance.autoLevelCapping = safeLevel;
    hlsInstance.nextLevel = safeLevel; // Force immediate downgrade

    // 🆕 Emergency: Very low buffer → minimum quality
    if (bufferAhead < BUFFER_MIN * 0.5) {
      hlsInstance.currentLevel = 0;
      hlsInstance.autoLevelCapping = 0;
    }
  }

  function loadVideoPlayer() {
    if (hlsInstance || !masterPlaylistUrl || !workerUrl) {
      console.warn(
        "[FastStream] Skipping loadVideoPlayer (already initialized or missing URLs)",
      );
      return;
    }
    playerCreated = true;

    const video = document.querySelector("video");
    if (!video) {
      console.error("[FastStream] No <video> element found on the page!");
      return;
    }

    console.log("[FastStream] Preparing to load video player...");
    video.pause();
    video.src = "";
    video.load();
    console.log("[FastStream] Video element paused and reset.");

    if (Hls.isSupported()) {
      console.log("[FastStream] Hls.js is supported by this browser.");
      console.log("[FastStream] Creating Hls instance with config:", {
        autoStartLoad: true,
        startPosition: -1,
        lowLatencyMode: false,
        maxBufferLength: BUFFER_TARGET + 10,
        maxMaxBufferLength: BUFFER_MAX + 40,
        backBufferLength: 30,
        maxBufferSize: 180 * 1024 * 1024,
        startFragPrefetch: true,
        maxBufferHole: 0.3,
        maxFragLookUpTolerance: 0.4,
        abrEwmaFastVoD: 3.0,
        abrEwmaSlowVoD: 9.0,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.9,
        maxStarvationDelay: 4,
        maxLoadingDelay: 4,
        capLevelToPlayerSize: true,
        progressive: true,
        enableWorker: false,
        workerPath: workerUrl,
        debug: false,
        highBufferWatchdogPeriod: 1,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 10,
      });
      hlsInstance = new Hls({
        autoStartLoad: true,
        startPosition: -1,
        lowLatencyMode: false, // Better for VOD-style large buffer
        // 🎯 Increased initial buffer config
        maxBufferLength: BUFFER_TARGET + 10, // Extra on startup
        maxMaxBufferLength: BUFFER_MAX + 40,
        backBufferLength: 30, // Increased from 20
        maxBufferSize: 180 * 1024 * 1024, // Increased headroom
        // 🔥 NEVER disable (persistent pipeline)
        startFragPrefetch: true,
        maxBufferHole: 0.3,
        maxFragLookUpTolerance: 0.4,
        // 📉 Stable ABR
        abrEwmaFastVoD: 3.0,
        abrEwmaSlowVoD: 9.0,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.9, // More aggressive up-switching (was 0.7)
        maxStarvationDelay: 4,
        maxLoadingDelay: 4,
        capLevelToPlayerSize: true,
        progressive: true, // Enable progressive loading
        enableWorker: false,
        workerPath: workerUrl,
        debug: false,
        // 🚀 Additional performance optimizations
        highBufferWatchdogPeriod: 1, // More frequent buffer checks
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 10,
      });

      console.log("[FastStream] Loading source:", masterPlaylistUrl);
      hlsInstance.loadSource(masterPlaylistUrl);

      console.log("[FastStream] Attaching media to video element.");
      hlsInstance.attachMedia(video);

      HLS_EVENTS.forEach((eventName) => {
        hls.on(eventName, (event, data) => {
          // Rich grouped log for important events
          console.groupCollapsed(
            `%c${timestamp} %c[HLS] %c${key}`,
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

      // 🔁 Enhanced seeking behavior
      addListener(video, "seeking", () => {
        console.log("[FastStream] [Listener] 'seeking' event triggered");
        if (!hlsInstance) return;
        // On seek: temporarily max buffer target to refill quickly from new position
        const config = hlsInstance.config;
        config.maxBufferLength = BUFFER_MAX;
        config.maxMaxBufferLength = BUFFER_MAX + 60;
        // Force prefetch from new seek position
        hlsInstance.startLoad(video.currentTime);
        console.log(
          "[FastStream] 🔄 Seeking → aggressive buffer refill triggered at",
          video.currentTime,
          "seconds",
        );
      });

      addListener(video, "waiting", () => {
        console.log("[FastStream] [Listener] 'waiting' event triggered");
        // Boost buffer when player is waiting
        if (hlsInstance) {
          const config = hlsInstance.config;
          const prev = config.maxBufferLength;
          config.maxBufferLength = Math.max(config.maxBufferLength, BUFFER_MAX);
          console.log(
            "[FastStream] ⏳ Player waiting - maxBufferLength bumped",
            { previous: prev, new: config.maxBufferLength },
          );
        }
      });

      addListener(video, "playing", () => {
        console.log("[FastStream] [Listener] 'playing' event triggered");
        // Reset to dynamic control when playing resumes
        if (hlsInstance) {
          const bufferAhead = getBufferAhead(video);
          console.log(
            "[FastStream] ▶️ Playing event fired. Buffer ahead:",
            bufferAhead,
          );
          controlBuffer(bufferAhead);
          console.log(
            `[FastStream] ▶️ Playing resumed - buffer: ${bufferAhead.toFixed(1)}s`,
          );
        }
      });
      console.log("[FastStream] Video player setup complete.");
    } else {
      console.error("[FastStream] Hls.js is NOT supported on this browser!");
    }
  }

  function hookNetworkRequests() {
    if (!window.__FASTSTREAM_FETCH_HOOKED__) {
      window.__FASTSTREAM_FETCH_HOOKED__ = true;

      const originalFetch = window.fetch;
      window.fetch = async function (input, init) {
        const url = typeof input === "string" ? input : input?.url || "";
        const res = await originalFetch(input, init);

        if (url.includes("playlist.m3u8")) {
          window.postMessage(
            { type: "FASTSTREAM_HLS_DETECTED", url, isMasterPlaylist: true },
            "*",
          );
        }

        // 🆕 JPEG detection (deduped, zero spam)
        if (/video\d+\.(jpe?g)/i.test(url)) {
          const now = Date.now();

          if (url !== lastJpegUrl || now - lastJpegTime > JPEG_DEDUPE_WINDOW) {
            lastJpegUrl = url;
            lastJpegTime = now;

            console.log("[FastStream] 📸 JPEG fragment detected →", url);

            // 🆕 Activate temporary pressure boost
            jpegBoostUntil = now + JPEG_BOOST_DURATION;
          }
        }

        return res;
      };
    }
  }

  function startJpegObserver() {
    if (perfObserver) return;

    try {
      perfObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();

        for (const entry of entries) {
          const url = entry.name;

          if (!/video\d+\.(jpe?g)/i.test(url)) continue;

          const now = Date.now();

          if (url === lastJpegUrl && now - lastJpegTime < JPEG_DEDUPE_WINDOW) {
            continue;
          }

          lastJpegUrl = url;
          lastJpegTime = now;

          console.log("[FastStream] 📸 JPEG fragment detected (perf) →", url);

          jpegBoostUntil = now + JPEG_BOOST_DURATION;
        }
      });

      perfObserver.observe({
        type: "resource",
        buffered: true,
      });

      console.log("[FastStream] 👁️ PerformanceObserver active");
    } catch (e) {
      console.warn("[FastStream] PerformanceObserver failed:", e);
    }
  }

  function handleStartPlayer(event) {
    if (event.data?.contentScriptName === "automation") {
      if (playerCreated) return;
      masterPlaylistUrl = event.data.url;
      loadVideoPlayer();
    }
  }

  function handleConfigMessage(event) {
    if (event.data?.contentScriptName === "automation") {
      workerUrl = event.data.workerUrl;
    }
  }

  function handleWindowMessage(event) {
    console.log("[FastStream] window message event data:", event.data);

    if (event.data?.contentScriptName === "automation") {
      if (playerCreated) {
        console.log(
          "[FastStream] Player already created, skipping loadVideoPlayer.",
        );
        return;
      }
      masterPlaylistUrl = event.data.url;
      console.log(
        "[FastStream] Setting masterPlaylistUrl to:",
        masterPlaylistUrl,
      );
      loadVideoPlayer();
      console.log("[FastStream] Called loadVideoPlayer()");
    } else if (event.data?.type === "FASTSTREAM_CONFIG") {
      workerUrl = event.data.workerUrl;
      console.log("[FastStream] Setting workerUrl to:", workerUrl);
    } else {
      console.log("[FastStream] Ignored window message data:", event.data);
    }
  }

  function cleanup() {
    cleanupListeners.forEach((fn) => fn());
    cleanupListeners.length = 0;

    if (controllerInterval) {
      clearInterval(controllerInterval);
      controllerInterval = null;
    }

    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    if (perfObserver) {
      perfObserver.disconnect();
      perfObserver = null;
    }

    // 🆕 reset jpeg state
    lastJpegUrl = null;
    lastJpegTime = 0;
    jpegBoostUntil = 0;

    playerCreated = false;
  }

  //   addListener(window, "message", handleConfigMessage);
  //   addListener(window, "message", handleStartPlayer);
  addListener(window, "message", handleWindowMessage);
  addListener(window, "beforeunload", cleanup);

  hookNetworkRequests();
  startJpegObserver();
})();
