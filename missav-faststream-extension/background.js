// Watch for changes to the user's options & apply them
chrome.storage.onChanged.addListener((changes, area) => {
  console.log("[NISSAV BACKGROUND] Area:", area);
  console.log("[NISSAV BACKGROUND] Changes:", changes);
  if (area === "sync") {
    // Log changes
  }
});
