// content.js - Reddit Auto Video Player (v8.1 - Complete Working Version)
(function () {
  "use strict";

  // ==================== CONFIGURATION ====================
  const CONFIG = {
    DEFAULT_VOLUME: 0.2,
    PANEL_TOP_OFFSET: 80,
    VIDEO_SCALE: 1.15,
    BACKGROUND_OPACITY: 0.95,
    STORAGE_KEY: "reddit_auto_player_volumes",
    SHADOW_STYLES: `
      video {
        transform: scale(1.15) !important;
        transition: transform 0.3s ease, filter 0.3s ease !important;
        filter: brightness(1.1) contrast(1.1) saturate(1.05) !important;
        box-shadow: 0 0 30px rgba(0, 0, 0, 0.5) !important;
      }
      :host {
        background: #000000 !important;
      }
      .media-controls, .player-controls {
        background: rgba(0, 0, 0, 0.8) !important;
        backdrop-filter: blur(10px) !important;
      }
    `,
  };

  // ==================== STATE ====================
  let isEnabled = false;
  let currentPlayingPost = null;
  let currentPlayingVideo = null;
  let mutationObserver = null;
  let userVolumeMap = new Map();
  let injectedShadowRoots = new Set();

  // ==================== LOGGING ====================
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

  // ==================== SHADOW DOM INJECTION ====================
  function injectShadowDOMStyles(shredditPlayer) {
    if (!shredditPlayer || !shredditPlayer.shadowRoot) {
      return false;
    }

    const shadowRoot = shredditPlayer.shadowRoot;

    // Avoid duplicate injection
    if (injectedShadowRoots.has(shadowRoot)) {
      return true;
    }

    try {
      const styleElement = document.createElement("style");
      styleElement.textContent = CONFIG.SHADOW_STYLES;
      shadowRoot.appendChild(styleElement);
      injectedShadowRoots.add(shadowRoot);

      log("✅ Shadow DOM styles injected", "success");
      return true;
    } catch (error) {
      log(`❌ Shadow DOM injection failed: ${error.message}`, "error");
      return false;
    }
  }

  // ==================== VIDEO STYLING ====================
  function applyVideoStyling(post, video) {
    if (!post || !video) return;

    log(`🎨 Applying styling to video`, "info");

    // Get the shreddit-player element
    const shredditPlayer = post.querySelector("shreddit-player");
    if (shredditPlayer) {
      // Inject styles into Shadow DOM for actual video scaling
      const shadowInjected = injectShadowDOMStyles(shredditPlayer);

      if (!shadowInjected) {
        // Retry after delay if Shadow DOM not ready
        setTimeout(() => injectShadowDOMStyles(shredditPlayer), 500);
      }

      // Style the shreddit-player container
      shredditPlayer.style.cssText = `
        background: #000000 !important;
        border-radius: 8px !important;
        overflow: visible !important;
        box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.9), 
                    0 0 25px rgba(255, 69, 0, 0.4),
                    0 8px 32px rgba(0, 0, 0, 0.7) !important;
        transition: all 0.3s ease !important;
      `;
    }

    // Create dark contrasting background
    let bgContainer = post.querySelector(".reddit-video-bg");
    if (!bgContainer) {
      bgContainer = document.createElement("div");
      bgContainer.className = "reddit-video-bg";
      bgContainer.style.cssText = `
        position: absolute;
        top: -10px;
        left: -10px;
        right: -10px;
        bottom: -10px;
        background: radial-gradient(
          ellipse at center,
          rgba(20, 20, 20, 0.95) 0%,
          rgba(0, 0, 0, 0.98) 70%,
          rgba(15, 15, 15, 1) 100%
        );
        border-radius: 12px;
        z-index: 0;
        pointer-events: none;
      `;

      const player = post.querySelector("shreddit-player");
      if (player && player.parentElement) {
        player.parentElement.style.position = "relative";
        player.parentElement.style.zIndex = "1";
        player.parentElement.insertBefore(bgContainer, player);
        log("🖼️ Dark background added", "success");
      }
    }

    // Style the post container
    post.style.background = "transparent";
    post.style.padding = "10px 0";

    log(`✨ Video enhanced with ${CONFIG.VIDEO_SCALE}x scale`, "success");
  }

  function removeVideoStyling(post) {
    if (!post) return;

    // Remove background
    post.querySelectorAll(".reddit-video-bg").forEach((el) => el.remove());

    // Reset player styles
    const shredditPlayer = post.querySelector("shreddit-player");
    if (shredditPlayer) {
      shredditPlayer.style.cssText = "";

      // Clean up shadow root tracking
      if (shredditPlayer.shadowRoot) {
        injectedShadowRoots.delete(shredditPlayer.shadowRoot);
      }
    }

    // Reset post styles
    post.style.background = "";
    post.style.padding = "";
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

    // State logging
    const logState = (eventName) => {
      console.log(
        `%c[Reddit Video State] ${eventName.padEnd(12)} | ` +
          `paused:${video.paused} | muted:${video.muted} | volume:${video.volume.toFixed(2)} | ` +
          `readyState:${video.readyState} | currentTime:${video.currentTime.toFixed(1)}s | src: ${videoId}`,
        "color:#00B0FF; font-weight:bold",
      );
    };

    // Event handlers
    const eventsToLog = [
      "play",
      "playing",
      "pause",
      "ended",
      "canplay",
      "error",
    ];

    eventsToLog.forEach((eventName) => {
      video.addEventListener(
        eventName,
        () => {
          logState(eventName.toUpperCase());

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
        },
        { once: eventName === "ended" },
      );
    });

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
    if (!post) {
      log("❌ No post provided", "error");
      return;
    }

    const player = post.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;

    if (!video) {
      log("❌ No video found in post", "error");
      return;
    }

    // Respect manual pause unless it's auto-next or arrow navigation
    if (video._redditUserPaused && !isAutoNext) {
      log("⏸️ Skipping auto-play - user manually paused this video", "warning");
      return;
    }

    cleanupPreviousPlayer();

    // Pause all other videos
    document.querySelectorAll("video").forEach((v) => {
      if (v !== video) v.pause();
    });

    // CRITICAL: Apply styling BEFORE marking as current
    applyVideoStyling(post, video);

    // Mark as current playing
    currentPlayingPost = post;
    currentPlayingVideo = video;
    post.setAttribute("data-currently-playing", "true");

    const postId = post.getAttribute("post-id") || "unknown";
    log(`▶️ Now playing: Post ${postId}`, "success");

    // Auto-next on ended
    if (video._redditAutoEnded) {
      video.removeEventListener("ended", video._redditAutoEnded);
    }

    video._redditAutoEnded = async () => {
      if (!isEnabled) return;
      log("🎬 Video ended - finding next", "info");

      const next = getNextVideoPost(post);
      if (next) {
        log("⏭️ Auto-advancing to next video", "info");
        smoothScrollToPost(next);
        const nextVideo = await waitForVideoInPost(next);
        if (nextVideo) {
          playVideoInPost(next, true);
        }
      } else {
        log("🏁 No more videos to play", "info");
      }
    };

    video.addEventListener("ended", video._redditAutoEnded, { once: true });

    // Setup volume management
    applyUnmuteAndVolume(video);

    // Play video
    try {
      await video.play();
      log("✅ Playback started successfully", "success");
    } catch (err) {
      log(`❌ Play failed: ${err.message}`, "error");

      // Create click-to-play overlay if autoplay blocked
      if (err.name === "NotAllowedError") {
        createPlayOverlay(video);
      }
    }
  }

  function createPlayOverlay(video) {
    // Remove existing overlays
    const parent = video.parentElement || video.closest("div");
    if (!parent) return;

    parent
      .querySelectorAll(".reddit-play-overlay")
      .forEach((el) => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "reddit-play-overlay";
    overlay.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 15px 25px;
      border-radius: 8px;
      cursor: pointer;
      z-index: 9999;
      font-family: system-ui, sans-serif;
      font-size: 16px;
      font-weight: 600;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
      border: 2px solid rgba(255, 69, 0, 0.6);
      transition: all 0.2s ease;
    `;
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

    parent.appendChild(overlay);
    log("🔧 Play overlay created", "warning");
  }

  function cleanupPreviousPlayer() {
    if (!currentPlayingPost) return;

    log("🧹 Cleaning up previous player", "info");

    // Remove visual enhancements
    removeVideoStyling(currentPlayingPost);

    // Cleanup event listeners
    const player = currentPlayingPost.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;

    if (video && video._redditAutoEnded) {
      video.removeEventListener("ended", video._redditAutoEnded);
      delete video._redditAutoEnded;
    }

    // Remove playing attribute
    currentPlayingPost.removeAttribute("data-currently-playing");

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

      // Don't intercept when typing in inputs
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
        log("➡️ Right Arrow - Next video", "info");
      } else if (e.key === "ArrowLeft") {
        targetPost = currentPlayingPost
          ? getPreviousVideoPost(currentPlayingPost)
          : getVideoPosts()[0];
        isAutoNext = true;
        log("⬅️ Left Arrow - Previous video", "info");
      }

      if (targetPost) {
        e.preventDefault(); // Prevent page scroll
        smoothScrollToPost(targetPost);
        const video = await waitForVideoInPost(targetPost);
        if (video) {
          setTimeout(() => {
            playVideoInPost(targetPost, isAutoNext);
          }, 400); // Small delay after scroll
        }
      }
    });

    log("⌨️ Keyboard navigation (← → arrows) enabled", "success");
  }

  // ==================== MUTATION OBSERVER ====================
  function setupMutationObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect();
    }

    mutationObserver = new MutationObserver((mutations) => {
      if (!isEnabled) return;

      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;

        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          // Check if the node itself is a post
          const newPosts = node.matches?.("shreddit-post") ? [node] : [];
          // Also check for nested posts
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

      post.style.cursor = "pointer";
      post.setAttribute("data-has-video", "true");

      post.addEventListener("click", (e) => {
        // Don't intercept clicks on links, buttons, etc.
        if (
          e.target.closest("a, button, shreddit-vote-button, faceplate-number")
        ) {
          return;
        }

        if (!isEnabled) return;

        log("🖱️ User clicked on video post", "info");
        smoothScrollToPost(post);
        setTimeout(() => playVideoInPost(post), 300);
      });

      post._redditClickListenerAdded = true;
    });
  }

  function startAutoPlay() {
    log("=== Starting Auto-Play Sequence ===", "info");

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

    log(
      `Found ${posts.length} video posts, starting with first visible`,
      "info",
    );

    smoothScrollToPost(startPost);
    setTimeout(() => {
      if (isEnabled) {
        playVideoInPost(startPost);
      }
    }, 800);
  }

  // ==================== UI CREATION ====================
  function createUI() {
    log("🎨 Creating UI panel", "info");

    const container = document.createElement("div");
    container.id = "reddit-auto-player-panel";
    container.style.cssText = `
      position: fixed;
      top: ${CONFIG.PANEL_TOP_OFFSET}px;
      right: 20px;
      z-index: 2147483647;
      background: rgba(255, 69, 0, 0.95);
      color: white;
      padding: 12px 16px;
      border-radius: 12px;
      box-shadow: 0 8px 25px rgba(255, 69, 0, 0.4);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      transition: top 0.3s ease;
      user-select: none;
      cursor: move;
    `;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.id = "reddit-auto-player-toggle";
    checkbox.style.cssText = `
      width: 18px;
      height: 18px;
      accent-color: #fff;
      cursor: pointer;
      flex-shrink: 0;
    `;

    const label = document.createElement("label");
    label.textContent = "Auto-play videos + scroll (← → arrows)";
    label.id = "reddit-auto-player-label";
    label.htmlFor = "reddit-auto-player-toggle";
    label.style.cssText = `
      cursor: pointer;
      font-weight: 600;
      user-select: none;
      white-space: nowrap;
    `;

    container.append(checkbox, label);
    document.body.appendChild(container);

    log("✅ UI panel created and added to page", "success");

    // Toggle functionality
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
      // Don't drag when clicking the checkbox
      if (e.target.tagName === "INPUT") return;

      isDragging = true;
      startY = e.clientY;
      startTop = element.getBoundingClientRect().top;
      element.style.transition = "none";
      element.style.opacity = "0.9";
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
        element.style.transition = "top 0.3s ease";
        element.style.opacity = "1";
        log(`📍 Panel positioned at ${element.style.top}`, "info");
      }
    });
  }

  // ==================== INITIALIZATION ====================
  function init() {
    log("🚀 Reddit Auto Video Player v8.1 Initializing", "info");
    log("=========================================", "info");

    // Load saved preferences
    loadSavedVolumes();

    // Create UI
    createUI();

    // Enable auto-play
    isEnabled = true;

    log("Features active:", "success");
    log("  ✓ Volume persistence across videos", "info");
    log(`  ✓ Video scaling (${CONFIG.VIDEO_SCALE}x)`, "info");
    log("  ✓ Shadow DOM injection for guaranteed styling", "info");
    log("  ✓ Dark contrasting background", "info");
    log("  ✓ Current playing post tracking", "info");
    log(
      `  ✓ Floating panel at ${CONFIG.PANEL_TOP_OFFSET}px (draggable)`,
      "info",
    );
    log("  ✓ Arrow key navigation (← →)", "info");
    log("  ✓ Auto-advance on video end", "info");

    // Delayed start to ensure page is fully loaded
    setTimeout(() => {
      log("⏰ Starting auto-play sequence...", "info");
      startAutoPlay();
      setupMutationObserver();
      setupKeyboardNavigation();
      addClickListenersToPosts();
    }, 1600);
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    log("👋 Page unloading - cleaning up", "info");
    cleanupPreviousPlayer();
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    saveVolumes();
  });

  log("📦 Extension script loaded and ready", "success");
})();
