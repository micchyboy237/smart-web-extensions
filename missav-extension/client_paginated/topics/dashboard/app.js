const API_BASE = "http://localhost:9001";

let wordChartInstance = null;
let currentRunData = null; // Full run data for the detail view
let searchController = null; // AbortController for the in-flight search
let searchState = null; // { word, matchType } while search mode is active

const LOG = "[topics]";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escape text, then wrap occurrences of `term` in <mark>. */
function highlightTerm(text, term) {
  const safe = escapeHtml(text);
  const trimmed = (term || "").trim();
  if (!trimmed) return safe;
  const pattern = new RegExp(`(${escapeRegExp(escapeHtml(trimmed))})`, "gi");
  return safe.replace(pattern, "<mark>$1</mark>");
}

const MATCH_STYLES = {
  semantic: {
    label: "Semantic",
    icon: "🧠",
    classes: "bg-violet-50 text-violet-700 border-violet-200",
    hint: "Matched by meaning (vector similarity)",
  },
  keyword: {
    label: "Keyword",
    icon: "🔤",
    classes: "bg-amber-50 text-amber-700 border-amber-200",
    hint: "Matched by exact words (full-text search)",
  },
  hybrid: {
    label: "Hybrid",
    icon: "⚡",
    classes: "bg-emerald-50 text-emerald-700 border-emerald-200",
    hint: "Matched by both meaning and words",
  },
};

function setGridMode(mode) {
  const grid = document.getElementById("dashboardGrid");
  grid.className =
    mode === "search"
      ? "grid grid-cols-1 lg:grid-cols-2 gap-6"
      : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6";
}

/* ------------------------------------------------------------------ */
/* Chart                                                               */
/* ------------------------------------------------------------------ */

function initChart() {
  const chartDom = document.getElementById("wordChart");
  wordChartInstance = echarts.init(chartDom);

  // Use ResizeObserver to handle dynamic container sizing
  new ResizeObserver(() => {
    wordChartInstance.resize();
  }).observe(chartDom.parentElement);
  window.addEventListener("resize", () => wordChartInstance.resize());
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

async function loadDashboard() {
  console.log(`${LOG} loading dashboard`);
  searchState = null;
  updateSearchStatus(null);
  setGridMode("dashboard");
  try {
    const res = await fetch(`${API_BASE}/topics/dashboard`);
    if (!res.ok) throw new Error("Failed to fetch dashboard");
    const data = await res.json();
    console.log(`${LOG} dashboard loaded: ${data.codes.length} codes`);
    renderGrid(data.codes);
  } catch (err) {
    console.error(`${LOG} dashboard error`, err);
    document.getElementById("dashboardGrid").innerHTML =
      `<p class="text-red-500 col-span-full text-center">Error loading dashboard: ${escapeHtml(err.message)}</p>`;
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
          `<span class="keyword-tag">${escapeHtml(w.word)}<span class="keyword-score">${w.score.toFixed(2)}</span></span>`,
      )
      .join("");

    const card = document.createElement("div");
    card.className =
      "bg-white p-6 rounded-xl shadow-sm border border-gray-100 card-hover cursor-pointer flex flex-col h-full";
    card.onclick = () => loadRunDetails(item.run_id, item.code);

    card.innerHTML = `
            <div class="flex justify-between items-start mb-4">
                <div class="bg-indigo-50 text-indigo-700 font-bold px-3 py-1 rounded-md text-sm tracking-wide">${escapeHtml(item.code.toUpperCase())}</div>
                <span class="text-xs text-gray-400">${new Date(item.created_at).toLocaleDateString()}</span>
            </div>
            <div class="flex-grow space-y-2">
                <div class="grid grid-cols-2 gap-2 text-sm text-gray-600 bg-gray-50 p-2 rounded">
                    <div>Topics: <strong>${item.n_topics}</strong></div>
                    <div>Docs: <strong>${item.n_docs}</strong></div>
                    <div class="col-span-2">Rep. Docs: <strong>${item.top_topic_rep_count || 0}</strong></div>
                </div>
                ${item.top_topic_name ? `<p class="text-sm font-medium text-gray-800 mt-2">Primary: "${escapeHtml(item.top_topic_name)}"</p>` : ""}
            </div>
            <div class="border-t pt-3 mt-4">
                <p class="text-xs text-gray-400 uppercase font-semibold mb-2">Top Keywords</p>
                <div class="flex flex-wrap">${wordsHtml || '<span class="text-gray-400 text-xs">No data</span>'}</div>
            </div>
        `;
    grid.appendChild(card);
  });
}

/* ------------------------------------------------------------------ */
/* Topic search                                                        */
/* ------------------------------------------------------------------ */

