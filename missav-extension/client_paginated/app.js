// client_paginated/app.js
function app() {
  const API = "http://localhost:9001";
  // Cluster quality tiers — client-side display mapping only.
  const CLUSTER_TIER_THRESHOLDS = {
    green: { consistency: 0.75, centroidSim: 0.7 },
    amber: { consistency: 0.55, centroidSim: 0.6 },
    core: { silhouette: 0.4, probability: 0.7 },
  };
  return {
    // ── state ──
    mode: "browse", // 'search' | 'similar' | 'browse' | 'clustered'
    query: "",
    lastQuery: "",
    items: [],
    cursor: null,
    page: 0,
    exhausted: false,
    loading: false,
    sort: "similarity",
    order: "desc",
    online: true,
    lastTook: null,
    filtersOpen: false,
    filters: {
      code: "",
      from: "",
      to: "",
      genresMode: "any",
      genres: [],
      completionFilter: "all",
    },
    // Grouped-search tuning (passed to /search_grouped)
    diversity: 0.0,
    fetchK: null, // null = server default
    diversityApplied: false,
    // New state for Code Autocomplete
    codeInput: "",
    codeSuggestions: [],
    showCodeDropdown: false,
    // New state for Genres Modal
    genresModalOpen: false,
    genreSortBy: "count",
    genreSortOrder: "desc",
    facets: { genres: [], years: [], codes: [] },
    detail: { open: false, loading: false, video: null },
    similarOf: null,
    toasts: [],
    // History tracking for Back button
    previousMode: null,
    previousQuery: null,
    // ── preview state (hover previews) ──
    showPreview: null,
    holdPreviews: [],
    _previewPlayer: null,
    // ── generation counters ──
    _gen: 0,
    _genClustered: 0,
    // ── clustered-mode state ──
    clustered: {
      data: null,
      loading: false,
      error: null,
      _inflight: false,
    },
    clusterPrefs: {
      candidateLimit: null,
      minClusterSize: 2,
      epsilon: 0.25,
      candidateSource: "recent",
    },
    clusterUi: {},
    // ── lifecycle ──
    boot() {
      this.hydrateFromURL();
      this.refreshIcons();
      this.$nextTick(() => this.refreshIcons());
      this.fetchFacets();
      // Handle Browser Back/Forward
      window.addEventListener("popstate", () => {
        this.hydrateFromURL();
        this.refetchOrCluster();
      });
      if (this.mode === "clustered") {
        this.fetchClustered();
      } else {
        this.refetch();
      }
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          if (this.genresModalOpen) this.genresModalOpen = false;
          else this.closeDetail();
        }
        if (
          e.key === "/" &&
          !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
        ) {
          e.preventDefault();
          this.$refs.searchInput.focus();
        }
      });
      const io = new IntersectionObserver(
        (entries) => {
          if (
            this.mode !== "clustered" &&
            entries[0].isIntersecting &&
            !this.exhausted &&
            !this.loading &&
            this.items.length
          ) {
            this.loadMore();
          }
        },
        { rootMargin: "400px" },
      );
      io.observe(this.$refs.sentinel);
      const checkSentinel = () => {
        if (this.mode === "clustered") return;
        const el = this.$refs.sentinel;
        if (!el || this.exhausted || this.loading || !this.items.length) return;
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight + 400) this.loadMore();
      };
      window.addEventListener("scroll", checkSentinel, { passive: true });
      this.$watch("items", () => {
        this.$nextTick(() => {
          this.refreshIcons();
          checkSentinel();
        });
      });
      this.$watch("detail.open", () =>
        this.$nextTick(() => this.refreshIcons()),
      );
      this.$watch("clustered.data", () =>
        this.$nextTick(() => this.refreshIcons()),
      );
      this.$watch("showPreview", (key) => {
        this._pauseCurrentPreview();
        if (key) this.$nextTick(() => this._playPreview(key));
      });
      this.$watch("holdPreviews", (keys) => {
        if (!this.showPreview && keys.length === 0) this._pauseCurrentPreview();
      });
    },
    refreshIcons() {
      if (window.lucide) lucide.createIcons();
    },
    // ── preview playback (hover + click-to-hold) ──
    _previewKeyOf(item) {
      return item?.id ? `home-0-${item.id}` : null;
    },
    _isPreviewActive(key) {
      return (
        !!key && (this.showPreview === key || this.holdPreviews.includes(key))
      );
    },
    isPreviewActive(key) {
      return this._isPreviewActive(key);
    },
    _previewEl(key) {
      if (!key) return null;
      const id = `preview-${key}`;
      return document.getElementById(id);
    },
    _pauseCurrentPreview() {
      const el = this._previewPlayer;
      if (el && !el.paused) {
        try {
          el.pause();
        } catch {
          /* ignore */
        }
      }
      this._previewPlayer = null;
    },
    setPreview(key) {
      const next = key || null;
      if (this.showPreview === next) return;
      this._pauseCurrentPreview();
      this.showPreview = next;
    },
    _playPreview(key) {
      const el = this._previewEl(key);
      if (!el) return;
      this._previewPlayer = el;
      try {
        const p = el.play();
        if (p && typeof p.catch === "function")
          p.catch(() => {
            /* autoplay blocked */
          });
      } catch {
        /* ignore */
      }
    },
    playPreview(key) {
      this._playPreview(key);
    },
    _holdPreview(key) {
      if (!key || this.holdPreviews.includes(key)) return;
      this.holdPreviews = [...this.holdPreviews, key];
    },
    _releaseHoldPreview(key) {
      if (!key) return;
      this.holdPreviews = this.holdPreviews.filter((k) => k !== key);
    },
    clickPreview(key) {
      if (!key) return;
      if (this.holdPreviews.includes(key)) {
        this._releaseHoldPreview(key);
        if (this.showPreview !== key) this._pauseCurrentPreview();
        return;
      }
      this._holdPreview(key);
      if (this.showPreview !== key) {
        this._pauseCurrentPreview();
        this._playPreview(key);
      }
    },
    previewError(key) {
      this._pauseCurrentPreview();
      if (this.showPreview === key) this.showPreview = null;
      this.holdPreviews = this.holdPreviews.filter((k) => k !== key);
    },
    clearPreviews() {
      this._pauseCurrentPreview();
      this.showPreview = null;
      this.holdPreviews = [];
    },
    // ── URL sync ──
    hydrateFromURL() {
      const p = new URLSearchParams(location.search);
      const urlMode = p.get("mode");
      const hasQ = !!p.get("q");
      this.mode = urlMode || (hasQ ? "search" : "browse");
      this.query = p.get("q") || "";
      this.lastQuery = this.query;
      this.filters.code = p.get("code") || "";
      this.filters.from = p.get("from") || "";
      this.filters.to = p.get("to") || "";
      this.filters.genresMode = p.get("gmode") || "any";
      this.filters.genres = (p.get("genres") || "").split(",").filter(Boolean);
      const cf = p.get("cf");
      this.filters.completionFilter =
        cf === "complete" || cf === "incomplete" ? cf : "all";
      // Grouped-search tuning from URL
      const divRaw = p.get("div");
      if (divRaw != null && divRaw !== "") {
        const d = parseFloat(divRaw);
        if (Number.isFinite(d)) this.diversity = Math.min(1, Math.max(0, d));
      }
      const fkRaw = p.get("fk");
      if (fkRaw != null && fkRaw !== "") {
        const fk = parseInt(fkRaw, 10);
        this.fetchK = Number.isFinite(fk) && fk > 0 ? fk : null;
      }
      this.similarOf = p.get("sim") || null;
      if (this.mode === "clustered") {
        const clRaw = p.get("cl");
        if (clRaw == null || clRaw === "") {
          this.clusterPrefs.candidateLimit = null;
        } else {
          const cl = parseInt(clRaw, 10);
          this.clusterPrefs.candidateLimit = Number.isFinite(cl) ? cl : null;
        }
        const msRaw = p.get("msize");
        if (msRaw != null && msRaw !== "") {
          const ms = parseInt(msRaw, 10);
          if (Number.isFinite(ms)) {
            this.clusterPrefs.minClusterSize = Math.min(20, Math.max(2, ms));
          }
        }
        const epsRaw = p.get("eps");
        if (epsRaw != null && epsRaw !== "") {
          const eps = parseFloat(epsRaw);
          if (Number.isFinite(eps)) {
            this.clusterPrefs.epsilon = Math.min(1, Math.max(0, eps));
          }
        }
        const src = p.get("src");
        if (src === "random" || src === "recent") {
          this.clusterPrefs.candidateSource = src;
        }
      }
      const urlSort = p.get("sort");
      if (this.mode === "browse") {
        this.sort =
          urlSort === "release_date" || urlSort === "created_at"
            ? urlSort
            : "release_date";
      } else {
        this.sort = urlSort || "similarity";
      }
      this.order = p.get("order") || "desc";
    },
    syncURL(push = false) {
      const p = new URLSearchParams();
      if (this.mode === "search" && this.lastQuery) p.set("q", this.lastQuery);
      if (this.mode === "clustered") {
        p.set("mode", "clustered");
        if (this.lastQuery) p.set("q", this.lastQuery);
        if (Number.isFinite(this.clusterPrefs.candidateLimit)) {
          p.set("cl", String(this.clusterPrefs.candidateLimit));
        }
        if (this.clusterPrefs.minClusterSize !== 2) {
          p.set("msize", String(this.clusterPrefs.minClusterSize));
        }
        if (this.clusterPrefs.epsilon !== 0.25) {
          p.set("eps", String(this.clusterPrefs.epsilon));
        }
        if (this.clusterPrefs.candidateSource !== "recent") {
          p.set("src", this.clusterPrefs.candidateSource);
        }
      }
      if (this.mode === "browse") p.set("mode", "browse");
      if (this.mode === "similar" && this.similarOf) {
        p.set("mode", "similar");
        p.set("sim", this.similarOf);
      }
      // Grouped-search tuning
      if (this.mode === "search") {
        if (this.diversity !== 0.0) p.set("div", String(this.diversity));
        if (Number.isFinite(this.fetchK) && this.fetchK > 0) {
          p.set("fk", String(this.fetchK));
        }
      }
      // Serialize code chips/filters
      if (this.filters.code) p.set("code", this.filters.code);
      if (this.filters.from) p.set("from", this.filters.from);
      if (this.filters.to) p.set("to", this.filters.to);
      if (this.filters.genresMode !== "any")
        p.set("gmode", this.filters.genresMode);
      if (this.filters.genres.length)
        p.set("genres", this.filters.genres.join(","));
      if (this.filters.completionFilter !== "all")
        p.set("cf", this.filters.completionFilter);
      // sort/order only meaningful for browse (search grouped has no sort)
      if (this.mode === "browse") {
        if (this.sort !== "similarity") p.set("sort", this.sort);
        if (this.order !== "desc") p.set("order", this.order);
      }
      const newUrl = `${location.pathname}?${p}`;
      if (push) {
        history.pushState(null, "", newUrl);
      } else {
        history.replaceState(null, "", newUrl);
      }
    },
    // ── actions ──
    onQueryInput() {
      clearTimeout(this._deb);
      this._deb = setTimeout(() => {
        if (this.mode === "clustered") {
          this.lastQuery = this.query.trim();
          this.syncURL();
          this.fetchClustered();
          return;
        }
        if (this.query.trim()) {
          this.doSearch();
        } else if (this.mode === "search" || this.mode === "similar") {
          this.doBrowse();
        }
      }, 400);
    },
    doSearch() {
      const q = this.query.trim();
      if (!q) {
        if (this.mode !== "browse") this.doBrowse();
        return;
      }
      this.previousMode = this.mode;
      this.mode = "search";
      this.lastQuery = q;
      this.similarOf = null;
      this.syncURL(true);
      this.refetch();
    },
    doBrowse() {
      this.previousMode = this.mode;
      this.mode = "browse";
      this.similarOf = null;
      if (!new URLSearchParams(location.search).get("sort")) {
        this.sort = "release_date";
      }
      this.syncURL(true);
      this.refetch();
    },
    toggleClusterMode() {
      clearTimeout(this._deb);
      if (this.mode === "clustered") {
        if (this.lastQuery) this.doSearch();
        else this.doBrowse();
        return;
      }
      this.previousMode = this.mode;
      this.mode = "clustered";
      this.lastQuery = this.query.trim();
      this.similarOf = null;
      this.syncURL(true);
      this.fetchClustered();
    },
    applyClusterPrefs() {
      this.syncURL();
      if (this.mode === "clustered") this.fetchClustered();
    },
    applyClusterPreset(name) {
      const presets = {
        tight: { minClusterSize: 4, epsilon: 0.15 },
        balanced: { minClusterSize: 2, epsilon: 0.25 },
        loose: { minClusterSize: 2, epsilon: 0.45 },
      };
      const p = presets[name];
      if (!p) return;
      this.clusterPrefs.minClusterSize = p.minClusterSize;
      this.clusterPrefs.epsilon = p.epsilon;
      this.applyClusterPrefs();
    },
    // Grouped-search tuning setters
    applySearchTuning() {
      this.syncURL();
      if (this.mode === "search") this.refetch();
    },
    findSimilar(id) {
      clearTimeout(this._deb);
      this.closeDetail();
      this.previousMode = this.mode;
      this.previousQuery = this.lastQuery;
      this.mode = "similar";
      this.similarOf = id;
      this.syncURL(true);
      this.refetch();
    },
    goBack() {
      window.history.back();
    },
    // Code Autocomplete Logic
    onCodeInputFocus() {
      this.showCodeDropdown = true;
      this.updateCodeSuggestions();
    },
    onCodeInputBlur() {
      setTimeout(() => {
        this.showCodeDropdown = false;
      }, 200);
    },
    updateCodeSuggestions() {
      const input = this.codeInput.toLowerCase();
      if (!input) {
        this.codeSuggestions = this.facets.codes.slice(0, 10);
      } else {
        this.codeSuggestions = this.facets.codes
          .filter((c) => c.code.toLowerCase().includes(input))
          .slice(0, 10);
      }
    },
    addCodeChip(codeObj) {
      const code = codeObj.code;
      const currentCodes = this.filters.code
        ? this.filters.code
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : [];
      if (!currentCodes.includes(code)) {
        currentCodes.push(code);
        this.filters.code = currentCodes.join(", ");
      }
      this.codeInput = "";
      this.showCodeDropdown = false;
      this.syncURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },
    removeCodeChip(code) {
      const currentCodes = this.filters.code
        ? this.filters.code
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : [];
      const newCodes = currentCodes.filter((c) => c !== code);
      this.filters.code = newCodes.join(", ");
      this.syncURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },
    toggleGenre(name) {
      const i = this.filters.genres.indexOf(name);
      if (i >= 0) this.filters.genres.splice(i, 1);
      else this.filters.genres.push(name);
      this.syncURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },
    setCompletionFilter(val) {
      this.filters.completionFilter = val;
      this.syncURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
      this.fetchFacets();
    },
    pickYear(year) {
      this.filters.from = `${year}-01-01`;
      this.filters.to = `${year}-12-31`;
      this.syncURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },
    clearFilters() {
      this.filters = {
        code: "",
        from: "",
        to: "",
        genresMode: "any",
        genres: [],
        completionFilter: "all",
      };
      this.codeInput = "";
      this.syncURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },
    recentYears() {
      return this.facets.years
        .filter((y) => y.year >= 2000)
        .slice(-10)
        .reverse();
    },
    // Genre Modal Sorting
    get sortedGenresForModal() {
      let genres = [...this.facets.genres];
      if (this.genreSortBy === "name") {
        genres.sort((a, b) => a.name.localeCompare(b.name));
      } else {
        genres.sort((a, b) => b.count - a.count);
      }
      if (this.genreSortOrder === "asc" && this.genreSortBy === "count") {
        genres.reverse();
      }
      if (this.genreSortBy === "name") {
        return this.genreSortOrder === "desc" ? genres.reverse() : genres;
      }
      return genres;
    },
    toggleGenreSort(by) {
      if (this.genreSortBy === by) {
        this.genreSortOrder = this.genreSortOrder === "asc" ? "desc" : "asc";
      } else {
        this.genreSortBy = by;
        this.genreSortOrder = by === "count" ? "desc" : "asc";
      }
    },
    // ── fetching (paginated modes) ──
    refetch() {
      this.clearPreviews();
      this.items = [];
      this.cursor = null;
      this.page = 0;
      this.exhausted = false;
      this.fetchPage({ reset: true });
    },
    refetchOrCluster() {
      if (this.mode === "clustered") this.fetchClustered();
      else this.refetch();
    },
    loadMore() {
      if (!this.exhausted && !this.loading) this.fetchPage();
    },
    async fetchPage({ reset = false } = {}) {
      this.loading = true;
      const gen = ++this._gen;
      try {
        const params = this.buildParams(reset);
        if (!params) {
          if (gen === this._gen) this.loading = false;
          return;
        }
        const res = await fetch(`${API}${params.path}`, {
          method: params.method,
          headers: params.body
            ? { "Content-Type": "application/json" }
            : undefined,
          body: params.body ? JSON.stringify(params.body) : undefined,
        });
        if (gen !== this._gen) return;
        this.online = true;
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`${res.status}: ${txt}`);
        }
        const page = await res.json();
        if (gen !== this._gen) return;
        if (reset) {
          this.items = [];
          this.cursor = null;
          this.page = 0;
          this.exhausted = false;
        }
        // Normalize grouped items: `score` → `similarity` so the rest of the
        // template (badges, sorting pill, etc.) keeps working unchanged.
        const normalized = (page.items || []).map((it) => ({
          ...it,
          similarity: it.similarity ?? it.score ?? null,
        }));
        this.items.push(...normalized);
        this.cursor = page.next_cursor;
        this.exhausted = !page.has_more || !page.next_cursor;
        this.lastTook = page.took_ms ?? null;
        this.diversityApplied = !!page.diversity_applied;
        if (this.mode === "browse") this.page += 1;
        this.$nextTick(() => this.refreshIcons());
      } catch (e) {
        if (gen !== this._gen) return;
        this.online = false;
        this.toast("error", e.message);
      } finally {
        if (gen === this._gen) this.loading = false;
      }
    },
    // ── fetching (clustered mode) ──
    async fetchClustered() {
      this.clearPreviews();
      this.clustered._inflight = true;
      this.clustered.loading = true;
      this.clustered.error = null;
      const gen = ++this._genClustered;
      const params = this.buildClusteredParams();
      try {
        const res = await fetch(`${API}/search_clustered`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        if (gen !== this._genClustered) return;
        this.online = true;
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`${res.status}: ${txt}`);
        }
        const data = await res.json();
        if (gen !== this._genClustered) return;
        this.clustered.data = data;
        this.lastTook = data.took_ms ?? null;
        const next = {};
        for (const c of data.clusters || []) {
          next[c.cluster_id] = this.clusterUi[c.cluster_id] || {
            coreOnly: false,
            hidden: false,
          };
        }
        this.clusterUi = next;
        this.$nextTick(() => this.refreshIcons());
      } catch (e) {
        if (gen !== this._genClustered) return;
        this.online = false;
        this.clustered.error = e.message;
        this.toast("error", e.message);
      } finally {
        this.clustered._inflight = false;
        if (gen === this._genClustered) this.clustered.loading = false;
      }
    },
    buildClusteredParams() {
      const getCodeParam = () => {
        const raw = (this.filters.code || "").trim();
        if (!raw) return null;
        const parts = raw
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean);
        const unique = [...new Set(parts)];
        if (unique.length === 0) return null;
        return unique.length === 1 ? unique[0] : unique;
      };
      const getGenreParam = () => {
        if (this.filters.genres.length === 0) return null;
        if (this.filters.genres.length === 1) return this.filters.genres[0];
        return this.filters.genres;
      };
      const q = this.lastQuery?.trim() || null;
      const limit =
        Number.isFinite(this.clusterPrefs.candidateLimit) &&
        this.clusterPrefs.candidateLimit >= 10
          ? this.clusterPrefs.candidateLimit
          : null;
      return {
        query: q,
        min_cluster_size: this.clusterPrefs.minClusterSize,
        cluster_selection_epsilon: this.clusterPrefs.epsilon,
        cluster_candidate_limit: limit,
        candidate_source: this.clusterPrefs.candidateSource,
        genre: getGenreParam(),
        genres_mode: this.filters.genresMode,
        code: getCodeParam(),
        min_release_date: this.filters.from
          ? new Date(this.filters.from + "T00:00:00Z").toISOString()
          : null,
        max_release_date: this.filters.to
          ? new Date(this.filters.to + "T23:59:59Z").toISOString()
          : null,
        min_similarity: null,
        completion_filter: this.filters.completionFilter,
      };
    },
    buildParams(reset) {
      const getCodeParam = () => {
        const raw = (this.filters.code || "").trim();
        if (!raw) return null;
        const parts = raw
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean);
        const unique = [...new Set(parts)];
        if (unique.length === 0) return null;
        return unique.length === 1 ? unique[0] : unique;
      };
      const getGenreParam = () => {
        if (this.filters.genres.length === 0) return null;
        if (this.filters.genres.length === 1) return this.filters.genres[0];
        return this.filters.genres;
      };
      if (this.mode === "search") {
        if (!this.lastQuery) {
          this.mode = "browse";
          this.similarOf = null;
          this.syncURL();
          return this.buildParams(reset);
        }
        // ✅ Replaced /search with /search_grouped.
        // GroupedSearchRequest schema: query, code, genre, genres_mode,
        // min_release_date, max_release_date, completion_filter,
        // min_similarity, diversity, fetch_k (plus pagination fields the
        // endpoint accepts on its own — kept optional / server-driven).
        return {
          path: "/search_grouped",
          method: "POST",
          body: {
            query: this.lastQuery,
            cursor: reset ? null : this.cursor,
            code: getCodeParam(),
            genre: getGenreParam(),
            genres_mode: this.filters.genresMode,
            min_release_date: this.filters.from
              ? new Date(this.filters.from + "T00:00:00Z").toISOString()
              : null,
            max_release_date: this.filters.to
              ? new Date(this.filters.to + "T23:59:59Z").toISOString()
              : null,
            completion_filter: this.filters.completionFilter,
            min_similarity: null,
            diversity: Number.isFinite(this.diversity) ? this.diversity : 0.0,
            fetch_k:
              Number.isFinite(this.fetchK) && this.fetchK > 0
                ? this.fetchK
                : null,
          },
        };
      }
      if (this.mode === "similar") {
        return {
          path: "/similar",
          method: "POST",
          body: {
            video_id: this.similarOf,
            limit: 20,
            cursor: reset ? null : this.cursor,
            genre: getGenreParam(),
            code: getCodeParam(),
            genres_mode: this.filters.genresMode,
            sort: "similarity",
            order: "desc",
            completion_filter: this.filters.completionFilter,
          },
        };
      }
      // browse
      const p = new URLSearchParams();
      p.set("limit", "20");
      p.set("offset", reset ? "0" : String(this.page * 20));
      const codeVal = getCodeParam();
      if (codeVal) {
        if (Array.isArray(codeVal)) codeVal.forEach((c) => p.append("code", c));
        else p.set("code", codeVal);
      }
      const browseSort =
        this.sort === "release_date" || this.sort === "created_at"
          ? this.sort
          : "release_date";
      p.set("sort", browseSort);
      p.set("order", this.order || "desc");
      p.set("genres_mode", this.filters.genresMode);
      if (this.filters.completionFilter !== "all") {
        p.set("completion_filter", this.filters.completionFilter);
      }
      const genreVal = getGenreParam();
      if (genreVal) {
        if (Array.isArray(genreVal))
          genreVal.forEach((g) => p.append("genre", g));
        else p.set("genre", genreVal);
      }
      return { path: `/browse?${p}`, method: "GET" };
    },
    async fetchFacets() {
      try {
        let qs = "";
        if (this.filters.completionFilter !== "all") {
          qs = `?completion_filter=${this.filters.completionFilter}`;
        }
        const r = await fetch(`${API}/facets${qs}`);
        const data = await r.json();
        this.facets = data;
        this.codeSuggestions = data.codes.slice(0, 10);
      } catch {
        /* ignore */
      }
    },
    // ── cluster view helpers ──
    clusterTier(c) {
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
    },
    clusterLabel(c) {
      if (!c || c.is_noise) return "Tangential · mixed";
      const tier = this.clusterTier(c);
      const hasQuery = c.centroid_similarity != null;
      if (hasQuery) {
        if (tier === "green") return "Very relevant · tightly grouped";
        if (tier === "amber") return "Related · grouped";
        return "Tangential · mixed";
      }
      if (tier === "green") return "Tightly grouped";
      if (tier === "amber") return "Loosely grouped";
      return "Mixed";
    },
    clusterTierDotClass(c) {
      return {
        green: "bg-emerald-400",
        amber: "bg-amber-400",
        grey: "bg-slate-500",
      }[this.clusterTier(c)];
    },
    clusterSegments(c) {
      return Math.round((c?.consistency_score ?? 0) * 5);
    },
    isCoreItem(it) {
      const t = CLUSTER_TIER_THRESHOLDS.core;
      return (
        (it.silhouette ?? 0) >= t.silhouette &&
        (it.probability ?? 0) >= t.probability
      );
    },
    isFringeItem(it) {
      return (it.silhouette ?? 0) < 0;
    },
    visibleItems(c) {
      if (!c || !Array.isArray(c.items)) return [];
      const ui = this.clusterUiFor(c.cluster_id);
      let list = c.items;
      if (ui.coreOnly) list = list.filter((it) => this.isCoreItem(it));
      return list;
    },
    findSimilarFromCluster(id) {
      this.findSimilar(id);
    },
    clusterUiFor(id) {
      return (
        this.clusterUi[id] || {
          coreOnly: false,
          hidden: false,
        }
      );
    },
    toggleClusterCoreOnly(id) {
      const cur = this.clusterUiFor(id);
      this.clusterUi = {
        ...this.clusterUi,
        [id]: { ...cur, coreOnly: !cur.coreOnly },
      };
    },
    toggleClusterHidden(id) {
      const cur = this.clusterUiFor(id);
      this.clusterUi = {
        ...this.clusterUi,
        [id]: { ...cur, hidden: !cur.hidden },
      };
    },
    // ── detail modal ──
    async openDetail(id) {
      this.detail = { open: true, loading: true, video: null };
      this.$nextTick(() => this.refreshIcons());
      try {
        const r = await fetch(`${API}/videos/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error(`Failed to load ${id}`);
        this.detail.video = await r.json();
      } catch (e) {
        this.toast("error", e.message);
        this.closeDetail();
      } finally {
        this.detail.loading = false;
        this.$nextTick(() => this.refreshIcons());
      }
    },
    closeDetail() {
      this.detail = { open: false, loading: false, video: null };
    },
    // ── toasts ──
    toast(type, msg) {
      const id = Math.random().toString(36).slice(2);
      this.toasts.push({ id, type, msg });
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
      }, 4000);
      this.$nextTick(() => this.refreshIcons());
    },
  };
}
