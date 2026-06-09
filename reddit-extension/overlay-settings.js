/* overlay-settings.js
 * ═══════════════════════════════════════════════════════════════
 * Video Overlay Settings Controller
 *
 * Provides a settings panel for adjusting video visibility:
 *   - Brightness  (0.3 – 2.0)
 *   - Contrast    (0.3 – 2.0)
 *   - Saturation  (0.0 – 2.0)
 *   - Zoom        (1.0 – 3.0) + drag-to-pan
 *
 * Settings are persisted per-session in memory and applied
 * as CSS filters + transform on the video element.
 *
 * PUBLIC API (exposed on window.OverlaySettings):
 *   createSettingsUI(overlayEl) → injects toggle button + panel
 *   applyTo(videoEl)            → apply current filters to video
 *   getState()                  → returns current settings
 *   reset()                     → restore defaults
 *   togglePanel()               → show/hide settings panel
 *   destroy()                   → cleanup
 * ═══════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // ─── Default values ─────────────────────────────────────────
  const DEFAULTS = {
    brightness: 1.0, // 1.0 = normal
    contrast: 1.0,
    saturation: 1.0,
    zoom: 1.0,
    panX: 0, // px offset from center
    panY: 0,
  };

  const RANGES = {
    brightness: { min: 0.3, max: 2.0, step: 0.05 },
    contrast: { min: 0.3, max: 2.0, step: 0.05 },
    saturation: { min: 0.0, max: 2.0, step: 0.05 },
    zoom: { min: 1.0, max: 3.0, step: 0.05 },
  };

  const LABELS = {
    brightness: "☀ Brightness",
    contrast: "◐ Contrast",
    saturation: "🎨 Saturation",
    zoom: "🔍 Zoom",
  };

  // ─── State ──────────────────────────────────────────────────
  let _state = { ...DEFAULTS };
  let _panelEl = null;
  let _toggleBtn = null;
  let _overlayEl = null;
  let _currentVideo = null;
  let _sliderRefs = {}; // { key: input element }
  let _valueRefs = {}; // { key: value display span }
  let _isPanning = false;
  let _panStart = { x: 0, y: 0 };
  let _panStartState = { x: 0, y: 0 };

  // ─── Helpers ─────────────────────────────────────────────────
  function _log(msg, data) {
    console.log(`[OverlaySettings] ${msg}`, data || "");
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // ─── Apply filters to video element ──────────────────────────
  /**
   * Applies brightness, contrast, saturation as CSS filters
   * and zoom + pan as CSS transform on the video element.
   *
   * @param {HTMLVideoElement} videoEl
   */
  function applyTo(videoEl) {
    if (!videoEl) {
      _log("applyTo() called with null video, skipping");
      return;
    }

    _currentVideo = videoEl;

    const { brightness, contrast, saturation, zoom, panX, panY } = _state;

    // Build CSS filter string (only include non-default values for perf)
    const filters = [];
    if (brightness !== 1.0) filters.push(`brightness(${brightness})`);
    if (contrast !== 1.0) filters.push(`contrast(${contrast})`);
    if (saturation !== 1.0) filters.push(`saturate(${saturation})`);

    videoEl.style.filter = filters.length > 0 ? filters.join(" ") : "none";

    // Apply zoom + pan via transform
    if (zoom !== 1.0 || panX !== 0 || panY !== 0) {
      videoEl.style.transform = `scale(${zoom}) translate(${panX}px, ${panY}px)`;
      videoEl.style.transformOrigin = "center center";
    } else {
      videoEl.style.transform = "";
      videoEl.style.transformOrigin = "";
    }

    // Ensure the video container allows overflow for zoom
    const wrap = videoEl.closest("#vo-video-wrap");
    if (wrap) {
      if (zoom > 1.0) {
        wrap.style.overflow = "hidden"; // clip zoomed content
      } else {
        wrap.style.overflow = "";
      }
    }

    _log(
      `Filters applied: ${filters.join(", ") || "none"} | zoom: ${zoom.toFixed(2)}`,
    );
  }

  // ─── Update all sliders and labels ──────────────────────────
  function _syncUI() {
    for (const [key, slider] of Object.entries(_sliderRefs)) {
      if (slider && _state[key] !== undefined) {
        slider.value = _state[key];
      }
    }
    for (const [key, display] of Object.entries(_valueRefs)) {
      if (display && _state[key] !== undefined) {
        const val = _state[key];
        if (key === "zoom") {
          display.textContent = `${val.toFixed(2)}x`;
        } else {
          display.textContent = `${Math.round(val * 100)}%`;
        }
      }
    }
  }

  // ─── Handle slider changes ──────────────────────────────────
  function _onSliderChange(key, value) {
    _state[key] = parseFloat(value);
    // Update label
    if (_valueRefs[key]) {
      if (key === "zoom") {
        _valueRefs[key].textContent = `${_state[key].toFixed(2)}x`;
      } else {
        _valueRefs[key].textContent = `${Math.round(_state[key] * 100)}%`;
      }
    }
    // Apply to current video immediately
    if (_currentVideo) {
      applyTo(_currentVideo);
    }
    _log(`${key} → ${_state[key].toFixed(2)}`);
  }

  // ─── Pan handlers (drag to pan when zoomed) ─────────────────
  function _onVideoMouseDown(e) {
    if (_state.zoom <= 1.0) return; // Only pan when zoomed
    if (e.button !== 0) return; // Left click only
    e.preventDefault();
    _isPanning = true;
    _panStart = { x: e.clientX, y: e.clientY };
    _panStartState = { x: _state.panX, y: _state.panY };
    _currentVideo.style.cursor = "grabbing";
    _log("Pan started");
  }

  function _onVideoMouseMove(e) {
    if (!_isPanning || !_currentVideo) return;
    const dx = e.clientX - _panStart.x;
    const dy = e.clientY - _panStart.y;
    // Scale movement inversely with zoom (slower pan at high zoom)
    const scale = _state.zoom;
    _state.panX = _panStartState.x + dx / scale;
    _state.panY = _panStartState.y + dy / scale;
    // Clamp pan to reasonable bounds
    const maxPan = 200;
    _state.panX = clamp(_state.panX, -maxPan, maxPan);
    _state.panY = clamp(_state.panY, -maxPan, maxPan);
    applyTo(_currentVideo);
  }

  function _onVideoMouseUp() {
    if (_isPanning) {
      _isPanning = false;
      if (_currentVideo) _currentVideo.style.cursor = "";
      _log("Pan ended");
    }
  }

  // ─── Reset to defaults ──────────────────────────────────────
  function reset() {
    _log("Resetting to defaults");
    _state = { ...DEFAULTS };
    _syncUI();
    if (_currentVideo) {
      applyTo(_currentVideo);
      _currentVideo.style.cursor = "";
    }
  }

  // ─── Toggle settings panel visibility ───────────────────────
  function togglePanel() {
    if (!_panelEl) return;
    const isVisible = _panelEl.classList.toggle("visible");
    if (_toggleBtn) {
      _toggleBtn.classList.toggle("active", isVisible);
    }
    _log(`Settings panel ${isVisible ? "opened" : "closed"}`);
  }

  // ─── Create settings UI ─────────────────────────────────────
  /**
   * Injects the settings toggle button into the overlay controls
   * and creates the settings panel inside the overlay.
   *
   * @param {HTMLElement} overlayEl - The #vo-overlay element
   */
  function createSettingsUI(overlayEl) {
    if (_panelEl) {
      _log("Settings UI already exists");
      return;
    }

    _overlayEl = overlayEl;
    _log("Creating settings UI...");

    // ─── 1. Add toggle button to the controls button row ───────
    const btnRow = overlayEl.querySelector("#vo-btn-row");
    if (btnRow) {
      _toggleBtn = document.createElement("button");
      _toggleBtn.className = "vo-btn";
      _toggleBtn.id = "vo-settings-toggle";
      _toggleBtn.title = "Video Settings";
      _toggleBtn.textContent = "⚙";
      _toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePanel();
      });
      btnRow.appendChild(_toggleBtn);
      _log("⚙ Settings toggle button added to controls");
    } else {
      console.warn(
        "[OverlaySettings] #vo-btn-row not found, cannot add toggle",
      );
    }

    // ─── 2. Create settings panel ──────────────────────────────
    _panelEl = document.createElement("div");
    _panelEl.id = "vo-settings-panel";
    _panelEl.innerHTML = `
      <div class="vo-settings-header">
        <span>Video Settings</span>
        <button class="vo-settings-close" title="Close">✕</button>
      </div>
      <div class="vo-settings-body">
        ${Object.entries(RANGES)
          .map(
            ([key, range]) => `
          <div class="vo-setting-row" data-setting="${key}">
            <label>${LABELS[key]}</label>
            <div class="vo-setting-controls">
              <input
                type="range"
                min="${range.min}"
                max="${range.max}"
                step="${range.step}"
                value="${DEFAULTS[key]}"
                class="vo-setting-slider"
                data-key="${key}"
              />
              <span class="vo-setting-value" data-key="${key}">
                ${key === "zoom" ? `${DEFAULTS[key].toFixed(2)}x` : `${Math.round(DEFAULTS[key] * 100)}%`}
              </span>
            </div>
          </div>
        `,
          )
          .join("")}
      </div>
      <div class="vo-settings-footer">
        <button id="vo-settings-reset" class="vo-settings-reset-btn">↺ Reset All</button>
      </div>
    `;

    overlayEl.appendChild(_panelEl);

    // ─── 3. Bind slider events ────────────────────────────────
    _panelEl.querySelectorAll(".vo-setting-slider").forEach((slider) => {
      const key = slider.dataset.key;
      _sliderRefs[key] = slider;
      slider.addEventListener("input", (e) => {
        _onSliderChange(key, e.target.value);
      });
    });

    // Store value display refs
    _panelEl.querySelectorAll(".vo-setting-value").forEach((span) => {
      const key = span.dataset.key;
      _valueRefs[key] = span;
    });

    // ─── 4. Close button ──────────────────────────────────────
    _panelEl
      .querySelector(".vo-settings-close")
      .addEventListener("click", () => {
        togglePanel();
      });

    // ─── 5. Reset button ──────────────────────────────────────
    _panelEl
      .querySelector("#vo-settings-reset")
      .addEventListener("click", () => {
        reset();
      });

    // ─── 6. Pan support on video ──────────────────────────────
    // We use event delegation on the overlay since the video
    // element gets moved in/out. The overlay persists.
    overlayEl.addEventListener("mousedown", (e) => {
      if (e.target.closest("#vo-video-wrap video")) {
        _onVideoMouseDown(e);
      }
    });
    document.addEventListener("mousemove", (e) => {
      if (_isPanning) _onVideoMouseMove(e);
    });
    document.addEventListener("mouseup", () => {
      if (_isPanning) _onVideoMouseUp();
    });

    _log("✅ Settings UI created");
  }

  // ─── Get current state (for debugging) ──────────────────────
  function getState() {
    return { ..._state };
  }

  // ─── Cleanup ────────────────────────────────────────────────
  function destroy() {
    _log("Destroying settings UI...");

    if (_currentVideo) {
      _currentVideo.style.filter = "";
      _currentVideo.style.transform = "";
      _currentVideo.style.transformOrigin = "";
      _currentVideo.style.cursor = "";
    }
    _currentVideo = null;

    if (_panelEl) {
      _panelEl.remove();
      _panelEl = null;
    }

    if (_toggleBtn) {
      _toggleBtn.remove();
      _toggleBtn = null;
    }

    _sliderRefs = {};
    _valueRefs = {};
    _state = { ...DEFAULTS };
    _overlayEl = null;

    _log("✅ Settings UI destroyed");
  }

  // ─── Expose public API ──────────────────────────────────────
  window.OverlaySettings = {
    createSettingsUI,
    applyTo,
    getState,
    reset,
    togglePanel,
    destroy,
    DEFAULTS,
    RANGES,
  };

  console.log("[OverlaySettings] Module loaded, API at window.OverlaySettings");
})();
