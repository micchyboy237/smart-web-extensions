// background.js - Automatic Debugger Mode (v3.4 - With Buffer Priming)
// First, include the buffer primer class
// Note: In a real service worker, you'd use importScripts('video-buffer-primer.js')
// For simplicity, we include the class directly

importScripts("video-buffer-primer.js");

// ============================================
// ProgressiveMP4Extractor Class
// ============================================
class ProgressiveMP4Extractor {
  constructor() {
    this.videoChunks = new Map();
    this.activeDebuggers = new Map();
    this.capturedResponses = new Map();
    this.detectedVideos = new Map();

    // NEW: Initialize buffer primer
    this.bufferPrimer = new VideoBufferPrimer();

    this.setupAutoAttach();
    console.log("[Extractor] Initialized v3.4 - With buffer priming");
  }

  setupAutoAttach() {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.status === "loading" && tab.url?.startsWith("http")) {
        await this.autoAttachDebugger(tabId);
      }
    });

    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.url?.startsWith("http")) {
        await this.autoAttachDebugger(activeInfo.tabId);
      }
    });

    chrome.tabs.onCreated.addListener(async (tab) => {
      if (tab.url?.startsWith("http")) {
        setTimeout(() => this.autoAttachDebugger(tab.id), 1000);
      }
    });

    chrome.debugger.onEvent.addListener(this.handleDebuggerEvent.bind(this));
    chrome.debugger.onDetach.addListener((source, reason) => {
      console.log(`[Debugger] Detached from tab ${source.tabId}: ${reason}`);
      this.activeDebuggers.delete(source.tabId);
    });

    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
    console.log("[Auto] Debugger auto-attach enabled with buffer priming");
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

  handleMessage(request, sender, sendResponse) {
    console.log(`[Background] Message: ${request.action}`);
    switch (request.action) {
      case "getStats":
        sendResponse(this.getStats());
        break;
      case "saveVideo":
        this.saveVideo(request.url, request.filename).then(sendResponse);
        return true;
      case "clear":
        this.clear(request.url);
        sendResponse({ success: true });
        break;
      case "videoDetected":
        this.trackDetectedVideo(request.url, request.type || "contentScript");
        sendResponse({ success: true });
        break;
      // NEW: Buffer primer actions
      case "getPrimerStats":
        sendResponse(this.bufferPrimer.getStats());
        break;
      case "clearPrimerCache":
        this.bufferPrimer.clear();
        sendResponse({ success: true });
        break;
      default:
        console.log(`[Background] Unknown action: ${request.action}`);
        sendResponse({ error: "Unknown action" });
    }
    return true;
  }

  trackDetectedVideo(url, source) {
    const isFirstDetection = !this.detectedVideos.has(url);

    if (this.detectedVideos.has(url)) {
      const entry = this.detectedVideos.get(url);
      entry.lastSeen = Date.now();
      entry.detectionCount++;
      console.log(
        `[Tracker] Video re-detected: ${url} (${entry.detectionCount}x, source: ${source})`,
      );
    } else {
      let filename = "unknown.mp4";
      try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split("/");
        filename = pathParts[pathParts.length - 1] || "video.mp4";
        if (!filename.includes(".")) filename += ".mp4";
      } catch (e) {
        console.warn("[Tracker] URL parse error:", e.message);
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
      console.log(
        `[Tracker] Total tracked videos: ${this.detectedVideos.size}`,
      );
    }

    // IMPORTANT FIX: Check shouldPrime for ALL detections, not just first
    // But skip if already primed to avoid duplicate work
    if (!this.bufferPrimer.primedUrls.has(url)) {
      const shouldPrimeResult = this.bufferPrimer.shouldPrime(url);
      console.log(
        `[Tracker] 🔍 shouldPrime result: ${shouldPrimeResult} for ${url}`,
      );

      if (shouldPrimeResult) {
        console.log(`[Tracker] 🎯 Triggering buffer prime`);
        this.bufferPrimer
          .primeVideoBuffer(url, source)
          .then((result) => {
            if (result.success) {
              console.log(`[Tracker] ✅ Buffer primed successfully`);
            } else {
              console.log(
                `[Tracker] ⚠️ Buffer priming issue: ${result.message}`,
              );
            }
          })
          .catch((error) => {
            console.error(`[Tracker] ❌ Buffer priming error:`, error);
          });
      }
    } else {
      console.log(`[Tracker] ⏭️ Already primed, skipping`);
    }
  }

  handleResponseReceived(tabId, params) {
    const response = params.response;
    const url = response.url;
    const mimeType = response.mimeType;

    let isVideo = false;
    if (mimeType && mimeType.includes("video/")) {
      isVideo = true;
    }
    if (
      url &&
      (url.includes(".mp4") || url.includes(".webm") || url.includes(".avi"))
    ) {
      isVideo = true;
    }
    if (response.headers) {
      try {
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
      console.log(`[Debugger] 🎬 Video detected: ${url}`);
      console.log(`[Debugger] MIME: ${mimeType || "unknown"}`);
      this.trackDetectedVideo(url, "debugger");

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

    console.log(`[Debugger] Loading finished for ${capture.url}`);

    const totalSize = capture.chunks.reduce(
      (sum, c) => sum + (c.dataLength || 0),
      0,
    );
    console.log(
      `[Debugger] Received ${capture.chunks.length} chunks, total ~${(totalSize / 1024 / 1024).toFixed(2)} MB`,
    );

    try {
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
          const binaryString = atob(body.body);
          bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
        } else {
          bytes = new TextEncoder().encode(body.body);
        }

        const blob = new Blob([bytes], {
          type: capture.contentType || "video/mp4",
        });
        console.log(
          `[Debugger] ✅ Captured ${blob.size} bytes from ${capture.url}`,
        );
        await this.addChunk(capture.url, blob);
      } else {
        console.log(`[Debugger] No body content for ${capture.url}`);
      }
    } catch (error) {
      console.error(`[Debugger] Failed to get response body:`, error);
      if (error.message) {
        console.error(`[Debugger] Error details: ${error.message}`);
      }
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
      console.log(`[Storage] New video tracked: ${url}`);
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

    if (this.detectedVideos.has(url)) {
      this.detectedVideos.get(url).hasChunks = true;
    }

    await this.tryReconstruct(url);
  }

  async tryReconstruct(url) {
    const entry = this.videoChunks.get(url);
    if (!entry || entry.chunks.length === 0) return null;

    const totalSize = entry.chunks.reduce((sum, c) => sum + c.size, 0);
    console.log(
      `[Reconstruct] ${entry.chunks.length} chunks, ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
    );
    return { size: totalSize, chunks: entry.chunks.length };
  }

  async reconstructVideo(url) {
    const entry = this.videoChunks.get(url);
    if (!entry || entry.chunks.length === 0) return null;

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

  getStats() {
    const stats = {};

    for (const [url, detectedInfo] of this.detectedVideos.entries()) {
      const chunkEntry = this.videoChunks.get(url);
      if (chunkEntry) {
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
          primed: this.bufferPrimer.primedUrls.has(url), // NEW
        };
      } else {
        stats[url] = {
          chunksCount: 0,
          totalBytesCaptured: 0,
          expectedTotalBytes: null,
          completeness: `Detected (${detectedInfo.detectionCount}x), waiting for data...`,
          lastUpdate: detectedInfo.lastSeen,
          filename: detectedInfo.filename,
          source: detectedInfo.source,
          hasChunks: false,
          primed: this.bufferPrimer.primedUrls.has(url), // NEW
        };
      }
    }

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
          primed: this.bufferPrimer.primedUrls.has(url), // NEW
        };
      }
    }

    // NEW: Log primer stats
    const primerStats = this.bufferPrimer.getStats();
    console.log(
      `[Stats] ${Object.keys(stats).length} videos | ${primerStats.totalPrimed} primed | ${primerStats.activeRequests} active | ${primerStats.queueLength} queued`,
    );

    return stats;
  }

  clear(url = null) {
    if (url) {
      const entry = this.videoChunks.get(url);
      if (entry) {
        entry.chunks.forEach((chunk) => {
          if (chunk.blobUrl) URL.revokeObjectURL(chunk.blobUrl);
        });
      }
      this.videoChunks.delete(url);
      this.detectedVideos.delete(url);
      console.log(`[Clear] Cleared: ${url}`);
    } else {
      for (const [url, entry] of this.videoChunks.entries()) {
        entry.chunks.forEach((chunk) => {
          if (chunk.blobUrl) URL.revokeObjectURL(chunk.blobUrl);
        });
      }
      this.videoChunks.clear();
      this.detectedVideos.clear();

      // NEW: Clear primer cache
      this.bufferPrimer.clear();

      console.log("[Clear] Cleared all videos and primer cache");
    }
  }

  async downloadVideoDirectly(url) {
    console.log(`[Download] Starting direct download: ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[Download] HTTP ${response.status} for ${url}`);
        return false;
      }

      const reader = response.body.getReader();
      const contentLength = parseInt(
        response.headers.get("content-length") || "0",
      );
      const contentType = response.headers.get("content-type") || "video/mp4";
      console.log(
        `[Download] Content-Length: ${(contentLength / 1024 / 1024).toFixed(2)} MB, Type: ${contentType}`,
      );

      let receivedLength = 0;
      const chunks = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(
            `[Download] ✅ Complete: ${(receivedLength / 1024 / 1024).toFixed(2)} MB`,
          );
          break;
        }
        chunks.push(value);
        receivedLength += value.length;

        if (receivedLength % (1024 * 1024) < value.length) {
          console.log(
            `[Download] Progress: ${(receivedLength / 1024 / 1024).toFixed(2)} MB`,
          );
        }
      }

      const allChunks = new Uint8Array(receivedLength);
      let position = 0;
      for (const chunk of chunks) {
        allChunks.set(chunk, position);
        position += chunk.length;
      }

      const blob = new Blob([allChunks], { type: contentType });
      console.log(
        `[Download] Created blob: ${(blob.size / 1024 / 1024).toFixed(2)} MB`,
      );

      await this.addChunk(url, blob);
      return true;
    } catch (error) {
      console.error(`[Download] Failed for ${url}:`, error);
      return false;
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
  "🎥 MP4 Extractor v3.4 - Active! Debugger auto-attaches + Buffer priming for initial 0 - n bytes per video",
);
