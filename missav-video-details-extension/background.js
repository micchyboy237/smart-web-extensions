// Jet_Apps/web-extensions/smart-web-extensions/missav-video-opener-extension/background.js
const LOG_PREFIX = "[MissAV-BG]";
const SERVER_URL = "http://127.0.0.1:9001";
const INGEST_ENDPOINT = `${SERVER_URL}/ingest`;
const MAX_FETCH_PAGES = 20;
const MAX_RETRIES_PER_VIDEO = 3;
const INGEST_CHUNK_SIZE = 100; // NEW: auto-ingest threshold + server chunk size
const INCOMPLETE_QUEUE_KEY = "pendingIncompleteIngestQueue"; // NEW
const COMPLETE_QUEUE_KEY = "pendingCompleteIngestQueue"; // NEW
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
  pendingIngestCount: 0, // total = incomplete + complete (kept for UI)
  pendingIncompleteCount: 0, // NEW
  pendingCompleteCount: 0, // NEW
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
// NEW: serialize all reads/writes to the two queues so concurrent messages
// (many search-page tabs + video tabs finishing at once) cannot clobber each other.
let ingestLock = Promise.resolve();
function withIngestLock(fn) {
  const run = ingestLock.then(fn, fn);
  ingestLock = run.catch(() => {});
  return run;
}
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
    pendingIncompleteCount: state.pendingIncompleteCount,
    pendingCompleteCount: state.pendingCompleteCount,
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
// ---------- Two-queue helpers ----------
function _getQueues() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [INCOMPLETE_QUEUE_KEY, COMPLETE_QUEUE_KEY],
      (r) => {
        resolve({
          incomplete: r[INCOMPLETE_QUEUE_KEY] || [],
          complete: r[COMPLETE_QUEUE_KEY] || [],
        });
      },
    );
  });
}
function _setQueues({ incomplete, complete }) {
  return new Promise((resolve) => {
    const payload = {};
    if (incomplete !== undefined) payload[INCOMPLETE_QUEUE_KEY] = incomplete;
    if (complete !== undefined) payload[COMPLETE_QUEUE_KEY] = complete;
    chrome.storage.local.set(payload, () => resolve());
  });
}
async function _clearAllQueues() {
  return _setQueues({ incomplete: [], complete: [] });
}
async function _refreshPendingPreview() {
  const { incomplete, complete } = await _getQueues();
  // Preview the most-recent 8 from the complete queue (more enriched), then incomplete.
  const combined = [...complete, ...incomplete];
  lastPendingIdsPreview = combined.slice(-8).map((i) => i.id);
  return {
    pendingIncompleteCount: incomplete.length,
    pendingCompleteCount: complete.length,
    pendingIngestCount: incomplete.length + complete.length,
  };
}
async function _syncCountsIntoState(reason = "") {
  const counts = await _refreshPendingPreview();
  let state = await getProcessingState();
  state.pendingIncompleteCount = counts.pendingIncompleteCount;
  state.pendingCompleteCount = counts.pendingCompleteCount;
  state.pendingIngestCount = counts.pendingIngestCount;
  await saveProcessingState(state, reason || "sync counts");
  updateBadge(state);
  chrome.runtime.sendMessage({ action: "updatePanel", state }).catch(() => {});
  return state;
}
// ---------- Auto-ingest: drains a single queue in chunks of INGEST_CHUNK_SIZE ----------
async function _drainQueue(queueKey, label) {
  return withIngestLock(async () => {
    const { incomplete, complete } = await _getQueues();
    const queue = queueKey === INCOMPLETE_QUEUE_KEY ? incomplete : complete;
    if (queue.length === 0) {
      log(`_drainQueue(${label}): empty, nothing to do`);
      return { inserted: 0, updated: 0, skipped: 0, drained: 0 };
    }
    log(`_drainQueue(${label}): draining ${queue.length} items`);
    let inserted = 0,
      updated = 0,
      skipped = 0,
      drained = 0;
    // Take a stable snapshot; clear the queue up front so concurrent appends
    // during the POSTs land in the *next* batch, not this one.
    const batch = queue.slice();
    if (queueKey === INCOMPLETE_QUEUE_KEY) {
      await _setQueues({ incomplete: [] });
    } else {
      await _setQueues({ complete: [] });
    }
    for (let i = 0; i < batch.length; i += INGEST_CHUNK_SIZE) {
      const chunk = batch.slice(i, i + INGEST_CHUNK_SIZE);
      log(
        `_drainQueue(${label}): chunk ${Math.floor(i / INGEST_CHUNK_SIZE) + 1} size=${chunk.length}`,
      );
      try {
        const resp = await ingestBatchToServer(chunk);
        inserted += resp.inserted || 0;
        updated += resp.updated || 0;
        skipped += resp.skipped || 0;
        drained += chunk.length;
      } catch (err) {
        log(
          `_drainQueue(${label}): chunk failed, re-queueing ${chunk.length} items`,
          err,
        );
        // Re-append failed chunk to the *front* of the queue for retry next drain.
        const { incomplete: inc2, complete: com2 } = await _getQueues();
        if (queueKey === INCOMPLETE_QUEUE_KEY) {
          await _setQueues({ incomplete: [...chunk, ...inc2] });
        } else {
          await _setQueues({ complete: [...chunk, ...com2] });
        }
        break;
      }
    }
    // Update cumulative counters.
    let state = await getProcessingState();
    state.ingestedCount = (state.ingestedCount || 0) + inserted + updated;
    state.lastIngest = {
      inserted,
      updated,
      skipped,
      took_ms: 0,
      at: new Date().toISOString(),
      queue: label,
    };
    await saveProcessingState(state, `drain ${label}`);
    await _syncCountsIntoState(`after drain ${label}`);
    log(
      `_drainQueue(${label}): done ins=${inserted} upd=${updated} skip=${skipped} drained=${drained}`,
    );
    return { inserted, updated, skipped, drained };
  });
}
// Threshold check: if either queue is at/over INGEST_CHUNK_SIZE, drain it.
async function maybeAutoIngest() {
  const { incomplete, complete } = await _getQueues();
  if (incomplete.length >= INGEST_CHUNK_SIZE) {
    log(
      `maybeAutoIngest: incomplete=${incomplete.length} >= ${INGEST_CHUNK_SIZE} → drain`,
    );
    await _drainQueue(INCOMPLETE_QUEUE_KEY, "incomplete");
  }
  if (complete.length >= INGEST_CHUNK_SIZE) {
    log(
      `maybeAutoIngest: complete=${complete.length} >= ${INGEST_CHUNK_SIZE} → drain`,
    );
    await _drainQueue(COMPLETE_QUEUE_KEY, "complete");
  }
}
// Final flush: drain whatever remains in both queues (called at run end).
async function flushAllQueues() {
  log("flushAllQueues: final flush of both queues");
  await _drainQueue(INCOMPLETE_QUEUE_KEY, "incomplete");
  await _drainQueue(COMPLETE_QUEUE_KEY, "complete");
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
        await flushAllQueues(); // NEW: final flush of both queues
      }
    } else {
      log(
        `processQueues: queues empty but still in flight (tabs=${localActiveTabCount}, pendingCloses=${pendingTabCloses.size})`,
      );
    }
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
      await _clearAllQueues();
      await saveProcessingState(state, "toggle stop");
      await _syncCountsIntoState("after stop");
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
    await _clearAllQueues();
    await saveProcessingState(state, "toggle start");
    await _syncCountsIntoState("after start");
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
    // 1) Filter out DB-complete ids.
    const newItems = items.filter(
      (it) => it.id && !existingVideoIds.has(it.id),
    );
    log(
      `extractedVideos: new=${newItems.length} skippedExisting=${items.length - newItems.length}`,
    );
    // 2) openVideos → enqueue video URLs for enrichment.
    if (state.openVideos && newItems.length > 0) {
      const urls = newItems.map((i) => i.url).filter(Boolean);
      videoUrlQueue.push(...urls);
      state.totalVideosOpened += urls.length;
      log(
        `extractedVideos: videoQueue=${videoUrlQueue.length}, totalVideosOpened=${state.totalVideosOpened}`,
      );
    }
    // 3) Append to INCOMPLETE queue (deduped against existing incomplete AND complete).
    if (newItems.length > 0) {
      await withIngestLock(async () => {
        const { incomplete, complete } = await _getQueues();
        const inIncomplete = new Set(incomplete.map((i) => i.id));
        const inComplete = new Set(complete.map((i) => i.id));
        const uniqueNew = newItems.filter(
          (i) => !inIncomplete.has(i.id) && !inComplete.has(i.id),
        );
        if (uniqueNew.length > 0) {
          await _setQueues({ incomplete: [...incomplete, ...uniqueNew] });
          log(
            `extractedVideos: incompleteQueue +${uniqueNew.length} → ${incomplete.length + uniqueNew.length}`,
          );
        }
      });
    }
    // 4) Live progress + auto-ingest threshold check.
    state.totalPagesProcessed += 1;
    state.collectedCount = (state.collectedCount || 0) + newItems.length;
    await saveProcessingState(state, "extractedVideos");
    await _syncCountsIntoState("after extractedVideos");
    await maybeAutoIngest();
    if (sender.tab && sender.tab.id) {
      chrome.tabs
        .sendMessage(sender.tab.id, {
          action: "updatePanel",
          state: processingState,
        })
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
    await withIngestLock(async () => {
      const { incomplete, complete } = await _getQueues();
      // Remove from incomplete (it's now fully covered by the complete queue).
      const filteredIncomplete = incomplete.filter((i) => i.id !== metadata.id);
      const removedFromIncomplete =
        incomplete.length - filteredIncomplete.length;
      // Upsert into complete.
      const idx = complete.findIndex((i) => i.id === metadata.id);
      let nextComplete;
      if (idx !== -1) {
        nextComplete = complete.slice();
        nextComplete[idx] = { ...complete[idx], ...metadata };
      } else {
        nextComplete = [...complete, metadata];
      }
      await _setQueues({
        incomplete: filteredIncomplete,
        complete: nextComplete,
      });
      log(
        `videoCompleted: incomplete ${incomplete.length}→${filteredIncomplete.length} (removed=${removedFromIncomplete}), complete ${complete.length}→${nextComplete.length}`,
      );
    });
    let state = await getProcessingState();
    state.collectedCount = (state.collectedCount || 0) + 1;
    await saveProcessingState(state, "videoCompleted");
    await _syncCountsIntoState("after videoCompleted");
    await maybeAutoIngest();
    sendResponse({ success: true });
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
    const counts = await _refreshPendingPreview();
    state.pendingIncompleteCount = counts.pendingIncompleteCount;
    state.pendingCompleteCount = counts.pendingCompleteCount;
    state.pendingIngestCount = counts.pendingIngestCount;
    sendResponse({ state, pendingIds: lastPendingIdsPreview });
    return;
  }
  if (message.action === "triggerBatchIngest") {
    log("triggerBatchIngest: invoked → flush both queues");
    try {
      await flushAllQueues();
      const state = await getProcessingState();
      sendResponse({
        success: true,
        inserted: state.lastIngest?.inserted || 0,
        updated: state.lastIngest?.updated || 0,
        skipped: state.lastIngest?.skipped || 0,
      });
    } catch (err) {
      log("triggerBatchIngest: error", err);
      sendResponse({ success: false, error: err.message });
    }
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
