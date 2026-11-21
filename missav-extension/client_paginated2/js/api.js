// client_paginated/js/api.js
export const API = "http://localhost:9001";

export function normalizeCodeList(raw) {
  if (!raw) return null;
  const parts = raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0] : unique;
}

export function normalizeGenreList(list) {
  if (!list || list.length === 0) return null;
  if (list.length === 1) return list[0];
  return list;
}

export async function fetchFacets(completionFilter = "all") {
  let qs = "";
  if (completionFilter !== "all") {
    qs = `?completion_filter=${completionFilter}`;
  }
  const r = await fetch(`${API}/facets${qs}`);
  if (!r.ok) throw new Error(`Facets failed: ${r.status}`);
  return r.json();
}

export async function searchVideos(body) {
  const res = await fetch(`${API}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function searchSimilar(body) {
  const res = await fetch(`${API}/similar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function browseVideos(params) {
  const res = await fetch(`${API}/browse?${params}`);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function searchClustered(body) {
  const res = await fetch(`${API}/search_clustered`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function getVideo(id) {
  const r = await fetch(`${API}/videos/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`Failed to load ${id}`);
  return r.json();
}
