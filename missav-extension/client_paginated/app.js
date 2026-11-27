// client_paginated/app.js
function app() {
  const API = "http://localhost:9001";
  const PAGE_SIZE = 20;
  const DIVERSITY_LEVELS = { off: 0, low: 0.25, medium: 0.5, high: 0.8 };

  function formatCount(num) {
    if (num == null) return "0";
    if (num < 1000) return num.toString();
    if (num < 10000) return (num / 1000).toFixed(1) + "k";
    return Math.floor(num / 1000) + "k";
  }

  function normalizeGrouped(g) {
    return {
      ...g,
      similarity: g.score ?? null,
      url: g.url || g.url_uncnsrd || g.url_engsub || null,
    };
  }

  return {
    // ── state ──
    mode: "search",
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
    diversity: "off",
    codeInput: "",
    codeSuggestions: [],
    showCodeDropdown: false,
    genresModalOpen: false,
    codesModalOpen: false,
    genreSortBy: "count",
    genreSortOrder: "desc",
    codeSortBy: "count",
    codeSortOrder: "desc",
    facets: { genres: [], years: [], codes: [] },
    allGenres: [],
    detail: { open: false, loading: false, video: null },
    similarOf: null,
    toasts: [],

    // ── Topic Mode State ──
    topics: {
      dashboard: [],
      currentRun: null,
      loading: false,
      error: null,
      searchQuery: "", // Separate search for topics
      searchResults: [], // Store search results
      searchExhausted: false, // For pagination if needed
    },

    // ── preview state ──
    showPreview: null,
    holdPreviews: [],
    _previewPlayer: null,
    _gen: 0,

    boot() {
      this.hydrateFromURL();
      this.refreshIcons();
      this.$nextTick(() => this.refreshIcons());
      this.fetchFacets();

      window.addEventListener("popstate", () => {
        this.hydrateFromURL();
        // Only refetch if NOT in topic mode
        if (this.mode !== "topics") {
          this.refetch();
        } else {
          // If we are in topics, ensure we load the right view
          if (this.topics.currentRun && !this.topics.dashboard.length) {
            // If we landed directly on a run via URL, fetch dashboard first then detail
            this.fetchTopicDashboard().then(() => {
              // Logic to re-open specific run if needed could go here
            });
          } else if (!this.topics.searchQuery) {
            // If no search query, show dashboard
            this.fetchTopicDashboard();
          } else {
            // If there is a search query in state (from history?), perform search
            this.fetchTopicSearch();
          }
        }
      });

      // Initial Load Logic
      if (this.mode === "topics") {
        if (this.topics.searchQuery) {
          this.fetchTopicSearch();
        } else {
          this.fetchTopicDashboard();
        }
      } else {
        this.refetch();
      }

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          if (this.genresModalOpen) this.genresModalOpen = false;
          if (this.codesModalOpen) this.codesModalOpen = false;
          else if (this.topics.currentRun) this.closeTopicDetail();
          else this.closeDetail();
        }
        if (
          e.key === "/" &&
          !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
        ) {
          e.preventDefault();
          // Focus appropriate input based on mode
          if (this.mode === "topics") {
            this.$refs.topicSearchInput?.focus();
          } else {
            this.$refs.searchInput?.focus();
          }
        }
      });

      // Infinite Scroll Setup
      const io = new IntersectionObserver(
        (entries) => {
          if (
            this.mode !== "topics" && // Disable infinite scroll in topic mode for now, or implement if needed
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
        if (this.mode === "topics") return;
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

      this.$watch("showPreview", (key) => {
        this._pauseCurrentPreview();
        if (key) this.$nextTick(() => this._playPreview(key));
      });

      // Watch topic search query for debounced search
      this.$watch("topics.searchQuery", (val) => {
        clearTimeout(this._topicDeb);
        this._topicDeb = setTimeout(() => {
          if (val.trim()) {
            this.fetchTopicSearch();
          } else if (val === "") {
            // Optional: Clear results or go back to dashboard?
            // Let's keep results until user clears or navigates away,
            // or we could switch back to dashboard.
            // For now, let's just clear results if empty to show dashboard logic if we wanted,
            // but usually empty search shows nothing or dashboard.
            // Let's stick to: if empty, don't auto-fetch dashboard, just clear results.
            this.topics.searchResults = [];
          }
        }, 600);
      });
    },

    refreshIcons() {
      if (window.lucide) lucide.createIcons();
    },

    // ── Preview Helpers ──
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
        } catch {}
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
      } catch {}
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

    // ── URL Sync ──
    hydrateFromURL() {
      const p = new URLSearchParams(location.search);
      const urlMode = p.get("mode");
      const hasQ = !!p.get("q");

      if (urlMode === "topics") {
        this.mode = "topics";
        const runId = p.get("run");
        const topicQ = p.get("tq"); // Topic Query param

        if (topicQ) {
          this.topics.searchQuery = topicQ;
          this.topics.currentRun = null;
        } else if (runId) {
          // We will handle opening the run in boot/fetch logic to avoid race conditions
          this.topics.currentRun = { run: { id: runId } }; // Placeholder to trigger UI
          this.topics.searchQuery = "";
        } else {
          this.topics.currentRun = null;
          this.topics.searchQuery = "";
        }
      } else {
        this.mode = "search";
        this.query = p.get("q") || "";
        this.lastQuery = this.query;
        this.topics.currentRun = null;
        this.topics.searchQuery = "";
      }

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
    },

    syncURL(push = false) {
      const p = new URLSearchParams();
      if (this.mode === "topics") {
        p.set("mode", "topics");
        if (this.topics.searchQuery) {
          p.set("tq", this.topics.searchQuery);
        } else if (this.topics.currentRun) {
          p.set("run", this.topics.currentRun.run.id);
        }
      } else {
        if (this.lastQuery) p.set("q", this.lastQuery);
        if (this.mode === "similar" && this.similarOf) {
          p.set("mode", "similar");
          p.set("sim", this.similarOf);
        }
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
      return this.mode === "search" || this.mode === "similar";
    },

    // ── Actions ──
    onQueryInput() {
      clearTimeout(this._deb);
      this._deb = setTimeout(() => {
        if (this.mode === "topics") {
          // Handle topic search if implemented later
          return;
        }
        if (this.query.trim()) {
          this.doSearch();
        }
      }, 400);
    },

    doSearch() {
      const q = this.query.trim();
      this.mode = "search";
      this.lastQuery = q;
      this.similarOf = null;
      this.syncURL(true);
      this.refetch();
    },

    toggleTopicMode() {
      this.mode = "topics";
      this.topics.currentRun = null;
      // Don't clear search query immediately, let UI decide
      this.syncURL(true);
      if (this.topics.searchQuery) {
        this.fetchTopicSearch();
      } else {
        this.fetchTopicDashboard();
      }
    },

    setDiversity(level) {
      if (!(level in DIVERSITY_LEVELS)) return;
      this.diversity = level;
      this.syncURL();
      if (this.isGroupedMode()) this.refetch();
    },

    findSimilar(id) {
      clearTimeout(this._deb);
      this.closeDetail();
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
      if (this.mode !== "topics") this.refetch();
    },
    removeCodeChip(code) {
      this.filters.code = this._currentCodes()
        .filter((c) => c !== code)
        .join(", ");
      this.syncURL();
      if (this.mode !== "topics") this.refetch();
    },
    toggleGenre(name) {
      const i = this.filters.genres.indexOf(name);
      if (i >= 0) this.filters.genres.splice(i, 1);
      else this.filters.genres.push(name);
      this.syncURL();
      if (this.mode !== "topics") this.refetch();
    },
    setCompletionFilter(val) {
      this.filters.completionFilter = val;
      this.syncURL();
      if (this.mode !== "topics") {
        this.refetch();
        this.fetchFacets();
      }
    },
    pickYear(year) {
      this.filters.from = `${year}-01-01`;
      this.filters.to = `${year}-12-31`;
      this.syncURL();
      if (this.mode !== "topics") this.refetch();
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
      if (this.mode !== "topics") this.refetch();
    },
    recentYears() {
      return this.facets.years
        .filter((y) => y.year >= 2000)
        .slice(-10)
        .reverse();
    },

    // Sorting
    get sortedAllGenres() {
      const genres = [...this.allGenres];
      if (this.genreSortBy === "name") {
        genres.sort((a, b) => a.name.localeCompare(b.name));
        return this.genreSortOrder === "desc" ? genres.reverse() : genres;
      }
      genres.sort((a, b) => b.count - a.count);
      return this.genreSortOrder === "asc" ? genres.reverse() : genres;
    },
    toggleGenreSort(by) {
      if (this.genreSortBy === by)
        this.genreSortOrder = this.genreSortOrder === "asc" ? "desc" : "asc";
      else {
        this.genreSortBy = by;
        this.genreSortOrder = by === "count" ? "desc" : "asc";
      }
    },
    get sortedAllCodes() {
      const codes = [...this.facets.codes];
      if (this.codeSortBy === "name") {
        codes.sort((a, b) => a.code.localeCompare(b.code));
        return this.codeSortOrder === "desc" ? codes.reverse() : codes;
      }
      codes.sort((a, b) => b.count - a.count);
      return this.codeSortOrder === "asc" ? codes.reverse() : codes;
    },
    toggleCodeSort(by) {
      if (this.codeSortBy === by)
        this.codeSortOrder = this.codeSortOrder === "asc" ? "desc" : "asc";
      else {
        this.codeSortBy = by;
        this.codeSortOrder = by === "count" ? "desc" : "asc";
      }
    },

    // ── Fetching ──
    refetch() {
      this.clearPreviews();
      this.items = [];
      this.cursor = null;
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
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const page = await res.json();
        if (gen !== this._gen) return;
        if (reset) {
          this.items = [];
          this.cursor = null;
          this.exhausted = false;
        }
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

    // ── Topic Fetching ──
    async fetchTopicDashboard() {
      this.topics.loading = true;
      this.topics.error = null;
      try {
        const res = await fetch(`${API}/topics/dashboard`);
        if (!res.ok) throw new Error("Failed to load dashboard");
        const data = await res.json();
        this.topics.dashboard = data.codes || [];
        // If we had a run ID in URL, open it now
        const p = new URLSearchParams(location.search);
        const runId = p.get("run");
        if (runId) {
          await this.openTopicDetail(runId);
        }
      } catch (e) {
        this.topics.error = e.message;
      } finally {
        this.topics.loading = false;
      }
    },

    async fetchTopicSearch() {
      if (!this.topics.searchQuery.trim()) return;

      this.topics.loading = true;
      this.topics.error = null;
      this.topics.currentRun = null; // Ensure we are not in detail view

      try {
        const params = new URLSearchParams({
          query: this.topics.searchQuery,
          limit: 20, // Initial limit
          min_topic_score: 0.0,
          use_ngram_fusion: true,
          require_word_match: true,
        });

        const res = await fetch(`${API}/topics/search?${params}`);
        if (!res.ok) throw new Error("Failed to search topics");

        const data = await res.json();
        this.topics.searchResults = data;
        this.syncURL(true);
      } catch (e) {
        this.topics.error = e.message;
        this.toast("error", e.message);
      } finally {
        this.topics.loading = false;
      }
    },

    async openTopicDetail(runId) {
      this.topics.loading = true;
      try {
        const res = await fetch(`${API}/topics/runs/${runId}`);
        if (!res.ok) throw new Error("Failed to load topic details");
        this.topics.currentRun = await res.json();
        this.syncURL(true); // Persist run ID
      } catch (e) {
        this.toast("error", e.message);
      } finally {
        this.topics.loading = false;
      }
    },

    closeTopicDetail() {
      this.topics.currentRun = null;
      // If we have a search query, stay in search results, otherwise go to dashboard
      if (!this.topics.searchQuery) {
        // Optionally refetch dashboard if needed, but usually it's cached
      }
      this.syncURL(true);
    },

    clearTopicSearch() {
      this.topics.searchQuery = "";
      this.topics.searchResults = [];
      this.fetchTopicDashboard();
    },

    // ── Shared Filter Helpers ──
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
    buildParams(reset) {
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
      const p = new URLSearchParams();
      if (this.lastQuery) p.set("query", this.lastQuery);
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
        if (this.filters.completionFilter !== "all")
          qs = `?completion_filter=${this.filters.completionFilter}`;
        const r = await fetch(`${API}/facets${qs}`);
        const data = await r.json();
        this.facets.genres = data.genres;
        this.facets.years = data.years;
        const genresRes = await fetch(`${API}/facets/genres${qs}`);
        const genresData = await genresRes.json();
        this.allGenres = genresData.genres || [];
        const codesRes = await fetch(`${API}/facets/codes${qs}`);
        const codesData = await codesRes.json();
        this.facets.codes = codesData.codes || [];
        this.codeSuggestions = this.facets.codes.slice(0, 10);
      } catch {}
    },

    // ── Detail Modal ──
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
    toast(type, msg) {
      const id = Math.random().toString(36).slice(2);
      this.toasts.push({ id, type, msg });
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
      }, 4000);
      this.$nextTick(() => this.refreshIcons());
    },
    formatCount,
  };
}
