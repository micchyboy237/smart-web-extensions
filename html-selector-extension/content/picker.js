/**
 * Visual Element Picker Module — multi-select version.
 * Every selected element gets a persistent highlight box with a circular
 * "×" button pinned to its top-right corner. Highlights stay visible for
 * as long as the picker is active (i.e. the panel window is open).
 */
const Picker = (() => {
  let isActive = false;
  let hoverBox = null;
  let rafId = null;
  let idCounter = 0;
  let onChange = null;
  const selections = new Map(); // id -> { node, box }

  function init(changeCallback) {
    onChange = changeCallback;
    hoverBox = document.createElement("div");
    hoverBox.className = "ext-hover-box";
    document.documentElement.appendChild(hoverBox);
  }

  function activate() {
    if (isActive) return;
    isActive = true;
    document.body.style.cursor = "crosshair";
    document.addEventListener("mouseover", _onMouseOver, true);
    document.addEventListener("click", _onClick, true);
    for (const sel of selections.values()) _showSelectionBox(sel);
    _startTracking();
    console.log(
      `[Picker] Activated, ${selections.size} existing selection(s) restored`,
    );
  }

  function deactivate() {
    if (!isActive) return;
    isActive = false;
    document.body.style.cursor = "";
    document.removeEventListener("mouseover", _onMouseOver, true);
    document.removeEventListener("click", _onClick, true);
    hoverBox.style.display = "none";
    for (const sel of selections.values()) sel.box.remove();
    _stopTracking();
    console.log("[Picker] Deactivated");
  }

  function getIsActive() {
    return isActive;
  }

  function getSelections() {
    return [...selections.entries()].map(([id, sel]) => ({
      id,
      node: sel.node,
    }));
  }

  function removeSelection(id) {
    const sel = selections.get(id);
    if (!sel) return false;
    sel.box.remove();
    selections.delete(id);
    onChange?.();
    console.log(`[Picker] Removed selection #${id}`);
    return true;
  }

  function clearSelections() {
    for (const sel of selections.values()) sel.box.remove();
    selections.clear();
    onChange?.();
    console.log("[Picker] All selections cleared");
  }

  // ── internals ──────────────────────────────────────────────────────────

  function _onMouseOver(e) {
    if (!isActive) return;
    const target = e.target;
    if (_isOwnElement(target)) return;
    if (_findSelectionByNode(target)) {
      hoverBox.style.display = "none"; // already selected — no hover box
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    _positionBox(hoverBox, target);
    hoverBox.style.display = "block";
  }

  function _onClick(e) {
    if (!isActive) return;
    const target = e.target;

    const removeBtn = target.closest?.(".ext-select-remove");
    if (removeBtn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      removeSelection(removeBtn.dataset.selId);
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (_isOwnElement(target)) return; // click on hover/select box chrome itself
    if (_findSelectionByNode(target)) return; // already selected, no-op

    _addSelection(target);
  }

  function _addSelection(node) {
    const id = String(++idCounter);
    const box = document.createElement("div");
    box.className = "ext-select-box";

    const removeBtn = document.createElement("button");
    removeBtn.className = "ext-select-remove";
    removeBtn.type = "button";
    removeBtn.title = "Remove from selection";
    removeBtn.textContent = "×";
    removeBtn.dataset.selId = id;
    box.appendChild(removeBtn);

    document.documentElement.appendChild(box);
    selections.set(id, { node, box });
    _positionBox(box, node);
    hoverBox.style.display = "none";
    _flashConfirm(node);
    onChange?.();
    console.log(
      `[Picker] Added selection #${id} <${node.tagName.toLowerCase()}>`,
    );
  }

  function _findSelectionByNode(node) {
    for (const [id, sel] of selections.entries()) {
      if (sel.node === node) return id;
    }
    return null;
  }

  function _isOwnElement(el) {
    return !!el.closest?.(
      ".ext-hover-box, .ext-select-box, .ext-select-remove",
    );
  }

  function _showSelectionBox(sel) {
    if (!sel.box.isConnected) document.documentElement.appendChild(sel.box);
  }

  function _positionBox(box, node) {
    const rect = node.getBoundingClientRect();
    Object.assign(box.style, {
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function _flashConfirm(node) {
    const flash = document.createElement("div");
    flash.className = "ext-flash-confirm";
    const rect = node.getBoundingClientRect();
    Object.assign(flash.style, {
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    document.documentElement.appendChild(flash);
    setTimeout(() => flash.remove(), 300);
  }

  // Reposition every visible box every frame while active — the simplest
  // way to stay correct across scroll, resize, and layout shifts.
  function _startTracking() {
    const tick = () => {
      for (const [id, sel] of [...selections.entries()]) {
        if (sel.node.isConnected) {
          _positionBox(sel.box, sel.node);
        } else {
          // Element vanished (e.g. SPA re-render) — drop it and notify the panel.
          sel.box.remove();
          selections.delete(id);
          onChange?.();
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function _stopTracking() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  return {
    init,
    activate,
    deactivate,
    getIsActive,
    getSelections,
    removeSelection,
    clearSelections,
  };
})();
