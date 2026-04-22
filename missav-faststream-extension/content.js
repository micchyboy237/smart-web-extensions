// content.js
(() => {
  const isTopFrame = window === window.top;

  console.log(
    `✅ [MISSAV CONTENT] 📍 Content script started in ${isTopFrame ? "TOP FRAME" : "IFRAME"}`,
  );

  // 1. Inject the real main-world detector
  function injectMainWorldDetector() {
    if (document.getElementById("faststream-injector")) return;
    const script = document.createElement("script");
    script.id = "faststream-injector";
    script.src = chrome.runtime.getURL("injector.js");
    script.onload = () => {
      console.log(
        "✅ [MISSAV CONTENT] 📥 Main-world injector script successfully injected",
      );

      // Send worker URL immediately (only content script can call chrome.runtime.getURL)
      window.postMessage(
        {
          type: "FASTSTREAM_CONFIG",
          workerUrl: chrome.runtime.getURL("hls.worker.js"),
        },
        "*",
      );
      console.log(
        "✅ [MISSAV CONTENT] 📤 Sent worker URL config to main world",
      );
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // 2. Listen for detection messages from main world
  function listenForDetection() {
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "FASTSTREAM_HLS_DETECTED") {
        const { url, isMasterPlaylist } = event.data;

        console.log(
          `✅ [MISSAV CONTENT] 📨 Received HLS detection from main world: ${isMasterPlaylist ? "MASTER" : "MEDIA"} →`,
          url,
        );

        if (isMasterPlaylist) {
          console.log(
            "🔄 [MISSAV CONTENT] 📤 Sending START_PLAYER command to main world",
          );
          window.postMessage(
            {
              type: "FASTSTREAM_START_PLAYER",
              url: url,
            },
            "*",
          );
        }
      }
    });
  }

  function init() {
    injectMainWorldDetector();
    listenForDetection();
    console.log(
      "🚀 [MISSAV CONTENT] ✅ Extension initialized — main-world detection + player ready",
    );
  }

  init();
})();
