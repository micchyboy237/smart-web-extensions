/**
 * groupByCode.js
 * Groups MissAV search results by JAV code, shows top N as filter chips,
 * and filters the DOM based on selection.
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
  minCount: 2, // Minimum videos to form a group
  topN: 10, // Max number of chips to display
  itemSelector: ".thumbnail.group",
  videoAnchorSelector: "a:has(video)", // Matches __sample.html structure
  altAttr: "alt", // Code is extracted from this attribute
  containerId: "jav-group-by-code-panel",
  activeChipClass: "jav-chip-active",
  hiddenItemClass: "jav-grouped-hidden",
};

// ============================================================================
// CORE LOGIC: EXTRACTION & AGGREGATION
// ============================================================================

/**
 * Lightweight JAV code extractor matching utils.js patterns.
 * Extracts the 'code' portion (e.g., "luxu" from "luxu-1389").
 * @param {string} text - Raw alt text or URL
 * @returns {string|null} Normalized lowercase code or null
 */
function extractCode(text) {
  if (!text) return null;

  // Pattern priority matches utils.js extractJavInfo exactly
  const patterns = [
    /\b([a-z]+\d*-[a-z]+)-\d+(?:-[a-z0-9-]+)?\b/i, // three-part: fc2-ppv-4909847
    /\b([a-z0-9]+)-\d+(?:-[a-z0-9-]+)?\b/i, // two-part: luxu-1389
    /\b([a-z]+)\d{3,6}\b/i, // no hyphen: abp123
    /\b(\d+[a-z]+)\d{3,6}\b/i, // digits first: 1pondo456
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].toLowerCase();
    }
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
    // Find anchor that contains a video child (per __sample.html)
    const videoAnchor = item.querySelector(config.videoAnchorSelector);
    if (!videoAnchor) {
      skipped++;
      return;
    }

    // Extract code from the alt attribute of the video anchor
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

  // Convert to array, filter by minCount, sort desc by count, limit to topN
  const result = Array.from(codeMap.values())
    .filter((g) => g.count >= config.minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, config.topN);

  console.log(
    `[GroupByCode] ✅ Top groups after filtering (min=${config.minCount}, topN=${config.topN}):`,
    result.map((g) => `${g.code}(${g.count})`).join(", "),
  );

  return result;
}

// ============================================================================
// DOM MANIPULATION: FILTERING & RESET
// ============================================================================

/**
 * Shows/hides items based on selected code group.
 * Follows searchTerm.js reset pattern: null elements = show all.
 * @param {Element[]|null} elements - Elements to show. Null = show all (reset).
 * @param {Object} config
 */
function applyFilter(elements, config) {
  const allItems = document.querySelectorAll(config.itemSelector);

  // Reset: remove hidden class from all items first
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
    `[GroupByCode] 🔽 Filter applied: ${showSet.size} shown, ${hiddenCount} hidden`,
  );
}

/**
 * Full reset: removes panel, injected styles, and shows all items.
 * @param {Object} config
 */
function resetAll(config) {
  console.log("[GroupByCode] 🗑️ Full reset triggered");

  // Show all items
  applyFilter(null, config);

  // Remove chip panel
  const panel = document.getElementById(config.containerId);
  if (panel) panel.remove();

  // Remove injected styles
  const style = document.getElementById("jav-group-by-code-style");
  if (style) style.remove();

  console.log("[GroupByCode] ✅ Reset complete");
}

// ============================================================================
// DOM MANIPULATION: UI INJECTION
// ============================================================================

/**
 * Injects styles for chips and hidden items. Idempotent.
 */
function injectStyles(config) {
  if (document.getElementById("jav-group-by-code-style")) return;

  const style = document.createElement("style");
  style.id = "jav-group-by-code-style";
  style.textContent = `
    #${config.containerId} {
      position: sticky;
      top: 0;
      z-index: 9999;
      background: rgba(30, 30, 46, 0.95);
      backdrop-filter: blur(8px);
      padding: 10px 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      margin-bottom: 12px;
    }
    #${config.containerId} .jav-chip {
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.05);
      color: #ccc;
      transition: all 0.15s ease;
      user-select: none;
    }
    #${config.containerId} .jav-chip:hover {
      background: rgba(255,255,255,0.15);
      color: #fff;
    }
    #${config.containerId} .jav-chip.${config.activeChipClass} {
      background: #fbbf24;
      color: #1e1e2e;
      border-color: #fbbf24;
    }
    .${config.hiddenItemClass} {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
  console.log("[GroupByCode] 🎨 Styles injected");
}

/**
 * Updates visual active state on chips (single-select).
 * @param {HTMLElement} activeChip
 * @param {Object} config
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
 * Creates and mounts the chip panel. First code chip is active by default.
 * @param {Array} groups - Sorted group data
 * @param {Object} config
 */
function renderChipPanel(groups, config) {
  // Remove existing panel if any (idempotent re-render)
  const existing = document.getElementById(config.containerId);
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = config.containerId;

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

  // Insert at top of main content area
  const mainContent = document.querySelector("main") || document.body;
  mainContent.prepend(panel);

  console.log(
    `[GroupByCode] 🏷️ Rendered ${groups.length + 1} chips (including All)`,
  );
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Main function: Extract codes, build chips, filter items.
 * @param {Object} [options={}] - Override default config
 * @param {number} [options.minCount=2] - Min videos per code group
 * @param {number} [options.topN=10] - Max chips to show
 */
function groupByCode(options = {}) {
  console.log("[GroupByCode] ▶️ Starting with options:", options);
  const config = { ...DEFAULT_CONFIG, ...options };

  // Validate sensible defaults
  if (config.minCount < 1) config.minCount = 1;
  if (config.topN < 1) config.topN = 1;

  // Step 1: Extract & aggregate
  const groups = extractGroupedCodes(config);

  if (groups.length === 0) {
    console.warn(
      "[GroupByCode] ⚠️ No groups found matching criteria. Try lowering minCount.",
    );
    alert(
      `[GroupByCode] No code groups found with count >= ${config.minCount}.\nTry: groupByCode({ minCount: 1 })`,
    );
    return;
  }

  // Step 2: Inject UI & apply initial filter (first chip active)
  injectStyles(config);
  renderChipPanel(groups, config);

  console.log("[GroupByCode] ✅ Done!");
}

/**
 * Reset helper: removes all UI and shows all items.
 * Usage: groupByCode.reset()
 */
groupByCode.reset = function () {
  resetAll(DEFAULT_CONFIG);
};

// Auto-log readiness
console.log(
  "[GroupByCode] ✅ Script loaded. Run: groupByCode() | groupByCode({ minCount: 3, topN: 5 }) | groupByCode.reset()",
);
