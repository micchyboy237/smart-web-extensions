// utils.js — Shared JAV ID extraction and URL utilities
// Used by: content.js, popup.js, and any other extension context.

/**
 * Extracts videoId, code, and episode from a JAV URL or text.
 *
 * Supported formats:
 *   With hyphen:
 *     - "mxgs-893"              → videoId: "mxgs-893",    code: "mxgs",  episode: "893"
 *     - "juq-373-uncensored"    → videoId: "juq-373-uncensored", code: "juq", episode: "373"
 *     - "fc2-ppv-4909847"       → videoId: "fc2-ppv-4909847",   code: "fc2-ppv", episode: "4909847"
 *   Without hyphen:
 *     - "mcs0261"               → videoId: "mcs0261",     code: "mcs",   episode: "0261"
 *     - "abp123"                → videoId: "abp123",      code: "abp",   episode: "123"
 *     - "1pondo456"             → videoId: "1pondo456",   code: "1pondo", episode: "456"
 *     - "heyzo1234"             → videoId: "heyzo1234",   code: "heyzo", episode: "1234"
 *     - "carib5678"             → videoId: "carib5678",   code: "carib", episode: "5678"
 *
 * @param {string} url  - The full URL to parse
 * @param {string} text - Fallback text if URL doesn't contain a match
 * @returns {{ videoId: string|null, code: string|null, episode: string|null }}
 */
function extractJavInfo(url, text) {
  console.log("[UTILS] 🔍 extractJavInfo called");
  console.log("  URL:", url);
  console.log("  text:", text);

  // ---------------------------------------------------------
  // Pattern 1: Three-part codes with hyphens + optional suffix
  // Examples: fc2-ppv-4909847, fc2-ppv-4909847-uncensored
  // ---------------------------------------------------------
  const threePartWithSuffix = /\b([a-z]+\d*-[a-z]+)-(\d+)(-[a-z0-9-]+)?\b/i;

  // ---------------------------------------------------------
  // Pattern 2: Two-part codes with hyphens + optional suffix
  // Examples: mxgs-893, juq-373, juq-373-uncensored-leak, club-914
  // ---------------------------------------------------------
  const twoPartWithSuffix = /\b([a-z0-9]+)-(\d+)(-[a-z0-9-]+)?\b/i;

  // ---------------------------------------------------------
  // Pattern 3: Letters followed by digits (NO hyphen)
  // Examples: mcs0261, abp123, heyzo1234, carib5678
  // ---------------------------------------------------------
  const lettersThenDigits = /\b([a-z]+)(\d{3,6})\b/i;

  // ---------------------------------------------------------
  // Pattern 4: Digits then letters (NO hyphen)
  // Examples: 1pondo456
  // ---------------------------------------------------------
  const digitsThenLetters = /\b(\d+[a-z]+)(\d{3,6})\b/i;

  let match = null;
  let patternUsed = "";

  // --- Try URL first ---
  match = url.match(threePartWithSuffix);
  if (match) patternUsed = "threePartWithSuffix (URL)";

  if (!match) {
    match = url.match(twoPartWithSuffix);
    if (match) patternUsed = "twoPartWithSuffix (URL)";
  }
  if (!match) {
    match = url.match(lettersThenDigits);
    if (match) patternUsed = "lettersThenDigits (URL)";
  }
  if (!match) {
    match = url.match(digitsThenLetters);
    if (match) patternUsed = "digitsThenLetters (URL)";
  }

  // --- Text fallback ---
  if (!match && text) {
    match =
      text.match(threePartWithSuffix) ||
      text.match(twoPartWithSuffix) ||
      text.match(lettersThenDigits) ||
      text.match(digitsThenLetters);
    if (match) patternUsed = "text fallback";
  }

  // --- Build result ---
  if (match) {
    let videoId, code, episode;

    if (patternUsed.includes("threePart") || patternUsed.includes("twoPart")) {
      videoId = match[0].toLowerCase();
      code = match[1].toLowerCase();
      episode = match[2];
    } else if (patternUsed.includes("lettersThenDigits")) {
      videoId = match[0].toLowerCase();
      code = match[1].toLowerCase();
      episode = match[2];
    } else if (patternUsed.includes("digitsThenLetters")) {
      videoId = match[0].toLowerCase();
      code = match[1].toLowerCase();
      episode = match[2];
    } else {
      videoId = match[0].toLowerCase();
      code = match[1] ? match[1].toLowerCase() : null;
      episode = match[2] || null;
    }

    console.log(`  ✅ Match via ${patternUsed}:`, match[0]);
    console.log(
      "  📦 Result -> videoId:",
      videoId,
      "| code:",
      code,
      "| episode:",
      episode,
    );
    return { videoId, code, episode };
  }

  console.log("  ⚠️ No match found for any pattern");
  return { videoId: null, code: null, episode: null };
}

