/**
 * RAG-Optimized HTML Cleaner
 * Combines DOMPurify sanitization with semantic-aware stripping
 * Based on HtmlRAG research: preserve structure, remove noise
 */
const RAGCleaner = (() => {
  const STRIP_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    "nav",
    "footer",
    "header",
    "aside",
    "template",
    "meta",
    "link",
    "base",
  ]);

  const BASE_KEEP_ATTRS = new Set([
    "href",
    "alt",
    "title",
    "role",
    "aria-label",
    "colspan",
    "rowspan",
    "headers",
  ]);

  // Tags that are inherently meaningful even without text content
  // (e.g., an <img> with alt text, an <a> with href, a <hr> separator)
  const SELF_MEANINGFUL_TAGS = new Set([
    "img",
    "a",
    "hr",
    "br",
    "input",
    "figure",
    "figcaption",
  ]);

  /**
   * Clean HTML string for RAG ingestion
   * @param {string} rawHtml - Raw outerHTML
   * @param {{ includeClassId?: boolean }} [options={}]
   * @returns {{ cleaned: string, textContent: string, metadata: object }}
   */
  function clean(rawHtml, options = {}) {
    const { includeClassId = false } = options;
    console.log(
      `[RAGCleaner] Starting cleanup | includeClassId: ${includeClassId} | input length: ${rawHtml.length}`,
    );

    const allowedAttrs = [...BASE_KEEP_ATTRS];
    const forbiddenAttrs = ["onclick", "onerror", "onload", "style"];

    // Always allow class/id through DOMPurify first; we filter numerics post-parse
    if (includeClassId) {
      allowedAttrs.push("class", "id");
    } else {
      forbiddenAttrs.push("class", "id");
    }

    // Step 1: DOMPurify baseline sanitization
    const purified = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: [..._getAllowedTags()],
      ALLOWED_ATTR: allowedAttrs,
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: [...STRIP_TAGS],
      FORBID_ATTR: forbiddenAttrs,
    });

    // Step 2: Parse into DOM for structural cleanup
    const doc = new DOMParser().parseFromString(purified, "text/html");

    // Step 3: Strip numeric classes/ids when includeClassId is active
    if (includeClassId) {
      _filterNumericClassIds(doc);
    }

    // Step 4: Flatten bare <div> wrappers (no class, id, or semantic attrs)
    _flattenBareDivs(doc);

    // Step 5: Remove hidden/invisible elements
    _removeHiddenElements(doc);

    // Step 6: Prune empty structural wrappers (div/span with no text & no meaningful descendants)
    _pruneEmptyContainers(doc);

    // Step 7: Collapse whitespace in remaining text nodes
    _normalizeWhitespace(doc);

    // Step 8: Extract clean outputs
    let cleanedHtml = doc.body.innerHTML.trim();
    let textContent = doc.body.textContent.replace(/\s+/g, " ").trim();

    // Step 9: Decode HTML entities for RAG-friendly output
    cleanedHtml = _decodeEntities(cleanedHtml);
    textContent = _decodeEntities(textContent);

    const metadata = {
      originalLength: rawHtml.length,
      cleanedLength: cleanedHtml.length,
      reduction: `${((1 - cleanedHtml.length / rawHtml.length) * 100).toFixed(1)}%`,
      hasLinks: doc.querySelectorAll("a[href]").length > 0,
      hasImages: doc.querySelectorAll("img[alt]").length > 0,
      includeClassId,
    };

    console.log("[RAGCleaner] Cleanup complete:", metadata);
    return { cleaned: cleanedHtml, textContent, metadata };
  }

  /**
   * Remove class tokens and id values that contain digits.
   * Numeric identifiers are typically framework-generated hashes or indices
   * that carry no semantic meaning for RAG retrieval.
   */
  function _filterNumericClassIds(doc) {
    const NUMERIC_RE = /\d/;
    let strippedCount = 0;

    // Filter class attributes
    const withClass = doc.body.querySelectorAll("[class]");
    for (const el of withClass) {
      const original = el.getAttribute("class");
      const filtered = original
        .split(/\s+/)
        .filter((token) => token && !NUMERIC_RE.test(token))
        .join(" ");

      if (!filtered) {
        el.removeAttribute("class");
        strippedCount++;
      } else if (filtered !== original) {
        el.setAttribute("class", filtered);
        strippedCount++;
      }
    }

    // Filter id attributes
    const withId = doc.body.querySelectorAll("[id]");
    for (const el of withId) {
      const id = el.getAttribute("id");
      if (NUMERIC_RE.test(id)) {
        el.removeAttribute("id");
        strippedCount++;
      }
    }

    console.log(
      `[RAGCleaner] Numeric class/id filter: stripped ${strippedCount} attribute(s)`,
    );
  }

  /**
   * Unwrap <div> elements that carry no semantic attributes (no class, id,
   * role, aria-*, or data-*). These are pure layout wrappers that add
   * nesting depth without meaning for RAG retrieval.
   * Runs bottom-up in a loop so nested bare divs collapse correctly.
   */
  function _flattenBareDivs(doc) {
    const BARE_ATTR_RE = /^(class|id|role|aria-|data-)/i;
    let flattenedCount = 0;
    let changed = true;

    while (changed) {
      changed = false;
      // Snapshot current divs — live NodeList would mutate during unwrapping
      const divs = [...doc.body.querySelectorAll("div")];

      for (const el of divs) {
        // Check if ANY attribute carries semantic weight
        let hasSemanticAttr = false;
        for (const attr of el.attributes) {
          if (BARE_ATTR_RE.test(attr.name)) {
            hasSemanticAttr = true;
            break;
          }
        }
        if (hasSemanticAttr) continue;

        // Unwrap: move all child nodes into parent, then remove the div
        const parent = el.parentNode;
        if (!parent) continue; // detached node, skip

        while (el.firstChild) {
          parent.insertBefore(el.firstChild, el);
        }
        el.remove();
        flattenedCount++;
        changed = true;
      }
    }

    console.log(
      `[RAGCleaner] Bare div flattener: unwrapped ${flattenedCount} container(s)`,
    );
  }

  /**
   * Remove div/span elements that have no text content AND no self-meaningful
   * descendants. Preserves containers that wrap actual content.
   * Runs bottom-up so nested empties collapse correctly.
   */
  function _pruneEmptyContainers(doc) {
    const PRUNE_CANDIDATES = new Set(["div", "span"]);
    let changed = true;

    // Iterate until stable — removing a child may make its parent empty
    while (changed) {
      changed = false;
      const candidates = doc.body.querySelectorAll("div, span");

      for (const el of candidates) {
        if (!PRUNE_CANDIDATES.has(el.tagName.toLowerCase())) continue;

        const hasText = el.textContent.trim().length > 0;
        const hasMeaningfulDescendant = el.querySelector(
          [...SELF_MEANINGFUL_TAGS].map((t) => t).join(", "),
        );

        if (!hasText && !hasMeaningfulDescendant) {
          // If the element has children, unwrap them into the parent
          // to avoid losing non-empty siblings that were nested inside
          const parent = el.parentNode;
          while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
          }
          el.remove();
          changed = true;
        }
      }
    }
  }

  /**
   * Decode HTML entities using the browser's built-in parser.
   */
  function _decodeEntities(str) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = str;
    return textarea.value;
  }

  function _getAllowedTags() {
    return [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
      "img",
      "figure",
      "figcaption",
      "blockquote",
      "pre",
      "code",
      "em",
      "strong",
      "article",
      "section",
      "main",
      "details",
      "summary",
      "div",
      "span",
    ];
  }

  function _removeHiddenElements(doc) {
    const hidden = doc.querySelectorAll(
      '[aria-hidden="true"], [hidden], .sr-only, .visually-hidden',
    );
    hidden.forEach((el) => el.remove());
  }

  function _normalizeWhitespace(doc) {
    const walker = document.createTreeWalker(
      doc.body,
      NodeFilter.SHOW_TEXT,
      null,
    );
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => {
      node.textContent = node.textContent.replace(/\s+/g, " ");
    });
  }

  return { clean };
})();
