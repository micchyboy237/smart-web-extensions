// background.js
console.log("Video Observer background service running");

let logs = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VIDEO_LOG") {
    logs.unshift(message.log); // Add to top
    if (logs.length > 100) logs.pop(); // Keep last 100 logs
  }

  if (message.type === "GET_LOGS") {
    sendResponse({ logs });
  }
});
