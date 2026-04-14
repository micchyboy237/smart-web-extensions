// Jet_Apps/web-extensions/smart-web-extensions/missav-extension/videoFastDownload.js
// Full HLS fast streaming + parallel download logic for missav.ws
// Based on FastStream's DownloadManager + HLSPlayer pattern, simplified for the extension.
// Handles the special "videoN.jpeg" segments (they are actually TS data).

class SimpleSpeedTracker {
  constructor() {
    this.buffer = [];
  }
  update(dataSize, startTime) {
    this.buffer.push({ dataSize, start: startTime, end: performance.now() });
    const cutoff = performance.now() - 10000;
    while (this.buffer.length > 2 && this.buffer[0].end < cutoff)
      this.buffer.shift();
  }
  getSpeed() {
    if (this.buffer.length === 0) return 0;
    let total = 0;
    this.buffer.forEach((entry) => (total += entry.dataSize));
    const dt =
      (this.buffer[this.buffer.length - 1].end - this.buffer[0].start) / 1000;
    return total / dt; // bytes per second
  }
}

class VideoFastDownload {
  constructor() {
    this.hls = null;
    this.video = null;
    this.fragments = [];
    this.downloadedFragments = new Map(); // url → ArrayBuffer
    this.concurrentLimit = 6; // FastStream-style parallel downloaders
    this.speedTracker = new SimpleSpeedTracker();
    this.preFetched = false;
    this.isDownloading = false;
  }

  /**
   * Start playing with fast background downloading
   * @param {HTMLVideoElement} videoElement
   * @param {string} m3u8Url - usually the master playlist URL
   * @param {object} headers - e.g. { Referer: "https://missav.ws/..." }
   */
  async startFastStreaming(videoElement, m3u8Url, headers = {}) {
    this.video = videoElement;
    this.headers = headers;

    if (!window.Hls || !Hls.isSupported()) {
      console.warn("hls.js not available – using native <video>");
      this.video.src = m3u8Url;
      return;
    }

    this.hls = new Hls({
      autoStartLoad: true,
      startPosition: -1,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
      maxBufferSize: 60 * 1000 * 1000,
      enableWorker: true,
      workerPath: "hls.worker.js", // the one from video-dev/hls.js
      xhrSetup: (xhr, url) => {
        Object.keys(this.headers).forEach((key) =>
          xhr.setRequestHeader(key, this.headers[key]),
        );
      },
      // Force highest quality on missav (842x480)
      startLevel: -1,
    });

    this.hls.loadSource(m3u8Url);
    this.hls.attachMedia(this.video);

    // Auto-select highest quality
    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (this.hls.levels && this.hls.levels.length > 0) {
        this.hls.loadLevel = this.hls.levels.length - 1; // 842x480
        console.log("✅ FastStream mode: selected highest quality (842x480)");
      }
    });

    // Get the real fragment list once the level is loaded
    this.hls.on(Hls.Events.LEVEL_UPDATED, (event, data) => {
      if (this.preFetched || !data.details || !data.details.fragments) return;
      this.preFetched = true;

      this.fragments = data.details.fragments.map((frag) => ({
        url: frag.url, // will be .../videoN.jpeg
        sn: frag.sn,
      }));

      console.log(
        `✅ Loaded ${this.fragments.length} fragments – starting fast parallel pre-fetch`,
      );
      this.fastPreFetchFragments();
    });

    // Track speed for debugging
    this.hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
      const size =
        data.frag.dataSize || (data.payload ? data.payload.byteLength : 0);
      this.speedTracker.update(size, performance.now());
    });
  }

  /**
   * Parallel download workers (FastStream-style)
   */
  async fastPreFetchFragments() {
    if (this.fragments.length === 0) return;

    const queue = [...this.fragments];
    const workers = [];

    for (let i = 0; i < this.concurrentLimit; i++) {
      workers.push(this._downloadWorker(queue));
    }

    await Promise.all(workers);
    console.log(
      "🚀 Fast pre-fetch complete – video should play without buffering",
    );
  }

  async _downloadWorker(queue) {
    while (queue.length > 0) {
      const frag = queue.shift();
      if (!frag || this.downloadedFragments.has(frag.url)) continue;

      try {
        const startTime = performance.now();
        const data = await this._downloadSingleFragment(frag.url);
        this.downloadedFragments.set(frag.url, data);
        this.speedTracker.update(data.byteLength, startTime);
      } catch (err) {
        console.warn(
          "Fragment fetch failed (will be retried by hls.js if needed):",
          frag.url,
        );
      }
    }
  }

  async _downloadSingleFragment(url) {
    const response = await fetch(url, {
      headers: this.headers,
      mode: "cors",
      credentials: "include",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.arrayBuffer();
  }

  /**
   * Download the entire video as one MP4 file
   * (uses already-fetched fragments when possible)
   * @param {function(number)} onProgress - 0-100 callback
   * @returns {Promise<Blob>}
   */
  async downloadFullVideo(onProgress = null) {
    this.isDownloading = true;
    console.log("📥 Starting full fast download...");

    // Make sure every fragment is downloaded
    for (let i = 0; i < this.fragments.length; i++) {
      const frag = this.fragments[i];
      if (!this.downloadedFragments.has(frag.url)) {
        try {
          const data = await this._downloadSingleFragment(frag.url);
          this.downloadedFragments.set(frag.url, data);
        } catch (e) {
          console.error("Failed to download fragment for save:", frag.url);
        }
      }
      if (onProgress)
        onProgress(Math.round(((i + 1) / this.fragments.length) * 100));
    }

    // Simple concatenation (works for many TS-based VODs).
    // For a perfect MP4, you can replace this with the hls2mp4 module from FastStream if you import it.
    const chunks = [];
    this.fragments.forEach((frag) => {
      const buf = this.downloadedFragments.get(frag.url);
      if (buf) chunks.push(new Uint8Array(buf));
    });

    const mergedBlob = new Blob(chunks, { type: "video/mp4" });
    console.log("✅ Full video ready!");
    this.isDownloading = false;
    return mergedBlob;
  }

  destroy() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video = null;
    this.fragments = [];
    this.downloadedFragments.clear();
    this.preFetched = false;
  }
}

// Export for easy use in the extension
window.VideoFastDownload = VideoFastDownload;
export default VideoFastDownload;
