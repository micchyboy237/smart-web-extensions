// client_paginated/app.js
function app() {
  const API = "http://localhost:9001";

  // Cluster quality tiers (shared by header + card badges).
  // Thresholds are dataset-tunable; keep them in one place.
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
    facets: { genres: [], years: [], codes: [] },
    detail: { open: false, loading: false, video: null },
    similarOf: null,
    toasts: [],
    _gen: 0,

    // ── clustered-mode state ──
    clustered: {
      // null when not in clustered mode; otherwise the response payload
      data: null,
      loading: false,
      error: null,
    },
    clusterPrefs: {
      nClusters: 3,
      candidateLimit: 100,
      minClusterSize: 2,
      epsilon: 0.25,
      includeNoise: false,
      candidateSource: "recent", // used only when query is blank
    },
    // per-cluster UI state (keyed by cluster_id)
    clusterUi: {}, // { [id]: { coreOnly: bool, hidden: bool, expanded: bool } }

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

      // Infinite scroll only applies to non-clustered modes.
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

      // Cluster prefs from URL (so refreshes / shares keep the config).
      if (this.mode === "clustered") {
        const k = parseInt(p.get("k") || "", 10);
        if (Number.isFinite(k))
          this.clusterPrefs.nClusters = Math.min(10, Math.max(2, k));
        const cl = parseInt(p.get("cl") || "", 10);
        if (Number.isFinite(cl))
          this.clusterPrefs.candidateLimit = Math.min(500, Math.max(10, cl));
        this.clusterPrefs.includeNoise = p.get("noise") === "1";
        const src = p.get("src");
        if (src === "random" || src === "recent")
          this.clusterPrefs.candidateSource = src;
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
        p.set("k", String(this.clusterPrefs.nClusters));
        p.set("cl", String(this.clusterPrefs.candidateLimit));
        if (this.clusterPrefs.includeNoise) p.set("noise", "1");
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
      if (this.filters.completionFilter !== "all") {
        p.set("cf", this.filters.completionFilter);
      }
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
          // Re-run clustering with the new query (or clear it → blank).
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

    // New: enter/leave clustered mode. Keeps the current query (if any)
    // so the user can flip between "flat results" and "grouped results"
    // without retyping.
    toggleClusterMode() {
      if (this.mode === "clustered") {
        // leave clustered → back to search (or browse if no query)
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

    // Re-run clustered fetch when the user tweaks the cluster config
    // from the header (k, candidate limit, noise toggle).
    applyClusterPrefs() {
      this.syncURL();
      if (this.mode === "clustered") this.fetchClustered();
    },

    findSimilar(id) {
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
      this.clustered.loading = true;
      this.clustered.error = null;
      const gen = ++this._gen;

      const params = this.buildClusteredParams();
      try {
        const res = await fetch(`${API}/search_clustered`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        if (gen !== this._gen) return;
        this.online = true;
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`${res.status}: ${txt}`);
        }
        const data = await res.json();
        if (gen !== this._gen) return;
        this.clustered.data = data;
        this.lastTook = data.took_ms ?? null;

        // Reset per-cluster UI state for clusters that no longer exist,
        // and ensure every returned cluster has a default entry.
        const next = {};
        for (const c of data.clusters || []) {
          next[c.cluster_id] = this.clusterUi[c.cluster_id] || {
            coreOnly: false,
            hidden: false,
            expanded: false,
          };
        }
        this.clusterUi = next;

        this.$nextTick(() => this.refreshIcons());
      } catch (e) {
        if (gen !== this._gen) return;
        this.online = false;
        this.clustered.error = e.message;
        this.toast("error", e.message);
      } finally {
        if (gen === this._gen) this.clustered.loading = false;
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
      return {
        query: q, // nullable — server branches on presence
        n_clusters: this.clusterPrefs.nClusters,
        cluster_candidate_limit: this.clusterPrefs.candidateLimit,
        min_cluster_size: this.clusterPrefs.minClusterSize,
        cluster_selection_epsilon: this.clusterPrefs.epsilon,
        include_noise: this.clusterPrefs.includeNoise,
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
        // min_similarity only when a query is present (server rejects otherwise)
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

    // Map server scores → one of "green" | "amber" | "grey".
    // Works with or without a query: centroid_similarity is null when absent.
    clusterTier(c) {
      if (c.is_noise) return "grey";
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
      // No query: consistency only.
      if (consistency >= t.green.consistency) return "green";
      if (consistency >= t.amber.consistency) return "amber";
      return "grey";
    },

    clusterLabel(c) {
      if (c.is_noise) return "Tangential · mixed";
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

    // 0..5 segments for the mini bar under the header.
    clusterSegments(c) {
      return Math.round((c.consistency_score ?? 0) * 5);
    },

    // "core" per the UX spec: high silhouette AND high membership.
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

    // Items to render for a cluster, respecting per-cluster UI prefs.
    visibleItems(c) {
      const ui = this.clusterUi[c.cluster_id] || {};
      let list = c.items || [];
      if (ui.coreOnly) list = list.filter((it) => this.isCoreItem(it));
      return list;
    },

    // Every item rendered in clustered mode — used for "loaded" counts.
    clusteredItemCount() {
      if (!this.clustered.data) return 0;
      return (this.clustered.data.clusters || []).reduce(
        (n, c) => n + (c.items?.length || 0),
        0,
      );
    },

    // In clustered mode, find-similar should preserve the *query-less vs query*
    // context. If we got here with a query, keep it; otherwise still call
    // /similar (which doesn't need one).
    findSimilarFromCluster(id) {
      this.findSimilar(id);
    },

    clusterUiFor(id) {
      return (
        this.clusterUi[id] || {
          coreOnly: false,
          hidden: false,
          expanded: false,
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

    toggleClusterExpanded(id) {
      const cur = this.clusterUiFor(id);
      this.clusterUi = {
        ...this.clusterUi,
        [id]: { ...cur, expanded: !cur.expanded },
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
