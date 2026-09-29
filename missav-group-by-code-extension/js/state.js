/**
 * state.js - State Management
 */

let currentState = {
  groups: [],
  selectedCode: null,
  searchTerm: "",
  filters: [],
  mode: "group",
  config: null,
  isActive: false,
  lastItemCount: 0,
  originalOrder: [],
  isRearranging: false,
  expandedGroup: null, // Track which group panel is expanded
};

function getState() {
  return currentState;
}

function setState(updates) {
  currentState = { ...currentState, ...updates };
}

function resetState() {
  currentState = {
    groups: [],
    selectedCode: null,
    searchTerm: "",
    filters: [],
    mode: "group",
    config: null,
    isActive: false,
    lastItemCount: 0,
    originalOrder: [],
    isRearranging: false,
    expandedGroup: null,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getState, setState, resetState };
}
