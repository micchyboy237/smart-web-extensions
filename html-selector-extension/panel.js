/**
 * Panel Controller
 * Runs inside the detached window opened by background.js. Talks only to
 * the ONE tab it was opened for — its id comes in via the URL query string.
 */
const tabId = Number(new URLSearchParams(location.search).get("tabId"));

const statusDot = document.getElementById("statusDot");
const disableBtn = document.getElementById("disableBtn");
const endpointInput = document.getElementById("endpointUrl");
const selCountEl = document.getElementById("selCount");
const selListEl = document.getElementById("selList");
const previewCode = document.getElementById("previewCode");
const clearBtn = document.getElementById("clearBtn");
const copyBtn = document.getElementById("copyBtn");
const sendBtn = document.getElementById("sendBtn");
const statusEl = document.getElementById("status");

let currentPreview = "";

init();

async function init() {
  if (!tabId) {
    setStatus("❌ No tab associated with this panel.", "error");
    return;
  }
  try {
    const state = await chrome.tabs.sendMessage(tabId, { type: "GET_STATE" });
    render(state);
  } catch (err) {
    setStatus("❌ Lost connection to the page. Close and reopen.", "error");
    console.error("[Panel] GET_STATE failed:", err.message);
  }
}

// Closing the window is enough — background.js's windows.onRemoved listener
// handles deactivating the picker and clearing the badge.
disableBtn.addEventListener("click", () => window.close());

clearBtn.addEventListener("click", async () => {
  await chrome.tabs.sendMessage(tabId, { type: "CLEAR_SELECTIONS" });
  setStatus("🗑️ All selections cleared");
});

copyBtn.addEventListener("click", async () => {
  if (!currentPreview) {
    setStatus("⚠️ Nothing to copy yet", "warning");
    return;
  }
  try {
    // Real focused document window → navigator.clipboard just works here,
    // no offscreen-document workaround needed.
    await navigator.clipboard.writeText(currentPreview);
    setStatus("✅ Copied cleaned HTML to clipboard");
  } catch (err) {
    console.error("[Panel] Clipboard write failed:", err.message);
    setStatus("❌ Copy failed: " + err.message, "error");
  }
});

sendBtn.addEventListener("click", async () => {
  const endpoint = endpointInput.value.trim();
  if (!endpoint) {
    setStatus("⚠️ Enter an endpoint URL", "warning");
    return;
  }
  if (!currentPreview) {
    setStatus("⚠️ No elements selected", "warning");
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const payload = {
    html: currentPreview, // exact text shown in the preview box above
    elementCount: Number(selCountEl.textContent),
    sourceUrl: tab?.url ?? null,
    sentAt: new Date().toISOString(),
  };
  setStatus(`📤 Sending ${payload.elementCount} element(s)...`);
  const result = await chrome.runtime.sendMessage({
    type: "SEND_TO_ENDPOINT",
    url: endpoint,
    data: payload,
  });
  setStatus(
    result.success
      ? `✅ Sent (HTTP ${result.status})`
      : `❌ Failed: ${result.error}`,
    result.success ? "info" : "error",
  );
});

// Live updates pushed from the content script whenever a selection changes.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "STATE_UPDATE" && sender.tab?.id === tabId) {
    render(msg.state);
  }
});

function render(state) {
  statusDot.style.background = state.active ? "#34a853" : "#9aa0a6";
  currentPreview = state.preview || "";
  selCountEl.textContent = state.count;

  selListEl.innerHTML = "";
  if (state.items.length === 0) {
    const li = document.createElement("li");
    li.className = "sel-empty";
    li.textContent = "Click elements on the page to select them.";
    selListEl.appendChild(li);
  } else {
    for (const item of state.items) {
      const li = document.createElement("li");

      const label = document.createElement("span");
      label.className = "sel-label";
      label.title = item.label;
      label.textContent = item.label;

      const removeBtn = document.createElement("button");
      removeBtn.className = "sel-remove";
      removeBtn.type = "button";
      removeBtn.title = "Remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () =>
        chrome.tabs.sendMessage(tabId, {
          type: "REMOVE_SELECTION",
          id: item.id,
        }),
      );

      li.append(label, removeBtn);
      selListEl.appendChild(li);
    }
  }

  previewCode.textContent = currentPreview || "// Nothing selected yet";
}

function setStatus(msg, type = "info") {
  statusEl.textContent = msg;
  statusEl.style.color =
    type === "error" ? "#ea4335" : type === "warning" ? "#f9ab00" : "#5f6368";
}
