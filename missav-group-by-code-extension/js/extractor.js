/**
 * extractor.js - Code Extraction Logic
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

function extractGroupedCodes(config) {
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

  const result = Array.from(codeMap.values())
    .filter((g) => g.count >= config.minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, config.topN);

  return { groups: result, totalItems: items.length };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractCode, extractGroupedCodes };
}
