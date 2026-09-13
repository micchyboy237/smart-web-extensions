/**
 * Content Script Orchestrator
 * Bridges Picker (DOM selection) <-> the detached panel window, via
 * chrome.runtime messages. Also owns the single function that builds the
 * combined preview — copy and send both use its output verbatim.
 */
(() => {
  Picker.init(_broadcastState);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case "TOGGLE_PICKER":
        msg.active ? Picker.activate() : Picker.deactivate();
        sendResponse({ success: true, active: Picker.getIsActive() });
        _broadcastState();
        return true;

      case "GET_STATE":
        sendResponse(_buildState());
        return true;

      case "REMOVE_SELECTION":
        sendResponse({ success: Picker.removeSelection(msg.id) });
        return true;

      case "CLEAR_SELECTIONS":
        Picker.clearSelections();
        sendResponse({ success: true });
        return true;

      default:
        return false;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && Picker.getIsActive()) {
      Picker.deactivate();
      _broadcastState();
      chrome.runtime.sendMessage({ type: "REQUEST_DISABLE" }).catch(() => {});
    }
  });

  function _buildState() {
    const sorted = _sortByDomOrder(Picker.getSelections());
    return {
      active: Picker.getIsActive(),
      count: sorted.length,
      items: sorted.map(({ id, node }) => ({
        id,
        tag: node.tagName.toLowerCase(),
        label: _describe(node),
      })),
      preview: _buildCombinedPreview(sorted),
    };
  }

  function _broadcastState() {
    chrome.runtime
      .sendMessage({ type: "STATE_UPDATE", state: _buildState() })
      .catch(() => {});
  }

  // Sort by where each element actually sits in the document — not selection order.
  function _sortByDomOrder(items) {
    return [...items].sort((a, b) => {
      const pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  // The ONE place that produces preview text — copy & send reuse this exact string.
  function _buildCombinedPreview(sortedItems) {
    if (sortedItems.length === 0) return "";
    const pieces = sortedItems.map(
      (item) => RAGCleaner.clean(item.node.outerHTML).cleaned,
    );
    return Prettify.html(pieces.join("\n\n"));
  }

  function _describe(node) {
    const id = node.id ? `#${node.id}` : "";
    const cls =
      typeof node.className === "string" && node.className.trim()
        ? "." + node.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    const text = node.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
    return `${node.tagName.toLowerCase()}${id}${cls}${text ? " — " + text : ""}`;
  }

  console.log("[Orchestrator] Content script initialized");
})();
