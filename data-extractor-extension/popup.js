const containerInput = document.getElementById("containerInput");
const urlInput = document.getElementById("urlInput");
const textInput = document.getElementById("textInput");
const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");
const refreshBtn = document.getElementById("refreshBtn");

const DEFAULT_CONFIG = {
  containerSelector: ".text-secondary",
  urlSelector: "",
  textSelector: "",
};

// Load saved config + immediately show preview
chrome.storage.sync.get("config", (data) => {
  const c = data.config || DEFAULT_CONFIG;
  containerInput.value = c.containerSelector || "";
  urlInput.value = c.urlSelector || "";
  textInput.value = c.textSelector || "";

  refreshData(); // ← show data right away
});

// Save config + refresh preview instantly
saveBtn.addEventListener("click", () => {
  const config = {
    containerSelector:
      containerInput.value.trim() || DEFAULT_CONFIG.containerSelector,
    urlSelector: urlInput.value.trim(),
    textSelector: textInput.value.trim(),
  };

  chrome.storage.sync.set({ config }, () => {
    status.textContent = "✅ Saved and applied to all tabs!";
    setTimeout(() => (status.textContent = ""), 2500);
    refreshData(); // ← refresh preview with new selectors
  });
});

refreshBtn.addEventListener("click", refreshData);

// ==================== FETCH DATA FROM CONTENT SCRIPT & RENDER ====================
async function refreshData() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("No active tab");

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "getData",
    });

    if (response?.data) {
      renderData(response.data);
    } else {
      throw new Error("No data returned");
    }
  } catch (err) {
    document.getElementById("dataList").innerHTML =
      `<div class="error">❌ Could not load data.<br>Make sure the page is fully loaded and the extension is active on this tab.</div>`;
    document.getElementById("itemCount").textContent = "0";
  }
}

function renderData(data) {
  document.getElementById("itemCount").textContent = data.length;

  const listEl = document.getElementById("dataList");

  if (data.length === 0) {
    listEl.innerHTML = `<p style="color:#666; text-align:center; padding:30px;">No matching items found on this page.</p>`;
    return;
  }

  let html = "<ul>";
  data.forEach((item) => {
    html += `
      <li>
        <strong>${item.text}</strong>
        <a href="${item.url}" target="_blank" rel="noopener">${item.url}</a>
      </li>
    `;
  });
  html += "</ul>";

  listEl.innerHTML = html;
}

const queryInput = document.getElementById("queryInput");
const searchBtn = document.getElementById("searchBtn");
const answerDiv = document.getElementById("answer");

searchBtn.addEventListener("click", async () => {
  const userQuery = queryInput.value.trim();
  if (!userQuery) return;

  answerDiv.textContent = "Thinking...";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const { data: currentData } = await chrome.tabs.sendMessage(tab.id, {
      action: "getData",
    });

    if (!currentData?.length) {
      answerDiv.textContent = "No data available on this page.";
      return;
    }

    // Send to your server / background script
    const response = await fetch("https://your-server.com/api/vector-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: userQuery, items: currentData }),
    });

    const result = await response.json();
    answerDiv.textContent =
      result.answer || result.content || "No answer received.";
  } catch (err) {
    answerDiv.innerHTML = `<span style="color:#d32f2f">Error: ${err.message}</span>`;
  }
});
