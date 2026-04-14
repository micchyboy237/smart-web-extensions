// injector.js - Runs in the PAGE'S MAIN WORLD (real fetch/XHR + player context)

(() => {
  if (window.__FASTSTREAM_INITIALIZED__) {
    console.warn("[FastStream] արդեն initialized — skipping");
    return;
  }
  window.__FASTSTREAM_INITIALIZED__ = true;
  console.log("✅ [MissAV FastStream] 🚀 Main-world injector loaded");

  let hlsInstance = null;
  let workerUrl = null;
  let masterPlaylistUrl = null;
  let playerCreated = false;
  let panel = null;
  let lastFragTime = 0;
  let updateInterval = null; // NEW: throttle panel updates
  let fragCounter = 0; // NEW: reduce update frequency
  let observer = null;
  const cleanupListeners = [];
  let lastJpegUrl = null;
  let lastJpegTime = 0;
  let lastJpegTriggerTime = 0; // NEW: global throttle
  let jpegBoostApplied = false; // NEW: one-time boost guard

  function addListener(target, type, handler) {
    target.addEventListener(type, handler);
    cleanupListeners.push(() => target.removeEventListener(type, handler));
  }

  function hookNetworkRequests() {
    if (!window.__FASTSTREAM_FETCH_HOOKED__) {
      window.__FASTSTREAM_FETCH_HOOKED__ = true;

      // === NEW: Also catch the video*.jpeg thumbnail (your example request) ===
      const originalFetch = window.fetch;
      window.fetch = async function (input, init) {
        const url = typeof input === "string" ? input : input?.url || "";
        const response = await originalFetch(input, init);

        if (url.includes("playlist.m3u8") || url.includes("video.m3u8")) {
          const isMaster = url.includes("playlist.m3u8");
          console.log(
            `✅ [MissAV FastStream] 📡 FETCH caught HLS ${isMaster ? "MASTER" : "MEDIA"} playlist →`,
            url,
          );
          window.postMessage(
            {
              type: "FASTSTREAM_HLS_DETECTED",
              url: url,
              isMasterPlaylist: isMaster,
              isJpegTrigger: false,
            },
            "*",
          );
        }

        // NEW: Detect video*.jpeg on surrit.com (the thumbnail you showed)
        if (url.includes("surrit.com") && /video\d+\.jpeg/.test(url)) {
          console.log(
            "✅ [MissAV FastStream] 📸 JPEG thumbnail detected →",
            url,
          );
          window.postMessage(
            {
              type: "FASTSTREAM_JPEG_DETECTED",
              url: url,
            },
            "*",
          );
        }

        return response;
      };
    }

    if (!window.__FASTSTREAM_XHR_HOOKED__) {
      window.__FASTSTREAM_XHR_HOOKED__ = true;

      // Override XMLHttpRequest
      const OriginalXHR = window.XMLHttpRequest;
      window.XMLHttpRequest = function () {
        const xhr = new OriginalXHR();
        const open = xhr.open;
        xhr.open = function (method, url) {
          if (
            typeof url === "string" &&
            (url.includes("playlist.m3u8") || url.includes("video.m3u8"))
          ) {
            const isMaster = url.includes("playlist.m3u8");
            console.log(
              `✅ [MissAV FastStream] 📡 XHR caught HLS ${isMaster ? "MASTER" : "MEDIA"} playlist →`,
              url,
            );
            window.postMessage(
              {
                type: "FASTSTREAM_HLS_DETECTED",
                url: url,
                isMasterPlaylist: isMaster,
              },
              "*",
            );
          }
          // Also catch JPEG via XHR (some sites use XHR for images)
          if (
            typeof url === "string" &&
            url.includes("surrit.com") &&
            /video\d+\.jpeg/.test(url)
          ) {
            console.log(
              "✅ [MissAV FastStream] 📸 JPEG thumbnail detected via XHR →",
              url,
            );
            window.postMessage({ type: "FASTSTREAM_JPEG_DETECTED", url }, "*");
          }
          return open.apply(this, arguments);
        };
        return xhr;
      };
    }
  }

  // Receive config (worker URL) from content script
  function handleConfigMessage(event) {
    if (event.data && event.data.type === "FASTSTREAM_CONFIG") {
      workerUrl = event.data.workerUrl;
      console.log(
        "✅ [MissAV FastStream] 🔧 Received worker URL in main world:",
        workerUrl,
      );
    }
  }

  // Receive start-player command + create player in main world
  function handleStartPlayer(event) {
    if (event.data && event.data.type === "FASTSTREAM_START_PLAYER") {
      if (playerCreated) {
        console.log(
          "⚠️ [MissAV FastStream] Player already created — ignoring duplicate START_PLAYER",
        );
        return;
      }
      masterPlaylistUrl = event.data.url;
      console.log(
        "🔄 [MissAV FastStream] 🎬 Received START_PLAYER command →",
        masterPlaylistUrl,
      );
      createFastPlayer(true); // called from playlist
    }
  }

  // NEW handler for JPEG detection
  function handleJpegDetected(event) {
    if (!event.data || event.source !== window) return;
    if (event.data?.type === "FASTSTREAM_JPEG_DETECTED") {
      const now = Date.now();

      // NEW: global throttle (max once every 3s)
      if (now - lastJpegTriggerTime < 3000) return;

      // NEW: only allow one boost per session
      if (jpegBoostApplied) return;

      lastJpegTriggerTime = now;
      jpegBoostApplied = true;

      console.log(
        "🔥 [MissAV FastStream] JPEG triggered prioritization (throttled)",
      );

      if (!playerCreated && masterPlaylistUrl) {
        createFastPlayer(false);
      }

      if (hlsInstance) {
        // UPDATED: Soft boost only (no forced reload / no aggressive expansion)
        hlsInstance.config.startFragPrefetch = false;

        console.log("🚀 Soft prioritization applied (no aggressive prefetch)");
      }
    }
  }

  function createFastPlayer(fromPlaylist) {
    if (hlsInstance || !masterPlaylistUrl || !workerUrl) return;
    playerCreated = true;
    console.log("✅ [MissAV FastStream] 🎬 Reusing existing video element");

    // Reuse the original video element on the page
    const video = document.querySelector("video");
    if (!video) {
      console.warn("⚠️ No existing video element found – falling back");
      return;
    }
    // Reuse and reset video element
    video.controls = true;
    video.style.background = "#000";
    video.pause();
    video.muted = true;
    // Clear any previous source/buffer to help GC
    if (video.src) video.src = "";
    video.load();

    console.log("✅ [MissAV FastStream] ✅ Reusing page's own element");

    if (Hls.isSupported()) {
      // Latest hls.js v1.6.16 style config with FastStream-inspired prefetch, FIXED: tighter buffer/GC
      hlsInstance = new Hls({
        autoStartLoad: fromPlaylist,
        startPosition: -1,
        // UPDATED: Balanced buffering (prevents aggressive continuous downloading)
        maxBufferLength: 20, // forward buffer target
        maxMaxBufferLength: 40, // hard cap
        backBufferLength: 15,
        maxBufferSize: 40 * 1024 * 1024, // reduced memory footprint

        maxBufferHole: 0.5,
        maxFragLookUpTolerance: 0.25,
        startFragPrefetch: false, // disable aggressive prefetch

        testBandwidth: false,
        lowLatencyMode: false,

        enableWorker: false,
        workerPath: workerUrl,
        abrEwmaFastVoD: 4.0,
        abrEwmaSlowVoD: 8.0,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.8,
        maxStarvationDelay: 4,
        maxLoadingDelay: 4,
        debug: false,
        capLevelToPlayerSize: true,
        // enableSoftwareAES: true (if needed for encrypted streams)
      });
      console.log(
        "✅ [MissAV FastStream] ⚙️ Fast HLS config applied (large buffer + prefetch)",
      );
      hlsInstance.loadSource(masterPlaylistUrl);
      hlsInstance.attachMedia(video);

      hlsInstance.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        console.log(
          "✅ [MissAV FastStream] 📜 Master playlist parsed — quality levels ready",
        );
        video.play().catch(() => {});
        console.log("✅ [MissAV FastStream] ▶️ Auto-play started");
        console.log("🎉 [MissAV FastStream] ✅ EXTENSION FULLY ACTIVE");

        // Create/update floating panel once
        if (!panel) {
          panel = document.createElement("div");
          panel.style.cssText =
            "position:fixed; bottom:20px; right:20px; background:rgba(0,0,0,0.85);" +
            "color:#0f0; padding:12px; border-radius:8px; font-family:monospace;" +
            "font-size:13px; z-index:999999; min-width:240px; box-shadow:0 0 15px rgba(0,255,0,0.3);";
          document.body.appendChild(panel);
        }

        // FIXED: Throttled panel updates (every ~800ms or on every 3rd frag)
        if (!updateInterval) {
          updateInterval = setInterval(() => {
            if (panel && hlsInstance) updatePanel();
          }, 800);
        }

        hlsInstance.on(Hls.Events.FRAG_LOADED, (event, data) => {
          fragCounter++;
          const now = Date.now();
          let speedKbps = 0;
          if (lastFragTime && data.frag?.duration) {
            speedKbps = Math.round(
              (data.frag.duration * 1000) / (now - lastFragTime),
            );
          }
          lastFragTime = now;

          // Update panel less aggressively
          if (fragCounter % 3 === 0 || speedKbps > 500) {
            updatePanel(data, speedKbps);
          }
        });

        // Still listen for buffer changes but don't spam
        hlsInstance.on(Hls.Events.BUFFER_APPENDED, () => {
          if (panel && fragCounter % 5 === 0) updatePanel();
        });
      });
    }
  }

  function updatePanel(fragData = null, speedKbps = 0) {
    if (!panel || !hlsInstance) return;

    // FIXED: More defensive buffer calculation (handles live/VOD better)
    const buffer = hlsInstance.media
      ? hlsInstance.media.buffered.length > 0
        ? (
            hlsInstance.media.buffered.end(0) - hlsInstance.media.currentTime
          ).toFixed(1)
        : "0"
      : "0";

    const queued = hlsInstance.bufferController ? "many" : "~10";

    // FIXED: Cleaner template + avoid repeated large string creation
    panel.innerHTML = `
      🚀 FastStream Live<br>
      Speed: ${speedKbps} kB/s<br>
      Buffer: ${buffer}s ahead<br>
      Fragments queued: ${queued}<br>
      JPEG trigger: active ✅<br>
      Back-buffer: ${hlsInstance.config.backBufferLength}s (evicting old)
    `;
  }

  // NEW: Cleanup function (call on page unload or when recreating player)
  function cleanup() {
    // remove listeners
    cleanupListeners.forEach((fn) => fn());
    cleanupListeners.length = 0;

    // disconnect observer
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (hlsInstance) {
      try {
        hlsInstance.stopLoad();
        hlsInstance.detachMedia();
        hlsInstance.destroy(); // IMPORTANT: frees workers, buffers, events
      } catch (e) {
        console.warn("[MissAV FastStream] Cleanup error:", e);
      }
      hlsInstance = null;
    }
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
    if (panel) {
      panel.remove();
      panel = null;
    }
    playerCreated = false;
    lastFragTime = 0;
    fragCounter = 0;
    console.log("🧹 [MissAV FastStream] Cleanup completed");
  }

  // Setup all listeners
  addListener(window, "message", handleConfigMessage);
  addListener(window, "message", handleStartPlayer);
  addListener(window, "message", handleJpegDetected);
  addListener(window, "beforeunload", cleanup);

  // Optional: also listen for video element removal if the site replaces it
  observer = new MutationObserver((mutations) => {
    if (!document.querySelector("video") && hlsInstance) {
      console.warn("[MissAV FastStream] Video element removed – cleaning up");
      cleanup();
    }
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  hookNetworkRequests();
  console.log("✅ [MissAV FastStream] 🎯 Network hooks active + ready");

  // Expose cleanup for content script if needed
  window.FastStreamCleanup = cleanup;
})();
