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
  expandedGroup: null,
};

function getState() {
  return currentState;
}

function setState(updates) {
  console.log("[GroupByCode] 📦 State update:", updates);
  currentState = { ...currentState, ...updates };
}

function resetState() {
  console.log("[GroupByCode] 🔄 Resetting state");
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
