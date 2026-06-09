// download-buttons.js - Download Manager for Video Cards
// Features: download_video_file (.mp4), download_video_chunks (.bin)
// Uses background service worker to bypass CORS restrictions
// ═══════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // Prevent double initialization
  if (window.__DOWNLOAD_BUTTONS_INITIALIZED__) {
    console.warn("[DownloadBtns] Already initialized, skipping");
    return;
  }
  window.__DOWNLOAD_BUTTONS_INITIALIZED__ = true;

  // ═══════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════
  const CONFIG = {
    // Chunk detection settings
    CHUNK_SAMPLE_INTERVAL_MS: 500,
    CHUNK_SCENE_THRESHOLD: 0.18,
    CHUNK_MIN_REGION_DURATION_S: 1.0,
    CHUNK_MERGE_GAP_S: 1.5,
    CHUNK_CANVAS_SIZE: 160,
    CHUNK_MAX_SAMPLES: 200,

    // Download settings
    DOWNLOAD_CHUNK_SIZE: 1024 * 1024,
    TOAST_DURATION_MS: 3500,

    // Background relay
    USE_STREAMING: true, // Stream with progress vs download all at once
    MESSAGE_TIMEOUT_MS: 60000, // 60s timeout for background response

    // Debug
    DEBUG: true,
  };

  // ═══════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  function log(message, data) {
    if (!CONFIG.DEBUG) return;
    const ts = new Date().toLocaleTimeString();
    const prefix = "[DownloadBtns]";
    if (data !== undefined) {
      console.log(`${prefix} [${ts}] ${message}`, data);
    } else {
      console.log(`${prefix} [${ts}] ${message}`);
    }
  }

  function showToast(message, type = "info") {
    const existing = document.querySelector(".dl-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `dl-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add("show");
    });

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 350);
    }, CONFIG.TOAST_DURATION_MS);
  }

  function sanitizeFilename(name) {
    return (
      name
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        .substring(0, 80) || "video"
    );
  }

  function getVideoSourceUrl(videoEl) {
    if (videoEl.currentSrc && videoEl.currentSrc.startsWith("http")) {
      return videoEl.currentSrc;
    }
    if (videoEl.src && videoEl.src.startsWith("http")) {
      return videoEl.src;
    }
    const sources = videoEl.querySelectorAll("source");
    for (const source of sources) {
      if (source.src && source.src.startsWith("http")) {
        return source.src;
      }
    }
    return null;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // ═══════════════════════════════════════════════════════════════
  // BACKGROUND RELAY COMMUNICATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send a message to the background service worker and wait for response.
   */
  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Background response timeout"));
      }, CONFIG.MESSAGE_TIMEOUT_MS);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          clearTimeout(timeout);

          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (response?.success) {
            resolve(response.data);
          } else {
            reject(new Error(response?.error || "Unknown background error"));
          }
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  /**
   * Reconstruct a Blob from base64 chunks received from background.
   */
  function base64ChunksToBlob(chunks, mimeType) {
    const uint8Chunks = chunks.map((base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    });

    // Concatenate
    const totalLength = uint8Chunks.reduce(
      (sum, chunk) => sum + chunk.length,
      0,
    );
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of uint8Chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return new Blob([combined], { type: mimeType });
  }

  /**
   * Fetch video via background service worker (bypasses CORS).
   * Returns { blob, size }.
   */
  async function fetchViaBackground(url, onProgress) {
    log(`Fetching via background: ${url.substring(0, 80)}...`);

    if (CONFIG.USE_STREAMING && onProgress) {
      // Set up progress listener
      const progressListener = (message) => {
        if (message.type === "DOWNLOAD_PROGRESS") {
          onProgress(message.received, message.total);
        }
      };

      chrome.runtime.onMessage.addListener(progressListener);

      try {
        const data = await sendToBackground({
          type: "DOWNLOAD_VIDEO",
          url,
          useStreaming: true,
        });

        // Clean up listener
        chrome.runtime.onMessage.removeListener(progressListener);

        const blob = base64ChunksToBlob(data.chunks, data.mimeType);
        return { blob, size: data.size };
      } catch (err) {
        chrome.runtime.onMessage.removeListener(progressListener);
        throw err;
      }
    } else {
      // Non-streaming: get all at once
      const data = await sendToBackground({
        type: "DOWNLOAD_VIDEO",
        url,
        useStreaming: false,
      });

      const blob = base64ChunksToBlob(data.chunks, data.mimeType);
      return { blob, size: data.size };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SCENE DETECTION ENGINE (unchanged from original)
  // ═══════════════════════════════════════════════════════════════

  async function detectVideoRegions(videoEl) {
    log("Starting region detection...");

    return new Promise((resolve, reject) => {
      const duration = videoEl.duration;
      if (!duration || isNaN(duration) || duration < 0.5) {
        log("Video too short for region detection, using single region");
        resolve([{ start: 0, end: duration || 0 }]);
        return;
      }

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const targetWidth = CONFIG.CHUNK_CANVAS_SIZE;
      const aspectRatio = videoEl.videoWidth / videoEl.videoHeight || 16 / 9;
      const targetHeight = Math.round(targetWidth / aspectRatio);
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const sampleInterval = CONFIG.CHUNK_SAMPLE_INTERVAL_MS / 1000;
      const numSamples = Math.min(
        Math.floor(duration / sampleInterval),
        CONFIG.CHUNK_MAX_SAMPLES,
      );

      const samples = [];
      const originalTime = videoEl.currentTime;
      const wasPaused = videoEl.paused;
      let sampleIndex = 0;
      let lastPixelData = null;
      const regions = [];
      let currentRegion = null;

      log(
        `Video duration: ${duration.toFixed(1)}s, samples: ${numSamples}, ` +
          `resolution: ${videoEl.videoWidth}x${videoEl.videoHeight}`,
      );

      function captureFrame() {
        if (sampleIndex >= numSamples) {
          finishDetection();
          return;
        }

        const seekTime = sampleIndex * sampleInterval;
        if (seekTime >= duration) {
          sampleIndex++;
          captureFrame();
          return;
        }

        videoEl.currentTime = seekTime;
      }

      function onSeeked() {
        const seekTime = videoEl.currentTime;

        ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight);
        const pixelData = ctx.getImageData(
          0,
          0,
          targetWidth,
          targetHeight,
        ).data;

        const hasSceneChange = lastPixelData
          ? detectSceneChange(
              lastPixelData,
              pixelData,
              targetWidth,
              targetHeight,
            )
          : false;

        samples.push({ time: seekTime, hasSceneChange, pixelData });
        lastPixelData = pixelData;

        if (hasSceneChange || currentRegion === null) {
          if (
            currentRegion &&
            currentRegion.end - currentRegion.start >=
              CONFIG.CHUNK_MIN_REGION_DURATION_S
          ) {
            regions.push({ ...currentRegion });
          }
          currentRegion = { start: seekTime, end: seekTime };
        } else if (currentRegion) {
          currentRegion.end = seekTime;
        }

        sampleIndex++;
        setTimeout(captureFrame, 30);
      }

      function finishDetection() {
        if (
          currentRegion &&
          currentRegion.end - currentRegion.start >=
            CONFIG.CHUNK_MIN_REGION_DURATION_S
        ) {
          regions.push({ ...currentRegion });
        }

        const mergedRegions = mergeNearbyRegions(regions);

        videoEl.currentTime = originalTime;
        if (wasPaused) videoEl.pause();

        videoEl.removeEventListener("seeked", onSeeked);

        log(
          `Region detection complete: ${mergedRegions.length} regions found`,
          mergedRegions.map(
            (r) => `[${r.start.toFixed(1)}s - ${r.end.toFixed(1)}s]`,
          ),
        );

        resolve(mergedRegions);
      }

      function onError(err) {
        videoEl.removeEventListener("seeked", onSeeked);
        videoEl.currentTime = originalTime;
        if (wasPaused) videoEl.pause();
        log(`Region detection error: ${err.message}`);
        reject(err);
      }

      videoEl.addEventListener("seeked", onSeeked);
      videoEl.addEventListener("error", onError, { once: true });

      captureFrame();
    });
  }

  function detectSceneChange(prevData, currData, width, height) {
    const totalPixels = width * height;
    let diffCount = 0;
    const sampleStep = 4;

    for (let i = 0; i < prevData.length; i += sampleStep * 4) {
      const rDiff = Math.abs(prevData[i] - currData[i]);
      const gDiff = Math.abs(prevData[i + 1] - currData[i + 1]);
      const bDiff = Math.abs(prevData[i + 2] - currData[i + 2]);

      if (rDiff > 30 || gDiff > 30 || bDiff > 30) {
        diffCount++;
      }
    }

    const sampledPixels = Math.floor(totalPixels / sampleStep);
    const diffRatio = diffCount / sampledPixels;

    return diffRatio > CONFIG.CHUNK_SCENE_THRESHOLD;
  }

  function mergeNearbyRegions(regions) {
    if (regions.length <= 1) return regions;

    const merged = [];
    let current = { ...regions[0] };

    for (let i = 1; i < regions.length; i++) {
      const gap = regions[i].start - current.end;
      if (gap <= CONFIG.CHUNK_MERGE_GAP_S) {
        current.end = regions[i].end;
      } else {
        merged.push(current);
        current = { ...regions[i] };
      }
    }

    merged.push(current);
    return merged;
  }

  // ═══════════════════════════════════════════════════════════════
  // CHUNK EXTRACTION & MERGING (unchanged from original)
  // ═══════════════════════════════════════════════════════════════

  async function extractAndMergeRegions(videoEl, regions, onProgress) {
    log(`Extracting ${regions.length} regions...`);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const captureWidth = CONFIG.CHUNK_CANVAS_SIZE;
    const aspectRatio = videoEl.videoWidth / videoEl.videoHeight || 16 / 9;
    const captureHeight = Math.round(captureWidth / aspectRatio);
    canvas.width = captureWidth;
    canvas.height = captureHeight;

    const originalTime = videoEl.currentTime;
    const wasPaused = videoEl.paused;

    const headerSize = 64;
    const regionIndexEntrySize = 16;
    const regionIndexSize = regions.length * regionIndexEntrySize;
    const dataOffset = headerSize + regionIndexSize;

    const allRegionData = [];
    let totalFrames = 0;

    for (let regionIdx = 0; regionIdx < regions.length; regionIdx++) {
      const region = regions[regionIdx];
      const regionDuration = region.end - region.start;
      const frameInterval = 0.5;
      const numFrames = Math.max(1, Math.floor(regionDuration / frameInterval));

      const frames = [];

      for (let f = 0; f < numFrames; f++) {
        const seekTime = region.start + f * frameInterval;
        if (seekTime > videoEl.duration) break;

        videoEl.currentTime = seekTime;

        await new Promise((resolve) => {
          const onSeeked = () => {
            videoEl.removeEventListener("seeked", onSeeked);
            resolve();
          };
          videoEl.addEventListener("seeked", onSeeked);
          setTimeout(() => {
            videoEl.removeEventListener("seeked", onSeeked);
            resolve();
          }, 2000);
        });

        ctx.drawImage(videoEl, 0, 0, captureWidth, captureHeight);
        const frameData = ctx.getImageData(0, 0, captureWidth, captureHeight);
        frames.push({
          width: captureWidth,
          height: captureHeight,
          pixels: new Uint8Array(frameData.data.buffer.slice(0)),
        });
        totalFrames++;

        if (onProgress) {
          onProgress(regionIdx + 1, regions.length, f + 1, numFrames);
        }
      }

      allRegionData.push({ start: region.start, end: region.end, frames });
    }

    videoEl.currentTime = originalTime;
    if (wasPaused) videoEl.pause();

    let totalDataSize = dataOffset;
    for (const region of allRegionData) {
      totalDataSize += 4;
      for (const frame of region.frames) {
        totalDataSize += 2 + 2 + 4 + frame.pixels.length;
      }
    }

    const buffer = new ArrayBuffer(totalDataSize);
    const view = new DataView(buffer);
    let offset = 0;

    const encoder = new TextEncoder();
    const magicBytes = encoder.encode("NSFWCHNK");
    new Uint8Array(buffer, offset, 8).set(magicBytes);
    offset += 8;
    view.setUint32(offset, 1, true);
    offset += 4;
    view.setUint32(offset, regions.length, true);
    offset += 4;
    view.setUint32(offset, Math.round(videoEl.duration * 1000), true);
    offset += 4;
    offset = headerSize;

    for (const region of allRegionData) {
      view.setFloat64(offset, region.start * 1000, true);
      offset += 8;
      view.setFloat64(offset, region.end * 1000, true);
      offset += 8;
    }

    offset = dataOffset;
    const uint8View = new Uint8Array(buffer);

    for (const region of allRegionData) {
      view.setUint32(offset, region.frames.length, true);
      offset += 4;

      for (const frame of region.frames) {
        view.setUint16(offset, frame.width, true);
        offset += 2;
        view.setUint16(offset, frame.height, true);
        offset += 2;
        view.setUint32(offset, frame.pixels.length, true);
        offset += 4;
        uint8View.set(frame.pixels, offset);
        offset += frame.pixels.length;
      }
    }

    log(
      `Binary built: ${(totalDataSize / 1024 / 1024).toFixed(2)}MB, ${totalFrames} frames`,
    );

    return new Blob([buffer], { type: "application/octet-stream" });
  }

  // ═══════════════════════════════════════════════════════════════
  // DOWNLOAD HANDLERS (UPDATED to use background relay)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Download the full video as an .mp4 file via background relay.
   */
  async function downloadVideoFile(videoEl, buttonEl) {
    const url = getVideoSourceUrl(videoEl);
    if (!url) {
      log("No video source URL found");
      showToast("❌ No video source found", "error");
      updateButtonState(buttonEl, "error");
      return;
    }

    const videoId = videoEl.dataset.videoObserverId || "unknown";
    const filename = sanitizeFilename(videoId) + ".mp4";

    log(`Starting MP4 download (via background): ${videoId} → ${filename}`);

    try {
      updateButtonState(buttonEl, "downloading", "0%");

      const { blob, size } = await fetchViaBackground(
        url,
        (received, total) => {
          const percent = Math.round((received / total) * 100);
          updateButtonState(buttonEl, "downloading", `${percent}%`);
        },
      );

      downloadBlob(blob, filename);

      const sizeMB = (size / 1024 / 1024).toFixed(1);
      log(`MP4 download complete: ${filename} (${sizeMB}MB)`);
      showToast(`✅ Downloaded ${filename} (${sizeMB}MB)`, "success");
      updateButtonState(buttonEl, "success", "✓");
    } catch (err) {
      log(`MP4 download failed: ${err.message}`);
      showToast(`❌ Download failed: ${err.message}`, "error");
      updateButtonState(buttonEl, "error", "✕");
    }

    setTimeout(() => {
      if (
        buttonEl.dataset.state === "success" ||
        buttonEl.dataset.state === "error"
      ) {
        updateButtonState(buttonEl, "default", "");
      }
    }, 4000);
  }

  /**
   * Download video chunks as a merged .bin file via background relay.
   */
  async function downloadVideoChunks(videoEl, buttonEl) {
    const url = getVideoSourceUrl(videoEl);
    if (!url) {
      log("No video source URL found");
      showToast("❌ No video source found", "error");
      updateButtonState(buttonEl, "error");
      return;
    }

    const videoId = videoEl.dataset.videoObserverId || "unknown";
    const filename = sanitizeFilename(videoId) + "_chunks.bin";

    log(`Starting chunks download (via background): ${videoId} → ${filename}`);

    try {
      updateButtonState(buttonEl, "downloading", "fetching...");

      // Fetch video via background
      const { blob } = await fetchViaBackground(url, (received, total) => {
        const percent = Math.round((received / total) * 30);
        updateButtonState(buttonEl, "downloading", `${percent}%`);
      });

      // Create temporary video element for analysis
      const tempVideo = document.createElement("video");
      tempVideo.src = URL.createObjectURL(blob);
      tempVideo.preload = "auto";
      tempVideo.muted = true;
      tempVideo.style.display = "none";
      document.body.appendChild(tempVideo);

      // Wait for metadata
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          tempVideo.removeEventListener("loadedmetadata", onMeta);
          reject(new Error("Metadata load timeout"));
        }, 10000);
        const onMeta = () => {
          clearTimeout(timeout);
          resolve();
        };
        tempVideo.addEventListener("loadedmetadata", onMeta, { once: true });
      });

      log(
        `Temp video ready: ${tempVideo.duration.toFixed(1)}s, ${tempVideo.videoWidth}x${tempVideo.videoHeight}`,
      );

      // Detect regions
      updateButtonState(buttonEl, "downloading", "detecting...");
      const regions = await detectVideoRegions(tempVideo);

      if (regions.length === 0) {
        showToast("⚠️ No distinct regions found, using single region", "info");
        regions.push({ start: 0, end: tempVideo.duration });
      }

      // Extract and merge regions
      updateButtonState(buttonEl, "downloading", "extracting...");
      const mergedBlob = await extractAndMergeRegions(
        tempVideo,
        regions,
        (regionIdx, totalRegions, frameIdx, totalFrames) => {
          const basePercent = 30;
          const extractionPercent = 70;
          const regionProgress = (regionIdx - 1) / totalRegions;
          const frameProgress = frameIdx / totalFrames / totalRegions;
          const percent = Math.round(
            basePercent + (regionProgress + frameProgress) * extractionPercent,
          );
          updateButtonState(
            buttonEl,
            "downloading",
            `${Math.min(99, percent)}%`,
          );
        },
      );

      // Cleanup
      URL.revokeObjectURL(tempVideo.src);
      document.body.removeChild(tempVideo);

      // Download
      updateButtonState(buttonEl, "downloading", "saving...");
      downloadBlob(mergedBlob, filename);

      const sizeMB = (mergedBlob.size / 1024 / 1024).toFixed(1);
      log(
        `Chunks download complete: ${filename} (${sizeMB}MB, ${regions.length} regions)`,
      );
      showToast(
        `✅ Downloaded ${filename} (${sizeMB}MB, ${regions.length} regions)`,
        "success",
      );
      updateButtonState(buttonEl, "success", "✓");
    } catch (err) {
      log(`Chunks download failed: ${err.message}`);
      showToast(`❌ Chunks failed: ${err.message}`, "error");
      updateButtonState(buttonEl, "error", "✕");

      const tempVideo = document.querySelector("video[style*='display: none']");
      if (tempVideo && tempVideo.src.startsWith("blob:")) {
        URL.revokeObjectURL(tempVideo.src);
        tempVideo.remove();
      }
    }

    setTimeout(() => {
      if (
        buttonEl.dataset.state === "success" ||
        buttonEl.dataset.state === "error"
      ) {
        updateButtonState(buttonEl, "default", "");
      }
    }, 4000);
  }

  /**
   * Update button visual state (unchanged).
   */
  function updateButtonState(buttonEl, state, text) {
    buttonEl.classList.remove("downloading", "success", "error");

    if (state === "default") {
      buttonEl.dataset.state = "";
      const originalText =
        buttonEl.dataset.originalText || buttonEl.textContent;
      buttonEl.innerHTML = originalText;
    } else {
      buttonEl.classList.add(state);
      buttonEl.dataset.state = state;

      if (!buttonEl.dataset.originalText) {
        buttonEl.dataset.originalText = buttonEl.innerHTML;
      }

      if (state === "downloading" && text) {
        buttonEl.innerHTML = `
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:12px;height:12px;flex-shrink:0;">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="31.4 31.4">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
            </circle>
          </svg>
          <span class="dl-progress">${text}</span>
        `;
      } else if (state === "success") {
        buttonEl.innerHTML = `
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:12px;height:12px;flex-shrink:0;">
            <polyline points="20 6 9 17 4 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          ${text || "✓"}
        `;
      } else if (state === "error") {
        buttonEl.innerHTML = `
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:12px;height:12px;flex-shrink:0;">
            <line x1="18" y1="6" x2="6" y2="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="6" y1="6" x2="18" y2="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          ${text || "✕"}
        `;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BUTTON INJECTION (unchanged)
  // ═══════════════════════════════════════════════════════════════

  function injectDownloadButtons(card, videoEl) {
    if (card.querySelector(".video-actions-row")) {
      return;
    }

    const actionsRow = document.createElement("div");
    actionsRow.className = "video-actions-row";

    const mp4Btn = document.createElement("button");
    mp4Btn.className = "download-btn dl-mp4-btn";
    mp4Btn.title = "Download full .mp4 video";
    mp4Btn.dataset.originalText = "⬇ MP4";
    mp4Btn.innerHTML = "⬇ MP4";
    mp4Btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (mp4Btn.dataset.state === "downloading") return;
      downloadVideoFile(videoEl, mp4Btn);
    });

    const chunksBtn = document.createElement("button");
    chunksBtn.className = "download-btn dl-chunks-btn";
    chunksBtn.title = "Download merged chunks as .bin";
    chunksBtn.dataset.originalText = "⬇ Chunks";
    chunksBtn.innerHTML = "⬇ Chunks";
    chunksBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (chunksBtn.dataset.state === "downloading") return;
      downloadVideoChunks(videoEl, chunksBtn);
    });

    actionsRow.appendChild(mp4Btn);
    actionsRow.appendChild(chunksBtn);
    card.appendChild(actionsRow);

    log(
      `Download buttons injected for ${videoEl.dataset.videoObserverId || "unknown"}`,
    );
  }

  function scanAndInject() {
    const panel = document.getElementById("video-observer-panel");
    if (!panel) return;

    const cards = panel.querySelectorAll(".video-card");
    let injected = 0;

    for (const card of cards) {
      const videoId = card.dataset.videoId;
      if (!videoId) continue;

      const videoEl = document.querySelector(
        `video[data-video-observer-id="${videoId}"]`,
      );
      if (!videoEl) continue;

      if (!card.querySelector(".video-actions-row")) {
        injectDownloadButtons(card, videoEl);
        injected++;
      }
    }

    if (injected > 0) {
      log(`Injected buttons into ${injected} cards`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════

  function init() {
    log("Download buttons module initializing...");

    setTimeout(scanAndInject, 1500);

    const panel = document.getElementById("video-observer-panel");
    if (panel) {
      const observer = new MutationObserver((mutations) => {
        let hasNewCards = false;
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              if (
                node.classList?.contains("video-card") ||
                node.querySelector?.(".video-card")
              ) {
                hasNewCards = true;
                break;
              }
            }
          }
          if (hasNewCards) break;
        }
        if (hasNewCards) {
          setTimeout(scanAndInject, 300);
        }
      });

      const videosList = panel.querySelector("#videos-list");
      if (videosList) {
        observer.observe(videosList, {
          childList: true,
          subtree: true,
        });
        log("Observer attached to videos-list");
      }
    } else {
      log("Panel not found, watching for creation...");
      const bodyObserver = new MutationObserver(() => {
        const panelEl = document.getElementById("video-observer-panel");
        if (panelEl) {
          bodyObserver.disconnect();
          log("Panel detected, initializing...");
          setTimeout(scanAndInject, 1000);
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    log("Download buttons module ready (background relay mode)");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  window.DownloadButtons = {
    downloadVideoFile,
    downloadVideoChunks,
    injectDownloadButtons,
    scanAndInject,
    getVideoSourceUrl,
    detectVideoRegions,
    extractAndMergeRegions,
    fetchViaBackground,
    CONFIG,
  };

  console.log(
    "[DownloadBtns] ✅ Module loaded - API available at window.DownloadButtons",
  );
})();
