// client_paginated2/js/preview.js
// Hover-preview controller.
// - On card mouseenter: swap <img> for <video> (muted, looped) using v.preview.
// - On mouseleave: swap back to thumbnail.
// - Uses a small in-memory cache of <video> elements to avoid re-creating.
// - Adds a 250ms delay so quick mouse sweeps don't fire loads.
// - USES FETCH + BLOB to bypass Cloudflare referrer blocking on .mp4 files.

const cache = new Map(); // id -> HTMLVideoElement
const HOVER_DELAY = 250;

export function createPreviewManager() {
  let hoverTimer = null;
  let activeId = null;

  async function getOrCreateVideo(id, previewUrl) {
    if (cache.has(id)) return cache.get(id);

    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = "none";
    v.className =
      "h-full w-full object-cover transition duration-500 group-hover:scale-110";

    // ✅ Fetch via JS to enforce no-referrer strictly and bypass Cloudflare blocks
    try {
      const response = await fetch(previewUrl, {
        method: "GET",
        referrerPolicy: "no-referrer",
      });

      if (!response.ok)
        throw new Error(`Failed to fetch video: ${response.status}`);

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      v.src = blobUrl;

      // Store the blob URL so we can revoke it later if needed (optional optimization)
      v._blobUrl = blobUrl;
    } catch (e) {
      console.warn("Preview fetch failed for", id, e);
      // Fallback: try setting src directly (might still fail if Cloudflare blocks localhost referer)
      v.src = previewUrl;
      v.referrerPolicy = "no-referrer";
    }

    cache.set(id, v);
    return v;
  }

  function start(id, previewUrl, container) {
    if (!previewUrl || !container) return;
    stop();

    hoverTimer = setTimeout(async () => {
      activeId = id;
      const video = await getOrCreateVideo(id, previewUrl);

      // Remove existing media children (img / video) but keep overlays.
      container
        .querySelectorAll("img[data-preview-media], video[data-preview-media]")
        .forEach((el) => el.remove());

      video.dataset.previewMedia = "1";
      container.prepend(video);

      // Play the video (catch error if user interaction hasn't happened yet, though muted usually allows it)
      video.play().catch(() => {});
    }, HOVER_DELAY);
  }

  function stop() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    if (activeId == null) return;

    const video = cache.get(activeId);
    if (video) {
      video.pause();
      video.currentTime = 0;
      // Optional: Revoke blob URL to free memory if not caching heavily
      // if (video._blobUrl) URL.revokeObjectURL(video._blobUrl);
    }

    // Caller is responsible for restoring the <img>. See restoreMedia().
    activeId = null;
  }

  // Restore the original thumbnail img (Alpine holds it in the x-if).
  function restoreMedia(container, thumbnail, title) {
    if (!container) return;

    container
      .querySelectorAll("video[data-preview-media]")
      .forEach((el) => el.remove());

    if (!container.querySelector("img[data-preview-media]")) {
      const img = document.createElement("img");
      img.src = thumbnail;
      img.alt = title || "";
      img.loading = "lazy";
      img.decoding = "async";
      img.dataset.previewMedia = "1";
      img.className =
        "h-full w-full object-cover transition duration-500 group-hover:scale-110";
      container.prepend(img);
    }
  }

  return { start, stop, restoreMedia };
}
