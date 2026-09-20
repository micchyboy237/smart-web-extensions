/**
 * groupByCode.js
 * Groups MissAV search results by JAV code, shows top N as filter chips
 * in a floating panel, and filters the DOM based on selection.
 *
 * Usage:
 *   groupByCode()
 *   groupByCode({ minCount: 3, topN: 5 })
 *   groupByCode.reset()
 */

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const DEFAULT_CONFIG = {
  minCount: 2,
  topN: 10,
  itemSelector: ".thumbnail.group",
  videoAnchorSelector: "a:has(video)",
  altAttr: "alt",
  containerId: "jav-group-by-code-panel",
  activeChipClass: "jav-chip-active",
  hiddenItemClass: "jav-grouped-hidden",
};

// ============================================================================
// CORE LOGIC: EXTRACTION & AGGREGATION
// ============================================================================

/**
 * Lightweight JAV code extractor matching utils.js patterns.
 * @param {string} text - Raw alt text or URL
 * @returns {string|null} Normalized lowercase code or null
 */
function extractCode(text) {
  if (!text) return null;
  const patterns = [
    /\b([a-z]+\d*-[a-z]+)-\d+(?:-[a-z0-9-]+)?\b/i,
    /\b([a-z0-9]+)-\d+(?:-[a-z0-9-]+)?\b/i,
    /\b([a-z]+)\d{3,6}\b/i,
    /\b(\d+[a-z]+)\d{3,6}\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Scans DOM and extracts grouped code data.
 * @param {Object} config
 * @returns {Array<{code: string, count: number, urls: string[], elements: Element[]}>}
 */
function extractGroupedCodes(config) {
  console.log("[GroupByCode] 🔍 Extracting items...");
  const items = document.querySelectorAll(config.itemSelector);
  const codeMap = new Map();
  let skipped = 0;

  items.forEach((item) => {
    const videoAnchor = item.querySelector(config.videoAnchorSelector);
    if (!videoAnchor) {
      skipped++;
      return;
    }

    const rawAlt = videoAnchor.getAttribute(config.altAttr);
    const code = extractCode(rawAlt);
    if (!code) {
      skipped++;
      return;
    }

    if (!codeMap.has(code)) {
      codeMap.set(code, { code, count: 0, urls: [], elements: [] });
    }
    const entry = codeMap.get(code);
    entry.count++;
    entry.urls.push(videoAnchor.href || "");
    entry.elements.push(item);
  });

  console.log(
    `[GroupByCode] 📦 Found ${items.length} items, ${skipped} skipped, ${codeMap.size} unique codes`,
  );

  const result = Array.from(codeMap.values())
    .filter((g) => g.count >= config.minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, config.topN);

  console.log(
    `[GroupByCode] ✅ Top groups (min=${config.minCount}, topN=${config.topN}):`,
    result.map((g) => `${g.code}(${g.count})`).join(", "),
  );
  return result;
}

// ============================================================================
// DOM MANIPULATION: FILTERING & RESET
// ============================================================================

/**
 * Shows/hides items. Null elements = reset (show all).
 */
function applyFilter(elements, config) {
  const allItems = document.querySelectorAll(config.itemSelector);
  allItems.forEach((el) => el.classList.remove(config.hiddenItemClass));

  if (!elements) {
    console.log("[GroupByCode] 🔄 Reset: showing all items");
    return;
  }

  const showSet = new Set(elements);
  let hiddenCount = 0;
  allItems.forEach((el) => {
    if (!showSet.has(el)) {
      el.classList.add(config.hiddenItemClass);
      hiddenCount++;
    }
  });
  console.log(
    `[GroupByCode] 🔽 Filter: ${showSet.size} shown, ${hiddenCount} hidden`,
  );
}

/**
 * Full reset: removes panel, styles, shows all items.
 */
function resetAll(config) {
  console.log("[GroupByCode] 🗑️ Full reset triggered");
  applyFilter(null, config);
  const panel = document.getElementById(config.containerId);
  if (panel) panel.remove();
  const style = document.getElementById("jav-group-by-code-style");
  if (style) style.remove();
  console.log("[GroupByCode] ✅ Reset complete");
}

// ============================================================================
// DOM MANIPULATION: FLOATING UI INJECTION
// ============================================================================

/**
 * Injects styles for floating panel, chips, and hidden items. Idempotent.
 */
function injectStyles(config) {
  if (document.getElementById("jav-group-by-code-style")) return;

  const style = document.createElement("style");
  style.id = "jav-group-by-code-style";
  style.textContent = `
    /* Floating panel - fixed position, always visible */
    #${config.containerId} {
      position: fixed !important;
      top: 12px !important;
      right: 12px !important;
      z-index: 2147483647 !important;
      background: rgba(30, 30, 46, 0.97);
      backdrop-filter: blur(12px);
      padding: 12px 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      max-width: 90vw;
      max-height: 80vh;
      overflow-y: auto;
      font-family: system-ui, -apple-system, sans-serif;
    }
    /* Collapse toggle button */
    #${config.containerId} .jav-panel-toggle {
      position: absolute;
      top: -8px;
      right: -8px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #fbbf24;
      color: #1e1e2e;
      font-size: 14px;
      font-weight: bold;
      line-height: 22px;
      text-align: center;
      cursor: pointer;
      border: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      user-select: none;
    }
    #${config.containerId}.jav-panel-collapsed {
      padding: 0 !important;
      gap: 0 !important;
      border: none !important;
      background: transparent !important;
      backdrop-filter: none !important;
      box-shadow: none !important;
      max-width: unset !important;
      max-height: unset !important;
      overflow: visible !important;
    }
    #${config.containerId}.jav-panel-collapsed .jav-chip,
    #${config.containerId}.jav-panel-collapsed .jav-panel-label {
      display: none !important;
    }
    /* Panel label */
    #${config.containerId} .jav-panel-label {
      font-size: 11px;
      font-weight: 700;
      color: #fbbf24;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-right: 4px;
      white-space: nowrap;
    }
    /* Chips */
    #${config.containerId} .jav-chip {
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.08);
      color: #ccc;
      transition: all 0.15s ease;
      user-select: none;
      white-space: nowrap;
    }
    #${config.containerId} .jav-chip:hover {
      background: rgba(255,255,255,0.18);
      color: #fff;
    }
    #${config.containerId} .jav-chip.${config.activeChipClass} {
      background: #fbbf24;
      color: #1e1e2e;
      border-color: #fbbf24;
    }
    /* Hidden items */
    .${config.hiddenItemClass} {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
  console.log("[GroupByCode] 🎨 Floating panel styles injected");
}

/**
 * Updates visual active state on chips (single-select).
 */
function setActiveChip(activeChip, config) {
  const panel = document.getElementById(config.containerId);
  if (!panel) return;
  panel
    .querySelectorAll(".jav-chip")
    .forEach((c) => c.classList.remove(config.activeChipClass));
  activeChip.classList.add(config.activeChipClass);
}

/**
 * Creates and mounts the floating chip panel.
 * First code chip is active by default. Includes collapse toggle.
 */
function renderChipPanel(groups, config) {
  // Remove existing panel if any
  const existing = document.getElementById(config.containerId);
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = config.containerId;

  // Collapse/expand toggle button
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "jav-panel-toggle";
  toggleBtn.textContent = "−";
  toggleBtn.title = "Collapse / Expand panel";
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isCollapsed = panel.classList.toggle("jav-panel-collapsed");
    toggleBtn.textContent = isCollapsed ? "+" : "−";
    toggleBtn.title = isCollapsed ? "Expand panel" : "Collapse panel";
  });
  panel.appendChild(toggleBtn);

  // Label
  const label = document.createElement("span");
  label.className = "jav-panel-label";
  label.textContent = "Filter by Code";
  panel.appendChild(label);

  // "All" reset chip
  const allChip = document.createElement("span");
  allChip.className = "jav-chip";
  allChip.textContent = "All";
  allChip.addEventListener("click", () => {
    setActiveChip(allChip, config);
    applyFilter(null, config);
  });
  panel.appendChild(allChip);

  // Code chips
  groups.forEach((group, index) => {
    const chip = document.createElement("span");
    chip.className = "jav-chip";
    chip.textContent = `${group.code.toUpperCase()} (${group.count})`;
    chip.dataset.code = group.code;
    chip.addEventListener("click", () => {
      setActiveChip(chip, config);
      applyFilter(group.elements, config);
    });
    panel.appendChild(chip);

    // Activate first chip by default
    if (index === 0) {
      setActiveChip(chip, config);
      applyFilter(group.elements, config);
    }
  });

  // Append to body (not main) so fixed positioning is relative to viewport
  document.body.appendChild(panel);

  console.log(
    `[GroupByCode] 🏷️ Floating panel rendered with ${groups.length + 1} chips`,
  );
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Main function: Extract codes, build floating chips, filter items.
 * @param {Object} [options={}] - Override default config
 */
function groupByCode(options = {}) {
  console.log("[GroupByCode] ▶️ Starting with options:", options);
  const config = { ...DEFAULT_CONFIG, ...options };

  if (config.minCount < 1) config.minCount = 1;
  if (config.topN < 1) config.topN = 1;

  const groups = extractGroupedCodes(config);

  if (groups.length === 0) {
    console.warn("[GroupByCode] ⚠️ No groups found. Try lowering minCount.");
    alert(
      `[GroupByCode] No code groups found with count >= ${config.minCount}.\nTry: groupByCode({ minCount: 1 })`,
    );
    return;
  }

  injectStyles(config);
  renderChipPanel(groups, config);
  console.log("[GroupByCode] ✅ Done!");
}

/**
 * Reset helper: removes all UI and shows all items.
 */
groupByCode.reset = function () {
  resetAll(DEFAULT_CONFIG);
};

console.log(
  "[GroupByCode] ✅ Script loaded. Run: groupByCode() | groupByCode({ minCount: 3, topN: 5 }) | groupByCode.reset()",
);
