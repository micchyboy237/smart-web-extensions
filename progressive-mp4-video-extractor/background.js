// background.js - Enhanced Progressive MP4 Chunk Detector & Reconstructor

class ProgressiveMP4Extractor {
  constructor() {
    this.videoChunks = new Map();
    this.activeDebuggers = new Map();
    this.capturedResponses = new Map();
    console.log("[Extractor] Initialized ProgressiveMP4Extractor v2.0");
  }

  async attachDebugger(tabId) {
    if (this.activeDebuggers.has(tabId)) {
      console.log(`[Extractor] Debugger already attached to tab ${tabId}`);
      return true;
    }

    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      await chrome.debugger.sendCommand({ tabId }, "Network.enable");
      await chrome.debugger.sendCommand({ tabId }, "Network.setCacheDisabled", {
        cacheDisabled: true,
      });

      chrome.debugger.onEvent.addListener(this.handleDebuggerEvent.bind(this));

      this.activeDebuggers.set(tabId, { attached: true });
      console.log(`[Extractor] Debugger attached to tab ${tabId}`);
      return true;
    } catch (error) {
      console.error(
        `[Extractor] Failed to attach debugger to tab ${tabId}:`,
        error,
      );
      return false;
    }
  }

  async detachDebugger(tabId) {
    if (!this.activeDebuggers.has(tabId)) return;

    try {
      await chrome.debugger.detach({ tabId });
      this.activeDebuggers.delete(tabId);
      console.log(`[Extractor] Debugger detached from tab ${tabId}`);
    } catch (error) {
      console.error(`[Extractor] Failed to detach debugger:`, error);
    }
  }

  handleDebuggerEvent(source, method, params) {
    if (method === "Network.responseReceived") {
      this.handleResponseReceived(source.tabId, params);
    } else if (method === "Network.dataReceived") {
      this.handleDataReceived(source.tabId, params);
    } else if (method === "Network.loadingFinished") {
      this.handleLoadingFinished(source.tabId, params);
    }
  }

  handleResponseReceived(tabId, params) {
    const response = params.response;
    const url = response.url;
    const mimeType = response.mimeType;

    console.log(`[Debugger] Response received: ${url} - ${mimeType}`);

    if (mimeType === "video/mp4" || url.includes(".mp4")) {
      console.log(`[Debugger] 🎬 Video response detected: ${url}`);

      // Check for range response
      const contentRange = response.headers.find(
        (h) => h.name.toLowerCase() === "content-range",
      );

      if (contentRange || response.status === 206) {
        console.log(`[Debugger] Range response detected for ${url}`);

        this.capturedResponses.set(params.requestId, {
          url,
          tabId,
          chunks: [],
          totalSize: this.parseTotalSize(contentRange?.value),
          startByte: this.parseStartByte(contentRange?.value),
          headers: response.headers,
        });
      }
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
      console.log(
        `[Debugger] Data chunk received: ${params.dataLength} bytes for ${capture.url}`,
      );
    }
  }

  async handleLoadingFinished(tabId, params) {
    const capture = this.capturedResponses.get(params.requestId);
    if (!capture) return;

    console.log(`[Debugger] Loading finished for ${capture.url}`);

    // Fetch the actual response body via debugger
    try {
      const body = await chrome.debugger.sendCommand(
        { tabId },
        "Network.getResponseBody",
        { requestId: params.requestId },
      );

      if (body && body.body) {
        const binaryString = atob(body.body);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const blob = new Blob([bytes], { type: "video/mp4" });
        await this.captureChunkFromDebugger(capture.url, blob, capture);
      }
    } catch (error) {
      console.error(`[Debugger] Failed to get response body:`, error);
    }

    this.capturedResponses.delete(params.requestId);
  }

  parseTotalSize(contentRange) {
    if (!contentRange) return null;
    const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  parseStartByte(contentRange) {
    if (!contentRange) return null;
    const match = contentRange.match(/bytes (\d+)-\d+\/\d+/);
    return match ? parseInt(match[1]) : null;
  }

  async captureChunkFromDebugger(url, blob, captureInfo) {
    if (!this.videoChunks.has(url)) {
      this.videoChunks.set(url, {
        chunks: [],
        totalSize: captureInfo.totalSize,
        contentType: "video/mp4",
        url: url,
      });
    }

    const entry = this.videoChunks.get(url);
    entry.chunks.push({
      start: captureInfo.startByte || 0,
      blob: blob,
      size: blob.size,
      timestamp: Date.now(),
    });

    console.log(`📦 Debugger captured: ${url} - ${blob.size} bytes`);
    await this.tryReconstruct(url);
  }

  detectRangeRequest(details) {
    const contentType = this.getResponseHeader(
      details.responseHeaders,
      "content-type",
    );
    const contentRange = this.getResponseHeader(
      details.responseHeaders,
      "content-range",
    );
    const acceptRanges = this.getResponseHeader(
      details.responseHeaders,
      "accept-ranges",
    );

    if (
      contentType?.includes("video/mp4") &&
      (contentRange || acceptRanges === "bytes")
    ) {
      console.log(
        `[Extractor] Progressive MP4 range request detected for ${details.url}`,
      );
      return true;
    }
    return false;
  }

  getResponseHeader(headers, name) {
    if (!headers) return null;
    const header = headers.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    );
    return header ? header.value : null;
  }

  getRequestHeader(details, name) {
    if (!details.requestHeaders) return null;
    const header = details.requestHeaders.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    );
    return header ? header.value : null;
  }

  parseRangeHeader(rangeHeader) {
    if (!rangeHeader) return null;
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      return {
        start: parseInt(match[1]),
        end: match[2] ? parseInt(match[2]) : null,
      };
    }
    return null;
  }

  parseContentRange(contentRange) {
    if (!contentRange) return null;
    const match = contentRange.match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
    if (match) {
      return {
        start: parseInt(match[1]),
        end: parseInt(match[2]),
        total: match[3] === "*" ? null : parseInt(match[3]),
      };
    }
    return null;
  }

  async captureChunk(details, responseBlob) {
    const url = details.url;
    const rangeHeader = this.getRequestHeader(details, "range");
    const contentRange = this.getResponseHeader(
      details.responseHeaders,
      "content-range",
    );

    if (!rangeHeader && !contentRange) {
      console.warn(`[Extractor] No range headers for ${url}`);
      return;
    }

    if (!this.videoChunks.has(url)) {
      this.videoChunks.set(url, {
        chunks: [],
        totalSize: null,
        contentType: this.getResponseHeader(
          details.responseHeaders,
          "content-type",
        ),
        url: url,
      });
    }

    const entry = this.videoChunks.get(url);
    let startByte = null;

    if (rangeHeader) {
      const range = this.parseRangeHeader(rangeHeader);
      if (range) startByte = range.start;
    }

    if (contentRange) {
      const rangeInfo = this.parseContentRange(contentRange);
      if (rangeInfo) {
        startByte = rangeInfo.start;
        if (rangeInfo.total && !entry.totalSize) {
          entry.totalSize = rangeInfo.total;
        }
      }
    }

    if (startByte === null) startByte = 0;

    entry.chunks.push({
      start: startByte,
      blob: responseBlob,
      size: responseBlob.size,
      timestamp: Date.now(),
    });

    console.log(
      `📦 Chunk captured: ${url} - start ${startByte} (${responseBlob.size} bytes)`,
    );
    await this.tryReconstruct(url);
  }

  async tryReconstruct(url) {
    const entry = this.videoChunks.get(url);
    if (!entry || entry.chunks.length === 0) return null;

    const sortedChunks = [...entry.chunks].sort((a, b) => a.start - b.start);
    let expectedOffset = 0;
    const contiguousChunks = [];

    for (const chunk of sortedChunks) {
      if (chunk.start === expectedOffset) {
        contiguousChunks.push(chunk);
        expectedOffset += chunk.size;
      } else if (chunk.start > expectedOffset) {
        console.log(
          `⚠️ Gap at ${expectedOffset}, missing ${chunk.start - expectedOffset} bytes`,
        );
        break;
      }
    }

    const isComplete = entry.totalSize && expectedOffset >= entry.totalSize;

    if (isComplete) {
      console.log(`✅ Complete video: ${url}`);
      return await this.reconstructVideo(url, contiguousChunks);
    }

    return null;
  }

  async reconstructVideo(url, chunks = null) {
    const entry = this.videoChunks.get(url);
    if (!entry) return null;

    const chunksToMerge =
      chunks || [...entry.chunks].sort((a, b) => a.start - b.start);
    if (chunksToMerge.length === 0) return null;

    const blobs = chunksToMerge.map((c) => c.blob);
    const mergedBlob = new Blob(blobs, {
      type: entry.contentType || "video/mp4",
    });

    return {
      blob: mergedBlob,
      url: URL.createObjectURL(mergedBlob),
      size: mergedBlob.size,
      chunksCount: chunksToMerge.length,
      isComplete: entry.totalSize ? mergedBlob.size >= entry.totalSize : false,
    };
  }

  async saveVideo(url, filename = null) {
    const result = await this.reconstructVideo(url);
    if (!result || result.size === 0) {
      console.error("No video data to save");
      return false;
    }

    if (!filename) {
      const urlParts = url.split("/");
      const originalName = urlParts[urlParts.length - 1].split("?")[0];
      filename = `reconstructed_${originalName}`;
      if (!filename.endsWith(".mp4")) filename += ".mp4";
    }

    chrome.downloads.download(
      {
        url: result.url,
        filename: filename,
        saveAs: true,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("Download failed:", chrome.runtime.lastError);
        } else {
          console.log(`💾 Saved: ${filename} (${result.size} bytes)`);
        }
        setTimeout(() => URL.revokeObjectURL(result.url), 1000);
      },
    );

    return true;
  }

  clear(url = null) {
    if (url) {
      this.videoChunks.delete(url);
    } else {
      this.videoChunks.clear();
    }
    console.log(`[Extractor] Cleared: ${url || "all"}`);
  }

  getStats() {
    const stats = {};
    for (const [url, entry] of this.videoChunks.entries()) {
      const totalChunksSize = entry.chunks.reduce((sum, c) => sum + c.size, 0);
      stats[url] = {
        chunksCount: entry.chunks.length,
        totalBytesCaptured: totalChunksSize,
        expectedTotalBytes: entry.totalSize,
        completeness: entry.totalSize
          ? `${Math.round((totalChunksSize / entry.totalSize) * 100)}%`
          : "unknown",
      };
    }
    return stats;
  }
}

