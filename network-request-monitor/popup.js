// popup.js
let logEntries = [];

function addLogEntry(entry) {
  logEntries.unshift(entry);
  if (logEntries.length > 50) logEntries.pop();
  updateDisplay();
}

function updateDisplay() {
  const container = document.getElementById("logs");
  container.innerHTML = logEntries
    .map((entry) => {
      const statusClass = entry.statusCode
        ? `status-${Math.floor(entry.statusCode / 100)}xx`
        : "";

      return `
      <div class="log-entry ${entry.type.toLowerCase()}">
        <div class="timestamp">${entry.timestamp}</div>
        <div><strong>${entry.type}</strong></div>
        <div class="url">${entry.url || entry.method + " " + entry.url}</div>
        ${entry.statusCode ? `<div class="status ${statusClass}">Status: ${entry.statusCode}</div>` : ""}
        ${entry.method ? `<div>Method: ${entry.method}</div>` : ""}
        ${entry.bodyLength ? `<div>Body Size: ${entry.bodyLength} chars</div>` : ""}
      </div>
    `;
    })
    .join("");
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "LOG_UPDATE") {
    addLogEntry(message.data);
  }
});

// Load existing logs from storage
chrome.storage.local.get(["requests"], (result) => {
  if (result.requests) {
    result.requests.forEach((entry) => addLogEntry(entry));
  }
});

// Clear button
document.getElementById("clearBtn").addEventListener("click", () => {
  logEntries = [];
  updateDisplay();
  chrome.storage.local.set({ requests: [] });
  console.log("[Popup] Logs cleared");
});

console.log("[Popup] Popup initialized");
