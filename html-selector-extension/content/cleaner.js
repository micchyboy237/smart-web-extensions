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

    // Always allow class/id/data-* through DOMPurify first; we filter numerics post-parse
    if (includeClassId) {
      allowedAttrs.push("class", "id");
    } else {
      forbiddenAttrs.push("class", "id");
    }

    // Step 1: DOMPurify baseline sanitization
    const purified = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: [..._getAllowedTags()],
      ALLOWED_ATTR: allowedAttrs,
      ALLOW_DATA_ATTR: true, // Allow data-* through; filtered post-parse for non-semantic values
      FORBID_TAGS: [...STRIP_TAGS],
      FORBID_ATTR: forbiddenAttrs,
    });

    // Step 2: Parse into DOM for structural cleanup
    const doc = new DOMParser().parseFromString(purified, "text/html");

    // Step 3: Strip numeric classes/ids when includeClassId is active
    if (includeClassId) {
      _filterNumericClassIds(doc);
    }

    // Step 4: Strip non-semantic data-* attributes (numeric names or JSON values)
    _filterNonSemanticDataAttrs(doc);

    // Step 5: Flatten redundant same-tag wrappers with no class/id and no immediate text
    _flattenRedundantWrappers(doc);

    // Step 6: Remove hidden/invisible elements
    _removeHiddenElements(doc);

    // Step 7: Prune empty structural wrappers (div/span with no text & no meaningful descendants)
    _pruneEmptyContainers(doc);

    // Step 8: Collapse whitespace in remaining text nodes
    _normalizeWhitespace(doc);

    // Step 9: Extract clean outputs
    let cleanedHtml = doc.body.innerHTML.trim();
    let textContent = doc.body.textContent.replace(/\s+/g, " ").trim();

    // Step 10: Decode HTML entities for RAG-friendly output
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
   * Remove data-* attributes that carry no semantic value for RAG:
   * 1. Attribute names containing digits (e.g., data-id-482, data-index-3)
   * 2. Attribute values that look like JSON (start with { or [)
   * Single pass over all elements for efficiency.
   */
  function _filterNonSemanticDataAttrs(doc) {
    const NUMERIC_NAME_RE = /\d/;
    const JSON_VALUE_RE = /^\s*[{[]/;
    let strippedCount = 0;

    const allElements = doc.body.querySelectorAll("*");
    for (const el of allElements) {
      // Collect attrs to remove first to avoid mutating during iteration
      const attrsToRemove = [];
      for (const attr of el.attributes) {
        if (!attr.name.startsWith("data-")) continue;

        // Reason 1: Numeric name → framework-generated index/hash
        if (NUMERIC_NAME_RE.test(attr.name)) {
          attrsToRemove.push(attr.name);
          continue;
        }

        // Reason 2: JSON value → serialized app state, not semantic content
        if (JSON_VALUE_RE.test(attr.value)) {
          attrsToRemove.push(attr.name);
        }
      }

      for (const attrName of attrsToRemove) {
        el.removeAttribute(attrName);
        strippedCount++;
      }
    }

    console.log(
      `[RAGCleaner] Non-semantic data-attr filter: stripped ${strippedCount} attribute(s)`,
    );
  }

  /**
   * Flatten elements that are pure structural wrappers:
   * - No class, no id
   * - No immediate non-whitespace text nodes
   * - Either parent shares the same tag, OR all element children share the same tag
   *   (catches nested same-tag chains where innermost has text)
   * Runs iteratively so deeply nested chains collapse fully.
   */
  function _flattenRedundantWrappers(doc) {
    let flattenedCount = 0;
    let changed = true;

    while (changed) {
      changed = false;
      const elements = [...doc.body.querySelectorAll("*")];

      for (const el of elements) {
        const parent = el.parentElement;
        if (!parent || parent === doc.body) continue;

        // Gate: must have no class and no id
        if (el.hasAttribute("class") || el.hasAttribute("id")) continue;

        // Gate: must have no immediate non-whitespace text node
        let hasImmediateText = false;
        for (const child of el.childNodes) {
          if (
            child.nodeType === Node.TEXT_NODE &&
            child.textContent.trim().length > 0
          ) {
            hasImmediateText = true;
            break;
          }
        }
        if (hasImmediateText) continue;

        // Condition A: Parent is the same tag (original behavior)
        const parentSameTag = el.tagName === parent.tagName;

        // Condition B: All element children share this element's tag
        // Catches <span><span>text</span></span> where outer qualifies
        let allChildrenSameTag = false;
        if (!parentSameTag) {
          const elementChildren = [...el.children];
          if (elementChildren.length > 0) {
            allChildrenSameTag = elementChildren.every(
              (child) => child.tagName === el.tagName,
            );
          }
        }

        if (!parentSameTag && !allChildrenSameTag) continue;

        // Unwrap into parent
        while (el.firstChild) {
          parent.insertBefore(el.firstChild, el);
        }
        el.remove();
        flattenedCount++;
        changed = true;
      }
    }

    console.log(
      `[RAGCleaner] Redundant wrapper flattener: unwrapped ${flattenedCount} element(s)`,
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
