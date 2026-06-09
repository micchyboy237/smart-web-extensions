// content.js - Core Video Observer orchestrator
// Coordinates all modules: Boost, Cache, Buffer, Preview, Cards, Panel, Overlay, Visibility
(function () {
  "use strict";
  console.log("[Content] Core module loading...");

  // ═══════════════════════════════════════════════════════════
  // CORE CONSTANTS
  // ═══════════════════════════════════════════════════════════
  const VIDEO_SELECTOR = "video";
  const OBSERVER_PANEL_ID = "video-observer-panel";
  const OVERLAY_ID = "vo-overlay";
  const MAX_GALLERY_ITEMS = 6;

  // ═══════════════════════════════════════════════════════════
  // HLS MANIFEST DETECTION (Multi-strategy)
  // ═══════════════════════════════════════════════════════════
  /**
   * Store detected HLS manifest URLs mapped to their video elements.
   * Uses multiple strategies since .m3u8 calls may happen before our extension loads.
   */
  const hlsManifestMap = new Map(); // video element → manifest URL
  const hlsManifestByPage = new Map(); // URL path → manifest URL (fallback)

  /**
   * Strategy 1: Scan Performance API for already-completed .m3u8 requests.
   * This catches .m3u8 calls that happened BEFORE our extension loaded.
   */
  function scanPerformanceAPIForM3U8() {
    console.log(
      "[Content] 🔍 Strategy 1: Scanning Performance API for .m3u8 requests...",
    );

    const entries = performance.getEntriesByType("resource");
    let found = 0;

    for (const entry of entries) {
      const url = entry.name || "";
      if (url.includes(".m3u8") || url.includes("m3u8")) {
        console.log(
          `[Content] 📡 Found .m3u8 in Performance API: ${url.substring(0, 100)}...`,
        );
        try {
          const urlObj = new URL(url, window.location.href);
          hlsManifestByPage.set(urlObj.pathname, url);
          found++;
        } catch (e) {}
      }
    }

    console.log(`[Content] 📊 Performance API scan: ${found} .m3u8 URLs found`);
    return found > 0;
  }

  /**
   * Strategy 2: Probe HLS.js internal state on the video element.
   * HLS.js stores its instance and config, which contains the manifest URL.
   */
  function probeHLSjsInternals(video) {
    try {
      // Check for HLS.js instance on the video element
      if (video._hls) {
        const hls = video._hls;
        console.log(`[Content] 🔍 Found HLS.js instance on video element`);

        // hls.url contains the source URL passed to loadSource()
        if (
          hls.url &&
          (hls.url.includes(".m3u8") || hls.url.includes("m3u8"))
        ) {
          console.log(
            `[Content] 📡 HLS.js url: ${hls.url.substring(0, 100)}...`,
          );
          return hls.url;
        }

        // hls.levels[0]?.url may contain variant playlist URL
        if (hls.levels && hls.levels.length > 0 && hls.levels[0].url) {
          console.log(
            `[Content] 📡 HLS.js levels[0].url: ${hls.levels[0].url.substring(0, 100)}...`,
          );
          return hls.levels[0].url;
        }
      }

      // Check for Plyr's HLS instance
      const plyrContainer = video.closest(".plyr");
      if (plyrContainer && plyrContainer._hls) {
        const hls = plyrContainer._hls;
        if (
          hls.url &&
          (hls.url.includes(".m3u8") || hls.url.includes("m3u8"))
        ) {
          console.log(
            `[Content] 📡 Plyr HLS.js url: ${hls.url.substring(0, 100)}...`,
          );
          return hls.url;
        }
      }

      // Check window for global HLS instances
      if (window.hls) {
        const hls = window.hls;
        if (
          hls.url &&
          (hls.url.includes(".m3u8") || hls.url.includes("m3u8"))
        ) {
          console.log(
            `[Content] 📡 Global HLS.js url: ${hls.url.substring(0, 100)}...`,
          );
          return hls.url;
        }
      }
    } catch (e) {
      console.warn(`[Content] ⚠️ Error probing HLS.js internals:`, e.message);
    }

    return null;
  }

  /**
   * Strategy 3: Scan all script text content for .m3u8 URLs.
   * Sites often inline the manifest URL in their page scripts.
   */
  function scanScriptsForM3U8() {
    console.log("[Content] 🔍 Strategy 3: Scanning scripts for .m3u8 URLs...");

    const scripts = document.querySelectorAll("script:not([src])");
    const m3u8Regex = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi;
    let found = 0;

    for (const script of scripts) {
      const text = script.textContent || "";
      const matches = text.match(m3u8Regex);
      if (matches) {
        for (const url of matches) {
          console.log(
            `[Content] 📡 Found .m3u8 in script: ${url.substring(0, 100)}...`,
          );
          try {
            const urlObj = new URL(url, window.location.href);
            hlsManifestByPage.set(urlObj.pathname, url);
            found++;
          } catch (e) {}
        }
      }
    }

    console.log(`[Content] 📊 Script scan: ${found} .m3u8 URLs found`);
    return found > 0;
  }

  /**
   * Strategy 4: Network interception for FUTURE .m3u8 requests.
   * Intercepts fetch and XHR to capture .m3u8 calls that happen after we load.
   */
  function initHLSNetworkInterceptor() {
    console.log(
      "[Content] 🎬 Strategy 4: Initializing HLS network interceptor...",
    );

    // ── Intercept fetch() calls ──
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

      if (url && (url.includes(".m3u8") || url.includes("m3u8"))) {
        console.log(
          `[Content] 📡 HLS fetch captured: ${url.substring(0, 100)}...`,
        );
        captureM3U8Url(url);
      }

      return originalFetch.apply(this, args);
    };

    // ── Intercept XMLHttpRequest calls ──
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__hlsUrl = url;
      return originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      if (
        this.__hlsUrl &&
        (this.__hlsUrl.includes(".m3u8") || this.__hlsUrl.includes("m3u8"))
      ) {
        console.log(
          `[Content] 📡 HLS XHR captured: ${this.__hlsUrl.substring(0, 100)}...`,
        );
        captureM3U8Url(this.__hlsUrl);

        // Also listen for load to catch redirects
        this.addEventListener("load", () => {
          const responseURL = this.responseURL;
          if (
            responseURL &&
            (responseURL.includes(".m3u8") || responseURL.includes("m3u8"))
          ) {
            captureM3U8Url(responseURL);
          }
        });
      }

      return originalXHRSend.apply(this, args);
    };

    console.log("[Content] ✅ HLS network interceptor active");
  }

  /**
   * Capture and store an .m3u8 URL, then resolve any pending previews.
   */
  function captureM3U8Url(url) {
    try {
      const urlObj = new URL(url, window.location.href);
      hlsManifestByPage.set(urlObj.pathname, url);
    } catch (e) {}

    // Associate with any blob-source videos that don't have a manifest yet
    for (const [videoEl, entry] of videos.entries()) {
      const videoSrc = videoEl.currentSrc || videoEl.src || "";
      if (videoSrc.startsWith("blob:") && !hlsManifestMap.has(videoEl)) {
        hlsManifestMap.set(videoEl, url);
        console.log(
          `[Content] 🔗 Associated HLS manifest with video ${entry.id}`,
        );
        resolvePendingPreviewSource(entry);
        break;
      }
    }
  }

  /**
   * Resolve a pending preview source when HLS manifest becomes available.
   */
  function resolvePendingPreviewSource(entry) {
    if (!entry._needsSourceResolution || !entry.preview) return false;

    const manifestUrl = hlsManifestMap.get(entry.element);
    if (!manifestUrl) return false;

    console.log(
      `[Content] 🔄 RESOLVING preview source for ${entry.id}: ${manifestUrl.substring(0, 80)}...`,
    );
    entry._needsSourceResolution = false;
    entry._hlsManifestUrl = manifestUrl;

    // Update the preview video source
    entry.preview.src = manifestUrl;
    entry.preview.dataset.cacheKeySrc = manifestUrl;
    entry.preview.dataset.previewSrc = "hls-manifest";
    entry.preview.dataset.hlsSource = "true";
    entry.preview.dataset.previewReady = "false";
    entry.preview.dataset.sourcePending = "false";

    // Update cache key in the entry
    entry.cacheKeySrc = manifestUrl;

    console.log(`[Content] ✅ Preview source resolved for ${entry.id}`);
    return true;
  }

  /**
   * MAIN: Try ALL strategies to find the HLS manifest for a video.
   * Returns the manifest URL or null.
   */
  function findHLSManifestForVideo(video, entry) {
    // Strategy 2: Probe HLS.js internals (most reliable)
    const hlsUrl = probeHLSjsInternals(video);
    if (hlsUrl) {
      hlsManifestMap.set(video, hlsUrl);
      try {
        const urlObj = new URL(hlsUrl, window.location.href);
        hlsManifestByPage.set(urlObj.pathname, hlsUrl);
      } catch (e) {}
      console.log(
        `[Content] ✅ HLS manifest found via HLS.js probe for ${entry.id}`,
      );
      return hlsUrl;
    }

    // Strategy 1 & 3: Check if we already captured something
    if (hlsManifestByPage.size > 0) {
      const fallbackUrl = hlsManifestByPage.values().next().value;
      hlsManifestMap.set(video, fallbackUrl);
      console.log(
        `[Content] ✅ HLS manifest found via page cache for ${entry.id}`,
      );
      return fallbackUrl;
    }

    // Nothing found yet
    console.log(
      `[Content] ⏳ No HLS manifest found yet for ${entry.id} - will retry`,
    );
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // HLS MANIFEST DETECTION via chrome.webRequest Service Worker
  // ═══════════════════════════════════════════════════════════
  /**
   * Query the background service worker for captured HLS/DASH manifests.
   * This is the MOST RELIABLE method because the SW runs before page JS.
   */
  async function queryBackgroundForManifests() {
    console.log(
      "[Content] 🔍 Querying background SW for streaming manifests...",
    );

    try {
      const response = await chrome.runtime.sendMessage({
        action: "getManifests",
      });

      if (response && response.success && response.manifests.length > 0) {
        console.log(
          `[Content] 📡 Background SW returned ${response.manifests.length} manifests:`,
        );

        for (const url of response.manifests) {
          console.log(`[Content]    📄 ${url.substring(0, 100)}...`);
          try {
            const urlObj = new URL(url, window.location.href);
            hlsManifestByPage.set(urlObj.pathname, url);
          } catch (e) {}
        }

        stats.hlsResolvedViaBackground = response.manifests.length;
        return true;
      } else {
        console.log(
          "[Content] 📡 No manifests available from background SW yet",
        );
        return false;
      }
    } catch (err) {
      console.warn("[Content] ⚠️ Failed to query background SW:", err.message);
      return false;
    }
  }

  /**
   * Query background SW for the latest manifest matching a pattern.
   * Useful for getting the specific variant playlist for a video.
   */
  async function queryBackgroundForLatestManifest(pattern) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "getLatestManifest",
        pattern: pattern || "",
      });

      if (response && response.success && response.manifest) {
        console.log(
          `[Content] 📡 Latest manifest from SW: ${response.manifest.substring(0, 100)}...`,
        );
        return response.manifest;
      }
      return null;
    } catch (err) {
      console.warn(
        "[Content] ⚠️ Failed to query background SW for latest manifest:",
        err.message,
      );
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // VIDEO DETECTION UTILITIES
  // ═══════════════════════════════════════════════════════════

  function isVideoInOurUI(video) {
    const panel = document.getElementById(OBSERVER_PANEL_ID);
    if (panel && panel.contains(video)) return true;
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.contains(video)) return true;
    if (video.closest("#vo-previews-wrap")) return true;
    if (video.closest(".vo-preview-thumb-wrapper")) return true;
    if (video.classList.contains("vo-preview-thumb-video")) return true;
    return false;
  }

  function getRealVideoSource(video) {
    const src = video.currentSrc || video.src || "";
    if (src.startsWith("blob:")) {
      const manifestUrl = hlsManifestMap.get(video);
      if (manifestUrl) return manifestUrl;
      if (hlsManifestByPage.size > 0)
        return hlsManifestByPage.values().next().value;
    }
    return src;
  }

  function isHLSVideo(video) {
    const realSrc = getRealVideoSource(video);
    return realSrc.includes(".m3u8") || realSrc.includes("m3u8");
  }

  function isDASHVideo(video) {
    const realSrc = getRealVideoSource(video);
    return realSrc.includes(".mpd") || realSrc.includes("mpd");
  }

  function getStreamingProtocol(video) {
    if (isHLSVideo(video)) return "hls";
    if (isDASHVideo(video)) return "dash";
    return "standard";
  }

  function hasValidSource(video) {
    const src = video.currentSrc || video.src || "";
    if (!src || src === window.location.href) return false;
    if (src.startsWith("data:")) return false;
    if (src.startsWith("blob:")) return true;
    const standardFormats = [".mp4", ".webm", ".ogg", ".ogv", ".mov"];
    if (standardFormats.some((fmt) => src.toLowerCase().includes(fmt)))
      return true;
    if (
      src.includes(".m3u8") ||
      src.includes("m3u8") ||
      src.includes(".mpd") ||
      src.includes("mpd")
    )
      return true;
    const sourceElements = video.querySelectorAll("source");
    for (const source of sourceElements) {
      const sourceSrc = (source.src || "").toLowerCase();
      if (sourceSrc && !sourceSrc.startsWith("data:")) return true;
      const type = (source.type || "").toLowerCase();
      if (
        type.includes("mp4") ||
        type.includes("webm") ||
        type.includes("ogg") ||
        type.includes("m3u8") ||
        type.includes("mpd") ||
        type.includes("dash")
      ) {
        return true;
      }
    }
    return !!(video.mediaKeys || video.srcObject);
  }

  function isTrackableVideo(video) {
    if (!document.body.contains(video)) return false;
    if (isVideoInOurUI(video)) return false;
    const rect = video.getBoundingClientRect();
    if (rect.width < 16 || rect.height < 16) return false;
    if (video.offsetParent === null && video.style.display !== "contents") {
      const style = window.getComputedStyle(video);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
    }
    if (!hasValidSource(video)) return false;
    const duration = video.duration;
    if (
      duration &&
      !isNaN(duration) &&
      duration < 0.5 &&
      !isHLSVideo(video) &&
      !isDASHVideo(video)
    )
      return false;
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // GLOBAL STATE
  // ═══════════════════════════════════════════════════════════
  let videos = new Map();
  let videoCards = new Map();
  let currentlyPlaying = null;
  let videoCounter = 0;
  let domObserver = null;
  let pollingInterval = null;
  let chatRoot = null;
  let globalResources = { observers: [], intervals: [] };
  let observeInProgress = false;
  let panelUpdatePending = false;
  let panelUpdateTimer = null;
  const PANEL_UPDATE_DEBOUNCE = 100;

  let stats = {
    totalDetected: 0,
    hlsVideos: 0,
    dashVideos: 0,
    standardVideos: 0,
    skippedPanelVideos: 0,
    skippedInvalidVideos: 0,
    hlsResolvedViaHLSjs: 0,
    hlsResolvedViaPerfAPI: 0,
    hlsResolvedViaScripts: 0,
    hlsResolvedViaNetwork: 0,
    hlsResolvedViaBackground: 0, // NEW: chrome.webRequest via Service Worker
  };

  // ═══════════════════════════════════════════════════════════
  // GLOBAL ACCESSORS
  // ═══════════════════════════════════════════════════════════
  window.__getVideosMap = () => videos;
  window.__getVideoCards = () => videoCards;
  window.__getCurrentlyPlaying = () => currentlyPlaying;
  window.__setCurrentlyPlaying = (val) => {
    currentlyPlaying = val;
  };
  window.__videoCounter = videoCounter;
  window.__getPollingInterval = () => pollingInterval;
  window.__setPollingInterval = (val) => {
    pollingInterval = val;
  };
  window.__getDomObserver = () => domObserver;
  window.__setDomObserver = (val) => {
    domObserver = val;
  };
  window.__getChatRoot = () => chatRoot;
  window.__addGlobalInterval = (interval) => {
    globalResources.intervals.push(interval);
  };
  window.__addGlobalObserver = (observer) => {
    globalResources.observers.push(observer);
  };
  window.__tabIsVisible = !document.hidden;
  window.__observeVideos = observeVideos;
  window.__enforceSinglePlayback = enforceSinglePlayback;
  window.__log = log;
  window.__showVideoOverlay = showVideoOverlay;
  window.__closeVideoOverlay = closeVideoOverlay;
  window.__isOverlayShowingVideo = isOverlayShowingVideo;
  window.__openGallery = (entry) => {
    if (typeof window.GalleryModule !== "undefined") {
      window.GalleryModule.open(entry);
    } else {
      console.warn("[Content] Gallery module not loaded");
    }
  };

  // ═══════════════════════════════════════════════════════════
  // SINGLE PLAYBACK CONTROLLER
  // ═══════════════════════════════════════════════════════════
  function enforceSinglePlayback(videoToPlay) {
    if (currentlyPlaying && currentlyPlaying !== videoToPlay) {
      currentlyPlaying.pause();
      log(
        `Paused previous video to enforce single playback`,
        currentlyPlaying ? currentlyPlaying.dataset.videoObserverId : "",
      );
      if (isOverlayShowingVideo(currentlyPlaying)) closeVideoOverlay();
    }
    currentlyPlaying = videoToPlay;
    const onEnded = () => {
      if (currentlyPlaying === videoToPlay) {
        currentlyPlaying = null;
        closeVideoOverlay();
      }
    };
    videoToPlay.addEventListener("ended", onEnded, { once: true });
    console.log(
      `[Content] Single playback enforced for ${videoToPlay.dataset.videoObserverId}`,
    );
  }

  function log(message, data = null) {
    if (window.PanelManager && window.PanelManager.logToPanel) {
      window.PanelManager.logToPanel(message, data);
    } else {
      const ts = new Date().toLocaleTimeString();
      console.log(`[nsfwPH ${ts}] ${message}`, data || "");
    }
  }

  function getVideoInfo(video) {
    const protocol = getStreamingProtocol(video);
    return {
      id: video.dataset.videoObserverId || `video-${++videoCounter}`,
      src: video.currentSrc || video.src || "No source",
      currentTime: video.currentTime || 0,
      duration: video.duration || 0,
      paused: video.paused,
      protocol: protocol,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // PREVIEW SOURCE RESOLUTION
  // ═══════════════════════════════════════════════════════════
  function getPreviewSource(originalVideo, entry) {
    const rawSrc = originalVideo.currentSrc || originalVideo.src || "";

    if (rawSrc.startsWith("blob:")) {
      // Try ALL strategies to find the manifest
      const manifestUrl = findHLSManifestForVideo(originalVideo, entry);
      if (manifestUrl) {
        entry._hlsManifestUrl = manifestUrl;
        entry._needsSourceResolution = false;
        return manifestUrl;
      }
      entry._needsSourceResolution = true;
    }

    return rawSrc;
  }

  // ═══════════════════════════════════════════════════════════
  // VIDEO TRACKING
  // ═══════════════════════════════════════════════════════════
  function trackVideo(video) {
    if (video.dataset.videoObserverAttached === "true") return;
    if (videos.has(video)) return;
    if (!isTrackableVideo(video)) {
      stats.skippedInvalidVideos++;
      return;
    }

    video.dataset.videoObserverAttached = "true";
    const id = `video-${++videoCounter}`;
    video.dataset.videoObserverId = id;
    window.__videoCounter = videoCounter;

    const protocol = getStreamingProtocol(video);
    stats.totalDetected++;
    if (protocol === "hls") stats.hlsVideos++;
    else if (protocol === "dash") stats.dashVideos++;
    else stats.standardVideos++;

    console.log(
      `[Content] 🎬 Video ${id} | Protocol: ${protocol.toUpperCase()} | ` +
        `Src: ${(video.currentSrc || video.src || "").substring(0, 80)}... | ` +
        `Duration: ${video.duration || "unknown"}s | ` +
        `Size: ${video.videoWidth || "?"}x${video.videoHeight || "?"}`,
    );

    const entry = {
      id,
      element: video,
      info: getVideoInfo(video),
      preview: null,
      framesPopulated: false,
      cleanups: [],
      boostCleanup: null,
      cacheKeySrc: null,
      protocol: protocol,
      _hlsManifestUrl: null,
      _needsSourceResolution: false,
    };
    videos.set(video, entry);

    if (!video.dataset.volumeSet) {
      video.volume = 0.5;
      video.dataset.volumeSet = "true";
    }

    log(`New video detected`, {
      id,
      protocol: protocol.toUpperCase(),
      srcShort: (video.currentSrc || video.src || "").substring(0, 80) + "...",
    });

    if (window.BoostEngine) {
      entry.boostCleanup =
        window.BoostEngine.attachBoostToVideo(video) || (() => {});
    }

    const previewSrc = getPreviewSource(video, entry);
    entry.cacheKeySrc = previewSrc;

    if (window.ChunkPreview) {
      entry.preview = window.ChunkPreview.createSinglePreview(
        video,
        id,
        previewSrc,
      );
      performPanelUpdateNow(id);
    }

    // Retry HLS manifest resolution if needed
    if (entry._needsSourceResolution) {
      console.log(`[Content] 🔄 Setting up HLS manifest retry for ${id}`);
      let retryCount = 0;
      const maxRetries = 40; // 20 seconds
      const retryInterval = setInterval(() => {
        retryCount++;
        if (!entry._needsSourceResolution || retryCount > maxRetries) {
          clearInterval(retryInterval);
          if (retryCount > maxRetries) {
            console.warn(
              `[Content] ⚠️ HLS manifest resolution timeout for ${id} after ${maxRetries} retries`,
            );
          }
          return;
        }
        // Re-run findHLSManifestForVideo each retry (strategies may yield results later)
        const manifestUrl = findHLSManifestForVideo(video, entry);
        if (manifestUrl && entry._needsSourceResolution) {
          hlsManifestMap.set(video, manifestUrl);
          resolvePendingPreviewSource(entry);
        }
      }, 500);
      // Store for cleanup
      entry._hlsRetryInterval = retryInterval;
    }

    const events = [
      "loadstart",
      "progress",
      "suspend",
      "abort",
      "error",
      "emptied",
      "stalled",
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "canplaythrough",
      "durationchange",
      "play",
      "playing",
      "pause",
      "ended",
      "waiting",
      "seeking",
      "seeked",
      "ratechange",
      "volumechange",
      "resize",
    ];
    events.forEach((ev) => {
      const handler = () => {
        entry.info = getVideoInfo(video);
      };
      video.addEventListener(ev, handler, { passive: true });
      entry.cleanups.push(() => video.removeEventListener(ev, handler));
    });

    console.log(
      `[Content] Tracked video: ${id} | Protocol: ${protocol.toUpperCase()} | ${events.length} events`,
    );
  }

  // ═══════════════════════════════════════════════════════════
  // PANEL UPDATE FUNCTIONS
  // ═══════════════════════════════════════════════════════════
  function performPanelUpdateNow(videoId) {
    if (!window.CardManager) return;
    if (videoId) {
      window.CardManager.performSingleCardUpdate(videoId);
    } else {
      window.CardManager.performPanelUpdate();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // VIDEO OBSERVATION
  // ═══════════════════════════════════════════════════════════
  function findTrackableVideos() {
    const allVideos = document.querySelectorAll(VIDEO_SELECTOR);
    const trackableVideos = [];
    let skippedPanel = 0,
      skippedInvalid = 0;

    for (const video of allVideos) {
      if (isVideoInOurUI(video)) {
        skippedPanel++;
        continue;
      }
      if (!isTrackableVideo(video)) {
        skippedInvalid++;
        continue;
      }
      trackableVideos.push(video);
    }

    stats.skippedPanelVideos += skippedPanel;
    console.log(
      `[Content] 🔍 Video scan: ${allVideos.length} total | ` +
        `${trackableVideos.length} trackable | ${skippedPanel} skipped (our UI) | ${skippedInvalid} skipped (invalid)`,
    );
    return trackableVideos;
  }

  async function processVideosStaggered(foundVideos, staggerMs = 16) {
    for (let i = 0; i < foundVideos.length; i++) {
      trackVideo(foundVideos[i]);
      if (i < foundVideos.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, staggerMs));
      }
    }
    console.log(`[Content] ✅ All ${foundVideos.length} videos processed`);
  }

  function observeVideos() {
    if (observeInProgress) return;
    observeInProgress = true;

    const previouslyTracked = videos.size;
    const foundVideos = findTrackableVideos();

    console.log(
      `[Content] 👁️ Observing ${foundVideos.length} videos (prev: ${previouslyTracked}) | ` +
        `HLS:${stats.hlsVideos} DASH:${stats.dashVideos} Std:${stats.standardVideos}`,
    );

    if (foundVideos.length === 0) {
      observeInProgress = false;
      return;
    }

    const staggerMs = previouslyTracked === 0 ? 50 : 16;
    processVideosStaggered(foundVideos, staggerMs).then(() => {
      if (previouslyTracked > 0) performPanelUpdateNow();
      observeInProgress = false;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // VIDEO OVERLAY BRIDGE
  // ═══════════════════════════════════════════════════════════
  function setupVideoOverlay() {
    if (typeof window.VideoOverlay === "undefined") {
      console.warn("[Content] VideoOverlay module not loaded!");
      return;
    }
    window.VideoOverlay.setup({ enforceSinglePlayback, log });
    console.log("[Content] ✅ VideoOverlay dependencies injected");
  }

  function showVideoOverlay(videoEl, entry) {
    log(`Opening overlay for ${entry.id}`);
    if (typeof window.VideoOverlay !== "undefined")
      window.VideoOverlay.show(videoEl, entry);
    else console.error("[Content] VideoOverlay not available");
  }

  function closeVideoOverlay() {
    log("Closing overlay");
    if (typeof window.VideoOverlay !== "undefined") window.VideoOverlay.close();
  }

  function isOverlayShowingVideo(videoEl) {
    if (typeof window.VideoOverlay !== "undefined")
      return window.VideoOverlay.isShowing(videoEl);
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // CLEANUP FUNCTIONS
  // ═══════════════════════════════════════════════════════════
  function cleanupRuntimeResources() {
    console.log("[Content] Cleaning up runtime resources...");
    if (panelUpdateTimer) {
      clearTimeout(panelUpdateTimer);
      panelUpdateTimer = null;
    }
    globalResources.observers.forEach((o) => o.disconnect());
    globalResources.observers = [];
    globalResources.intervals.forEach((i) => clearInterval(i));
    globalResources.intervals = [];
    for (const entry of videos.values()) {
      if (entry._hlsRetryInterval) clearInterval(entry._hlsRetryInterval);
      if (entry.boostCleanup) {
        entry.boostCleanup();
        entry.boostCleanup = null;
      }
      if (entry.preview) {
        if (typeof entry.preview._initialBoostCleanup === "function")
          entry.preview._initialBoostCleanup();
        if (window.BoostEngine)
          window.BoostEngine.cleanupPreviewBoost(entry.preview);
      }
    }
    if (window.ChunkCache) window.ChunkCache.memoryCache.clear();
    console.log("[Content] Runtime resources cleaned up ✅");
  }

  function cleanupAllResources() {
    console.log("[Content] Performing full cleanup...");
    cleanupRuntimeResources();
    if (typeof window.VideoOverlay !== "undefined") {
      window.VideoOverlay.destroy();
      log("Video overlay destroyed.");
    }
    if (window.ChunkCache)
      window.ChunkCache.clear().catch((err) =>
        console.warn("[Cleanup] Error clearing chunk cache:", err),
      );
    console.log("[Content] Full cleanup complete ✅");
  }

  // ═══════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════
  function waitForBody(callback) {
    if (document.body) return callback();
    console.log("[Content] Waiting for body element...");
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(document.documentElement, { childList: true });
    setTimeout(() => {
      if (document.body) callback();
    }, 1500);
  }

  function init() {
    if (window.__VIDEO_OBSERVER_INITIALIZED__) return;
    window.__VIDEO_OBSERVER_INITIALIZED__ = true;
    cleanupRuntimeResources();

    console.log("[Content] Initializing Video Observer...");
    console.log(`[Content] Video selector: "${VIDEO_SELECTOR}" (generic)`);
    console.log(`[Content] Excluding: #${OBSERVER_PANEL_ID}, #${OVERLAY_ID}`);

    // Strategy 0: Query background Service Worker (MOST RELIABLE - runs before page JS)
    queryBackgroundForManifests().then((found) => {
      if (found) {
        console.log(
          "[Content] ✅ Background SW provided manifests - preview sources will be resolved",
        );
        stats.hlsResolvedViaBackground++;
      }
    });

    // Strategy 1: Scan Performance API for already-completed .m3u8 requests
    if (scanPerformanceAPIForM3U8()) {
      stats.hlsResolvedViaPerfAPI++;
    }

    // Strategy 2: Scan inline scripts for .m3u8 URLs
    if (scanScriptsForM3U8()) {
      stats.hlsResolvedViaScripts++;
    }

    // Strategy 3: Set up network interception for future .m3u8 requests
    initHLSNetworkInterceptor();

    // Strategy 4: Also re-query background SW after a delay (catches late-loading manifests)
    setTimeout(async () => {
      const found = await queryBackgroundForManifests();
      if (found) {
        // Try to resolve any pending previews with newly found manifests
        for (const [videoEl, entry] of videos.entries()) {
          if (entry._needsSourceResolution) {
            const manifestUrl = hlsManifestByPage.values().next().value;
            if (manifestUrl) {
              hlsManifestMap.set(videoEl, manifestUrl);
              resolvePendingPreviewSource(entry);
            }
          }
        }
      }
    }, 2000);

    if (window.PanelManager) {
      window.PanelManager.createFloatingPanel();
      log("Floating panel created.");
    }
    setupVideoOverlay();
    log("Video overlay module initialized.");
    if (window.VisibilityManager)
      window.VisibilityManager.initVisibilityListener();

    observeVideos();
    log("Initial video observation performed.");

    let debounceTimer = null;
    domObserver = new MutationObserver((mutations) => {
      if (!window.__tabIsVisible) return;
      const hasRelevantChange = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (node) =>
            node.nodeType === 1 &&
            !node.closest?.(`#${OBSERVER_PANEL_ID}`) &&
            !node.closest?.(`#${OVERLAY_ID}`) &&
            !node.closest?.("#vo-previews-wrap"),
        ),
      );
      if (!hasRelevantChange) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(observeVideos, 600);
    });

    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
    globalResources.observers.push(domObserver);

    pollingInterval = setInterval(observeVideos, 30000);
    globalResources.intervals.push(pollingInterval);

    log("Init complete — observer watching document body for new videos");
    console.log("[Content] ✅ Full initialization complete");
    console.log("[Content] Detection stats:", stats);
    console.log("[Content] Active modules:", {
      BoostEngine: !!window.BoostEngine,
      ChunkCache: !!window.ChunkCache,
      BufferManager: !!window.BufferManager,
      ChunkPreview: !!window.ChunkPreview,
      CardManager: !!window.CardManager,
      PanelManager: !!window.PanelManager,
      VisibilityManager: !!window.VisibilityManager,
      VideoOverlay: !!window.VideoOverlay,
    });
  }

  window.addEventListener("unload", () => {
    cleanupAllResources();
  });

  console.log("[Content] Waiting for body to start initialization...");
  waitForBody(init);
  console.log("[Content] Core module loaded ✅");
})();
