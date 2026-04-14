(() => {
  if (window.__FASTSTREAM_MP4__) return;
  window.__FASTSTREAM_MP4__ = true;

  console.log("🔥 [FastStream] injector loaded");

  // Buffer thresholds - consistent for page load and seeks
  const BUFFER_LOW = 5;
  const BOOST_DURATION = 8000; // 8 seconds - for page load
  const INITIAL_BUFFER_TARGET = 12; // for page load
  // const SEEK_BUFFER_TARGET = 8; // no longer needed here
  const SEEK_BOOST_RATE = 1.5; // stronger nudge after seek (was 1.20)
  const SEEK_BOOST_DURATION = 10000; // 10 seconds for seeks only

  function formatTime(t) {
    return t.toFixed(2) + "s";
  }

  function getBufferAhead(video) {
    if (!video.buffered.length) return 0;
    return video.buffered.end(video.buffered.length - 1) - video.currentTime;
  }

  function logBuffer(video, label = "") {
    const ranges = [];
    for (let i = 0; i < video.buffered.length; i++) {
      ranges.push(
        `[${formatTime(video.buffered.start(i))} → ${formatTime(
          video.buffered.end(i),
        )}]`,
      );
    }
    console.log("📊 [BUFFER]", label, {
      currentTime: formatTime(video.currentTime),
      bufferAhead: formatTime(getBufferAhead(video)),
      ranges,
    });
  }

  function attachVideoListeners(video) {
    if (video.__FASTSTREAM_ATTACHED__) return;
    video.__FASTSTREAM_ATTACHED__ = true;

    console.log("🎬 [FastStream] Video detected:", video);

    let boostTimeout = null;

    video.addEventListener("seeking", () => {
      console.log("⏩ seeking started");
      if (boostTimeout) clearTimeout(boostTimeout);
    });

    // Early check for page-load buffering (runs once)
    setTimeout(() => {
      const ahead = getBufferAhead(video);
      if (ahead < INITIAL_BUFFER_TARGET && !video.__hasBoostedOnLoad) {
        console.log(
          `📈 Page load buffer low (${formatTime(ahead)}), triggering 8s boost...`,
        );
        boostBufferAfterSeek(video, false); // false = gentle boost for load
        video.__hasBoostedOnLoad = true;
      }
    }, 600); // check shortly after video detection

    // Improved seek handling
    video.addEventListener("seeked", () => {
      console.log("✅ seeked finished");
      boostBufferAfterSeek(video, true);
    });

    video.addEventListener("play", () => {
      console.log("▶️ play");
      logBuffer(video, "on play");
    });

    video.addEventListener("pause", () => {
      console.log("⏸ pause");
      logBuffer(video, "on pause");
    });

    video.addEventListener("waiting", () => {
      console.log("⏳ waiting (buffer underrun)");
      logBuffer(video, "waiting");
    });

    video.addEventListener("progress", () => {
      logBuffer(video, "progress");
    });

    video.addEventListener("timeupdate", () => {
      logBuffer(video, "timeupdate");
    });

    // Continuous monitoring every second
    setInterval(() => {
      if (video.paused) return;
      logBuffer(video, "interval");

      const ahead = getBufferAhead(video);
      if (ahead < BUFFER_LOW) {
        console.warn(`⚠️ LOW BUFFER: ${formatTime(ahead)}`);
      }
    }, 1000);
  }

  // Unified buffer booster
  function boostBufferAfterSeek(video, isSeek = false) {
    if (!video) return;

    const rate = isSeek ? SEEK_BOOST_RATE : 1.08;
    const duration = isSeek ? SEEK_BOOST_DURATION : BOOST_DURATION;

    console.log(
      `🚀 Starting ${duration / 1000}s buffer boost (${rate}x)${isSeek ? " [AFTER SEEK]" : " [PAGE LOAD]"}`,
    );

    const originalRate = video.playbackRate || 1.0;
    const targetRate = rate;

    // Optional extra nudge for seeks: brief pause + play can help trigger prefetch on some sites
    if (isSeek && !video.paused) {
      const wasPlaying = true;
      video.pause();
      setTimeout(() => {
        if (wasPlaying) video.play().catch(() => {});
      }, 50);
    }

    video.playbackRate = targetRate;

    if (video.__boostTimeout) clearTimeout(video.__boostTimeout);

    video.__boostTimeout = setTimeout(() => {
      if (video.playbackRate === targetRate) {
        video.playbackRate = originalRate;
      }
      console.log(
        `✅ ${duration / 1000}s buffer boost finished (${rate}x) - back to normal`,
      );
      logBuffer(video, "after boost");
    }, duration);
  }

  function detectVideos() {
    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      attachVideoListeners(video);
    });
  }

  detectVideos();
  const observer = new MutationObserver(detectVideos);
  observer.observe(document, { childList: true, subtree: true });
})();
