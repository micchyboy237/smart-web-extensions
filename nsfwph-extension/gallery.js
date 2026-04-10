// gallery.js

const GALLERY_ID = "video-gallery-modal";

function createGalleryModal() {
  let modal = document.getElementById(GALLERY_ID);
  if (modal) return modal;

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

  modal.querySelector(".gallery-close").onclick = () => modal.remove();
  modal.querySelector(".gallery-overlay").onclick = () => modal.remove();

  return modal;
}

function extractFrame(videoSrc, time) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.src = videoSrc;
    video.muted = true;
    // video.crossOrigin = "anonymous"; // Removed for fallback logic
    video.preload = "auto";

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    video.addEventListener("loadedmetadata", () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      video.currentTime = time;
    });

    video.addEventListener("seeked", () => {
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/jpeg");
        // If CORS blocked, this will fail or return empty
        if (!data || data.length < 1000) throw new Error("Canvas tainted");

        const img = document.createElement("img");
        img.src = data;
        img.className = "gallery-image";
        resolve(img);
      } catch (e) {
        // 🔥 Fallback to video preview
        const fallback = document.createElement("video");
        fallback.src =
          videoSrc + (videoSrc.includes("?") ? "&" : "?") + `t=${time}`;
        fallback.muted = true;
        fallback.preload = "auto";
        fallback.className = "gallery-video";

        fallback.addEventListener(
          "loadeddata",
          () => {
            fallback.currentTime = time;
            fallback
              .play()
              .then(() => {
                setTimeout(() => fallback.pause(), 200);
              })
              .catch(() => {});
          },
          { once: true },
        );

        resolve(fallback);
      }
    });
  });
}

function openGallery(entry) {
  const modal = createGalleryModal();
  const grid = modal.querySelector(".gallery-grid");
  grid.innerHTML = "";

  const src = entry.element.currentSrc || entry.element.src;
  if (!src) return;

  const duration = entry.element.duration;
  if (!duration || isNaN(duration)) return;

  const MAX = 6;
  const times = [];

  for (let i = 0; i < MAX; i++) {
    const t = ((i + 1) / (MAX + 1)) * duration;
    times.push(t);
  }

  // Sequential extraction (more stable)
  (async () => {
    for (const t of times) {
      const img = await extractFrame(src, t);
      if (img) grid.appendChild(img);
    }
  })();
}
