// overlay-previews.js
(function () {
  "use strict";
  let _container = null;
  let _mainVideo = null;
  let _thumbnails = [];
  let _timeUpdateHandler = null;

  function formatMMSS(totalSeconds) {
    if (!isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
    const mins = Math.floor(totalSeconds / 60);
    const secs = Math.floor(totalSeconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  function calcFrameCount(duration) {
    if (!duration || !isFinite(duration) || duration < 1) return 3;
    const count = Math.min(
      10,
      Math.max(3, Math.round(Math.log2(duration / 15 + 1) * 3)),
    );
    console.log(
      `[OverlayPreviews] calcFrameCount: ${formatMMSS(duration)} → ${count} frames`,
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
      console.log(
        "[OverlayPreviews] ✅ Container injected into #vo-media-wrap",
      );
    } else {
      console.warn(
        "[OverlayPreviews] ⚠️ #vo-media-wrap not found! Fallback to #vo-player",
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

  function createThumbnail(videoSrc, time) {
    const wrapper = document.createElement("div");
    wrapper.className = "vo-preview-thumb-wrapper";
    wrapper.dataset.time = time;
    const video = document.createElement("video");
    video.src = videoSrc;
    video.muted = true;
    video.preload = "metadata";
    video.className = "vo-preview-thumb-video";
    video.playsInline = true;
    video.controls = false;

    const seekToFrame = () => {
      try {
        video.currentTime = time;
      } catch (e) {}
    };

    if (video.readyState >= 1) seekToFrame();
    else video.addEventListener("loadedmetadata", seekToFrame, { once: true });

    video.addEventListener(
      "seeked",
      () => {
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
    const timeLabel = document.createElement("span");
    timeLabel.className = "vo-preview-time-label";
    timeLabel.textContent = formatMMSS(time);
    wrapper.appendChild(timeLabel);

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

  function generatePreviews(videoEl, entry) {
    clearPreviews();
    _mainVideo = videoEl;
    const src = videoEl.currentSrc || videoEl.src;
    if (!src) return;
    const duration = videoEl.duration;
    if (!duration || isNaN(duration) || duration < 1) return;

    const container = createContainer();
    if (!container) return;

    const MAX = calcFrameCount(duration);
    const times = Array.from(
      { length: MAX },
      (_, i) => ((i + 1) / (MAX + 1)) * duration,
    );
    console.log(
      `[OverlayPreviews] 🎬 Generating ${MAX} previews | Times: ${times.map((t) => formatMMSS(t)).join(", ")}`,
    );

    const previewVideos = [];
    (async () => {
      for (const t of times) {
        const wrapper = createThumbnail(src, t);
        container.appendChild(wrapper);
        previewVideos.push(wrapper.querySelector("video"));
        _thumbnails.push(wrapper);
      }
      if (window.BoostEngine?.PriorityManager) {
        window.BoostEngine.PriorityManager.setOverlayPreviewsPriority(
          previewVideos,
        );
      }
      if (_mainVideo) {
        _timeUpdateHandler = () => updateActivePreview(_mainVideo.currentTime);
        _mainVideo.addEventListener("timeupdate", _timeUpdateHandler);
        updateActivePreview(_mainVideo.currentTime);
      }
    })();
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
    if (_mainVideo && _timeUpdateHandler) {
      _mainVideo.removeEventListener("timeupdate", _timeUpdateHandler);
      _timeUpdateHandler = null;
    }
    if (window.BoostEngine?.PriorityManager) {
      window.BoostEngine.PriorityManager.clearOverlayPreviewsPriority();
    } else if (_container) {
      _container.querySelectorAll("video").forEach((v) => {
        v.pause();
        v.removeAttribute("src");
        v.load();
      });
    }
    if (_container) _container.innerHTML = "";
    _thumbnails = [];
    _mainVideo = null;
    console.log("[OverlayPreviews] 🧹 Cleared previews and restored bandwidth");
  }

  window.OverlayPreviews = {
    show: generatePreviews,
    hide: clearPreviews,
    destroy: clearPreviews,
    updateActivePreview: updateActivePreview,
  };
  console.log(
    "[OverlayPreviews] ✅ Module loaded, API exposed at window.OverlayPreviews",
  );
})();
