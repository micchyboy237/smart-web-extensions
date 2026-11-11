// background.js
const DEFAULT_STATE = {
  isRunning: false,
  code: null,
  currentPage: 0,
  totalVideosOpened: 0,
  totalPagesProcessed: 0,
  shouldStop: false,
  autoCloseTabs: true,
  jsWaitTime: 5000,
  pageDelay: 2000,
  tabOpenDelay: 200,
};

// Track tabs that are waiting to be closed
const pendingTabCloses = new Map(); // Map<tabId, {url, createdAt}>

// Get processing state from storage
async function getProcessingState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["processingState"], (result) => {
      resolve(result.processingState || { ...DEFAULT_STATE });
    });
  });
}

// Save processing state to storage
async function saveProcessingState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ processingState: state }, resolve);
  });
}

// Update toolbar badge with progress
function updateBadge(state) {
  if (state.isRunning) {
    const text = `${state.totalVideosOpened}`;
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// Initialize badge on startup
chrome.runtime.onStartup.addListener(async () => {
  const state = await getProcessingState();
  updateBadge(state);
});

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getProcessingState();
  updateBadge(state);
});

// Listen for tab updates to detect when pages finish loading
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if this tab is pending closure
  if (pendingTabCloses.has(tabId)) {
    const pendingInfo = pendingTabCloses.get(tabId);

    // Check if tab has finished loading
    if (changeInfo.status === "complete") {
      console.log(`Tab ${tabId} finished loading: ${pendingInfo.url}`);

      // Wait additional time for JS to execute
      setTimeout(() => {
        console.log(`Closing tab ${tabId} after JS wait`);
        chrome.tabs.remove(tabId).catch((err) => {
          console.error("Failed to close tab:", err);
        });
        pendingTabCloses.delete(tabId);
      }, pendingInfo.waitTime);
    }
  }
});

// Listen for toolbar button click - toggles running state
chrome.action.onClicked.addListener(async (tab) => {
  const url = tab.url;
  const searchMatch = url.match(/\/en\/search\/([a-zA-Z0-9]+)-\?page=(\d+)/);

  if (!searchMatch) {
    chrome.tabs
      .sendMessage(tab.id, {
        action: "showNotification",
        message: "Please navigate to a missav search page first",
      })
      .catch(() => {});
    return;
  }

  let state = await getProcessingState();

  // Toggle running state
  if (state.isRunning) {
    // Stop
    console.log("Stopping processing...");
    state.isRunning = false;
    state.shouldStop = true;
    await saveProcessingState(state);
    updateBadge(state);

    chrome.tabs
      .sendMessage(tab.id, {
        action: "updatePanel",
        state: state,
      })
      .catch(() => {});

    chrome.tabs
      .sendMessage(tab.id, {
        action: "showNotification",
        message: `Stopped! Processed ${state.totalPagesProcessed} pages, opened ${state.totalVideosOpened} videos.`,
      })
      .catch(() => {});
  } else {
    // Start
    const code = searchMatch[1];
    const pageNum = parseInt(searchMatch[2]);

    console.log(`Starting processing for code: ${code}, page: ${pageNum}`);

    state = {
      ...DEFAULT_STATE,
      isRunning: true,
      code: code,
      currentPage: pageNum,
      shouldStop: false,
    };
    await saveProcessingState(state);
    updateBadge(state);

    chrome.tabs
      .sendMessage(tab.id, {
        action: "startProcessing",
        code: code,
        pageNum: pageNum,
        tabId: tab.id,
        state: state,
      })
      .catch((e) => {
        console.error("Failed to send message:", e);
      });
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message, sender, sendResponse) {
  if (message.action === "openVideos") {
    const { urls, code, pageNum, state: currentState } = message;

    console.log(
      `Opening ${urls.length} videos from page ${pageNum} for code: ${code}`,
    );

    // Update state
    currentState.totalVideosOpened += urls.length;
    currentState.totalPagesProcessed += 1;
    await saveProcessingState(currentState);
    updateBadge(currentState);

    // Notify content script to update panel
    chrome.tabs
      .sendMessage(sender.tab.id, {
        action: "updatePanel",
        state: currentState,
      })
      .catch(() => {});

    // Open each video URL in a new tab
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];

      // Check if should stop
      const currentState = await getProcessingState();
      if (currentState.shouldStop || !currentState.isRunning) {
        console.log("Stop requested, skipping remaining videos");
        break;
      }

      // Delay between opening tabs
      await new Promise((resolve) =>
        setTimeout(resolve, currentState.tabOpenDelay),
      );

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

          console.log(`Opened video ${i + 1}/${urls.length}: ${url}`);

          // If autoCloseTabs is enabled, mark this tab for closing after it loads
          if (currentState.autoCloseTabs) {
            pendingTabCloses.set(tab.id, {
              url: url,
              createdAt: Date.now(),
              waitTime: currentState.jsWaitTime,
            });
            console.log(
              `Tab ${tab.id} marked for auto-close after load + ${currentState.jsWaitTime}ms`,
            );
          }
        },
      );
    }

    sendResponse({ success: true });
  } else if (message.action === "processingComplete") {
    console.log("Processing complete");
    let state = await getProcessingState();
    state.isRunning = false;
    await saveProcessingState(state);
    updateBadge(state);

    chrome.tabs
      .sendMessage(sender.tab.id, {
        action: "updatePanel",
        state: state,
      })
      .catch(() => {});

    sendResponse({ success: true });
  } else if (message.action === "navigateToNextPage") {
    const { nextPageUrl, code, pageNum, state: currentState } = message;

    // Check if should stop
    if (currentState.shouldStop || !currentState.isRunning) {
      console.log("Stop requested, not navigating to next page");
      currentState.isRunning = false;
      await saveProcessingState(currentState);
      updateBadge(currentState);
      sendResponse({ success: false, stopped: true });
      return;
    }

    console.log(`Navigating to next page: ${nextPageUrl}`);

    // Update current page in state
    currentState.currentPage = pageNum;
    await saveProcessingState(currentState);

    // Delay before navigating to next page
    await new Promise((resolve) => setTimeout(resolve, currentState.pageDelay));

    // Check again if should stop
    const updatedState = await getProcessingState();
    if (updatedState.shouldStop || !updatedState.isRunning) {
      console.log("Stop requested during delay");
      updatedState.isRunning = false;
      await saveProcessingState(updatedState);
      updateBadge(updatedState);
      sendResponse({ success: false, stopped: true });
      return;
    }

    // Update the current tab to the next page
    chrome.tabs.update(
      sender.tab.id,
      {
        url: nextPageUrl,
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error("Failed to navigate:", chrome.runtime.lastError);
          getProcessingState().then((state) => {
            state.isRunning = false;
            saveProcessingState(state);
            updateBadge(state);
          });
          return;
        }

        // Page will reload and content script will auto-detect running state
      },
    );

    sendResponse({ success: true });
  } else if (message.action === "getProcessingState") {
    const state = await getProcessingState();
    sendResponse({ state });
  } else if (message.action === "updateState") {
    const { updates } = message;
    let state = await getProcessingState();
    state = { ...state, ...updates };
    await saveProcessingState(state);
    updateBadge(state);
    sendResponse({ success: true, state });
  }
}

// Cleanup: Remove old pending tabs periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 60000; // 1 minute

  for (const [tabId, info] of pendingTabCloses.entries()) {
    if (now - info.createdAt > maxAge) {
      console.log(`Removing stale pending tab ${tabId}`);
      pendingTabCloses.delete(tabId);
    }
  }
}, 30000); // Check every 30 seconds
