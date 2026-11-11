(function () {
  "use strict";

  const LOG_PREFIX = "[MissAV-Content]";
  let panelElement = null;

  function extractVideoUrls(code) {
    const anchors = Array.from(document.querySelectorAll("a"));
    const uniqueUrls = new Set();

    anchors.forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (!href) return;

      const hasVideo = anchor.querySelector("video") !== null;
      if (!hasVideo) return;

      const codeRegex = new RegExp(code, "i");
      if (!codeRegex.test(href)) return;

      if (!href.includes("/en/")) return;

      const absoluteUrl = href.startsWith("http")
        ? href
        : new URL(href, window.location.origin).href;
      uniqueUrls.add(absoluteUrl);
    });

    console.log(
      `${LOG_PREFIX} Extracted ${uniqueUrls.size} video URLs for code '${code}'`,
    );
    return Array.from(uniqueUrls);
  }

  function getTotalPagesFromDom() {
    let maxPage = 0;

    const paginationContainer = document.querySelector(".hidden.md\\:flex");
    if (paginationContainer) {
      const links = paginationContainer.querySelectorAll('a[href*="page="]');
      links.forEach((link) => {
        const href = link.getAttribute("href");
        const match = href.match(/page=(\d+)/);
        if (match) {
          const pageNum = parseInt(match[1]);
          if (pageNum > maxPage) maxPage = pageNum;
        }
      });
    }

    if (maxPage === 0) {
      const links = Array.from(
        document.querySelectorAll('a[aria-label^="Go to page"]'),
      );
      links.forEach((link) => {
        const label = link.getAttribute("aria-label");
        const match = label.match(/(\d+)/);
        if (match) {
          const pageNum = parseInt(match[1]);
          if (pageNum > maxPage) maxPage = pageNum;
        }
      });
    }

    console.log(`${LOG_PREFIX} Detected total pages: ${maxPage}`);
    return maxPage;
  }

  function createPanel(state) {
    if (panelElement) panelElement.remove();

    panelElement = document.createElement("div");
    panelElement.id = "missav-control-panel";
    panelElement.style.cssText = `
      position: fixed !important;
      top: 10px !important;
      left: 10px !important;
      background: rgba(0, 0, 0, 0.95) !important;
      color: white !important;
      padding: 15px !important;
      border-radius: 8px !important;
      z-index: 2147483647 !important;
      font-family: Arial, Helvetica, sans-serif !important;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5) !important;
      min-width: 300px !important;
      border: 2px solid #4CAF50 !important;
      display: block !important;
    `;

    document.body.appendChild(panelElement);
    updatePanelContent(state);
  }

  function updatePanelContent(state) {
    if (!panelElement) {
      createPanel(state);
      return;
    }

    const statusColor = state.isRunning ? "#4CAF50" : "#f44336";
    const statusText = state.isRunning ? "RUNNING" : "STOPPED";
    const buttonText = state.isRunning ? "⏹ Stop" : "▶ Start";
    const buttonBg = state.isRunning ? "#f44336" : "#4CAF50";

    const openVideosChecked = state.openVideos ? "checked" : "";
    const totalPagesDisplay = state.totalPages || "?";

    panelElement.innerHTML = `
      <div style="margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <h3 style="margin: 0; color: #4CAF50; font-size: 16px; font-weight: bold;">MissAV Opener</h3>
          <span style="background: ${statusColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${statusText}</span>
        </div>
        <div style="font-size: 13px; line-height: 1.8;">
          <div><strong>Code:</strong> ${state.code || "N/A"}</div>
          <div><strong>Progress:</strong> ${state.totalPagesProcessed} / ${totalPagesDisplay} Pages</div>
          <div><strong>Videos Found:</strong> <span style="color: #4CAF50; font-weight: bold;">${state.totalVideosOpened}</span></div>
        </div>
      </div>
      
      <div style="border-top: 1px solid #555; padding-top: 12px; margin-bottom: 12px;">
        <label style="display: flex; align-items: center; cursor: pointer; font-size: 13px;">
          <input type="checkbox" id="missav-open-videos-toggle" ${openVideosChecked} style="margin-right: 8px;">
          <span>Open Video Tabs</span>
        </label>
        <div style="font-size: 11px; color: #aaa; margin-left: 24px; margin-top: 4px;">
          Uncheck to only scan pages first
        </div>
      </div>

      <div style="border-top: 1px solid #555; padding-top: 12px;">
        <button id="missav-toggle-btn" style="
          background: ${buttonBg};
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
          font-weight: bold;
          width: 100%;
          transition: background 0.2s;
        ">${buttonText}</button>
      </div>
    `;

    document
      .getElementById("missav-toggle-btn")
      .addEventListener("click", (e) => {
        e.preventDefault();
        console.log(`${LOG_PREFIX} Toggle button clicked`);
        chrome.runtime.sendMessage({ action: "toggleState" });
      });

    document
      .getElementById("missav-open-videos-toggle")
      .addEventListener("change", (e) => {
        console.log(
          `${LOG_PREFIX} Settings changed: Open Videos = ${e.target.checked}`,
        );
        chrome.runtime.sendMessage({
          action: "updateSettings",
          updates: { openVideos: e.target.checked },
        });
      });
  }

  function showNotification(message, duration = 3000) {
    const notif = document.createElement("div");
    notif.style.cssText = `
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      background: #333 !important;
      color: white !important;
      padding: 12px 18px !important;
      border-radius: 5px !important;
      z-index: 2147483647 !important;
      font-family: Arial, Helvetica, sans-serif !important;
    `;
    notif.textContent = message;
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), duration);
  }

  async function initializeBatchProcess(code, startPage) {
    console.log(
      `${LOG_PREFIX} Initializing batch process for code: ${code}, start page: ${startPage}`,
    );
    const totalPages = getTotalPagesFromDom();

    if (totalPages === 0) {
      showNotification("Could not detect total pages. Defaulting to 50.");
      console.warn(
        `${LOG_PREFIX} Could not detect total pages, defaulting to 50`,
      );
    }

    const limit = totalPages > 0 ? totalPages : 50;
    const pageUrls = [];
    const baseUrl = `https://missav.ws/en/search/${code}-`;

    for (let i = 1; i <= limit; i++) {
      pageUrls.push(`${baseUrl}?page=${i}`);
    }

    console.log(
      `${LOG_PREFIX} Generated ${pageUrls.length} page URLs. Sending to background...`,
    );

    // Send page queue
    chrome.runtime.sendMessage(
      {
        action: "setPageQueue",
        pageUrls: pageUrls,
        totalPages: totalPages,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            `${LOG_PREFIX} Failed to send page queue:`,
            chrome.runtime.lastError,
          );
        } else {
          console.log(`${LOG_PREFIX} Page queue sent successfully`);
        }
      },
    );

    // Process the CURRENT page immediately
    const videoUrls = extractVideoUrls(code);
    chrome.runtime.sendMessage({
      action: "extractedVideos",
      urls: videoUrls,
      pageNum: startPage,
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "showNotification") {
      showNotification(message.message);
      sendResponse({ success: true });
    } else if (
      message.action === "updatePanel" ||
      message.action === "forceShowPanel"
    ) {
      console.log(`${LOG_PREFIX} Received panel update request`);
      if (message.action === "forceShowPanel" || !panelElement) {
        createPanel(message.state);
      } else {
        updatePanelContent(message.state);
      }
      sendResponse({ success: true });
    } else if (message.action === "initializeBatchProcess") {
      createPanel(message.state);
      initializeBatchProcess(message.code, message.pageNum);
      sendResponse({ success: true });
    }

    return true;
  });

  window.addEventListener("load", () => {
    setTimeout(async () => {
      console.log(`${LOG_PREFIX} Page loaded, checking state...`);
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "getProcessingState" }, resolve);
      });

      if (response && response.state && response.state.isRunning) {
        console.log(`${LOG_PREFIX} Detected running state. Showing panel.`);
        createPanel(response.state);

        const urlMatch = window.location.href.match(
          /\/en\/search\/([a-zA-Z0-9]+)-(\?page=(\d+))?/,
        );
        if (urlMatch) {
          const code = urlMatch[1];
          const pageNum = urlMatch[3] ? parseInt(urlMatch[3]) : 1;

          console.log(
            `${LOG_PREFIX} Extracting videos from current page ${pageNum} as part of batch...`,
          );
          const videoUrls = extractVideoUrls(code);
          chrome.runtime.sendMessage({
            action: "extractedVideos",
            urls: videoUrls,
            pageNum: pageNum,
          });
        }
      } else {
        console.log(`${LOG_PREFIX} Not in running state`);
      }
    }, 500);
  });
})();
