/**
 * Offscreen Document Clipboard Handler
 *
 * KEY CONSTRAINT (Chrome MV3, as of 2026):
 *   - navigator.clipboard.writeText() is BLOCKED in offscreen documents
 *     because the API requires document focus, which offscreen docs never have.
 *     Error thrown: "DOMException: Document is not focused."
 *   - Fix: use the deprecated-but-working document.execCommand('copy')
 *     via a hidden textarea. This works reliably in Chrome offscreen docs.
 *
 * Flow: background.js → OFFSCREEN_COPY → here → execCommand → clipboard
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "OFFSCREEN_COPY") return;

  console.log("[Offscreen] OFFSCREEN_COPY received", {
    textLength: msg.text?.length,
    textPreview: msg.text?.substring(0, 80) + "...",
  });

  const result = _execCommandCopy(msg.text);

  if (result.success) {
    console.log("[Offscreen] execCommand copy succeeded");
    sendResponse({ success: true });
  } else {
    console.error("[Offscreen] execCommand copy failed:", result.error);
    sendResponse({ success: false, error: result.error });
  }

  return true; // keep message channel open (even though we respond sync here)
});

/**
 * Write text to clipboard via a hidden textarea + execCommand.
 * This is the only reliable clipboard write method available inside
 * an offscreen document in Chrome MV3.
 *
 * @param {string} text
 * @returns {{ success: boolean, error?: string }}
 */
function _execCommandCopy(text) {
  let textarea = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;

    // Position off-screen so it's invisible but still in the DOM
    textarea.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "width:1px",
      "height:1px",
      "opacity:0",
      "pointer-events:none",
      "white-space:pre", // preserves newlines in copied text
    ].join(";");

    document.body.appendChild(textarea);

    console.log("[Offscreen] textarea appended, selecting...", {
      valueLength: textarea.value.length,
      bodyChildCount: document.body.childElementCount,
    });

    textarea.focus();
    textarea.select();

    // Select all content explicitly (belt + suspenders)
    textarea.setSelectionRange(0, textarea.value.length);

    console.log("[Offscreen] Selection range set:", {
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    });

    const success = document.execCommand("copy");

    console.log("[Offscreen] execCommand('copy') returned:", success);

    if (!success) {
      return { success: false, error: "execCommand returned false" };
    }

    return { success: true };
  } catch (err) {
    console.error("[Offscreen] execCommand threw:", {
      name: err.name,
      message: err.message,
    });
    return { success: false, error: err.message };
  } finally {
    if (textarea && textarea.parentNode) {
      textarea.parentNode.removeChild(textarea);
      console.log("[Offscreen] textarea cleaned up");
    }
  }
}
