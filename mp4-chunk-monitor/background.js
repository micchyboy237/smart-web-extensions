// background.js - Enhanced with video detection logging
class NetworkRequestMonitor {
  constructor() {
    this.requestCount = 0;
    this.initializeListeners();
    this.setupKeepAlive();
    console.log("[Background] Network Request Monitor initialized");
  }

  initializeListeners() {
    // Log all outgoing requests
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        this.requestCount++;
        const timestamp = new Date().toISOString();

        // Create log entry
        const logEntry = {
          id: this.requestCount,
          timestamp,
          type: "REQUEST",
          method: details.method,
          url: details.url,
          requestId: details.requestId,
          tabId: details.tabId,
        };

        console.log(`[Background][REQUEST #${this.requestCount}]`, {
          method: details.method,
          url: details.url,
          timestamp,
        });

        // Check if it might be a video request
        if (details.url.includes(".mp4") || details.url.includes("/video/")) {
          console.log(
            `[Background][VIDEO DETECTED] Request for video: ${details.url}`,
          );
        }

        // Store for later
        this.storeRequest(details.requestId, logEntry);

        // Send to popup if open
        this.sendToPopup(logEntry);
      },
      { urls: ["<all_urls>"] },
      ["requestBody"],
    );

    // Log response headers
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        const timestamp = new Date().toISOString();
        const isVideoResponse =
          details.statusCode === 206 && details.url.includes(".mp4");

        console.log(
          `[Background][RESPONSE] ${details.statusCode} - ${details.url}`,
          isVideoResponse ? "🎬 VIDEO CHUNK" : "",
        );

        let contentType = null;
        if (details.responseHeaders) {
          const importantHeaders = [
            "content-type",
            "content-length",
            "cache-control",
          ];
          const relevantHeaders = details.responseHeaders.filter((h) =>
            importantHeaders.includes(h.name.toLowerCase()),
          );

          // Extract content-type
          const contentTypeHeader = details.responseHeaders.find(
            (h) => h.name.toLowerCase() === "content-type",
          );
          contentType = contentTypeHeader ? contentTypeHeader.value : null;

          console.log("[Background][Headers]", relevantHeaders);

          // Log specifically for video responses
          if (
            isVideoResponse ||
            (contentType && contentType.includes("video/mp4"))
          ) {
            console.log(
              `[Background][VIDEO RESPONSE] Status: ${details.statusCode}, Content-Type: ${contentType}, URL: ${details.url}`,
            );
          }
        }

        const logEntry = {
          timestamp,
          type: "RESPONSE",
          statusCode: details.statusCode,
          url: details.url,
          requestId: details.requestId,
          contentType: contentType,
          isVideoChunk:
            isVideoResponse ||
            (contentType && contentType.includes("video/mp4")),
        };

        this.sendToPopup(logEntry);
      },
      { urls: ["<all_urls>"] },
      ["responseHeaders"],
    );

    // Listen for messages from content script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log(
        "[Background][Message]",
        message.type,
        "from",
        sender.tab?.id,
      );

      if (message.type === "FETCH_RESPONSE") {
        console.log("[Background][Fetch Body]", {
          url: message.url,
          bodyLength: message.body?.length || 0,
          preview: message.body?.substring(0, 200),
        });
        sendResponse({ received: true });
      } else if (message.type === "XHR_RESPONSE") {
        console.log("[Background][XHR Body]", {
          url: message.url,
          bodyLength: message.body?.length || 0,
          preview: message.body?.substring(0, 200),
        });
        sendResponse({ received: true });
      }
      return true; // Keep message channel open
    });
  }

  setupKeepAlive() {
    // Keep service worker alive
    setInterval(() => {
      console.log("[Background] Keep-alive ping");
      chrome.storage.local.get(["lastPing"], (result) => {
        chrome.storage.local.set({
          lastPing: Date.now(),
          requestCount: this.requestCount,
        });
      });
    }, 20000); // Every 20 seconds
  }

  storeRequest(requestId, data) {
    chrome.storage.local.get(["requests"], (result) => {
      const requests = result.requests || [];
      requests.unshift(data); // Add to beginning
      // Keep last 100 requests
      const trimmed = requests.slice(0, 100);
      chrome.storage.local.set({ requests: trimmed });
    });
  }

  sendToPopup(data) {
    chrome.runtime.sendMessage({ type: "LOG_UPDATE", data: data }).catch(() => {
      // No popup open, that's fine
    });
  }
}

// Initialize the monitor
const monitor = new NetworkRequestMonitor();

// Log that background script is alive
console.log(
  "[Background] Service worker started at:",
  new Date().toISOString(),
);
