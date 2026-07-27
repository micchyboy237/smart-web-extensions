// Jet_Apps/web-extensions/smart-web-extensions/missav-extension/client/state-persistence.js
//
// Manages popup form & results state persistence across popup open/close cycles.
// Uses chrome.storage.session — scoped per browser session, NOT shared across
// tabs (each tab gets its own keyed state). Auto-clears when browser closes.

// ====================== STATE PERSISTENCE ======================
const PopupState = {
  // --- Current tab reference ---
  _tabId: null,

  // --- Storage key format: "popupState_{tabId}" ---
  _getKey() {
    return this._tabId ? `popupState_${this._tabId}` : null;
  },

  /**
   * Initialize: detect current tab ID so we can scope state correctly.
   * Must be called before save/load. Returns the tab ID.
   */
  async init(tabId = null) {
    if (tabId !== null) {
      this._tabId = tabId;
      console.log(`[STATE] 🆔 Initialized for tab (explicit): ${this._tabId}`);
      return this._tabId;
    }
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      this._tabId = tab?.id || null;
      console.log(
        `[STATE] 🆔 Initialized for tab (query fallback): ${this._tabId}`,
      );
      return this._tabId;
    } catch (err) {
      console.warn("[STATE] ⚠️ Could not get tab ID:", err.message);
      this._tabId = null;
      return null;
    }
  },

  /**
   * Collect all current form values from the DOM.
   * Callers pass DOM references so this file has zero DOM dependencies.
   *
   * @param {Object} formRefs - Map of element IDs or references
   *        Expected shape: { query, topK, searchType, includeCodes, excludeCodes,
   *                          includeCodesFilter, excludeCodesFilter, episodeMin,
   *                          episodeMax, diversityFactor, maxPerCode,
   *                          autoShuffle, limitToPage }
   * @returns {Object} Serializable form snapshot
   */
  _collectFormSnapshot(formRefs) {
    const getVal = (el) => (el ? el.value : undefined);
    const getChecked = (el) => (el ? el.checked : undefined);
    const getSelected = (el) =>
      el ? Array.from(el.selectedOptions || []).map((o) => o.value) : undefined;

    return {
      query: getVal(formRefs.query),
      topK: getVal(formRefs.topK),
      searchType: getVal(formRefs.searchType),
      includeCodesSelected: getSelected(formRefs.includeCodes),
      excludeCodesSelected: getSelected(formRefs.excludeCodes),
      includeCodesFilter: getVal(formRefs.includeCodesFilter),
      excludeCodesFilter: getVal(formRefs.excludeCodesFilter),
      episodeMin: getVal(formRefs.episodeMin),
      episodeMax: getVal(formRefs.episodeMax),
      diversityFactor: getVal(formRefs.diversityFactor),
      maxPerCode: getVal(formRefs.maxPerCode),
      autoShuffle: getChecked(formRefs.autoShuffle),
      limitToPage: getChecked(formRefs.limitToPage),
    };
  },

  /**
   * Restore form values into the DOM from a saved snapshot.
   *
   * @param {Object} formRefs - Same shape as _collectFormSnapshot
   * @param {Object} snapshot  - Previously saved form snapshot
   */
  _restoreFormSnapshot(formRefs, snapshot) {
    const setVal = (el, val) => {
      if (el && val !== undefined && val !== null) el.value = val;
    };
    const setChecked = (el, val) => {
      if (el && val !== undefined) el.checked = val;
    };
    const restoreMulti = (el, values) => {
      if (!el || !values?.length) return;
      const set = new Set(values);
      Array.from(el.options).forEach((o) => (o.selected = set.has(o.value)));
    };

    setVal(formRefs.query, snapshot.query);
    setVal(formRefs.topK, snapshot.topK);
    setVal(formRefs.searchType, snapshot.searchType);
    setVal(formRefs.includeCodesFilter, snapshot.includeCodesFilter);
    setVal(formRefs.excludeCodesFilter, snapshot.excludeCodesFilter);
    setVal(formRefs.episodeMin, snapshot.episodeMin);
    setVal(formRefs.episodeMax, snapshot.episodeMax);
    setVal(formRefs.diversityFactor, snapshot.diversityFactor);
    setVal(formRefs.maxPerCode, snapshot.maxPerCode);
    setChecked(formRefs.autoShuffle, snapshot.autoShuffle);
    setChecked(formRefs.limitToPage, snapshot.limitToPage);
    // Multi-selects — must be called AFTER <option>s are populated
    restoreMulti(formRefs.includeCodes, snapshot.includeCodesSelected);
    restoreMulti(formRefs.excludeCodes, snapshot.excludeCodesSelected);
  },

  // ─────────────── PUBLIC API ───────────────

  /**
   * Save full popup state: form values + search results + search params.
   *
   * @param {Object} payload
   *   .formRefs       - DOM references to all form fields
   *   .currentResults - Array of result objects (or empty [])
   *   .lastSearchParams - Last search parameters object (or null)
   */
  async save({ formRefs = {}, currentResults = [], lastSearchParams = null }) {
    const key = this._getKey();
    if (!key) {
      console.log("[STATE] ⚠️ Skip save: no tab ID");
      return;
    }
    const state = {
      form: this._collectFormSnapshot(formRefs),
      results: currentResults,
      lastSearchParams: lastSearchParams,
      savedAt: Date.now(),
    };
    try {
      await chrome.storage.session.set({ [key]: state });
      console.log(`[STATE] 💾 Saved for tab ${this._tabId}`, {
        query: state.form.query?.substring(0, 40),
        resultsCount: state.results?.length || 0,
      });
    } catch (err) {
      console.error("[STATE] ❌ Save failed:", err.message);
    }
  },

  /**
   * Load saved state for the current tab.
   *
   * @param {Object} formRefs - DOM references to all form fields
   * @returns {Object|null} The loaded state payload, or null if no saved state.
   *   Shape: { form, results, lastSearchParams, savedAt }
   */
  async load({ formRefs = {} }) {
    const key = this._getKey();
    if (!key) {
      console.log("[STATE] ⚠️ Skip load: no tab ID");
      return null;
    }
    try {
      const data = await chrome.storage.session.get(key);
      const state = data[key];
      if (!state || !state.savedAt) {
        console.log(`[STATE] 📭 No saved state for tab ${this._tabId}`);
        return null;
      }
      const ageSec = Math.round((Date.now() - state.savedAt) / 1000);
      console.log(
        `[STATE] 📂 Loaded state for tab ${this._tabId} (${ageSec}s old)`,
        {
          query: state.form?.query?.substring(0, 40),
          resultsCount: state.results?.length || 0,
        },
      );
      // Restore form fields into the DOM
      if (state.form) {
        this._restoreFormSnapshot(formRefs, state.form);
      }
      return {
        results: state.results || [],
        lastSearchParams: state.lastSearchParams || null,
        savedAt: state.savedAt,
      };
    } catch (err) {
      console.error("[STATE] ❌ Load failed:", err.message);
      return null;
    }
  },

  /**
   * Clear saved state for the current tab (e.g., on manual reset).
   */
  async clear() {
    const key = this._getKey();
    if (!key) return;
    try {
      await chrome.storage.session.remove(key);
      console.log(`[STATE] 🧹 Cleared state for tab ${this._tabId}`);
    } catch (err) {
      console.error("[STATE] ❌ Clear failed:", err.message);
    }
  },

  /**
   * Clear ALL saved states across all tabs (e.g., on extension uninstall or debug).
   */
  async clearAll() {
    try {
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith("popupState_"));
      if (keys.length > 0) {
        await chrome.storage.session.remove(keys);
        console.log(`[STATE] 🧹 Cleared all ${keys.length} tab states`);
      }
    } catch (err) {
      console.error("[STATE] ❌ Clear all failed:", err.message);
    }
  },

  /**
   * Get info about the current state without modifying anything.
   * Useful for debugging.
   */
  async info() {
    const key = this._getKey();
    if (!key) return { exists: false };
    try {
      const data = await chrome.storage.session.get(key);
      const state = data[key];
      return {
        exists: !!state,
        tabId: this._tabId,
        savedAt: state?.savedAt || null,
        ageMs: state?.savedAt ? Date.now() - state.savedAt : null,
        hasResults: state?.results?.length > 0,
        resultsCount: state?.results?.length || 0,
      };
    } catch {
      return { exists: false };
    }
  },
};

console.log("[STATE] ✅ state-persistence.js loaded");
