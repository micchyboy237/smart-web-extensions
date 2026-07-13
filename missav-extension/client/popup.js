// Load saved config + immediately show preview
document.addEventListener("DOMContentLoaded", () => {
  refreshData(); // ← show data right away
});

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
