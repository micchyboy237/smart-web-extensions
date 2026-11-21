// client_paginated2/js/preview.js
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

    // ✅ CRITICAL FIX: Use fetch to bypass Cloudflare Referrer/Hotlink blocking
    try {
      const response = await fetch(previewUrl, {
        method: "GET",
        referrerPolicy: "no-referrer", // Strips Referer header completely
        mode: "cors", // Attempts CORS, but falls back to opaque if blocked
        cache: "no-cache", // Ensures we don't get a stale 403 from browser cache
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      v.src = blobUrl;
      v._blobUrl = blobUrl; // Store for cleanup
    } catch (e) {
      console.warn("Preview fetch failed for", id, e);
      // Fallback: If fetch fails, try standard src with no-referrer attribute
      // This might still fail for snos-349, but it's our last resort.
      v.src = previewUrl;
      v.referrerPolicy = "no-referrer";
      v.crossOrigin = "anonymous";
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

      container
        .querySelectorAll("img[data-preview-media], video[data-preview-media]")
        .forEach((el) => el.remove());

      video.dataset.previewMedia = "1";
      container.prepend(video);

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
    }

    activeId = null;
  }

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
      img.referrerPolicy = "no-referrer"; // Also protect images
      container.prepend(img);
    }
  }

  return { start, stop, restoreMedia };
}
