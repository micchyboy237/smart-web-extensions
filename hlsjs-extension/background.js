/**
 * background.js - Service Worker for CORS Bypass & Request Monitoring
 *
 * Uses chrome.declarativeNetRequest (with fallback) to inject CORS headers
 * into HLS stream responses that lack them.
 * Uses chrome.webRequest for monitoring and stats.
 */

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  hlsExtensions: [
    ".m3u8",
    ".ts",
    ".m4s",
    ".m4a",
    ".m4v",
    ".mp4",
    ".aac",
    ".vtt",
  ],

  stats: {
    requestsIntercepted: 0,
    corsHeadersAdded: 0,
    errorsPrevented: 0,
    activeStreams: new Set(),
    requestHistory: [],
  },
};

// ============================================================================
// API Availability Check
// ============================================================================

const dnrAvailable =
  typeof chrome !== "undefined" &&
  chrome.declarativeNetRequest &&
  typeof chrome.declarativeNetRequest.getDynamicRules === "function";

console.log(
  `[Background] declarativeNetRequest API available: ${dnrAvailable}`,
);

if (!dnrAvailable) {
  console.warn(
    "[Background] ⚠️ declarativeNetRequest not available. CORS auto-fix disabled.",
  );
  console.warn(
    '[Background] ℹ️  Add "declarativeNetRequest" to manifest permissions if needed.',
  );
  console.warn("[Background] ℹ️  WebRequest monitoring is still active.");
}

// ============================================================================
// CORS Rule Management (only if DNR is available)
// ============================================================================

let ruleIdCounter = 1;
const activeCorsRules = new Map();

/**
 * Check if DNR API is ready before any operation
 */
function isDnrReady() {
  if (!dnrAvailable) {
    console.debug("[Background] DNR API not available - skipping operation");
    return false;
  }
  return true;
}

/**
 * Get active CORS rules (safe)
 */
async function getActiveCorsRules() {
  if (!isDnrReady()) {
    return { totalRules: 0, domains: [], rules: [], dnrAvailable: false };
  }

  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return {
      totalRules: rules.length,
      domains: Array.from(activeCorsRules.keys()),
      rules: rules.map((r) => ({
        id: r.id,
        urlFilter: r.condition?.urlFilter || "unknown",
      })),
      dnrAvailable: true,
    };
  } catch (error) {
    console.error("[Background] Failed to get dynamic rules:", error.message);
    return {
      totalRules: 0,
      domains: [],
      rules: [],
      dnrAvailable: true,
      error: error.message,
    };
  }
}

/**
 * Add a CORS bypass rule for a specific domain
 */
async function addCorsRuleForDomain(domain) {
  if (!isDnrReady()) {
    console.warn(
      `[Background] Cannot add CORS rule for ${domain}: DNR API not available`,
    );
    return false;
  }

  if (activeCorsRules.has(domain)) {
    console.log(`[Background] CORS rule already exists for: ${domain}`);
    return true;
  }

  const newRuleIds = [];
  const patterns = [
    `*://${domain}/*.m3u8*`,
    `*://${domain}/*.ts*`,
    `*://${domain}/*.m4s*`,
    `*://${domain}/*.m4a*`,
    `*://${domain}/*.mp4*`,
    `*://${domain}/*.m4v*`,
    `*://${domain}/*.aac*`,
    `*://${domain}/*.vtt*`,
  ];

  const rules = patterns.map((pattern) => ({
    id: ruleIdCounter++,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
        {
          header: "Access-Control-Allow-Methods",
          operation: "set",
          value: "GET, OPTIONS",
        },
        {
          header: "Access-Control-Allow-Headers",
          operation: "set",
          value: "*",
        },
        {
          header: "Cross-Origin-Resource-Policy",
          operation: "set",
          value: "cross-origin",
        },
      ],
    },
    condition: {
      urlFilter: pattern,
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  }));

  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = new Set(existingRules.map((r) => r.id));
    const newRules = rules.filter((r) => !existingIds.has(r.id));

    if (newRules.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: newRules,
      });

      newRuleIds.push(...newRules.map((r) => r.id));
      activeCorsRules.set(domain, newRuleIds);

      console.log(
        `[Background] ✅ Added ${newRules.length} CORS rules for: ${domain}`,
      );
      return true;
    }
    return true;
  } catch (error) {
    console.error(
      `[Background] ❌ Failed to add CORS rules for ${domain}:`,
      error.message,
    );
    return false;
  }
}

