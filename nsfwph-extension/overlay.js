/* overlay.js */
(function () {
  "use strict";
  // ─── Private state ───────────────────────────────────────────
  let _overlayEl = null;
  let _currentVideo = null;
  let _currentEntry = null;
  let _scrubberController = null;
  let _keydownCleanup = null;
  let _deps = null;

  function setup(deps) {
    _deps = deps;
    console.log("[Overlay] ✅ Dependencies injected:", Object.keys(deps));
    if (typeof window.ScrubberSystem === "undefined") {
      console.warn("[Overlay] ⚠️ ScrubberSystem not found!");
    } else {
      console.log("[Overlay] ✅ ScrubberSystem detected");
    }
  }

  function _log(message, data) {
    if (_deps && _deps.log) {
      _deps.log(message, data);
    } else {
      console.log(`[Overlay] ${message}`, data || "");
    }
  }

  function create() {
    if (_overlayEl) {
      _log("Overlay DOM already exists, skipping create()");
      return;
    }
    _log("Creating overlay DOM with #vo-media-wrap...");
    const overlay = document.createElement("div");
    overlay.id = "vo-overlay";
    overlay.innerHTML = `
      <div id="vo-player" data-size="m">
        <div id="vo-media-wrap">
          <div id="vo-video-wrap">
            <button id="vo-close" title="Close (Esc)">✕</button>
          </div>
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
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    _overlayEl = overlay;

    // Close on scrim click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        _log("Scrim clicked → closing overlay");
        close();
      }
    });

    document.getElementById("vo-close").addEventListener("click", () => {
      _log("Close button clicked");
      close();
    });

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        _log("ESC key pressed → closing overlay");
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    _keydownCleanup = () => document.removeEventListener("keydown", onKeyDown);

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

    document.getElementById("vo-controls").addEventListener("click", (e) => {
      const playPauseBtn = e.target.closest("#vo-playpause");
      const muteBtn = e.target.closest("#vo-mute");
      const pipBtn = e.target.closest("#vo-pip");
      if (playPauseBtn) {
        const video = _currentVideo;
        if (!video) return;
        if (video.paused) {
          _log("Play button clicked");
          if (_deps && _deps.enforceSinglePlayback)
            _deps.enforceSinglePlayback(video);
          video
            .play()
            .catch((err) => console.warn("[Overlay] Play failed:", err));
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
        return;
      }
      if (pipBtn) {
        const video = _currentVideo;
        if (!video) return;
        (async () => {
          try {
            if (document.pictureInPictureElement)
              await document.exitPictureInPicture();
            else if (video.requestPictureInPicture)
              await video.requestPictureInPicture();
          } catch (err) {
            console.warn("[Overlay] PiP failed:", err);
          }
        })();
        return;
      }
    });
    _log("✅ Overlay DOM created with #vo-media-wrap and event bindings");
  }

  function _returnVideoToOriginalParent(videoEl) {
    if (!videoEl._overlayOriginalParent) return;
    const parent = videoEl._overlayOriginalParent;
    const nextSib = videoEl._overlayOriginalNextSibling;
    try {
      if (nextSib && nextSib.parentElement === parent) {
        parent.insertBefore(videoEl, nextSib);
      } else {
        parent.appendChild(videoEl);
      }
    } catch (err) {
      console.warn("[Overlay] Could not return video to original parent:", err);
    }
    delete videoEl._overlayOriginalParent;
    delete videoEl._overlayOriginalNextSibling;
  }

  function show(videoEl, entry) {
    _log(`show() called for ${entry.id}`);
    if (!_overlayEl) create();

    const videoWrap = document.getElementById("vo-video-wrap");
    const title = document.getElementById("vo-title");
    const controlsContainer = document.getElementById("vo-controls");

    if (_currentVideo && _currentVideo !== videoEl) {
      if (_scrubberController) _scrubberController.detach();
      _returnVideoToOriginalParent(_currentVideo);
    }

    if (!videoEl._overlayOriginalParent) {
      videoEl._overlayOriginalParent = videoEl.parentElement;
      videoEl._overlayOriginalNextSibling = videoEl.nextSibling;
    }

    const closeBtn = document.getElementById("vo-close");
    videoWrap.insertBefore(videoEl, closeBtn);

    const src = videoEl.currentSrc || videoEl.src || "";
    const filename = src.split("/").pop().split("?")[0] || entry.id;
    title.textContent = `${entry.id} — ${filename}`;

    if (typeof window.ScrubberSystem !== "undefined") {
      if (!_scrubberController) {
        _scrubberController =
          window.ScrubberSystem.createScrubberController(controlsContainer);
      }
      _scrubberController.attach(videoEl);
    }

    if (typeof window.OverlaySettings !== "undefined") {
      if (!_overlayEl.querySelector("#vo-settings-panel")) {
        window.OverlaySettings.createSettingsUI(_overlayEl);
      }
      window.OverlaySettings.applyTo(videoEl);
    }

    if (typeof window.OverlayPreviews !== "undefined") {
      window.OverlayPreviews.show(videoEl, entry);
    }

    _currentVideo = videoEl;
    _currentEntry = entry;
    requestAnimationFrame(() => _overlayEl.classList.add("visible"));
    _log(`✅ Overlay opened for ${entry.id}`);
  }

  function close() {
    if (!_overlayEl) return;
    const video = _currentVideo;
    _overlayEl.classList.remove("visible");

    const onTransitionEnd = () => {
      _overlayEl.removeEventListener("transitionend", onTransitionEnd);
      if (video) {
        if (_scrubberController) _scrubberController.detach();
        if (typeof window.OverlayPreviews !== "undefined")
          window.OverlayPreviews.hide();
        _returnVideoToOriginalParent(video);
        _currentVideo = null;
        _currentEntry = null;
      }
      _log("✅ Overlay closed, video returned to DOM");
    };
    _overlayEl.addEventListener("transitionend", onTransitionEnd, {
      once: true,
    });
    setTimeout(() => {
      if (_currentVideo === video && video) onTransitionEnd();
    }, 400);
  }

  function isShowing(videoEl) {
    return (
      _overlayEl !== null &&
      _currentVideo === videoEl &&
      _overlayEl.classList.contains("visible")
    );
  }

  function getCurrentVideo() {
    return _currentVideo;
  }

  function destroy() {
    _log("Destroying overlay...");
    if (_currentVideo) close();
    if (_scrubberController) _scrubberController.cleanup();
    if (typeof window.OverlaySettings !== "undefined")
      window.OverlaySettings.destroy();
    if (typeof window.OverlayPreviews !== "undefined")
      window.OverlayPreviews.destroy();
    if (_keydownCleanup) _keydownCleanup();
    if (_overlayEl) _overlayEl.remove();
    _currentVideo = null;
    _currentEntry = null;
    _scrubberController = null;
    _keydownCleanup = null;
    _overlayEl = null;
    _log("✅ Overlay destroyed");
  }

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
