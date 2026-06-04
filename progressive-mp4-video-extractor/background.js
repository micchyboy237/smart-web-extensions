// background.js - Automatic Debugger Mode (Fixed v3.3 - Improved video tracking)
class ProgressiveMP4Extractor {
  constructor() {
    this.videoChunks = new Map(); // Videos with captured data
    this.activeDebuggers = new Map(); // Active debugger connections
    this.capturedResponses = new Map(); // In-progress captures
    this.detectedVideos = new Map(); // NEW: Track all detected videos (even without chunks)
    this.setupAutoAttach();
    console.log("[Extractor] Initialized v3.3 - Fixed video tracking");
  }

  setupAutoAttach() {
    // Auto-attach debugger to EVERY tab when it loads
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.status === "loading" && tab.url?.startsWith("http")) {
        await this.autoAttachDebugger(tabId);
      }
    });

    // Also attach when tab becomes active
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.url?.startsWith("http")) {
        await this.autoAttachDebugger(activeInfo.tabId);
      }
    });

    // New tabs
    chrome.tabs.onCreated.addListener(async (tab) => {
      if (tab.url?.startsWith("http")) {
        setTimeout(() => this.autoAttachDebugger(tab.id), 1000);
      }
    });

    // Listen for debugger events globally
    chrome.debugger.onEvent.addListener(this.handleDebuggerEvent.bind(this));
    chrome.debugger.onDetach.addListener((source, reason) => {
      console.log(`[Debugger] Detached from tab ${source.tabId}: ${reason}`);
      this.activeDebuggers.delete(source.tabId);
    });

    // Listen for messages from content script and popup
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));

    console.log("[Auto] Debugger auto-attach enabled");
  }

  async autoAttachDebugger(tabId) {
    if (this.activeDebuggers.has(tabId)) {
      return true;
    }

    try {
      console.log(`[Auto] Attaching debugger to tab ${tabId}...`);
      await chrome.debugger.attach({ tabId }, "1.3");
      await chrome.debugger.sendCommand({ tabId }, "Network.enable");
      await chrome.debugger.sendCommand({ tabId }, "Network.setCacheDisabled", {
        cacheDisabled: true,
      });
      this.activeDebuggers.set(tabId, { attached: true });
      console.log(`[Auto] ✅ Debugger attached to tab ${tabId}`);
      return true;
    } catch (error) {
      console.error(`[Auto] Failed to attach to tab ${tabId}:`, error);
      return false;
    }
  }

  async detachDebugger(tabId) {
    if (!this.activeDebuggers.has(tabId)) return;

    try {
      await chrome.debugger.detach({ tabId });
      this.activeDebuggers.delete(tabId);
      console.log(`[Debugger] Detached from tab ${tabId}`);
    } catch (error) {
      console.error(`[Debugger] Detach error:`, error);
    }
  }

  handleDebuggerEvent(source, method, params) {
    const tabId = source.tabId;

    if (method === "Network.responseReceived") {
      this.handleResponseReceived(tabId, params);
    } else if (method === "Network.dataReceived") {
      this.handleDataReceived(tabId, params);
    } else if (method === "Network.loadingFinished") {
      this.handleLoadingFinished(tabId, params);
    }
  }

  /**
   * Handle incoming messages from popup and content script
   */
  handleMessage(request, sender, sendResponse) {
    console.log(`[Background] Message: ${request.action}`);

    switch (request.action) {
      case "getStats":
        sendResponse(this.getStats());
        break;

      case "saveVideo":
        this.saveVideo(request.url, request.filename).then(sendResponse);
        return true; // Keep channel open for async response

      case "clear":
        this.clear(request.url);
        sendResponse({ success: true });
        break;

      case "videoDetected":
        // NEW: Track detected videos from content script
        this.trackDetectedVideo(request.url, request.type || "contentScript");
        sendResponse({ success: true });
        break;

      default:
        console.log(`[Background] Unknown action: ${request.action}`);
        sendResponse({ error: "Unknown action" });
    }

    return true;
  }

  /**
   * NEW: Track a detected video (even without captured chunks)
   */
  trackDetectedVideo(url, source) {
    if (this.detectedVideos.has(url)) {
      // Update last seen time
      const entry = this.detectedVideos.get(url);
      entry.lastSeen = Date.now();
      entry.detectionCount++;
      console.log(
        `[Tracker] Video re-detected: ${url.substring(0, 60)}... (${entry.detectionCount}x, source: ${source})`,
      );
      return;
    }

    // Extract filename from URL
    let filename = "unknown.mp4";
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split("/");
      filename = pathParts[pathParts.length - 1] || "video.mp4";
      if (!filename.includes(".")) filename += ".mp4";
    } catch (e) {
      // Use full URL as fallback
    }

    this.detectedVideos.set(url, {
      url: url,
      filename: filename,
      source: source,
      detectedAt: Date.now(),
      lastSeen: Date.now(),
      detectionCount: 1,
      hasChunks: this.videoChunks.has(url),
    });

    console.log(
      `[Tracker] 🎥 New video tracked: ${filename} (source: ${source})`,
    );
    console.log(`[Tracker] Total tracked videos: ${this.detectedVideos.size}`);
  }

  handleResponseReceived(tabId, params) {
    const response = params.response;
    const url = response.url;
    const mimeType = response.mimeType;

    // FIXED: Safely check headers
    let isVideo = false;

    // Check MIME type
    if (mimeType && mimeType.includes("video/")) {
      isVideo = true;
    }

    // Check URL
    if (
      url &&
      (url.includes(".mp4") || url.includes(".webm") || url.includes(".avi"))
    ) {
      isVideo = true;
    }

    // Check headers safely (headers might be undefined or not an array)
    if (response.headers) {
      try {
        // Convert headers to array if needed
        const headersArray = Array.isArray(response.headers)
          ? response.headers
          : Object.entries(response.headers);

        for (const header of headersArray) {
          const headerName = Array.isArray(header) ? header[0] : header.name;
          const headerValue = Array.isArray(header) ? header[1] : header.value;

          if (
            headerName &&
            headerName.toLowerCase() === "content-type" &&
            headerValue &&
            headerValue.includes("video/")
          ) {
            isVideo = true;
            break;
          }
        }
      } catch (e) {
        console.log("[Debugger] Header parse error:", e);
      }
    }

    if (isVideo) {
      console.log(`[Debugger] 🎬 Video detected: ${url.substring(0, 80)}...`);
      console.log(`[Debugger] MIME: ${mimeType || "unknown"}`);

      // NEW: Track this video immediately
      this.trackDetectedVideo(url, "debugger");

      // Store response info for potential body capture
      this.capturedResponses.set(params.requestId, {
        url: url,
        tabId: tabId,
        chunks: [],
        totalSize: null,
        contentType: mimeType || "video/mp4",
        startTime: Date.now(),
      });
    }
  }

  handleDataReceived(tabId, params) {
    const capture = this.capturedResponses.get(params.requestId);
    if (capture) {
      capture.chunks.push({
        dataLength: params.dataLength,
        encodedLength: params.encodedDataLength,
        timestamp: Date.now(),
      });
    }
  }

  async handleLoadingFinished(tabId, params) {
    const capture = this.capturedResponses.get(params.requestId);
    if (!capture) return;

    console.log(
      `[Debugger] Loading finished for ${capture.url.substring(0, 60)}...`,
    );

    // Calculate total size from chunks
    const totalSize = capture.chunks.reduce(
      (sum, c) => sum + (c.dataLength || 0),
      0,
    );
    console.log(
      `[Debugger] Received ${capture.chunks.length} chunks, total ~${(totalSize / 1024 / 1024).toFixed(2)} MB`,
    );

    try {
      // Get the actual response body via debugger (bypasses CORS!)
      const body = await chrome.debugger.sendCommand(
        { tabId },
        "Network.getResponseBody",
        { requestId: params.requestId },
      );

      if (body && body.body) {
        console.log(
          `[Debugger] Response body received, encoding: ${body.base64Encoded ? "base64" : "text"}`,
        );

        let bytes;
        if (body.base64Encoded) {
          // Convert base64 to binary
          const binaryString = atob(body.body);
          bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
        } else {
          // Convert text to binary
          bytes = new TextEncoder().encode(body.body);
        }

        const blob = new Blob([bytes], {
          type: capture.contentType || "video/mp4",
        });

        console.log(
          `[Debugger] ✅ Captured ${blob.size} bytes from ${capture.url.substring(0, 60)}...`,
        );
        await this.addChunk(capture.url, blob);
      } else {
        console.log(
          `[Debugger] No body content for ${capture.url.substring(0, 60)}`,
        );
      }
    } catch (error) {
      console.error(`[Debugger] Failed to get response body:`, error);
      if (error.message) {
        console.error(`[Debugger] Error details: ${error.message}`);
      }
      // NEW: Even if body capture fails, we still have the video tracked
      console.log(`[Debugger] Video still tracked despite capture failure`);
    }

    this.capturedResponses.delete(params.requestId);
  }

  async addChunk(url, blob) {
    if (!this.videoChunks.has(url)) {
      this.videoChunks.set(url, {
        chunks: [],
        totalSize: null,
        contentType: blob.type || "video/mp4",
        url: url,
        lastUpdate: Date.now(),
      });
      console.log(`[Storage] New video tracked: ${url.substring(0, 60)}...`);
    }

    const entry = this.videoChunks.get(url);
    const chunkIndex = entry.chunks.length + 1;

    entry.chunks.push({
      index: chunkIndex,
      blob: blob,
      size: blob.size,
      timestamp: Date.now(),
    });
    entry.lastUpdate = Date.now();

    const totalSize = entry.chunks.reduce((sum, c) => sum + c.size, 0);
    console.log(
      `[Storage] 📦 Chunk ${chunkIndex}: ${(blob.size / 1024 / 1024).toFixed(2)} MB | Total: ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
    );

    // Update the detected video entry to reflect that chunks are available
    if (this.detectedVideos.has(url)) {
      this.detectedVideos.get(url).hasChunks = true;
    }

    // Try to reconstruct after each chunk
    await this.tryReconstruct(url);
  }

  async tryReconstruct(url) {
    const entry = this.videoChunks.get(url);
    if (!entry || entry.chunks.length === 0) return null;

    const totalSize = entry.chunks.reduce((sum, c) => sum + c.size, 0);
    console.log(
      `[Reconstruct] ${entry.chunks.length} chunks, ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
    );

    // Auto-save notification for live monitor
    return { size: totalSize, chunks: entry.chunks.length };
  }

  async reconstructVideo(url) {
    const entry = this.videoChunks.get(url);
    if (!entry || entry.chunks.length === 0) return null;

    // Sort chunks by index
    const sortedChunks = [...entry.chunks].sort((a, b) => a.index - b.index);
    const blobs = sortedChunks.map((c) => c.blob);
    const mergedBlob = new Blob(blobs, {
      type: entry.contentType || "video/mp4",
    });

    console.log(
      `[Reconstruct] Merged ${sortedChunks.length} chunks into ${(mergedBlob.size / 1024 / 1024).toFixed(2)} MB`,
    );

    return {
      blob: mergedBlob,
      url: URL.createObjectURL(mergedBlob),
      size: mergedBlob.size,
      chunksCount: entry.chunks.length,
      isComplete: true,
    };
  }

  async saveVideo(url, filename = null) {
    const result = await this.reconstructVideo(url);
    if (!result || result.size === 0) {
      console.error("[Save] No video data");
      return false;
    }

    if (!filename) {
      const urlParts = url.split("/");
      let originalName = urlParts[urlParts.length - 1].split("?")[0];
      if (!originalName || originalName.length === 0) {
        originalName = `video_${Date.now()}.mp4`;
      }
      if (!originalName.endsWith(".mp4")) originalName += ".mp4";
      filename = `captured_${Date.now()}_${originalName}`;
    }

    chrome.downloads.download(
      {
        url: result.url,
        filename: filename,
        saveAs: true,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("[Save] Download failed:", chrome.runtime.lastError);
        } else {
          console.log(
            `[Save] ✅ Saved: ${filename} (${(result.size / 1024 / 1024).toFixed(2)} MB)`,
          );
        }
        setTimeout(() => URL.revokeObjectURL(result.url), 2000);
      },
    );
    return true;
  }

  /**
   * UPDATED: Returns both detected videos AND videos with chunks
   */
  getStats() {
    const stats = {};

    // First, include all detected videos (even without chunks)
    for (const [url, detectedInfo] of this.detectedVideos.entries()) {
      const chunkEntry = this.videoChunks.get(url);

      if (chunkEntry) {
        // Has captured chunks
        const totalSize = chunkEntry.chunks.reduce((sum, c) => sum + c.size, 0);
        stats[url] = {
          chunksCount: chunkEntry.chunks.length,
          totalBytesCaptured: totalSize,
          expectedTotalBytes: null,
          completeness: `${chunkEntry.chunks.length} chunks, ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
          lastUpdate: chunkEntry.lastUpdate,
          filename: detectedInfo.filename,
          source: detectedInfo.source,
          hasChunks: true,
        };
      } else {
        // Detected but no chunks captured yet
        stats[url] = {
          chunksCount: 0,
          totalBytesCaptured: 0,
          expectedTotalBytes: null,
          completeness: `Detected (${detectedInfo.detectionCount}x), waiting for data...`,
          lastUpdate: detectedInfo.lastSeen,
          filename: detectedInfo.filename,
          source: detectedInfo.source,
          hasChunks: false,
        };
      }
    }

    // Also check for videos in videoChunks that might not be in detectedVideos (backward compat)
    for (const [url, entry] of this.videoChunks.entries()) {
      if (!stats[url]) {
        const totalSize = entry.chunks.reduce((sum, c) => sum + c.size, 0);
        stats[url] = {
          chunksCount: entry.chunks.length,
          totalBytesCaptured: totalSize,
          expectedTotalBytes: null,
          completeness: `${entry.chunks.length} chunks, ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
          lastUpdate: entry.lastUpdate,
          filename: "unknown.mp4",
          source: "legacy",
          hasChunks: true,
        };
      }
    }

    console.log(
      `[Stats] Returning ${Object.keys(stats).length} videos (${this.detectedVideos.size} tracked, ${this.videoChunks.size} with chunks)`,
    );
    return stats;
  }

  clear(url = null) {
    if (url) {
      const entry = this.videoChunks.get(url);
      if (entry) {
        // Revoke object URLs if any
        entry.chunks.forEach((chunk) => {
          if (chunk.blobUrl) URL.revokeObjectURL(chunk.blobUrl);
        });
      }
      this.videoChunks.delete(url);
      this.detectedVideos.delete(url);
      console.log(`[Clear] Cleared: ${url.substring(0, 60)}...`);
    } else {
      // Revoke all object URLs
      for (const [url, entry] of this.videoChunks.entries()) {
        entry.chunks.forEach((chunk) => {
          if (chunk.blobUrl) URL.revokeObjectURL(chunk.blobUrl);
        });
      }
      this.videoChunks.clear();
      this.detectedVideos.clear();
      console.log("[Clear] Cleared all videos");
    }
  }
}

// Initialize extractor
const extractor = new ProgressiveMP4Extractor();

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  extractor.detachDebugger(tabId);
});

console.log(
  "🎥 MP4 Extractor v3.3 - Active! Debugger auto-attaches to all tabs. Videos tracked immediately upon detection.",
);
