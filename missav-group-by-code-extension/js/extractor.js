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
  console.log("[GroupByCode] 🔍 Extracting grouped codes...");
  const items = document.querySelectorAll(config.itemSelector);
  console.log(
    `[GroupByCode] Found ${items.length} items with selector: ${config.itemSelector}`,
  );

  const codeMap = new Map();
  const seenHrefs = new Set(); // Track unique video URLs to avoid duplicates
  let skipped = 0;

  items.forEach((item, idx) => {
    const videoAnchor = item.querySelector(config.videoAnchorSelector);
    if (!videoAnchor) {
      skipped++;
      if (idx < 3)
        console.log(`[GroupByCode] ⚠️ Item ${idx}: No video anchor found`);
      return;
    }

    // Check if we've already processed this video URL
    const href = videoAnchor.href || "";
    if (seenHrefs.has(href)) {
      skipped++;
      // Optional: log duplicates if needed for debugging
      // if (idx < 5) console.log(`[GroupByCode] ⚠️ Item ${idx}: Duplicate href detected, skipping`);
      return;
    }
    seenHrefs.add(href);

    const rawAlt = videoAnchor.getAttribute(config.altAttr);
    const code = extractCode(rawAlt);
    if (!code) {
      skipped++;
      if (idx < 3)
        console.log(
          `[GroupByCode] ⚠️ Item ${idx}: No code extracted from alt="${rawAlt}"`,
        );
      return;
    }

    if (!codeMap.has(code)) {
      codeMap.set(code, { code, count: 0, urls: [], elements: [] });
    }
    const entry = codeMap.get(code);
    entry.count++;
    entry.urls.push(href);
    entry.elements.push(item);
  });

  console.log(
    `[GroupByCode] Skipped ${skipped} items, found ${codeMap.size} unique codes`,
  );

  // REMOVED: .slice(0, config.topN) to include ALL groups
  const result = Array.from(codeMap.values())
    .filter((g) => g.count >= config.minCount)
    .sort((a, b) => b.count - a.count);

  console.log(`[GroupByCode] ✅ Extracted ${result.length} groups (ALL)`);
  // Optional: Log top 10 for brevity in console
  result.slice(0, 10).forEach((g) => {
    console.log(`[GroupByCode]   - ${g.code.toUpperCase()}: ${g.count} items`);
  });

  return { groups: result, totalItems: items.length };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractCode, extractGroupedCodes };
}
