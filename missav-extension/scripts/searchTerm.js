/**
 * Highlights matching item CONTAINERS based on title search.
 * @param {string} searchTerm - Case-insensitive search query.
 */
function highlightSearchContainers(searchTerm) {
  const ACTIVE_CLASS = "search-highlight-active";
  const ITEM_SELECTOR = ".thumbnail.group";
  const TITLE_SELECTOR = 'a[x-text="item.full_title"], .my-2.text-sm a';

  // --- Inject Styles Once ---
  if (!document.getElementById("search-highlight-style")) {
    const style = document.createElement("style");
    style.id = "search-highlight-style";
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
    `;
    document.head.appendChild(style);
    console.log("[ContainerHighlight] Styles injected.");
  }

  // --- Cleanup ---
  const previouslyHighlighted = document.querySelectorAll(`.${ACTIVE_CLASS}`);
  previouslyHighlighted.forEach((el) => el.classList.remove(ACTIVE_CLASS));
  if (previouslyHighlighted.length > 0) {
    console.log(
      `[ContainerHighlight] Cleared ${previouslyHighlighted.length} previous highlights.`,
    );
  }

  // --- Validate ---
  if (!searchTerm || !searchTerm.trim()) {
    console.warn("[ContainerHighlight] Empty search term. Cleanup only.");
    return;
  }

  const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "i");
  console.log(
    `[ContainerHighlight] Searching: "${searchTerm}" | Regex: ${regex}`,
  );

  // --- Match & Highlight Containers ---
  const items = document.querySelectorAll(ITEM_SELECTOR);
  let matchCount = 0;

  items.forEach((container, index) => {
    const titleEl = container.querySelector(TITLE_SELECTOR);
    if (!titleEl) return;

    const titleText = titleEl.textContent?.trim() || "";
    if (!regex.test(titleText)) return;

    container.classList.add(ACTIVE_CLASS);
    matchCount++;

    const dvdId =
      container.querySelector("a[alt]")?.getAttribute("alt") || `item-${index}`;
    console.log(
      `[ContainerHighlight] ✅ [${matchCount}] ${dvdId} — "${titleText.substring(0, 80)}..."`,
    );
  });

  console.log(
    `[ContainerHighlight] Done. ${matchCount}/${items.length} containers highlighted.`,
  );
}

// ▶️ USAGE: Replace with your search term
highlightSearchContainers("heyzo");
