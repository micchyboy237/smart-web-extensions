// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_AND_OPEN") {
    handleCheckAndOpen(message.url)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ opened: false, error: err.message }));
    // Return true to indicate async response
    return true;
  }

  if (message.type === "GET_OPENED_COUNT") {
    sendResponse({ count: openedCount });
    return false;
  }
});

let openedCount = 0;

async function handleCheckAndOpen(url) {
  try {
    // Query ALL open tabs across all windows
    const tabs = await chrome.tabs.query({});

    // Check if any tab already has this URL open
    const isDuplicate = tabs.some((tab) => {
      if (!tab.url) return false;
      // Normalize both URLs for comparison (strip trailing slashes, fragments)
      const normalizeUrl = (u) => {
        try {
          const parsed = new URL(u);
          return parsed.origin + parsed.pathname;
        } catch {
          return u;
        }
      };
      return normalizeUrl(tab.url) === normalizeUrl(url);
    });

    if (isDuplicate) {
      return { opened: false, duplicate: true };
    }

    // Open new tab
    await chrome.tabs.create({ url, active: false });
    openedCount++;
    return { opened: true, duplicate: false };
  } catch (err) {
    throw new Error(`Failed to open tab: ${err.message}`);
  }
}