function updateSearchStatus(info) {
  const bar = document.getElementById("searchStatus");
  const text = document.getElementById("searchStatusText");
  const clearBtn = document.getElementById("searchClearBtn");

  if (!info) {
    bar.classList.add("hidden");
    clearBtn.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  clearBtn.classList.remove("hidden");
  text.innerHTML = info;
}

async function handleSearch(e) {
  e.preventDefault();

  const word = document.getElementById("searchInput").value.trim();
  const matchType = document.getElementById("searchMatchType").value;
  const limit = parseInt(document.getElementById("searchLimit").value) || 10;

  // Empty search = go back to the dashboard
  if (!word) {
    console.log(`${LOG} empty search -> reset to dashboard`);
    return clearSearch();
  }

  // Cancel any previous in-flight search (prevents stale results)
  if (searchController) searchController.abort();
  searchController = new AbortController();
  const { signal } = searchController;

  const params = new URLSearchParams({
    word,
    limit: String(limit),
    match_type: matchType,
  });
  const url = `${API_BASE}/topics/search?${params}`;
  console.log(`${LOG} search start: ${url}`);

  const submitBtn = document.getElementById("searchBtn");
  const spinner = document.getElementById("searchSpinner");
  submitBtn.disabled = true;
  spinner.classList.remove("hidden");

  searchState = { word, matchType };
  setGridMode("search");
  document.getElementById("dashboardGrid").innerHTML =
    '<p class="text-gray-400 col-span-full text-center py-10">Searching topics...</p>';
  closeDetails();

  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Search failed (${res.status})`);
    }
    const results = await res.json();
    const ms = Math.round(performance.now() - t0);
    console.log(`${LOG} search done: ${results.length} results in ${ms}ms`);

    renderSearchResults(results, word);
    updateSearchStatus(
      `<strong>${results.length}</strong> topic${results.length === 1 ? "" : "s"} for ` +
        `<span class="font-semibold text-indigo-700">"${escapeHtml(word)}"</span> ` +
        `<span class="text-gray-400">• ${escapeHtml(matchType)} • ${ms}ms</span>`,
    );
  } catch (err) {
    if (err.name === "AbortError") {
      console.log(`${LOG} search aborted (newer search started)`);
      return;
    }
    console.error(`${LOG} search error`, err);
    document.getElementById("dashboardGrid").innerHTML =
      `<p class="text-red-500 col-span-full text-center py-10">Search error: ${escapeHtml(err.message)}</p>`;
    updateSearchStatus(null);
    document.getElementById("searchClearBtn").classList.remove("hidden");
  } finally {
    // Only reset the button if this is still the active request
    if (!signal.aborted) {
      submitBtn.disabled = false;
      spinner.classList.add("hidden");
    }
  }
}

function clearSearch() {
  console.log(`${LOG} clear search`);
  if (searchController) searchController.abort();
  document.getElementById("searchInput").value = "";
  document.getElementById("searchBtn").disabled = false;
  document.getElementById("searchSpinner").classList.add("hidden");
  closeDetails();
  loadDashboard();
}

function renderSearchResults(results, word) {
  const grid = document.getElementById("dashboardGrid");
  grid.innerHTML = "";

  if (!results || results.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full text-center py-12 text-gray-500">
        <p class="text-lg font-medium">No topics found for "${escapeHtml(word)}"</p>
        <p class="text-sm mt-1">Try a different word or switch the match type to <strong>all</strong>.</p>
      </div>`;
    return;
  }

  // Bar width is relative to the best score (raw RRF scores are very small)
  const maxScore = Math.max(...results.map((r) => r.relevance_score)) || 1;

  results.forEach((item) => {
    const style = MATCH_STYLES[item.match_type] || MATCH_STYLES.semantic;
    const matchedSet = new Set(
      (item.matched_keywords || []).map((k) => k.toLowerCase()),
    );
    const relPct = Math.max(
      4,
      Math.round((item.relevance_score / maxScore) * 100),
    );

    const wordsHtml = (item.top_words || [])
      .map((w) => {
        const isMatch =
          matchedSet.has(w.word.toLowerCase()) ||
          w.word.toLowerCase().includes(word.toLowerCase());
        return `<span class="keyword-tag ${isMatch ? "keyword-tag-match" : ""}">${escapeHtml(w.word)}<span class="keyword-score">${Number(w.score).toFixed(2)}</span></span>`;
      })
      .join("");

    const snippetHtml = item.representative_snippet
      ? `<p class="doc-snippet line-clamp-4">"${highlightTerm(item.representative_snippet, word)}"</p>`
      : '<p class="text-gray-400 text-xs italic">No representative snippet.</p>';

    const card = document.createElement("div");
    card.className =
      "bg-white p-6 rounded-xl shadow-sm border border-gray-100 card-hover cursor-pointer flex flex-col h-full";
    card.title = style.hint;
    card.onclick = () => loadRunDetails(item.run_id, item.code, item.topic_id);

    card.innerHTML = `
      <div class="flex justify-between items-start mb-3 gap-3">
        <div class="min-w-0">
          <h3 class="text-lg font-bold text-gray-800 truncate">
            ${highlightTerm(item.topic_name || "Unnamed topic", word)}
          </h3>
          <p class="text-xs text-gray-400 mt-0.5">Topic #${item.topic_id}</p>
        </div>
        <span class="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${style.classes}">
          ${style.icon} ${style.label}
        </span>
      </div>

      <div class="mb-3">
        <div class="flex justify-between text-xs text-gray-400 mb-1">
          <span>Relevance</span>
          <span>${item.relevance_score.toFixed(4)}</span>
        </div>
        <div class="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div class="h-full bg-indigo-500 rounded-full" style="width:${relPct}%"></div>
        </div>
      </div>

      <div class="mb-3">
        <p class="text-xs text-gray-400 uppercase font-semibold mb-2">Top Keywords</p>
        <div class="flex flex-wrap">${wordsHtml || '<span class="text-gray-400 text-xs">No data</span>'}</div>
      </div>

      <div class="flex-grow mb-4">
        <p class="text-xs text-gray-400 uppercase font-semibold mb-2">Representative Snippet</p>
        ${snippetHtml}
      </div>

      <div class="border-t pt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span class="bg-indigo-50 text-indigo-700 font-bold px-2 py-0.5 rounded tracking-wide">${escapeHtml(item.code.toUpperCase())}</span>
        <span>📅 ${new Date(item.created_at).toLocaleDateString()}</span>
        <span>📄 ${item.representative_doc_count} docs</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

/* ------------------------------------------------------------------ */
/* Detail view                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {string} runId
 * @param {string} code
 * @param {number|null} focusTopicId - optional topic_id to preselect (used by search results)
 */
async function loadRunDetails(runId, code, focusTopicId = null) {
  console.log(
    `${LOG} load run details: run=${runId} code=${code} focusTopic=${focusTopicId}`,
  );
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

    // Preselect the searched topic, otherwise the first one
    let startIndex = 0;
    if (focusTopicId !== null) {
      const found = currentRunData.topics.findIndex(
        (t) => t.topic_id === focusTopicId,
      );
      if (found >= 0) startIndex = found;
      else console.warn(`${LOG} topic ${focusTopicId} not found in run`);
    }
    select.value = String(startIndex);
    changeTopic(startIndex);
  } catch (err) {
    console.error(`${LOG} detail error`, err);
    alert("Error loading details: " + err.message);
    closeDetails();
  }
}

function changeTopic(index) {
  if (!currentRunData) return;
  const topic = currentRunData.topics[index];
  if (!topic) return;
  console.log(`${LOG} show topic index=${index} id=${topic.topic_id}`);

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
    // Highlight the active search term inside snippets (if searching)
    const term = searchState ? searchState.word : "";
    topic.representative_docs.forEach((doc) => {
      const div = document.createElement("div");
      div.className = "doc-snippet";
      const confidence = doc.membership_score
        ? (doc.membership_score * 100).toFixed(1)
        : "N/A";
      div.innerHTML = `"${highlightTerm(doc.content, term)}" <br><span class="text-xs text-indigo-500 not-italic mt-2 block font-semibold">Confidence: ${confidence}%</span>`;
      docsContainer.appendChild(div);
    });
  }
}

function closeDetails() {
  document.getElementById("detailView").classList.add("hidden");
  currentRunData = null;
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

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
    top_k: parseInt(document.getElementById("inputTopK").value) || 10,
    no_llm: document.getElementById("inputNoLlm").checked,
  };
  console.log(`${LOG} save analysis`, payload);

  try {
    const res = await fetch(`${API_BASE}/topics/save_topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Save failed");
    }

    await res.json();
    console.log(`${LOG} analysis saved`);

    // A new run should show up on the dashboard, so leave search mode
    document.getElementById("searchInput").value = "";
    loadDashboard();
    closeModal();
    document.getElementById("analysisForm").reset();
  } catch (err) {
    console.error(`${LOG} save error`, err);
    alert("Error: " + err.message);
  } finally {
    btn.disabled = false;
    spinner.classList.add("hidden");
    text.innerText = "Start Analysis";
  }
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

document.addEventListener("DOMContentLoaded", () => {
  initChart();
  loadDashboard();

  // Esc inside the search box clears the search
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearSearch();
  });
});
