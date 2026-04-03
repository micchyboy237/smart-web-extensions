// content.js - Reddit Auto Video Player (v7.2 - Auto-Next with Auto-Play)

const DEFAULT_VOLUME = 0.2;

(function () {
  "use strict";

  let isEnabled = false;
  let currentPlayingPost = null;
  let mutationObserver = null;

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

  // ==================== UNMUTE + VOLUME HELPER ====================
  function applyUnmuteAndVolume(video, isNewVideo = false) {
    if (!video) return;

    const videoId = video.src
      ? video.src.split("/").pop().slice(0, 20) + "..."
      : "unknown";

    if (video._redditUserPaused === undefined) {
      video._redditUserPaused = false;
    }

    const logState = (eventName) => {
      console.log(
        `%c[Reddit Video State] ${eventName.padEnd(12)} | ` +
          `paused:${video.paused} | muted:${video.muted} | volume:${video.volume.toFixed(2)} | ` +
          `readyState:${video.readyState} | currentTime:${video.currentTime.toFixed(1)}s | src: ${videoId}`,
        "color:#00B0FF; font-weight:bold",
      );
    };

    const unmuteAndSetVolume = () => {
      if (video._redditUserPaused) return;

      video.muted = false;
      video.volume = DEFAULT_VOLUME;
      log(`🔊 Unmuted + volume set to ${DEFAULT_VOLUME}`, "success");
    };

    const eventsToLog = [
      "play",
      "playing",
      "pause",
      "ended",
      "volumechange",
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
            log("⏸️ User manually paused - respecting pause", "warning");
          }

          if (eventName === "play" || eventName === "playing") {
            video._redditUserPaused = false;
          }

          if (
            ["play", "playing", "canplay"].includes(eventName) &&
            !video._redditUserPaused
          ) {
            setTimeout(unmuteAndSetVolume, 10);
          }
        },
        { once: eventName === "ended" },
      );
    });

    video.muted = true;
    video.volume = DEFAULT_VOLUME;
    setTimeout(unmuteAndSetVolume, 100);
  }

  // ==================== MAIN PLAY FUNCTION ====================
  async function playVideoInPost(post, isAutoNext = false) {
    if (!post) return;

    const player = post.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;
    if (!video) return;

    // Respect manual pause (except for auto-next chain)
    if (video._redditUserPaused && !isAutoNext) {
      log("⏸️ Skipping auto-play - user manually paused this video", "warning");
      return;
    }

    cleanupPreviousPlayer();

    // Pause all other videos
    document.querySelectorAll("video").forEach((v) => {
      if (v !== video) v.pause();
    });

    currentPlayingPost = post;

    log(
      `▶️ Now playing: ${post.getAttribute("post-id") || "video post"}`,
      "success",
    );

    // Setup auto-next on ended
    if (video._redditAutoEnded)
      video.removeEventListener("ended", video._redditAutoEnded);

    video._redditAutoEnded = async () => {
      if (!isEnabled) return;
      const next = getNextVideoPost(post);
      if (next) {
        log("⏭️ Video ended - scrolling to next", "info");
        smoothScrollToPost(next);

        const nextVideo = await waitForVideoInPost(next);
        if (nextVideo) {
          // Pass isAutoNext = true so it forces play even if previously paused
          playVideoInPost(next, true);
        }
      }
    };

    video.addEventListener("ended", video._redditAutoEnded, { once: true });

    applyUnmuteAndVolume(video);

    try {
      await video.play();
      log("✅ Playback started", "success");
    } catch (err) {
      log(`❌ Play failed: ${err.message}`, "error");
    }
  }

  function cleanupPreviousPlayer() {
    if (!currentPlayingPost) return;
    const player = currentPlayingPost.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;
    if (video && video._redditAutoEnded) {
      video.removeEventListener("ended", video._redditAutoEnded);
      delete video._redditAutoEnded;
    }
  }

  function stopAutoPlay() {
    cleanupPreviousPlayer();
    currentPlayingPost = null;
    document.querySelectorAll("video").forEach((v) => v.pause());
  }

  // ==================== MUTATION OBSERVER (No aggressive auto-play) ====================
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
    log("🆕 New video post detected", "info");

    applyUnmuteAndVolume(video, true);

    if (!post._redditClickListenerAdded) {
      addClickListenersToPosts();
    }
  }

  function scanForAllVideos() {
    if (!isEnabled) return;
    getVideoPosts().forEach((post) => processNewPost(post));
  }

  // Click handler (user-initiated play)
  function addClickListenersToPosts() {
    getVideoPosts().forEach((post) => {
      if (post._redditClickListenerAdded) return;

      post.style.cursor = "pointer";

      post.addEventListener("click", (e) => {
        const ignored = e.target.closest(
          "a, button, shreddit-vote-button, faceplate-number",
        );
        if (ignored) return;

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
    if (posts.length === 0) return;

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

  // ==================== UI ====================
  function createUI() {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      zIndex: "2147483647",
      background: "rgba(255,69,0,0.95)",
      color: "white",
      padding: "12px 16px",
      borderRadius: "12px",
      boxShadow: "0 8px 25px rgba(255,69,0,0.4)",
      fontFamily: "system-ui, sans-serif",
      fontSize: "14px",
      display: "flex",
      alignItems: "center",
      gap: "10px",
      backdropFilter: "blur(10px)",
    });

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    Object.assign(checkbox.style, {
      width: "18px",
      height: "18px",
      accentColor: "#fff",
    });

    const label = document.createElement("label");
    label.textContent = "Auto-play videos + scroll";
    label.style.cursor = "pointer";
    label.style.fontWeight = "600";

    container.append(checkbox, label);
    document.body.appendChild(container);

    checkbox.addEventListener("change", () => {
      isEnabled = checkbox.checked;
      log(
        `Auto-play ${isEnabled ? "ENABLED" : "DISABLED"}`,
        isEnabled ? "success" : "warning",
      );

      if (isEnabled) {
        startAutoPlay();
        setupMutationObserver();
        setTimeout(addClickListenersToPosts, 1000);
      } else {
        stopAutoPlay();
        if (mutationObserver) mutationObserver.disconnect();
      }
    });

    return checkbox;
  }

  function init() {
    createUI();
    isEnabled = true;
    log("Extension loaded (v7.2 - Auto-Next with Auto-Play)", "success");

    setTimeout(() => {
      startAutoPlay();
      setupMutationObserver();
      addClickListenersToPosts();
    }, 1600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
