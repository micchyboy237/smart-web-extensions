// popup.js - UI for controlling the extractor
console.log("[Popup] Script loaded.");

document.getElementById("getStats").addEventListener("click", async () => {
  console.log("[Popup] Requesting stats...");
  const response = await chrome.runtime.sendMessage({ action: "getStats" });
  console.log("[Popup] Stats:", response);

  const statsDiv = document.getElementById("stats");

  if (Object.keys(response).length === 0) {
    statsDiv.innerHTML =
      "<em>No videos detected yet. Play a video on any site.</em>";
    return;
  }

  statsDiv.innerHTML = "<h3>Captured Videos:</h3>";
  for (const [url, stats] of Object.entries(response)) {
    statsDiv.innerHTML += `
      <div class="video-entry">
        <div><strong>URL:</strong> ${url.substring(0, 80)}...</div>
        <div><strong>Chunks:</strong> ${stats.chunksCount}</div>
        <div><strong>Size:</strong> ${(stats.totalBytesCaptured / 1024 / 1024).toFixed(2)} MB</div>
        <div><strong>Complete:</strong> ${stats.completeness}</div>
        <button class="save-btn" data-url="${url}">💾 Save Video</button>
        <hr>
      </div>
    `;
  }

  document.querySelectorAll(".save-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const url = btn.getAttribute("data-url");
      console.log(`[Popup] Saving: ${url}`);
      await chrome.runtime.sendMessage({
        action: "saveVideo",
        url: url,
        filename: `video_${Date.now()}.mp4`,
      });
      btn.textContent = "✓ Saved!";
      setTimeout(() => {
        btn.textContent = "💾 Save Video";
      }, 2000);
    });
  });
});

document.getElementById("clear").addEventListener("click", async () => {
  console.log("[Popup] Clearing...");
  await chrome.runtime.sendMessage({ action: "clear" });
  document.getElementById("stats").innerHTML =
    "<em>Cleared. Refresh page to recapture.</em>";
});

document
  .getElementById("attachDebugger")
  .addEventListener("click", async () => {
    console.log("[Popup] Attaching debugger...");
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const response = await chrome.runtime.sendMessage({
      action: "attachDebugger",
      tabId: tab.id,
    });
    console.log("[Popup] Debugger attached:", response);
    alert(
      response
        ? "Debugger attached successfully!"
        : "Failed to attach debugger",
    );
  });
