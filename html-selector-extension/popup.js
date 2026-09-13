/**
 * Popup Controller v2
 * Coordinates Picker, Preview, Cleaner output, and Background HTTP
 */
const toggleBtn = document.getElementById("togglePicker");
const previewBtn = document.getElementById("previewBtn");
const sendBtn = document.getElementById("sendData");
const clearBtn = document.getElementById("clearData");
const statusEl = document.getElementById("status");
const endpointInput = document.getElementById("endpointUrl");

let isPickerActive = false;

toggleBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  isPickerActive = !isPickerActive;
  await chrome.tabs.sendMessage(tab.id, {
    type: "TOGGLE_PICKER",
    active: isPickerActive,
  });
  updateUI();
});

previewBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "PREVIEW_LAST" });
    if (!res.success) setStatus(`⚠️ ${res.error}`, "warning");
  } catch (err) {
    setStatus("❌ Could not open preview", "error");
  }
});

sendBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const endpoint = endpointInput.value.trim();

  if (!endpoint) {
    setStatus("⚠️ Enter an endpoint URL", "warning");
    return;
  }

  setStatus("📡 Fetching cleaned selections...");
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_SELECTIONS",
    });
    const items = response?.items || [];

    if (items.length === 0) {
      setStatus("⚠️ No elements selected", "warning");
      return;
    }

    // Send CLEANED html, not raw
    const payload = {
      elements: items.map((item) => ({
        cleanedHtml: item.cleaned,
        textContent: item.textContent,
        metadata: item.metadata,
        timestamp: item.timestamp,
      })),
      count: items.length,
      sourceUrl: tab.url,
      sentAt: new Date().toISOString(),
    };

    setStatus(`📤 Sending ${items.length} cleaned items...`);
    const result = await chrome.runtime.sendMessage({
      type: "SEND_TO_ENDPOINT",
      url: endpoint,
      data: payload,
    });

    setStatus(
      result.success
        ? `✅ Sent ${items.length} items (${payload.elements.reduce((sum, e) => sum + e.metadata.cleanedLength, 0)} chars)`
        : `❌ Failed: ${result.error}`,
      result.success ? "info" : "error",
    );
  } catch (err) {
    setStatus(`❌ Error: ${err.message}`, "error");
  }
});

clearBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_SELECTIONS" });
  setStatus("🗑️ All selections cleared");
});

function updateUI() {
  toggleBtn.textContent = isPickerActive
    ? "Stop Picking (Esc)"
    : "Start Picking";
  toggleBtn.className = `btn ${isPickerActive ? "btn-danger" : "btn-primary"}`;
  setStatus(
    isPickerActive
      ? "🎯 Click elements on page. Esc to stop."
      : "Ready. Select elements to clean & capture.",
  );
}

function setStatus(msg, type = "info") {
  statusEl.textContent = msg;
  statusEl.style.color =
    type === "error" ? "#ea4335" : type === "warning" ? "#f9ab00" : "#5f6368";
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PICKER_DEACTIVATED") {
    isPickerActive = false;
    updateUI();
  }
});
