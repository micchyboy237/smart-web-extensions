// popup.js - UI with live monitor (Updated for v3.3 stats format)
console.log("[Popup] Script loaded v3.3");

// DOM Elements
const statusDiv = document.getElementById("status");
const autoRefreshToggle = document.getElementById("autoRefreshToggle");
const refreshMonitorBtn = document.getElementById("refreshMonitorBtn");
const showVideosBtn = document.getElementById("showVideosBtn");
const clearAllBtn = document.getElementById("clearAllBtn");

// Live monitor elements
const activeVideosCountEl = document.getElementById("activeVideosCount");
const totalChunksCountEl = document.getElementById("totalChunksCount");
const totalDataSizeEl = document.getElementById("totalDataSize");
const liveVideoListEl = document.getElementById("liveVideoList");

// State
let autoRefreshInterval = null;
let currentStats = null;

/**
 * Show status message
 */
function showStatus(message, type = "info") {
  console.log(`[Popup] Status: ${type} - ${message}`);
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  statusDiv.style.display = "block";
  setTimeout(() => {
    if (statusDiv.style.display === "block") {
      statusDiv.style.display = "none";
    }
  }, 3000);
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0";
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(1);
}

/**
 * Extract filename from URL
 */
function getShortName(url, maxLen = 40) {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/");
    let filename = pathParts[pathParts.length - 1];
    if (!filename || filename.length === 0) filename = "video";
    if (filename.includes("?")) filename = filename.split("?")[0];
    if (filename.length > maxLen) {
      filename = filename.substring(0, maxLen - 3) + "...";
    }
    return filename;
  } catch {
    return url.substring(0, maxLen);
  }
}

/**
 * Fetch stats from background
 */
async function fetchStats() {
  try {
    const stats = await chrome.runtime.sendMessage({ action: "getStats" });
    currentStats = stats;
    console.log(
      `[Popup] Received stats: ${Object.keys(stats || {}).length} videos`,
    );
    updateLiveMonitor(stats);
    return stats;
  } catch (error) {
    console.error("[Popup] Failed to fetch stats:", error);
    return null;
  }
}

/**
 * Update live monitor UI
 */
function updateLiveMonitor(stats) {
  if (!stats || Object.keys(stats).length === 0) {
    activeVideosCountEl.textContent = "0";
    totalChunksCountEl.textContent = "0";
    totalDataSizeEl.innerHTML = '0<span class="stat-unit">MB</span>';
    liveVideoListEl.innerHTML = `
      <div class="empty-state">🎬 No videos detected yet<br><small>Play a video to start capturing</small></div>
    `;
    return;
  }

  const videoCount = Object.keys(stats).length;
  let totalChunks = 0;
  let totalBytes = 0;

  for (const [url, videoStats] of Object.entries(stats)) {
    totalChunks += videoStats.chunksCount;
    totalBytes += videoStats.totalBytesCaptured;
  }

  activeVideosCountEl.textContent = videoCount;
  totalChunksCountEl.textContent = totalChunks;
  totalDataSizeEl.innerHTML = `${formatBytes(totalBytes)}<span class="stat-unit">MB</span>`;

  // Build video list
  let videosHtml = "";
  for (const [url, videoStats] of Object.entries(stats)) {
    const sizeMB = formatBytes(videoStats.totalBytesCaptured);
    const shortName = videoStats.filename || getShortName(url, 35);

    // Determine status icon and progress
    let statusIcon = "🎬"; // Detected but no data
    let progressPercent = 0;

    if (videoStats.hasChunks && videoStats.chunksCount > 0) {
      statusIcon = "📦"; // Has captured data
      // Extract percentage from completeness string if available
      const percentMatch = videoStats.completeness.match(/(\d+(?:\.\d+)?)/);
      progressPercent = percentMatch
        ? Math.min(100, parseFloat(percentMatch[1]))
        : 10;
    }

    videosHtml += `
      <div class="video-item" data-url="${escapeHtml(url)}" title="${escapeHtml(url)}">
        <div class="video-url">
          ${statusIcon} ${escapeHtml(shortName)}
        </div>
        <div class="video-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${Math.max(5, progressPercent)}%"></div>
          </div>
          <div class="chunk-badge">
            ${
              videoStats.chunksCount > 0
                ? `${videoStats.chunksCount} chunks | ${sizeMB}MB`
                : "detected"
            }
          </div>
        </div>
        <div style="font-size: 8px; opacity: 0.8; margin-top: 4px;">
          ${videoStats.completeness}
        </div>
      </div>
    `;
  }

  liveVideoListEl.innerHTML = videosHtml;

  console.log(
    `[Popup] Updated monitor: ${videoCount} videos, ${totalChunks} chunks, ${formatBytes(totalBytes)}MB`,
  );
}

