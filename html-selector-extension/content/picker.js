/**
 * Visual Element Picker Module
 * Handles hover highlighting and click-to-select
 */
const Picker = (() => {
  let isActive = false;
  let overlay = null;
  let lastHovered = null;
  let onSelectCallback = null;

  function init(onSelect) {
    onSelectCallback = onSelect;
    _createOverlay();
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isActive) deactivate();
    });
  }

  function activate() {
    isActive = true;
    document.body.style.cursor = "crosshair";
    document.addEventListener("mouseover", _onMouseOver, true);
    document.addEventListener("click", _onClick, true);
    console.log("[Picker] Activated");
  }

  function deactivate() {
    isActive = false;
    document.body.style.cursor = "";
    document.removeEventListener("mouseover", _onMouseOver, true);
    document.removeEventListener("click", _onClick, true);
    _hideOverlay();
    console.log("[Picker] Deactivated");
  }

  function getIsActive() {
    return isActive;
  }

  function _createOverlay() {
    overlay = document.createElement("div");
    overlay.id = "ext-selector-overlay";
    overlay.className = "ext-highlight-overlay";
    document.body.appendChild(overlay);
  }

  function _onMouseOver(e) {
    if (!isActive) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    if (target.id === "ext-selector-overlay") return;
    lastHovered = target;
    const rect = target.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: "block",
      top: `${rect.top + window.scrollY}px`,
      left: `${rect.left + window.scrollX}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function _onClick(e) {
    if (!isActive) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const target = lastHovered || e.target;
    if (!target || target.id === "ext-selector-overlay") return;
    if (onSelectCallback) onSelectCallback(target.outerHTML);
    _flashConfirm(target);
  }

  function _hideOverlay() {
    if (overlay) overlay.style.display = "none";
  }

  function _flashConfirm(element) {
    const flash = document.createElement("div");
    flash.className = "ext-flash-confirm";
    const rect = element.getBoundingClientRect();
    Object.assign(flash.style, {
      top: `${rect.top + window.scrollY}px`,
      left: `${rect.left + window.scrollX}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 300);
  }

  return { init, activate, deactivate, getIsActive };
})();
