/**
 * Filters item containers: highlights matches, hides non-matches.
 * @param {string} [searchTerm] - Case-insensitive primary search. Pass nothing, '' or null to reset.
 * @param {string[]} [filters=[]] - Optional array of additional AND conditions applied to matching results.
 */
function filterSearchContainers(searchTerm, filters = []) {
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
  allItems.forEach((el) => el.classList.remove(ACTIVE_CLASS, DIMMED_CLASS));

  // --- Empty Search = Show All (filters ignored during reset) ---
  if (!searchTerm || !searchTerm.trim()) {
    console.log(
      `[FilterHighlight] Reset. Showing all ${allItems.length} items.`,
    );
    return;
  }

  // --- Build Regexes ---
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const primaryRegex = new RegExp(escapeRegex(searchTerm), "i");

  const validFilters = Array.isArray(filters)
    ? filters.filter((f) => typeof f === "string" && f.trim() !== "")
    : [];
  const filterRegexes = validFilters.map((f) => ({
    term: f,
    regex: new RegExp(escapeRegex(f), "i"),
  }));

  console.log(
    `[FilterHighlight] Primary: "${searchTerm}" | Secondary filters (${filterRegexes.length}): [${validFilters.map((f) => `"${f}"`).join(", ")}]`,
  );

  // --- Evaluate & Apply ---
  let matchCount = 0;
  let hiddenCount = 0;

  allItems.forEach((container, index) => {
    const titleEl = container.querySelector(TITLE_SELECTOR);
    const titleText = titleEl?.textContent?.trim() || "";

    // Primary check first (short-circuit)
    if (!primaryRegex.test(titleText)) {
      container.classList.add(DIMMED_CLASS);
      hiddenCount++;
      return;
    }

    // Secondary filters: ALL must match (AND logic)
    const failedFilters = filterRegexes.filter(
      ({ regex }) => !regex.test(titleText),
    );

    if (failedFilters.length > 0) {
      container.classList.add(DIMMED_CLASS);
      hiddenCount++;
      return;
    }

    // ✅ Passed all checks
    container.classList.add(ACTIVE_CLASS);
    matchCount++;

    const dvdId =
      container.querySelector("a[alt]")?.getAttribute("alt") || `item-${index}`;
    const filterInfo =
      filterRegexes.length > 0
        ? ` | Filters passed: [${validFilters.join(", ")}]`
        : "";
    console.log(`[FilterHighlight] ✅ [${matchCount}] ${dvdId}${filterInfo}`);
  });

  console.log(
    `[FilterHighlight] Done. ✅ ${matchCount} shown | 🚫 ${hiddenCount} hidden | 📦 ${allItems.length} total`,
  );
}

// ▶️ USAGE EXAMPLES:
// filterSearchContainers('younger men', ['jux-', 'wife']);  // Primary + AND filters
// filterSearchContainers('cuckold', ['uncensored']);          // Primary + single filter
// filterSearchContainers('jux-');                            // Primary only
// filterSearchContainers();                                   // Reset: show everything
