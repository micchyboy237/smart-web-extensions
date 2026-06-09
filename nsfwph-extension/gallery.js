// gallery.js
const GALLERY_ID = "video-gallery-modal";

/**
 * Format seconds to mm:ss display string.
 * Examples: 0 → "0:00", 65 → "1:05", 3661 → "61:01"
 * @param {number} totalSeconds
 * @returns {string}
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
    // Reuse existing modal but make sure grid is cleared
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
  // Also support Escape key
  const escHandler = (e) => {
    if (e.key === "Escape") closeModal();
  };
  document.addEventListener("keydown", escHandler, { once: true });
  // Store handler so we can remove it later if needed
  modal._escHandler = escHandler;
  console.log("[Gallery] Modal created");
  return modal;
}

/** Main cleanup function - revokes all media resources */
function cleanupGallery(modal) {
  const grid = modal.querySelector(".gallery-grid");
  if (!grid) return;
  // Remove all children and revoke any resources
  const wrappers = Array.from(grid.querySelectorAll(".gallery-item-wrapper"));
  console.log(`[Gallery] 🧹 Cleaning up ${wrappers.length} gallery items`);
  wrappers.forEach((wrapper) => {
    const media = wrapper.querySelector("video, img");
    if (media instanceof HTMLVideoElement) {
      media.pause();
      media.src = ""; // Important: break reference to video data
      media.load(); // Forces release of decoded frames
    }
    if (media instanceof HTMLImageElement && media.src.startsWith("data:")) {
      media.src = ""; // Free base64 data URL
    }
    wrapper.remove();
  });
  // Also remove any leftover children (safety)
  Array.from(grid.children).forEach((child) => {
    grid.removeChild(child);
  });
  grid.innerHTML = "";
  // Remove escape handler
  if (modal._escHandler) {
    document.removeEventListener("keydown", modal._escHandler);
    delete modal._escHandler;
  }
  console.log("[Gallery] Cleanup complete");
}

/**
 * Extract a frame from a video at a specific time.
 * Returns the media element wrapped in a container with time label.
 *
 * @param {string} videoSrc - The video source URL
 * @param {number} time - Time in seconds to capture the frame
 * @returns {Promise<HTMLElement|null>} - The wrapper div with media + time label, or null
 */
function extractFrame(videoSrc, time) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    let resolved = false;
    video.muted = true;
    video.preload = "metadata"; // Better than "auto" for thumbnails
    video.src = videoSrc;

    const cleanupVideo = () => {
      video.pause();
      video.src = "";
      video.load();
      // Remove all listeners to prevent leaks
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };

    /**
     * Creates the wrapper container with media element and time label.
     * @param {HTMLImageElement|HTMLVideoElement} mediaElement
     * @param {number} frameTime
     * @returns {HTMLElement}
     */
    const createWrapper = (mediaElement, frameTime) => {
      const wrapper = document.createElement("div");
      wrapper.className = "gallery-item-wrapper";

      // Add the media element
      mediaElement.classList.add("gallery-media");
      wrapper.appendChild(mediaElement);

      // Add the time label overlay
      const timeLabel = document.createElement("span");
      timeLabel.className = "gallery-time-label";
      timeLabel.textContent = formatMMSS(frameTime);
      wrapper.appendChild(timeLabel);

      console.log(`[Gallery] 🖼️ Frame extracted at ${formatMMSS(frameTime)}`);
      return wrapper;
    };

    const onLoadedMetadata = () => {
      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 180;
      video.currentTime = time;
      console.log(
        `[Gallery] 📐 Metadata loaded for frame at ${formatMMSS(time)} | ` +
          `Dimensions: ${canvas.width}x${canvas.height}`,
      );
    };

    const onSeeked = () => {
      if (resolved) return;
      resolved = true;
      try {
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
        const img = document.createElement("img");
        img.src = dataUrl;
        img.className = "gallery-image";
        img.loading = "lazy";
        cleanupVideo();
        resolve(createWrapper(img, time));
      } catch (e) {
        console.warn(`[Gallery] ⚠️ Canvas extraction failed:`, e.message);
        // Fallback to a mini video element
        cleanupVideo();
        const fallback = document.createElement("video");
        fallback.src = `${videoSrc}${videoSrc.includes("?") ? "&" : "?"}t=${Math.floor(time)}`;
        fallback.muted = true;
        fallback.className = "gallery-video";
        fallback.controls = false;
        fallback.loop = false;
        fallback.preload = "metadata";
        fallback.addEventListener(
          "loadeddata",
          () => {
            fallback.currentTime = time;
            fallback
              .play()
              .then(() => setTimeout(() => fallback.pause(), 150))
              .catch(() => {});
          },
          { once: true },
        );
        resolve(createWrapper(fallback, time));
      }
    };

    const onError = () => {
      if (resolved) return;
      resolved = true;
      console.warn(
        `[Gallery] ❌ Failed to load video for frame at ${formatMMSS(time)}`,
      );
      cleanupVideo();
      resolve(null);
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });

    // Safety timeout in case video hangs
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn(`[Gallery] ⏰ Timeout for frame at ${formatMMSS(time)}`);
        cleanupVideo();
        resolve(null);
      }
    }, 8000);
  });
}

/**
 * Open the gallery modal for a video entry.
 * @param {Object} entry - The video entry object with element, src, duration
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

  const MAX = 6;
  // Calculate evenly spaced time points throughout the video
  const times = Array.from(
    { length: MAX },
    (_, i) => ((i + 1) / (MAX + 1)) * duration,
  );

  console.log(
    `[Gallery] 🎬 Extracting ${MAX} frames from ${formatMMSS(duration)} video | ` +
      `Times: ${times.map((t) => formatMMSS(t)).join(", ")}`,
  );

  // Sequential extraction to avoid overwhelming the browser
  (async () => {
    let successCount = 0;
    for (const t of times) {
      const wrapper = await extractFrame(src, t);
      if (wrapper) {
        grid.appendChild(wrapper);
        successCount++;
      }
    }
    console.log(
      `[Gallery] ✅ Gallery complete: ${successCount}/${MAX} frames extracted`,
    );
  })();
}
