// gallery.js
const GALLERY_ID = "video-gallery-modal";

/**
 * Format seconds to mm:ss display string.
 */
function formatMMSS(totalSeconds) {
  if (!isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function createGalleryModal() {
  let modal = document.getElementById(GALLERY_ID);
  if (modal) {
    cleanupGallery(modal);
    return modal;
  }

  modal = document.createElement("div");
  modal.id = GALLERY_ID;
  modal.innerHTML = `
        <div class="gallery-overlay"></div>
        <div class="gallery-content">
            <button class="gallery-close">✕</button>
            <div class="gallery-grid"></div>
        </div>
    `;
  document.body.appendChild(modal);

  const closeBtn = modal.querySelector(".gallery-close");
  const overlay = modal.querySelector(".gallery-overlay");

  const closeModal = () => {
    cleanupGallery(modal);
    modal.remove();
  };

  closeBtn.onclick = closeModal;
  overlay.onclick = closeModal;

  const escHandler = (e) => {
    if (e.key === "Escape") closeModal();
  };
  document.addEventListener("keydown", escHandler, { once: true });
  modal._escHandler = escHandler;

  console.log("[Gallery] Modal created");
  return modal;
}

/**
 * Main cleanup function - revokes all media resources and clears priority.
 */
function cleanupGallery(modal) {
  const grid = modal.querySelector(".gallery-grid");
  if (!grid) return;

  // 🔧 NEW: Clear gallery priority and perform proper cleanup via PriorityManager
  if (window.BoostEngine?.PriorityManager) {
    window.BoostEngine.PriorityManager.clearGalleryPriority();
  }

  // Fallback cleanup for any remaining videos
  const wrappers = Array.from(grid.querySelectorAll(".gallery-item-wrapper"));
  console.log(
    `[Gallery] 🧹 Fallback cleaning up ${wrappers.length} gallery items`,
  );

  wrappers.forEach((wrapper) => {
    const video = wrapper.querySelector("video");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    wrapper.remove();
  });

  grid.innerHTML = "";

  if (modal._escHandler) {
    document.removeEventListener("keydown", modal._escHandler);
    delete modal._escHandler;
  }

  console.log("[Gallery] Cleanup complete");
}

/**
 * Create a gallery item using a native <video> element to avoid CORS issues.
 * Instead of extracting to canvas, we let the browser render the video frame.
 *
 * @param {string} videoSrc - The video source URL
 * @param {number} time - Time in seconds to show
 * @returns {HTMLElement} - The wrapper div with video + time label
 */
function createGalleryVideoItem(videoSrc, time) {
  const wrapper = document.createElement("div");
  wrapper.className = "gallery-item-wrapper";

  const video = document.createElement("video");
  video.src = videoSrc;
  video.muted = true;
  video.preload = "metadata"; // Will be upgraded to "auto" by PriorityManager
  video.className = "gallery-media";
  video.playsInline = true;
  video.controls = false;

  // Seek to the specific frame once metadata is loaded
  const seekToFrame = () => {
    try {
      video.currentTime = time;
    } catch (e) {
      console.warn("[Gallery] Seek failed:", e);
    }
  };

  if (video.readyState >= 1) {
    seekToFrame();
  } else {
    video.addEventListener("loadedmetadata", seekToFrame, { once: true });
  }

  // Play briefly to render the frame, then pause to save bandwidth
  video.addEventListener(
    "seeked",
    () => {
      video
        .play()
        .then(() => {
          setTimeout(() => {
            if (!video.paused) video.pause();
          }, 150);
        })
        .catch(() => {
          // Autoplay might be blocked, which is fine for a thumbnail
        });
    },
    { once: true },
  );

  wrapper.appendChild(video);

  const timeLabel = document.createElement("span");
  timeLabel.className = "gallery-time-label";
  timeLabel.textContent = formatMMSS(time);
  wrapper.appendChild(timeLabel);

  return wrapper;
}

/**
 * Open the gallery modal for a video entry.
 */
function openGallery(entry) {
  console.log("[Gallery] 📂 Opening gallery");
  const modal = createGalleryModal();
  const grid = modal.querySelector(".gallery-grid");
  grid.innerHTML = "";

  const src = entry.element.currentSrc || entry.element.src;
  if (!src) {
    console.warn("[Gallery] ⚠️ No video source found");
    return;
  }

  const duration = entry.element.duration;
  if (!duration || isNaN(duration) || duration < 1) {
    console.warn("[Gallery] ⚠️ Invalid duration:", duration);
    return;
  }

  const MAX = calcFrameCount(duration);
  const times = Array.from(
    { length: MAX },
    (_, i) => ((i + 1) / (MAX + 1)) * duration,
  );

  console.log(
    `[Gallery] 🎬 Creating ${MAX} video items for ${formatMMSS(duration)} video | ` +
      `Times: ${times.map((t) => formatMMSS(t)).join(", ")}`,
  );

  const galleryVideos = [];

  // Sequential creation to avoid overwhelming the DOM
  (async () => {
    for (const t of times) {
      const wrapper = createGalleryVideoItem(src, t);
      grid.appendChild(wrapper);
      galleryVideos.push(wrapper.querySelector("video"));
    }

    console.log(
      `[Gallery] ✅ Gallery complete: ${galleryVideos.length} video items created`,
    );

    // 🔧 NEW: Apply priority to download gallery videos
    if (window.BoostEngine?.PriorityManager) {
      window.BoostEngine.PriorityManager.setGalleryPriority(galleryVideos);
    } else {
      console.warn(
        "[Gallery] ⚠️ PriorityManager not available, gallery videos will use default preload",
      );
    }
  })();
}

/**
 * Calculate the number of frames to extract for a video based on its duration.
 */
function calcFrameCount(duration) {
  if (!duration || !isFinite(duration) || duration < 1) {
    console.warn(
      `[Gallery] calcFrameCount: invalid duration (${duration}), defaulting to 3`,
    );
    return 3;
  }
  const count = Math.min(
    12,
    Math.max(3, Math.round(Math.log2(duration / 10 + 1) * 3)),
  );
  console.log(
    `[Gallery] calcFrameCount: ${formatMMSS(duration)} → ${count} frames`,
  );
  return count;
}
