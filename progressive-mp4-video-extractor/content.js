// content.js - Simple video detector
console.log("[Content] MP4 Extractor v3.1 loaded");

// Find and report all videos
function reportVideos() {
  const videos = document.querySelectorAll("video");
  console.log(`[Content] Found ${videos.length} videos`);

  videos.forEach((video, i) => {
    const src = video.src || video.currentSrc;
    if (src && (src.includes(".mp4") || src.includes(".webm"))) {
      console.log(`[Content] Video ${i}: ${src.substring(0, 80)}...`);

      chrome.runtime
        .sendMessage({
          action: "videoDetected",
          url: src,
          type: "videoElement",
        })
        .catch((e) => console.log("[Content] Background not ready"));
    }
  });
}

// Watch for new videos
const observer = new MutationObserver(() => reportVideos());
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener("DOMContentLoaded", () => {
    observer.observe(document.body, { childList: true, subtree: true });
    reportVideos();
  });
}

reportVideos();

// Respond to pings
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "ping") {
    sendResponse({
      success: true,
      videoCount: document.querySelectorAll("video").length,
    });
  }
  return true;
});

console.log("[Content] Ready - monitoring for videos");
