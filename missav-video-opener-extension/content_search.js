// Jet_Apps/web-extensions/smart-web-extensions/missav-video-opener-extension/content_search.js
(function () {
  "use strict";
  // --- GUARD CLAUSE ---
  if (!window.location.pathname.includes("/en/search/")) {
    return;
  }
  const LOG_PREFIX = "[MissAV-Content]";
  const DEBUG = true;
  function log(...args) {
    if (DEBUG) console.log(LOG_PREFIX, ...args);
  }
  function logObj(label, obj) {
    if (!DEBUG) return;
    console.groupCollapsed(`${LOG_PREFIX} ${label}`);
    try {
      console.table(obj);
    } catch (_) {}
    console.log(obj);
    console.groupEnd();
  }
  let panelElement = null;
  let lastPendingIds = [];
  function isValidMediaUrl(url) {
    if (!url || typeof url !== "string") return false;
    const t = url.trim();
    if (!t) return false;
    if (/[()?:]/.test(t) && /\s/.test(t)) return false;
    if (
      t.startsWith("javascript:") ||
      t.startsWith("blob:") ||
      t.startsWith("data:")
    )
      return false;
    if (!/^https?:\/\//i.test(t)) return false;
    return true;
  }
  function getSrcOrDataSrc(el) {
    if (!el) return null;
    if (el.currentSrc) {
      const cs = el.currentSrc.trim();
      if (isValidMediaUrl(cs)) return cs;
    }
    const s = el.getAttribute("src");
    if (s && isValidMediaUrl(s)) return s.trim();
    const d = el.getAttribute("data-src");
    if (d && isValidMediaUrl(d)) return d.trim();
    if (el.tagName === "VIDEO") {
      const so = el.querySelector("source");
      if (so) {
        const ss = so.getAttribute("src");
        if (ss && isValidMediaUrl(ss)) return ss.trim();
      }
      const p = el.getAttribute("poster");
      if (p && isValidMediaUrl(p)) return p.trim();
    }
    return null;
  }
  function generatePreviewUrl(thumb) {
    if (!thumb || typeof thumb !== "string") return null;
    if (thumb.endsWith("/preview.mp4")) return thumb;
    const i = thumb.lastIndexOf("/");
    if (i === -1) return null;
    return thumb.substring(0, i + 1) + "preview.mp4";
  }
  function generateIdFromUrl(url, videoId) {
    const input = url || videoId;
    if (!input) return "unknown-" + Date.now();
    let normalized;
    try {
      const u = new URL(input);
      normalized = u.origin + u.pathname;
    } catch (_) {
      normalized = input;
    }
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return "jav-" + hash.toString(36);
  }
  // --- JAV identifier extraction (from pasted extractor script) ---
  function extractJavInfo(url, text) {
    const threePartWithSuffix = /\b([a-z]+\d*-[a-z]+)-(\d+)(-[a-z0-9-]+)?\b/i;
    const twoPartWithSuffix = /\b([a-z0-9]+)-(\d+)(-[a-z0-9-]+)?\b/i;
    const lettersThenDigits = /\b([a-z]+)(\d{3,6})\b/i;
    const digitsThenLetters = /\b(\d+[a-z]+)(\d{3,6})\b/i;
    let match = null;
    match =
      url.match(threePartWithSuffix) ||
      url.match(twoPartWithSuffix) ||
      url.match(lettersThenDigits) ||
      url.match(digitsThenLetters);
    if (!match && text) {
      match =
        text.match(threePartWithSuffix) ||
        text.match(twoPartWithSuffix) ||
        text.match(lettersThenDigits) ||
        text.match(digitsThenLetters);
    }
    if (match) {
      if (match[0].includes("-")) {
        return {
          videoId: match[0].toLowerCase(),
          code: match[1].toLowerCase(),
          episode: match[2],
        };
      }
      return {
        videoId: match[0].toLowerCase(),
        code: match[1]?.toLowerCase() || null,
        episode: match[2] || null,
      };
    }
    return { videoId: null, code: null, episode: null };
  }
  // --- Multi-item extraction via .thumbnail.group containers ---
  function extractVideoMetadataFromSearch(code) {
    const t0 = performance.now();
    log(`extractVideoMetadataFromSearch(${code}) — scanning .thumbnail.group…`);
    const containers = document.querySelectorAll(".thumbnail.group");
    log(`  found ${containers.length} .thumbnail.group containers`);
    const seenUrls = new Set();
    const items = [];
    containers.forEach((container, index) => {
      try {
        // 1. Anchor containing media
        const mediaAnchor = Array.from(
          container.querySelectorAll("a[href]"),
        ).find((a) => a.querySelector("video") || a.querySelector("img"));
        if (!mediaAnchor) return;
        // 2. URL
        let rawUrl = mediaAnchor.getAttribute("href");
        if (!rawUrl) return;
        if (rawUrl.startsWith("/")) rawUrl = window.location.origin + rawUrl;
        const cleanUrl = rawUrl.split("#")[0].split("?")[0];
        if (seenUrls.has(cleanUrl)) return;
        seenUrls.add(cleanUrl);
        // 3. Title (Structure 4 first, then siblings, then flex, then img alt)
        let title = "";
        const innerTitleLink = container.querySelector(
          ".text-sm.truncate a.text-secondary",
        );
        let siblingTitleLink = null;
        if (!innerTitleLink) {
          const parent = container.parentElement;
          siblingTitleLink =
            parent?.querySelector(".text-sm.truncate a") ||
            container.nextElementSibling?.querySelector("a");
        }
        if (!innerTitleLink && !siblingTitleLink) {
          const parentFlex = container.closest(".flex");
          const sideTitle = parentFlex?.querySelector(".overflow-y-hidden a");
          if (sideTitle) title = sideTitle.innerText.trim();
        }
        if (innerTitleLink) title = innerTitleLink.innerText.trim();
        else if (siblingTitleLink) title = siblingTitleLink.innerText.trim();
        if (!title) {
          const img = container.querySelector("img");
          if (img) title = img.getAttribute("alt") || "";
        }
        // 4. Media
        const imgEl = container.querySelector("img");
        const videoEl = container.querySelector("video");
        let thumbnail = imgEl ? getSrcOrDataSrc(imgEl) : null;
        let preview = null;
        if (videoEl) {
          const vSrc = getSrcOrDataSrc(videoEl);
          if (vSrc && vSrc.includes("preview.mp4")) preview = vSrc;
        }
        if (!preview && thumbnail) preview = generatePreviewUrl(thumbnail);
        // 5. Identifiers
        const {
          videoId,
          code: itemCode,
          episode,
        } = extractJavInfo(cleanUrl, title);
        if (!videoId) {
          log(`  [container ${index}] no videoId, skipping (${cleanUrl})`);
          return;
        }
        const id = generateIdFromUrl(cleanUrl, videoId);
        items.push({
          id,
          url: cleanUrl,
          code: itemCode,
          episode,
          video_id: videoId,
          title: title || null,
          thumbnail: thumbnail || null,
          preview: preview || null,
          details: null,
          release_date: null,
          genres: [],
        });
      } catch (err) {
        log(`  [container ${index}] error:`, err?.message);
      }
    });
    const elapsed = (performance.now() - t0).toFixed(1);
    log(
      `extractVideoMetadataFromSearch: unique=${items.length} (${elapsed}ms)`,
    );
    return { items, urls: items.map((i) => i.url) };
  }
  function getTotalPagesFromDom() {
    const container = document.querySelector(".hidden.md\\:flex");
    // No paginator in DOM → only one page of results.
    if (!container) {
      log(`getTotalPagesFromDom: no paginator → single page`);
      return 1;
    }
    // Also require at least one page link inside it, in case the element exists
    // but is empty/hidden shell.
    const links = container.querySelectorAll('a[href*="page="]');
    if (links.length === 0) {
      log(
        `getTotalPagesFromDom: paginator present but no page links → single page`,
      );
      return 1;
    }
    let maxPage = 1;
    let currentPage = 1;
    links.forEach((l) => {
      const m = l.getAttribute("href").match(/[?&]page=(\d+)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    // The "current" page is the one wrapped in [aria-current="page"].
    const currentEl = container.querySelector('[aria-current="page"]');
    if (currentEl) {
      const t = (currentEl.textContent || "").trim();
      if (/^\d+$/.test(t)) currentPage = parseInt(t, 10);
    }
    log(`getTotalPagesFromDom: maxPage=${maxPage} currentPage=${currentPage}`);
    return maxPage;
  }
  function createPanel(state) {
    log("createPanel()");
    if (panelElement) panelElement.remove();
    panelElement = document.createElement("div");
    panelElement.id = "missav-control-panel";
    panelElement.style.cssText = `
      position: fixed !important; top: 10px !important; left: 10px !important;
      background: rgba(0, 0, 0, 0.95) !important; color: white !important;
      padding: 15px !important; border-radius: 8px !important; z-index: 2147483647 !important;
      font-family: Arial, Helvetica, sans-serif !important; min-width: 320px !important;
      max-width: 420px !important; border: 2px solid #4CAF50 !important;
      max-height: 90vh !important; overflow-y: auto !important;
    `;
    document.body.appendChild(panelElement);
    updatePanelContent(state);
  }
  function updatePanelContent(state, pendingIds) {
    if (!panelElement) {
      createPanel(state);
      return;
    }
    if (pendingIds) lastPendingIds = pendingIds;
    const statusColor = state.isRunning ? "#4CAF50" : "#f44336";
    const statusText = state.isRunning ? "RUNNING" : "STOPPED";
    const buttonText = state.isRunning ? "⏹ Stop" : "▶ Start";
    const buttonBg = state.isRunning ? "#f44336" : "#4CAF50";
    const openChecked = state.openVideos ? "checked" : "";
    const totalPagesDisplay = state.totalPages || "?";
    const li = state.lastIngest;
    const pendingListHtml = lastPendingIds.length
      ? `<div style="font-size:11px;color:#aaa;margin-top:6px;">
           <strong>Pending IDs (last ${lastPendingIds.length}):</strong><br>
           ${lastPendingIds.map((id) => `<code style="color:#4CAF50;">${id}</code>`).join("<br>")}
           ${
             (state.pendingIngestCount || 0) > lastPendingIds.length
               ? `<div style="color:#FF9800;">+${(state.pendingIngestCount || 0) - lastPendingIds.length} more</div>`
               : ""
           }
         </div>`
      : `<div style="font-size:11px;color:#666;margin-top:6px;">Pending queue empty</div>`;
    panelElement.innerHTML = `
      <div style="margin-bottom: 12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="margin:0;color:#4CAF50;font-size:16px;">MissAV Opener</h3>
          <span style="background:${statusColor};color:white;padding:2px 8px;border-radius:4px;font-size:11px;">${statusText}</span>
        </div>
        <div style="font-size:13px;line-height:1.8;">
          <div><strong>Code:</strong> ${state.code || "N/A"}</div>
          <div><strong>Progress:</strong> ${state.totalPagesProcessed} / ${totalPagesDisplay} Pages</div>
          <div><strong>Videos Found:</strong> <span style="color:#4CAF50;">${state.totalVideosOpened}</span></div>
          <div><strong>Collected:</strong> <span style="color:#9C27B0;">${state.collectedCount || 0}</span></div>
          <div><strong>Pending Ingest:</strong> <span style="color:#FF9800;">${state.pendingIngestCount || 0}</span></div>
          <div><strong>Ingested (DB):</strong> <span style="color:#2196F3;">${state.ingestedCount || 0}</span></div>
          <div><strong>Incomplete:</strong> <span style="color:#FF5722;">${state.incompleteCount || 0}</span></div>
          ${
            li
              ? `<div style="font-size:11px;color:#888;margin-top:4px;">
             Last ingest: +${li.inserted} new, ~${li.updated} upd, ${li.skipped} skip (${Math.round(li.took_ms)}ms)
          </div>`
              : ""
          }
        </div>
        ${pendingListHtml}
      </div>
      <div style="border-top:1px solid #555;padding-top:12px;margin-bottom:12px;">
        <label style="display:flex;align-items:center;cursor:pointer;font-size:13px;">
          <input type="checkbox" id="missav-open-videos-toggle" ${openChecked} style="margin-right:8px;">
          <span>Open Video Tabs</span>
        </label>
      </div>
      <div style="border-top:1px solid #555;padding-top:12px;">
        <button id="missav-toggle-btn" style="background:${buttonBg};color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer;width:100%;margin-bottom:10px;">${buttonText}</button>
        <button id="missav-ingest-btn" style="background:#2196F3;color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer;width:100%;">🚀 Ingest All Pending</button>
      </div>
    `;
    document
      .getElementById("missav-toggle-btn")
      .addEventListener("click", () => {
        log("UI: toggle button clicked");
        chrome.runtime.sendMessage({ action: "toggleState" }, (resp) =>
          log("UI: toggleState response", resp),
        );
      });
    document
      .getElementById("missav-ingest-btn")
      .addEventListener("click", () => {
        log("UI: ingest button clicked");
        chrome.runtime.sendMessage(
          { action: "triggerBatchIngest" },
          (response) => {
            log("UI: triggerBatchIngest response", response);
            if (response && response.success) {
              showNotification(
                `Ingested: ${response.inserted} new, ${response.updated} updated`,
              );
            }
          },
        );
      });
    document
      .getElementById("missav-open-videos-toggle")
      .addEventListener("change", (e) => {
        log(`UI: openVideos → ${e.target.checked}`);
        chrome.runtime.sendMessage({
          action: "updateSettings",
          updates: { openVideos: e.target.checked },
        });
      });
  }
  function showNotification(message) {
    const n = document.createElement("div");
    n.style.cssText = `position:fixed;bottom:20px;right:20px;background:#333;color:white;padding:12px;border-radius:5px;z-index:2147483647;`;
    n.textContent = message;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 3000);
  }
  async function initializeBatchProcess(code, startPage) {
    log(`initializeBatchProcess code=${code} startPage=${startPage}`);
    const totalPages = getTotalPagesFromDom(); // always >= 1, never 0/50

    if (totalPages <= 1) {
      log(`initializeBatchProcess: single page, no page queue needed`);
      chrome.runtime.sendMessage({
        action: "setPageQueue",
        pageUrls: [], // no extra tabs
        totalPages: 1,
      });
    } else {
      const baseUrl = `https://missav.ws/en/search/${code}-`;
      const pageUrls = [];
      for (let i = 1; i <= totalPages; i++)
        pageUrls.push(`${baseUrl}?page=${i}`);
      log(`initializeBatchProcess: queuing ${pageUrls.length} page URLs`);
      chrome.runtime.sendMessage({
        action: "setPageQueue",
        pageUrls,
        totalPages,
      });
    }

    const { items } = extractVideoMetadataFromSearch(code);
    chrome.runtime.sendMessage({
      action: "extractedVideos",
      items,
      pageNum: startPage,
    });
  }
  async function fetchPendingPreview() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getProcessingState" }, (resp) => {
        resolve(resp?.pendingIds || []);
      });
    });
  }
  let _panelRefreshTimer = null;
  let _lastPanelStateJson = null;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let dirty = false;
    if (changes.processingState) {
      const newJson = JSON.stringify(changes.processingState.newValue);
      if (newJson !== _lastPanelStateJson) {
        _lastPanelStateJson = newJson;
        dirty = true;
      }
    }
    if (changes.pendingIngestQueue) dirty = true;
    if (!dirty) return;
    clearTimeout(_panelRefreshTimer);
    _panelRefreshTimer = setTimeout(async () => {
      const pending = await fetchPendingPreview();
      chrome.runtime.sendMessage(
        { action: "getProcessingState" },
        (response) => {
          if (response && response.state) {
            updatePanelContent(response.state, pending);
          }
        },
      );
    }, 150);
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log(`← message: ${message?.action}`);
    if (
      message.action === "updatePanel" ||
      message.action === "forceShowPanel"
    ) {
      if (message.action === "forceShowPanel" || !panelElement)
        createPanel(message.state);
      else updatePanelContent(message.state);
      sendResponse({ success: true });
    } else if (message.action === "initializeBatchProcess") {
      log("initializeBatchProcess received", {
        code: message.code,
        pageNum: message.pageNum,
      });
      createPanel(message.state);
      initializeBatchProcess(message.code, message.pageNum);
      sendResponse({ success: true });
    }
    return true;
  });
  window.addEventListener("load", () => {
    setTimeout(async () => {
      const response = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: "getProcessingState" }, resolve),
      );
      if (response && response.state && response.state.isRunning) {
        createPanel(response.state);
        const urlMatch = window.location.href.match(
          /\/en\/search\/([a-zA-Z0-9]+)-/,
        );
        if (urlMatch) {
          const code = urlMatch[1];
          const pageMatch = window.location.href.match(/[?&]page=(\d+)/);
          const pageNum = pageMatch ? parseInt(pageMatch[1]) : 1;
          const { items } = extractVideoMetadataFromSearch(code);
          chrome.runtime.sendMessage({
            action: "extractedVideos",
            items,
            pageNum,
          });
        }
      }
    }, 500);
  });
})();
