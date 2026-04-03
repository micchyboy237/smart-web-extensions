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

// Load saved config
chrome.storage.sync.get("config", (data) => {
  const c = data.config || DEFAULT_CONFIG;
  containerInput.value = c.containerSelector || "";
  urlInput.value = c.urlSelector || "";
  textInput.value = c.textSelector || "";

  // Load data immediately after config
  refreshData();
});

// Save config + refresh preview
saveBtn.addEventListener("click", () => {
  const config = {
    containerSelector:
      containerInput.value.trim() || DEFAULT_CONFIG.containerSelector,
    urlSelector: urlInput.value.trim(),
    textSelector: textInput.value.trim(),
  };

  chrome.storage.sync.set({ config }, () => {
    status.textContent = "✅ Saved & applied!";
    setTimeout(() => (status.textContent = ""), 2000);
    refreshData(); // refresh with new selectors
  });
});

refreshBtn.addEventListener("click", refreshData);

// ==================== DATA FETCH & RENDER ====================
async function refreshData() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error();

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "getData",
    });

    if (response?.data) {
      renderData(response.data);
    } else {
      throw new Error();
    }
  } catch (err) {
    document.getElementById("dataList").innerHTML =
      `<div class="error">❌ Could not load data.<br>Reload the page or check if extension is active.</div>`;
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
        <a href="${item.url}" target="_blank">${item.url}</a>
      </li>
    `;
  });
  html += "</ul>";

  listEl.innerHTML = html;
}
