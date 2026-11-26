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

  const grid = document.getElementById("dashboardGrid");
  grid.innerHTML = "";

  data.codes.forEach((item) => {
    const card = document.createElement("div");
    card.className =
      "bg-white p-5 rounded-lg shadow-sm border border-gray-100 card-hover cursor-pointer";
    card.onclick = () => loadRunDetails(item.run_id, item.code);

    // Format words with scores
    const wordsHtml = item.top_topic_words
      .map(
        (w) =>
          `<span class="tag" title="Score: ${w.score.toFixed(2)}">${w.word}</span>`,
      )
      .join("");

    card.innerHTML = `
          <div class="flex justify-between items-start mb-3">
              <h3 class="text-xl font-bold text-indigo-600">${item.code.toUpperCase()}</h3>
              <span class="text-xs text-gray-400">${new Date(item.created_at).toLocaleDateString()}</span>
          </div>
          <div class="text-sm text-gray-600 mb-4 space-y-1">
              <p><strong>${item.n_topics}</strong> Topics • <strong>${item.n_docs}</strong> Docs</p>
              ${item.top_topic_rep_count ? `<p class="text-xs text-gray-500">${item.top_topic_rep_count} rep. docs in primary topic</p>` : ""}
              ${item.top_topic_name ? `<p class="mt-1 italic text-gray-500">Primary: "${item.top_topic_name}"</p>` : ""}
          </div>
          <div class="border-t pt-3">
              <p class="text-xs text-gray-400 uppercase font-semibold mb-2">Key Words (Top ${item.n_topics})</p>
              <div class="flex flex-wrap gap-1">${wordsHtml || '<span class="text-gray-400 text-xs">No data</span>'}</div>
          </div>
      `;
    grid.appendChild(card);
  });
}

async function loadRunDetails(runId, code) {
  document.getElementById("detailView").classList.remove("hidden");
  document.getElementById("detailTitle").innerText =
    `Analysis for ${code.toUpperCase()}`;

  // Scroll to details
  document.getElementById("detailView").scrollIntoView({ behavior: "smooth" });

  const res = await fetch(`${API_BASE}/topics/runs/${runId}`);
  const data = await res.json();

  // For simplicity, let's show the first topic in the run as the "main" view
  // In a real app, you might list all topics in the detail view
  const mainTopic = data.topics[0];

  if (mainTopic) {
    const option = {
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        data: mainTopic.words.map((w) => w.word),
        axisLabel: { interval: 0, rotate: 30 },
      },
      yAxis: { type: "value" },
      series: [
        {
          data: mainTopic.words.map((w) => w.score),
          type: "bar",
          itemStyle: { color: "#4f46e5" },
        },
      ],
    };
    wordChartInstance.setOption(option);

    const docsContainer = document.getElementById("repDocsContainer");
    docsContainer.innerHTML = "";
    mainTopic.representative_docs.forEach((doc) => {
      const div = document.createElement("div");
      div.className = "doc-snippet";
      div.innerText = `"${doc.content.substring(0, 100)}..."`;
      docsContainer.appendChild(div);
    });
  }
}

function closeDetails() {
  document.getElementById("detailView").classList.add("hidden");
}

document.addEventListener("DOMContentLoaded", () => {
  initChart();
  loadDashboard();
});
