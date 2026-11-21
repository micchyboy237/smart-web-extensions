// client_paginated/js/app.js
import {
  API,
  normalizeCodeList,
  normalizeGenreList,
  fetchFacets,
  searchVideos,
  searchSimilar,
  browseVideos,
  searchClustered,
  getVideo,
} from "./api.js";
import { hydrateFromURL, syncURL } from "./urlSync.js";
import { buildFiltersParams, buildDateRange } from "./filters.js";
import {
  createAutocompleteState,
  getCodeOptions,
  parseCodeInput,
} from "./autocomplete.js";
import { createPreviewManager } from "./preview.js";
import { GENRE_MAX_VISIBLE, sortedGenres, visibleGenres } from "./genres.js";
import {
  CLUSTER_TIER_THRESHOLDS,
  clusterTier,
  clusterLabel,
  clusterTierDotClass,
  clusterSegments,
  isCoreItem,
  isFringeItem,
  buildClusteredParams,
} from "./clusters.js";

// Expose helpers used by clusters.js via window bridge (avoids circular import).
window.__api = { normalizeCodeList, normalizeGenreList };

function app() {
  const preview = createPreviewManager();

  return {
    // ── state ──
    mode: "browse",
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
    similarSourceVideo: null, // full video details for the "similar" header
    toasts: [],

    // ── autocomplete ──
    codeAutocomplete: createAutocompleteState(),

    // ── genres modal ──
    genresModal: { open: false, sortBy: "count", order: "desc" },
    genresExpanded: false,

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

    // ── computed ──
    get selectedCodes() {
      return parseCodeInput(this.filters.code);
    },
    get sortedGenresList() {
      return sortedGenres(
        this.facets.genres,
        this.genresModal.sortBy,
        this.genresModal.order,
      );
    },
    get visibleGenresList() {
      return visibleGenres(this.sortedGenresList, this.genresExpanded);
    },
    get hasMoreGenres() {
      return this.facets.genres.length > GENRE_MAX_VISIBLE;
    },
    get codeOptions() {
      return getCodeOptions(
        this.facets,
        this.selectedCodes,
        this.codeAutocomplete.input,
      );
    },

    // ── cluster helper passthroughs (for template) ──
    clusterTier,
    clusterLabel,
    clusterTierDotClass,
    clusterSegments,
    isCoreItem,
    isFringeItem,

    // ── lifecycle ──
    boot() {
      hydrateFromURL(this);
      this.refreshIcons();
      this.$nextTick(() => this.refreshIcons());
      this.fetchFacets();
      if (this.mode === "clustered") {
        this.fetchClustered();
      } else {
        this.refetch();
      }
      if (this.mode === "similar" && this.similarOf) {
        this.loadSimilarSource();
      }

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          if (this.genresModal.open) this.genresModal.open = false;
          else this.closeDetail();
        }
        if (
          e.key === "/" &&
          !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
        ) {
          e.preventDefault();
          this.$refs.searchInput?.focus();
        }
      });

      // Handle browser back/forward.
      window.addEventListener("popstate", () => {
        hydrateFromURL(this);
        if (this.mode === "clustered") this.fetchClustered();
        else {
          this.refetch();
          if (this.mode === "similar" && this.similarOf)
            this.loadSimilarSource();
          else this.similarSourceVideo = null;
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
      if (this.$refs.sentinel) io.observe(this.$refs.sentinel);

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
      this.$watch("genresModal.open", () =>
        this.$nextTick(() => this.refreshIcons()),
      );
    },

    refreshIcons() {
      if (window.lucide) lucide.createIcons();
    },

    // ── navigation ──
    pushURL() {
      // pushState (not replace) so Back works.
      const params = new URLSearchParams(location.search);
      // syncURL mutates via replaceState; we rebuild here for push.
      const p = new URLSearchParams();
      if (this.mode === "search" && this.lastQuery) p.set("q", this.lastQuery);
      if (this.mode === "clustered") {
        p.set("mode", "clustered");
        if (this.lastQuery) p.set("q", this.lastQuery);
        if (Number.isFinite(this.clusterPrefs.candidateLimit))
          p.set("cl", String(this.clusterPrefs.candidateLimit));
        if (this.clusterPrefs.minClusterSize !== 2)
          p.set("msize", String(this.clusterPrefs.minClusterSize));
        if (this.clusterPrefs.epsilon !== 0.25)
          p.set("eps", String(this.clusterPrefs.epsilon));
        if (this.clusterPrefs.candidateSource !== "recent")
          p.set("src", this.clusterPrefs.candidateSource);
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
      history.pushState(null, "", `${location.pathname}?${p}`);
    },

    goBack() {
      history.back();
    },

    // ── query actions ──
    onQueryInput() {
      clearTimeout(this._deb);
      this._deb = setTimeout(() => {
        if (this.mode === "clustered") {
          this.lastQuery = this.query.trim();
          this.pushURL();
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
      this.similarSourceVideo = null;
      if (
        this.sort === "release_date" &&
        !new URLSearchParams(location.search).get("sort")
      ) {
        this.sort = "similarity";
      }
      this.pushURL();
      this.refetch();
    },

    doBrowse() {
      this.mode = "browse";
      this.similarOf = null;
      this.similarSourceVideo = null;
      if (!new URLSearchParams(location.search).get("sort")) {
        this.sort = "release_date";
      }
      this.pushURL();
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
      this.similarSourceVideo = null;
      this.pushURL();
      this.fetchClustered();
    },

    applyClusterPrefs() {
      this.pushURL();
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

    async findSimilar(id) {
      clearTimeout(this._deb);
      this.closeDetail();
      this.mode = "similar";
      this.similarOf = id;
      this.similarSourceVideo = null;
      this.pushURL();
      await this.refetch();
      this.loadSimilarSource();
    },

    findSimilarFromCluster(id) {
      this.findSimilar(id);
    },

    // Load the full source video for the "Similar videos" header.
    async loadSimilarSource() {
      if (!this.similarOf) return;
      try {
        this.similarSourceVideo = await getVideo(this.similarOf);
        this.$nextTick(() => this.refreshIcons());
      } catch {
        this.similarSourceVideo = null;
      }
    },

    // ── filters ──
    toggleGenre(name) {
      const i = this.filters.genres.indexOf(name);
      if (i >= 0) this.filters.genres.splice(i, 1);
      else this.filters.genres.push(name);
      this.pushURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },

    setCompletionFilter(val) {
      this.filters.completionFilter = val;
      this.pushURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
      this.fetchFacets();
    },

    pickYear(year) {
      this.filters.from = `${year}-01-01`;
      this.filters.to = `${year}-12-31`;
      this.pushURL();
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
      this.pushURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },

    recentYears() {
      return this.facets.years
        .filter((y) => y.year >= 2000)
        .slice(-10)
        .reverse();
    },

    // ── series-code autocomplete ──
    focusCodeInput() {
      this.codeAutocomplete.open = true;
      this.codeAutocomplete.highlightedIndex = -1;
    },
    onCodeInput() {
      this.codeAutocomplete.open = true;
      this.codeAutocomplete.highlightedIndex = -1;
    },
    onCodeBlur() {
      // Delay so a click on an option can register first.
      this.codeAutocomplete.blurTimer = setTimeout(() => {
        this.codeAutocomplete.open = false;
        this.codeAutocomplete.input = "";
        this.codeAutocomplete.highlightedIndex = -1;
        // Commit any free-typed text as a chip (e.g. partial code).
        const raw = (this.filters.code || "").trim();
        if (raw) {
          const codes = parseCodeInput(raw);
          this.filters.code = codes.join(", ");
        }
      }, 150);
    },
    addCode(code) {
      const codes = parseCodeInput(this.filters.code);
      if (!codes.includes(code.toLowerCase())) codes.push(code.toLowerCase());
      this.filters.code = codes.join(", ");
      this.codeAutocomplete.input = "";
      this.codeAutocomplete.highlightedIndex = -1;
      this.pushURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },
    removeCode(code) {
      const codes = parseCodeInput(this.filters.code).filter(
        (c) => c !== code.toLowerCase(),
      );
      this.filters.code = codes.join(", ");
      this.pushURL();
      this.mode === "clustered" ? this.fetchClustered() : this.refetch();
    },
    onCodeKeydown(e) {
      const opts = this.codeOptions;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.codeAutocomplete.highlightedIndex = Math.min(
          this.codeAutocomplete.highlightedIndex + 1,
          opts.length - 1,
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.codeAutocomplete.highlightedIndex = Math.max(
          this.codeAutocomplete.highlightedIndex - 1,
          -1,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const idx = this.codeAutocomplete.highlightedIndex;
        if (idx >= 0 && opts[idx]) {
          this.addCode(opts[idx].code);
        } else {
          // Commit free-typed text.
          const raw = (this.filters.code || "").trim();
          if (raw) {
            parseCodeInput(raw).forEach((c) => this.addCode(c));
            this.filters.code = "";
          }
        }
        this.codeAutocomplete.open = false;
      } else if (e.key === "Escape") {
        this.codeAutocomplete.open = false;
      }
    },

    // ── genres modal ──
    openGenresModal() {
      this.genresModal.open = true;
    },
    setGenreSort(sortBy, order) {
      this.genresModal.sortBy = sortBy;
      this.genresModal.order = order;
    },

    // ── fetching (paginated) ──
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
        let page;
        if (params.method === "POST") {
          if (params.path === "/search") page = await searchVideos(params.body);
          else if (params.path === "/similar")
            page = await searchSimilar(params.body);
          else throw new Error(`Unknown POST path: ${params.path}`);
        } else {
          page = await browseVideos(params.query);
        }
        if (gen !== this._gen) return;
        this.online = true;
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

    buildParams(reset) {
      const f = buildFiltersParams(this.filters);
      const dates = buildDateRange(this.filters);

      if (this.mode === "search") {
        if (!this.lastQuery) {
          this.mode = "browse";
          this.similarOf = null;
          this.pushURL();
          return this.buildParams(reset);
        }
        return {
          method: "POST",
          path: "/search",
          body: {
            query: this.lastQuery,
            limit: 20,
            cursor: reset ? null : this.cursor,
            code: f.code,
            genre: f.genre,
            genres_mode: f.genres_mode,
            min_release_date: dates.min_release_date,
            max_release_date: dates.max_release_date,
            sort: this.sort || "similarity",
            order: this.order || "desc",
            completion_filter: f.completion_filter,
          },
        };
      }
      if (this.mode === "similar") {
        return {
          method: "POST",
          path: "/similar",
          body: {
            video_id: this.similarOf,
            limit: 20,
            cursor: reset ? null : this.cursor,
            genre: f.genre,
            code: f.code,
            genres_mode: f.genres_mode,
            sort: "similarity",
            order: "desc",
            completion_filter: f.completion_filter,
          },
        };
      }
      // browse
      const p = new URLSearchParams();
      p.set("limit", "20");
      p.set("offset", reset ? "0" : String(this.page * 20));
      if (f.code) {
        if (Array.isArray(f.code)) f.code.forEach((c) => p.append("code", c));
        else p.set("code", f.code);
      }
      const browseSort =
        this.sort === "release_date" || this.sort === "created_at"
          ? this.sort
          : "release_date";
      p.set("sort", browseSort);
      p.set("order", this.order || "desc");
      p.set("genres_mode", f.genres_mode);
      if (f.completion_filter !== "all")
        p.set("completion_filter", f.completion_filter);
      if (f.genre) {
        if (Array.isArray(f.genre))
          f.genre.forEach((g) => p.append("genre", g));
        else p.set("genre", f.genre);
      }
      return { method: "GET", path: "/browse", query: p.toString() };
    },

    // ── fetching (clustered) ──
    async fetchClustered() {
      this.clustered._inflight = true;
      this.clustered.loading = true;
      this.clustered.error = null;
      const gen = ++this._genClustered;
      const params = buildClusteredParams(this);
      try {
        const data = await searchClustered(params);
        if (gen !== this._genClustered) return;
        this.online = true;
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

    async fetchFacets() {
      try {
        this.facets = await fetchFacets(this.filters.completionFilter);
      } catch {
        /* ignore */
      }
    },

    // ── cluster view helpers ──
    visibleItems(c) {
      if (!c || !Array.isArray(c.items)) return [];
      const ui = this.clusterUiFor(c.cluster_id);
      let list = c.items;
      if (ui.coreOnly) list = list.filter((it) => isCoreItem(it));
      return list;
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

    // ── hover preview ──
    onCardEnter(id, previewUrl, event) {
      const container = event.currentTarget.querySelector(
        "[data-preview-container]",
      );
      preview.start(id, previewUrl, container);
    },
    onCardLeave(id, thumbnail, title, event) {
      preview.stop();
      const container = event.currentTarget.querySelector(
        "[data-preview-container]",
      );
      preview.restoreMedia(container, thumbnail, title);
    },

    // ── detail modal ──
    async openDetail(id) {
      this.detail = { open: true, loading: true, video: null };
      this.$nextTick(() => this.refreshIcons());
      try {
        this.detail.video = await getVideo(id);
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

    openSource(url) {
      if (url) window.open(url, "_blank", "noopener");
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

// Alpine expects a global function.
window.app = app;
