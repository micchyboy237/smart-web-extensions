// gallery.js
const GALLERY_ID = "video-gallery-modal";

function createGalleryModal() {
  let modal = document.getElementById(GALLERY_ID);
  if (modal) {
    // Reuse existing modal but make sure grid is cleared
    modal.querySelector(".gallery-grid").innerHTML = "";
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
    cleanupGallery(modal); // ← Important
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

  return modal;
}

/** Main cleanup function - this is the key part */
function cleanupGallery(modal) {
  const grid = modal.querySelector(".gallery-grid");
  if (!grid) return;

  // Remove all children and revoke any resources
  Array.from(grid.children).forEach((child) => {
    if (child instanceof HTMLVideoElement) {
      child.pause();
      child.src = ""; // Important: break reference to video data
      child.load(); // Forces release of decoded frames
    }
    if (child instanceof HTMLImageElement && child.src.startsWith("data:")) {
      child.src = ""; // Free base64 data URL
    }
    grid.removeChild(child);
  });

  grid.innerHTML = "";

  // Optional: remove escape handler
  if (modal._escHandler) {
    document.removeEventListener("keydown", modal._escHandler);
    delete modal._escHandler;
  }
}

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

    const onLoadedMetadata = () => {
      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 180;
      video.currentTime = time;
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
        resolve(img);
      } catch (e) {
        // Fallback
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

        resolve(fallback);
      }
    };

    const onError = () => {
      if (resolved) return;
      resolved = true;
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
        cleanupVideo();
        resolve(null);
      }
    }, 8000);
  });
}

function openGallery(entry) {
  const modal = createGalleryModal();
  const grid = modal.querySelector(".gallery-grid");
  grid.innerHTML = "";

  const src = entry.element.currentSrc || entry.element.src;
  if (!src) return;

  const duration = entry.element.duration;
  if (!duration || isNaN(duration) || duration < 1) return;

  const MAX = 6;
  const times = Array.from(
    { length: MAX },
    (_, i) => ((i + 1) / (MAX + 1)) * duration,
  );

  // Sequential + cleanup on modal close
  (async () => {
    for (const t of times) {
      const media = await extractFrame(src, t);
      if (media) {
        grid.appendChild(media);
      }
    }
  })();
}
