(() => {
  if (window.__FASTSTREAM_MP4__) return;
  window.__FASTSTREAM_MP4__ = true;

  console.log("🔥 [FastStream] injector loaded");

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

    video.addEventListener("play", () => {
      console.log("▶️ play");
      logBuffer(video, "on play");
    });

    video.addEventListener("pause", () => {
      console.log("⏸ pause");
    });

    video.addEventListener("seeking", () => {
      console.log("⏩ seeking");
    });

    video.addEventListener("waiting", () => {
      console.log("⏳ waiting (buffer underrun)");
      logBuffer(video, "waiting");
    });

    video.addEventListener("progress", () => {
      console.log("📥 progress (network)");
      logBuffer(video, "progress");
    });

    video.addEventListener("timeupdate", () => {
      logBuffer(video, "timeupdate");
    });

    // 🔥 continuous monitor (like Netflix debug)
    setInterval(() => {
      if (video.paused) return;
      logBuffer(video, "interval");
    }, 1000);
  }

  function detectVideos() {
    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      attachVideoListeners(video);
    });
  }

  // 🔥 run immediately
  detectVideos();

  // 🔥 observe DOM changes
  const observer = new MutationObserver(() => {
    detectVideos();
  });

  observer.observe(document, {
    childList: true,
    subtree: true,
  });
})();
