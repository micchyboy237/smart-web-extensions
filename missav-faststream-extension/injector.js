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

  // 🎯 Buffer model
  const BUFFER_TARGET = 35;
  const BUFFER_MIN = 25;
  const BUFFER_MAX = 55;

  // 🎯 Pressure tuning
  const PRESSURE_GAIN = 20; // how aggressively we expand buffer window
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
      if (!hlsInstance || !video) return;

      const bufferAhead = getBufferAhead(video);
      controlBuffer(bufferAhead);
    }, 400);
  }

  function controlBuffer(bufferAhead) {
    const config = hlsInstance.config;

    // 🎯 Normalize pressure (0 → 1)
    const pressure = Math.max(
      0,
      Math.min(1, (BUFFER_TARGET - bufferAhead) / BUFFER_TARGET),
    );

    // 🆕 Apply JPEG-triggered boost (no reset, just more pressure)
    const now = Date.now();
    const boostActive = now < jpegBoostUntil;

    const boostGain = boostActive ? PRESSURE_GAIN * 1.5 : PRESSURE_GAIN;

    // 🎯 Smooth buffer window expansion (with boost)
    const dynamicBuffer = BUFFER_TARGET + pressure * boostGain;

    config.maxBufferLength = Math.min(dynamicBuffer, BUFFER_MAX);
    config.maxMaxBufferLength = BUFFER_MAX + 15;

    // 🔥 ALWAYS keep forward loading active
    config.startFragPrefetch = true;

    // 🧠 ABR Coupling (boost-aware)
    adaptBitrate(bufferAhead, pressure, boostActive);
  }

  function adaptBitrate(bufferAhead, pressure, boostActive) {
    if (!hlsInstance) return;

    // 🔴 Low buffer → reduce quality aggressively
    if (bufferAhead < BUFFER_MIN) {
      const safeLevel = Math.max(0, hlsInstance.currentLevel - 1);
      hlsInstance.autoLevelCapping = safeLevel;
      return;
    }

    // 🟡 Medium pressure → stabilize
    if (pressure > 0.3) {
      hlsInstance.autoLevelCapping = hlsInstance.currentLevel;
      return;
    }

    // 🆕 During boost → slightly conservative ABR
    if (boostActive) {
      hlsInstance.autoLevelCapping = hlsInstance.currentLevel;
      return;
    }

    // 🟢 Healthy buffer → allow full ABR
    hlsInstance.autoLevelCapping = -1;
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

        // 🎯 Initial buffer config (controller will take over)
        maxBufferLength: BUFFER_TARGET,
        maxMaxBufferLength: BUFFER_MAX + 15,
        backBufferLength: 20,
        maxBufferSize: 70 * 1024 * 1024,

        // 🔥 NEVER disable (persistent pipeline)
        startFragPrefetch: true,

        maxBufferHole: 0.3,
        maxFragLookUpTolerance: 0.2,

        // 📉 Stable ABR
        abrEwmaFastVoD: 3.0,
        abrEwmaSlowVoD: 9.0,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.7,

        maxStarvationDelay: 2,
        maxLoadingDelay: 2,

        capLevelToPlayerSize: true,
        enableWorker: false,
        workerPath: workerUrl,

        debug: false,
      });

      hlsInstance.loadSource(masterPlaylistUrl);
      hlsInstance.attachMedia(video);

      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        startController(video);
        video.play().catch(() => {});
      });

      // 🔁 Seek = no reset (controller adapts)
      addListener(video, "seeking", () => {});
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
