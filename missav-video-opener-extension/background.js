// Jet_Apps/web-extensions/smart-web-extensions/missav-video-opener-extension/background.js
const LOG_PREFIX = "[MissAV-BG]";
const SERVER_URL = "http://127.0.0.1:9001";
const INGEST_ENDPOINT = `${SERVER_URL}/ingest`;
const MAX_FETCH_PAGES = 20;
const MAX_RETRIES_PER_VIDEO = 3;
const DEFAULT_STATE = {
  isRunning: false,
  code: null,
  currentPage: 0,
  totalPages: 0,
  totalPagesProcessed: 0,
  totalVideosOpened: 0,
  collectedCount: 0,
  ingestedCount: 0,
  incompleteCount: 0,
  pendingIngestCount: 0,
  lastIngest: null,
  shouldStop: false,
  autoCloseTabs: true,
  openVideos: true,
  jsWaitTime: 12000,
  pageDelay: 1000,
  tabOpenDelay: 500,
  maxConcurrentTabs: 20,
};
let processingState = { ...DEFAULT_STATE };
let videoUrlQueue = [];
let pageUrlQueue = [];
let pendingTabCloses = new Map();
let localActiveTabCount = 0;
let existingVideoIds = new Set();
let retryCounts = new Map();
let lastPendingIdsPreview = [];
const DEBUG = true;
function log(...args) {
  if (DEBUG) console.log(LOG_PREFIX, ...args);
}
function logState(state, label) {
  if (!DEBUG) return;
  console.groupCollapsed(`${LOG_PREFIX} state: ${label}`);
  console.table({
    isRunning: state.isRunning,
    code: state.code,
    currentPage: state.currentPage,
    totalPages: state.totalPages,
    totalPagesProcessed: state.totalPagesProcessed,
    totalVideosOpened: state.totalVideosOpened,
    collectedCount: state.collectedCount,
    ingestedCount: state.ingestedCount,
    incompleteCount: state.incompleteCount,
    pendingIngestCount: state.pendingIngestCount,
    activeTabs: localActiveTabCount,
    videoQueue: videoUrlQueue.length,
    pageQueue: pageUrlQueue.length,
    pendingCloses: pendingTabCloses.size,
  });
  console.groupEnd();
}
async function getProcessingState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["processingState"], (result) => {
      processingState = { ...DEFAULT_STATE, ...(result.processingState || {}) };
      resolve(processingState);
    });
  });
}
async function saveProcessingState(state, reason = "") {
  processingState = state;
  if (DEBUG && reason) log(`saveProcessingState (${reason})`);
  return new Promise((resolve) => {
    chrome.storage.local.set({ processingState: state }, () => resolve());
  });
}
function updateBadge(state) {
  if (state.isRunning) {
    chrome.action.setBadgeText({
      text: `${state.totalPagesProcessed}/${state.totalPages || "?"}`,
    });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}
async function refreshPendingPreview() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["pendingIngestQueue"], (result) => {
      const queue = result.pendingIngestQueue || [];
      lastPendingIdsPreview = queue.slice(-8).map((i) => i.id);
      resolve(queue.length);
    });
  });
}
async function fetchExistingVideoIds(code) {
  if (!code) return new Set();
  log(`fetchExistingVideoIds code=${code} …`);
  const ids = new Set();
  const limit = 5000;
  let offset = 0,
    pageCount = 0;
  while (pageCount < MAX_FETCH_PAGES) {
    const url =
      `${SERVER_URL}/videos?code=${encodeURIComponent(code)}` +
      `&completion_filter=complete&fields=id&limit=${limit}&offset=${offset}`;
    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log(`fetchExistingVideoIds: HTTP ${res.status}`);
        break;
      }
      data = await res.json();
    } catch (err) {
      log(`fetchExistingVideoIds: fetch failed`, err);
      break;
    }
    if (!data.items || data.items.length === 0) break;
    for (const item of data.items) if (item.id) ids.add(item.id);
    log(
      `fetchExistingVideoIds: page ${pageCount} += ${data.items.length} (total ${ids.size})`,
    );
    if (data.items.length < limit) break;
    offset += limit;
    pageCount++;
  }
  log(`fetchExistingVideoIds: ${ids.size} existing complete IDs for ${code}`);
  return ids;
}
// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (pendingTabCloses.has(tabId) && changeInfo.status === "complete") {
    const pendingInfo = pendingTabCloses.get(tabId);
    log(
      `tab ${tabId} complete → will close in ${pendingInfo.waitTime}ms (url=${tab?.url || "?"})`,
    );
    setTimeout(async () => {
      let ran = "unknown";
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            singleRan: window.__missavSingleRan === true,
            singleLog: window.__missavSingleLastLog || null,
            href: location.href,
          }),
        });
        ran = result?.singleRan;
        log(
          `tab ${tabId} pre-close: singleRan=${result?.singleRan} last=${result?.singleLog} href=${result?.href}`,
        );
      } catch (e) {
        log(
          `tab ${tabId} pre-close probe failed (tab may already be gone): ${e?.message}`,
        );
      }
      chrome.tabs.remove(tabId).catch(() => {});
      pendingTabCloses.delete(tabId);
      if (localActiveTabCount > 0) localActiveTabCount--;
      log(
        `tab ${tabId} closed. activeTabCount=${localActiveTabCount} singleRan=${ran}`,
      );
      processQueues();
    }, pendingInfo.waitTime);
  }
});
async function processQueues() {
  const state = await getProcessingState();
  if (
    !state.isRunning &&
    pageUrlQueue.length === 0 &&
    videoUrlQueue.length === 0
  ) {
    log(`processQueues: not running and queues empty, idle`);
    return;
  }
  if (state.shouldStop) {
    log(`processQueues: shouldStop=true, not launching new tabs`);
    return;
  }
  const capacity = state.maxConcurrentTabs - localActiveTabCount;
  if (capacity <= 0) return;
  let urlToOpen = null,
    source = null;
  if (pageUrlQueue.length > 0) {
    urlToOpen = pageUrlQueue.shift();
    source = "pageQueue";
  } else if (videoUrlQueue.length > 0) {
    urlToOpen = videoUrlQueue.shift();
    source = "videoQueue";
  }
  if (urlToOpen) {
    log(
      `processQueues: opening [${source}] ${urlToOpen} (active=${localActiveTabCount + 1})`,
    );
    localActiveTabCount++;
    chrome.tabs.create({ url: urlToOpen, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        log(
          `processQueues: tabs.create error`,
          chrome.runtime.lastError.message,
        );
        if (localActiveTabCount > 0) localActiveTabCount--;
        setTimeout(processQueues, 100);
        return;
      }
      log(`processQueues: tab ${tab.id} created → ${urlToOpen}`);
      if (state.autoCloseTabs)
        pendingTabCloses.set(tab.id, { waitTime: state.jsWaitTime });
      setTimeout(processQueues, state.tabOpenDelay);
    });
  } else {
    if (localActiveTabCount === 0 && pendingTabCloses.size === 0) {
      log(`processQueues: all queues empty and no active tabs → finishing`);
      if (state.isRunning) {
        state.isRunning = false;
        state.shouldStop = false;
        await saveProcessingState(state, "queues drained");
        updateBadge(state);
        chrome.runtime
          .sendMessage({ action: "updatePanel", state })
          .catch(() => {});
        await autoIngestPending();
      }
    } else {
      log(
        `processQueues: queues empty but still in flight (tabs=${localActiveTabCount}, pendingCloses=${pendingTabCloses.size})`,
      );
    }
  }
}
async function autoIngestPending() {
  const queue = await new Promise((resolve) => {
    chrome.storage.local.get(["pendingIngestQueue"], (r) =>
      resolve(r.pendingIngestQueue || []),
    );
  });
  if (queue.length === 0) {
    log("autoIngestPending: queue empty, nothing to ingest");
    return;
  }
  try {
    const CHUNK_SIZE = 500;
    let totalInserted = 0,
      totalUpdated = 0,
      totalSkipped = 0;
    for (let i = 0; i < queue.length; i += CHUNK_SIZE) {
      const chunk = queue.slice(i, i + CHUNK_SIZE);
      log(
        `autoIngestPending: chunk ${Math.floor(i / CHUNK_SIZE) + 1} size=${chunk.length}`,
      );
      const resp = await ingestBatchToServer(chunk);
      totalInserted += resp.inserted || 0;
      totalUpdated += resp.updated || 0;
      totalSkipped += resp.skipped || 0;
    }
    chrome.storage.local.set({ pendingIngestQueue: [] });
    let state = await getProcessingState();
    state.ingestedCount =
      (state.ingestedCount || 0) + totalInserted + totalUpdated;
    state.pendingIngestCount = 0;
    state.lastIngest = {
      inserted: totalInserted,
      updated: totalUpdated,
      skipped: totalSkipped,
      took_ms: 0,
      at: new Date().toISOString(),
    };
    lastPendingIdsPreview = [];
    await saveProcessingState(state, "auto ingest");
    updateBadge(state);
    chrome.runtime
      .sendMessage({ action: "updatePanel", state })
      .catch(() => {});
    log(
      `autoIngestPending: done ins=${totalInserted} upd=${totalUpdated} skip=${totalSkipped}`,
    );
  } catch (err) {
    log("autoIngestPending: error", err);
  }
}
chrome.action.onClicked.addListener(async (tab) => {
  log(`action clicked on tab ${tab.id}`);
  const state = await getProcessingState();
  chrome.tabs
    .sendMessage(tab.id, { action: "forceShowPanel", state })
    .catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log(
    `→ message: ${message?.action} from tab ${sender?.tab?.id} url=${sender?.tab?.url}`,
  );
  handleMessage(message, sender, sendResponse);
  return true;
});
async function handleMessage(message, sender, sendResponse) {
  if (message.action === "toggleState") {
    let state = await getProcessingState();
    if (state.isRunning) {
      log("toggleState: STOP");
      state.isRunning = false;
      state.shouldStop = true;
      videoUrlQueue = [];
      pageUrlQueue = [];
      chrome.storage.local.set({ pendingIngestQueue: [] });
      await saveProcessingState(state, "toggle stop");
      updateBadge(state);
      logState(state, "after stop");
      sendResponse({ success: true, isRunning: false });
      return;
    }
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: "No tab context" });
      return;
    }
    const url = sender.tab.url;
    const searchMatch = url.match(/\/en\/search\/([a-zA-Z0-9]+)-/);
    if (!searchMatch) {
      sendResponse({ success: false, error: "Not on search page" });
      return;
    }
    const code = searchMatch[1];
    const pageMatch = url.match(/[?&]page=(\d+)/);
    const pageNum = pageMatch ? parseInt(pageMatch[1]) : 1;
    log(`toggleState: START code=${code} startPage=${pageNum}`);
    localActiveTabCount = 0;
    retryCounts = new Map();
    lastPendingIdsPreview = [];
    existingVideoIds = await fetchExistingVideoIds(code);
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
    chrome.storage.local.set({ pendingIngestQueue: [] });
    await saveProcessingState(state, "toggle start");
    updateBadge(state);
    logState(state, "after start");
    chrome.tabs.sendMessage(tabId, {
      action: "initializeBatchProcess",
      code: state.code,
      pageNum: state.currentPage,
      tabId,
      state,
    });
    sendResponse({ success: true, isRunning: true });
    return;
  }
  if (message.action === "updateSettings") {
    let state = await getProcessingState();
    state = { ...state, ...message.updates };
    log("updateSettings:", message.updates);
    await saveProcessingState(state, "updateSettings");
    sendResponse({ success: true, state });
    return;
  }
  if (message.action === "setPageQueue") {
    const { pageUrls, totalPages } = message;
    let state = await getProcessingState();
    state.totalPages = totalPages;
    const currentPageUrl = `https://missav.ws/en/search/${state.code}-?page=${state.currentPage}`;
    pageUrlQueue = pageUrls.filter((u) => u !== currentPageUrl);
    log(`setPageQueue: totalPages=${totalPages}, queue=${pageUrlQueue.length}`);
    await saveProcessingState(state, "setPageQueue");
    updateBadge(state);
    logState(state, "after setPageQueue");
    processQueues();
    sendResponse({ success: true });
    return;
  }
  if (message.action === "extractedVideos") {
    const { items, pageNum } = message;
    let state = await getProcessingState();
    log(
      `extractedVideos: page=${pageNum} items=${items.length} (existingIds=${existingVideoIds.size})`,
    );
    // Filter out videos already complete in DB.
    const newItems = items.filter(
      (it) => it.id && !existingVideoIds.has(it.id),
    );
    const skippedExisting = items.length - newItems.length;
    log(
      `extractedVideos: new=${newItems.length} skippedExisting=${skippedExisting}`,
    );
    // Optionally open video tabs for enrichment (only when openVideos is true).
    if (state.openVideos && newItems.length > 0) {
      const urls = newItems.map((i) => i.url).filter(Boolean);
      videoUrlQueue.push(...urls);
      state.totalVideosOpened += urls.length;
      log(
        `extractedVideos: videoQueue=${videoUrlQueue.length}, totalVideosOpened=${state.totalVideosOpened}`,
      );
    }
    // Enqueue incomplete items for ingestion.
    if (newItems.length > 0) {
      await new Promise((resolve) => {
        chrome.storage.local.get(["pendingIngestQueue"], (result) => {
          const queue = result.pendingIngestQueue || [];
          const inQueue = new Set(queue.map((i) => i.id));
          const uniqueNew = newItems.filter((i) => !inQueue.has(i.id));
          if (uniqueNew.length > 0) {
            const next = [...queue, ...uniqueNew];
            chrome.storage.local.set({ pendingIngestQueue: next }, () => {
              log(
                `extractedVideos: pendingIngestQueue +${uniqueNew.length} → ${next.length} [${uniqueNew.map((i) => i.id).join(",")}]`,
              );
              resolve();
            });
          } else {
            resolve();
          }
        });
      });
    }
    // Refresh pending count from the real queue.
    const pendingCount = await new Promise((resolve) => {
      chrome.storage.local.get(["pendingIngestQueue"], (r) =>
        resolve((r.pendingIngestQueue || []).length),
      );
    });
    // Live progress update.
    state.totalPagesProcessed += 1;
    state.collectedCount = (state.collectedCount || 0) + newItems.length;
    state.pendingIngestCount = pendingCount;
    lastPendingIdsPreview = await new Promise((resolve) => {
      chrome.storage.local.get(["pendingIngestQueue"], (r) => {
        const q = r.pendingIngestQueue || [];
        resolve(q.slice(-8).map((i) => i.id));
      });
    });
    log(
      `extractedVideos: totalPagesProcessed → ${state.totalPagesProcessed}/${state.totalPages}, collected=${state.collectedCount}, pending=${pendingCount}`,
    );
    await saveProcessingState(state, "extractedVideos");
    updateBadge(state);
    if (sender.tab && sender.tab.id) {
      chrome.tabs
        .sendMessage(sender.tab.id, { action: "updatePanel", state })
        .catch(() => {});
    }
    processQueues();
    sendResponse({ success: true });
    return;
  }
  if (message.action === "videoCompleted") {
    const { metadata } = message;
    if (!metadata || !metadata.id) {
      log("videoCompleted: missing metadata");
      sendResponse({ success: false, error: "No metadata" });
      return;
    }
    log(
      `videoCompleted: id=${metadata.id} video_id=${metadata.video_id} title="${(metadata.title || "").slice(0, 60)}"`,
    );
    retryCounts.delete(metadata.id);
    chrome.storage.local.get(["pendingIngestQueue"], (result) => {
      let queue = result.pendingIngestQueue || [];
      const existingIndex = queue.findIndex((item) => item.id === metadata.id);
      if (existingIndex !== -1) {
        log(`videoCompleted: Updating existing item at index ${existingIndex}`);
        queue[existingIndex] = { ...queue[existingIndex], ...metadata };
      } else {
        log(`videoCompleted: Adding new item to queue`);
        queue.push(metadata);
      }
      chrome.storage.local.set({ pendingIngestQueue: queue }, async () => {
        let state = await getProcessingState();
        state.collectedCount = (state.collectedCount || 0) + 1;
        state.pendingIngestCount = queue.length;
        lastPendingIdsPreview = queue.slice(-8).map((i) => i.id);
        log(
          `videoCompleted: collectedCount → ${state.collectedCount}, pending → ${queue.length}`,
        );
        await saveProcessingState(state, "videoCompleted");
        updateBadge(state);
        chrome.runtime
          .sendMessage({ action: "updatePanel", state })
          .catch(() => {});
        sendResponse({ success: true, queueLength: queue.length });
      });
    });
    return true;
  }
  if (message.action === "markVideoIncomplete") {
    const { videoId, url } = message;
    if (!videoId) {
      sendResponse({ success: false, error: "No videoId" });
      return;
    }
    existingVideoIds.delete(videoId);
    const retries = (retryCounts.get(videoId) || 0) + 1;
    retryCounts.set(videoId, retries);
    log(
      `markVideoIncomplete: ${videoId} attempt ${retries}/${MAX_RETRIES_PER_VIDEO}`,
    );
    (async () => {
      let state = await getProcessingState();
      state.incompleteCount = (state.incompleteCount || 0) + 1;
      if (
        retries < MAX_RETRIES_PER_VIDEO &&
        url &&
        state.isRunning &&
        !state.shouldStop
      ) {
        videoUrlQueue.push(url);
        log(
          `markVideoIncomplete: re-queued ${videoId} (videoQueue=${videoUrlQueue.length})`,
        );
      } else if (retries >= MAX_RETRIES_PER_VIDEO) {
        log(
          `markVideoIncomplete: giving up on ${videoId} after ${retries} retries`,
        );
      }
      await saveProcessingState(state, "markVideoIncomplete");
      updateBadge(state);
      processQueues();
      sendResponse({ success: true, retries });
    })();
    return true;
  }
  if (message.action === "getProcessingState") {
    const state = await getProcessingState();
    state.pendingIngestCount = await refreshPendingPreview();
    sendResponse({ state, pendingIds: lastPendingIdsPreview });
    return;
  }
  if (message.action === "triggerBatchIngest") {
    log("triggerBatchIngest: invoked");
    chrome.storage.local.get(["pendingIngestQueue"], async (result) => {
      let queue = result.pendingIngestQueue || [];
      log(`triggerBatchIngest: queue=${queue.length}`);
      if (queue.length === 0) {
        log("triggerBatchIngest: nothing to ingest");
        sendResponse({ success: true, inserted: 0, updated: 0, skipped: 0 });
        return;
      }
      try {
        const CHUNK_SIZE = 500;
        let totalInserted = 0;
        let totalUpdated = 0;
        let totalSkipped = 0;
        for (let i = 0; i < queue.length; i += CHUNK_SIZE) {
          const chunk = queue.slice(i, i + CHUNK_SIZE);
          log(
            `Processing chunk ${Math.floor(i / CHUNK_SIZE) + 1}, size: ${chunk.length}`,
          );
          const response = await ingestBatchToServer(chunk);
          totalInserted += response.inserted || 0;
          totalUpdated += response.updated || 0;
          totalSkipped += response.skipped || 0;
        }
        chrome.storage.local.set({ pendingIngestQueue: [] });
        let state = await getProcessingState();
        state.ingestedCount =
          (state.ingestedCount || 0) + (totalInserted + totalUpdated);
        state.pendingIngestCount = 0;
        state.lastIngest = {
          inserted: totalInserted,
          updated: totalUpdated,
          skipped: totalSkipped,
          took_ms: 0,
          at: new Date().toISOString(),
        };
        lastPendingIdsPreview = [];
        log(`triggerBatchIngest: Finished. Total inserted: ${totalInserted}`);
        await saveProcessingState(state, "batch ingest");
        updateBadge(state);
        chrome.runtime
          .sendMessage({ action: "updatePanel", state })
          .catch(() => {});
        sendResponse({
          success: true,
          inserted: totalInserted,
          updated: totalUpdated,
          skipped: totalSkipped,
        });
      } catch (err) {
        log("triggerBatchIngest: error", err);
        sendResponse({ success: false, error: err.message });
      }
    });
    return true;
  }
}
async function ingestBatchToServer(videoDataArray) {
  const payload = { items: videoDataArray, upsert: true };
  log(
    `ingestBatchToServer: POST ${INGEST_ENDPOINT} items=${videoDataArray.length}`,
  );
  const response = await fetch(INGEST_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return await response.json();
}
