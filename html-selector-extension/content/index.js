/**
 * Content Script Orchestrator
 * Bridges Picker (DOM selection) <-> the detached panel window, via
 * chrome.runtime messages. Also owns the single function that builds the
 * combined preview — copy and send both use its output verbatim.
 */
(() => {
  let includeClassId = false;

  // Initialize setting from storage
  chrome.storage.sync.get({ includeClassId: false }, (result) => {
    includeClassId = result.includeClassId;
    console.log(`[Orchestrator] Loaded includeClassId: ${includeClassId}`);
  });

  // React to setting changes in real-time without requiring re-selection
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.includeClassId) {
      includeClassId = changes.includeClassId.newValue;
      console.log(`[Orchestrator] includeClassId updated: ${includeClassId}`);
      _broadcastState(); // Re-render preview with new setting immediately
    }
  });

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
      includeClassId,
      items: sorted.map(({ id, node }) => ({
        id,
        tag: node.tagName.toLowerCase(),
        label: _describe(node),
        selector: _getCssSelector(node),
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
      (item) =>
        RAGCleaner.clean(item.node.outerHTML, { includeClassId }).cleaned,
    );
    return Prettify.html(pieces.join("\n\n"));
  }

  /**
   * Generate a direct CSS selector for a specific element.
   * Prioritizes ID, then tag+classes uniqueness, falls back to nth-of-type path.
   */
  function _getCssSelector(node) {
    // 1. ID is always unique and shortest
    if (node.id) {
      try {
        return `#${CSS.escape(node.id)}`;
      } catch (_) {
        /* fall through */
      }
    }

    const tag = node.tagName.toLowerCase();

    // 2. Try tag + classes if it uniquely identifies the element
    const classList =
      typeof node.className === "string"
        ? node.className.trim().split(/\s+/).filter(Boolean)
        : [];

    if (classList.length > 0) {
      const classSelector = classList
        .map((c) => {
          try {
            return `.${CSS.escape(c)}`;
          } catch (_) {
            return "";
          }
        })
        .filter(Boolean)
        .join("");

      if (classSelector) {
        const candidate = `${tag}${classSelector}`;
        try {
          if (document.querySelectorAll(candidate).length === 1)
            return candidate;
        } catch (_) {
          /* invalid selector, fall through */
        }
      }
    }

    // 3. Fallback: build full path using nth-of-type for guaranteed uniqueness
    const path = [];
    let current = node;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 0;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      const tagName = current.tagName.toLowerCase();
      const nth = index > 0 ? `:nth-of-type(${index + 1})` : "";
      path.unshift(`${tagName}${nth}`);

      // Stop climbing at body or if we hit an ancestor with an ID
      if (current.parentElement === document.body || current.id) break;
      current = current.parentElement;
    }

    return path.join(" > ");
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
