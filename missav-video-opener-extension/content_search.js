// Jet_Apps/web-extensions/smart-web-extensions/missav-video-opener-extension/content_search.js
(function () {
  "use strict";

  // --- GUARD CLAUSE ---
  // Only run if this is a search page
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

  function extractVideoMetadataFromSearch(code) {
    const startedAt = performance.now();
    log(`extractVideoMetadataFromSearch(${code}) — scanning anchors…`);
    const anchors = Array.from(document.querySelectorAll("a"));
    const uniqueItems = new Map();
    let matched = 0;
    anchors.forEach((anchor, idx) => {
      const href = anchor.getAttribute("href");
      if (!href) return;
      if (anchor.querySelector("video") === null) return;
      if (!new RegExp(code, "i").test(href)) return;
      if (!href.includes("/en/")) return;
      const absoluteUrl = href.startsWith("http")
        ? href
        : new URL(href, window.location.origin).href;
      const pathMatch = absoluteUrl.match(
        /\/(?:dm\d+\/)?en\/([a-z0-9]+-\d+(?:-[a-z0-9-]+)?)/i,
      );
      if (!pathMatch) {
        log(`  [anchor ${idx}] path fail: ${absoluteUrl}`);
        return;
      }
      const videoId = pathMatch[1].toLowerCase();
      const codeMatch = videoId.match(/^([a-z0-9]+)-(\d+)/);
      if (!codeMatch) return;
      const itemCode = codeMatch[1],
        episode = codeMatch[2];
      const titleEl = anchor.querySelector(
        ".text-base, .lg\\:text-lg, h1, h2, h3, .title",
      );
      const title = titleEl ? titleEl.innerText.trim() : null;
      const imgEl = anchor.querySelector("img");
      const thumbnail = imgEl ? getSrcOrDataSrc(imgEl) : null;
      const id = generateIdFromUrl(absoluteUrl, videoId);
      matched++;
      if (uniqueItems.has(id)) {
        log(`  [anchor ${idx}] duplicate ${id}`);
        return;
      }
      log(
        `  [anchor ${idx}] ✓ ${videoId} | title=${title?.slice(0, 40) || "(none)"}`,
      );
      uniqueItems.set(id, {
        id,
        url: absoluteUrl,
        code: itemCode,
        episode,
        video_id: videoId,
        title,
        thumbnail,
        preview: thumbnail ? generatePreviewUrl(thumbnail) : null,
        details: null,
        release_date: null,
        genres: [],
      });
    });
    const elapsed = (performance.now() - startedAt).toFixed(1);
    log(
      `extractVideoMetadataFromSearch: matched=${matched} unique=${uniqueItems.size} (${elapsed}ms)`,
    );
    return {
      urls: Array.from(uniqueItems.values()).map((i) => i.url),
      metadataList: Array.from(uniqueItems.values()),
    };
  }

  function getTotalPagesFromDom() {
    let maxPage = 0;
    const c = document.querySelector(".hidden.md\\:flex");
    if (c)
      c.querySelectorAll('a[href*="page="]').forEach((l) => {
        const m = l.getAttribute("href").match(/page=(\d+)/);
        if (m) maxPage = Math.max(maxPage, parseInt(m[1]));
      });
    log(`getTotalPagesFromDom: maxPage=${maxPage}`);
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
    const totalPages = getTotalPagesFromDom() || 50;
    const pageUrls = [];
    const baseUrl = `https://missav.ws/en/search/${code}-`;
    for (let i = 1; i <= totalPages; i++) pageUrls.push(`${baseUrl}?page=${i}`);
    log(`initializeBatchProcess: queuing ${pageUrls.length} page URLs`);
    chrome.runtime.sendMessage({
      action: "setPageQueue",
      pageUrls,
      totalPages,
    });
    const { urls, metadataList } = extractVideoMetadataFromSearch(code);
    chrome.runtime.sendMessage({
      action: "extractedVideos",
      urls,
      pageNum: startPage,
      metadataList,
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
          const { urls, metadataList } = extractVideoMetadataFromSearch(code);
          chrome.runtime.sendMessage({
            action: "extractedVideos",
            urls,
            pageNum,
            metadataList,
          });
        }
      }
    }, 500);
  });
})();
