// content.js - Reddit Video Observer orchestrator
(function () {
  "use strict";
  console.log("[RedditContent] Core module loading...");

  const SELECTOR = "shreddit-player video";
  const CLONE_MARKER = "data-shadow-clone";
  const FLATTEN_MARKER = "data-shadow-flattened";
  const MUTATION_DEBOUNCE = 400;
  const POLL_INTERVAL = 10000;

  let videos = new Map();
  let videoCards = new Map();
  let currentlyPlaying = null;
  let videoCounter = 0;
  let domObserver = null;
  let pollingInterval = null;
  let globalResources = { observers: [], intervals: [] };
  let observeInProgress = false;
  let mutationDebounceTimer = null;
  let panelUpdateTimer = null;
  // Track which players we've already set up source-watching on
  let sourceWatchedPlayers = new WeakSet();

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
  window.__addGlobalInterval = (i) => globalResources.intervals.push(i);
  window.__addGlobalObserver = (o) => globalResources.observers.push(o);
  window.__tabIsVisible = !document.hidden;
  window.__observeVideos = observeVideos;
  window.__enforceSinglePlayback = enforceSinglePlayback;
  window.__log = log;
  window.__showVideoOverlay = showVideoOverlay;
  window.__closeVideoOverlay = closeVideoOverlay;
  window.__isOverlayShowingVideo = isOverlayShowingVideo;
  window.__openGallery = (entry) => {
    if (typeof window.GalleryModule !== "undefined")
      window.GalleryModule.open(entry);
  };

  function log(message, data = null) {
    if (window.PanelManager && window.PanelManager.logToPanel) {
      window.PanelManager.logToPanel(message, data);
    } else {
      console.log(
        `[Reddit ${new Date().toLocaleTimeString()}] ${message}`,
        data || "",
      );
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SHADOW SOURCE WATCHER
  // ═══════════════════════════════════════════════════════════
  /**
   * Watch a shreddit-player's shadow DOM <video> for src attribute changes.
   * When Reddit sets the src asynchronously, sync it to the clone.
   */
  function watchPlayerSource(player) {
    if (!player.shadowRoot) return;
    if (sourceWatchedPlayers.has(player)) return;
    sourceWatchedPlayers.add(player);

    const originalVideo = player.shadowRoot.querySelector("video");
    if (!originalVideo) return;

    // Use MutationObserver on the shadow video's attributes
    const attrObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (
          m.type === "attributes" &&
          (m.attributeName === "src" || m.attributeName === "currentSrc")
        ) {
          const src =
            originalVideo.currentSrc ||
            originalVideo.src ||
            originalVideo.getAttribute("src");
          if (!src) return;

          // Find clone
          let clone = player.querySelector(`video[${CLONE_MARKER}]`);
          if (!clone) {
            // Clone doesn't exist — flatten now
            if (
              window.ShadowDOMFlattener &&
              !window.ShadowDOMFlattener.isFlattened(player)
            ) {
              window.ShadowDOMFlattener.flattenOne(player);
            }
            clone = player.querySelector(`video[${CLONE_MARKER}]`);
          }
          if (clone && !clone.src && !clone.dataset.videoObserverAttached) {
            clone.src = src;
            console.log(
              `[RedditContent] 🔗 Source synced from shadow DOM: ${src.substring(0, 60)}...`,
            );

            // Trigger observation for this newly-sourced video
            // Use a small delay to let the clone settle
            setTimeout(() => observeVideos(), 100);
          }
          // We got what we needed — disconnect
          attrObserver.disconnect();
          break;
        }
      }
    });

    attrObserver.observe(originalVideo, {
      attributes: true,
      attributeFilter: ["src"],
    });
    globalResources.observers.push(attrObserver);
  }

  /**
   * Set up source watching on all shreddit-players that have shadow DOMs.
   */
  function setupSourceWatchers() {
    const players = document.querySelectorAll("shreddit-player");
    for (const player of players) {
      if (player.shadowRoot) {
        watchPlayerSource(player);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SHADOW DOM SYNC
  // ═══════════════════════════════════════════════════════════
  function syncCloneSources() {
    const players = document.querySelectorAll("shreddit-player");
    let synced = 0;
    for (const player of players) {
      if (!player.shadowRoot) continue;
      const originalVideo = player.shadowRoot.querySelector("video");
      if (!originalVideo) continue;
      const originalSrc =
        originalVideo.currentSrc ||
        originalVideo.src ||
        originalVideo.getAttribute("src");
      if (!originalSrc) continue;

      let clone = player.querySelector(`video[${CLONE_MARKER}]`);
      if (!clone) {
        if (
          window.ShadowDOMFlattener &&
          !window.ShadowDOMFlattener.isFlattened(player)
        ) {
          window.ShadowDOMFlattener.flattenOne(player);
        }
        clone = player.querySelector(`video[${CLONE_MARKER}]`);
      }
      if (clone && !clone.src && !clone.currentSrc) {
        clone.src = originalSrc;
        synced++;
      }
    }
    if (synced > 0) {
      console.log(
        `[RedditContent] 🔗 Synced ${synced} clone sources from originals`,
      );
    }
    return synced;
  }

  function ensureShadowDOMFlattened() {
    if (!window.ShadowDOMFlattener) {
      console.error("[RedditContent] ❌ ShadowDOMFlattener not loaded!");
      return false;
    }
    try {
      const count = window.ShadowDOMFlattener.flattenAll();
      if (count > 0) {
        console.log(`[RedditContent] 🔓 Flattened ${count} new players`);
        // Set up source watchers on newly flattened players
        setupSourceWatchers();
      }
      syncCloneSources();
      return true;
    } catch (err) {
      console.error("[RedditContent] ❌ Shadow flattening failed:", err);
      return false;
    }
  }

  function enforceSinglePlayback(videoToPlay) {
    if (currentlyPlaying && currentlyPlaying !== videoToPlay) {
      currentlyPlaying.pause();
      if (isOverlayShowingVideo(currentlyPlaying)) closeVideoOverlay();
    }
    currentlyPlaying = videoToPlay;
    videoToPlay.addEventListener(
      "ended",
      () => {
        if (currentlyPlaying === videoToPlay) {
          currentlyPlaying = null;
          closeVideoOverlay();
        }
      },
      { once: true },
    );
  }

  function getVideoInfo(video) {
    return {
      id: video.dataset.videoObserverId || `video-${++videoCounter}`,
      src: video.currentSrc || video.src || "No source",
      currentTime: video.currentTime || 0,
      duration: video.duration || 0,
      paused: video.paused,
    };
  }

  function trackVideo(video) {
    if (video.dataset.videoObserverAttached === "true") return;
    video.dataset.videoObserverAttached = "true";
    if (videos.has(video)) return;

    const id = `video-${++videoCounter}`;
    video.dataset.videoObserverId = id;
    window.__videoCounter = videoCounter;

    const entry = {
      id,
      element: video,
      info: getVideoInfo(video),
      preview: null,
      framesPopulated: false,
      cleanups: [],
      boostCleanup: null,
      cacheKeySrc: null,
    };
    videos.set(video, entry);

    if (!video.dataset.volumeSet) {
      video.volume = 0.5;
      video.dataset.volumeSet = "true";
    }

    log(`New video detected`, {
      id,
      srcShort: (video.currentSrc || video.src || "").substring(0, 80) + "...",
    });

    if (window.BoostEngine) {
      entry.boostCleanup =
        window.BoostEngine.attachBoostToVideo(video) || (() => {});
    }
    if (window.ChunkPreview) {
      entry.preview = window.ChunkPreview.createSinglePreview(video, id);
      performPanelUpdateNow(id);
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
  }

  function performPanelUpdateNow(videoId) {
    if (!window.CardManager) return;
    if (videoId) {
      window.CardManager.performSingleCardUpdate(videoId);
    } else {
      window.CardManager.performPanelUpdate();
    }
  }

  async function processVideosStaggered(foundVideos, staggerMs = 16) {
    for (let i = 0; i < foundVideos.length; i++) {
      trackVideo(foundVideos[i]);
      if (i < foundVideos.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, staggerMs));
      }
    }
    console.log(`[RedditContent] ✅ Processed ${foundVideos.length} videos`);
  }

  function observeVideos() {
    if (observeInProgress) return;
    observeInProgress = true;

    if (!ensureShadowDOMFlattened()) {
      observeInProgress = false;
      return;
    }

    const allFound = document.querySelectorAll(SELECTOR);
    const previouslyTracked = videos.size;

    const videoArray = Array.from(allFound).filter((video) => {
      const hasSource = !!(video.currentSrc || video.src);
      if (!hasSource) return false;
      if (video.dataset.videoObserverAttached === "true") return false;
      return true;
    });

    if (videoArray.length === 0) {
      observeInProgress = false;
      return;
    }

    console.log(
      `[RedditContent] Found ${allFound.length} total, ${videoArray.length} new (tracked: ${previouslyTracked})`,
    );

    const staggerMs = previouslyTracked === 0 ? 50 : 16;
    processVideosStaggered(videoArray, staggerMs).then(() => {
      if (previouslyTracked > 0) performPanelUpdateNow();
      observeInProgress = false;
    });
  }

  function setupVideoOverlay() {
    if (typeof window.VideoOverlay !== "undefined") {
      window.VideoOverlay.setup({ enforceSinglePlayback, log });
    }
  }
  function showVideoOverlay(videoEl, entry) {
    if (typeof window.VideoOverlay !== "undefined")
      window.VideoOverlay.show(videoEl, entry);
  }
  function closeVideoOverlay() {
    if (typeof window.VideoOverlay !== "undefined") window.VideoOverlay.close();
  }
  function isOverlayShowingVideo(videoEl) {
    return typeof window.VideoOverlay !== "undefined"
      ? window.VideoOverlay.isShowing(videoEl)
      : false;
  }

  function cleanupRuntimeResources() {
    if (panelUpdateTimer) {
      clearTimeout(panelUpdateTimer);
      panelUpdateTimer = null;
    }
    if (mutationDebounceTimer) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    globalResources.observers.forEach((o) => o.disconnect());
    globalResources.observers = [];
    globalResources.intervals.forEach((i) => clearInterval(i));
    globalResources.intervals = [];
    sourceWatchedPlayers = new WeakSet();
    for (const entry of videos.values()) {
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
  }

  function cleanupAllResources() {
    cleanupRuntimeResources();
    if (typeof window.VideoOverlay !== "undefined")
      window.VideoOverlay.destroy();
    if (window.ChunkCache) window.ChunkCache.clear().catch(() => {});
    if (window.ShadowDOMFlattener) window.ShadowDOMFlattener.unflattenAll();
    console.log("[RedditContent] Full cleanup complete ✅");
  }

  function setupMutationObserver() {
    domObserver = new MutationObserver((mutations) => {
      if (!window.__tabIsVisible) return;
      const hasAdditions = mutations.some((m) => m.addedNodes.length > 0);
      if (!hasAdditions) return;

      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = setTimeout(() => {
        // Set up source watchers BEFORE observing (catches players that
        // were just inserted but haven't had src set yet)
        setupSourceWatchers();
        observeVideos();
      }, MUTATION_DEBOUNCE);
    });

    function startObserving() {
      const feedRoot = document.querySelector("shreddit-feed") || document.body;
      domObserver.observe(feedRoot, { childList: true, subtree: true });
      console.log(
        `[RedditContent] 🔍 MutationObserver watching: ${feedRoot.tagName || feedRoot.nodeName}`,
      );
    }

    if (document.querySelector("shreddit-feed")) {
      startObserving();
    } else {
      const feedFinder = new MutationObserver(() => {
        if (document.querySelector("shreddit-feed")) {
          feedFinder.disconnect();
          startObserving();
        }
      });
      feedFinder.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      setTimeout(() => {
        if (!document.querySelector("shreddit-feed")) {
          feedFinder.disconnect();
          startObserving();
        }
      }, 3000);
    }
    globalResources.observers.push(domObserver);
  }

  function waitForBody(callback) {
    if (document.body) return callback();
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
    if (window.__VIDEO_OBSERVER_INITIALIZED__) {
      console.log("[RedditContent] Already initialized, skipping");
      return;
    }
    window.__VIDEO_OBSERVER_INITIALIZED__ = true;
    cleanupRuntimeResources();
    console.log("[RedditContent] Initializing Reddit Video Observer...");

    ensureShadowDOMFlattened();

    if (window.PanelManager) window.PanelManager.createFloatingPanel();
    setupVideoOverlay();
    if (window.VisibilityManager)
      window.VisibilityManager.initVisibilityListener();

    setupMutationObserver();
    log("MutationObserver watching feed for new shreddit-player elements");

    // Initial scan after delay
    setTimeout(() => {
      setupSourceWatchers();
      observeVideos();
    }, 2000);

    // Polling safety net
    pollingInterval = setInterval(() => {
      if (window.__tabIsVisible) {
        setupSourceWatchers();
        observeVideos();
      }
    }, POLL_INTERVAL);
    globalResources.intervals.push(pollingInterval);

    log("Init complete ✅");
  }

  window.addEventListener("unload", () => cleanupAllResources());
  waitForBody(init);
  console.log("[RedditContent] Core module loaded ✅");
})();
