/**
 * Preview Modal Module
 * Fix 1: Uses 'pointerup' on copy button — fires before picker's 'click' capture handler
 * Fix 2: index.js must call Picker.deactivate() before Preview.show()
 */
const Preview = (() => {
  let modal = null;
  let escHandler = null;

  function show(cleanedHtml, metadata) {
    if (modal) hide();

    console.log("[Preview] show() called", {
      htmlLength: cleanedHtml.length,
      reduction: metadata.reduction,
      isSecureContext: window.isSecureContext,
      hasClipboardAPI: !!navigator.clipboard,
      pageProtocol: window.location.protocol,
    });

    modal = document.createElement("div");
    modal.id = "ext-preview-modal";
    modal.className = "ext-preview-modal";
    modal.innerHTML = `
      <div class="ext-preview-backdrop"></div>
      <div class="ext-preview-container">
        <div class="ext-preview-header">
          <h3>Cleaned HTML Preview</h3>
          <div class="ext-preview-meta">
            <span>Reduced: ${metadata.reduction}</span>
            <span>Clean: ${metadata.cleanedLength} chars</span>
          </div>
          <button class="ext-preview-close" title="Close">&times;</button>
        </div>
        <div class="ext-preview-body">
          <pre><code>${_escapeHtml(cleanedHtml)}</code></pre>
        </div>
        <div class="ext-preview-footer">
          <button class="ext-copy-btn" title="Copy to clipboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span>Copy HTML</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    console.log("[Preview] Modal appended to DOM");

    _bindModalEvents(cleanedHtml);

    const btn = modal.querySelector(".ext-copy-btn");
    console.log("[Preview] Copy button in DOM after bind:", {
      found: !!btn,
      tagName: btn?.tagName,
      label: btn?.querySelector("span")?.textContent?.trim(),
    });
  }

  function hide() {
    if (escHandler) {
      document.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
    if (modal) {
      modal.remove();
      modal = null;
      console.log("[Preview] Modal closed & cleaned up");
    }
  }

  function _bindModalEvents(textToCopy) {
    console.log("[Preview] _bindModalEvents() called", {
      modalInDOM: !!document.getElementById("ext-preview-modal"),
      textLength: textToCopy.length,
    });

    const closeBtn = modal.querySelector(".ext-preview-close");
    const backdrop = modal.querySelector(".ext-preview-backdrop");
    const copyBtn = modal.querySelector(".ext-copy-btn");
    const span = copyBtn?.querySelector("span");

    console.log("[Preview] DOM query results:", {
      closeBtn: !!closeBtn,
      backdrop: !!backdrop,
      copyBtn: !!copyBtn,
      span: !!span,
    });

    if (!copyBtn) {
      console.error(
        "[Preview] FATAL: .ext-copy-btn not found — listeners not bound",
      );
      return;
    }

    closeBtn.addEventListener("click", hide);
    backdrop.addEventListener("click", hide);

    // KEY FIX: Use 'pointerup' instead of 'click'.
    // The picker registers a document 'click' handler with capture:true +
    // stopImmediatePropagation(), which kills all click events while active.
    // 'pointerup' fires in a completely separate event chain — unaffected.
    copyBtn.addEventListener("pointerup", (e) => {
      e.stopPropagation();

      console.log("[Preview] Copy button POINTERUP fired ✓", {
        textLength: textToCopy.length,
        timestamp: Date.now(),
        documentHasFocus: document.hasFocus(),
        isSecureContext: window.isSecureContext,
        pickerStillActive: document.body.style.cursor === "crosshair",
      });

      const originalText = span.textContent;
      span.textContent = "⏳ Copying...";

      console.log("[Preview] Sending COPY_TO_CLIPBOARD to background...");

      chrome.runtime.sendMessage(
        { type: "COPY_TO_CLIPBOARD", text: textToCopy },
        (response) => {
          const lastErr = chrome.runtime.lastError;

          console.log("[Preview] COPY_TO_CLIPBOARD response received", {
            response,
            lastError: lastErr?.message ?? null,
          });

          if (lastErr) {
            console.error("[Preview] Runtime lastError:", lastErr.message);
            span.textContent = "✗ Extension error";
            setTimeout(() => {
              span.textContent = originalText;
            }, 2000);
            return;
          }

          if (response?.success) {
            span.textContent = "✓ Copied!";
            copyBtn.classList.add("copied");
            console.log("[Preview] ✓ Copy succeeded via background");
          } else {
            span.textContent = "✗ Copy failed";
            console.error("[Preview] ✗ Copy failed, reason:", response?.error);
          }

          setTimeout(() => {
            span.textContent = originalText;
            copyBtn.classList.remove("copied");
          }, 2000);
        },
      );
    }); // no capture needed — pointerup is its own chain

    escHandler = (e) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("keydown", escHandler);

    console.log("[Preview] All event listeners bound ✓ (copy uses pointerup)");
  }

  function _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  return { show, hide };
})();
