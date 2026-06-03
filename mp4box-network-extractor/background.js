// background.js - Service Worker for intercepting network requests

console.log("[MP4Box Extractor] Background service worker started");

// Store detected MP4 files
let detectedMP4s = new Map();

// Listen for web requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;

    // Check if it's an MP4 file
    if (url.match(/\.mp4(\?|$)/i)) {
      console.log(`[MP4Box Extractor] Detected MP4 request: ${url}`);

      // Store initial info
      const mp4Info = {
        url: url,
        timestamp: new Date().toISOString(),
        status: "detected",
        requestId: details.requestId,
        tabId: details.tabId,
        frameId: details.frameId,
        parentFrameId: details.parentFrameId,
        initiator: details.initiator,
        method: details.method,
        requestBody: details.requestBody,
      };

      detectedMP4s.set(details.requestId, mp4Info);

      // Notify any open popups
      chrome.runtime
        .sendMessage({
          type: "MP4_DETECTED",
          data: mp4Info,
        })
        .catch(() => {
          // No popup open, ignore
        });
    }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

// Listen for response headers
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (detectedMP4s.has(details.requestId)) {
      const mp4Info = detectedMP4s.get(details.requestId);

      // Extract response headers
      const headers = {};
      details.responseHeaders.forEach((header) => {
        headers[header.name.toLowerCase()] = header.value;
      });

      mp4Info.status = "headers_received";
      mp4Info.responseHeaders = headers;
      mp4Info.statusCode = details.statusCode;
      mp4Info.statusLine = details.statusLine;

      // Check content-type
      if (
        headers["content-type"] &&
        headers["content-type"].includes("video/mp4")
      ) {
        console.log(
          `[MP4Box Extractor] Confirmed MP4 content type for: ${mp4Info.url}`,
        );
        mp4Info.contentType = headers["content-type"];
      }

      // Get content length if available
      if (headers["content-length"]) {
        mp4Info.contentLength = parseInt(headers["content-length"]);
        console.log(
          `[MP4Box Extractor] Content length: ${mp4Info.contentLength} bytes`,
        );
      }

      // Check for partial content
      if (details.statusCode === 206 && headers["content-range"]) {
        mp4Info.isPartialContent = true;
        mp4Info.contentRange = headers["content-range"];
        console.log(
          `[MP4Box Extractor] Partial content detected: ${headers["content-range"]}`,
        );
      }

      detectedMP4s.set(details.requestId, mp4Info);

      // Notify popup
      chrome.runtime
        .sendMessage({
          type: "MP4_HEADERS_RECEIVED",
          data: mp4Info,
        })
        .catch(() => {});
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

// Listen for completed requests
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (detectedMP4s.has(details.requestId)) {
      const mp4Info = detectedMP4s.get(details.requestId);
      mp4Info.status = "completed";
      mp4Info.completedTimestamp = new Date().toISOString();
      mp4Info.fromCache = details.fromCache;
      mp4Info.ip = details.ip;

      console.log(`[MP4Box Extractor] Request completed for: ${mp4Info.url}`);
      console.log(`[MP4Box Extractor] From cache: ${details.fromCache}`);

      detectedMP4s.set(details.requestId, mp4Info);

      chrome.runtime
        .sendMessage({
          type: "MP4_COMPLETED",
          data: mp4Info,
        })
        .catch(() => {});
    }
  },
  { urls: ["<all_urls>"] },
);

// Clean up on error
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (detectedMP4s.has(details.requestId)) {
      const mp4Info = detectedMP4s.get(details.requestId);
      mp4Info.status = "error";
      mp4Info.error = details.error;

      console.error(
        `[MP4Box Extractor] Error for ${mp4Info.url}: ${details.error}`,
      );

      detectedMP4s.set(details.requestId, mp4Info);

      chrome.runtime
        .sendMessage({
          type: "MP4_ERROR",
          data: mp4Info,
        })
        .catch(() => {});

      // Clean up after 1 minute
      setTimeout(() => {
        detectedMP4s.delete(details.requestId);
      }, 60000);
    }
  },
  { urls: ["<all_urls>"] },
);

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_MP4_DATA") {
    const mp4Data = Array.from(detectedMP4s.values());
    sendResponse({ mp4s: mp4Data });
  }
  return true;
});

// Clean up old entries periodically
setInterval(
  () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [id, mp4] of detectedMP4s) {
      const timestamp = new Date(mp4.timestamp).getTime();
      if (timestamp < oneHourAgo) {
        detectedMP4s.delete(id);
        console.log(`[MP4Box Extractor] Cleaned up old entry: ${mp4.url}`);
      }
    }
  },
  60 * 60 * 1000,
);

console.log("[MP4Box Extractor] Background service worker fully initialized");
