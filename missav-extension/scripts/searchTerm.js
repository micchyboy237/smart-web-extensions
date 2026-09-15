/**
 * Filters item containers: highlights matches, hides non-matches.
 * @param {string} searchTerm - Case-insensitive search query. Pass '' or null to reset.
 */
function filterSearchContainers(searchTerm) {
  const ACTIVE_CLASS = "search-highlight-active";
  const DIMMED_CLASS = "search-dimmed";
  const ITEM_SELECTOR = ".thumbnail.group";
  const TITLE_SELECTOR = 'a[x-text="item.full_title"], .my-2.text-sm a';

  // --- Inject Styles Once ---
  if (!document.getElementById("search-filter-style")) {
    const style = document.createElement("style");
    style.id = "search-filter-style";
    style.textContent = `
      .${ACTIVE_CLASS} {
        outline: 3px solid #fbbf24 !important;
        outline-offset: 2px;
        border-radius: 0.5rem;
        position: relative;
      }
      .${ACTIVE_CLASS}::after {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(251, 191, 36, 0.12);
        border-radius: inherit;
        pointer-events: none;
        z-index: 10;
      }
      .${DIMMED_CLASS} {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
    console.log("[FilterHighlight] Styles injected.");
  }

  // --- Cleanup ---
  const allItems = document.querySelectorAll(ITEM_SELECTOR);
  allItems.forEach((el) => {
    el.classList.remove(ACTIVE_CLASS, DIMMED_CLASS);
  });

  // --- Empty Search = Show All ---
  if (!searchTerm || !searchTerm.trim()) {
    console.log(
      `[FilterHighlight] Reset. Showing all ${allItems.length} items.`,
    );
    return;
  }

  const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "i");
  console.log(`[FilterHighlight] Filtering: "${searchTerm}" | Regex: ${regex}`);

  // --- Evaluate & Apply ---
  let matchCount = 0;
  let hiddenCount = 0;

  allItems.forEach((container, index) => {
    const titleEl = container.querySelector(TITLE_SELECTOR);
    const titleText = titleEl?.textContent?.trim() || "";

    if (regex.test(titleText)) {
      container.classList.add(ACTIVE_CLASS);
      matchCount++;
      const dvdId =
        container.querySelector("a[alt]")?.getAttribute("alt") ||
        `item-${index}`;
      console.log(`[FilterHighlight] ✅ [${matchCount}] ${dvdId}`);
    } else {
      container.classList.add(DIMMED_CLASS);
      hiddenCount++;
    }
  });

  console.log(
    `[FilterHighlight] Done. ✅ ${matchCount} shown | 🚫 ${hiddenCount} hidden | 📦 ${allItems.length} total`,
  );
}

// ▶️ USAGE EXAMPLES:
// filterSearchContainers('jux-536');
// filterSearchContainers('heyzo-');
// filterSearchContainers('');          // Reset: show everything, no highlights
