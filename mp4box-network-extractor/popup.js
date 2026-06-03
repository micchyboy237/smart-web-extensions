// popup.js - Main popup logic

console.log("[MP4Box Extractor] Popup opened");

let detectedMP4s = [];
let extractedData = [];
let logs = [];
let currentTabId = null;

// DOM Elements
const mp4ListEl = document.getElementById("mp4List");
const detectedCountEl = document.getElementById("detectedCount");
const parsedCountEl = document.getElementById("parsedCount");
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("searchInput");
const statusFilter = document.getElementById("statusFilter");
const logsContentEl = document.getElementById("logsContent");
const clearLogsBtn = document.getElementById("clearLogsBtn");
const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");

// Add log entry
function addLog(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, message, type };
  logs.unshift(logEntry);

  // Keep only last 100 logs
  if (logs.length > 100) logs.pop();

  renderLogs();
  console.log(`[MP4Box Extractor] ${type.toUpperCase()}: ${message}`);
}

// Render logs
function renderLogs() {
  logsContentEl.innerHTML = logs
    .map(
      (log) => `
    <div class="log-entry log-${log.type}">
      <span class="log-time">[${log.timestamp}]</span>
      <span class="log-message">${escapeHtml(log.message)}</span>
    </div>
  `,
    )
    .join("");

  // Auto-scroll to top
  logsContentEl.scrollTop = 0;
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Format bytes
function formatBytes(bytes) {
  if (!bytes) return "Unknown";
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

// Format duration
function formatDuration(seconds) {
  if (!seconds) return "Unknown";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

// Render MP4 list
function renderMP4List() {
  const searchTerm = searchInput.value.toLowerCase();
  const status = statusFilter.value;

  let filteredMP4s = detectedMP4s;

  // Apply search filter
  if (searchTerm) {
    filteredMP4s = filteredMP4s.filter((mp4) =>
      mp4.url.toLowerCase().includes(searchTerm),
    );
  }

  // Apply status filter
  if (status !== "all") {
    filteredMP4s = filteredMP4s.filter((mp4) =>
      status === "parsed" ? mp4.parsed : mp4.status === status,
    );
  }

  if (filteredMP4s.length === 0) {
    mp4ListEl.innerHTML = '<div class="no-data">No MP4 files detected</div>';
    return;
  }

  mp4ListEl.innerHTML = filteredMP4s
    .map((mp4) => {
      const parsed = extractedData.find((d) => d.requestId === mp4.requestId);
      const isParsed = !!parsed;

      // Determine status class
      let statusClass = "status-" + mp4.status;
      if (isParsed) statusClass = "status-parsed";

      return `
      <div class="mp4-item" data-request-id="${mp4.requestId}">
        <div class="mp4-header">
          <div class="mp4-url" title="${escapeHtml(mp4.url)}">
            📹 ${escapeHtml(mp4.url.substring(0, 100))}${mp4.url.length > 100 ? "..." : ""}
          </div>
          <div class="mp4-status ${statusClass}">
            ${isParsed ? "✓ Parsed" : mp4.status}
          </div>
        </div>
        
        <div class="mp4-details">
          <div class="detail-row">
            <span class="detail-label">Time:</span>
            <span class="detail-value">${new Date(mp4.timestamp).toLocaleTimeString()}</span>
            
            ${mp4.statusCode ? `<span class="detail-label">Status:</span><span class="detail-value">${mp4.statusCode}</span>` : ""}
            
            ${mp4.contentLength ? `<span class="detail-label">Size:</span><span class="detail-value">${formatBytes(mp4.contentLength)}</span>` : ""}
          </div>
          
          ${
            mp4.isPartialContent
              ? `
            <div class="detail-row">
              <span class="detail-label">Partial Range:</span>
              <span class="detail-value highlight">${mp4.contentRange || "Yes"}</span>
            </div>
          `
              : ""
          }
          
          ${
            isParsed
              ? `
            <div class="detail-row">
              <span class="detail-label">Duration:</span>
              <span class="detail-value">${formatDuration(parsed.durationSec)}</span>
              
              <span class="detail-label">Tracks:</span>
              <span class="detail-value">${parsed.tracks.length}</span>
            </div>
            
            ${
              parsed.videoTracks.length > 0
                ? `
              <div class="detail-row">
                <span class="detail-label">Video:</span>
                <span class="detail-value">
                  ${parsed.videoTracks[0].width}x${parsed.videoTracks[0].height} | 
                  ${parsed.videoTracks[0].codec}
                </span>
              </div>
            `
                : ""
            }
            
            ${
              parsed.audioTracks.length > 0
                ? `
              <div class="detail-row">
                <span class="detail-label">Audio:</span>
                <span class="detail-value">
                  ${parsed.audioTracks[0].channelCount}ch | 
                  ${parsed.audioTracks[0].sampleRate / 1000}kHz | 
                  ${parsed.audioTracks[0].codec}
                </span>
              </div>
            `
                : ""
            }
            
            <div class="detail-row">
              <span class="detail-label">Structure:</span>
              <span class="detail-value">
                ${parsed.hasMoov ? "✓ moov" : "✗ moov"} | 
                ${parsed.hasMdat ? "✓ mdat" : "✗ mdat"} |
                ${parsed.isFragmented ? "Fragmented" : "Progressive"}
              </span>
            </div>
          `
              : `
            <button class="btn-parse" data-url="${escapeHtml(mp4.url)}" data-request-id="${mp4.requestId}">
              🔍 Parse with MP4Box
            </button>
          `
          }
        </div>
      </div>
    `;
    })
    .join("");

  // Add event listeners for parse buttons
  document.querySelectorAll(".btn-parse").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const url = btn.getAttribute("data-url");
      const requestId = btn.getAttribute("data-request-id");
      await parseMP4(url, requestId);
    });
  });

  // Update stats
  const parsedCount = extractedData.length;
  detectedCountEl.textContent = detectedMP4s.length;
  parsedCountEl.textContent = parsedCount;
}

