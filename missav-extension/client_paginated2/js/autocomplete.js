// client_paginated/js/autocomplete.js
// Autocomplete for series code input.
// - On focus: show all codes (with counts) as suggestions.
// - Typing filters the list (prefix/substring match).
// - Selected codes become chips below the input; each chip has an "x".

export function createAutocompleteState() {
  return {
    open: false,
    input: "",
    highlightedIndex: -1,
    blurTimer: null,
  };
}

// Get options: all codes not already selected, filtered by input text.
export function getCodeOptions(facets, selectedCodes, input) {
  const selected = new Set(
    (selectedCodes || []).map((c) => c.trim().toLowerCase()).filter(Boolean),
  );
  const q = (input || "").trim().toLowerCase();
  return (facets.codes || [])
    .filter((c) => !selected.has(c.code.toLowerCase()))
    .filter((c) => !q || c.code.toLowerCase().includes(q))
    .sort((a, b) => {
      // Prefer prefix matches, then higher count.
      const aPrefix = q && a.code.toLowerCase().startsWith(q);
      const bPrefix = q && b.code.toLowerCase().startsWith(q);
      if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
      return b.count - a.count;
    })
    .slice(0, 50);
}

export function parseCodeInput(raw) {
  return (raw || "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}

export function formatChips(codes) {
  return codes.map((c) => ({ code: c, id: c }));
}
