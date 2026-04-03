// content.js - Reddit Auto Video Player (v7 - Click to Play + Listener Management)

const DEFAULT_VOLUME = 0.2; // Change as needed (0.2–0.5 recommended)

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
        const video = player ? getVideoFromPlayer(player) : null;
        return video;
      },
    );
  }

  function getVideos() {
    // Returns all <video> elements from all video posts currently available
    return getVideoPosts()
      .map((post) => {
        const player = post.querySelector("shreddit-player");
        return player || null;
      })
      .filter(Boolean); // Remove nulls
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

    const logState = (eventName) => {
      console.log(
        `%c[Reddit Video State] ${eventName.padEnd(12)} | ` +
          `paused:${video.paused} | ` +
          `muted:${video.muted} | ` +
          `volume:${video.volume.toFixed(2)} | ` +
          `readyState:${video.readyState} | ` +
          `currentTime:${video.currentTime.toFixed(1)}s | ` +
          `src: ${videoId}`,
        "color:#00B0FF; font-weight:bold",
      );
    };

    const unmuteAndSetVolume = () => {
      const wasMuted = video.muted;
      const oldVolume = video.volume;

      video.muted = false;
      video.volume = DEFAULT_VOLUME;

      if (wasMuted || oldVolume !== DEFAULT_VOLUME) {
        log(
          `🔊 Unmuted + set volume to ${DEFAULT_VOLUME} (${isNewVideo ? "NEW video" : "existing"})`,
          "success",
        );
        logState("UNMUTE_APPLIED");
      }
    };

    const eventsToLog = [
      "play",
      "playing",
      "pause",
      "ended",
      "volumechange",
      "canplay",
      "canplaythrough",
      "loadedmetadata",
      "waiting",
      "seeking",
      "seeked",
      "timeupdate",
      "error",
    ];

    eventsToLog.forEach((eventName) => {
      video.addEventListener(
        eventName,
        () => {
          logState(eventName.toUpperCase());
          if (["play", "playing", "canplay"].includes(eventName)) {
            setTimeout(unmuteAndSetVolume, 10);
          }
        },
        { once: eventName === "ended" },
      );
    });

    // Aggressive unmute attempts
    video.muted = true;
    video.volume = DEFAULT_VOLUME;
    setTimeout(unmuteAndSetVolume, 50);
    setTimeout(unmuteAndSetVolume, 200);
    setTimeout(unmuteAndSetVolume, 600);
  }

  // ==================== CLEAN LISTENERS FROM PREVIOUS PLAYER ====================
  function cleanupPreviousPlayer() {
    if (!currentPlayingPost) return;

    const player = currentPlayingPost.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;

    if (video && video._redditAutoEnded) {
      video.removeEventListener("ended", video._redditAutoEnded);
      delete video._redditAutoEnded;
    }
  }

  // ==================== MAIN PLAY FUNCTION ====================
  async function playVideoInPost(post) {
    if (!post) return;

    const player = post.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;
    if (!video) return;

    // Cleanup previous player’s listeners
    cleanupPreviousPlayer();

    // Pause all other videos
    document.querySelectorAll("video").forEach((v) => {
      if (v !== video) v.pause();
    });

    currentPlayingPost = post;

    log(
      `▶️ Now playing: ${post.getAttribute("post-id") || "clicked post"}`,
      "success",
    );

    // Set up auto-next on ended
    video._redditAutoEnded = async () => {
      if (!isEnabled) return;
      const next = getNextVideoPost(post);
      if (next) {
        smoothScrollToPost(next);
        const nextVideo = await waitForVideoInPost(next);
        if (nextVideo) playVideoInPost(next);
      }
    };

    video.addEventListener("ended", video._redditAutoEnded, { once: true });

    // Apply unmute + volume control
    applyUnmuteAndVolume(video);

    try {
      await video.play();
      log("✅ Playback started", "success");
    } catch (err) {
      log(`❌ Play failed: ${err.message}`, "error");
    }
  }

  function startAutoPlay() {
    log("=== Starting Auto-Play Sequence ===", "info");

    const posts = getVideoPosts();
    if (posts.length === 0) {
      log("No videos found on page", "warning");
      return;
    }

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

  function stopAutoPlay() {
    cleanupPreviousPlayer();
    currentPlayingPost = null;
    document.querySelectorAll("video").forEach((v) => v.pause());
  }

  // ==================== CLICK HANDLER FOR ALL POSTS ====================
  function addClickListenersToPosts() {
    const posts = getVideoPosts();

    posts.forEach((post) => {
      // Avoid adding duplicate listeners
      if (post._redditClickListenerAdded) return;

      post.style.cursor = "pointer"; // Visual feedback

      post.addEventListener("click", (e) => {
        // Ignore clicks on interactive elements like upvote, comments, etc.
        const ignoredTags = [
          "A",
          "BUTTON",
          "SHREDDIT-VOTE-BUTTON",
          "FACEPLATE-NUMBER",
        ];
        if (
          ignoredTags.includes(e.target.tagName) ||
          e.target.closest("shreddit-vote-button, faceplate-number, a")
        ) {
          return;
        }

        if (!isEnabled) return;

        log("🖱️ User clicked on a video post", "info");
        smoothScrollToPost(post);
        setTimeout(() => playVideoInPost(post), 300);
      });

      post._redditClickListenerAdded = true;
    });
  }

  // ==================== IMPROVED MUTATION OBSERVER ====================
  function setupMutationObserver() {
    if (mutationObserver) mutationObserver.disconnect();

    mutationObserver = new MutationObserver((mutations) => {
      if (!isEnabled) return;

      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;

        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          // Find all shreddit-post (new or in subtree)
          const newPosts = [];
          if (node.matches?.("shreddit-post")) newPosts.push(node);
          newPosts.push(
            ...Array.from(node.querySelectorAll?.("shreddit-post") || []),
          );

          for (const post of newPosts) {
            processNewPost(post);
          }
        });
      }
    });

    mutationObserver.observe(document.documentElement, {
      // Better root: documentElement
      childList: true,
      subtree: true,
    });

    log(
      "🔍 Improved MutationObserver active (watching documentElement)",
      "success",
    );

    // Also run once immediately and after a delay to catch already-loaded or late-initialized videos
    setTimeout(scanForAllVideos, 800);
    setTimeout(scanForAllVideos, 2500);
  }

  // ==================== PROCESS A NEW/EXISTING POST ====================
  function processNewPost(post) {
    if (!post || post._redditVideoProcessed) return;

    const player = post.querySelector("shreddit-player");
    if (!player) return;

    let video = getVideoFromPlayer(player);

    // If video not ready yet, wait a bit and retry (common with shadow DOM)
    if (!video || (!video.src && !video.currentSrc)) {
      setTimeout(() => {
        video = getVideoFromPlayer(player);
        if (video) handleNewVideo(post, video);
      }, 400);
      return;
    }

    handleNewVideo(post, video);
  }

  function handleNewVideo(post, video) {
    if (!video) return;

    post._redditVideoProcessed = true; // Prevent duplicate processing

    log("🆕 New video post detected and processed", "info");

    applyUnmuteAndVolume(video, true);

    // Add click listener if needed
    if (!post._redditClickListenerAdded) {
      addClickListenersToPosts();
    }

    // Optional: auto-play if visible
    const rect = post.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.85 && rect.bottom > -100) {
      setTimeout(() => {
        if (isEnabled && (!currentPlayingPost || currentPlayingPost !== post)) {
          playVideoInPost(post);
        }
      }, 600);
    }
  }

  // ==================== FULL PAGE SCAN (backup for late-loaded videos) ====================
  function scanForAllVideos() {
    if (!isEnabled) return;

    const posts = getVideoPosts();
    log(`📡 Scanning page - found ${posts.length} video posts`, "info");

    posts.forEach((post) => {
      const player = post.querySelector("shreddit-player");
      const video = player ? getVideoFromPlayer(player) : null;
      if (video) {
        handleNewVideo(post, video);
      }
    });
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

  function logVideos() {
    const videos = getVideos(); // This uses your existing getVideos()

    log(`📊 Found ${videos.length} video player(s) on the page`, "info");

    if (videos.length === 0) {
      log("No video players detected at this moment.", "warning");
      return;
    }

    videos.forEach((player, index) => {
      const post = player.closest("shreddit-post");
      const video = getVideoFromPlayer(player);

      const postId = post?.getAttribute("post-id") || "unknown";
      const videoSrc = video?.src || video?.currentSrc || "no src";
      const shortSrc =
        videoSrc.length > 60 ? videoSrc.substring(0, 57) + "..." : videoSrc;

      log(
        `Video ${index + 1}/${videos.length} | ` +
          `Post ID: ${postId} | ` +
          `Player: ${player.tagName} | ` +
          `Video readyState: ${video?.readyState || 0} | ` +
          `Paused: ${video?.paused} | ` +
          `Muted: ${video?.muted} | ` +
          `Src: ${shortSrc}`,
        "info",
      );

      // Extra detailed log for the actual <video> element
      if (video) {
        console.groupCollapsed(
          `%c[Reddit Auto Video] Detailed Video Info #${index + 1}`,
          "color:#FF4500; font-weight:bold",
        );
        console.log("Video Element:", video);
        console.log("Source:", video.src || video.currentSrc);
        console.log("Duration:", video.duration);
        console.log("Current Time:", video.currentTime);
        console.log("Paused:", video.paused);
        console.log("Muted:", video.muted);
        console.log("Volume:", video.volume);
        console.log("Ready State:", video.readyState);
        console.log("Parent Post:", post);
        console.groupEnd();
      }
    });
  }

  function init() {
    const checkbox = createUI();
    isEnabled = true;

    log(
      "Extension loaded (v7 - Click to Play + Listener Management)",
      "success",
    );

    logVideos();

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
