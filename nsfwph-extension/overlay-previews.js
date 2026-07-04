// overlay-previews.js
(function () {
  "use strict";

  const STAGGER_CONCURRENCY = 5; // How many previews load simultaneously
  const STAGGER_GAP_MS = 200; // Delay between batches

  let _container = null;
  let _mainVideo = null;
  let _thumbnails = [];
  let _timeUpdateHandler = null;
  let _loadingStates = new Map();
  let _staggerAbortController = null;

  function formatMMSS(totalSeconds) {
    if (!isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
    const mins = Math.floor(totalSeconds / 60);
    const secs = Math.floor(totalSeconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  function calcFrameCount(duration, maxFrames = 20) {
    if (!duration || !isFinite(duration) || duration < 1) return 3;

    // Logarithmic scaling with configurable ceiling
    const count = Math.min(
      maxFrames,
      Math.max(3, Math.round(Math.log2(duration / 30 + 1) * 6)),
    );

    console.log(
      `[OverlayPreviews] 📐 calcFrameCount: ${formatMMSS(duration)} → ${count} frames (max: ${maxFrames})`,
    );
    return count;
  }

  function createContainer() {
    if (_container && document.body.contains(_container)) return _container;
    _container = document.createElement("div");
    _container.id = "vo-previews-wrap";
    const mediaWrap = document.getElementById("vo-media-wrap");
    if (mediaWrap) {
      mediaWrap.appendChild(_container);
    } else {
      console.warn(
        "[OverlayPreviews] ⚠️ #vo-media-wrap not found, fallback to #vo-player",
      );
      const player = document.getElementById("vo-player");
      if (player) {
        const controls = document.getElementById("vo-controls");
        if (controls) player.insertBefore(_container, controls);
        else player.appendChild(_container);
      }
    }
    return _container;
  }

  function createSpinner() {
    const spinner = document.createElement("div");
    spinner.className = "vo-preview-spinner";
    spinner.innerHTML = `<div class="vo-spinner-arc"></div>`;
    return spinner;
  }

  /**
   * Activate a single video for loading using PriorityManager for bandwidth control.
   * Sets src, updates state, and notifies PriorityManager to give this video priority.
   */
  function activateVideo(video) {
    if (!video.dataset.pendingSrc) return;

    const state = _loadingStates.get(video);
    if (!state || state.state === "ready" || state.state === "error") return;

    // Set the src to start loading
    video.src = video.dataset.pendingSrc;
    delete video.dataset.pendingSrc;

    state.state = "loading";
    state.startTime = performance.now();

    // Use PriorityManager to give this video bandwidth priority
    if (window.BoostEngine?.PriorityManager?.addOverlayPreviewPriority) {
      window.BoostEngine.PriorityManager.addOverlayPreviewPriority(video);
    }
  }

  /**
   * Deactivate a video after it's loaded to free bandwidth for the next batch.
   * Notifies PriorityManager to remove priority and stops the connection.
   */
  function deactivateVideo(video) {
    // Don't notify PriorityManager — we do batch completion once at the end
    video.preload = "none";
  }

  function createThumbnail(videoSrc, time, index, total) {
    const wrapper = document.createElement("div");
    wrapper.className = "vo-preview-thumb-wrapper";
    wrapper.dataset.time = time;

    const video = document.createElement("video");
    // Don't set src yet — will be set when batch activates via activateVideo()
    video.muted = true;
    video.preload = "none";
    video.className = "vo-preview-thumb-video";
    video.playsInline = true;
    video.controls = false;
    video.style.opacity = "0";
    video.style.transition = "opacity 0.2s ease";

    // Store for later activation
    video.dataset.pendingSrc = videoSrc;
    video.dataset.seekTime = time;

    const spinner = createSpinner();
    wrapper.appendChild(spinner);

    const loadId = `${index + 1}/${total} @ ${formatMMSS(time)}`;
    const shortSrc = videoSrc
      .substring(videoSrc.lastIndexOf("/") + 1)
      .substring(0, 60);

    _loadingStates.set(video, {
      startTime: 0, // Will be set when actually loading via activateVideo()
      url: shortSrc,
      index,
      time,
      loadId,
      state: "pending",
    });

    // ─── Event: metadata loaded ───
    video.addEventListener(
      "loadedmetadata",
      () => {
        const state = _loadingStates.get(video);
        if (state && (state.state === "loading" || state.state === "pending")) {
          const elapsed = (performance.now() - state.startTime).toFixed(0);
          state.state = "metadata";
          console.log(`  📋 [${loadId}] metadata ready (+${elapsed}ms)`);
        }
      },
      { once: true },
    );

    // ─── Event: ready ───
    video.addEventListener(
      "canplay",
      () => {
        const state = _loadingStates.get(video);
        if (state && state.state !== "ready") {
          const elapsed = (performance.now() - state.startTime).toFixed(0);
          state.state = "ready";
          console.log(`  ✅ [${loadId}] fully loaded (+${elapsed}ms)`);
          // Hide spinner with fade
          spinner.style.opacity = "0";
          setTimeout(() => {
            if (spinner.parentElement) spinner.remove();
          }, 200);
          video.style.opacity = "1";
        }
      },
      { once: true },
    );

    // ─── Event: error ───
    video.addEventListener(
      "error",
      () => {
        const state = _loadingStates.get(video);
        if (state) {
          const elapsed = (performance.now() - state.startTime).toFixed(0);
          state.state = "error";
          console.error(`  ❌ [${loadId}] failed (+${elapsed}ms)`);
          // Replace spinner with error icon
          spinner.innerHTML = `
          <div class="vo-spinner-error">
            <svg width="20" height="20" viewBox="0 0 20 20">
              <line x1="6" y1="6" x2="14" y2="14" stroke="#ff6464" stroke-width="2" stroke-linecap="round"/>
              <line x1="14" y1="6" x2="6" y2="14" stroke="#ff6464" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </div>
        `;
        }
      },
      { once: true },
    );

    // ─── Seek + capture frame after metadata ───
    const seekToFrame = () => {
      try {
        video.currentTime = parseFloat(video.dataset.seekTime);
      } catch (e) {
        console.warn(`  ⚠️ [${loadId}] seek failed:`, e.message);
      }
    };

    video.addEventListener("loadedmetadata", seekToFrame, { once: true });

    video.addEventListener(
      "seeked",
      () => {
        const state = _loadingStates.get(video);
        const totalElapsed = state
          ? (performance.now() - state.startTime).toFixed(0)
          : "?";
        console.log(`  🎯 [${loadId}] frame captured (+${totalElapsed}ms)`);
        video
          .play()
          .then(() => {
            setTimeout(() => {
              if (!video.paused) video.pause();
            }, 150);
          })
          .catch(() => {});
      },
      { once: true },
    );

    wrapper.appendChild(video);

    // Time label
    const timeLabel = document.createElement("span");
    timeLabel.className = "vo-preview-time-label";
    timeLabel.textContent = formatMMSS(time);
    wrapper.appendChild(timeLabel);

    // Click handler to seek main video
    wrapper.addEventListener("click", () => {
      if (_mainVideo) {
        const wasPlaying = !_mainVideo.paused;
        _mainVideo.currentTime = time;
        if (wasPlaying) _mainVideo.play().catch(() => {});
        _container
          .querySelectorAll(".vo-preview-thumb-wrapper.active")
          .forEach((el) => el.classList.remove("active"));
        wrapper.classList.add("active");
      }
    });

    return wrapper;
  }

  /**
   * Staggered loading: activates videos in small batches with delays.
   * Each batch gets bandwidth priority via PriorityManager, then releases it.
   */
  async function loadBatchStaggered(videos, concurrency = 3, gapMs = 400) {
    // Abort any previous staggered load
    if (_staggerAbortController) {
      _staggerAbortController.abort();
    }
    _staggerAbortController = new AbortController();
    const signal = _staggerAbortController.signal;

    const total = videos.length;
    let completed = 0;

    console.log(
      `[OverlayPreviews] ⏳ Staggered load: ${total} previews, ` +
        `${concurrency} concurrent, ${gapMs}ms gap`,
    );

    const batchStart = performance.now();

    // Process in batches
    for (let i = 0; i < total; i += concurrency) {
      if (signal.aborted) {
        console.log("[OverlayPreviews] ⚠️ Staggered load aborted");
        return;
      }

      const batch = videos.slice(i, i + concurrency);
      const batchNum = Math.floor(i / concurrency) + 1;
      const totalBatches = Math.ceil(total / concurrency);

      const batchIds = batch
        .map((v) => _loadingStates.get(v)?.loadId)
        .filter(Boolean)
        .join(", ");

      console.log(`  📦 Batch ${batchNum}/${totalBatches}: [${batchIds}]`);

      // Activate only this batch — sets src and notifies PriorityManager
      batch.forEach((video) => activateVideo(video));

      // Wait for batch to finish loading (or timeout)
      await Promise.race([
        Promise.all(
          batch.map((video) => {
            return new Promise((resolve) => {
              const onDone = () => {
                video.removeEventListener("loadedmetadata", onDone);
                video.removeEventListener("error", onDone);
                video.removeEventListener("canplay", onDone);
                completed++;
                const pct = Math.round((completed / total) * 100);
                console.log(
                  `  📊 ${completed}/${total} (${pct}%) | ${((performance.now() - batchStart) / 1000).toFixed(1)}s`,
                );
                resolve();
              };
              video.addEventListener("loadedmetadata", onDone, { once: true });
              video.addEventListener("error", onDone, { once: true });
              video.addEventListener("canplay", onDone, { once: true });
            });
          }),
        ),
        // Timeout per batch to prevent hanging
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);

      // After batch loads, release bandwidth for next batch
      batch.forEach((video) => deactivateVideo(video));

      // Gap between batches
      if (i + concurrency < total && !signal.aborted) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, gapMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }

    const totalElapsed = ((performance.now() - batchStart) / 1000).toFixed(1);
    console.log(
      `[OverlayPreviews] ✅ Staggered load done: ${completed}/${total} in ${totalElapsed}s`,
    );

    // 🔑 Notify PriorityManager that ALL batches are complete
    if (window.BoostEngine?.PriorityManager?.notifyOverlayPreviewsComplete) {
      window.BoostEngine.PriorityManager.notifyOverlayPreviewsComplete();
    }
  }

  function generatePreviews(videoEl, entry) {
    clearPreviews();
    _mainVideo = videoEl;
    const src = videoEl.currentSrc || videoEl.src;
    if (!src) {
      console.warn("[OverlayPreviews] ⚠️ No video source, skipping");
      return;
    }
    const duration = videoEl.duration;
    if (!duration || isNaN(duration) || duration < 1) {
      console.warn(
        `[OverlayPreviews] ⚠️ Invalid duration (${duration}), skipping`,
      );
      return;
    }
    const container = createContainer();
    if (!container) {
      console.warn("[OverlayPreviews] ⚠️ No container, skipping");
      return;
    }

    const MAX = calcFrameCount(duration);
    const times = Array.from(
      { length: MAX },
      (_, i) => ((i + 1) / (MAX + 1)) * duration,
    );

    console.log(
      `[OverlayPreviews] 🎬 Generating ${MAX} previews for ${formatMMSS(duration)}` +
        `\n  Times: ${times.map((t) => formatMMSS(t)).join(" · ")}` +
        `\n  Source: ${src.substring(src.lastIndexOf("/") + 1).substring(0, 80)}`,
    );

    // Create all DOM elements first (fast)
    const creationStart = performance.now();
    const previewVideos = [];

    times.forEach((t, i) => {
      const wrapper = createThumbnail(src, t, i, MAX);
      container.appendChild(wrapper);
      const video = wrapper.querySelector("video");
      previewVideos.push(video);
      _thumbnails.push(wrapper);
    });

    console.log(
      `[OverlayPreviews] 🏗️ ${MAX} DOM elements created (${(performance.now() - creationStart).toFixed(0)}ms)`,
    );

    // Start staggered loading — PriorityManager handles bandwidth per-batch
    loadBatchStaggered(previewVideos, STAGGER_CONCURRENCY, STAGGER_GAP_MS);

    // Time update handler for active preview highlighting
    if (_mainVideo) {
      _timeUpdateHandler = () => updateActivePreview(_mainVideo.currentTime);
      _mainVideo.addEventListener("timeupdate", _timeUpdateHandler);
      updateActivePreview(_mainVideo.currentTime);
    }
  }

  function updateActivePreview(currentTime) {
    if (!_container || _thumbnails.length === 0) return;
    let closestIndex = 0;
    let minDiff = Infinity;
    for (let i = 0; i < _thumbnails.length; i++) {
      const time = parseFloat(_thumbnails[i].dataset.time);
      const diff = Math.abs(time - currentTime);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }
    _thumbnails.forEach((el, i) => {
      el.classList.toggle("active", i === closestIndex);
    });
  }

  function clearPreviews() {
    // Abort any in-progress staggered load
    if (_staggerAbortController) {
      _staggerAbortController.abort();
      _staggerAbortController = null;
    }

    // Clean up any remaining priority-managed videos
    if (window.BoostEngine?.PriorityManager) {
      window.BoostEngine.PriorityManager.clearOverlayPreviewsPriority();
    }

    if (_mainVideo && _timeUpdateHandler) {
      _mainVideo.removeEventListener("timeupdate", _timeUpdateHandler);
      _timeUpdateHandler = null;
    }

    if (_container) {
      _container.querySelectorAll("video").forEach((v) => {
        v.pause();
        v.removeAttribute("src");
        v.load();
      });
      _container.innerHTML = "";
    }

    _thumbnails = [];
    _loadingStates.clear();
    _mainVideo = null;

    console.log("[OverlayPreviews] 🧹 Cleared");
  }

  window.OverlayPreviews = {
    show: generatePreviews,
    hide: clearPreviews,
    destroy: clearPreviews,
    updateActivePreview: updateActivePreview,
  };

  console.log("[OverlayPreviews] ✅ Module loaded (staggered loading enabled)");
})();
