// client_paginated/app.js
// Search + browse now use GET /search_grouped (keyset cursor, grouped by code+episode).
// Similar videos now use GET /similar_grouped (grouped by code+episode).
// /search_clustered (HDBSCAN topics) is unchanged.
function app() {
  const API = "http://localhost:9001";
  const PAGE_SIZE = 20;
  const CLUSTER_TIER_THRESHOLDS = {
    green: { consistency: 0.75, centroidSim: 0.7 },
    amber: { consistency: 0.55, centroidSim: 0.6 },
    core: { silhouette: 0.4, probability: 0.7 },
  };
  // Diversity presets -> /search_grouped & /similar_grouped `diversity` (MMR, 0 = off)
  const DIVERSITY_LEVELS = { off: 0, low: 0.25, medium: 0.5, high: 0.8 };
  // Grouped item -> shape the card templates already expect.
  function normalizeGrouped(g) {
    return {
      ...g,
      similarity: g.score ?? null, // score -> similarity
      // Prefer standard url, fallback to uncensored or engsub if needed/available
      url: g.url || g.url_uncnsrd || g.url_engsub || null,
    };
  }
  return {
    // ── state ──
    mode: "browse", // 'search' | 'similar' | 'browse' | 'clustered'
    query: "",
    lastQuery: "",
    items: [],
    cursor: null,
    exhausted: false,
    loading: false,
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
    // grouped-search diversity (MMR)
    diversity: "off", // key of DIVERSITY_LEVELS
    codeInput: "",
    codeSuggestions: [],
    showCodeDropdown: false,
    genresModalOpen: false,
    genreSortBy: "count",
    genreSortOrder: "desc",
    facets: { genres: [], years: [], codes: [] },
    detail: { open: false, loading: false, video: null },
    similarOf: null,
    toasts: [],
    previousMode: null,
    previousQuery: null,
    // ── preview state ──
    showPreview: null,
    holdPreviews: [],
    _previewPlayer: null,
    // ── generation counters ──
    _gen: 0,
    _genClustered: 0,
    // ── clustered-mode state ──
    clustered: { data: null, loading: false, error: null, _inflight: false },
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
      window.addEventListener("popstate", () => {
        this.hydrateFromURL();
        this.refetchOrCluster();
      });
      if (this.mode === "clustered") this.fetchClustered();
      else this.refetch();
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
    // ── preview playback ──
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
      return document.getElementById(`preview-${key}`);
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
        if (p && typeof p.catch === "function") p.catch(() => {});
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
      this.similarOf = p.get("sim") || null;
      const div = p.get("div");
      this.diversity = div && div in DIVERSITY_LEVELS ? div : "off";
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
      if (this.filters.code) p.set("code", this.filters.code);
      if (this.filters.from) p.set("from", this.filters.from);
      if (this.filters.to) p.set("to", this.filters.to);
      if (this.filters.genresMode !== "any")
        p.set("gmode", this.filters.genresMode);
      if (this.filters.genres.length)
        p.set("genres", this.filters.genres.join(","));
      if (this.filters.completionFilter !== "all")
        p.set("cf", this.filters.completionFilter);
      if (this.diversity !== "off" && this.isGroupedMode())
        p.set("div", this.diversity);
      const newUrl = `${location.pathname}?${p}`;
      if (push) history.pushState(null, "", newUrl);
      else history.replaceState(null, "", newUrl);
    },
    isGroupedMode() {
      return (
        this.mode === "search" ||
        this.mode === "browse" ||
        this.mode === "similar"
      );
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
      this.syncURL(true);
      this.refetch();
    },
    // Diversity (MMR) selector handler
    setDiversity(level) {
      if (!(level in DIVERSITY_LEVELS)) return;
      this.diversity = level;
      this.syncURL();
      if (this.isGroupedMode()) this.refetch();
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
    // Code autocomplete
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
    _currentCodes() {
      return this.filters.code
        ? this.filters.code
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : [];
    },
    addCodeChip(codeObj) {
      const code = codeObj.code;
      const currentCodes = this._currentCodes();
      if (!currentCodes.includes(code)) {
        currentCodes.push(code);
        this.filters.code = currentCodes.join(", ");
      }
      this.codeInput = "";
      this.showCodeDropdown = false;
      this.syncURL();
      this.refetchOrCluster();
    },
    removeCodeChip(code) {
      this.filters.code = this._currentCodes()
        .filter((c) => c !== code)
        .join(", ");
      this.syncURL();
      this.refetchOrCluster();
    },
    toggleGenre(name) {
      const i = this.filters.genres.indexOf(name);
      if (i >= 0) this.filters.genres.splice(i, 1);
      else this.filters.genres.push(name);
      this.syncURL();
      this.refetchOrCluster();
    },
    setCompletionFilter(val) {
      this.filters.completionFilter = val;
      this.syncURL();
      this.refetchOrCluster();
      this.fetchFacets();
    },
    pickYear(year) {
      this.filters.from = `${year}-01-01`;
      this.filters.to = `${year}-12-31`;
      this.syncURL();
      this.refetchOrCluster();
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
      this.refetchOrCluster();
    },
    recentYears() {
      return this.facets.years
        .filter((y) => y.year >= 2000)
        .slice(-10)
        .reverse();
    },
    // Genre modal sorting
    get sortedGenresForModal() {
      const genres = [...this.facets.genres];
      if (this.genreSortBy === "name") {
        genres.sort((a, b) => a.name.localeCompare(b.name));
        return this.genreSortOrder === "desc" ? genres.reverse() : genres;
      }
      genres.sort((a, b) => b.count - a.count);
      return this.genreSortOrder === "asc" ? genres.reverse() : genres;
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
          this.exhausted = false;
        }
        // /search_grouped and /similar_grouped items need normalizing;
        // clustered items are handled separately.
        const incoming =
          params.kind === "grouped"
            ? page.items.map(normalizeGrouped)
            : page.items;
        this.items.push(...incoming);
        this.cursor = page.next_cursor;
        this.exhausted = !page.has_more || !page.next_cursor;
        this.lastTook = page.took_ms ?? null;
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
    // ── shared filter helpers ──
    _codeList() {
      const raw = (this.filters.code || "").trim();
      if (!raw) return [];
      return [
        ...new Set(
          raw
            .split(",")
            .map((c) => c.trim().toLowerCase())
            .filter(Boolean),
        ),
      ];
    },
    _isoFrom() {
      return this.filters.from
        ? new Date(this.filters.from + "T00:00:00Z").toISOString()
        : null;
    },
    _isoTo() {
      return this.filters.to
        ? new Date(this.filters.to + "T23:59:59Z").toISOString()
        : null;
    },
    buildClusteredParams() {
      const codes = this._codeList();
      const genres = this.filters.genres;
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
        genre:
          genres.length === 0 ? null : genres.length === 1 ? genres[0] : genres,
        genres_mode: this.filters.genresMode,
        code: codes.length === 0 ? null : codes.length === 1 ? codes[0] : codes,
        min_release_date: this._isoFrom(),
        max_release_date: this._isoTo(),
        min_similarity: null,
        completion_filter: this.filters.completionFilter,
      };
    },
    // Builds the request for the active paginated mode.
    //   search / browse / similar -> GET /search_grouped or /similar_grouped
    buildParams(reset) {
      // Handle Similar Mode via /similar_grouped
      if (this.mode === "similar") {
        const p = new URLSearchParams();
        p.set("video_id", this.similarOf);
        p.set("limit", String(PAGE_SIZE));
        if (!reset && this.cursor) p.set("cursor", this.cursor);

        this._codeList().forEach((c) => p.append("code", c));
        this.filters.genres.forEach((g) => p.append("genre", g));
        p.set("genres_mode", this.filters.genresMode);

        const from = this._isoFrom();
        const to = this._isoTo();
        if (from) p.set("min_release_date", from);
        if (to) p.set("max_release_date", to);
        if (this.filters.completionFilter !== "all")
          p.set("completion_filter", this.filters.completionFilter);

        const div = DIVERSITY_LEVELS[this.diversity] ?? 0;
        if (div > 0) p.set("diversity", String(div));

        return {
          kind: "grouped",
          path: `/similar_grouped?${p}`,
          method: "GET",
        };
      }

      if (this.mode === "search" && !this.lastQuery) {
        this.mode = "browse";
        this.similarOf = null;
        this.syncURL();
      }

      const p = new URLSearchParams();
      if (this.mode === "search" && this.lastQuery)
        p.set("query", this.lastQuery);
      p.set("limit", String(PAGE_SIZE));
      if (!reset && this.cursor) p.set("cursor", this.cursor);

      this._codeList().forEach((c) => p.append("code", c));
      this.filters.genres.forEach((g) => p.append("genre", g));
      p.set("genres_mode", this.filters.genresMode);

      const from = this._isoFrom();
      const to = this._isoTo();
      if (from) p.set("min_release_date", from);
      if (to) p.set("max_release_date", to);
      if (this.filters.completionFilter !== "all")
        p.set("completion_filter", this.filters.completionFilter);

      const div = DIVERSITY_LEVELS[this.diversity] ?? 0;
      if (div > 0) p.set("diversity", String(div));

      return { kind: "grouped", path: `/search_grouped?${p}`, method: "GET" };
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
      return this.clusterUi[id] || { coreOnly: false, hidden: false };
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
