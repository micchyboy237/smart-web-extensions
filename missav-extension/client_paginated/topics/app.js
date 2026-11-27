const API_BASE = "http://localhost:9001";
let wordChartInstance = null;
let currentRunId = null;

// Initialize ECharts
function initChart() {
  const chartDom = document.getElementById("wordChart");
  wordChartInstance = echarts.init(chartDom);
  window.addEventListener("resize", () => wordChartInstance.resize());
}

async function loadRuns() {
  const code = document.getElementById("codeSelect").value;
  // If code is empty string, the endpoint will return all runs
  const url = code
    ? `${API_BASE}/topics/runs?code=${code}&limit=20`
    : `${API_BASE}/topics/runs?limit=20`;

  try {
    const res = await fetch(url);
    const runs = await res.json();

    const list = document.getElementById("runList");
    list.innerHTML = "";
    runs.forEach((run) => {
      const li = document.createElement("li");
      li.className = "topic-item";
      li.innerHTML = `
                <div class="flex justify-between items-center">
                    <span class="font-bold text-indigo-600">${run.code.toUpperCase()}</span>
                    <span class="text-xs text-gray-400">${new Date(run.created_at).toLocaleDateString()}</span>
                </div>
                <div class="text-xs text-gray-500">${run.n_topics} topics • ${run.n_docs} docs</div>
            `;
      li.onclick = () => loadRunDetails(run.id);
      list.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to load runs:", err);
  }
}

async function loadRunDetails(runId) {
  currentRunId = runId;
  const res = await fetch(`${API_BASE}/topics/runs/${runId}`);
  const data = await res.json();

  const list = document.getElementById("topicList");
  list.innerHTML = "";
  data.topics.forEach((topic) => {
    const li = document.createElement("li");
    li.className = "topic-item";
    li.innerHTML = `<span class="text-sm">#${topic.topic_id} ${topic.name || "Unnamed"}</span>`;
    li.onclick = () => showTopicDetails(topic);
    list.appendChild(li);
  });
}

function showTopicDetails(topic) {
  document.getElementById("currentTopicTitle").innerText =
    `Topic #${topic.topic_id}: ${topic.name || "Unnamed"}`;

  // Update ECharts
  const option = {
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: topic.words.map((w) => w.word),
      axisLabel: { interval: 0, rotate: 30 },
    },
    yAxis: { type: "value" },
    series: [
      {
        data: topic.words.map((w) => w.score),
        type: "bar",
        itemStyle: { color: "#4f46e5" },
      },
    ],
  };
  wordChartInstance.setOption(option);

  // Render Docs (UPDATED: Simplified display)
  const docsContainer = document.getElementById("repDocsContainer");
  docsContainer.innerHTML = "";
  topic.representative_docs.forEach((doc) => {
    const div = document.createElement("div");
    div.className = "doc-snippet";
    // Only show content and membership score now
    div.innerText = `"${doc.content.substring(0, 120)}..." (Confidence: ${doc.membership_score?.toFixed(2)})`;
    docsContainer.appendChild(div);
  });
}

// Start
document.addEventListener("DOMContentLoaded", () => {
  initChart();
  loadRuns();
});
