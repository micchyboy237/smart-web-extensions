(() => {
  console.log("🔥 [FastStream] content.js loaded");

  // Load MP4Box as module to fix 'export' syntax error
  const mp4box = document.createElement("script");
  mp4box.src = chrome.runtime.getURL("mp4box.js");
  mp4box.type = "module"; // ← Critical fix for export syntax
  mp4box.onload = () => {
    console.log("✅ mp4box.js loaded as module");
    const injector = document.createElement("script");
    injector.src = chrome.runtime.getURL("injector.js");
    (document.head || document.documentElement).appendChild(injector);
  };
  (document.head || document.documentElement).appendChild(mp4box);

  // mp4-player.js is loaded via injector when needed
})();
