(() => {
  console.log("🔥 [FastStream] content.js loaded");

  const player = document.createElement("script");
  player.src = chrome.runtime.getURL("mp4-player.js");
  (document.head || document.documentElement).appendChild(player);

  const mp4box = document.createElement("script");
  mp4box.src = chrome.runtime.getURL("mp4box.js");
  mp4box.onload = () => {
    console.log("✅ mp4box loaded");

    const injector = document.createElement("script");
    injector.src = chrome.runtime.getURL("injector.js");
    (document.head || document.documentElement).appendChild(injector);
  };
  (document.head || document.documentElement).appendChild(mp4box);
})();
