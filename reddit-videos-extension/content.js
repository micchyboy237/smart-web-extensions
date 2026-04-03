// content.js - Reddit Auto Video Player (v6 - MutationObserver + New Videos)

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
        return video && (video.src || video.currentSrc);
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

    // Log initial state
    logState("INITIAL");

    // === Unmute + Volume Logic ===
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

    // Attach comprehensive state listeners
    const eventsToLog = [
      "play",
      "playing",
      "pause",
      "ended",
      "volumechange",
      "mutedchange", // Note: mutedchange is not standard, but safe
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

          // Auto-unmute on key playback events
          if (["play", "playing", "canplay"].includes(eventName)) {
            setTimeout(unmuteAndSetVolume, 10);
          }
        },
        { once: eventName === "ended" },
      ); // ended only once
    });

    // Extra aggressive unmute attempts
    video.muted = true;
    video.volume = DEFAULT_VOLUME;

    setTimeout(unmuteAndSetVolume, 50);
    setTimeout(unmuteAndSetVolume, 200);
    setTimeout(unmuteAndSetVolume, 600);

    // Also listen for any external mute attempts (Reddit often forces mute)
    const originalMutedSetter = Object.getOwnPropertyDescriptor(
      HTMLVideoElement.prototype,
      "muted",
    );
    if (originalMutedSetter) {
      Object.defineProperty(video, "muted", {
        set: function (value) {
          originalMutedSetter.set.call(this, value);
          if (value === true) {
            logState("FORCED_MUTE_DETECTED");
            setTimeout(unmuteAndSetVolume, 30);
          }
        },
        get: originalMutedSetter.get,
      });
    }
  }

  // ==================== MAIN PLAY FUNCTION (for auto-play chain) ====================
  async function playVideoInPost(post) {
    const player = post.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;
    if (!video) return;

    currentPlayingPost = post;

    // Pause others
    document.querySelectorAll("video").forEach((v) => {
      if (v !== video) v.pause();
    });

    log("▶️ Starting playback for post", "success");

    // Clean old ended listener
    if (video._redditAutoEnded) {
      video.removeEventListener("ended", video._redditAutoEnded);
      delete video._redditAutoEnded;
    }

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

    // Apply unmute logic
    applyUnmuteAndVolume(video);

    try {
      await video.play();
      log("✅ play() started", "success");
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
    currentPlayingPost = null;
    document.querySelectorAll("video").forEach((v) => v.pause());
  }

  // ==================== MUTATION OBSERVER FOR NEW VIDEOS ====================
  function setupMutationObserver() {
    if (mutationObserver) mutationObserver.disconnect();

    mutationObserver = new MutationObserver((mutations) => {
      if (!isEnabled) return;

      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            // Check if the added node (or its descendants) contains a new video post
            const posts =
              node.matches && node.matches("shreddit-post")
                ? [node]
                : Array.from(node.querySelectorAll?.("shreddit-post") || []);

            for (const post of posts) {
              const player = post.querySelector("shreddit-player");
              if (!player) continue;

              const video = getVideoFromPlayer(player);
              if (video && (video.src || video.currentSrc)) {
                log("🆕 New video detected via MutationObserver", "info");

                // Apply unmute + volume immediately to the new video
                applyUnmuteAndVolume(video);

                // Optional: auto-play the new video if it's near the viewport
                const rect = post.getBoundingClientRect();
                if (rect.top < window.innerHeight * 0.8 && rect.bottom > 0) {
                  setTimeout(() => {
                    if (isEnabled) playVideoInPost(post);
                  }, 600);
                }
              }
            }
          });
        }
      }
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    log("🔍 MutationObserver active for new videos", "success");
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
      } else {
        stopAutoPlay();
        if (mutationObserver) mutationObserver.disconnect();
      }
    });

    return checkbox;
  }

  function init() {
    const checkbox = createUI();
    isEnabled = true;

    log("Extension loaded (v6 - MutationObserver for new videos)", "success");

    setTimeout(() => {
      startAutoPlay();
      setupMutationObserver();
    }, 1600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
