class FastMP4Player {
  constructor(video, url) {
    this.video = video;
    this.url = url;

    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);

    this.mp4box = MP4Box.createFile();

    this.sourceBuffer = null;

    this.fileSize = null;

    this.inflight = new Map();

    this.byteRateEstimate = 500000; // fallback

    // 🎯 Buffer model
    this.BUFFER_TARGET = 35;
    this.BUFFER_MAX = 60;

    this.controller = null;

    this.DEBUG = true;
  }

  log(...args) {
    if (!this.DEBUG) return;
    console.log("[FastMP4]", ...args);
  }

  formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(2) + "MB";
  }

  async start() {
    if (!window.MP4Box) {
      console.error("❌ MP4Box not available");
      return;
    }

    await new Promise((resolve) =>
      this.mediaSource.addEventListener("sourceopen", resolve, { once: true }),
    );

    this.setupMP4Box();
    this.log("🚀 Player started");
    this.fetchRange(0, 1024 * 1024); // probe

    this.startController();

    this.video.play().catch(() => {});
  }

  setupMP4Box() {
    this.mp4box.onReady = (info) => {
      this.log("📦 MP4Box READY", info);
      const track = info.videoTracks[0];

      const codec = `video/mp4; codecs="${track.codec}"`;

      this.sourceBuffer = this.mediaSource.addSourceBuffer(codec);

      this.mp4box.setSegmentOptions(track.id, null, {
        nbSamples: 1,
      });

      const initSegs = this.mp4box.initializeSegmentation();

      initSegs.forEach((seg) => {
        this.log("🎬 Init segment appended", seg.buffer.byteLength);
        this.sourceBuffer.appendBuffer(seg.buffer);
      });

      this.mp4box.start();
    };

    this.mp4box.onSegment = (id, user, buffer) => {
      this.log("🎞 Segment", {
        track: id,
        size: this.formatMB(buffer.byteLength),
      });
      try {
        this.sourceBuffer.appendBuffer(buffer);
      } catch (e) {
        console.warn("append error", e);
      }
    };

    this.mp4box.onError = (e) => {
      console.error("MP4Box error", e);
    };
  }

  getBufferAhead() {
    if (!this.video.buffered.length) return 0;
    return this.video.buffered.end(0) - this.video.currentTime;
  }

  startController() {
    if (this.controller) return;

    this.controller = setInterval(() => {
      this.tick();
    }, 300);
  }

  tick() {
    const bufferAhead = this.getBufferAhead();

    const pressure = Math.max(
      0,
      Math.min(1, (this.BUFFER_TARGET - bufferAhead) / this.BUFFER_TARGET),
    );

    const dynamicBuffer = this.BUFFER_TARGET + pressure * 20;

    this.log("📊 BUFFER", {
      ahead: bufferAhead.toFixed(2) + "s",
      pressure: pressure.toFixed(2),
      target: dynamicBuffer.toFixed(2),
    });

    if (bufferAhead >= dynamicBuffer) return;

    const currentTime = this.video.currentTime;

    const startByte = Math.floor(currentTime * this.byteRateEstimate);
    const windowSize = dynamicBuffer * this.byteRateEstimate;

    const endByte = startByte + windowSize;

    this.scheduleWindow(startByte, endByte, pressure);
  }

  scheduleWindow(start, end, pressure) {
    const chunkSize = 1024 * 1024 * (1 + pressure * 2);

    this.log("🧠 SCHEDULER", {
      start: this.formatMB(start),
      end: this.formatMB(end),
      chunk: this.formatMB(chunkSize),
    });

    for (let pos = start; pos < end; pos += chunkSize) {
      const chunkEnd = Math.min(pos + chunkSize, end);
      const key = `${pos}-${chunkEnd}`;

      if (this.inflight.has(key)) continue;

      this.fetchRange(pos, chunkEnd);
    }
  }

  async fetchRange(start, end) {
    const key = `${start}-${end}`;
    this.inflight.set(key, true);

    this.log("⬇️ FETCH", {
      range: `${this.formatMB(start)} → ${this.formatMB(end)}`,
    });

    try {
      const res = await fetch(this.url, {
        headers: {
          Range: `bytes=${start}-${end}`,
        },
      });

      const contentRange = res.headers.get("content-range");

      if (contentRange && !this.fileSize) {
        this.fileSize = parseInt(contentRange.split("/")[1]);
        this.log("📏 File size detected:", this.formatMB(this.fileSize));
      }

      const buf = await res.arrayBuffer();

      buf.fileStart = start;

      this.log("📥 APPEND", {
        start: this.formatMB(start),
        size: this.formatMB(buf.byteLength),
      });

      this.mp4box.appendBuffer(buf);

      // update bitrate estimate
      const duration = this.video.currentTime || 1;
      this.byteRateEstimate = Math.max(
        this.byteRateEstimate,
        (start + buf.byteLength) / duration,
      );

      this.log(
        "📈 ByteRate estimate:",
        this.formatMB(this.byteRateEstimate) + "/s",
      );
    } catch (e) {
      console.error("fetchRange error", e);
    }

    this.inflight.delete(key);
  }
}

window.FastMP4Player = FastMP4Player;
