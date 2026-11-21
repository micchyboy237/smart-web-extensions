// client_paginated/js/urlSync.js
export function hydrateFromURL(state) {
  const p = new URLSearchParams(location.search);
  const urlMode = p.get("mode");
  const hasQ = !!p.get("q");
  state.mode = urlMode || (hasQ ? "search" : "browse");
  state.query = p.get("q") || "";
  state.lastQuery = state.query;
  state.filters.code = p.get("code") || "";
  state.filters.from = p.get("from") || "";
  state.filters.to = p.get("to") || "";
  state.filters.genresMode = p.get("gmode") || "any";
  state.filters.genres = (p.get("genres") || "").split(",").filter(Boolean);
  const cf = p.get("cf");
  state.filters.completionFilter =
    cf === "complete" || cf === "incomplete" ? cf : "all";
  state.similarOf = p.get("sim") || null;

  if (state.mode === "clustered") {
    const clRaw = p.get("cl");
    if (clRaw == null || clRaw === "") {
      state.clusterPrefs.candidateLimit = null;
    } else {
      const cl = parseInt(clRaw, 10);
      state.clusterPrefs.candidateLimit = Number.isFinite(cl) ? cl : null;
    }
    const msRaw = p.get("msize");
    if (msRaw != null && msRaw !== "") {
      const ms = parseInt(msRaw, 10);
      if (Number.isFinite(ms)) {
        state.clusterPrefs.minClusterSize = Math.min(20, Math.max(2, ms));
      }
    }
    const epsRaw = p.get("eps");
    if (epsRaw != null && epsRaw !== "") {
      const eps = parseFloat(epsRaw);
      if (Number.isFinite(eps)) {
        state.clusterPrefs.epsilon = Math.min(1, Math.max(0, eps));
      }
    }
    const src = p.get("src");
    if (src === "random" || src === "recent") {
      state.clusterPrefs.candidateSource = src;
    }
  }
  const urlSort = p.get("sort");
  if (state.mode === "browse") {
    state.sort =
      urlSort === "release_date" || urlSort === "created_at"
        ? urlSort
        : "release_date";
  } else {
    state.sort = urlSort || "similarity";
  }
  state.order = p.get("order") || "desc";
}

export function syncURL(state) {
  const p = new URLSearchParams();
  if (state.mode === "search" && state.lastQuery) p.set("q", state.lastQuery);
  if (state.mode === "clustered") {
    p.set("mode", "clustered");
    if (state.lastQuery) p.set("q", state.lastQuery);
    if (Number.isFinite(state.clusterPrefs.candidateLimit)) {
      p.set("cl", String(state.clusterPrefs.candidateLimit));
    }
    if (state.clusterPrefs.minClusterSize !== 2) {
      p.set("msize", String(state.clusterPrefs.minClusterSize));
    }
    if (state.clusterPrefs.epsilon !== 0.25) {
      p.set("eps", String(state.clusterPrefs.epsilon));
    }
    if (state.clusterPrefs.candidateSource !== "recent") {
      p.set("src", state.clusterPrefs.candidateSource);
    }
  }
  if (state.mode === "browse") p.set("mode", "browse");
  if (state.mode === "similar" && state.similarOf) {
    p.set("mode", "similar");
    p.set("sim", state.similarOf);
  }
  if (state.filters.code) p.set("code", state.filters.code);
  if (state.filters.from) p.set("from", state.filters.from);
  if (state.filters.to) p.set("to", state.filters.to);
  if (state.filters.genresMode !== "any")
    p.set("gmode", state.filters.genresMode);
  if (state.filters.genres.length)
    p.set("genres", state.filters.genres.join(","));
  if (state.filters.completionFilter !== "all")
    p.set("cf", state.filters.completionFilter);
  if (state.mode === "browse") {
    if (state.sort !== "similarity") p.set("sort", state.sort);
    if (state.order !== "desc") p.set("order", state.order);
  }
  history.replaceState(null, "", `${location.pathname}?${p}`);
}
