const API_BASE = "http://localhost:9001";
let wordChartInstance = null;

function initChart() {
  const chartDom = document.getElementById("wordChart");
  wordChartInstance = echarts.init(chartDom);
  window.addEventListener("resize", () => wordChartInstance.resize());
}

async function loadDashboard() {
  const res = await fetch(`${API_BASE}/topics/dashboard`);
  const data = await res.json();
  renderGrid(data.codes);
}

function renderGrid(codes) {
  const grid = document.getElementById("dashboardGrid");
  grid.innerHTML = "";
  codes.forEach((item) => {
    const wordsHtml = item.top_topic_words
      .map(
        (w) =>
          `<span class="tag" title="Score: ${w.score.toFixed(2)}">${w.word}</span>`,
      )
      .join("");

    const card = document.createElement("div");
    card.className =
      "bg-white p-6 rounded-xl shadow-sm border border-gray-100 card-hover cursor-pointer flex flex-col h-full";
    card.onclick = () => loadRunDetails(item.run_id, item.code);

    card.innerHTML = `
            <div class="flex justify-between items-start mb-4">
                <div class="bg-indigo-50 text-indigo-700 font-bold px-3 py-1 rounded-md text-sm">${item.code.toUpperCase()}</div>
                <span class="text-xs text-gray-400">${new Date(item.created_at).toLocaleDateString()}</span>
            </div>
            <div class="flex-grow">
                <div class="text-sm text-gray-600 mb-4 space-y-1">
                    <div class="flex justify-between"><span>Topics:</span> <strong>${item.n_topics}</strong></div>
                    <div class="flex justify-between"><span>Docs:</span> <strong>${item.n_docs}</strong></div>
                    <div class="flex justify-between"><span>Rep. Docs:</span> <strong>${item.top_topic_rep_count || 0}</strong></div>
                </div>
                ${item.top_topic_name ? `<p class="text-sm font-medium text-gray-800 mb-2">Primary: "${item.top_topic_name}"</p>` : ""}
            </div>
            <div class="border-t pt-3 mt-2">
                <p class="text-xs text-gray-400 uppercase font-semibold mb-2">Top Keywords</p>
                <div class="flex flex-wrap">${wordsHtml}</div>
            </div>
        `;
    grid.appendChild(card);
  });
}

async function loadRunDetails(runId, code) {
  document.getElementById("detailView").classList.remove("hidden");
  document.getElementById("detailView").scrollIntoView({ behavior: "smooth" });
  document.getElementById("detailTitle").innerText =
    `Analysis: ${code.toUpperCase()}`;

  const res = await fetch(`${API_BASE}/topics/runs/${runId}`);
  const data = await res.json();
  document.getElementById("detailMeta").innerText =
    `Run ID: ${runId} • ${data.topics.length} Topics Found`;

  const mainTopic = data.topics[0];
  if (mainTopic) {
    // Chart
    wordChartInstance.setOption({
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        data: mainTopic.words.map((w) => w.word),
        axisLabel: { rotate: 30 },
      },
      yAxis: { type: "value" },
      series: [
        {
          data: mainTopic.words.map((w) => w.score),
          type: "bar",
          itemStyle: { color: "#4f46e5", borderRadius: [4, 4, 0, 0] },
        },
      ],
    });

    // Docs
    document.getElementById("repCountBadge").innerText =
      mainTopic.representative_docs.length;
    const docsContainer = document.getElementById("repDocsContainer");
    docsContainer.innerHTML = "";
    mainTopic.representative_docs.forEach((doc) => {
      const div = document.createElement("div");
      div.className = "doc-snippet";
      div.innerHTML = `"${doc.content}" <br><span class="text-xs text-indigo-500 not-italic mt-1 block">Confidence: ${(doc.membership_score * 100).toFixed(1)}%</span>`;
      docsContainer.appendChild(div);
    });
  }
}

// Modal Logic
function openModal() {
  document.getElementById("analysisModal").classList.remove("hidden");
  document.getElementById("analysisModal").classList.add("flex");
}
function closeModal() {
  document.getElementById("analysisModal").classList.add("hidden");
  document.getElementById("analysisModal").classList.remove("flex");
}

async function handleSave(e) {
  e.preventDefault();
  const btn = document.getElementById("saveBtn");
  const spinner = document.getElementById("btnSpinner");
  const text = document.getElementById("btnText");

  btn.disabled = true;
  spinner.classList.remove("hidden");
  text.innerText = "Processing...";

  const payload = {
    code: document.getElementById("inputCode").value,
    n_topics: parseInt(document.getElementById("inputNTopics").value),
    n_docs: parseInt(document.getElementById("inputNDocs").value),
    no_llm: document.getElementById("inputNoLlm").checked,
  };

  try {
    const res = await fetch(`${API_BASE}/save_topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error("Save failed");

    const newSummary = await res.json();

    // Prepend new card to grid
    const grid = document.getElementById("dashboardGrid");
    const tempDiv = document.createElement("div");
    // Re-use render logic by creating a temporary array
    renderGrid([newSummary, ...getCurrentGridData()]);

    closeModal();
    document.getElementById("analysisForm").reset();
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    btn.disabled = false;
    spinner.classList.add("hidden");
    text.innerText = "Start Analysis";
  }
}

// Helper to keep grid state simple for this example
function getCurrentGridData() {
  // In a real app, you'd maintain a state array. For now, we'll just reload.
  loadDashboard();
  return [];
}

document.addEventListener("DOMContentLoaded", () => {
  initChart();
  loadDashboard();
});
