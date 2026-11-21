// client_paginated/js/genres.js
// Genre section helpers: max-height list, show-all modal, sort/order.

export const GENRE_MAX_VISIBLE = 12;

export function sortedGenres(genres, sortBy, order) {
  const arr = [...(genres || [])];
  if (sortBy === "count") {
    arr.sort((a, b) => b.count - a.count);
  } else {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (order === "desc") arr.reverse();
  return arr;
}

export function visibleGenres(genres, expanded) {
  if (expanded) return genres;
  return genres.slice(0, GENRE_MAX_VISIBLE);
}
