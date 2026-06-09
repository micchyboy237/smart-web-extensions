// popup.js - Enhanced with video filtering and download functionality
class PopupManager {
  constructor() {
    this.logEntries = [];
    this.filterVideosOnly = false;
    this.videoResponses = [];
    this.initializeElements();
    this.attachEventListeners();
    this.loadLogs();
    this.setupMessageListener();
    console.log("[Popup] Popup manager initialized");
  }
  initializeElements() {
    this.container = document.getElementById("logs");
    this.clearBtn = document.getElementById("clearBtn");
    this.downloadBtn = document.getElementById("downloadBtn");
    this.filterCheckbox = document.getElementById("filterVideosCheckbox");
    this.downloadManagerBtn = document.getElementById("downloadManagerBtn");
    console.log("[Popup] Elements initialized:", {
      container: !!this.container,
      clearBtn: !!this.clearBtn,
      downloadBtn: !!this.downloadBtn,
      filterCheckbox: !!this.filterCheckbox,
      downloadManagerBtn: !!this.downloadManagerBtn,
    });
  }
  attachEventListeners() {
    this.clearBtn.addEventListener("click", () => this.clearLogs());
    this.downloadBtn.addEventListener("click", () => this.downloadAllVideos());
    this.filterCheckbox.addEventListener("change", (e) => {
      this.filterVideosOnly = e.target.checked;
      console.log(`[Popup] Filter videos only: ${this.filterVideosOnly}`);
      this.updateDisplay();
    });
    // Add download manager button listener
    this.downloadManagerBtn.addEventListener("click", () => {
      console.log("[Popup] Download Manager button clicked");
      this.openDownloadManager();
    });
    console.log("[Popup] Event listeners attached");
  }
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "LOG_UPDATE") {
        this.addLogEntry(message.data);
      }
      // Handle download manager events
      if (
        message.type === "DOWNLOAD_CREATED" ||
        message.type === "DOWNLOAD_UPDATED" ||
        message.type === "DOWNLOAD_ERASED"
      ) {
        console.log("[Popup] Download event received:", message.type);
        // Optionally show notification or update badge
        this.updateDownloadCount();
      }
    });
  }
  updateDownloadCount() {
    // Query download manager for active count
    chrome.runtime.sendMessage({ type: "GET_DOWNLOADS" }, (downloads) => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[Popup] Failed to get download count:",
          chrome.runtime.lastError,
        );
        return;
      }
      const activeCount = downloads
        ? downloads.filter((d) => d.state === "in_progress").length
        : 0;
      console.log(`[Popup] Active downloads: ${activeCount}`);
      if (activeCount > 0) {
        this.downloadManagerBtn.textContent = `📂 Download Manager (${activeCount} active)`;
      } else {
        this.downloadManagerBtn.textContent = "📂 Download Manager";
      }
    });
  }
  loadLogs() {
    chrome.storage.local.get(["requests"], (result) => {
      if (result.requests) {
        console.log(
          `[Popup] Loading ${result.requests.length} logs from storage`,
        );
        result.requests.forEach((entry) => this.addLogEntry(entry));
        this.updateDisplay();
      }
      // Also update download count on load
      this.updateDownloadCount();
    });
  }
  isVideoResponse(entry) {
    // Check if this is a response with status 206 (Partial Content) and video/mp4 content type
    if (entry.type !== "RESPONSE") return false;
    if (entry.statusCode !== 206) return false;
    // Check if URL ends with .mp4 or contains video indicators
    const url = entry.url || "";
    const isMp4Url =
      url.toLowerCase().includes(".mp4") ||
      url.toLowerCase().includes("video") ||
      url.toLowerCase().includes("/video/");
    // We'll also check content-type from headers if available
    // For now, URL check is sufficient
    return isMp4Url;
  }
  extractVideoInfo(entry) {
    return {
      url: entry.url,
      timestamp: entry.timestamp,
      statusCode: entry.statusCode,
    };
  }
  addLogEntry(entry) {
    // Add to beginning of array
    this.logEntries.unshift(entry);
    // Keep last 200 entries for performance
    if (this.logEntries.length > 200) {
      this.logEntries.pop();
    }
    // If this is a video response, add to videoResponses
    if (this.isVideoResponse(entry)) {
      const videoInfo = this.extractVideoInfo(entry);
      // Avoid duplicates by URL
      const exists = this.videoResponses.some((v) => v.url === videoInfo.url);
      if (!exists) {
        this.videoResponses.push(videoInfo);
        console.log(`[Popup] New video detected: ${videoInfo.url}`);
      }
    }
    this.updateDisplay();
  }
  getFilteredEntries() {
    if (!this.filterVideosOnly) {
      return this.logEntries;
    }
    // Filter only video responses
    return this.logEntries.filter((entry) => this.isVideoResponse(entry));
  }
  updateDisplay() {
    const filteredEntries = this.getFilteredEntries();
    const videoCount = this.videoResponses.length;
    console.log(
      `[Popup] Updating display - Showing ${filteredEntries.length} of ${this.logEntries.length} entries, Videos found: ${videoCount}`,
    );
    // Show/hide download button based on video count and filter
    if (videoCount > 0 && this.filterVideosOnly) {
      this.downloadBtn.style.display = "block";
      this.downloadBtn.textContent = `📥 Download ${videoCount} Video${videoCount > 1 ? "s" : ""}`;
    } else {
      this.downloadBtn.style.display = "none";
    }
    // Generate HTML for log entries
    this.container.innerHTML = filteredEntries
      .map((entry) => {
        const isVideo = this.isVideoResponse(entry);
        const videoClass = isVideo ? "video-response" : "";
        const statusClass = entry.statusCode
          ? `status-${Math.floor(entry.statusCode / 100)}xx`
          : "";
        return `
          <div class="log-entry ${entry.type.toLowerCase()} ${videoClass}">
            <div class="timestamp">${entry.timestamp || new Date().toISOString()}</div>
            <div><strong>${entry.type}</strong> ${isVideo ? "🎬 VIDEO" : ""}</div>
            <div class="url">${this.formatUrl(entry)}</div>
            ${entry.statusCode ? `<div class="status ${statusClass}">Status: ${entry.statusCode} ${entry.statusCode === 206 ? "(Partial Content - Video Chunk)" : ""}</div>` : ""}
            ${entry.method ? `<div>Method: ${entry.method}</div>` : ""}
            ${entry.bodyLength ? `<div>Body Size: ${entry.bodyLength} chars</div>` : ""}
          </div>
        `;
      })
      .join("");
    // Show message if no logs
    if (filteredEntries.length === 0) {
      if (this.filterVideosOnly) {
        this.container.innerHTML =
          '<div style="text-align: center; padding: 20px; color: #666;">🎬 No progressive MP4 video responses found yet.<br>Try playing some videos on the page!</div>';
      } else {
        this.container.innerHTML =
          '<div style="text-align: center; padding: 20px; color: #666;">No logs yet. Network activity will appear here.</div>';
      }
    }
  }
  formatUrl(entry) {
    if (entry.url) {
      return entry.url;
    }
    if (entry.method) {
      return `${entry.method} ${entry.url || "unknown URL"}`;
    }
    return "Unknown URL";
  }
  async downloadAllVideos() {
    console.log(
      `[Popup] Starting download of ${this.videoResponses.length} videos`,
    );
    if (this.videoResponses.length === 0) {
      console.warn("[Popup] No videos to download");
      return;
    }
    // Show download progress indicator
    this.downloadBtn.textContent = `⏬ Downloading ${this.videoResponses.length} videos...`;
    this.downloadBtn.disabled = true;
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < this.videoResponses.length; i++) {
      const video = this.videoResponses[i];
      const filename = this.generateFilename(video, i);
      try {
        console.log(
          `[Popup] Downloading video ${i + 1}/${this.videoResponses.length}: ${filename}`,
        );
        await this.downloadVideo(video.url, filename);
        successCount++;
        // Add small delay between downloads to avoid overwhelming the browser
        await this.sleep(500);
      } catch (error) {
        console.error(`[Popup] Failed to download ${video.url}:`, error);
        failCount++;
      }
    }
    // Reset button
    this.downloadBtn.textContent = `📥 Download ${this.videoResponses.length} Video${this.videoResponses.length > 1 ? "s" : ""}`;
    this.downloadBtn.disabled = false;
    // Show completion message
    console.log(
      `[Popup] Download complete - Success: ${successCount}, Failed: ${failCount}`,
    );
    alert(
      `Download complete!\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`,
    );
    // Update download manager button count
    this.updateDownloadCount();
  }
  generateFilename(video, index) {
    try {
      // Extract filename from URL
      const urlParts = video.url.split("/");
      let filename = urlParts[urlParts.length - 1].split("?")[0];
      // If no valid filename, generate one
      if (!filename || !filename.includes(".mp4")) {
        const timestamp = new Date(video.timestamp)
          .toISOString()
          .replace(/[:.]/g, "-");
        filename = `video_${timestamp}.mp4`;
      }
      // Add index to avoid overwriting
      if (index > 0) {
        const nameParts = filename.split(".");
        if (nameParts.length > 1) {
          nameParts[nameParts.length - 2] += `_${index + 1}`;
          filename = nameParts.join(".");
        } else {
          filename = `${filename}_${index + 1}.mp4`;
        }
      }
      return filename;
    } catch (error) {
      console.error("[Popup] Error generating filename:", error);
      return `video_${Date.now()}_${index}.mp4`;
    }
  }
  downloadVideo(url, filename) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: url,
          filename: filename,
          saveAs: false, // Set to true if you want user to choose location each time
          conflictAction: "uniquify",
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            console.log(
              `[Popup] Download started with ID: ${downloadId} for ${filename}`,
            );
            // Open download manager automatically after starting downloads
            this.openDownloadManager();
            resolve(downloadId);
          }
        },
      );
    });
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  clearLogs() {
    console.log("[Popup] Clearing all logs");
    this.logEntries = [];
    this.videoResponses = [];
    this.updateDisplay();
    chrome.storage.local.set({ requests: [] });
  }
  /**
   * Open download manager - Mac optimized
   * Opens as a popup window centered on screen with Mac-friendly dimensions
   */
  openDownloadManager() {
    console.log("[Popup] Opening download manager window...");
    const url = chrome.runtime.getURL("downloads.html");
    // Mac-optimized window dimensions
    const windowWidth = 680;
    const windowHeight = 650;
    // Calculate center position for Mac screen
    const screenWidth = window.screen.availWidth || 1440;
    const screenHeight = window.screen.availHeight || 900;
    const left = Math.round((screenWidth - windowWidth) / 2);
    const top = Math.round((screenHeight - windowHeight) / 2);
    console.log(
      `[Popup] Screen: ${screenWidth}x${screenHeight}, Window: ${windowWidth}x${windowHeight}, Position: (${left}, ${top})`,
    );
    chrome.windows.create(
      {
        url: url,
        type: "popup",
        width: windowWidth,
        height: windowHeight,
        left: left,
        top: top,
        focused: true,
      },
      (window) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[Popup] Failed to create window:",
            chrome.runtime.lastError,
          );
          // Fallback: Open in new tab
          console.log("[Popup] Falling back to new tab...");
          chrome.tabs.create(
            {
              url: url,
              active: true,
            },
            (tab) => {
              console.log("[Popup] Download manager opened in tab:", tab?.id);
            },
          );
          return;
        }
        console.log("[Popup] Download manager window created:", window.id);
      },
    );
  }
}
// Initialize popup manager when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  console.log("[Popup] DOM loaded, initializing...");
  const popupManager = new PopupManager();
  // Expose for debugging
  window.popupManager = popupManager;
});
