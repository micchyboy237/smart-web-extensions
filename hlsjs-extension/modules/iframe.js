/**
 * iframe.js - I-Frame Previews (Trick Play) Features
 *
 * Manages I-frame only playback for thumbnail previews and trick play.
 * Supports both video I-frame players and image I-frame players.
 *
 * NEW: Smart Timeline Previews - Dynamically generates clickable thumbnails
 * based on video duration for visual timeline navigation.
 */
class IFrameController {
  constructor(player) {
    this.player = player;
    this.hls = player.hls;
    this.video = player.video;

    // I-frame players
    this.iFramePlayer = null;
    this.imagePlayer = null;

    // DOM elements
    this.iFrameVideoEl = null;
    this.thumbnailImgEl = null;

    // Timeline preview properties
    this.timelinePreviews = [];
    this.timelineContainer = null;
    this.isPreloading = false;
    this.preloadQueue = [];
    this.currentBatchIndex = 0;
    this.totalThumbnails = 0;

    // Configuration for smart timeline
    this.config = {
      minThumbnails: 5,
      maxThumbnails: 20,
      thumbnailsPerBatch: 3,
      preloadDelayMs: 100,
    };

    Logger.info(
      "iframe",
      "IFrameController initialized with smart timeline support",
    );
    this._setupEvents();
  }

