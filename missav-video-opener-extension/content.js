// content.js
(function () {
  "use strict";

  let panelElement = null;

  function extractVideoUrls(code) {
    const anchors = Array.from(document.querySelectorAll("a"));
    const uniqueUrls = new Set();

    anchors.forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (!href) return;

      // Check if this anchor contains a video element
      const hasVideo = anchor.querySelector("video") !== null;
      if (!hasVideo) return;

      // Check if href contains the code pattern (case-insensitive)
      const codeRegex = new RegExp(code, "i");
      if (!codeRegex.test(href)) return;

      // Ensure it's a video detail page (contains /en/)
      if (!href.includes("/en/")) return;

      // Make absolute URL if relative
      const absoluteUrl = href.startsWith("http")
        ? href
        : new URL(href, window.location.origin).href;
      uniqueUrls.add(absoluteUrl);
    });

    return Array.from(uniqueUrls);
  }

  function getNextPageUrl(currentPageNum) {
    const nextPageNum = currentPageNum + 1;

    // Look for pagination link with the next page number
    const links = Array.from(
      document.querySelectorAll('a[aria-label^="Go to page"]'),
    );

    for (const link of links) {
      const label = link.getAttribute("aria-label");
      if (label && label.includes(nextPageNum.toString())) {
        return link.href;
      }
    }

    // Also check for "Next" button
    const nextButton = document.querySelector('a[aria-label*="Next"]');
    if (nextButton) {
      return nextButton.href;
    }

    return null;
  }

  function createPanel(state) {
    // Remove existing panel if any
    if (panelElement) {
      panelElement.remove();
    }

    // Create panel container
    panelElement = document.createElement("div");
    panelElement.id = "missav-control-panel";

    // Set styles with high z-index and fixed positioning
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
      min-width: 280px !important;
      border: 2px solid #4CAF50 !important;
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    `;

    // Append to body
    document.body.appendChild(panelElement);

    // Update panel content
    updatePanelContent(state);

    console.log("Panel created and appended to body");
  }

  function updatePanelContent(state) {
    if (!panelElement) {
      console.log("Panel element not found, creating...");
      createPanel(state);
      return;
    }

    const statusColor = state.isRunning ? "#4CAF50" : "#f44336";
    const statusText = state.isRunning ? "RUNNING" : "STOPPED";
    const buttonText = state.isRunning ? "⏹ Stop" : "▶ Start";
    const buttonBg = state.isRunning ? "#f44336" : "#4CAF50";

    panelElement.innerHTML = `
      <div style="margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <h3 style="margin: 0; color: #4CAF50; font-size: 16px; font-weight: bold;">MissAV Opener</h3>
          <span style="background: ${statusColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${statusText}</span>
        </div>
        <div style="font-size: 13px; line-height: 1.8;">
          <div><strong>Code:</strong> ${state.code || "N/A"}</div>
          <div><strong>Page:</strong> ${state.currentPage || 0}</div>
          <div><strong>Videos:</strong> <span style="color: #4CAF50; font-weight: bold;">${state.totalVideosOpened}</span></div>
          <div><strong>Pages:</strong> ${state.totalPagesProcessed}</div>
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
          margin-bottom: 10px;
          transition: background 0.2s;
        ">${buttonText}</button>
        <div style="font-size: 11px; color: #aaa; text-align: center;">
          Click button or extension icon to toggle
        </div>
      </div>
    `;

    // Add button handler
    const toggleBtn = document.getElementById("missav-toggle-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log("Toggle button clicked");
        chrome.runtime.sendMessage({ action: "toggleState" });
      });
    }

    console.log("Panel content updated");
  }

  function hidePanel() {
    if (panelElement) {
      panelElement.remove();
      panelElement = null;
      console.log("Panel hidden");
    }
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
      box-shadow: 0 2px 10px rgba(0,0,0,0.3) !important;
      max-width: 400px !important;
      display: block !important;
    `;
    notif.textContent = message;
    document.body.appendChild(notif);

    setTimeout(() => {
      if (notif.parentNode) {
        notif.remove();
      }
    }, duration);
  }

  async function processCurrentPage() {
    // Get current state
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getProcessingState" }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error("Message error:", chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(resp);
        }
      });
    });

    if (!response) {
      console.log("Failed to get processing state");
      return;
    }

    const state = response.state;

    if (!state.isRunning || state.shouldStop) {
      console.log("Not running or should stop");
      return;
    }

    // Parse current page from URL
    const urlMatch = window.location.href.match(
      /\/en\/search\/([a-zA-Z0-9]+)-\?page=(\d+)/,
    );
    if (!urlMatch) {
      console.log("Not on a search page");
      return;
    }

    const code = urlMatch[1];
    const pageNum = parseInt(urlMatch[2]);

    console.log(`Processing page ${pageNum} for code: ${code}`);

    // Update panel
    updatePanelContent({ ...state, code, currentPage: pageNum });

    // Extract video URLs
    const videoUrls = extractVideoUrls(code);

    if (videoUrls.length === 0) {
      console.log(`No videos found on page ${pageNum}`);
      showNotification(`No videos found on page ${pageNum}`, 2000);

      // Check if there's a next page
      const nextPageUrl = getNextPageUrl(pageNum);
      if (nextPageUrl) {
        console.log(`Next page available: ${nextPageUrl}`);
        showNotification("Moving to next page...", 1500);

        // Navigate to next page
        chrome.runtime.sendMessage({
          action: "navigateToNextPage",
          nextPageUrl: nextPageUrl,
          code: code,
          pageNum: pageNum + 1,
          state: state,
        });
      } else {
        console.log("No more pages available");
        showNotification("All pages processed!", 3000);
        setTimeout(() => {
          hidePanel();
          chrome.runtime.sendMessage({ action: "processingComplete" });
        }, 3000);
      }

      return;
    }

    console.log(`Found ${videoUrls.length} videos on page ${pageNum}`);
    showNotification(`Found ${videoUrls.length} videos. Opening...`, 2000);

    // Send URLs to background script to open
    chrome.runtime.sendMessage(
      {
        action: "openVideos",
        urls: videoUrls,
        code: code,
        pageNum: pageNum,
        state: state,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("Failed to send message:", chrome.runtime.lastError);
          showNotification("Error opening videos");
          hidePanel();
          chrome.runtime.sendMessage({ action: "processingComplete" });
        } else {
          console.log(`Successfully opened ${videoUrls.length} videos`);

          // Check if there's a next page
          const nextPageUrl = getNextPageUrl(pageNum);
          if (nextPageUrl) {
            console.log(`Next page available: ${nextPageUrl}`);
            showNotification("Moving to next page in 2 seconds...", 2000);

            // Navigate to next page after delay
            setTimeout(() => {
              chrome.runtime.sendMessage({
                action: "navigateToNextPage",
                nextPageUrl: nextPageUrl,
                code: code,
                pageNum: pageNum + 1,
                state: state,
              });
            }, 2000);
          } else {
            console.log("No more pages available");
            showNotification("All pages processed!", 3000);
            setTimeout(() => {
              hidePanel();
              chrome.runtime.sendMessage({ action: "processingComplete" });
            }, 3000);
          }
        }
      },
    );
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "showNotification") {
      showNotification(message.message);
      sendResponse({ success: true });
    } else if (message.action === "updatePanel") {
      updatePanelContent(message.state);
      sendResponse({ success: true });
    } else if (message.action === "startProcessing") {
      const { code, pageNum, tabId, state } = message;

      console.log(`Starting processing for page ${pageNum}, code: ${code}`);

      // Create/update panel
      createPanel(state);

      // Process current page
      processCurrentPage();

      sendResponse({ success: true });
    } else if (message.action === "toggleState") {
      // This will be handled by clicking the extension icon
      // Just provide visual feedback
      showNotification("Click extension icon to toggle");
      sendResponse({ success: true });
    }

    return true;
  });

  // Auto-detect running state when page loads
  function initOnLoad() {
    console.log("Initializing on page load...");

    // Check if body exists
    if (!document.body) {
      console.log("Body not ready, retrying...");
      setTimeout(initOnLoad, 100);
      return;
    }

    setTimeout(async () => {
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: "getProcessingState" },
            (resp) => {
              if (chrome.runtime.lastError) {
                console.error("Message error:", chrome.runtime.lastError);
                resolve(null);
              } else {
                resolve(resp);
              }
            },
          );
        });

        if (!response) {
          console.log("Failed to get state on load");
          return;
        }

        const state = response.state;

        // If running, show panel and process
        if (state.isRunning && !state.shouldStop) {
          console.log("Detected running state on page load");
          createPanel(state);

          // Small delay to ensure page is fully loaded
          setTimeout(() => {
            processCurrentPage();
          }, 1000);
        } else {
          console.log("Not in running state");
        }
      } catch (e) {
        console.error("Error during initialization:", e);
      }
    }, 500);
  }

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOnLoad);
  } else {
    initOnLoad();
  }

  console.log("MissAV Video Opener extension loaded");
})();