/**
 * Detect video ID from a MissAV page URL.
 * Uses extractJavInfo first, then falls back to MissAV-specific URL patterns.
 *
 * @param {string} url - The full page URL
 * @returns {string|null} The video ID, or null if not a video page
 */
function detectVideoIdFromUrl(url) {
  if (!url) return null;

  console.log("[UTILS] 🔍 detectVideoIdFromUrl:", url);

  if (!url.includes("missav.ws") && !url.includes("missav.com")) {
    console.log("[UTILS] ⏭️ Not a MissAV URL");
    return null;
  }

  // Try extractJavInfo first (handles most patterns)
  const javInfo = extractJavInfo(url, null);
  if (javInfo.videoId) {
    console.log("[UTILS] ✅ Detected via extractJavInfo:", javInfo.videoId);
    return javInfo.videoId;
  }

  // Fallback patterns specific to MissAV URL structure
  const patterns = [
    /\/(?:en|ja|zh|ko|th)\/([a-z0-9]+-\d+(?:-[a-z0-9]+)*)/i,
    /\/dm\d+\/(?:en|ja|zh|ko|th)\/([a-z0-9]+-\d+(?:-[a-z0-9]+)*)/i,
    /\/([a-z0-9]+-\d+(?:-[a-z0-9]+)*)(?:\/|$|\?|#)/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      const videoId = match[1].toLowerCase();
      console.log("[UTILS] ✅ Detected via fallback pattern:", videoId);
      return videoId;
    }
  }

  console.log("[UTILS] ⚠️ No video ID detected");
  return null;
}

console.log("[UTILS] ✅ utils.js loaded");

/**
 * Generates a stable, deterministic ID from a URL.
 * Same URL always returns the exact same ID.
 * DIFFERENT URLs with same videoId will generate DIFFERENT IDs.
 *
 * @param {string} url - The full URL
 * @param {string} videoId - Optional videoId extracted from the URL
 * @returns {string} Generated hash ID like "jav-abc123"
 */
function generateIdFromUrl(url, videoId) {
  if (!url && !videoId) {
    const fallbackId = "unknown-" + Date.now();
    console.log(
      "[UTILS] ⚠️ generateIdFromUrl: no url or videoId, fallback:",
      fallbackId,
    );
    return fallbackId;
  }
  const input = url || videoId;
  try {
    let normalized;
    if (url) {
      try {
        const urlObj = new URL(url);
        normalized = urlObj.origin + urlObj.pathname;
      } catch (e) {
        normalized = url;
      }
    } else {
      normalized = videoId;
    }
    // FNV-1a hash (32-bit) for consistent, unique IDs
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    const generatedId = "jav-" + hash.toString(36);
    console.log("[UTILS] 🔑 generateIdFromUrl:", input, "→", generatedId);
    return generatedId;
  } catch (e) {
    const fallback =
      "jav-" +
      btoa(input)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 16);
    console.log("[UTILS] ⚠️ generateIdFromUrl fallback:", input, "→", fallback);
    return fallback;
  }
}

/**
 * Detect the database-ready ID (hashed) from a MissAV page URL.
 * This returns the same ID that's saved as the unique key in ChromaDB.
 *
 * @param {string} url - The full page URL
 * @returns {string|null} The hashed DB ID (e.g., "jav-abc123"), or null
 */
function detectDbIdFromUrl(url) {
  if (!url) return null;

  console.log("[UTILS] 🔍 detectDbIdFromUrl:", url);

  if (!url.includes("missav.ws") && !url.includes("missav.com")) {
    console.log("[UTILS] ⏭️ Not a MissAV URL");
    return null;
  }

  const javInfo = extractJavInfo(url, null);
  if (!javInfo.videoId) {
    console.log("[UTILS] ⚠️ No video ID extracted from URL");
    return null;
  }

  // Generate the same hashed ID that content.js saves to the DB
  const dbId = generateIdFromUrl(url, javInfo.videoId);
  console.log(
    "[UTILS] ✅ DB ID detected:",
    dbId,
    "(videoId:",
    javInfo.videoId + ")",
  );
  return dbId;
}
