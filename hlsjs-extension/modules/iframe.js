/**
 * iframe.js - I-Frame Previews (Trick Play) Features
 *
 * Manages I-frame only playback for thumbnail previews and trick play.
 * Supports both video I-frame players and image I-frame players.
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

    Logger.info("iframe", "IFrameController initialized");
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
    };

    Logger.info("iframe", "I-frame status", status);
    return status;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy() {
    Logger.info("iframe", "Destroying IFrameController...");

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

Logger.info("iframe", "✓ I-frame preview module loaded");