// ============================================================================
// webRequest: onHeadersReceived (MONITOR)
// ============================================================================

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    const { url, type } = details;

    if (!isHlsResource(url)) return;

    const domain = getDomain(url);
    const existingHeaders = details.responseHeaders || [];

    const hasCORS = existingHeaders.some(
      (h) => h.name.toLowerCase() === "access-control-allow-origin",
    );

    CONFIG.stats.requestsIntercepted++;

    // Log every 10th request to avoid spam
    if (CONFIG.stats.requestsIntercepted % 10 === 0 || !hasCORS) {
      console.log(
        `[Background] 🎯 HLS response: ${domain} | CORS: ${hasCORS ? "✅" : "❌"} | Status: ${details.statusCode}`,
      );
    }

    // If missing CORS headers, try to add DNR rule
    if (!hasCORS && !activeCorsRules.has(domain)) {
      CONFIG.stats.corsHeadersAdded++;
      console.log(
        `[Background] ⚠️ Missing CORS: ${domain} | Auto-fix: ${dnrAvailable ? "Attempting..." : "Unavailable"}`,
      );

      if (dnrAvailable) {
        const added = await addCorsRuleForDomain(domain);
        console.log(
          `[Background] ${added ? "✅" : "❌"} Rule added for: ${domain}`,
        );
      } else {
        console.log(
          `[Background] ℹ️  Stream from ${domain} may have CORS issues in browser`,
        );
        console.log(`[Background] ℹ️  Use a CORS-enabled stream or CORS proxy`);
      }
    }

    // Track stream URLs
    if (url.endsWith(".m3u8")) {
      CONFIG.stats.activeStreams.add(domain);
      CONFIG.stats.requestHistory.push({
        timestamp: Date.now(),
        url: url,
        type: type,
        domain: domain,
        hasCORS,
      });

      // Trim history
      while (CONFIG.stats.requestHistory.length > 100) {
        CONFIG.stats.requestHistory.shift();
      }
    }
  },
  {
    urls: ["https://*/*", "http://*/*"],
    types: ["xmlhttprequest", "media", "other"],
  },
  ["responseHeaders", "extraHeaders"],
);

// ============================================================================
// webRequest: onCompleted & onErrorOccurred
// ============================================================================

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!isHlsResource(details.url)) return;
    // Silent tracking - no log spam
  },
  {
    urls: ["https://*/*", "http://*/*"],
    types: ["xmlhttprequest", "media", "other"],
  },
  ["responseHeaders", "extraHeaders"],
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!isHlsResource(details.url)) return;

    const domain = getDomain(details.url);
    CONFIG.stats.errorsPrevented++;

    console.error(`[Background] ❌ HLS error: ${domain} | ${details.error}`);
  },
  {
    urls: ["https://*/*", "http://*/*"],
    types: ["xmlhttprequest", "media", "other"],
  },
  ["extraHeaders"],
);

// ============================================================================
// Message Handling
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case "getStats":
      handleGetStats(sendResponse);
      break;
    case "addCorsRule":
      handleAddCorsRule(message.domain, sendResponse);
      break;
    case "getCorsRules":
      handleGetCorsRules(sendResponse);
      break;
    case "checkUrl":
      handleCheckUrl(message.url, sendResponse);
      break;
    default:
      sendResponse({
        success: false,
        error: `Unknown action: ${message.action}`,
      });
  }
  return true;
});

async function handleGetStats(sendResponse) {
  let corsRules = {
    totalRules: 0,
    domains: [],
    rules: [],
    dnrAvailable: false,
  };

  if (dnrAvailable) {
    corsRules = await getActiveCorsRules();
  }

  sendResponse({
    success: true,
    stats: {
      requestsIntercepted: CONFIG.stats.requestsIntercepted,
      corsHeadersAdded: CONFIG.stats.corsHeadersAdded,
      errorsPrevented: CONFIG.stats.errorsPrevented,
      activeStreams: Array.from(CONFIG.stats.activeStreams),
      recentRequests: CONFIG.stats.requestHistory.slice(-20),
      corsRules: corsRules,
      dnrAvailable: dnrAvailable,
    },
  });
}

async function handleAddCorsRule(domain, sendResponse) {
  if (!dnrAvailable) {
    sendResponse({
      success: false,
      error: "declarativeNetRequest API not available",
    });
    return;
  }

  const result = await addCorsRuleForDomain(domain);
  sendResponse({ success: result, domain });
}

async function handleGetCorsRules(sendResponse) {
  if (!dnrAvailable) {
    sendResponse({
      success: false,
      error: "declarativeNetRequest API not available",
    });
    return;
  }

  const rules = await getActiveCorsRules();
  sendResponse({ success: true, rules });
}

async function handleCheckUrl(url, sendResponse) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      mode: "cors",
      cache: "no-cache",
    });

    sendResponse({
      success: true,
      hasCORS: !!response.headers.get("Access-Control-Allow-Origin"),
      status: response.status,
    });
  } catch (error) {
    sendResponse({
      success: false,
      hasCORS: false,
      error: error.message,
    });
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function isHlsResource(url) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return CONFIG.hlsExtensions.some((ext) => lowerUrl.includes(ext));
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[Background] 🚀 Extension ${details.reason}`);
  console.log(
    `[Background] DNR API: ${dnrAvailable ? "✅ Available" : "❌ Not available"}`,
  );

  // Clear stale rules only if DNR is available
  if (dnrAvailable) {
    try {
      const existingRules =
        await chrome.declarativeNetRequest.getDynamicRules();
      if (existingRules.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: existingRules.map((r) => r.id),
        });
        console.log(
          `[Background] 🧹 Cleared ${existingRules.length} stale CORS rules`,
        );
      }
    } catch (error) {
      console.error("[Background] Failed to clear stale rules:", error.message);
    }
  }

  activeCorsRules.clear();
  ruleIdCounter = 1;
});

console.log(`[Background] ⚡ Service worker started`);
console.log(`[Background] 📡 Monitoring: Active`);
console.log(
  `[Background] 🔧 Auto-fix CORS: ${dnrAvailable ? "✅ Ready" : "❌ Unavailable (add declarativeNetRequest permission)"}`,
);
