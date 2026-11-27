const API_BASE = "http://localhost:9001";
let wordChartInstance = null;
let currentRunData = null; // Store full run data locally

function initChart() {
  const chartDom = document.getElementById("wordChart");
  wordChartInstance = echarts.init(chartDom);

  // Use ResizeObserver to handle dynamic container sizing
  new ResizeObserver(() => {
    wordChartInstance.resize();
  }).observe(chartDom.parentElement);

  window.addEventListener("resize", () => wordChartInstance.resize());
}

async function loadDashboard() {
  try {
    const res = await fetch(`${API_BASE}/topics/dashboard`);
    if (!res.ok) throw new Error("Failed to fetch dashboard");
    const data = await res.json();
    renderGrid(data.codes);
  } catch (err) {
    console.error(err);
    document.getElementById("dashboardGrid").innerHTML =
      `<p class="text-red-500 col-span-full text-center">Error loading dashboard: ${err.message}</p>`;
  }
}

function renderGrid(codes) {
  const grid = document.getElementById("dashboardGrid");
  grid.innerHTML = "";

  if (!codes || codes.length === 0) {
    grid.innerHTML =
      '<p class="text-gray-500 col-span-full text-center py-10">No topic runs found. Start a new analysis!</p>';
    return;
  }

  codes.forEach((item) => {
    // Format keywords with scores
    const wordsHtml = item.top_topic_words
      .map(
        (w) =>
          `<span class="keyword-tag">${w.word}<span class="keyword-score">${w.score.toFixed(2)}</span></span>`,
      )
      .join("");

    const card = document.createElement("div");
    card.className =
      "bg-white p-6 rounded-xl shadow-sm border border-gray-100 card-hover cursor-pointer flex flex-col h-full";
    card.onclick = () => loadRunDetails(item.run_id, item.code);

    card.innerHTML = `
            <div class="flex justify-between items-start mb-4">
                <div class="bg-indigo-50 text-indigo-700 font-bold px-3 py-1 rounded-md text-sm tracking-wide">${item.code.toUpperCase()}</div>
                <span class="text-xs text-gray-400">${new Date(item.created_at).toLocaleDateString()}</span>
            </div>
            <div class="flex-grow space-y-2">
                <div class="grid grid-cols-2 gap-2 text-sm text-gray-600 bg-gray-50 p-2 rounded">
                    <div>Topics: <strong>${item.n_topics}</strong></div>
                    <div>Docs: <strong>${item.n_docs}</strong></div>
                    <div class="col-span-2">Rep. Docs: <strong>${item.top_topic_rep_count || 0}</strong></div>
                </div>
                ${item.top_topic_name ? `<p class="text-sm font-medium text-gray-800 mt-2">Primary: "${item.top_topic_name}"</p>` : ""}
            </div>
            <div class="border-t pt-3 mt-4">
                <p class="text-xs text-gray-400 uppercase font-semibold mb-2">Top Keywords</p>
                <div class="flex flex-wrap">${wordsHtml || '<span class="text-gray-400 text-xs">No data</span>'}</div>
            </div>
        `;
    grid.appendChild(card);
  });
}

async function loadRunDetails(runId, code) {
  document.getElementById("detailView").classList.remove("hidden");
  document.getElementById("detailView").scrollIntoView({ behavior: "smooth" });

  // Show loading state in detail view
  document.getElementById("detailTitle").innerText = "Loading...";

  try {
    const res = await fetch(`${API_BASE}/topics/runs/${runId}`);
    if (!res.ok) throw new Error("Failed to load details");
    currentRunData = await res.json();

    document.getElementById("detailTitle").innerText =
      `Analysis: ${currentRunData.run.code.toUpperCase()}`;
    document.getElementById("detailMeta").innerText =
      `Run ID: ${runId} • ${currentRunData.topics.length} Topics • ${currentRunData.run.n_docs} Docs`;

    // Populate Topic Selector
    const select = document.getElementById("topicSelect");
    select.innerHTML = "";
    currentRunData.topics.forEach((t, index) => {
      const option = document.createElement("option");
      option.value = index;
      option.text = `#${t.topic_id} ${t.name || "Unnamed"}`;
      select.appendChild(option);
    });

    // Load first topic by default
    changeTopic(0);
  } catch (err) {
    alert("Error loading details: " + err.message);
    closeDetails();
  }
}

function changeTopic(index) {
  if (!currentRunData) return;
  const topic = currentRunData.topics[index];

  // Update Chart
  const option = {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
    xAxis: {
      type: "category",
      data: topic.words.map((w) => w.word),
      axisLabel: { interval: 0, rotate: 30, fontSize: 10 },
    },
    yAxis: { type: "value", name: "Relevance Score" },
    series: [
      {
        data: topic.words.map((w) => w.score),
        type: "bar",
        itemStyle: { color: "#4f46e5", borderRadius: [4, 4, 0, 0] },
        barWidth: "60%",
      },
    ],
  };
  wordChartInstance.setOption(option, true); // true = not merge, replace

  // Update Docs
  document.getElementById("repCountBadge").innerText =
    topic.representative_docs.length;
  const docsContainer = document.getElementById("repDocsContainer");
  docsContainer.innerHTML = "";

  if (topic.representative_docs.length === 0) {
    docsContainer.innerHTML =
      '<p class="text-gray-400 text-sm italic">No representative documents found.</p>';
  } else {
    topic.representative_docs.forEach((doc) => {
      const div = document.createElement("div");
      div.className = "doc-snippet";
      const confidence = doc.membership_score
        ? (doc.membership_score * 100).toFixed(1)
        : "N/A";
      div.innerHTML = `"${doc.content}" <br><span class="text-xs text-indigo-500 not-italic mt-2 block font-semibold">Confidence: ${confidence}%</span>`;
      docsContainer.appendChild(div);
    });
  }
}

function closeDetails() {
  document.getElementById("detailView").classList.add("hidden");
  currentRunData = null;
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
    code: document.getElementById("inputCode").value.toLowerCase(),
    n_topics: parseInt(document.getElementById("inputNTopics").value),
    n_docs: parseInt(document.getElementById("inputNDocs").value),
    // ADD THIS LINE:
    top_k: parseInt(document.getElementById("inputTopK").value) || 10,
    no_llm: document.getElementById("inputNoLlm").checked,
  };

  try {
    // Ensure the URL is correct as per previous fix
    const res = await fetch(`${API_BASE}/topics/save_topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Save failed");
    }

    const newSummary = await res.json();
    loadDashboard();
    closeModal();
    document.getElementById("analysisForm").reset();

    // Optional: Reset top_k to default if desired, or let browser remember
    // document.getElementById("inputTopK").value = 10;
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    btn.disabled = false;
    spinner.classList.add("hidden");
    text.innerText = "Start Analysis";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initChart();
  loadDashboard();
});
