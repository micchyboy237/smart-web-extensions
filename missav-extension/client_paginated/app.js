// client_paginated/app.js
function app() {
  const API = "http://localhost:9001";

  // Cluster quality tiers — client-side display mapping only. The "core"
  // thresholds are the only ones the client invents; every other number
  // (probability, silhouette, consistency_score, etc.) is read verbatim
  // from /search_clustered.
  const CLUSTER_TIER_THRESHOLDS = {
    green: { consistency: 0.75, centroidSim: 0.7 },
    amber: { consistency: 0.55, centroidSim: 0.6 },
    core: { silhouette: 0.4, probability: 0.7 },
  };

  // Advanced per-cluster diversification presets. Each maps 1:1 to the
  // /search_clustered flags documented in usage.md.
  const DIVERSIFY_PRESETS = {
    off: {
      diversifyItems: false,
      itemsPerCluster: null,
      itemDiversity: 0.6,
      itemShuffle: false,
      diversifyNoise: false,
    },
    reorder: {
      diversifyItems: true,
      itemsPerCluster: null,
      itemDiversity: 0.6,
      itemShuffle: false,
      diversifyNoise: false,
    },
    capped: {
      diversifyItems: true,
      itemsPerCluster: 10,
      itemDiversity: 0.7,
      itemShuffle: false,
      diversifyNoise: false,
    },
    paged: {
      diversifyItems: true,
      itemsPerCluster: 8,
      itemDiversity: 0.8,
      itemShuffle: true,
      diversifyNoise: false,
    },
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
    facets: { genres: [], years: [], codes: [] },
    detail: { open: false, loading: false, video: null },
    similarOf: null,
    toasts: [],

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

    // Server-side knobs passed verbatim to /search_clustered.
    //
    // `candidateLimit: null` means "let the server decide" — the server uses
    // CLUSTER_CANDIDATE_CAP_QUERY or CLUSTER_CANDIDATE_CAP_BROWSE.
    // There is no n_clusters — the server picks k via cluster_utils.
    clusterPrefs: {
      candidateLimit: null, // null = "auto" (server cap)
      minClusterSize: 2, // min_cluster_size (-s)
      epsilon: 0.25, // cluster_selection_epsilon (-e)
      candidateSource: "recent", // used only when query is null
      // ── NEW: per-cluster item diversification (opt-in) ──
      diversifyItems: false, // diversify_items
      itemsPerCluster: null, // items_per_cluster (null = no cap)
      itemDiversity: 0.6, // item_diversity [0,1]
      itemShuffle: false, // item_shuffle (makes itemSeed effective)
      diversifyNoise: false, // diversify_noise
      itemSeed: 1, // item_seed (rotated by "Next page")
    },

    // Client-only: visibility prefs per cluster.
    clusterUi: {}, // { [cluster_id]: { coreOnly, hidden } }

    // ── lifecycle ──
    boot() {
      this.hydrateFromURL();
      this.refreshIcons();
      this.$nextTick(() => this.refreshIcons());
      this.fetchFacets();
      if (this.mode === "clustered") {
        this.fetchClustered();
      } else {
        this.refetch();
      }
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.closeDetail();
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
    },

    refreshIcons() {
      if (window.lucide) lucide.createIcons();
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

      // ── Clustered knobs ──
      //
      // URL contract (unchanged for the core knobs):
      //   cl     → cluster_candidate_limit. Omitted or empty ⇒ "auto" (null).
      //   msize  → min_cluster_size.        Omitted ⇒ default (2).
      //   eps    → cluster_selection_epsilon. Omitted ⇒ default (0.25).
      //   src    → candidate_source.        Omitted ⇒ "recent".
      //
      // NEW URL contract (diversification):
      //   div    → "1" enables diversify_items. Omitted ⇒ false.
      //   ipc    → items_per_cluster.        Omitted ⇒ null (no cap).
      //   idiv   → item_diversity.           Omitted ⇒ 0.6.
      //   ishu   → "1" enables item_shuffle. Omitted ⇒ false.
      //   inoise → "1" enables diversify_noise. Omitted ⇒ false.
      //   iseed  → item_seed.                Omitted ⇒ 1.
      //
      // Defaults are omitted from the URL so a clean share link reproduces
      // the baseline behavior.
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

        // ── Diversification knobs ──
        this.clusterPrefs.diversifyItems = p.get("div") === "1";
        const ipcRaw = p.get("ipc");
        if (ipcRaw != null && ipcRaw !== "") {
          const ipc = parseInt(ipcRaw, 10);
          if (Number.isFinite(ipc)) {
            this.clusterPrefs.itemsPerCluster = Math.min(100, Math.max(1, ipc));
          }
        }
        const idivRaw = p.get("idiv");
        if (idivRaw != null && idivRaw !== "") {
          const idiv = parseFloat(idivRaw);
          if (Number.isFinite(idiv)) {
            this.clusterPrefs.itemDiversity = Math.min(1, Math.max(0, idiv));
          }
        }
        this.clusterPrefs.itemShuffle = p.get("ishu") === "1";
        this.clusterPrefs.diversifyNoise = p.get("inoise") === "1";
        const iseedRaw = p.get("iseed");
        if (iseedRaw != null && iseedRaw !== "") {
          const iseed = parseInt(iseedRaw, 10);
          if (Number.isFinite(iseed)) {
            this.clusterPrefs.itemSeed = Math.max(0, iseed);
          }
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

    syncURL() {
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
        // ── Diversification knobs ──
        if (this.clusterPrefs.diversifyItems) p.set("div", "1");
        if (
          this.clusterPrefs.diversifyItems &&
          Number.isFinite(this.clusterPrefs.itemsPerCluster)
        ) {
          p.set("ipc", String(this.clusterPrefs.itemsPerCluster));
        }
        if (
          this.clusterPrefs.diversifyItems &&
          this.clusterPrefs.itemDiversity !== 0.6
        ) {
          p.set("idiv", String(this.clusterPrefs.itemDiversity));
        }
        if (this.clusterPrefs.diversifyItems && this.clusterPrefs.itemShuffle) {
          p.set("ishu", "1");
        }
        if (
          this.clusterPrefs.diversifyItems &&
          this.clusterPrefs.diversifyNoise
        ) {
          p.set("inoise", "1");
        }
        if (
          this.clusterPrefs.diversifyItems &&
          this.clusterPrefs.itemShuffle &&
          this.clusterPrefs.itemSeed !== 1
        ) {
          p.set("iseed", String(this.clusterPrefs.itemSeed));
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
      if (this.mode === "browse") {
        if (this.sort !== "similarity") p.set("sort", this.sort);
        if (this.order !== "desc") p.set("order", this.order);
      }
      history.replaceState(null, "", `${location.pathname}?${p}`);
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
      this.mode = "search";
      this.lastQuery = q;
      this.similarOf = null;
      if (
        this.sort === "release_date" &&
        !new URLSearchParams(location.search).get("sort")
      ) {
        this.sort = "similarity";
      }
      this.syncURL();
      this.refetch();
    },

    doBrowse() {
      this.mode = "browse";
      this.similarOf = null;
      if (!new URLSearchParams(location.search).get("sort")) {
        this.sort = "release_date";
      }
      this.syncURL();
      this.refetch();
    },

    toggleClusterMode() {
      clearTimeout(this._deb);
      if (this.mode === "clustered") {
        if (this.lastQuery) this.doSearch();
        else this.doBrowse();
        return;
      }
      this.mode = "clustered";
      this.lastQuery = this.query.trim();
      this.similarOf = null;
      this.syncURL();
      this.fetchClustered();
    },

    applyClusterPrefs() {
      this.syncURL();
      if (this.mode === "clustered") this.fetchClustered();
    },

    // Preset helpers used by the preset selector in the header.
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

    // ── NEW: diversification preset helpers ──
    applyDiversifyPreset(name) {
      const p = DIVERSIFY_PRESETS[name];
      if (!p) return;
      Object.assign(this.clusterPrefs, p);
      // Reset the seed so "paged" starts from a stable page.
      if (p.itemShuffle) this.clusterPrefs.itemSeed = 1;
      this.applyClusterPrefs();
    },

    // Rotate the per-cluster page. Only meaningful when item_shuffle=true;
    // a no-op otherwise (the server ignores item_seed without item_shuffle).
    nextClusterPage() {
      this.clusterPrefs.itemSeed = (this.clusterPrefs.itemSeed || 0) + 1;
      this.applyClusterPrefs();
    },

    // True iff the current clustered request will actually honor item_seed.
    clusterItemsArePaged() {
      return (
        this.mode === "clustered" &&
        this.clusterPrefs.diversifyItems &&
        this.clusterPrefs.itemShuffle
      );
    },

    // True iff any per-cluster diversification is active.
    clusterDiversifyActive() {
      return this.mode === "clustered" && this.clusterPrefs.diversifyItems;
    },

    findSimilar(id) {
      clearTimeout(this._deb);
      this.closeDetail();
      this.mode = "similar";
      this.similarOf = id;
      this.syncURL();
      this.refetch();
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
      this.syncURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },

    recentYears() {
      return this.facets.years
        .filter((y) => y.year >= 2000)
        .slice(-10)
        .reverse();
    },

    // ── fetching (paginated modes) ──
    refetch() {
      this.items = [];
      this.cursor = null;
      this.page = 0;
      this.exhausted = false;
      this.fetchPage({ reset: true });
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
        this.items.push(...page.items);
        this.cursor = page.next_cursor;
        this.exhausted = !page.has_more || !page.next_cursor;
        this.lastTook = page.took_ms ?? null;
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
        // Preserve per-cluster UI state for clusters that still exist;
        // reset entries for clusters that were dropped.
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
      // Auto mode: send `null` so the server uses its cap. Sending `100`
      // (or any other client-invented number) would silently override the
      // server's much larger default and shrink the pool.
      const limit =
        Number.isFinite(this.clusterPrefs.candidateLimit) &&
        this.clusterPrefs.candidateLimit >= 10
          ? this.clusterPrefs.candidateLimit
          : null;

      // ── NEW: diversification knobs ──
      // Only sent when diversification is actually on. Keeps the payload
      // identical to the old client when the feature is off.
      const diversifyItems = !!this.clusterPrefs.diversifyItems;
      const itemsPerCluster =
        diversifyItems &&
        Number.isFinite(this.clusterPrefs.itemsPerCluster) &&
        this.clusterPrefs.itemsPerCluster >= 1
          ? Math.min(100, this.clusterPrefs.itemsPerCluster)
          : null;
      const itemDiversity = diversifyItems
        ? Math.min(1, Math.max(0, this.clusterPrefs.itemDiversity ?? 0.6))
        : 0.6;
      const itemShuffle = diversifyItems && !!this.clusterPrefs.itemShuffle;
      const diversifyNoise =
        diversifyItems && !!this.clusterPrefs.diversifyNoise;
      const itemSeed = itemShuffle
        ? Math.max(0, this.clusterPrefs.itemSeed | 0)
        : undefined;

      const body = {
        // Query is optional; server branches on presence.
        query: q,
        // cluster_utils knobs — no n_clusters, no include_noise.
        min_cluster_size: this.clusterPrefs.minClusterSize,
        cluster_selection_epsilon: this.clusterPrefs.epsilon,
        cluster_candidate_limit: limit, // null → server cap
        candidate_source: this.clusterPrefs.candidateSource,
        // Shared filters.
        genre: getGenreParam(),
        genres_mode: this.filters.genresMode,
        code: getCodeParam(),
        min_release_date: this.filters.from
          ? new Date(this.filters.from + "T00:00:00Z").toISOString()
          : null,
        max_release_date: this.filters.to
          ? new Date(this.filters.to + "T23:59:59Z").toISOString()
          : null,
        min_similarity: null, // server rejects when query is null
        completion_filter: this.filters.completionFilter,
        // ── Per-cluster diversification (opt-in) ──
        diversify_items: diversifyItems,
        items_per_cluster: itemsPerCluster,
        item_diversity: itemDiversity,
        item_shuffle: itemShuffle,
        diversify_noise: diversifyNoise,
      };
      if (itemSeed !== undefined) body.item_seed = itemSeed;
      return body;
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
      const sortFor = (mode) => {
        if (mode === "similar") return "similarity";
        if (mode === "browse") return this.sort || "release_date";
        return this.sort || "similarity";
      };
      const orderFor = (mode) => {
        if (mode === "similar") return "desc";
        return this.order || "desc";
      };

      if (this.mode === "search") {
        if (!this.lastQuery) {
          this.mode = "browse";
          this.similarOf = null;
          this.syncURL();
          return this.buildParams(reset);
        }
        return {
          path: "/search",
          method: "POST",
          body: {
            query: this.lastQuery,
            limit: 20,
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
            sort: sortFor("search"),
            order: orderFor("search"),
            completion_filter: this.filters.completionFilter,
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
        this.facets = await r.json();
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

    // Server already sorts items by (silhouette, probability) desc, so this
    // only filters — no re-sort. "core only" hides fringe and boundary items.
    visibleItems(c) {
      if (!c || !Array.isArray(c.items)) return [];
      const ui = this.clusterUiFor(c.cluster_id);
      let list = c.items;
      if (ui.coreOnly) list = list.filter((it) => this.isCoreItem(it));
      return list;
    },

    // ── NEW: cluster size helpers ──
    // `full_size` is always present in the updated API. Fall back to `size`
    // for safety when a cached/older response is being rendered.
    clusterFullSize(c) {
      return c?.full_size ?? c?.size ?? 0;
    },

    // True when the server actually ran MMR on this cluster's items.
    clusterWasDiversified(c) {
      return !!c?.diversified;
    },

    // Human-readable size label, e.g. "10 of 31" when capped.
    clusterSizeLabel(c) {
      const size = c?.size ?? 0;
      const full = this.clusterFullSize(c);
      if (full > size) return `${size} of ${full}`;
      return String(size);
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
