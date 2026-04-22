// injector.js - Persistent Lead Buffer Engine (v2 - Netflix-style)

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

  function createFastPlayer() {
    if (hlsInstance || !masterPlaylistUrl || !workerUrl) return;
    playerCreated = true;

    const video = document.querySelector("video");
    if (!video) return;

    video.pause();
    video.src = "";
    video.load();

    if (Hls.isSupported()) {
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

      hlsInstance.loadSource(masterPlaylistUrl);
      hlsInstance.attachMedia(video);

      // 🔁 Enhanced seeking behavior
      addListener(video, "seeking", () => {
        if (!hlsInstance) return;
        // On seek: temporarily max buffer target to refill quickly from new position
        const config = hlsInstance.config;
        config.maxBufferLength = BUFFER_MAX;
        config.maxMaxBufferLength = BUFFER_MAX + 60;
        // Force prefetch from new seek position
        hlsInstance.startLoad(video.currentTime);
        console.log(
          "[MISSAV INJECTOR] 🔄 Seeking → aggressive buffer refill triggered",
        );
      });

      addListener(video, "waiting", () => {
        // Boost buffer when player is waiting
        if (hlsInstance) {
          const config = hlsInstance.config;
          config.maxBufferLength = Math.max(config.maxBufferLength, BUFFER_MAX);
        }
      });

      addListener(video, "playing", () => {
        // Reset to dynamic control when playing resumes
        if (hlsInstance) {
          const bufferAhead = getBufferAhead(video);
          controlBuffer(bufferAhead);
          console.log(
            `[MISSAV INJECTOR] ▶️ Playing resumed - buffer: ${bufferAhead.toFixed(1)}s`,
          );
        }
      });
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

            console.log("[MISSAV INJECTOR] 📸 JPEG fragment detected →", url);

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

          console.log(
            "[MISSAV INJECTOR] 📸 JPEG fragment detected (perf) →",
            url,
          );

          jpegBoostUntil = now + JPEG_BOOST_DURATION;
        }
      });

      perfObserver.observe({
        type: "resource",
        buffered: true,
      });

      console.log("[MISSAV INJECTOR] 👁️ PerformanceObserver active");
    } catch (e) {
      console.warn("[MISSAV INJECTOR] PerformanceObserver failed:", e);
    }
  }

  function handleStartPlayer(event) {
    if (event.data?.type === "FASTSTREAM_START_PLAYER") {
      if (playerCreated) return;
      masterPlaylistUrl = event.data.url;
      createFastPlayer();
    }
  }

  function handleConfigMessage(event) {
    if (event.data?.type === "FASTSTREAM_CONFIG") {
      workerUrl = event.data.workerUrl;
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

  addListener(window, "message", handleConfigMessage);
  addListener(window, "message", handleStartPlayer);
  addListener(window, "beforeunload", cleanup);

  hookNetworkRequests();
  startJpegObserver();
})();
