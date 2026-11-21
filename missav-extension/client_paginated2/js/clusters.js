// client_paginated/js/clusters.js
export const CLUSTER_TIER_THRESHOLDS = {
  green: { consistency: 0.75, centroidSim: 0.7 },
  amber: { consistency: 0.55, centroidSim: 0.6 },
  core: { silhouette: 0.4, probability: 0.7 },
};

export function clusterTier(c) {
  if (!c || c.is_noise) return "grey";
  const hasQuery = c.centroid_similarity != null;
  const consistency = c.consistency_score ?? 0;
  const centroidSim = c.centroid_similarity ?? 0;
  const t = CLUSTER_TIER_THRESHOLDS;
  if (hasQuery) {
    if (
      consistency >= t.green.consistency &&
      centroidSim >= t.green.centroidSim
    )
      return "green";
    if (
      consistency >= t.amber.consistency ||
      centroidSim >= t.amber.centroidSim
    )
      return "amber";
    return "grey";
  }
  if (consistency >= t.green.consistency) return "green";
  if (consistency >= t.amber.consistency) return "amber";
  return "grey";
}

export function clusterLabel(c) {
  if (!c || c.is_noise) return "Tangential · mixed";
  const tier = clusterTier(c);
  const hasQuery = c.centroid_similarity != null;
  if (hasQuery) {
    if (tier === "green") return "Very relevant · tightly grouped";
    if (tier === "amber") return "Related · grouped";
    return "Tangential · mixed";
  }
  if (tier === "green") return "Tightly grouped";
  if (tier === "amber") return "Loosely grouped";
  return "Mixed";
}

export function clusterTierDotClass(c) {
  return {
    green: "bg-emerald-400",
    amber: "bg-amber-400",
    grey: "bg-slate-500",
  }[clusterTier(c)];
}

export function clusterSegments(c) {
  return Math.round((c?.consistency_score ?? 0) * 5);
}

export function isCoreItem(it) {
  const t = CLUSTER_TIER_THRESHOLDS.core;
  return (
    (it.silhouette ?? 0) >= t.silhouette &&
    (it.probability ?? 0) >= t.probability
  );
}

export function isFringeItem(it) {
  return (it.silhouette ?? 0) < 0;
}

export function buildClusteredParams(state) {
  const { normalizeCodeList, normalizeGenreList } = window.__api;
  const q = state.lastQuery?.trim() || null;
  const limit =
    Number.isFinite(state.clusterPrefs.candidateLimit) &&
    state.clusterPrefs.candidateLimit >= 10
      ? state.clusterPrefs.candidateLimit
      : null;
  return {
    query: q,
    min_cluster_size: state.clusterPrefs.minClusterSize,
    cluster_selection_epsilon: state.clusterPrefs.epsilon,
    cluster_candidate_limit: limit,
    candidate_source: state.clusterPrefs.candidateSource,
    genre: normalizeGenreList(state.filters.genres),
    genres_mode: state.filters.genresMode,
    code: normalizeCodeList(state.filters.code),
    min_release_date: state.filters.from
      ? new Date(state.filters.from + "T00:00:00Z").toISOString()
      : null,
    max_release_date: state.filters.to
      ? new Date(state.filters.to + "T23:59:59Z").toISOString()
      : null,
    min_similarity: null,
    completion_filter: state.filters.completionFilter,
  };
}
