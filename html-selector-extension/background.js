/**
 * Background Service Worker
 *
 * CLIPBOARD STRATEGY (Chrome MV3):
 *   navigator.clipboard is NOT available in extension service workers.
 *   The only working path is: SW → offscreen doc → execCommand('copy').
 *   We skip the SW clipboard attempt entirely to avoid misleading errors.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── HTTP Relay ──────────────────────────────────────────────────────────────
  if (msg.type === "SEND_TO_ENDPOINT") {
    fetch(msg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.data),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return {
          success: true,
          status: r.status,
          data: await r.json().catch(() => ({})),
        };
      })
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── Clipboard Write ─────────────────────────────────────────────────────────
  if (msg.type === "COPY_TO_CLIPBOARD") {
    console.log("[BG] COPY_TO_CLIPBOARD received", {
      textLength: msg.text?.length,
      senderTabId: sender.tab?.id,
      senderUrl: sender.tab?.url,
    });

    _writeViaOffscreen(msg.text)
      .then(() => {
        console.log("[BG] Clipboard write pipeline succeeded");
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("[BG] Clipboard write pipeline failed:", err.message);
        sendResponse({ success: false, error: err.message });
      });

    return true; // keep channel open for async response
  }
});

/**
 * Ensure exactly one offscreen document is alive, then ask it
 * to write `text` to the clipboard via execCommand.
 *
 * Chrome MV3 constraint: only one offscreen doc per extension at a time.
 * We guard creation with a module-level promise to prevent race conditions.
 *
 * @param {string} text
 */
let _creating = null; // in-flight createDocument promise guard

async function _writeViaOffscreen(text) {
  await _ensureOffscreenDocument();

  console.log("[BG] Sending OFFSCREEN_COPY to offscreen doc", {
    textLength: text.length,
  });

  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_COPY",
    text,
  });

  console.log("[BG] OFFSCREEN_COPY response:", response);

  if (!response?.success) {
    throw new Error(response?.error ?? "Offscreen copy returned no success");
  }
}

/**
 * Creates the offscreen document if one doesn't already exist.
 * Uses chrome.runtime.getContexts (Chrome 116+) with a clients.matchAll()
 * fallback for older Chromium builds.
 */
async function _ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");

  // Chrome 116+ path (preferred)
  if ("getContexts" in chrome.runtime) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });

    console.log("[BG] Existing offscreen contexts:", existing.length);

    if (existing.length > 0) return;
  } else {
    // Fallback: service worker clients list
    const clients = await self.clients.matchAll();
    const exists = clients.some((c) => c.url === offscreenUrl);
    console.log("[BG] Offscreen doc exists via clients.matchAll():", exists);
    if (exists) return;
  }

  // Guard against concurrent creation calls
  if (_creating) {
    console.log("[BG] Offscreen creation already in progress, awaiting...");
    await _creating;
    return;
  }

  console.log("[BG] Creating offscreen document...");
  _creating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["CLIPBOARD"],
    justification: "Write cleaned HTML to clipboard via execCommand",
  });

  try {
    await _creating;
    console.log("[BG] Offscreen document created successfully");
  } finally {
    _creating = null;
  }
}
