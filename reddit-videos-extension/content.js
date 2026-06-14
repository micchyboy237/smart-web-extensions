// content.js - Reddit Auto Video Player (v8.0 - CSS Refactored)
(function () {
  "use strict";

  // Configuration
  const CONFIG = {
    DEFAULT_VOLUME: 0.2,
    PANEL_TOP_OFFSET: 80,
    VIDEO_SCALE: 1.05,
    BACKGROUND_OPACITY: 0.85,
    STORAGE_KEY: "reddit_auto_player_volumes",
    CSS_FILE: "styles.css",
  };

  // State
  let isEnabled = false;
  let currentPlayingPost = null;
  let currentPlayingVideo = null;
  let mutationObserver = null;
  let userVolumeMap = new Map();

  // ==================== LOGGING UTILITY ====================
  function log(message, type = "info") {
    const styles = {
      info: "color:#FF4500; font-weight:bold",
      success: "color:#00C853; font-weight:bold",
      warning: "color:#FF9100; font-weight:bold",
      error: "color:#FF1744; font-weight:bold",
    };
    console.log(
      `%c[Reddit Auto Video] ${message}`,
      styles[type] || styles.info,
    );
  }

  // ==================== CSS INJECTION ====================
  function injectStylesheet() {
    // Check if already injected
    if (document.getElementById("reddit-auto-player-styles")) {
      log("Stylesheet already injected", "info");
      return;
    }

    const link = document.createElement("link");
    link.id = "reddit-auto-player-styles";
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = chrome.runtime.getURL(CONFIG.CSS_FILE);

    // Fallback: inline critical styles if file fails to load
    link.onerror = () => {
      log("Failed to load external CSS, injecting inline styles", "warning");
      injectInlineStyles();
    };

    document.head.appendChild(link);
    log("External stylesheet injected", "success");
  }

  function injectInlineStyles() {
    const style = document.createElement("style");
    style.id = "reddit-auto-player-inline-styles";
    style.textContent = `
      #reddit-auto-player-panel {
        position: fixed; top: ${CONFIG.PANEL_TOP_OFFSET}px; right: 20px;
        z-index: 2147483647; background: rgba(255,69,0,0.95); color: white;
        padding: 12px 16px; border-radius: 12px;
        box-shadow: 0 8px 25px rgba(255,69,0,0.4);
        font-family: system-ui; font-size: 14px;
        display: flex; align-items: center; gap: 10px;
        backdrop-filter: blur(10px); cursor: move;
      }
      [data-currently-playing="true"] shreddit-player video {
        transform: scale(1.05); transition: transform 0.3s ease;
        filter: brightness(1.05) contrast(1.05);
      }
      .reddit-video-bg {
        position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        background: linear-gradient(135deg, rgba(20,20,20,0.85), rgba(40,40,40,0.85));
        border-radius: 8px; z-index: 0; pointer-events: none;
      }
    `;
    document.head.appendChild(style);
    log("Inline styles injected as fallback", "success");
  }

  // ==================== VOLUME PERSISTENCE ====================
  function loadSavedVolumes() {
    try {
      const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        userVolumeMap = new Map(Object.entries(parsed));
        log(`Loaded ${userVolumeMap.size} saved volume preferences`, "success");
      }
    } catch (error) {
      log(`Failed to load saved volumes: ${error.message}`, "error");
    }
  }

  function saveVolumes() {
    try {
      const obj = Object.fromEntries(userVolumeMap);
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(obj));
    } catch (error) {
      log(`Failed to save volumes: ${error.message}`, "error");
    }
  }

  // ==================== DOM HELPERS ====================
  function getVideoFromPlayer(player) {
    return player?.shadowRoot?.querySelector("video") || null;
  }

  function getVideoPosts() {
    return Array.from(document.querySelectorAll("shreddit-post")).filter(
      (post) => {
        const player = post.querySelector("shreddit-player");
        return player && getVideoFromPlayer(player);
      },
    );
  }

  function getNextVideoPost(currentPost) {
    const posts = getVideoPosts();
    const idx = posts.indexOf(currentPost);
    return idx >= 0 && idx + 1 < posts.length ? posts[idx + 1] : null;
  }

  function getPreviousVideoPost(currentPost) {
    const posts = getVideoPosts();
    const idx = posts.indexOf(currentPost);
    return idx > 0 ? posts[idx - 1] : null;
  }

  function smoothScrollToPost(post) {
    if (!post) return;
    const target = post.querySelector("shreddit-player") || post;
    const rect = target.getBoundingClientRect();
    const targetY =
      window.scrollY + rect.top - Math.max(120, window.innerHeight * 0.18);
    window.scrollTo({ top: targetY, behavior: "smooth" });
  }

  async function waitForVideoInPost(post, timeoutMs = 5000) {
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        const player = post.querySelector("shreddit-player");
        const video = player ? getVideoFromPlayer(player) : null;
        if (video && (video.src || video.currentSrc) && video.readyState >= 2) {
          resolve(video);
        } else if (Date.now() - start > timeoutMs) {
          resolve(null);
        } else {
          setTimeout(check, 300);
        }
      };
      check();
    });
  }

  function getVideoId(video) {
    return video.src ? video.src.split("/").pop().slice(0, 20) : "unknown";
  }

  // ==================== VIDEO STYLING (Minimal JS, CSS handles rest) ====================
  function markAsCurrentlyPlaying(post, video) {
    // Remove from previous
    if (currentPlayingPost) {
      currentPlayingPost.removeAttribute("data-currently-playing");
    }

    // Set new current
    currentPlayingPost = post;
    currentPlayingVideo = video;
    post.setAttribute("data-currently-playing", "true");

    log(`🎯 Marked post as currently playing`, "info");
  }

  function applyBackgroundContainer(post) {
    // Check if already exists
    if (post.querySelector(".reddit-video-bg")) {
      return;
    }

    const bgContainer = document.createElement("div");
    bgContainer.className = "reddit-video-bg";

    const player = post.querySelector("shreddit-player");
    if (player) {
      player.style.position = "relative";
      player.parentElement.style.position = "relative";
      player.parentElement.insertBefore(bgContainer, player);
      log("🖼️ Background container added", "success");
    }
  }

  function addVideoStatusIndicator(post) {
    if (post.querySelector(".reddit-video-status")) {
      return;
    }

    const status = document.createElement("div");
    status.className = "reddit-video-status";
    status.textContent = "▶ NOW PLAYING";

    const player = post.querySelector("shreddit-player");
    if (player) {
      player.parentElement.style.position = "relative";
      player.parentElement.appendChild(status);
    }
  }

  // ==================== VOLUME MANAGEMENT ====================
  function applyUnmuteAndVolume(video, isNewVideo = false) {
    if (!video) return;

    const videoId = getVideoId(video);

    // Initialize state
    if (video._redditUserPaused === undefined) {
      video._redditUserPaused = false;
    }

    // Track user volume changes
    const volumeChangeHandler = () => {
      if (!video._settingVolumeProgrammatically && !video.muted) {
        const currentVolume = video.volume;
        if (currentVolume !== CONFIG.DEFAULT_VOLUME) {
          userVolumeMap.set(videoId, currentVolume);
          saveVolumes();
          log(`💾 Volume saved: ${currentVolume.toFixed(2)}`, "success");
        }
      }
      video._settingVolumeProgrammatically = false;
    };

    video.removeEventListener("volumechange", volumeChangeHandler);
    video.addEventListener("volumechange", volumeChangeHandler);

    // Event handlers
    const handlePlayState = (eventName) => {
      if (eventName === "pause") {
        video._redditUserPaused = true;
        log("⏸️ User paused video", "warning");
      }
      if (eventName === "play" || eventName === "playing") {
        video._redditUserPaused = false;
      }

      // Apply volume only on initial play if no user preference
      if (
        (eventName === "playing" || eventName === "canplay") &&
        !video._redditUserPaused &&
        !userVolumeMap.has(videoId)
      ) {
        setTimeout(() => {
          if (!userVolumeMap.has(videoId)) {
            video._settingVolumeProgrammatically = true;
            video.muted = false;
            video.volume = CONFIG.DEFAULT_VOLUME;
            log(`🔊 Default volume: ${CONFIG.DEFAULT_VOLUME}`, "info");
          }
        }, 50);
      }
    };

    ["play", "playing", "pause", "ended", "canplay", "error"].forEach(
      (event) => {
        video.addEventListener(event, () => handlePlayState(event), {
          once: event === "ended",
        });
      },
    );

    // Initial volume setup
    if (isNewVideo) {
      setTimeout(() => {
        if (userVolumeMap.has(videoId)) {
          video._settingVolumeProgrammatically = true;
          video.volume = userVolumeMap.get(videoId);
          video.muted = false;
          log(`🔄 Restored volume: ${video.volume.toFixed(2)}`, "success");
        } else {
          video._settingVolumeProgrammatically = true;
          video.muted = true;
          video.volume = CONFIG.DEFAULT_VOLUME;
          setTimeout(() => {
            video._settingVolumeProgrammatically = true;
            video.muted = false;
          }, 100);
        }
      }, 10);
    }
  }

  // ==================== PLAY VIDEO ====================
  async function playVideoInPost(post, isAutoNext = false) {
    if (!post) return;

    const player = post.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;
    if (!video) return;

    if (video._redditUserPaused && !isAutoNext) {
      log("⏸️ Skipping - user paused this video", "warning");
      return;
    }

    cleanupPreviousPlayer();

    // Pause all other videos
    document.querySelectorAll("video").forEach((v) => {
      if (v !== video) v.pause();
    });

    // Mark as current playing - CSS handles visual styling
    markAsCurrentlyPlaying(post, video);
    applyBackgroundContainer(post);
    addVideoStatusIndicator(post);

    log(
      `▶️ Playing: Post ${post.getAttribute("post-id") || "unknown"}`,
      "success",
    );

    // Auto-next setup
    if (video._redditAutoEnded) {
      video.removeEventListener("ended", video._redditAutoEnded);
    }

    video._redditAutoEnded = async () => {
      if (!isEnabled) return;
      log("🎬 Video ended - finding next", "info");

      const next = getNextVideoPost(post);
      if (next) {
        smoothScrollToPost(next);
        const nextVideo = await waitForVideoInPost(next);
        if (nextVideo) playVideoInPost(next, true);
      } else {
        log("🏁 No more videos", "info");
      }
    };

    video.addEventListener("ended", video._redditAutoEnded, { once: true });

    // Setup volume
    applyUnmuteAndVolume(video);

    // Play
    try {
      await video.play();
      log("✅ Playback started", "success");
    } catch (err) {
      log(`❌ Play failed: ${err.message}`, "error");

      if (err.name === "NotAllowedError") {
        createPlayOverlay(video);
      }
    }
  }

  function createPlayOverlay(video) {
    // Remove existing overlays
    video.parentElement?.querySelector(".reddit-play-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "reddit-play-overlay";
    overlay.textContent = "▶️ Click to play";
    overlay.onclick = async (e) => {
      e.stopPropagation();
      overlay.remove();
      try {
        await video.play();
        log("✅ Playback started via overlay click", "success");
      } catch (err) {
        log(`❌ Still failed: ${err.message}`, "error");
      }
    };
    video.parentElement?.appendChild(overlay);
    log("🔧 Play overlay created", "warning");
  }

  function cleanupPreviousPlayer() {
    if (!currentPlayingPost) return;

    log("🧹 Cleaning up previous player", "info");

    // Remove styling indicators
    currentPlayingPost.removeAttribute("data-currently-playing");
    currentPlayingPost.querySelector(".reddit-video-status")?.remove();

    // Cleanup event listeners
    const player = currentPlayingPost.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;

    if (video?._redditAutoEnded) {
      video.removeEventListener("ended", video._redditAutoEnded);
      delete video._redditAutoEnded;
    }

    currentPlayingPost = null;
    currentPlayingVideo = null;
  }

  function stopAutoPlay() {
    log("🛑 Stopping auto-play", "warning");
    cleanupPreviousPlayer();
    document.querySelectorAll("video").forEach((v) => v.pause());
  }

  // ==================== KEYBOARD NAVIGATION ====================
  function setupKeyboardNavigation() {
    document.addEventListener("keydown", async (e) => {
      if (!isEnabled) return;

      if (
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.isContentEditable
      ) {
        return;
      }

      let targetPost = null;
      let isAutoNext = false;

      if (e.key === "ArrowRight") {
        targetPost = currentPlayingPost
          ? getNextVideoPost(currentPlayingPost)
          : getVideoPosts()[0];
        isAutoNext = true;
        log("➡️ Arrow Right - Next", "info");
      } else if (e.key === "ArrowLeft") {
        targetPost = currentPlayingPost
          ? getPreviousVideoPost(currentPlayingPost)
          : getVideoPosts()[0];
        isAutoNext = true;
        log("⬅️ Arrow Left - Previous", "info");
      }

      if (targetPost) {
        e.preventDefault();
        smoothScrollToPost(targetPost);
        const video = await waitForVideoInPost(targetPost);
        if (video) {
          setTimeout(() => playVideoInPost(targetPost, isAutoNext), 400);
        }
      }
    });

    log("⌨️ Arrow key navigation ready", "success");
  }

  // ==================== MUTATION OBSERVER ====================
  function setupMutationObserver() {
    if (mutationObserver) mutationObserver.disconnect();

    mutationObserver = new MutationObserver((mutations) => {
      if (!isEnabled) return;

      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;

        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          const newPosts = node.matches?.("shreddit-post") ? [node] : [];
          newPosts.push(...(node.querySelectorAll?.("shreddit-post") || []));

          for (const post of newPosts) {
            processNewPost(post);
          }
        });
      }
    });

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    log("🔍 MutationObserver active", "success");
  }

  function processNewPost(post) {
    if (post._redditVideoProcessed) return;

    const player = post.querySelector("shreddit-player");
    if (!player) return;

    const video = getVideoFromPlayer(player);
    if (!video) return;

    post._redditVideoProcessed = true;

    // Add data attribute for CSS targeting
    post.setAttribute("data-has-video", "true");

    log("🆕 New video post detected", "info");
    applyUnmuteAndVolume(video, true);

    if (!post._redditClickListenerAdded) {
      addClickListenersToPosts();
    }
  }

  function addClickListenersToPosts() {
    getVideoPosts().forEach((post) => {
      if (post._redditClickListenerAdded) return;

      post.setAttribute("data-has-video", "true");

      post.addEventListener("click", (e) => {
        if (
          e.target.closest("a, button, shreddit-vote-button, faceplate-number")
        ) {
          return;
        }

        if (!isEnabled) return;

        log("🖱️ Post clicked", "info");
        smoothScrollToPost(post);
        setTimeout(() => playVideoInPost(post), 300);
      });

      post._redditClickListenerAdded = true;
    });
  }

  function startAutoPlay() {
    log("=== Starting Auto-Play ===", "info");

    const posts = getVideoPosts();
    if (posts.length === 0) {
      log("No video posts found", "warning");
      return;
    }

    // Find first visible post
    let startPost = posts[0];
    for (const p of posts) {
      const r = p.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.75 && r.bottom > 100) {
        startPost = p;
        break;
      }
    }

    smoothScrollToPost(startPost);
    setTimeout(() => isEnabled && playVideoInPost(startPost), 800);
  }

  // ==================== UI CREATION ====================
  function createUI() {
    const container = document.createElement("div");
    container.id = "reddit-auto-player-panel";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.id = "reddit-auto-player-toggle";

    const label = document.createElement("label");
    label.textContent = "Auto-play videos + scroll (← → arrows)";
    label.id = "reddit-auto-player-label";
    label.htmlFor = "reddit-auto-player-toggle";

    container.append(checkbox, label);
    document.body.appendChild(container);

    // Toggle handler
    checkbox.addEventListener("change", () => {
      isEnabled = checkbox.checked;
      log(
        `Auto-play ${isEnabled ? "ENABLED" : "DISABLED"}`,
        isEnabled ? "success" : "warning",
      );

      if (isEnabled) {
        startAutoPlay();
        setupMutationObserver();
        setupKeyboardNavigation();
        setTimeout(addClickListenersToPosts, 1000);
      } else {
        stopAutoPlay();
        if (mutationObserver) {
          mutationObserver.disconnect();
          mutationObserver = null;
        }
      }
    });

    // Make panel draggable
    makeDraggable(container);

    return checkbox;
  }

  function makeDraggable(element) {
    let isDragging = false;
    let startY = 0;
    let startTop = 0;

    element.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "INPUT") return;
      isDragging = true;
      startY = e.clientY;
      startTop = element.getBoundingClientRect().top;
      element.classList.add("dragging");
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const deltaY = e.clientY - startY;
      const newTop = Math.max(0, startTop + deltaY);
      element.style.top = `${newTop}px`;
    });

    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        element.classList.remove("dragging");
        log(`📍 Panel positioned at ${element.style.top}`, "info");
      }
    });
  }

  // ==================== INITIALIZATION ====================
  function init() {
    log("🚀 Reddit Auto Video Player v8.0 Initializing", "info");

    // Inject CSS first
    injectStylesheet();

    // Load saved preferences
    loadSavedVolumes();

    // Create UI
    createUI();
    isEnabled = true;

    log("Features:", "success");
    log("  ✓ Volume persistence (localStorage)", "info");
    log("  ✓ CSS-based video styling", "info");
    log("  ✓ Current post tracking", "info");
    log("  ✓ Draggable control panel", "info");
    log("  ✓ Arrow key navigation", "info");

    // Delayed start
    setTimeout(() => {
      startAutoPlay();
      setupMutationObserver();
      setupKeyboardNavigation();
      addClickListenersToPosts();
    }, 1600);
  }

  // Start when ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Cleanup on unload
  window.addEventListener("beforeunload", () => {
    log("👋 Cleaning up", "info");
    cleanupPreviousPlayer();
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    saveVolumes();
  });
})();
