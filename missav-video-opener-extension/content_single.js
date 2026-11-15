// Jet_Apps/web-extensions/smart-web-extensions/missav-video-opener-extension/content_single.js
(function () {
  "use strict";
  const LOG_PREFIX = "[MissAV-Single]";

  function extractVideoMetadata() {
    const url = window.location.href.split("#")[0];

    // 1. Extract Video ID from URL
    const pathMatch = window.location.pathname.match(
      /\/(?:dm\d+\/)?(?:en|ja|zh|ko|th)\/([a-z0-9]+-\d+)/i,
    );
    if (!pathMatch) return null;
    const videoId = pathMatch[1].toLowerCase();

    // 2. Extract Code and Episode
    const codeMatch = videoId.match(/^([a-z0-9]+)-(\d+)/);
    const code = codeMatch ? codeMatch[1] : null;
    const episode = codeMatch ? codeMatch[2] : null;

    // 3. Extract Title
    const h1 = document.querySelector("h1.text-base, h1.lg\\:text-lg");
    const title = h1 ? h1.innerText.trim() : null;

    // 4. Extract Details/Description
    let details = null;
    const detailSelectors = [
      ".order-first .text-secondary.break-all",
      ".mt-4.text-secondary.break-all",
    ];
    for (const sel of detailSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 0) {
        details = el.innerText.trim();
        break;
      }
    }

    // 5. Extract Release Date
    let releaseDate = null;
    const timeEl = document.querySelector(".order-first time[datetime]");
    if (timeEl) {
      releaseDate = timeEl.getAttribute("datetime");
    }

    // 6. Extract Genres
    let genres = [];
    const genreContainers = document.querySelectorAll(".text-secondary");
    for (const container of genreContainers) {
      const span = container.querySelector("span");
      if (span && span.textContent.trim() === "Genre:") {
        const links = container.querySelectorAll("a.font-medium");
        genres = Array.from(links)
          .map((link) => link.textContent.trim())
          .filter((t) => t);
        break;
      }
    }

    // 7. Extract Media URLs
    let thumbnail = null;
    let preview = null;

    // Try Player Poster
    const videoPlayer = document.querySelector("video.player");
    if (videoPlayer) {
      thumbnail =
        videoPlayer.getAttribute("data-poster") ||
        videoPlayer.getAttribute("poster");
    }

    // Fallback Image
    if (!thumbnail) {
      const fallbackImg = document.querySelector(".order-first img");
      if (fallbackImg) {
        thumbnail =
          fallbackImg.getAttribute("src") ||
          fallbackImg.getAttribute("data-src");
      }
    }

    // Generate Preview URL logic (same as smart-extension)
    if (thumbnail) {
      const lastSlashIndex = thumbnail.lastIndexOf("/");
      if (lastSlashIndex !== -1) {
        const baseUrl = thumbnail.substring(0, lastSlashIndex + 1);
        preview = `${baseUrl}preview.mp4`;
      }
    }

    // 8. Generate Stable ID (FNV-1a hash simulation for consistency with smart-extension)
    // For simplicity in this opener, we'll use a deterministic string based on videoId if we don't have the exact hash util
    // But to match the DB, we should ideally use the same hash.
    // Since we can't easily import utils.js here without module changes, we'll send videoId and let the server or background handle ID generation if needed.
    // HOWEVER, the DB expects 'id'. Let's generate a simple consistent ID for now or pass videoId and let the server map it.
    // Actually, the server expects 'id'. Let's use a simple hash implementation.
    const id = generateSimpleId(url, videoId);

    return {
      id,
      url,
      code,
      episode,
      video_id: videoId,
      title,
      thumbnail,
      preview,
      details,
      release_date: releaseDate,
      genres,
    };
  }

  function generateSimpleId(url, videoId) {
    // Simple FNV-1a 32-bit hash to match the Python/Smart Extension logic roughly
    // Note: For perfect consistency, this JS hash must match the JS hash in smart-extension/utils.js
    let hash = 0x811c9dc5;
    const input = url || videoId;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return "jav-" + hash.toString(36);
  }

  // Send data to background when page loads
  window.addEventListener("load", () => {
    setTimeout(() => {
      const metadata = extractVideoMetadata();
      if (metadata && metadata.title) {
        console.log(
          `${LOG_PREFIX} Extracted metadata for ${metadata.video_id}`,
        );
        chrome.runtime.sendMessage({
          action: "ingestSingleVideo",
          data: metadata,
        });
      }
    }, 1000); // Wait for dynamic content to settle
  });
})();