  // --------------------------------------------------------------------------
  // Event Setup
  // --------------------------------------------------------------------------
  _setupEvents() {
    if (!this.hls) {
      Logger.warn("iframe", "hls instance not available for event setup");
      return;
    }

    // Check for I-frame variants on manifest parse
    this.hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      this._handleManifest(data);
    });

    Logger.info("iframe", "✓ I-frame events setup");
  }

  _handleManifest(data) {
    const hasIFrameVariants = data.iFrameVariants?.length > 0;
    Logger.info("iframe", "Manifest parsed - checking I-frame variants", {
      hasIFrameVariants,
      variantCount: data.iFrameVariants?.length || 0,
    });

    if (hasIFrameVariants) {
      data.iFrameVariants.forEach((variant, index) => {
        Logger.debug("iframe", `I-frame variant ${index}`, {
          bandwidth: variant.bandwidth,
          uri: variant.uri?.substring(0, 50) + "...",
        });
      });
    }
  }

  // ==========================================================================
  // SMART TIMELINE PREVIEWS - NEW FEATURE
  // ==========================================================================

  /**
   * Calculate optimal number of thumbnails based on video duration
   * @param {number} duration - Video duration in seconds
   * @returns {number} - Optimal thumbnail count
   */
  calculateOptimalThumbnailCount(duration) {
    let count;

    if (duration <= 60) {
      // Short videos (< 1 min): 5 thumbnails
      count = 5;
    } else if (duration <= 300) {
      // Medium videos (1-5 min): 10 thumbnails
      count = 10;
    } else if (duration <= 1800) {
      // Long videos (5-30 min): 15 thumbnails
      count = 15;
    } else {
      // Very long videos (> 30 min): 20 thumbnails max
      count = 20;
    }

    Logger.info("iframe", "📊 Calculated optimal thumbnail count", {
      duration: `${duration.toFixed(1)}s`,
      thumbnailCount: count,
      strategy:
        duration <= 60
          ? "short"
          : duration <= 300
            ? "medium"
            : duration <= 1800
              ? "long"
              : "very-long",
    });

    return count;
  }

  /**
   * Calculate thumbnail timestamps based on duration and count
   * @param {number} duration - Video duration in seconds
   * @param {number} count - Number of thumbnails
   * @returns {Array} - Array of timestamp objects
   */
  calculateThumbnailTimestamps(duration, count) {
    const timestamps = [];
    const interval = duration / count;

    for (let i = 0; i < count; i++) {
      const timestamp = i * interval;
      timestamps.push({
        index: i,
        timestamp: timestamp,
        interval: interval,
        percent: (timestamp / duration) * 100,
      });
    }

    Logger.debug("iframe", "📅 Thumbnail timestamps calculated", {
      count: timestamps.length,
      firstTimestamp: timestamps[0].timestamp.toFixed(1),
      lastTimestamp: timestamps[timestamps.length - 1].timestamp.toFixed(1),
      interval: interval.toFixed(1),
    });

    return timestamps;
  }

  /**
   * Generate timeline previews with smart loading
   * @param {HTMLElement} containerEl - Container for timeline previews
   * @param {Object} options - Optional configuration
   * @returns {Promise} - Promise that resolves when all thumbnails are loaded
   */
  async generateTimelinePreviews(containerEl, options = {}) {
    if (!this.hls || !this.video) {
      Logger.error(
        "iframe",
        "Cannot generate timeline previews: player not ready",
      );
      return null;
    }

    // Check if image player is available
    if (!this.hls.createImageIFramePlayer) {
      Logger.error("iframe", "Image I-frame player not supported");
      return null;
    }

    // Clear existing previews
    this.clearTimelinePreviews();

    this.timelineContainer = containerEl;

    // Get video duration
    const duration = this.video.duration;
    if (!duration || isNaN(duration) || duration <= 0) {
      Logger.warn(
        "iframe",
        "Invalid video duration, waiting for durationchange event",
      );

      // Wait for duration to be available
      await new Promise((resolve) => {
        const onDurationChange = () => {
          this.video.removeEventListener("durationchange", onDurationChange);
          resolve();
        };
        this.video.addEventListener("durationchange", onDurationChange);
      });
    }

    const finalDuration = this.video.duration;
    Logger.info("iframe", "🎬 Generating timeline previews", {
      duration: `${finalDuration.toFixed(1)}s`,
      container: containerEl.id || "unknown",
    });

    // Merge options with defaults
    const mergedOptions = {
      thumbnailCount: this.calculateOptimalThumbnailCount(finalDuration),
      batchSize: this.config.thumbnailsPerBatch,
      showLoadingIndicators: true,
      ...options,
    };

    // Calculate timestamps
    const timestamps = this.calculateThumbnailTimestamps(
      finalDuration,
      mergedOptions.thumbnailCount,
    );
    this.totalThumbnails = timestamps.length;

    // Create UI placeholders
    this._createTimelineUI(timestamps, mergedOptions.showLoadingIndicators);

    // Start batch loading
    await this._batchLoadThumbnails(timestamps, mergedOptions.batchSize);

    Logger.info("iframe", "✅ Timeline previews generation complete", {
      totalLoaded: this.timelinePreviews.filter((p) => p.loaded).length,
      totalFailed: this.timelinePreviews.filter((p) => p.error).length,
    });

    return this.timelinePreviews;
  }

  /**
   * Create timeline UI elements
   * @param {Array} timestamps - Array of timestamp objects
   * @param {boolean} showLoading - Whether to show loading indicators
   */
  _createTimelineUI(timestamps, showLoading) {
    // Add styles if not already present
    this._injectTimelineStyles();

    // Clear container
    this.timelineContainer.innerHTML = "";
    this.timelineContainer.className = "hls-timeline-previews";

    timestamps.forEach((ts, index) => {
      const previewItem = document.createElement("div");
      previewItem.className = "timeline-preview-item";
      previewItem.dataset.timestamp = ts.timestamp;
      previewItem.dataset.index = index;

      // Thumbnail container
      const thumbnailContainer = document.createElement("div");
      thumbnailContainer.className = "preview-thumbnail";

      // Loading indicator
      if (showLoading) {
        const loadingDiv = document.createElement("div");
        loadingDiv.className = "preview-loading";
        loadingDiv.innerHTML = "⏳";
        thumbnailContainer.appendChild(loadingDiv);
      }

      // Time label
      const timeLabel = document.createElement("div");
      timeLabel.className = "preview-time";
      timeLabel.textContent = this._formatTime(ts.timestamp);

      // Seek button (clickable area)
      const seekButton = document.createElement("div");
      seekButton.className = "preview-seek-btn";
      seekButton.textContent = "▶";
      seekButton.title = `Seek to ${this._formatTime(ts.timestamp)}`;

      previewItem.appendChild(thumbnailContainer);
      previewItem.appendChild(timeLabel);
      previewItem.appendChild(seekButton);

      // Add click handler for seeking
      previewItem.addEventListener("click", (e) => {
        e.stopPropagation();
        this._seekToTimestamp(ts.timestamp);
      });

      this.timelineContainer.appendChild(previewItem);

      // Store preview data
      this.timelinePreviews.push({
        index: index,
        timestamp: ts.timestamp,
        interval: ts.interval,
        percent: ts.percent,
        element: previewItem,
        thumbnailContainer: thumbnailContainer,
        loaded: false,
        error: false,
        imageUrl: null,
      });
    });

    Logger.debug("iframe", "Timeline UI created", {
      items: this.timelinePreviews.length,
      containerWidth: this.timelineContainer.clientWidth,
    });
  }

  /**
   * Batch load thumbnails to avoid network congestion
   * @param {Array} timestamps - Array of timestamp objects
   * @param {number} batchSize - Number of thumbnails to load per batch
   */
  async _batchLoadThumbnails(timestamps, batchSize) {
    this.isPreloading = true;
    this.preloadQueue = [...timestamps];
    this.currentBatchIndex = 0;

    const totalBatches = Math.ceil(timestamps.length / batchSize);
    Logger.info("iframe", "Starting batch thumbnail loading", {
      totalThumbnails: timestamps.length,
      batchSize: batchSize,
      totalBatches: totalBatches,
    });

    for (let batch = 0; batch < totalBatches; batch++) {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, timestamps.length);
      const batchTimestamps = timestamps.slice(start, end);

      Logger.debug("iframe", `Loading batch ${batch + 1}/${totalBatches}`, {
        items: batchTimestamps.length,
        startTimestamp: batchTimestamps[0].timestamp.toFixed(1),
        endTimestamp:
          batchTimestamps[batchTimestamps.length - 1].timestamp.toFixed(1),
      });

      // Load thumbnails in parallel for this batch
      const loadPromises = batchTimestamps.map((ts) =>
        this._loadSingleThumbnail(ts),
      );
      await Promise.all(loadPromises);

      // Small delay between batches to allow network to breathe
      if (batch < totalBatches - 1) {
        await this._delay(this.config.preloadDelayMs);
      }
    }

    this.isPreloading = false;
    Logger.info("iframe", "✅ Batch loading complete");
  }

  /**
   * Load a single thumbnail at specific timestamp
   * @param {Object} timestamp - Timestamp object
   * @returns {Promise} - Promise that resolves when thumbnail is loaded
   */
  async _loadSingleThumbnail(timestamp) {
    const preview = this.timelinePreviews.find(
      (p) => p.index === timestamp.index,
    );
    if (!preview) {
      Logger.warn("iframe", "Preview not found for index", timestamp.index);
      return;
    }

    // Update loading state
    if (preview.thumbnailContainer) {
      const loadingEl =
        preview.thumbnailContainer.querySelector(".preview-loading");
      if (loadingEl) {
        loadingEl.innerHTML = "🖼️";
        loadingEl.classList.add("loading-active");
      }
    }

    try {
      // Create a temporary image player for this thumbnail
      const tempImagePlayer = this.hls.createImageIFramePlayer();
      if (!tempImagePlayer) {
        throw new Error("Failed to create image player");
      }

      // Create a promise that resolves when the frame is parsed
      const thumbnailPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(`Timeout loading thumbnail at ${timestamp.timestamp}s`),
          );
        }, 10000); // 10 second timeout

        tempImagePlayer.on(Hls.Events.FRAG_PARSED, (event, data) => {
          clearTimeout(timeout);
          const jpegBytes = data.frag.data;
          const blob = new Blob([jpegBytes], { type: "image/jpeg" });
          const url = URL.createObjectURL(blob);

          // Update UI with thumbnail
          this._updateThumbnailUI(preview, url);

          // Clean up temp player
          tempImagePlayer.destroy();

          resolve(url);
        });

        tempImagePlayer.on(Hls.Events.ERROR, (event, data) => {
          clearTimeout(timeout);
          reject(new Error(`Error loading thumbnail: ${data.details}`));
        });
      });

      // Load the thumbnail
      tempImagePlayer.loadMediaAt(timestamp.timestamp);
      await thumbnailPromise;

      preview.loaded = true;
      Logger.debug(
        "iframe",
        `✓ Thumbnail loaded at ${timestamp.timestamp.toFixed(1)}s`,
      );
    } catch (error) {
      preview.error = true;
      Logger.error(
        "iframe",
        `❌ Failed to load thumbnail at ${timestamp.timestamp.toFixed(1)}s`,
        {
          error: error.message,
        },
      );

      // Show error indicator
      if (preview.thumbnailContainer) {
        const loadingEl =
          preview.thumbnailContainer.querySelector(".preview-loading");
        if (loadingEl) {
          loadingEl.innerHTML = "❌";
          loadingEl.classList.add("error");
        } else {
          const errorDiv = document.createElement("div");
          errorDiv.className = "preview-error";
          errorDiv.innerHTML = "❌";
          preview.thumbnailContainer.appendChild(errorDiv);
        }
      }
    }
  }

  /**
   * Update thumbnail UI with loaded image
   * @param {Object} preview - Preview object
   * @param {string} imageUrl - URL of the loaded image
   */
  _updateThumbnailUI(preview, imageUrl) {
    if (!preview.thumbnailContainer) return;

    // Clear container
    preview.thumbnailContainer.innerHTML = "";

    // Create image element
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = `Preview at ${this._formatTime(preview.timestamp)}`;
    img.className = "preview-image";
    img.loading = "lazy";

    // Add fade-in effect
    img.style.opacity = "0";
    img.onload = () => {
      img.style.transition = "opacity 0.3s ease";
      img.style.opacity = "1";
    };

    preview.thumbnailContainer.appendChild(img);
    preview.imageUrl = imageUrl;

    // Store for cleanup later
    if (!this.thumbnailUrls) {
      this.thumbnailUrls = [];
    }
    this.thumbnailUrls.push(imageUrl);
  }

  /**
   * Seek video to specific timestamp
   * @param {number} timestamp - Timestamp in seconds
   */
  _seekToTimestamp(timestamp) {
    if (!this.video) {
      Logger.error("iframe", "Cannot seek: video element not available");
      return;
    }

    Logger.info(
      "iframe",
      `🎯 Seeking to timestamp: ${this._formatTime(timestamp)}`,
    );
    this.video.currentTime = timestamp;

    // Highlight the selected preview
    this._highlightSelectedPreview(timestamp);

    // Play if video is not playing
    if (this.video.paused) {
      this.video.play().catch((err) => {
        Logger.debug(
          "iframe",
          "Auto-play prevented, user interaction required",
          err,
        );
      });
    }
  }

  /**
   * Highlight the currently selected preview
   * @param {number} timestamp - Selected timestamp
   */
  _highlightSelectedPreview(timestamp) {
    this.timelinePreviews.forEach((preview) => {
      preview.element.classList.remove("selected");
    });

    const selected = this.timelinePreviews.find(
      (p) => Math.abs(p.timestamp - timestamp) < 0.5,
    );
    if (selected) {
      selected.element.classList.add("selected");

      // Scroll into view if needed
      selected.element.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  }

  /**
   * Clear all timeline previews
   */
  clearTimelinePreviews() {
    Logger.info("iframe", "Clearing timeline previews");

    // Clean up object URLs to prevent memory leaks
    if (this.thumbnailUrls) {
      this.thumbnailUrls.forEach((url) => {
        if (url && url.startsWith("blob:")) {
          URL.revokeObjectURL(url);
        }
      });
      this.thumbnailUrls = [];
    }

    // Clear container
    if (this.timelineContainer) {
      this.timelineContainer.innerHTML = "";
    }

    // Reset state
    this.timelinePreviews = [];
    this.isPreloading = false;
    this.preloadQueue = [];
    this.currentBatchIndex = 0;
    this.totalThumbnails = 0;

    Logger.debug("iframe", "Timeline previews cleared");
  }

  /**
   * Inject CSS styles for timeline previews
   */
  _injectTimelineStyles() {
    if (document.getElementById("hls-timeline-styles")) return;

    const styles = `
      <style id="hls-timeline-styles">
        .hls-timeline-previews {
          display: flex;
          overflow-x: auto;
          gap: 12px;
          padding: 16px;
          background: #1a1a1a;
          border-radius: 8px;
          margin: 16px 0;
          scrollbar-width: thin;
        }
        
        .hls-timeline-previews::-webkit-scrollbar {
          height: 8px;
        }
        
        .hls-timeline-previews::-webkit-scrollbar-track {
          background: #333;
          border-radius: 4px;
        }
        
        .hls-timeline-previews::-webkit-scrollbar-thumb {
          background: #666;
          border-radius: 4px;
        }
        
        .timeline-preview-item {
          flex-shrink: 0;
          width: 120px;
          background: #2a2a2a;
          border-radius: 6px;
          overflow: hidden;
          cursor: pointer;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          position: relative;
        }
        
        .timeline-preview-item:hover {
          transform: translateY(-4px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        
        .timeline-preview-item.selected {
          box-shadow: 0 0 0 2px #4CAF50;
          transform: scale(1.02);
        }
        
        .preview-thumbnail {
          width: 100%;
          aspect-ratio: 16/9;
          background: #1a1a1a;
          position: relative;
          overflow: hidden;
        }
        
        .preview-image {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        
        .preview-loading, .preview-error {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .preview-loading.loading-active {
          animation: pulse 1s infinite;
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        
        .preview-time {
          padding: 6px 8px;
          font-size: 11px;
          color: #ccc;
          text-align: center;
          background: #222;
          font-family: monospace;
        }
        
        .preview-seek-btn {
          position: absolute;
          bottom: 24px;
          right: 4px;
          background: rgba(0,0,0,0.7);
          border-radius: 50%;
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          opacity: 0;
          transition: opacity 0.2s ease;
          pointer-events: none;
        }
        
        .timeline-preview-item:hover .preview-seek-btn {
          opacity: 1;
        }
      </style>
    `;

    document.head.insertAdjacentHTML("beforeend", styles);
    Logger.debug("iframe", "Timeline preview styles injected");
  }

  /**
   * Format time in MM:SS or HH:MM:SS format
   * @param {number} seconds - Time in seconds
   * @returns {string} - Formatted time string
   */
  _formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  }

  /**
   * Delay helper
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise} - Promise that resolves after delay
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get timeline preview status
   * @returns {Object} - Status object
   */
  getTimelineStatus() {
    const loadedCount = this.timelinePreviews.filter((p) => p.loaded).length;
    const errorCount = this.timelinePreviews.filter((p) => p.error).length;
    const pendingCount = this.totalThumbnails - loadedCount - errorCount;

    return {
      total: this.totalThumbnails,
      loaded: loadedCount,
      error: errorCount,
      pending: pendingCount,
      isPreloading: this.isPreloading,
      percentageComplete:
        this.totalThumbnails > 0
          ? ((loadedCount / this.totalThumbnails) * 100).toFixed(1)
          : 0,
    };
  }

  // ==========================================================================
  // Video I-Frame Player
  // ==========================================================================

  /**
   * Create and initialize video I-frame player
   * @param {HTMLVideoElement} iFrameVideoEl - Video element for I-frame playback
   */
  createVideoIFramePlayer(iFrameVideoEl) {
    if (!this.hls) {
      Logger.error("iframe", "Cannot create I-frame player: hls not available");
      return null;
    }

    if (this.hls.iframeVariants?.length === 0) {
      Logger.warn("iframe", "No I-frame variants available in stream");
      return null;
    }

    Logger.info("iframe", "Creating video I-frame player");
    this.iFrameVideoEl = iFrameVideoEl;
    this.iFramePlayer = this.hls.createIFramePlayer();

    if (this.iFramePlayer) {
      this.iFramePlayer.attachMedia(iFrameVideoEl);

      // I-frame player events
      this.iFramePlayer.on(Hls.Events.FRAG_BUFFERED, (event, data) => {
        Logger.debug("iframe", "🖼️ I-frame buffered", {
          start: data.frag.start,
          duration: data.frag.duration,
        });
      });

      this.iFramePlayer.on(Hls.Events.FRAG_LOADED, (event, data) => {
        Logger.debug("iframe", "I-frame fragment loaded", {
          url: data.frag.relurl,
        });
      });

      this.iFramePlayer.on(Hls.Events.ERROR, (event, data) => {
        Logger.error("iframe", "I-frame player error", {
          type: data.type,
          details: data.details,
        });
      });

      this.iFramePlayer.startLoad();
      Logger.info("iframe", "✓ Video I-frame player created and loading");
    } else {
      Logger.error("iframe", "Failed to create I-frame player");
    }

    return this.iFramePlayer;
  }

  /**
   * Show I-frame preview at specific time
   */
  showPreviewAtTime(currentTime) {
    if (!this.iFramePlayer || !this.iFrameVideoEl) {
      Logger.warn("iframe", "I-frame player not available");
      return;
    }

    Logger.info(
      "iframe",
      `🖼️ Showing I-frame preview at ${currentTime.toFixed(2)}s`,
    );
    this.iFrameVideoEl.style.display = "block";
    this.iFrameVideoEl.onseeked = () => {
      Logger.debug("iframe", "✓ Preview frame rendered");
    };
    this.iFramePlayer.loadMediaAt(currentTime);
  }

  /**
   * Preload frame without seeking
   */
  preloadFrameAtTime(time) {
    if (!this.iFramePlayer) {
      Logger.warn("iframe", "I-frame player not available");
      return;
    }

    Logger.debug("iframe", `Preloading I-frame at ${time.toFixed(2)}s`);
    this.iFramePlayer.loadMediaAt(time, { seekOnAppend: false });
  }

  /**
   * Hide I-frame preview
   */
  hidePreview() {
    if (this.iFrameVideoEl) {
      this.iFrameVideoEl.style.display = "none";
      Logger.debug("iframe", "I-frame preview hidden");
    }
    if (this.iFramePlayer) {
      this.iFramePlayer.stopLoad();
      Logger.debug("iframe", "I-frame player loading stopped");
    }
  }

  // ==========================================================================
  // Image I-Frame Player (JPEG Thumbnails)
  // ==========================================================================

  /**
   * Create image I-frame player
   * @param {HTMLImageElement} thumbnailImgEl - Image element for thumbnail display
   */
  createImageIFramePlayer(thumbnailImgEl) {
    if (!this.hls) {
      Logger.error("iframe", "Cannot create image player: hls not available");
      return null;
    }

    Logger.info("iframe", "Creating image I-frame player");
    this.thumbnailImgEl = thumbnailImgEl;
    this.imagePlayer = this.hls.createImageIFramePlayer();

    if (this.imagePlayer) {
      this.imagePlayer.attachImage(thumbnailImgEl);

      this.imagePlayer.on(Hls.Events.FRAG_BUFFERED, (event, data) => {
        Logger.debug("iframe", "🖼️ Thumbnail rendered at", {
          time: data.frag.start,
        });
      });

      this.imagePlayer.on(Hls.Events.FRAG_LOADED, (event, data) => {
        Logger.debug("iframe", "Thumbnail fragment loaded");
      });

      this.imagePlayer.on(Hls.Events.ERROR, (event, data) => {
        Logger.error("iframe", "Image player error", {
          type: data.type,
          details: data.details,
        });
      });

      Logger.info("iframe", "✓ Image I-frame player created");
    } else {
      Logger.error("iframe", "Failed to create image I-frame player");
    }

    return this.imagePlayer;
  }

  /**
   * Show thumbnail at specific time
   */
  showThumbnailAtTime(time) {
    if (!this.imagePlayer) {
      Logger.warn("iframe", "Image player not available");
      return;
    }

    Logger.debug("iframe", `🖼️ Loading thumbnail at ${time.toFixed(2)}s`);
    this.imagePlayer.loadMediaAt(time);
  }

  // ==========================================================================
  // Custom Image Processing
  // ==========================================================================

  /**
   * Create image player with custom processing callback
   * @param {Function} onFrameCallback - Called with JPEG data Uint8Array
   */
  createCustomImageProcessor(onFrameCallback) {
    if (!this.hls) {
      Logger.error(
        "iframe",
        "Cannot create custom processor: hls not available",
      );
      return null;
    }

    Logger.info("iframe", "Creating custom image processor");
    const imagePlayer = this.hls.createImageIFramePlayer();

    if (imagePlayer) {
      imagePlayer.on(Hls.Events.FRAG_PARSED, (event, data) => {
        const jpegBytes = data.frag.data;
        Logger.debug("iframe", "JPEG frame parsed", {
          size: jpegBytes.length + " bytes",
          time: data.frag.start,
        });

        if (onFrameCallback) {
          onFrameCallback(jpegBytes, data.frag.start);
        }
      });

      Logger.info("iframe", "✓ Custom image processor created");
    }

    return imagePlayer;
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------
  getIFrameStatus() {
    const status = {
      hasIFrameVariants: (this.hls?.iframeVariants?.length || 0) > 0,
      videoPlayerActive: !!this.iFramePlayer,
      imagePlayerActive: !!this.imagePlayer,
      iframeVariantCount: this.hls?.iframeVariants?.length || 0,
      timelineEnabled: this.timelinePreviews.length > 0,
      timelineStatus: this.getTimelineStatus(),
    };

    Logger.info("iframe", "I-frame status", status);
    return status;
  }

  /**
   * Get all loaded thumbnail URLs
   * @returns {Array<string>} Array of blob URLs
   */
  getThumbnailUrls() {
    return this.timelinePreviews
      .filter((p) => p.loaded && p.imageUrl)
      .map((p) => p.imageUrl);
  }

  /**
   * Get thumbnail URL for a specific timestamp
   * @param {number} timestamp - Timestamp in seconds
   * @returns {string|null} Blob URL or null if not loaded
   */
  getThumbnailUrlAt(timestamp) {
    const preview = this.timelinePreviews.find(
      (p) => Math.abs(p.timestamp - timestamp) < 0.5,
    );
    return preview?.imageUrl || null;
  }

  /**
   * Get all preview data including URLs
   * @returns {Array<Object>} Array of preview objects with URLs
   */
  getAllPreviews() {
    return this.timelinePreviews.map((p) => ({
      index: p.index,
      timestamp: p.timestamp,
      formattedTime: this._formatTime(p.timestamp),
      loaded: p.loaded,
      error: p.error,
      imageUrl: p.imageUrl, // ← This is the blob URL for img src
      element: p.element,
      percent: p.percent,
    }));
  }

  /**
   * Get thumbnail URLs without creating UI elements
   * @param {number} duration - Video duration
   * @param {number} count - Number of thumbnails
   * @returns {Promise<Array<{timestamp: number, url: string}>>}
   */
  async getThumbnailUrlsOnly(duration, count) {
    const timestamps = this.calculateThumbnailTimestamps(duration, count);
    const results = [];

    for (const ts of timestamps) {
      try {
        const tempPlayer = this.hls.createImageIFramePlayer();
        if (!tempPlayer) continue;

        const url = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);

          tempPlayer.on(Hls.Events.FRAG_PARSED, (event, data) => {
            clearTimeout(timeout);
            const jpegBytes = data.frag.data;
            const blob = new Blob([jpegBytes], { type: "image/jpeg" });
            const blobUrl = URL.createObjectURL(blob);
            tempPlayer.destroy();
            resolve(blobUrl);
          });

          tempPlayer.on(Hls.Events.ERROR, (event, data) => {
            clearTimeout(timeout);
            reject(new Error(data.details));
          });

          tempPlayer.loadMediaAt(ts.timestamp);
        });

        results.push({
          timestamp: ts.timestamp,
          formattedTime: this._formatTime(ts.timestamp),
          url: url,
        });
      } catch (error) {
        console.error(`Failed at ${ts.timestamp}s:`, error);
        results.push({
          timestamp: ts.timestamp,
          formattedTime: this._formatTime(ts.timestamp),
          url: null,
          error: error.message,
        });
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------
  destroy() {
    Logger.info("iframe", "Destroying IFrameController...");

    // Clear timeline previews
    this.clearTimelinePreviews();

    if (this.iFramePlayer) {
      this.iFramePlayer.stopLoad();
      this.iFramePlayer = null;
      Logger.debug("iframe", "Video I-frame player destroyed");
    }

    if (this.imagePlayer) {
      this.imagePlayer = null;
      Logger.debug("iframe", "Image player destroyed");
    }

    Logger.info("iframe", "✓ IFrameController destroyed");
  }
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = IFrameController;
}
if (typeof window !== "undefined") {
  window.IFrameController = IFrameController;
}
Logger.info(
  "iframe",
  "✓ I-frame preview module loaded with smart timeline support",
);
