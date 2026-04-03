// content.js - Reddit Auto Video Player (v5 - Aggressive Unmute on Play)

const DEFAULT_VOLUME = 0.3; // You can change this (0.2 ~ 0.5 recommended)

(function () {
  "use strict";

  let isEnabled = false;
  let currentPlayingPost = null;

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

  // ==================== MAIN PLAY FUNCTION ====================
  async function playVideoInPost(post) {
    const player = post.querySelector("shreddit-player");
    const video = player ? getVideoFromPlayer(player) : null;
    if (!video) return;

    currentPlayingPost = post;

    // Pause all others
    document.querySelectorAll("video").forEach((v) => {
      if (v !== video) v.pause();
    });

    log("▶️ Starting playback for post", "success");

    // Clean previous ended listener
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

    // === Aggressive unmute strategy ===
    const unmuteAndSetVolume = () => {
      if (video.muted || video.volume !== DEFAULT_VOLUME) {
        video.muted = false;
        video.volume = DEFAULT_VOLUME;
        log(
          `🔊 Successfully unmuted + set volume to ${DEFAULT_VOLUME}`,
          "success",
        );
      }
    };

    // Try to unmute on every possible event that fires after playback starts
    video.addEventListener("play", unmuteAndSetVolume, { once: true });
    video.addEventListener("playing", unmuteAndSetVolume, { once: true });
    video.addEventListener("volumechange", unmuteAndSetVolume);
    video.addEventListener("canplay", unmuteAndSetVolume, { once: true });

    // Force start muted (this is required for autoplay to succeed)
    video.muted = true;
    video.volume = DEFAULT_VOLUME;
    video.currentTime = 0;

    try {
      await video.play();
      log("✅ play() started (initially muted)", "success");
      // Immediate unmute attempt right after play() succeeds
      setTimeout(unmuteAndSetVolume, 50);
      setTimeout(unmuteAndSetVolume, 300);
      setTimeout(unmuteAndSetVolume, 800);
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

  // UI + Keyboard (kept simple)
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
      if (isEnabled) startAutoPlay();
      else stopAutoPlay();
    });

    return checkbox;
  }

  function init() {
    const checkbox = createUI();
    isEnabled = true;

    log("Extension loaded (v5 - Aggressive unmute)", "success");

    // Give Reddit time to load videos
    setTimeout(startAutoPlay, 1600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
