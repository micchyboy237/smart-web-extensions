# Progressive MP4 Streaming with HTTP Range Requests

A comprehensive guide to implementing efficient video streaming using HTTP range requests, with practical JavaScript examples and best practices.

## Table of Contents

- [Overview](#overview)
- [What are HTTP Range Requests?](#what-are-http-range-requests)
- [Why Progressive Streaming?](#why-progressive-streaming)
- [Server Requirements](#server-requirements)
- [Core Concepts](#core-concepts)
- [Implementation Guide](#implementation-guide)
  - [Basic Range Requests](#basic-range-requests)
  - [Video Player with Buffering](#video-player-with-buffering)
  - [Resume Interrupted Downloads](#resume-interrupted-downloads)
  - [Parallel Chunk Downloading](#parallel-chunk-downloading)
- [Use Cases & Range Formats](#use-cases--range-formats)
- [Advanced Techniques](#advanced-techniques)
- [Error Handling](#error-handling)
- [Performance Optimization](#performance-optimization)
- [Browser Support](#browser-support)
- [Testing & Debugging](#testing--debugging)
- [Common Pitfalls](#common-pitfalls)
- [Full Example](#full-example)

## Overview

HTTP range requests allow clients to request specific byte ranges of a resource, enabling efficient video streaming, seek operations, and resumable downloads. This approach is fundamental to modern video streaming and can significantly improve user experience.

### Key Benefits

- **Fast startup** - Download just enough to start playing
- **Seek support** - Jump to any position without downloading entire file
- **Bandwidth efficient** - Only download what's needed
- **Resume capability** - Continue interrupted downloads
- **Adaptive streaming** - Adjust quality based on connection

## What are HTTP Range Requests?

A range request asks the server for only a portion of a file:

```http
GET /video.mp4 HTTP/1.1
Host: example.com
Range: bytes=0-524287
```

Server responds with:

```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-524287/3959061
Content-Length: 524288
```

## Why Progressive Streaming?

Traditional approaches have significant drawbacks:

| Approach           | Pros                    | Cons                            |
| ------------------ | ----------------------- | ------------------------------- |
| Full download      | Simple                  | Long wait time, bandwidth waste |
| Chunked encoding   | Streaming possible      | No seek support, complex        |
| **Range requests** | Seek, resume, efficient | Server must support             |

## Server Requirements

Your server must support:

### 1. HTTP/1.1 or higher

```bash
# Check support
curl -I https://your-server.com/video.mp4 | grep "Accept-Ranges"
```

### 2. Accept-Ranges Header

```http
Accept-Ranges: bytes
```

### 3. 206 Partial Content Response

```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1000/5000
```

### Recommended Server Configuration

**Nginx:**

```nginx
location /videos/ {
    add_header Accept-Ranges bytes;
    add_header Cache-Control "public, max-age=31536000";
}
```

**Apache (.htaccess):**

```apache
<FilesMatch "\.mp4$">
    Header set Accept-Ranges bytes
    Header set Cache-Control "public, max-age=31536000"
</FilesMatch>
```

**Cloudflare (CDN):** Automatically supports range requests

## Core Concepts

### Byte Ranges Format

| Format                       | Description       | Example               |
| ---------------------------- | ----------------- | --------------------- |
| `bytes=start-end`            | Specific range    | `bytes=0-1023`        |
| `bytes=start-`               | From start to end | `bytes=1024-`         |
| `bytes=-suffix`              | Last N bytes      | `bytes=-2048`         |
| `bytes=start-end, start-end` | Multiple ranges   | `bytes=0-99, 200-299` |

### Important Response Headers

| Header           | Purpose                  | Example                  |
| ---------------- | ------------------------ | ------------------------ |
| `Content-Range`  | Indicates returned range | `bytes 0-524287/3959061` |
| `Content-Length` | Size of returned portion | `524288`                 |
| `Accept-Ranges`  | Server capability        | `bytes`                  |
| `ETag`           | Entity tag for caching   | `"abc123"`               |

## Implementation Guide

### Basic Range Requests

```javascript
// Simple range request
async function fetchRange(url, start, end = null) {
  const rangeHeader = end ? `bytes=${start}-${end}` : `bytes=${start}-`;

  const response = await fetch(url, {
    headers: { Range: rangeHeader },
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Range request failed: ${response.status}`);
  }

  // Parse Content-Range header
  const contentRange = response.headers.get("Content-Range");
  const match = contentRange?.match(/bytes \d+-\d+\/(\d+)/);
  const totalSize = match ? parseInt(match[1]) : null;

  return {
    data: await response.arrayBuffer(),
    totalSize: totalSize,
    range: {
      start: start,
      end: end || totalSize - 1,
    },
  };
}

// Usage
const { data, totalSize } = await fetchRange("video.mp4", 0, 1048575);
console.log(`Downloaded ${data.byteLength} bytes of ${totalSize}`);
```

### Video Player with Buffering

```javascript
class ProgressiveVideoPlayer {
  constructor(videoElement, videoUrl, options = {}) {
    this.video = videoElement;
    this.url = videoUrl;
    this.chunkSize = options.chunkSize || 512 * 1024; // 512KB chunks
    this.bufferAhead = options.bufferAhead || 2; // 2 chunks ahead
    this.downloadedBytes = 0;
    this.totalSize = null;
    this.bufferedChunks = new Map();
    this.isPlaying = false;

    this.init();
  }

  async init() {
    // Get total file size with a small request
    const headResponse = await fetch(this.url, {
      method: "HEAD",
    });
    this.totalSize = parseInt(headResponse.headers.get("Content-Length"));

    // Setup video event listeners
    this.video.addEventListener("timeupdate", () => this.handleTimeUpdate());
    this.video.addEventListener("seeked", () => this.handleSeek());

    // Start initial buffer
    await this.downloadInitialBuffer();
  }

  async downloadInitialBuffer() {
    const initialSize = Math.min(1024 * 1024, this.totalSize); // 1MB or less
    const buffer = await this.downloadRange(0, initialSize - 1);

    this.downloadedBytes = buffer.byteLength;
    this.createAndPlayBuffer(buffer);
  }

  async downloadRange(start, end) {
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
    });

    if (response.status === 206) {
      return await response.arrayBuffer();
    }
    throw new Error(`Failed to download range: ${start}-${end}`);
  }

  createAndPlayBuffer(buffer) {
    const blob = new Blob([buffer], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);

    this.video.src = url;
    this.video.play();
    this.isPlaying = true;

    // Start progressive downloading
    this.downloadProgressively();
  }

  async downloadProgressively() {
    while (this.downloadedBytes < this.totalSize && this.isPlaying) {
      const nextEnd = Math.min(
        this.downloadedBytes + this.chunkSize - 1,
        this.totalSize - 1,
      );

      const chunk = await this.downloadRange(this.downloadedBytes, nextEnd);

      this.downloadedBytes += chunk.byteLength;

      // Append to video source if needed
      await this.appendChunk(chunk);
    }
  }

  async appendChunk(chunk) {
    // For MSE (Media Source Extensions) implementation
    if (!this.mediaSource) {
      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);

      await new Promise((resolve) => {
        this.mediaSource.addEventListener("sourceopen", resolve);
      });

      this.sourceBuffer = this.mediaSource.addSourceBuffer("video/mp4");
    }

    return new Promise((resolve) => {
      this.sourceBuffer.appendBuffer(chunk);
      this.sourceBuffer.addEventListener("updateend", resolve, { once: true });
    });
  }

  async handleSeek() {
    const currentTime = this.video.currentTime;
    const targetByte = this.timeToByte(currentTime);

    if (targetByte < this.downloadedBytes - this.chunkSize) {
      // Seeking backward - need to redownload
      await this.downloadRange(targetByte, targetByte + this.chunkSize - 1);
      this.downloadedBytes = targetByte + this.chunkSize;
    }
  }

  timeToByte(time) {
    // Estimate byte position based on bitrate
    // This is simplified - real implementation needs bitrate calculation
    const estimatedBitrate = this.totalSize / this.video.duration;
    return Math.floor(time * estimatedBitrate);
  }

  handleTimeUpdate() {
    const currentByte = this.timeToByte(this.video.currentTime);
    const bufferRemaining = this.downloadedBytes - currentByte;

    // Preload if buffer is low
    if (bufferRemaining < this.chunkSize * this.bufferAhead) {
      this.downloadProgressively();
    }
  }
}
```

### Resume Interrupted Downloads

```javascript
class ResumableDownloader {
  constructor(url, options = {}) {
    this.url = url;
    this.chunkSize = options.chunkSize || 1024 * 1024;
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
  }

  async download(resumeFrom = 0) {
    let downloadedBytes = resumeFrom;
    const chunks = [];

    // Get total size
    const headResponse = await fetch(this.url, { method: "HEAD" });
    const totalSize = parseInt(headResponse.headers.get("Content-Length"));

    while (downloadedBytes < totalSize) {
      const end = Math.min(downloadedBytes + this.chunkSize - 1, totalSize - 1);

      try {
        const response = await fetch(this.url, {
          headers: { Range: `bytes=${downloadedBytes}-${end}` },
        });

        if (response.status === 206 || response.status === 200) {
          const chunk = await response.arrayBuffer();
          chunks.push(chunk);

          downloadedBytes += chunk.byteLength;
          this.onProgress(downloadedBytes, totalSize);

          // Save progress
          this.saveProgress(downloadedBytes);
        } else {
          throw new Error(`Unexpected status: ${response.status}`);
        }
      } catch (error) {
        console.error("Download interrupted:", error);
        // Save progress for resumption
        this.saveProgress(downloadedBytes);
        throw error;
      }
    }

    // Combine all chunks
    const fullVideo = this.combineChunks(chunks, totalSize);
    this.onComplete(fullVideo);

    return fullVideo;
  }

  saveProgress(bytes) {
    localStorage.setItem(`download_progress_${this.url}`, bytes.toString());
  }

  getSavedProgress() {
    const saved = localStorage.getItem(`download_progress_${this.url}`);
    return saved ? parseInt(saved) : 0;
  }

  combineChunks(chunks, totalSize) {
    const combined = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of chunks) {
      combined.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    return combined.buffer;
  }

  async resume() {
    const lastPosition = this.getSavedProgress();

    if (lastPosition > 0) {
      console.log(`Resuming download from ${lastPosition} bytes`);
      return await this.download(lastPosition);
    } else {
      return await this.download();
    }
  }
}

// Usage
const downloader = new ResumableDownloader("large-video.mp4", {
  onProgress: (downloaded, total) => {
    const percent = ((downloaded / total) * 100).toFixed(2);
    console.log(`Downloaded: ${percent}%`);
  },
  onComplete: (videoData) => {
    console.log("Download complete!");
    // Save or play the video
    const blob = new Blob([videoData], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    videoElement.src = url;
  },
});

// Resume from where you left off
downloader.resume();
```

### Parallel Chunk Downloading

```javascript
class ParallelDownloader {
  constructor(url, numConnections = 4) {
    this.url = url;
    this.numConnections = numConnections;
    this.chunks = new Array(numConnections);
  }

  async download() {
    // Get total size
    const response = await fetch(this.url, { method: "HEAD" });
    const totalSize = parseInt(response.headers.get("Content-Length"));

    // Calculate chunk sizes
    const chunkSize = Math.ceil(totalSize / this.numConnections);

    // Download chunks in parallel
    const promises = [];
    for (let i = 0; i < this.numConnections; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);

      if (start < totalSize) {
        promises.push(this.downloadChunk(i, start, end));
      }
    }

    await Promise.all(promises);

    // Combine chunks in order
    return this.combineChunks(totalSize);
  }

  async downloadChunk(index, start, end) {
    console.log(`Downloading chunk ${index}: bytes ${start}-${end}`);

    const response = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
    });

    if (response.status === 206) {
      this.chunks[index] = await response.arrayBuffer();
    } else {
      throw new Error(`Failed to download chunk ${index}`);
    }
  }

  combineChunks(totalSize) {
    const combined = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of this.chunks) {
      if (chunk) {
        combined.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }
    }

    return combined.buffer;
  }
}

// Usage
const downloader = new ParallelDownloader("video.mp4", 6);
const videoData = await downloader.download();
```

## Use Cases & Range Formats

### Complete Reference Table

| Use Case            | Priority  | Range Format            | Example             | Typical Size |
| ------------------- | --------- | ----------------------- | ------------------- | ------------ |
| **Initial buffer**  | High      | `bytes=0-524288`        | First 512KB         | 256KB-1MB    |
| **Quick preview**   | High      | `bytes=0-262144`        | First 256KB         | 128-256KB    |
| **Video seek**      | Immediate | `bytes=5242880-`        | Jump to 5MB         | Variable     |
| **Resume download** | High      | `bytes=163840-`         | Continue from saved | Remaining    |
| **Parallel chunk**  | Medium    | `bytes=0-1048575`       | First of 4 chunks   | 1MB each     |
| **Metadata fetch**  | Low       | `bytes=-16384`          | Last 16KB           | 8-32KB       |
| **Thumbnail scrub** | Low       | `bytes=1048576-1179648` | 128KB segment       | 64-256KB     |
| **Quality switch**  | Medium    | `bytes=5242880-6291456` | 1MB segment         | 512KB-1MB    |
| **End of file**     | Low       | `bytes=-65536`          | Last 64KB           | 32-128KB     |
| **Test connection** | Low       | `bytes=0-65536`         | First 64KB          | 64KB         |

### Practical Examples

```javascript
// 1. Initial buffer for fast playback
const initBuffer = await fetchRange(url, 0, 1024 * 1024); // First 1MB

// 2. Seek to 2 minutes (assuming 5MB total, 30fps estimate)
const seekPosition = 2 * 60 * (totalSize / duration);
const seekBuffer = await fetchRange(
  url,
  seekPosition,
  seekPosition + 1024 * 1024,
);

// 3. Get video metadata from end
const metadata = await fetchRange(url, totalSize - 16384, totalSize - 1);

// 4. Multi-range (rarely used, but possible)
const response = await fetch(url, {
  headers: {
    Range: "bytes=0-1023, 2048-3071, 4096-5119",
  },
});

// 5. Adaptive quality based on connection
const speed = await testConnectionSpeed(url);
const bufferSize = speed > 1000 ? 2 * 1024 * 1024 : 256 * 1024;
const adaptiveBuffer = await fetchRange(url, 0, bufferSize - 1);
```

## Advanced Techniques

### 1. Adaptive Bitrate Selection

```javascript
class AdaptiveBitratePlayer {
  constructor(videoUrl, qualities) {
    this.url = videoUrl;
    this.qualities = qualities; // [{bitrate, start, end}, ...]
    this.currentQuality = 0;
    this.downloadTimes = [];
  }

  async selectOptimalQuality() {
    // Measure download speed
    const testSize = 256 * 1024;
    const start = performance.now();

    await fetchRange(this.url, 0, testSize - 1);

    const duration = performance.now() - start;
    const speed = testSize / duration; // bytes per ms

    // Select quality that matches speed
    const targetBitrate = speed * 8; // kbps

    const bestQuality = this.qualities.find((q) => q.bitrate <= targetBitrate);
    this.currentQuality = bestQuality || this.qualities[0];

    return this.currentQuality;
  }

  async stream() {
    const quality = await this.selectOptimalQuality();
    console.log(`Streaming at ${quality.bitrate} kbps`);

    // Download quality-specific segments
    for (let segment of quality.segments) {
      const chunk = await fetchRange(this.url, segment.start, segment.end);
      await this.playSegment(chunk);
    }
  }
}
```

### 2. Smart Prefetching

```javascript
class PredictivePrefetcher {
  constructor(url, totalSize) {
    this.url = url;
    this.totalSize = totalSize;
    this.loadedRanges = [];
    this.viewingHistory = [];
  }

  async prefetchAround(position, radius = 1024 * 1024) {
    const start = Math.max(0, position - radius);
    const end = Math.min(position + radius, this.totalSize - 1);

    // Check if already loaded
    if (this.isRangeLoaded(start, end)) {
      return;
    }

    // Prefetch with low priority
    setTimeout(async () => {
      const chunk = await fetchRange(this.url, start, end);
      this.loadedRanges.push({ start, end, chunk });
    }, 1000);
  }

  isRangeLoaded(start, end) {
    return this.loadedRanges.some(
      (range) => range.start <= start && range.end >= end,
    );
  }

  async analyzeUserBehavior() {
    // Learn user seeking patterns
    const commonSeeks = this.calculateCommonSeeks();

    // Prefetch common seek points
    for (const seekPoint of commonSeeks) {
      await this.prefetchAround(seekPoint);
    }
  }
}
```

### 3. Recovery from Partial Responses

```javascript
async function resilientDownload(url, requiredBytes) {
  let downloaded = 0;
  let attempts = 0;
  const maxAttempts = 3;

  while (downloaded < requiredBytes && attempts < maxAttempts) {
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${downloaded}-${requiredBytes - 1}` },
      });

      if (response.status === 206) {
        const chunk = await response.arrayBuffer();
        downloaded += chunk.byteLength;
        attempts = 0; // Reset on success
      } else if (response.status === 416) {
        // Range not satisfiable - we're done
        break;
      }
    } catch (error) {
      attempts++;
      console.log(`Attempt ${attempts} failed, retrying...`);

      if (attempts === maxAttempts) {
        throw new Error(`Failed to download after ${maxAttempts} attempts`);
      }

      // Exponential backoff
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempts)),
      );
    }
  }

  return downloaded;
}
```

## Error Handling

### Common Errors and Solutions

| Error                         | Status | Cause                         | Solution                   |
| ----------------------------- | ------ | ----------------------------- | -------------------------- |
| `ERR_ABORTED`                 | -      | Request cancelled             | Implement resume logic     |
| `416 Range Not Satisfiable`   | 416    | Invalid range                 | Validate range bounds      |
| `200 OK` instead of 206       | 200    | Server doesn't support ranges | Fall back to full download |
| `ERR_CONTENT_LENGTH_MISMATCH` | -      | Connection interrupted        | Retry with range request   |
| Timeout                       | -      | Slow connection               | Reduce chunk size          |

### Robust Error Handler

```javascript
class RobustRangeFetcher {
  constructor(url, options = {}) {
    this.url = url;
    this.timeout = options.timeout || 30000;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
  }

  async fetchWithRetry(start, end, retryCount = 0) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(this.url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 206) {
        return await response.arrayBuffer();
      } else if (response.status === 416) {
        // Range not satisfiable - adjust end
        const contentRange = response.headers.get("Content-Range");
        const match = contentRange?.match(/bytes \d+-\d+\/(\d+)/);
        const totalSize = match ? parseInt(match[1]) : null;

        if (totalSize && start >= totalSize) {
          throw new Error("Range exceeds file size");
        }
        return await this.fetchWithRetry(start, totalSize - 1, retryCount);
      } else if (response.status === 200) {
        // Server doesn't support ranges
        const fullData = await response.arrayBuffer();
        return fullData.slice(start, end + 1);
      } else {
        throw new Error(`Unexpected status: ${response.status}`);
      }
    } catch (error) {
      if (retryCount < this.maxRetries) {
        const delay = this.retryDelay * Math.pow(2, retryCount);
        console.log(
          `Retry ${retryCount + 1}/${this.maxRetries} after ${delay}ms`,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.fetchWithRetry(start, end, retryCount + 1);
      }
      throw error;
    }
  }

  async safeFetch(start, end) {
    try {
      return await this.fetchWithRetry(start, end);
    } catch (error) {
      console.error("All retries failed:", error);
      // Fallback: try to get whole file
      const fallbackResponse = await fetch(this.url);
      const fullData = await fallbackResponse.arrayBuffer();
      return fullData.slice(start, end + 1);
    }
  }
}
```

## Performance Optimization

### Best Practices

1. **Chunk Size Selection**

```javascript
function getOptimalChunkSize(speed, latency) {
  // Aim for 2-5 seconds of video per chunk
  const targetSeconds = 3;
  const bitrate = 500000; // Assume 500 kbps video
  const targetBytes = (bitrate * targetSeconds) / 8;

  // Adjust based on connection
  if (speed < 100) return 256 * 1024; // Slow: 256KB
  if (speed < 500) return 512 * 1024; // Medium: 512KB
  if (speed < 2000) return 1024 * 1024; // Fast: 1MB
  return 2 * 1024 * 1024; // Very fast: 2MB
}
```

2. **Connection Pooling**

```javascript
class ConnectionPool {
  constructor(maxConnections = 6) {
    this.maxConnections = maxConnections;
    this.activeConnections = 0;
    this.queue = [];
  }

  async execute(fetchFn) {
    if (this.activeConnections >= this.maxConnections) {
      await new Promise((resolve) => this.queue.push(resolve));
    }

    this.activeConnections++;
    try {
      return await fetchFn();
    } finally {
      this.activeConnections--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}
```

3. **Caching Strategy**

```javascript
class RangeCache {
  constructor(maxSize = 50 * 1024 * 1024) {
    // 50MB cache
    this.cache = new Map();
    this.maxSize = maxSize;
    this.currentSize = 0;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (entry && Date.now() < entry.expiry) {
      return entry.data;
    }
    return null;
  }

  set(key, data, ttl = 3600000) {
    // 1 hour TTL
    const size = data.byteLength;

    // Evict old entries if needed
    while (this.currentSize + size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      this.currentSize -= oldest.data.byteLength;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      data: data,
      expiry: Date.now() + ttl,
      size: size,
    });
    this.currentSize += size;
  }
}
```

## Browser Support

| Browser     | Range Requests | Partial Content | Status       |
| ----------- | -------------- | --------------- | ------------ |
| Chrome 23+  | ✅ Full        | ✅ 206          | Excellent    |
| Firefox 19+ | ✅ Full        | ✅ 206          | Excellent    |
| Safari 6+   | ✅ Full        | ✅ 206          | Excellent    |
| Edge 12+    | ✅ Full        | ✅ 206          | Excellent    |
| Opera 15+   | ✅ Full        | ✅ 206          | Excellent    |
| IE 9+       | ⚠️ Limited     | ⚠️ Partial      | Use polyfill |

### Feature Detection

```javascript
function supportsRangeRequests() {
  return "fetch" in window && "Response" in window;
}

async function testServerRangeSupport(url) {
  try {
    const response = await fetch(url, {
      headers: { Range: "bytes=0-0" },
    });

    return (
      response.status === 206 ||
      (response.status === 200 && response.headers.has("Accept-Ranges"))
    );
  } catch {
    return false;
  }
}

// Progressive enhancement
if (await testServerRangeSupport(videoUrl)) {
  console.log("Using advanced range streaming");
  await useProgressiveStreaming();
} else {
  console.log("Falling back to full download");
  await useSimpleDownload();
}
```

## Testing & Debugging

### Testing Tools

```bash
# Test range support
curl -I https://example.com/video.mp4 | grep "Accept-Ranges"

# Download specific range
curl -H "Range: bytes=0-1048575" https://example.com/video.mp4 -o first-mb.mp4

# Get content-range header
curl -D - -H "Range: bytes=0-0" https://example.com/video.mp4

# Test multiple ranges
curl -H "Range: bytes=0-99, 200-299" https://example.com/video.mp4
```

### Debug Helper

```javascript
function debugRangeRequest(response) {
  console.group("Range Request Debug");
  console.log("Status:", response.status);
  console.log("Status Text:", response.statusText);
  console.log("Content-Range:", response.headers.get("Content-Range"));
  console.log("Content-Length:", response.headers.get("Content-Length"));
  console.log("Accept-Ranges:", response.headers.get("Accept-Ranges"));
  console.log("ETag:", response.headers.get("ETag"));
  console.groupEnd();

  if (response.status === 206) {
    const contentRange = response.headers.get("Content-Range");
    const match = contentRange.match(/bytes (\d+)-(\d+)\/(\d+)/);
    if (match) {
      console.log(`Range: ${match[1]}-${match[2]} of ${match[3]}`);
      console.log(`Complete: ${parseInt(match[2]) + 1 === parseInt(match[3])}`);
    }
  }
}
```

## Common Pitfalls

### 1. Assuming All Servers Support Ranges

```javascript
// ❌ Wrong
const response = await fetch(url, {
  headers: { Range: "bytes=0-1024" },
});
const data = await response.arrayBuffer(); // Might fail

// ✅ Correct
const response = await fetch(url, {
  headers: { Range: "bytes=0-1024" },
});

if (response.status === 206) {
  // Server supports ranges
  const data = await response.arrayBuffer();
} else if (response.status === 200) {
  // Server doesn't support ranges, download full
  const fullData = await response.arrayBuffer();
  const data = fullData.slice(0, 1025);
}
```

### 2. Off-by-One Errors

```javascript
// ❌ Wrong - requests 0-1023 (1024 bytes)
const response = await fetch(url, {
  headers: { Range: `bytes=${start}-${start + 1023}` },
});

// ✅ Correct - requests exactly 1024 bytes
const response = await fetch(url, {
  headers: { Range: `bytes=${start}-${start + 1024 - 1}` },
});
```

### 3. Not Handling Aborted Requests

```javascript
// ❌ Wrong
const response = await fetch(url);
const data = await response.arrayBuffer(); // Never reaches if aborted

// ✅ Correct
let abortController = new AbortController();

try {
  const response = await fetch(url, {
    signal: abortController.signal,
  });
  const data = await response.arrayBuffer();
} catch (error) {
  if (error.name === "AbortError") {
    console.log("Request aborted, saving progress...");
    saveProgress(currentPosition);
  }
}
```

## Full Example

Here's a complete, production-ready progressive MP4 player:

```javascript
class ProgressiveMP4Player {
  constructor(videoElement, videoUrl, options = {}) {
    this.video = videoElement;
    this.url = videoUrl;
    this.chunkSize = options.chunkSize || 512 * 1024;
    this.bufferAhead = options.bufferAhead || 3;
    this.onProgress = options.onProgress || (() => {});

    this.downloadedBytes = 0;
    this.totalSize = null;
    this.isStreaming = false;
    this.abortController = null;

    this.init();
  }

  async init() {
    await this.getFileInfo();
    this.setupEventListeners();
    await this.startStreaming();
  }

  async getFileInfo() {
    const response = await fetch(this.url, { method: "HEAD" });
    this.totalSize = parseInt(response.headers.get("Content-Length"));

    // Check range support
    const supportsRanges = response.headers.get("Accept-Ranges") === "bytes";
    if (!supportsRanges) {
      console.warn("Server does not support range requests");
      this.chunkSize = this.totalSize; // Download all at once
    }
  }

  setupEventListeners() {
    this.video.addEventListener("seeked", () => this.handleSeek());
    this.video.addEventListener("play", () => this.handlePlay());
    this.video.addEventListener("pause", () => this.handlePause());
    this.video.addEventListener("ended", () => this.handleEnded());
  }

  async startStreaming() {
    this.isStreaming = true;
    this.abortController = new AbortController();

    // Start with initial buffer (first 1MB)
    const initialEnd = Math.min(1024 * 1024 - 1, this.totalSize - 1);
    await this.downloadAndPlay(0, initialEnd);

    // Continue progressive download
    this.downloadProgressively();
  }

  async downloadRange(start, end) {
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: this.abortController.signal,
    });

    if (response.status === 206) {
      return await response.arrayBuffer();
    } else if (response.status === 200) {
      // Fallback to full download
      const fullData = await response.arrayBuffer();
      return fullData.slice(start, end + 1);
    } else {
      throw new Error(`Download failed: ${response.status}`);
    }
  }

  async downloadAndPlay(start, end) {
    const chunk = await this.downloadRange(start, end);
    this.downloadedBytes = end + 1;

    await this.appendToPlayer(chunk);
    this.onProgress(this.downloadedBytes, this.totalSize);

    return chunk;
  }

  async appendToPlayer(chunk) {
    if (!this.mediaSource) {
      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);

      await new Promise((resolve) => {
        this.mediaSource.addEventListener("sourceopen", resolve, {
          once: true,
        });
      });

      this.sourceBuffer = this.mediaSource.addSourceBuffer("video/mp4");
    }

    return new Promise((resolve, reject) => {
      this.sourceBuffer.addEventListener("updateend", resolve, { once: true });
      this.sourceBuffer.addEventListener("error", reject, { once: true });
      this.sourceBuffer.appendBuffer(chunk);
    });
  }

  async downloadProgressively() {
    while (this.isStreaming && this.downloadedBytes < this.totalSize) {
      const bufferRemaining = this.getBufferRemaining();

      if (bufferRemaining < this.chunkSize * this.bufferAhead) {
        const nextEnd = Math.min(
          this.downloadedBytes + this.chunkSize - 1,
          this.totalSize - 1,
        );

        try {
          await this.downloadAndPlay(this.downloadedBytes, nextEnd);
        } catch (error) {
          if (error.name !== "AbortError") {
            console.error("Download error:", error);
            await this.retryDownload();
          }
          break;
        }
      } else {
        // Buffer is healthy, wait
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  getBufferRemaining() {
    if (!this.video.buffered.length) return 0;

    const currentTime = this.video.currentTime;
    for (let i = 0; i < this.video.buffered.length; i++) {
      if (
        currentTime >= this.video.buffered.start(i) &&
        currentTime <= this.video.buffered.end(i)
      ) {
        return this.video.buffered.end(i) - currentTime;
      }
    }
    return 0;
  }

  async handleSeek() {
    const targetTime = this.video.currentTime;
    const targetByte = this.timeToByte(targetTime);

    if (
      targetByte < this.downloadedBytes - this.chunkSize ||
      targetByte > this.downloadedBytes + this.chunkSize
    ) {
      // Seek is far away, need to redownload
      this.isStreaming = false;
      if (this.abortController) {
        this.abortController.abort();
      }

      this.downloadedBytes = targetByte;
      await this.startStreaming();
    }
  }

  timeToByte(time) {
    if (!this.video.duration) return 0;
    return Math.floor((time / this.video.duration) * this.totalSize);
  }

  handlePlay() {
    this.isStreaming = true;
    this.downloadProgressively();
  }

  handlePause() {
    this.isStreaming = false;
  }

  handleEnded() {
    this.isStreaming = false;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  async retryDownload() {
    console.log("Retrying download from", this.downloadedBytes);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.isStreaming = true;
    this.downloadProgressively();
  }

  destroy() {
    this.isStreaming = false;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.mediaSource && this.mediaSource.readyState === "open") {
      this.mediaSource.endOfStream();
    }
  }
}

// Usage
const videoElement = document.getElementById("myVideo");
const player = new ProgressiveMP4Player(
  videoElement,
  "https://example.com/video.mp4",
  {
    chunkSize: 1024 * 1024, // 1MB chunks
    bufferAhead: 5, // Keep 5 seconds buffered
    onProgress: (downloaded, total) => {
      const percent = ((downloaded / total) * 100).toFixed(1);
      console.log(`Buffered: ${percent}%`);
    },
  },
);
```

## License

MIT

## Contributing

Contributions welcome! Please submit issues and pull requests.

## References

- [RFC 7233: HTTP Range Requests](https://tools.ietf.org/html/rfc7233)
- [Media Source Extensions API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API)
- [HTML5 Video Elements](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video)
