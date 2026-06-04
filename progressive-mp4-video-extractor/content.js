// content.js - Page-level video interception

console.log("[Content] Progressive MP4 Extractor content script loaded");

// Intercept fetch and XHR at page level
(function () {
  // Store original fetch
  const originalFetch = window.fetch;
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  // Intercept fetch requests
  window.fetch = async function (...args) {
    const url = args[0];
    const requestInfo = args[1] || {};

    console.log(`[Content] Fetch intercepted: ${url}`);

    if (typeof url === "string" && url.includes(".mp4")) {
      console.log(`[Content] 🎬 MP4 fetch detected: ${url}`);

      // Notify background script
      chrome.runtime
        .sendMessage({
          action: "videoDetected",
          url: url,
          type: "fetch",
          headers: requestInfo.headers,
        })
        .catch((e) => console.log("[Content] Background not ready"));
    }

    return originalFetch.apply(this, args);
  };

  // Intercept XHR
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._monitoredUrl = url;
    console.log(`[Content] XHR open: ${method} ${url}`);

    if (typeof url === "string" && url.includes(".mp4")) {
      console.log(`[Content] 🎬 MP4 XHR detected: ${url}`);

      chrome.runtime
        .sendMessage({
          action: "videoDetected",
          url: url,
          type: "xhr",
        })
        .catch((e) => console.log("[Content] Background not ready"));
    }

    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._monitoredUrl && this._monitoredUrl.includes(".mp4")) {
      console.log(`[Content] XHR send for MP4: ${this._monitoredUrl}`);

      // Add event listeners to capture response
      this.addEventListener("loadend", function () {
        if (this.status === 206 || this.status === 200) {
          console.log(
            `[Content] XHR complete for ${this._monitoredUrl}, status: ${this.status}`,
          );

          // Try to capture response as blob
          try {
            const responseBlob = this.response;
            if (
              responseBlob instanceof Blob &&
              responseBlob.type.includes("video")
            ) {
              console.log(
                `[Content] Captured response blob: ${responseBlob.size} bytes`,
              );

              // Send to background
              responseBlob.arrayBuffer().then((buffer) => {
                chrome.runtime
                  .sendMessage({
                    action: "captureBlob",
                    url: this._monitoredUrl,
                    blob: Array.from(new Uint8Array(buffer)),
                    headers: this.getAllResponseHeaders(),
                  })
                  .catch((e) => console.log("[Content] Failed to send blob"));
              });
            }
          } catch (e) {
            console.error("[Content] Failed to capture response:", e);
          }
        }
      });
    }

    return originalXHRSend.call(this, body);
  };

  // Listen for video element events
  const observeVideoElements = () => {
    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      if (!video._monitored) {
        video._monitored = true;

        console.log(
          `[Content] Video element found:`,
          video.src || video.currentSrc,
        );

        if (video.src && video.src.includes(".mp4")) {
          chrome.runtime
            .sendMessage({
              action: "videoDetected",
              url: video.src,
              type: "videoElement",
            })
            .catch((e) => console.log("[Content] Background not ready"));
        }

        // Monitor src attribute changes
        const srcObserver = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.attributeName === "src" && video.src) {
              console.log(`[Content] Video src changed to: ${video.src}`);
              if (video.src.includes(".mp4")) {
                chrome.runtime
                  .sendMessage({
                    action: "videoDetected",
                    url: video.src,
                    type: "videoElementSrcChange",
                  })
                  .catch((e) => console.log("[Content] Background not ready"));
              }
            }
          });
        });

        srcObserver.observe(video, { attributes: true });

        video.addEventListener("loadedmetadata", () => {
          console.log(
            `[Content] Video metadata loaded: duration=${video.duration}`,
          );
        });
      }
    });
  };

  // Safe DOM observer initialization
  const initDOMObserver = () => {
    // Check if document.body exists
    if (!document.body) {
      console.log("[Content] document.body not ready, waiting...");
      // Wait for DOMContentLoaded
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initDOMObserver);
      } else {
        // If DOMContentLoaded already fired but body still null (unlikely), retry
        setTimeout(initDOMObserver, 100);
      }
      return;
    }

    console.log("[Content] Initializing DOM observer on document.body");

    // Initial scan for existing videos
    observeVideoElements();

    // Observe DOM for dynamically added videos
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;

      for (const mutation of mutations) {
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
      }

      if (shouldScan) {
        observeVideoElements();
      }
    });

    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      console.log("[Content] DOM observer started successfully");
    } catch (error) {
      console.error("[Content] Failed to start DOM observer:", error);
    }
  };

  // Alternative: Use a more robust approach with requestIdleCallback
  const startWhenReady = () => {
    if (document.body) {
      initDOMObserver();
    } else {
      console.log("[Content] Waiting for document.body...");
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
          setTimeout(initDOMObserver, 0);
        });
      } else {
        // Fallback: poll for body
        let attempts = 0;
        const checkBody = setInterval(() => {
          attempts++;
          if (document.body) {
            clearInterval(checkBody);
            initDOMObserver();
          } else if (attempts > 50) {
            clearInterval(checkBody);
            console.error("[Content] Timeout waiting for document.body");
          }
        }, 100);
      }
    }
  };

  // Start the observer initialization
  startWhenReady();

  console.log("[Content] Interceptors and observers initialized");
})();

// Additional: Listen for media requests via Performance API
if (window.PerformanceObserver) {
  try {
    const perfObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      for (const entry of entries) {
        if (
          entry.initiatorType === "video" ||
          (entry.name && entry.name.includes(".mp4"))
        ) {
          console.log(
            `[Content] Performance entry: ${entry.name} (${entry.initiatorType})`,
          );

          chrome.runtime
            .sendMessage({
              action: "videoDetected",
              url: entry.name,
              type: "performance",
              initiator: entry.initiatorType,
            })
            .catch((e) => console.log("[Content] Background not ready"));
        }
      }
    });

    perfObserver.observe({ entryTypes: ["resource"] });
    console.log("[Content] PerformanceObserver initialized");
  } catch (error) {
    console.error("[Content] PerformanceObserver failed:", error);
  }
}
