const LOG_PREFIX = "[MissAV]";

const DEFAULT_STATE = {
  isRunning: false,
  code: null,
  currentPage: 0,
  totalPages: 0,
  totalVideosOpened: 0,
  totalPagesProcessed: 0,
  shouldStop: false,
  autoCloseTabs: true,
  openVideos: true,
  jsWaitTime: 5000,
  pageDelay: 1000,
  tabOpenDelay: 500,
  maxConcurrentTabs: 10,
};

let processingState = { ...DEFAULT_STATE };
let videoUrlQueue = [];
let pageUrlQueue = [];
let pendingTabCloses = new Map();
let localActiveTabCount = 0;

async function getProcessingState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["processingState"], (result) => {
      processingState = result.processingState || { ...DEFAULT_STATE };
      resolve(processingState);
    });
  });
}

async function saveProcessingState(state) {
  processingState = state;
  return new Promise((resolve) => {
    chrome.storage.local.set({ processingState: state }, () => {
      console.log(
        `${LOG_PREFIX} State saved: Running=${state.isRunning}, Pages=${state.totalPagesProcessed}/${state.totalPages}, Videos=${state.totalVideosOpened}`,
      );
      resolve();
    });
  });
}

function updateBadge(state) {
  if (state.isRunning) {
    const text = `${state.totalPagesProcessed}/${state.totalPages || "?"}`;
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

chrome.runtime.onStartup.addListener(async () => {
  console.log(`${LOG_PREFIX} Extension started`);
  localActiveTabCount = 0;
  updateBadge(await getProcessingState());
});

chrome.runtime.onInstalled.addListener(async () => {
  console.log(`${LOG_PREFIX} Extension installed/updated`);
  localActiveTabCount = 0;
  updateBadge(await getProcessingState());
});

// --- Tab Management ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (pendingTabCloses.has(tabId)) {
    if (changeInfo.status === "complete") {
      const pendingInfo = pendingTabCloses.get(tabId);
      console.log(
        `${LOG_PREFIX} Tab ${tabId} loaded (${pendingInfo.type}). Waiting ${pendingInfo.waitTime}ms.`,
      );

      setTimeout(() => {
        console.log(`${LOG_PREFIX} Closing tab ${tabId}`);
        chrome.tabs
          .remove(tabId)
          .catch((err) =>
            console.error(`${LOG_PREFIX} Failed to close tab:`, err),
          );
        pendingTabCloses.delete(tabId);

        if (localActiveTabCount > 0) localActiveTabCount--;
        processQueues();
      }, pendingInfo.waitTime);
    }
  }
});

function getActiveExtensionTabCount() {
  return localActiveTabCount;
}

// --- Unified Queue Processor ---

async function processQueues() {
  const state = await getProcessingState();
  if (!state.isRunning || state.shouldStop) {
    console.log(
      `${LOG_PREFIX} Process queues halted: Running=${state.isRunning}, Stop=${state.shouldStop}`,
    );
    return;
  }

  const currentTabs = getActiveExtensionTabCount();
  const capacity = state.maxConcurrentTabs - currentTabs;

  if (capacity <= 0) {
    console.log(
      `${LOG_PREFIX} At max capacity (${currentTabs}/${state.maxConcurrentTabs}). Waiting...`,
    );
    return;
  }

  let urlToOpen = null;
  let type = "";

  if (pageUrlQueue.length > 0) {
    urlToOpen = pageUrlQueue.shift();
    type = "page";
    console.log(
      `${LOG_PREFIX} Opening PAGE from queue. Remaining pages: ${pageUrlQueue.length}`,
    );
  } else if (videoUrlQueue.length > 0) {
    urlToOpen = videoUrlQueue.shift();
    type = "video";
    console.log(
      `${LOG_PREFIX} Opening VIDEO from queue. Remaining videos: ${videoUrlQueue.length}`,
    );
  }

  if (urlToOpen) {
    console.log(`${LOG_PREFIX} Creating tab for: ${urlToOpen}`);
    localActiveTabCount++;

    chrome.tabs.create(
      {
        url: urlToOpen,
        active: false,
      },
      (tab) => {
        if (chrome.runtime.lastError) {
          console.error(
            `${LOG_PREFIX} Failed to create tab:`,
            chrome.runtime.lastError,
          );
          if (localActiveTabCount > 0) localActiveTabCount--;
          setTimeout(processQueues, 100);
          return;
        }

        if (state.autoCloseTabs) {
          pendingTabCloses.set(tab.id, {
            url: urlToOpen,
            type: type,
            createdAt: Date.now(),
            waitTime: state.jsWaitTime,
          });
        }

        setTimeout(processQueues, state.tabOpenDelay);
      },
    );
  } else {
    console.log(`${LOG_PREFIX} All queues empty. Processing finished.`);
    if (state.isRunning) {
      state.isRunning = false;
      saveProcessingState(state);
      updateBadge(state);
    }
  }
}

