/**
 * Preview Modal Module
 * Shows cleaned HTML with copy-to-clipboard button
 */
const Preview = (() => {
  let modal = null;

  function show(cleanedHtml, metadata) {
    if (modal) modal.remove();

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
    _bindModalEvents(cleanedHtml);
    console.log("[Preview] Modal opened");
  }

  function hide() {
    if (modal) {
      modal.remove();
      modal = null;
      console.log("[Preview] Modal closed");
    }
  }

  function _bindModalEvents(textToCopy) {
    modal.querySelector(".ext-preview-close").addEventListener("click", hide);
    modal
      .querySelector(".ext-preview-backdrop")
      .addEventListener("click", hide);

    const copyBtn = modal.querySelector(".ext-copy-btn");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(textToCopy);
        const span = copyBtn.querySelector("span");
        const original = span.textContent;
        span.textContent = "Copied!";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          span.textContent = original;
          copyBtn.classList.remove("copied");
        }, 2000);
        console.log("[Preview] Copied to clipboard");
      } catch (err) {
        console.error("[Preview] Copy failed:", err);
      }
    });

    // Close on Escape
    const escHandler = (e) => {
      if (e.key === "Escape") {
        hide();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);
  }

  function _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  return { show, hide };
})();
