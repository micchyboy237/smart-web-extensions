/**
 * Minimal, dependency-free HTML pretty-printer.
 * Good enough for the small semantic tag set RAGCleaner outputs — no need
 * to pull in a full formatting library for this.
 */
const Prettify = (() => {
  const VOID_TAGS = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);

  function html(rawHtml, indent = "  ") {
    const tokens = rawHtml.split(/(<[^>]+>)/g).filter((t) => t.trim() !== "");
    let depth = 0;
    const lines = [];

    for (const token of tokens) {
      if (token.startsWith("</")) {
        depth = Math.max(0, depth - 1);
        lines.push(indent.repeat(depth) + token);
        continue;
      }
      if (token.startsWith("<")) {
        const tagName = (token.match(/^<([a-zA-Z0-9-]+)/) ||
          [])[1]?.toLowerCase();
        const selfClosing = token.endsWith("/>") || VOID_TAGS.has(tagName);
        lines.push(indent.repeat(depth) + token);
        if (!selfClosing) depth += 1;
        continue;
      }
      const text = token.trim();
      if (text) lines.push(indent.repeat(depth) + text);
    }
    return lines.join("\n");
  }

  return { html };
})();
