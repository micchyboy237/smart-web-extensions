/**
 * Content Script Orchestrator
 * Wires Picker, Cleaner, and Preview modules together
 */
(() => {
  const selectedItems = []; // Stores { raw, cleaned, textContent, metadata }

  // Initialize picker with selection callback
  Picker.init((rawHtml) => {
    const result = RAGCleaner.clean(rawHtml);
    selectedItems.push({
      raw: rawHtml,
      cleaned: result.cleaned,
      textContent: result.textContent,
      metadata: result.metadata,
      timestamp: Date.now(),
    });
    console.log(
      `[Orchestrator] Item #${selectedItems.length} captured & cleaned`,
    );
  });

  // Message handler for popup communication
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case "TOGGLE_PICKER":
        msg.active ? Picker.activate() : Picker.deactivate();
        sendResponse({ success: true, active: Picker.getIsActive() });
        break;

      case "GET_SELECTIONS":
        sendResponse({ items: selectedItems });
        break;

      case "CLEAR_SELECTIONS":
        selectedItems.length = 0;
        console.log("[Orchestrator] Selections cleared");
        sendResponse({ success: true });
        break;

      case "PREVIEW_LAST":
        if (selectedItems.length > 0) {
          const last = selectedItems[selectedItems.length - 1];
          Preview.show(last.cleaned, last.metadata);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "No items selected" });
        }
        break;

      default:
        sendResponse({ success: false, error: "Unknown message type" });
    }
    return true;
  });

  // Notify popup when picker deactivates via Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && Picker.getIsActive()) {
      // Picker handles its own deactivation; just notify popup
      chrome.runtime
        .sendMessage({ type: "PICKER_DEACTIVATED" })
        .catch(() => {});
    }
  });

  console.log("[Orchestrator] Content script initialized");
})();
