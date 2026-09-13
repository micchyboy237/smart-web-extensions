/**
 * RAG-Optimized HTML Cleaner
 * Combines DOMPurify sanitization with semantic-aware stripping
 * Based on HtmlRAG research: preserve structure, remove noise
 */
const RAGCleaner = (() => {
  // Elements that add zero retrieval value
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

  // Attributes worth keeping for RAG context
  const KEEP_ATTRS = new Set([
    "href",
    "alt",
    "title",
    "role",
    "aria-label",
    "colspan",
    "rowspan",
    "headers",
  ]);

  /**
   * Clean HTML string for RAG ingestion
   * @param {string} rawHtml - Raw outerHTML
   * @returns {{ cleaned: string, textContent: string, metadata: object }}
   */
  function clean(rawHtml) {
    console.log("[RAGCleaner] Starting cleanup, input length:", rawHtml.length);

    // Step 1: DOMPurify baseline sanitization (XSS protection)
    const purified = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: [..._getAllowedTags()],
      ALLOWED_ATTR: [...KEEP_ATTRS],
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: [...STRIP_TAGS],
      FORBID_ATTR: ["onclick", "onerror", "onload", "style", "class", "id"],
    });

    // Step 2: Parse into DOM for structural cleanup
    const doc = new DOMParser().parseFromString(purified, "text/html");

    // Step 3: Remove hidden/invisible elements
    _removeHiddenElements(doc);

    // Step 4: Collapse whitespace in text nodes
    _normalizeWhitespace(doc);

    // Step 5: Extract clean outputs
    const cleanedHtml = doc.body.innerHTML.trim();
    const textContent = doc.body.textContent.replace(/\s+/g, " ").trim();

    const metadata = {
      originalLength: rawHtml.length,
      cleanedLength: cleanedHtml.length,
      reduction: `${((1 - cleanedHtml.length / rawHtml.length) * 100).toFixed(1)}%`,
      hasLinks: doc.querySelectorAll("a[href]").length > 0,
      hasImages: doc.querySelectorAll("img[alt]").length > 0,
    };

    console.log("[RAGCleaner] Cleanup complete:", metadata);
    return { cleaned: cleanedHtml, textContent, metadata };
  }

  function _getAllowedTags() {
    // Semantic tags valuable for RAG chunking
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
