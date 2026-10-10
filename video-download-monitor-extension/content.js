// content.js

// Track active video elements and their download status
const trackedVideos = new Map();
let observer;

// Initialize MutationObserver to detect new video elements
function initObserver() {
  observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Check if the node itself is a video
          if (node.tagName === "VIDEO") {
            trackVideo(node);
          }
          // Check for videos inside the added node
          const videos = node.querySelectorAll("video");
          videos.forEach(trackVideo);
        }
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Also check existing videos on load
  document.querySelectorAll("video").forEach(trackVideo);
}

// Track a specific video element
function trackVideo(videoElement) {
  if (trackedVideos.has(videoElement)) return;

  const videoId = Math.random().toString(36).substr(2, 9);
  trackedVideos.set(videoElement, videoId);

  // Listen for progress events to monitor buffering/download
  videoElement.addEventListener("progress", () => {
    updateVideoProgress(videoElement, videoId);
  });

  // Initial update
  updateVideoProgress(videoElement, videoId);
}

// Calculate and send progress data to background script
function updateVideoProgress(video, id) {
  if (video.buffered.length > 0) {
    const bufferedEnd = video.buffered.end(video.buffered.length - 1);
    const duration = video.duration || 0;
    const percentLoaded = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

    // Send message to background script
    chrome.runtime
      .sendMessage({
        type: "VIDEO_PROGRESS",
        data: {
          id: id,
          src: video.currentSrc || video.src,
          percent: percentLoaded.toFixed(2),
          bufferedSeconds: bufferedEnd,
          duration: duration,
        },
      })
      .catch(() => {}); // Ignore errors if popup/background not listening
  }
}

// Intercept fetch requests to allow cancellation (Feature 2)
// Note: This only works for fetch-based downloads, not native <video> tag buffering
const originalFetch = window.fetch;
window.fetch = function (...args) {
  const url = args[0];
  const controller = new AbortController();

  // If the fetch is for a video-like resource, track it
  if (
    typeof url === "string" &&
    (url.includes(".mp4") || url.includes(".webm") || url.includes(".mov"))
  ) {
    chrome.runtime
      .sendMessage({
        type: "FETCH_STARTED",
        data: { url: url, abortable: true },
      })
      .catch(() => {});
  }

  // Pass the signal to the original fetch
  const options = args[1] || {};
  options.signal = controller.signal;

  return originalFetch(url, options);
};

// Start observing
initObserver();
