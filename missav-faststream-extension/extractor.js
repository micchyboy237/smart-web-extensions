// Jet_Apps/web-extensions/smart-web-extensions/missav-faststream-extension/extractor.js
// extractor.js - Simple segment extractor for MissAV FastStream
// Runs alongside the fast player. Extracts frames, audio, or mp4 per segment.

class FastStreamExtractor {
  constructor(hlsInstance, videoElement) {
    this.hls = hlsInstance;
    this.video = videoElement;
    this.canvas = document.createElement("canvas");
    this.canvasCtx = this.canvas.getContext("2d");
    this.extractedSegments = new Map(); // Cache to avoid duplicate processing
    console.log(
      "[Extractor] ✅ Ready - use extractSegment() or listen to events",
    );
  }

  // Called when fragment is loaded (payload now guaranteed via fLoader)
  async onFragmentLoaded(fragment, rawPayload) {
    const segmentKey = fragment.url || fragment.sn;

    // Skip if already processed (dedupe)
    if (this.extractedSegments.has(segmentKey)) {
      console.log(`[Extractor] ⏭️  Already processed: ${segmentKey}`);
      return;
    }
    this.extractedSegments.set(segmentKey, true);

    console.log(`[Extractor] 🎬 Processing segment: ${segmentKey}`);

    // ✅ rawPayload is now guaranteed to have data (thanks to fLoader copy)
    if (!rawPayload || rawPayload.byteLength === 0) {
      console.warn("[Extractor] ⚠️ Empty payload received");
      return;
    }

    // Example: Auto-grab a frame image (middle of segment)
    if (fragment.startTime !== undefined && fragment.duration) {
      const timeInSegment = fragment.startTime + fragment.duration / 2;
      this.extractFrameAtTime(timeInSegment).catch((err) => {
        console.error("[Extractor] Frame extraction failed:", err);
      });
    }

    // You can also save rawPayload for later processing
    // e.g., this.saveRawSegment(segmentKey, rawPayload);
  }

  // 1. Extract frame image (easy, no extra libs)
  async extractFrameAtTime(timeSeconds) {
    return new Promise((resolve, reject) => {
      const originalTime = this.video.currentTime;
      const onSeeked = () => {
        this.video.removeEventListener("seeked", onSeeked);
        this.video.removeEventListener("error", onError);

        try {
          this.canvas.width = this.video.videoWidth || 842;
          this.canvas.height = this.video.videoHeight || 480;
          this.canvasCtx.drawImage(this.video, 0, 0);
          const dataUrl = this.canvas.toDataURL("image/jpeg", 0.9);
          console.log("[Extractor] ✅ Frame extracted as JPEG");

          // Example: download
          const link = document.createElement("a");
          link.href = dataUrl;
          link.download = `frame-${Date.now()}.jpg`;
          link.click();

          // Restore original time
          this.video.currentTime = originalTime;
          resolve(dataUrl);
        } catch (err) {
          reject(err);
        }
      };

      const onError = (e) => {
        this.video.removeEventListener("seeked", onSeeked);
        this.video.removeEventListener("error", onError);
        reject(e);
      };

      this.video.addEventListener("seeked", onSeeked);
      this.video.addEventListener("error", onError);
      this.video.currentTime = timeSeconds;
    });
  }

  // 2. Extract audio bytes + metadata (uses Web Audio API or ffmpeg.wasm)
  async extractAudio(rawTsBytes) {
    const blob = new Blob([rawTsBytes], { type: "video/mp2t" });
    console.log(
      "[Extractor] Audio extraction started (raw bytes length:",
      rawTsBytes.byteLength,
      ")",
    );

    // For full sample rate / channels / raw PCM: use ffmpeg.wasm
    // Placeholder - load ffmpeg once globally if needed
    return {
      audioBytes: rawTsBytes,
      sampleRate: "use ffmpeg.wasm for exact metadata",
      blob: blob,
    };
  }

  // 3. Extract full .mp4 for the segment (remux TS → MP4)
  async extractMp4Segment(rawTsBytes, filename = "segment.mp4") {
    // Note: Raw TS may not play as MP4 without remuxing
    // For proper remuxing, use ffmpeg.wasm:
    // ffmpeg.run('-i', 'input.ts', '-c', 'copy', 'output.mp4');

    const blob = new Blob([rawTsBytes], { type: "video/mp2t" });
    console.log("[Extractor] Preparing segment download...");

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);

    return { success: true, filename };
  }

  // Public helper: call from console or popup for current segment
  async extractCurrentSegment() {
    console.log("[Extractor] Manual extraction triggered");
    // Implementation depends on tracking current fragment
  }

  // Utility: Clear cache (useful for memory management)
  clearCache() {
    this.extractedSegments.clear();
    console.log("[Extractor] 🧹 Cache cleared");
  }
}

// Expose globally so injector can use it
window.FastStreamExtractor = FastStreamExtractor;
