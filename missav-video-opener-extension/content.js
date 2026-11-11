// content.js
(function () {
  "use strict";

  let progressDiv = null;

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

  function showProgress(code, currentPage, totalVideos, totalPages) {
    if (!progressDiv) {
      progressDiv = document.createElement("div");
      progressDiv.id = "missav-progress-panel";
      progressDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 20px;
        border-radius: 10px;
        z-index: 999999;
        font-family: Arial, sans-serif;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        min-width: 300px;
        border: 2px solid #4CAF50;
      `;
      document.body.appendChild(progressDiv);
    }

    progressDiv.innerHTML = `
      <div style="margin-bottom: 15px;">
        <h3 style="margin: 0 0 10px 0; color: #4CAF50;">MissAV Video Opener</h3>
        <div style="font-size: 14px; line-height: 1.6;">
          <div><strong>Code:</strong> ${code}</div>
          <div><strong>Current Page:</strong> ${currentPage}</div>
          <div><strong>Videos Opened:</strong> <span style="color: #4CAF50; font-weight: bold;">${totalVideos}</span></div>
          <div><strong>Pages Processed:</strong> ${totalPages}</div>
        </div>
      </div>
      <div style="border-top: 1px solid #555; padding-top: 15px; margin-top: 15px;">
        <div style="font-size: 12px; color: #aaa; margin-bottom: 10px;">
          Click the extension icon to stop
        </div>
        <div style="display: flex; gap: 10px;">
          <button id="stop-btn" style="
            background: #f44336;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            flex: 1;
          ">Stop</button>
        </div>
      </div>
    `;

    // Add stop button handler
    const stopBtn = document.getElementById("stop-btn");
    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "stopProcessing" });
        hideProgress();
      });
    }
  }

  function hideProgress() {
    if (progressDiv) {
      progressDiv.remove();
      progressDiv = null;
    }
  }

  function showNotification(message, duration = 3000) {
    const notif = document.createElement("div");
    notif.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #333;
      color: white;
      padding: 15px 20px;
      border-radius: 5px;
      z-index: 999999;
      font-family: Arial, sans-serif;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
    `;
    notif.textContent = message;
    document.body.appendChild(notif);

    setTimeout(() => {
      notif.remove();
    }, duration);
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "showNotification") {
      showNotification(message.message);
      sendResponse({ success: true });
    } else if (message.action === "stopProcessing") {
      hideProgress();
      showNotification("Processing stopped by user");
      sendResponse({ success: true });
    } else if (message.action === "startProcessing") {
      const { code, pageNum, tabId } = message;

      console.log(`Starting processing for page ${pageNum}, code: ${code}`);

      // Show progress panel
      chrome.runtime.sendMessage(
        { action: "getProcessingState" },
        (response) => {
          if (response && response.state) {
            showProgress(
              code,
              pageNum,
              response.state.totalVideosOpened,
              response.state.totalPagesProcessed,
            );
          }
        },
      );

      // Extract video URLs
      const videoUrls = extractVideoUrls(code);

      if (videoUrls.length === 0) {
        console.log(`No videos found on page ${pageNum}`);
        showNotification(`No videos found on page ${pageNum}`, 2000);

        // Update progress
        showProgress(code, pageNum, 0, 0);

        // Check if there's a next page
        const nextPageUrl = getNextPageUrl(pageNum);
        if (nextPageUrl) {
          console.log(`Next page available: ${nextPageUrl}`);
          // Auto-continue to next page after short delay
          setTimeout(() => {
            chrome.runtime.sendMessage({
              action: "navigateToNextPage",
              nextPageUrl: nextPageUrl,
              code: code,
              pageNum: pageNum + 1,
            });
          }, 1500);
        } else {
          console.log("No more pages available");
          showNotification("No more pages available", 2000);
          setTimeout(() => {
            hideProgress();
            chrome.runtime.sendMessage({ action: "processingComplete" });
          }, 2000);
        }

        sendResponse({ success: true, videoCount: 0 });
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
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("Failed to send message:", chrome.runtime.lastError);
            showNotification("Error opening videos");
            hideProgress();
            chrome.runtime.sendMessage({ action: "processingComplete" });
          } else {
            console.log(`Successfully opened ${videoUrls.length} videos`);

            // Update progress display
            chrome.runtime.sendMessage(
              { action: "getProcessingState" },
              (resp) => {
                if (resp && resp.state) {
                  showProgress(
                    code,
                    pageNum,
                    resp.state.totalVideosOpened,
                    resp.state.totalPagesProcessed,
                  );
                }
              },
            );

            // Check if there's a next page
            const nextPageUrl = getNextPageUrl(pageNum);
            if (nextPageUrl) {
              console.log(`Next page available: ${nextPageUrl}`);
              // Auto-continue to next page after short delay
              setTimeout(() => {
                chrome.runtime.sendMessage({
                  action: "navigateToNextPage",
                  nextPageUrl: nextPageUrl,
                  code: code,
                  pageNum: pageNum + 1,
                });
              }, 2000);
            } else {
              console.log("No more pages available");
              showNotification("All pages processed!", 3000);
              setTimeout(() => {
                hideProgress();
                chrome.runtime.sendMessage({ action: "processingComplete" });
              }, 3000);
            }
          }
        },
      );

      sendResponse({ success: true, videoCount: videoUrls.length });
    }

    return true;
  });

  console.log("MissAV Video Opener extension loaded");
})();
