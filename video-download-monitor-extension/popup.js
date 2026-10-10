// popup.js

// Update video list from background state
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "UPDATE_DOWNLOADS") {
    updateVideoList(message.data);
  }
  if (message.type === "UPDATE_FETCHES") {
    updateFetchList(message.data);
  }
});

// Load initial cache info
document.addEventListener("DOMContentLoaded", () => {
  loadCacheInfo();

  // Request current state from background
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    // Handle initial state if needed
  });
});

function updateVideoList(videos) {
  const container = document.getElementById("video-list");
  container.innerHTML = "";

  if (Object.keys(videos).length === 0) {
    container.innerHTML =
      '<div style="font-size:12px; color:#999;">No active videos</div>';
    return;
  }

  Object.values(videos).forEach((video) => {
    const div = document.createElement("div");
    div.className = "video-item";
    div.innerHTML = `
      <div>${video.src.substring(0, 30)}...</div>
      <div>${video.percent}% Loaded</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${video.percent}%"></div>
      </div>
    `;
    container.appendChild(div);
  });
}

function updateFetchList(fetches) {
  const container = document.getElementById("fetch-list");
  container.innerHTML = "";

  if (Object.keys(fetches).length === 0) {
    container.innerHTML =
      '<div style="font-size:12px; color:#999;">No active fetches</div>';
    return;
  }

  Object.keys(fetches).forEach((url) => {
    const div = document.createElement("div");
    div.className = "video-item";
    div.innerHTML = `
      <div>${url.substring(0, 30)}...</div>
      <button class="cancel" onclick="cancelFetch('${url}')">Cancel</button>
    `;
    container.appendChild(div);
  });
}

// Feature 2: Cancel fetch (Note: Requires actual AbortController implementation in content script)
window.cancelFetch = function (url) {
  // In a real implementation, you would send a message to the content script
  // to call abort() on the specific AbortController associated with this URL.
  alert(
    `Cancel request for ${url} sent (Implementation required in content.js)`,
  );
};

// Feature 3: Load Cache Info
async function loadCacheInfo() {
  chrome.runtime.sendMessage({ type: "GET_CACHE_INFO" }, (info) => {
    const div = document.getElementById("cache-info");
    if (info.error) {
      div.textContent = info.error;
    } else {
      div.innerHTML = `
        <div>Cache Used: <strong>${info.formattedCache}</strong></div>
        <div>Total Usage: ${formatBytes(info.usage)}</div>
        <div>Quota: ${formatBytes(info.quota)}</div>
      `;
    }
  });
}

// Feature 3/4: Clear Cache
document.getElementById("clear-cache-btn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_CACHE" }, (response) => {
    if (response.success) {
      alert("Cache cleared successfully!");
      loadCacheInfo();
    }
  });
});

// Feature 7: Cache Current Videos for Offline
document
  .getElementById("cache-current-videos")
  .addEventListener("click", () => {
    // This would require injecting a script into the active tab to access the Cache API
    // or using a service worker registered by the site.
    // For an extension, we can't directly cache cross-origin resources easily without CORS.
    alert(
      "To cache videos for offline use, the website must implement a Service Worker with Cache API support. This extension monitors but cannot force-cache cross-origin resources due to browser security policies.",
    );
  });

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}
