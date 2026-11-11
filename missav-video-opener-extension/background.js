// background.js
let processingState = {
  isProcessing: false,
  code: null,
  currentPage: 0,
  totalVideosOpened: 0,
  totalPagesProcessed: 0,
  shouldStop: false,
};

// Initialize processing state from storage
chrome.storage.local.get(["processingState"], (result) => {
  if (result.processingState) {
    processingState = result.processingState;
  }
});

// Save processing state to storage
function saveProcessingState() {
  chrome.storage.local.set({ processingState });
}

// Update toolbar badge with progress
function updateBadge() {
  if (processingState.isProcessing) {
    const text = `${processingState.totalVideosOpened}`;
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// Listen for toolbar button click
chrome.action.onClicked.addListener(async (tab) => {
  // Check if we're on a missav search page
  const url = tab.url;
  const searchMatch = url.match(/\/en\/search\/([a-zA-Z0-9]+)-\?page=(\d+)/);

  if (!searchMatch) {
    console.log("Not on a missav search page");
    chrome.tabs
      .sendMessage(tab.id, {
        action: "showNotification",
        message:
          "Please navigate to a missav search page first (e.g., https://missav.ws/en/search/wnz-?page=1)",
      })
      .catch(() => {
        console.log("Content script not available");
      });
    return;
  }

  const code = searchMatch[1];
  const pageNum = parseInt(searchMatch[2]);

  // If already processing, this click will stop it
  if (processingState.isProcessing) {
    console.log("Stopping processing...");
    processingState.shouldStop = true;
    processingState.isProcessing = false;
    saveProcessingState();
    updateBadge();

    chrome.tabs
      .sendMessage(tab.id, {
        action: "showNotification",
        message: `Stopped! Processed ${processingState.totalPagesProcessed} pages, opened ${processingState.totalVideosOpened} videos.`,
      })
      .catch(() => {});

    return;
  }

  // Start new processing
  console.log(`Starting processing for code: ${code}, page: ${pageNum}`);

  processingState = {
    isProcessing: true,
    code: code,
    currentPage: pageNum,
    totalVideosOpened: 0,
    totalPagesProcessed: 0,
    shouldStop: false,
  };
  saveProcessingState();
  updateBadge();

  try {
    await chrome.tabs.sendMessage(tab.id, {
      action: "startProcessing",
      code: code,
      pageNum: pageNum,
      tabId: tab.id,
    });
  } catch (e) {
    console.error("Failed to send message to content script:", e);
    processingState.isProcessing = false;
    saveProcessingState();
    updateBadge();
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openVideos") {
    const { urls, code, pageNum } = message;

    console.log(
      `Opening ${urls.length} videos from page ${pageNum} for code: ${code}`,
    );

    // Update state
    processingState.totalVideosOpened += urls.length;
    processingState.totalPagesProcessed += 1;
    saveProcessingState();
    updateBadge();

    // Open each video URL in a new tab
    urls.forEach((url, index) => {
      setTimeout(() => {
        // Check if should stop
        if (processingState.shouldStop) {
          console.log("Stop requested, skipping remaining videos");
          return;
        }

        chrome.tabs.create(
          {
            url: url,
            active: false,
            index: sender.tab.index + 1,
          },
          (tab) => {
            if (chrome.runtime.lastError) {
              console.error("Failed to create tab:", chrome.runtime.lastError);
              return;
            }

            console.log(`Opened video ${index + 1}/${urls.length}: ${url}`);

            // Wait for JS to load (5 seconds)
            setTimeout(() => {
              console.log(`JS loaded for: ${url}`);
              // Optionally close the tab after waiting
              // chrome.tabs.remove(tab.id);
            }, 5000);
          },
        );
      }, index * 200);
    });

    sendResponse({ success: true });
  } else if (message.action === "processingComplete") {
    console.log("Processing complete");
    processingState.isProcessing = false;
    saveProcessingState();
    updateBadge();
    sendResponse({ success: true });
  } else if (message.action === "navigateToNextPage") {
    const { nextPageUrl, code, pageNum } = message;

    // Check if should stop
    if (processingState.shouldStop) {
      console.log("Stop requested, not navigating to next page");
      processingState.isProcessing = false;
      saveProcessingState();
      updateBadge();
      sendResponse({ success: false, stopped: true });
      return;
    }

    console.log(`Navigating to next page: ${nextPageUrl}`);

    // Update current page in state
    processingState.currentPage = pageNum;
    saveProcessingState();

    // Update the current tab to the next page
    chrome.tabs.update(
      sender.tab.id,
      {
        url: nextPageUrl,
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error("Failed to navigate:", chrome.runtime.lastError);
          processingState.isProcessing = false;
          saveProcessingState();
          updateBadge();
          return;
        }

        // Wait for page to load, then continue processing
        setTimeout(() => {
          // Check again if should stop
          if (processingState.shouldStop) {
            console.log("Stop requested during navigation wait");
            processingState.isProcessing = false;
            saveProcessingState();
            updateBadge();
            return;
          }

          chrome.tabs
            .sendMessage(sender.tab.id, {
              action: "startProcessing",
              code: code,
              pageNum: pageNum,
              tabId: sender.tab.id,
            })
            .catch((e) => {
              console.error("Failed to send message after navigation:", e);
              processingState.isProcessing = false;
              saveProcessingState();
              updateBadge();
            });
        }, 2000);
      },
    );

    sendResponse({ success: true });
  } else if (message.action === "getProcessingState") {
    sendResponse({ state: processingState });
  }

  return true;
});

// Update badge on extension load
updateBadge();