// --- Message Handling ---

chrome.action.onClicked.addListener(async (tab) => {
  console.log(`${LOG_PREFIX} Toolbar icon clicked`);
  const state = await getProcessingState();
  chrome.tabs
    .sendMessage(tab.id, {
      action: "forceShowPanel",
      state: state,
    })
    .catch((e) => {
      console.warn(`${LOG_PREFIX} Could not send message to show panel:`, e);
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(`${LOG_PREFIX} Received message:`, message.action);
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message, sender, sendResponse) {
  if (message.action === "toggleState") {
    let state = await getProcessingState();

    if (state.isRunning) {
      console.log(`${LOG_PREFIX} STOPPING processing via panel...`);
      state.isRunning = false;
      state.shouldStop = true;
      videoUrlQueue = [];
      pageUrlQueue = [];
      await saveProcessingState(state);
      updateBadge(state);
      sendResponse({ success: true, isRunning: false });
    } else {
      const url = sender.tab ? sender.tab.url : "";
      // Updated Regex to handle optional ?page=1
      const searchMatch = url.match(
        /\/en\/search\/([a-zA-Z0-9]+)-(\?page=(\d+))?/,
      );

      if (!searchMatch) {
        console.warn(
          `${LOG_PREFIX} Cannot start: Not on a valid search page. URL: ${url}`,
        );
        sendResponse({ success: false, error: "Not on search page" });
        return;
      }

      const code = searchMatch[1];
      // Default to page 1 if parameter is missing
      const pageNum = searchMatch[3] ? parseInt(searchMatch[3]) : 1;

      console.log(
        `${LOG_PREFIX} STARTING processing for code: ${code}, page: ${pageNum}`,
      );

      localActiveTabCount = 0;

      state = {
        ...DEFAULT_STATE,
        isRunning: true,
        code: code,
        currentPage: pageNum,
        shouldStop: false,
        openVideos: state.openVideos,
      };

      videoUrlQueue = [];
      pageUrlQueue = [];
      await saveProcessingState(state);
      updateBadge(state);

      chrome.tabs.sendMessage(sender.tab.id, {
        action: "initializeBatchProcess",
        code: state.code,
        pageNum: state.currentPage,
        tabId: sender.tab.id,
        state: state,
      });

      sendResponse({ success: true, isRunning: true });
    }
  } else if (message.action === "updateSettings") {
    console.log(`${LOG_PREFIX} Updating settings:`, message.updates);
    let state = await getProcessingState();
    state = { ...state, ...message.updates };
    await saveProcessingState(state);
    sendResponse({ success: true, state });
  } else if (message.action === "setPageQueue") {
    console.log(`${LOG_PREFIX} RECEIVED setPageQueue message`);
    const { pageUrls, totalPages } = message;

    // Get fresh state
    let state = await getProcessingState();

    console.log(
      `${LOG_PREFIX} Setting total pages to: ${totalPages}. Queue size: ${pageUrls.length}`,
    );

    state.totalPages = totalPages;

    // Filter out current page
    const currentPageUrl = `https://missav.ws/en/search/${state.code}-?page=${state.currentPage}`;
    pageUrlQueue = pageUrls.filter((url) => url !== currentPageUrl);

    console.log(
      `${LOG_PREFIX} Queue initialized. Pages to scan: ${pageUrlQueue.length}`,
    );

    await saveProcessingState(state);
    updateBadge(state);

    console.log(`${LOG_PREFIX} Starting queue processing...`);
    processQueues();

    sendResponse({ success: true });
  } else if (message.action === "extractedVideos") {
    console.log(`${LOG_PREFIX} RECEIVED extractedVideos message`);
    const { urls, pageNum } = message;

    // Get fresh state
    let state = await getProcessingState();

    if (state.openVideos) {
      console.log(
        `${LOG_PREFIX} Adding ${urls.length} videos from page ${pageNum} to video queue`,
      );
      videoUrlQueue.push(...urls);
      state.totalVideosOpened += urls.length;
    } else {
      console.log(
        `${LOG_PREFIX} Skipping video collection for page ${pageNum} (Setting disabled)`,
      );
    }

    state.totalPagesProcessed += 1;
    await saveProcessingState(state);
    updateBadge(state);

    chrome.tabs
      .sendMessage(sender.tab.id, {
        action: "updatePanel",
        state: state,
      })
      .catch(() => {});

    processQueues();

    sendResponse({ success: true });
  } else if (message.action === "getProcessingState") {
    sendResponse({ state: await getProcessingState() });
  }
}