/**
 * Escape HTML
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Render full captured videos list
 */
async function renderCapturedVideos() {
  console.log("[Popup] Fetching videos...");
  showStatus("Loading videos...", "info");

  const stats = await fetchStats();
  const capturedDiv = document.getElementById("capturedVideos");

  if (!stats || Object.keys(stats).length === 0) {
    capturedDiv.innerHTML =
      '<div class="empty-state">No videos captured yet.<br>Play a video on any website to start capturing.</div>';
    showStatus("No videos found", "info");
    return;
  }

  let html = "";
  let saveableCount = 0;

  for (const [url, videoStats] of Object.entries(stats)) {
    const sizeMB = (videoStats.totalBytesCaptured / 1024 / 1024).toFixed(2);
    const expectedMB = videoStats.expectedTotalBytes
      ? (videoStats.expectedTotalBytes / 1024 / 1024).toFixed(2)
      : "unknown";
    const hasData = videoStats.hasChunks && videoStats.chunksCount > 0;

    if (hasData) saveableCount++;

    html += `
      <div class="video-entry">
        <div class="video-url-full">🔗 ${escapeHtml(url)}</div>
        <div class="video-stats">
          <span>📦 Chunks: ${videoStats.chunksCount}</span>
          <span>💾 Size: ${sizeMB} MB</span>
          <span>📊 Status: ${videoStats.completeness}</span>
          <span>🔍 Source: ${videoStats.source || "unknown"}</span>
          ${videoStats.expectedTotalBytes ? `<span>🎯 Expected: ${expectedMB} MB</span>` : ""}
          ${!hasData ? '<span style="color: #ff9800;">⏳ Waiting for data...</span>' : ""}
        </div>
        <div class="btn-group">
          <button class="save-btn" data-url="${escapeHtml(url)}" ${!hasData ? "disabled" : ""}>
            ${hasData ? "💾 Save Video" : "⏳ No data yet"}
          </button>
        </div>
      </div>
    `;
  }

  capturedDiv.innerHTML = html;

  // Add save button handlers
  document.querySelectorAll(".save-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;

      const url = btn.getAttribute("data-url");
      console.log(`[Popup] Saving: ${url}`);

      btn.textContent = "⏳ Saving...";
      btn.disabled = true;

      const response = await chrome.runtime.sendMessage({
        action: "saveVideo",
        url: url,
        filename: `video_${Date.now()}.mp4`,
      });

      if (response) {
        btn.textContent = "✓ Saved!";
        showStatus("Video saved successfully!", "success");
      } else {
        btn.textContent = "❌ Failed";
        showStatus("Failed to save video", "error");
      }

      setTimeout(() => {
        btn.textContent = "💾 Save Video";
        btn.disabled = false;
      }, 2000);
    });
  });

  showStatus(
    `Found ${Object.keys(stats).length} video(s) - ${saveableCount} ready to save`,
    "success",
  );
}

/**
 * Clear all videos
 */
async function clearAll() {
  console.log("[Popup] Clearing all videos...");
  await chrome.runtime.sendMessage({ action: "clear" });
  document.getElementById("capturedVideos").innerHTML =
    '<div class="empty-state">Cleared. Play a video to start capturing.</div>';
  await fetchStats();
  showStatus("All videos cleared", "success");
}

/**
 * Start auto-refresh
 */
function startAutoRefresh() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);

  if (autoRefreshToggle.checked) {
    autoRefreshInterval = setInterval(() => {
      fetchStats();
    }, 2000);
    console.log("[Popup] Auto-refresh started");
  }
}

/**
 * Stop auto-refresh
 */
function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
    console.log("[Popup] Auto-refresh stopped");
  }
}

// Event listeners
refreshMonitorBtn.addEventListener("click", async () => {
  await fetchStats();
  showStatus("Monitor refreshed", "success");
});

showVideosBtn.addEventListener("click", async () => {
  await renderCapturedVideos();
});

clearAllBtn.addEventListener("click", async () => {
  await clearAll();
});

autoRefreshToggle.addEventListener("change", () => {
  if (autoRefreshToggle.checked) {
    startAutoRefresh();
    fetchStats();
  } else {
    stopAutoRefresh();
  }
});

// Initialize
(async () => {
  console.log("[Popup] Initializing v3.3...");

  // Initial fetch
  await fetchStats();

  // Start auto-refresh if enabled
  if (autoRefreshToggle.checked) {
    startAutoRefresh();
  }

  // Check if content script is active
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: "ping",
      });
      console.log("[Popup] Content script active:", response);
    } catch (error) {
      console.log(
        "[Popup] Content script not responding - refresh the page if videos aren't detected",
      );
    }
  }

  console.log("[Popup] Ready");
})();
