// client_paginated/js/filters.js
import { normalizeCodeList, normalizeGenreList } from "./api.js";

export function buildFiltersParams(filters) {
  return {
    code: normalizeCodeList(filters.code),
    genre: normalizeGenreList(filters.genres),
    genres_mode: filters.genresMode,
    completion_filter: filters.completionFilter,
  };
}

export function buildDateRange(filters) {
  return {
    min_release_date: filters.from
      ? new Date(filters.from + "T00:00:00Z").toISOString()
      : null,
    max_release_date: filters.to
      ? new Date(filters.to + "T23:59:59Z").toISOString()
      : null,
  };
}

export function activeFilterCount(filters) {
  let count = 0;
  if (filters.code) count++;
  if (filters.from || filters.to) count++;
  if (filters.genres.length) count++;
  if (filters.completionFilter !== "all") count++;
  return count;
}
