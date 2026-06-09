/* overlay.js
 * ═══════════════════════════════════════════════════════════════
 * Video Overlay Controller
 *
 * Handles creating, showing, closing, and controlling the floating
 * video overlay player. Extracted from content.js for modularity.
 *
 * Integrates with ScrubberSystem (scrubber.js) for:
 *   - Progress bar with thumb
 *   - Buffered regions display
 *   - Hover thumbnail preview popup
 *
 * PUBLIC API (exposed on window.VideoOverlay):
 *   setup(deps)          - Inject dependencies from content.js
 *   show(videoEl, entry) - Open overlay with a video
 *   close()              - Close the overlay
 *   isShowing(videoEl)   - Check if a specific video is in overlay
 *   getCurrentVideo()    - Get the currently displayed video
 *   destroy()            - Full cleanup
 *
 * DEPENDENCIES (injected via setup):
 *   - enforceSinglePlayback(videoEl) from content.js
 *   - log(message, data) from content.js
 *   - ScrubberSystem (window.ScrubberSystem) from scrubber.js
 * ═══════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // ─── Private state ───────────────────────────────────────────
  let _overlayEl = null; // #vo-overlay DOM element
  let _currentVideo = null; // currently displayed <video>
  let _currentEntry = null; // associated entry object
  let _scrubberController = null; // ScrubberSystem controller instance
  let _keydownCleanup = null; // ESC key handler cleanup
  let _deps = null; // { enforceSinglePlayback, log }

  // ─── Setup: receive dependencies from content.js ─────────────
  /**
   * Must be called once before any other function.
   * @param {Object} deps
   * @param {Function} deps.enforceSinglePlayback
   * @param {Function} deps.log
   */
  function setup(deps) {
    _deps = deps;
    console.log("[Overlay] ✅ Dependencies injected:", Object.keys(deps));

    // Verify scrubber system is available
    if (typeof window.ScrubberSystem === "undefined") {
      console.warn(
        "[Overlay] ⚠️ ScrubberSystem not found! scrubber.js may be missing. " +
          "Scrubber features (progress bar, thumbnails) will be disabled.",
      );
    } else {
      console.log("[Overlay] ✅ ScrubberSystem detected");
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────
  function _log(message, data) {
    if (_deps && _deps.log) {
      _deps.log(message, data);
    } else {
      console.log(`[Overlay] ${message}`, data || "");
    }
  }

  // ─── DOM Creation ────────────────────────────────────────────
  function create() {
    if (_overlayEl) {
      _log("Overlay DOM already exists, skipping create()");
      return;
    }

    _log("Creating overlay DOM...");

    const overlay = document.createElement("div");
    overlay.id = "vo-overlay";
    overlay.innerHTML = `
      <div id="vo-player" data-size="m">
        <div id="vo-video-wrap">
          <button id="vo-close" title="Close (Esc)">✕</button>
        </div>
        <div id="vo-controls">
          <div id="vo-top-row">
            <div id="vo-title">—</div>
            <div id="vo-size-btns">
              <button class="vo-size-btn" data-size="s">S</button>
              <button class="vo-size-btn active" data-size="m">M</button>
              <button class="vo-size-btn" data-size="l">L</button>
            </div>
          </div>
          <!-- Scrubber + bottom row injected by ScrubberSystem -->
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    _overlayEl = overlay;

    // ─── Event bindings ────────────────────────────────────────

    // Close on scrim click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        _log("Scrim clicked → closing overlay");
        close();
      }
    });

    // Close button
    document.getElementById("vo-close").addEventListener("click", () => {
      _log("Close button clicked");
      close();
    });

    // ESC key
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        _log("ESC key pressed → closing overlay");
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    _keydownCleanup = () => document.removeEventListener("keydown", onKeyDown);

    // Size mode buttons
    document.getElementById("vo-size-btns").addEventListener("click", (e) => {
      const btn = e.target.closest(".vo-size-btn");
      if (!btn) return;
      const size = btn.dataset.size;
      const player = document.getElementById("vo-player");
      player.dataset.size = size;
      document.querySelectorAll(".vo-size-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.size === size);
      });
      _log(`Size mode → ${size}`);
    });

    // Play/pause button (delegated — created by ScrubberSystem)
    // We use event delegation on #vo-controls since scrubber buttons
    // are injected dynamically
    document.getElementById("vo-controls").addEventListener("click", (e) => {
      const playPauseBtn = e.target.closest("#vo-playpause");
      const muteBtn = e.target.closest("#vo-mute");
      const pipBtn = e.target.closest("#vo-pip");

      if (playPauseBtn) {
        const video = _currentVideo;
        if (!video) return;
        if (video.paused) {
          _log("Play button clicked");
          if (_deps && _deps.enforceSinglePlayback) {
            _deps.enforceSinglePlayback(video);
          }
          video.play().catch((err) => {
            console.warn("[Overlay] Play failed:", err);
          });
        } else {
          _log("Pause button clicked");
          video.pause();
        }
        return;
      }

      if (muteBtn) {
        const video = _currentVideo;
        if (!video) return;
        video.muted = !video.muted;
        muteBtn.textContent = video.muted ? "🔇 Unmute" : "🔊 Mute";
        _log(`Mute toggled → ${video.muted ? "muted" : "unmuted"}`);
        return;
      }

      if (pipBtn) {
        const video = _currentVideo;
        if (!video) return;
        (async () => {
          try {
            if (document.pictureInPictureElement) {
              _log("Exiting PiP");
              await document.exitPictureInPicture();
            } else if (video.requestPictureInPicture) {
              _log("Entering PiP");
              await video.requestPictureInPicture();
            }
          } catch (err) {
            console.warn("[Overlay] PiP failed:", err);
          }
        })();
        return;
      }
    });

    _log("✅ Overlay DOM created with all event bindings");
  }

  // ─── DOM Return Logic ────────────────────────────────────────
  function _returnVideoToOriginalParent(videoEl) {
    if (!videoEl._overlayOriginalParent) {
      _log(
        `No original parent stored for ${videoEl.dataset.videoObserverId}, skipping return`,
      );
      return;
    }

    const parent = videoEl._overlayOriginalParent;
    const nextSib = videoEl._overlayOriginalNextSibling;

    try {
      if (nextSib && nextSib.parentElement === parent) {
        parent.insertBefore(videoEl, nextSib);
      } else {
        parent.appendChild(videoEl);
      }
      _log(`Returned ${videoEl.dataset.videoObserverId} to original DOM`);
    } catch (err) {
      console.warn("[Overlay] Could not return video to original parent:", err);
    }

    delete videoEl._overlayOriginalParent;
    delete videoEl._overlayOriginalNextSibling;
  }

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Open the overlay with a specific video element.
   * Moves the actual <video> DOM node into the overlay and
   * attaches the scrubber system.
   *
   * @param {HTMLVideoElement} videoEl - The video to display
   * @param {Object} entry - The video entry object with { id }
   */
  function show(videoEl, entry) {
    _log(`show() called for ${entry.id}`);

    // Create overlay DOM if it doesn't exist yet
    if (!_overlayEl) {
      create();
    }

    const videoWrap = document.getElementById("vo-video-wrap");
    const title = document.getElementById("vo-title");
    const controlsContainer = document.getElementById("vo-controls");

    // Detach any previous video + scrubber from overlay
    if (_currentVideo && _currentVideo !== videoEl) {
      _log("Detaching previous video and scrubber from overlay");

      // Detach scrubber from old video
      if (_scrubberController) {
        _scrubberController.detach();
      }

      _returnVideoToOriginalParent(_currentVideo);
    }

    // Store original parent so we can return the video element later
    if (!videoEl._overlayOriginalParent) {
      videoEl._overlayOriginalParent = videoEl.parentElement;
      videoEl._overlayOriginalNextSibling = videoEl.nextSibling;
      _log(
        `Stored original parent for ${entry.id}: ${videoEl._overlayOriginalParent?.tagName || "unknown"}`,
      );
    }

    // Move the actual video element into the overlay
    const closeBtn = document.getElementById("vo-close");
    videoWrap.insertBefore(videoEl, closeBtn);

    // Set title
    const src = videoEl.currentSrc || videoEl.src || "";
    const filename = src.split("/").pop().split("?")[0] || entry.id;
    title.textContent = `${entry.id} — ${filename}`;

    // ─── Initialize or re-attach scrubber system ────────────────
    if (typeof window.ScrubberSystem !== "undefined") {
      if (!_scrubberController) {
        // First time: create the scrubber controller (injects DOM)
        _scrubberController =
          window.ScrubberSystem.createScrubberController(controlsContainer);
        _log("Scrubber controller created (DOM injected)");
      }
      // Attach scrubber to the new video
      _scrubberController.attach(videoEl);
      _log(
        `Scrubber attached to ${entry.id} (${_scrubberController.getThumbnailCount()} thumbnails cached)`,
      );
    } else {
      _log("⚠️ ScrubberSystem unavailable — no progress bar or thumbnails");
    }

    // Mark which video is in the overlay
    _currentVideo = videoEl;
    _currentEntry = entry;

    // Show with transition
    requestAnimationFrame(() => {
      _overlayEl.classList.add("visible");
    });

    _log(`✅ Overlay opened for ${entry.id}`);
  }

  /**
   * Close the overlay and return the video to its original DOM position.
   */
  function close() {
    if (!_overlayEl) {
      _log("close() called but overlay doesn't exist");
      return;
    }

    const video = _currentVideo;
    _log(
      `close() called${video ? ` for ${video.dataset.videoObserverId}` : ""}`,
    );

    _overlayEl.classList.remove("visible");

    // Wait for transition to finish before moving the video back
    const onTransitionEnd = () => {
      _overlayEl.removeEventListener("transitionend", onTransitionEnd);

      if (video) {
        // Detach scrubber (keeps thumbnails cached for re-open)
        if (_scrubberController) {
          _scrubberController.detach();
          _log(
            `Scrubber detached (${_scrubberController.getThumbnailCount()} thumbnails preserved)`,
          );
        }

        _returnVideoToOriginalParent(video);
        _currentVideo = null;
        _currentEntry = null;
      }

      _log("✅ Overlay closed, video returned to DOM");
    };

    _overlayEl.addEventListener("transitionend", onTransitionEnd, {
      once: true,
    });

    // Fallback in case transition doesn't fire
    setTimeout(() => {
      if (_currentVideo === video && video) {
        _log("Transition fallback triggered");
        onTransitionEnd();
      }
    }, 400);
  }

  /**
   * Check if a specific video element is currently displayed in the overlay.
   *
   * @param {HTMLVideoElement} videoEl
   * @returns {boolean}
   */
  function isShowing(videoEl) {
    return (
      _overlayEl !== null &&
      _currentVideo === videoEl &&
      _overlayEl.classList.contains("visible")
    );
  }

  /**
   * Get the currently displayed video element (or null).
   *
   * @returns {HTMLVideoElement|null}
   */
  function getCurrentVideo() {
    return _currentVideo;
  }

  /**
   * Clean up all overlay resources.
   * Called on extension unload or page teardown.
   */
  function destroy() {
    _log("Destroying overlay...");

    if (_currentVideo) {
      close();
    }

    // Full scrubber cleanup (frees canvas + thumbnails)
    if (_scrubberController) {
      _scrubberController.cleanup();
      _scrubberController = null;
      _log("Scrubber fully cleaned up (memory freed)");
    }

    if (_keydownCleanup) {
      _keydownCleanup();
      _keydownCleanup = null;
    }

    if (_overlayEl) {
      _overlayEl.remove();
      _overlayEl = null;
    }

    _currentVideo = null;
    _currentEntry = null;

    _log("✅ Overlay destroyed");
  }

  // ─── Expose public API on window ─────────────────────────────
  window.VideoOverlay = {
    setup,
    create,
    show,
    close,
    isShowing,
    getCurrentVideo,
    destroy,
  };

  console.log("[Overlay] Module loaded, API exposed at window.VideoOverlay");
})();
