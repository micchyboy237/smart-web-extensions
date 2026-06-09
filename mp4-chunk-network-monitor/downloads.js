// downloads.js - Download Manager Popup Logic

class DownloadManagerUI {
  constructor() {
    this.downloads = [];
    this.initializeElements();
    this.attachEventListeners();
    this.setupMessageListener();
    this.loadDownloads();
    console.log("[DownloadManagerUI] Initialized");
  }

  initializeElements() {
    this.listContainer = document.getElementById("downloadList");
    this.headerStats = document.getElementById("headerStats");
    this.clearAllBtn = document.getElementById("clearAllBtn");
  }

  attachEventListeners() {
    this.clearAllBtn.addEventListener("click", () => this.clearAllDownloads());

    // Use event delegation for download item actions
    this.listContainer.addEventListener("click", (e) => {
      const actionBtn = e.target.closest(".action-btn");
      if (!actionBtn) return;

      const downloadId = parseInt(actionBtn.dataset.id);
      const action = actionBtn.dataset.action;

      console.log(
        `[DownloadManagerUI] Action: ${action} on download ${downloadId}`,
      );

      switch (action) {
        case "open":
          chrome.runtime.sendMessage({ type: "OPEN_DOWNLOAD", id: downloadId });
          break;
        case "show":
          chrome.runtime.sendMessage({
            type: "SHOW_IN_FOLDER",
            id: downloadId,
          });
          break;
        case "erase":
          chrome.runtime.sendMessage({
            type: "ERASE_DOWNLOAD",
            id: downloadId,
          });
          break;
        case "pause":
          chrome.runtime.sendMessage({
            type: "PAUSE_DOWNLOAD",
            id: downloadId,
          });
          break;
        case "resume":
          chrome.runtime.sendMessage({
            type: "RESUME_DOWNLOAD",
            id: downloadId,
          });
          break;
        case "cancel":
          chrome.runtime.sendMessage({
            type: "CANCEL_DOWNLOAD",
            id: downloadId,
          });
          break;
      }
    });
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.type) {
        case "DOWNLOAD_CREATED":
          console.log(
            "[DownloadManagerUI] Received DOWNLOAD_CREATED:",
            message.data.id,
          );
          this.addOrUpdateDownload(message.data);
          break;

        case "DOWNLOAD_UPDATED":
          console.log(
            "[DownloadManagerUI] Received DOWNLOAD_UPDATED:",
            message.data.id,
            `state=${message.data.state}`,
          );
          this.addOrUpdateDownload(message.data);
          break;

        case "DOWNLOAD_ERASED":
          console.log(
            "[DownloadManagerUI] Received DOWNLOAD_ERASED:",
            message.data.id,
          );
          this.removeDownload(message.data.id);
          break;

        case "PATH_RESOLVED":
          console.log(
            "[DownloadManagerUI] Received PATH_RESOLVED:",
            message.data.id,
          );
          this.updatePath(message.data.id, message.data.absolutePath);
          break;
      }
    });
  }

  /**
   * Load all downloads from background
   */
  loadDownloads() {
    console.log("[DownloadManagerUI] Requesting downloads...");
    chrome.runtime.sendMessage({ type: "GET_DOWNLOADS" }, (downloads) => {
      if (chrome.runtime.lastError) {
        console.error(
          "[DownloadManagerUI] Error loading downloads:",
          chrome.runtime.lastError,
        );
        this.showError("Failed to load downloads. Please try again.");
        return;
      }
      if (downloads && downloads.length > 0) {
        console.log(`[DownloadManagerUI] Loaded ${downloads.length} downloads`);
        this.downloads = downloads;
        this.render();
      } else {
        console.log("[DownloadManagerUI] No downloads found");
        this.downloads = [];
        this.render();
      }
    });
  }

  /**
   * Add or update a download in the local list
   */
  addOrUpdateDownload(data) {
    const index = this.downloads.findIndex((d) => d.id === data.id);
    if (index >= 0) {
      this.downloads[index] = { ...this.downloads[index], ...data };
      console.log(
        `[DownloadManagerUI] Updated download ${data.id} at index ${index}`,
      );
    } else {
      this.downloads.unshift(data);
      console.log(`[DownloadManagerUI] Added new download ${data.id}`);
    }
    this.render();
  }

  /**
   * Remove a download from the list
   */
  removeDownload(id) {
    this.downloads = this.downloads.filter((d) => d.id !== id);
    console.log(`[DownloadManagerUI] Removed download ${id}`);
    this.render();
  }

  /**
   * Update absolute path for a download
   */
  updatePath(id, absolutePath) {
    const download = this.downloads.find((d) => d.id === id);
    if (download) {
      download.absolutePath = absolutePath;
      download.absolutePathDisplay = absolutePath.replace(/\\/g, "/");
      console.log(`[DownloadManagerUI] Updated path for ${id}`);
      this.render();
    }
  }

  /**
   * Clear all completed downloads
   */
  clearAllDownloads() {
    const completedIds = this.downloads
      .filter((d) => d.state === "complete")
      .map((d) => d.id);

    console.log(
      `[DownloadManagerUI] Clearing ${completedIds.length} completed downloads`,
    );

    completedIds.forEach((id) => {
      chrome.runtime.sendMessage({ type: "ERASE_DOWNLOAD", id });
    });
  }

  /**
   * Format bytes to human-readable string
   */
  formatBytes(bytes) {
    if (bytes === 0 || bytes === null || bytes === undefined) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  /**
   * Format time remaining
   */
  formatTimeRemaining(seconds) {
    if (seconds === null || seconds === undefined) return "--";
    if (seconds < 0) return "Almost done";
    if (seconds < 60) return `${seconds}s left`;
    if (seconds < 3600)
      return `${Math.floor(seconds / 60)}m ${seconds % 60}s left`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m left`;
  }

  /**
   * Format timestamp for display
   */
  formatTime(dateStr) {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;

    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  /**
   * Render all downloads
   */
  render() {
    // Update header stats
    const activeCount = this.downloads.filter(
      (d) => d.state === "in_progress",
    ).length;
    const completedCount = this.downloads.filter(
      (d) => d.state === "complete",
    ).length;
    const totalCount = this.downloads.length;

    this.headerStats.textContent = `${totalCount} total · ${activeCount} active · ${completedCount} completed`;

    if (totalCount === 0) {
      this.listContainer.innerHTML = `
        <div class="empty-state">
          <div class="icon">📭</div>
          <p>No downloads yet</p>
          <p style="font-size: 12px; margin-top: 4px;">Downloads will appear here automatically</p>
        </div>`;
      return;
    }

    // Render download items
    this.listContainer.innerHTML = this.downloads
      .map((d) => this.renderDownloadItem(d))
      .join("");
    console.log(`[DownloadManagerUI] Rendered ${totalCount} downloads`);
  }

  /**
   * Render a single download item
   */
  renderDownloadItem(d) {
    const stateClass = this.getStateClass(d.state);
    const stateLabel = this.getStateLabel(d.state);
    const progress = d.progress || 0;

    return `
      <div class="download-item ${d.state}" id="download-${d.id}">
        <!-- Header -->
        <div class="download-header">
          <span class="download-icon">${this.getIcon(d)}</span>
          <span class="download-filename" title="${this.escapeHtml(d.basename)}">
            ${this.escapeHtml(d.basename)}
          </span>
          <span class="download-state ${stateClass}">${stateLabel}</span>
        </div>
        
        <!-- Progress Bar -->
        ${
          d.state === "in_progress"
            ? `
        <div class="progress-container">
          <div class="progress-bar">
            <div class="progress-fill active" style="width: ${progress}%"></div>
          </div>
          <div class="progress-text">
            <span>${this.formatBytes(d.bytesReceived)} / ${this.formatBytes(d.totalBytes)}</span>
            <span>${progress}%</span>
          </div>
          ${
            d.timeRemaining
              ? `
          <div style="font-size: 11px; color: #888; margin-top: 2px;">
            ⏱ ${this.formatTimeRemaining(d.timeRemaining)}
          </div>`
              : ""
          }
        </div>
        `
            : d.state === "complete"
              ? `
        <div class="progress-container">
          <div class="progress-bar">
            <div class="progress-fill" style="width: 100%"></div>
          </div>
          <div class="progress-text">
            <span>${this.formatBytes(d.fileSize || d.bytesReceived)}</span>
            <span>✓ Complete</span>
          </div>
        </div>
        `
              : ""
        }
        
        <!-- Details -->
        <div class="download-details">
          ${
            d.absolutePath
              ? `
          <div class="detail-row">
            <span class="detail-label">📁 Path:</span>
            <span class="detail-value path" title="${this.escapeHtml(d.absolutePathDisplay)}">
              ${this.escapeHtml(d.absolutePathDisplay)}
            </span>
          </div>`
              : ""
          }
          
          <div class="detail-row">
            <span class="detail-label">🔗 URL:</span>
            <span class="detail-value url" title="${this.escapeHtml(d.url)}">
              ${this.escapeHtml(this.truncateUrl(d.url, 80))}
            </span>
          </div>
          
          ${
            d.referrer
              ? `
          <div class="detail-row">
            <span class="detail-label">↩ Referrer:</span>
            <span class="detail-value">${this.escapeHtml(this.truncateUrl(d.referrer, 60))}</span>
          </div>`
              : ""
          }
          
          <div class="detail-row">
            <span class="detail-label">🕐 Started:</span>
            <span class="detail-value">${this.formatTime(d.startTime)}</span>
          </div>
          
          ${
            d.error
              ? `
          <div class="detail-row">
            <span class="detail-label">⚠ Error:</span>
            <span class="detail-value" style="color: #c62828;">${this.escapeHtml(d.error)}</span>
          </div>`
              : ""
          }
          
          ${
            d.byExtensionName
              ? `
          <div class="detail-row">
            <span class="detail-label">🧩 Extension:</span>
            <span class="detail-value">${this.escapeHtml(d.byExtensionName)}</span>
          </div>`
              : ""
          }
        </div>
        
        <!-- Actions -->
        <div class="download-actions">
          ${
            d.state === "complete" && d.exists
              ? `
            <button class="action-btn open" data-id="${d.id}" data-action="open">📂 Open</button>
            <button class="action-btn folder" data-id="${d.id}" data-action="show">📁 Show in Folder</button>
          `
              : ""
          }
          ${
            d.state === "in_progress" && !d.paused
              ? `
            <button class="action-btn pause" data-id="${d.id}" data-action="pause">⏸ Pause</button>
            <button class="action-btn cancel" data-id="${d.id}" data-action="cancel">✕ Cancel</button>
          `
              : ""
          }
          ${
            d.state === "in_progress" && d.paused && d.canResume
              ? `
            <button class="action-btn resume" data-id="${d.id}" data-action="resume">▶ Resume</button>
            <button class="action-btn cancel" data-id="${d.id}" data-action="cancel">✕ Cancel</button>
          `
              : ""
          }
          <button class="action-btn erase" data-id="${d.id}" data-action="erase">🗑 Remove</button>
        </div>
      </div>
    `;
  }

  /**
   * Get icon emoji based on file type
   */
  getIcon(d) {
    const mime = d.mime || "";
    if (mime.startsWith("video/")) return "🎬";
    if (mime.startsWith("audio/")) return "🎵";
    if (mime.startsWith("image/")) return "🖼";
    if (mime.includes("pdf")) return "📄";
    if (mime.includes("zip") || mime.includes("rar")) return "📦";
    return "📥";
  }

  /**
   * Get CSS class for download state badge
   */
  getStateClass(state) {
    const map = {
      complete: "state-complete",
      in_progress: "state-progress",
      interrupted: "state-interrupted",
      paused: "state-paused",
    };
    return map[state] || "state-progress";
  }

  /**
   * Get human-readable state label
   */
  getStateLabel(state) {
    const map = {
      complete: "Complete",
      in_progress: "Downloading",
      interrupted: "Failed",
      paused: "Paused",
    };
    return map[state] || state;
  }

  /**
   * Truncate URL for display
   */
  truncateUrl(url, maxLen) {
    if (!url) return "";
    if (url.length <= maxLen) return url;
    return url.substring(0, maxLen - 3) + "...";
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Show error state
   */
  showError(message) {
    this.listContainer.innerHTML = `
      <div class="error-state">
        <p>⚠️ ${this.escapeHtml(message)}</p>
        <button class="btn" onclick="location.reload()" style="margin-top: 8px;">Retry</button>
      </div>`;
    console.error("[DownloadManagerUI]", message);
  }
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  console.log("[DownloadManagerUI] DOM ready, initializing...");
  window.downloadManagerUI = new DownloadManagerUI();
});
