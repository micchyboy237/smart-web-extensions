// background.js - Enhanced with Download Manager integration

// Import download manager functionality
importScripts("download-manager.js");

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
        if (details.url.includes(".mp4") || details.url.includes("/video/")) {
          console.log(
            `[Background][VIDEO DETECTED] Request for video: ${details.url}`,
          );
        }
        this.storeRequest(details.requestId, logEntry);
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
          const contentTypeHeader = details.responseHeaders.find(
            (h) => h.name.toLowerCase() === "content-type",
          );
          contentType = contentTypeHeader ? contentTypeHeader.value : null;
        }

        // FIX: Ensure the log entry has all fields the popup expects
        const logEntry = {
          timestamp,
          type: "RESPONSE", // ✓ Must be exactly "RESPONSE"
          statusCode: details.statusCode, // ✓ Must be a number
          url: details.url, // ✓ Must be a string
          requestId: details.requestId,
          contentType: contentType,
          isVideoChunk:
            isVideoResponse ||
            (contentType && contentType.includes("video/mp4")),
        };

        // Debug: Log what we're sending
        console.log("[Background] 📤 Sending to popup:", {
          type: logEntry.type,
          statusCode: logEntry.statusCode,
          url: logEntry.url.substring(0, 60) + "...",
        });

        this.sendToPopup(logEntry);

        // FIX: Also store with the same format
        this.storeRequest(details.requestId, logEntry);
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
      // Note: DownloadManager messages are handled in download-manager.js
      return true;
    });
  }

  setupKeepAlive() {
    setInterval(() => {
      console.log("[Background] Keep-alive ping");
      chrome.storage.local.get(["lastPing"], (result) => {
        chrome.storage.local.set({
          lastPing: Date.now(),
          requestCount: this.requestCount,
        });
      });
    }, 20000);
  }

  storeRequest(requestId, data) {
    chrome.storage.local.get(["requests"], (result) => {
      const requests = result.requests || [];
      requests.unshift(data);
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
console.log(
  "[Background] Service worker started at:",
  new Date().toISOString(),
);