// Parse MP4 with MP4Box
async function parseMP4(url, requestId) {
  addLog(`Parsing MP4: ${url.substring(0, 100)}...`, "info");
  statusText.textContent = "Parsing...";
  statusIndicator.style.backgroundColor = "#ff9800";

  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    // Send message to content script
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "PARSE_MP4",
      url: url,
      requestId: requestId,
    });

    if (response.success) {
      addLog(
        `✓ Successfully parsed MP4: ${url.substring(0, 80)}...`,
        "success",
      );
      statusText.textContent = "Parsing Complete";
      statusIndicator.style.backgroundColor = "#4caf50";

      // Refresh extracted data
      await loadExtractedData();
      setTimeout(() => {
        statusText.textContent = "Monitoring";
        statusIndicator.style.backgroundColor = "#4caf50";
      }, 2000);
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    addLog(`✗ Failed to parse MP4: ${error.message}`, "error");
    statusText.textContent = "Parse Failed";
    statusIndicator.style.backgroundColor = "#f44336";
    setTimeout(() => {
      statusText.textContent = "Monitoring";
      statusIndicator.style.backgroundColor = "#4caf50";
    }, 3000);
  }
}

// Load detected MP4s from background
async function loadDetectedMP4s() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_MP4_DATA" });
    if (response && response.mp4s) {
      detectedMP4s = response.mp4s;
      addLog(`Loaded ${detectedMP4s.length} detected MP4 files`, "info");
      renderMP4List();
    }
  } catch (error) {
    console.error("Failed to load MP4s:", error);
    addLog(`Failed to load MP4s: ${error.message}`, "error");
  }
}

// Load extracted data from content script
async function loadExtractedData() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_EXTRACTED_DATA",
    });
    if (response && response.data) {
      extractedData = response.data;
      addLog(
        `Loaded ${extractedData.length} MP4Box extraction results`,
        "info",
      );
      renderMP4List();
    }
  } catch (error) {
    console.error("Failed to load extracted data:", error);
  }
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "MP4_DETECTED") {
    addLog(`Detected MP4: ${message.data.url.substring(0, 80)}...`, "info");
    loadDetectedMP4s();
  } else if (message.type === "MP4_HEADERS_RECEIVED") {
    addLog(
      `Headers received for: ${message.data.url.substring(0, 80)}...`,
      "info",
    );
    loadDetectedMP4s();
  } else if (message.type === "MP4_COMPLETED") {
    addLog(`Completed: ${message.data.url.substring(0, 80)}...`, "success");
    loadDetectedMP4s();
  } else if (message.type === "MP4_ERROR") {
    addLog(
      `Error for ${message.data.url.substring(0, 80)}...: ${message.data.error}`,
      "error",
    );
    loadDetectedMP4s();
  } else if (message.type === "MP4BOX_EXTRACTED") {
    addLog(
      `✓ MP4Box extracted data for: ${message.data.url.substring(0, 80)}...`,
      "success",
    );
    loadExtractedData();
  }
});

// Refresh button
refreshBtn.addEventListener("click", () => {
  addLog("Manual refresh triggered", "info");
  loadDetectedMP4s();
  loadExtractedData();
});

// Clear logs button
clearLogsBtn.addEventListener("click", () => {
  logs = [];
  addLog("Logs cleared", "info");
  renderLogs();
});

// Search input debounce
let searchTimeout;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    renderMP4List();
  }, 300);
});

// Status filter
statusFilter.addEventListener("change", () => {
  renderMP4List();
});

// Initialize
async function init() {
  addLog("Extension popup initialized", "info");
  await loadDetectedMP4s();
  await loadExtractedData();

  // Update status
  statusText.textContent = "Monitoring";
  statusIndicator.style.backgroundColor = "#4caf50";
}

// Start
init();
