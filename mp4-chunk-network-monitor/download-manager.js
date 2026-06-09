// download-manager.js - Minimal Download Manager
// Features: Download history, live progress, summary details with absolute paths

class DownloadManager {
  constructor() {
    this.downloads = new Map(); // id -> DownloadItem
    this.pollTimerId = -1;
    this.POLL_INTERVAL_MS = 200;

    console.log("[DownloadManager] Initializing download manager...");
    this.initializeListeners();
    this.loadExistingDownloads();
    console.log("[DownloadManager] Initialization complete");
  }

  /**
   * Set up Chrome downloads API event listeners
   */
  initializeListeners() {
    // New download created
    chrome.downloads.onCreated.addListener((downloadItem) => {
      console.log(
        "[DownloadManager] onCreated:",
        downloadItem.id,
        downloadItem.filename,
      );
      this.addOrUpdate(downloadItem);
      this.startPolling();
      this.notifyPopup("DOWNLOAD_CREATED", this.serialize(downloadItem));
    });

    // Download state changed
    chrome.downloads.onChanged.addListener((delta) => {
      console.log(
        "[DownloadManager] onChanged:",
        delta.id,
        delta.state?.current,
      );
      const existing = this.downloads.get(delta.id);
      if (existing) {
        // Apply delta changes
        for (const [key, value] of Object.entries(delta)) {
          if (key !== "id") {
            existing[key] = value.current;
          }
        }
        existing._lastUpdated = Date.now();
        console.log(
          "[DownloadManager] Updated download:",
          existing.id,
          `state=${existing.state}, bytes=${existing.bytesReceived}/${existing.totalBytes}`,
        );

        // Resolve absolute path on completion
        if (delta.state?.current === "complete") {
          this.resolveAbsolutePath(delta.id);
        }

        this.notifyPopup("DOWNLOAD_UPDATED", this.serialize(existing));
      }
    });

    // Download erased from history
    chrome.downloads.onErased.addListener((id) => {
      console.log("[DownloadManager] onErased:", id);
      this.downloads.delete(id);
      this.notifyPopup("DOWNLOAD_ERASED", { id });
    });

    // Listen for popup requests
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log("[DownloadManager] Received message:", message.type);

      switch (message.type) {
        case "GET_DOWNLOADS":
          sendResponse(this.getAllDownloads());
          break;

        case "GET_DOWNLOAD_DETAILS":
          sendResponse(this.getDownloadDetails(message.id));
          break;

        case "OPEN_DOWNLOAD":
          this.openDownload(message.id);
          sendResponse({ success: true });
          break;

        case "SHOW_IN_FOLDER":
          this.showInFolder(message.id);
          sendResponse({ success: true });
          break;

        case "ERASE_DOWNLOAD":
          this.eraseDownload(message.id);
          sendResponse({ success: true });
          break;

        case "PAUSE_DOWNLOAD":
          this.pauseDownload(message.id);
          sendResponse({ success: true });
          break;

        case "RESUME_DOWNLOAD":
          this.resumeDownload(message.id);
          sendResponse({ success: true });
          break;

        case "CANCEL_DOWNLOAD":
          this.cancelDownload(message.id);
          sendResponse({ success: true });
          break;

        default:
          console.log("[DownloadManager] Unknown message type:", message.type);
      }
      return true; // Keep message channel open for async response
    });
  }

  /**
   * Load existing downloads from Chrome's download history
   */
  async loadExistingDownloads() {
    try {
      const results = await chrome.downloads.search({
        orderBy: ["-startTime"],
        limit: 50,
      });
      console.log(
        `[DownloadManager] Loaded ${results.length} existing downloads`,
      );
      results.forEach((item) => {
        this.addOrUpdate(item);
        // Resolve paths for completed downloads
        if (item.state === "complete" && item.filename) {
          this.resolveAbsolutePath(item.id);
        }
      });
    } catch (error) {
      console.error(
        "[DownloadManager] Failed to load existing downloads:",
        error,
      );
    }
  }

  /**
   * Add or update a download item in the local cache
   */
  addOrUpdate(downloadItem) {
    const existing = this.downloads.get(downloadItem.id);
    if (existing) {
      // Merge new data
      Object.assign(existing, downloadItem);
      existing._lastUpdated = Date.now();
    } else {
      downloadItem._lastUpdated = Date.now();
      downloadItem._absolutePath = null; // Will be resolved
      this.downloads.set(downloadItem.id, downloadItem);
      console.log("[DownloadManager] Added new download:", downloadItem.id);
    }
  }

  /**
   * Resolve the absolute local path for a completed download
   */
  async resolveAbsolutePath(downloadId) {
    try {
      const [download] = await chrome.downloads.search({ id: downloadId });
      if (download && download.filename) {
        const item = this.downloads.get(downloadId);
        if (item) {
          item._absolutePath = download.filename;
          // Normalize path separators for display
          item._absolutePathDisplay = download.filename.replace(/\\/g, "/");
          console.log(
            "[DownloadManager] Resolved absolute path:",
            downloadId,
            "→",
            item._absolutePathDisplay,
          );

          // Store in persistent storage
          this.storeDownloadPath(downloadId, download.filename);
          this.notifyPopup("PATH_RESOLVED", {
            id: downloadId,
            absolutePath: download.filename,
          });
        }
      }
    } catch (error) {
      console.error(
        "[DownloadManager] Failed to resolve path for",
        downloadId,
        error,
      );
    }
  }

  /**
   * Store download path in chrome.storage for persistence
   */
  storeDownloadPath(downloadId, path) {
    const key = `download_path_${downloadId}`;
    chrome.storage.local.set({ [key]: path }, () => {
      console.log("[DownloadManager] Stored path in storage:", key, path);
    });
  }

  /**
   * Get all downloads as serializable array
   */
  getAllDownloads() {
    const downloads = [];
    for (const [id, item] of this.downloads) {
      downloads.push(this.serialize(item));
    }
    // Sort by startTime descending (newest first)
    downloads.sort((a, b) => {
      const timeA = new Date(a.startTime || 0).getTime();
      const timeB = new Date(b.startTime || 0).getTime();
      return timeB - timeA;
    });
    console.log(`[DownloadManager] Returning ${downloads.length} downloads`);
    return downloads;
  }

  /**
   * Get detailed info for a single download
   */
  getDownloadDetails(id) {
    const item = this.downloads.get(id);
    if (!item) {
      console.warn("[DownloadManager] Download not found:", id);
      return null;
    }
    return this.serialize(item);
  }

  /**
   * Serialize download item for messaging (no circular refs, no functions)
   */
  serialize(item) {
    return {
      id: item.id,
      url: item.url,
      referrer: item.referrer || "",
      filename: item.filename || "",
      basename: this.getBasename(item.filename || ""),
      absolutePath: item._absolutePath || item.filename || "",
      absolutePathDisplay: item._absolutePathDisplay || item.filename || "",
      state: item.state || "unknown",
      startTime: item.startTime || "",
      endTime: item.endTime || "",
      estimatedEndTime: item.estimatedEndTime || "",
      bytesReceived: item.bytesReceived || 0,
      totalBytes: item.totalBytes || 0,
      fileSize: item.fileSize || 0,
      mime: item.mime || "",
      danger: item.danger || "safe",
      paused: item.paused || false,
      canResume: item.canResume || false,
      exists: item.exists || false,
      error: item.error || null,
      byExtensionId: item.byExtensionId || "",
      byExtensionName: item.byExtensionName || "",
      progress: this.calculateProgress(item),
      speed: this.calculateSpeed(item),
      timeRemaining: this.calculateTimeRemaining(item),
      _lastUpdated: item._lastUpdated || Date.now(),
    };
  }

  /**
   * Extract filename from full path
   */
  getBasename(path) {
    if (!path) return "Unknown";
    const normalized = path.replace(/\\/g, "/");
    return normalized.split("/").pop() || path;
  }

  /**
   * Calculate download progress percentage (0-100)
   */
  calculateProgress(item) {
    if (!item.totalBytes || item.totalBytes <= 0) return 0;
    if (item.state === "complete") return 100;
    return Math.min(
      100,
      Math.round((item.bytesReceived / item.totalBytes) * 100),
    );
  }

  /**
   * Calculate download speed in bytes per second
   */
  calculateSpeed(item) {
    if (item.state !== "in_progress" || item.paused) return 0;
    // Use a simple estimation based on progress change
    // For more accuracy, track previous bytesReceived and time
    return 0; // Simplified - would need time-series tracking
  }

  /**
   * Estimate time remaining in seconds
   */
  calculateTimeRemaining(item) {
    if (!item.estimatedEndTime || item.state !== "in_progress") return null;
    const now = Date.now();
    const endTime = new Date(item.estimatedEndTime).getTime();
    const remaining = Math.max(0, endTime - now);
    return Math.round(remaining / 1000); // Return in seconds
  }

  /**
   * Start polling for progress updates on active downloads
   */
  startPolling() {
    if (this.pollTimerId >= 0) {
      return; // Already polling
    }
    console.log("[DownloadManager] Starting progress polling");
    this.pollTimerId = setInterval(
      () => this.pollProgress(),
      this.POLL_INTERVAL_MS,
    );
  }

  /**
   * Poll Chrome downloads API for updates on in-progress downloads
   */
  async pollProgress() {
    try {
      const activeDownloads = await chrome.downloads.search({
        state: "in_progress",
      });

      if (activeDownloads.length === 0) {
        this.stopPolling();
        return;
      }

      console.log(
        `[DownloadManager] Polling ${activeDownloads.length} active downloads`,
      );
      for (const item of activeDownloads) {
        this.addOrUpdate(item);
        this.notifyPopup("DOWNLOAD_UPDATED", this.serialize(item));
      }
    } catch (error) {
      console.error("[DownloadManager] Poll error:", error);
    }
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollTimerId >= 0) {
      console.log("[DownloadManager] Stopping progress polling");
      clearInterval(this.pollTimerId);
      this.pollTimerId = -1;
    }
  }

  /**
   * Notify popup UI of download events
   */
  notifyPopup(eventType, data) {
    chrome.runtime
      .sendMessage({
        type: eventType,
        data: data,
      })
      .catch(() => {
        // Popup not open - that's fine
      });
  }

  // Action methods

  openDownload(id) {
    console.log("[DownloadManager] Opening download:", id);
    chrome.downloads.open(id);
  }

  showInFolder(id) {
    console.log("[DownloadManager] Showing in folder:", id);
    chrome.downloads.show(id);
  }

  eraseDownload(id) {
    console.log("[DownloadManager] Erasing download:", id);
    chrome.downloads.erase({ id });
  }

  pauseDownload(id) {
    console.log("[DownloadManager] Pausing download:", id);
    chrome.downloads.pause(id);
  }

  resumeDownload(id) {
    console.log("[DownloadManager] Resuming download:", id);
    chrome.downloads.resume(id);
  }

  cancelDownload(id) {
    console.log("[DownloadManager] Cancelling download:", id);
    chrome.downloads.cancel(id);
  }
}

// Initialize the download manager
console.log("[Background] Creating DownloadManager instance...");
const downloadManager = new DownloadManager();

// Export for debugging
self.downloadManager = downloadManager;