const extractor = new ProgressiveMP4Extractor();

// Auto-attach debugger to tabs playing videos
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.startsWith("http")) {
    extractor.attachDebugger(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  extractor.detachDebugger(tabId);
});

// WebRequest listener (fallback)
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.type !== "media" && details.type !== "xmlhttprequest") {
      return { responseHeaders: details.responseHeaders };
    }

    if (extractor.detectRangeRequest(details)) {
      try {
        const response = await fetch(details.url, {
          headers: details.requestHeaders?.reduce((acc, h) => {
            acc[h.name] = h.value;
            return acc;
          }, {}),
        });
        const blob = await response.blob();
        await extractor.captureChunk(details, blob);
      } catch (e) {
        console.error(`[Listener] Fetch failed:`, e);
      }
    }

    return { responseHeaders: details.responseHeaders };
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest"] },
  ["responseHeaders", "requestHeaders", "blocking"],
);

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case "getStats":
      sendResponse(extractor.getStats());
      break;
    case "saveVideo":
      extractor.saveVideo(request.url, request.filename).then(sendResponse);
      return true;
    case "reconstruct":
      extractor.reconstructVideo(request.url).then(sendResponse);
      return true;
    case "clear":
      extractor.clear(request.url);
      sendResponse({ success: true });
      break;
    case "attachDebugger":
      extractor.attachDebugger(request.tabId).then(sendResponse);
      return true;
  }
  return true;
});

console.log("🎥 Progressive MP4 chunk extractor v2.0 loaded");
