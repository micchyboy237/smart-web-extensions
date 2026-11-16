// client_paginated/app.js
function app() {
  const API = "http://localhost:9001";
  return {
    // ── state ──
    mode: "browse", // 'search' | 'similar' | 'browse'
    query: "",
    lastQuery: "",
    items: [],
    cursor: null,
    page: 0,
    exhausted: false,
    loading: false,
    sort: "similarity", // default for search/similar; browse overrides via UI
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
    },
    facets: { genres: [], years: [], codes: [] },
    detail: { open: false, loading: false, video: null },
    similarOf: null,
    toasts: [],
    _gen: 0,

    // ── lifecycle ──
    boot() {
      this.hydrateFromURL();
      this.refreshIcons();
      this.$nextTick(() => this.refreshIcons());
      this.fetchFacets();
      this.refetch();

      // keyboard
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

      // infinite scroll
      const io = new IntersectionObserver(
        (entries) => {
          if (
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

      // FIX: IntersectionObserver only fires on *transition*.
      const checkSentinel = () => {
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
    },

    refreshIcons() {
      if (window.lucide) lucide.createIcons();
    },

    // ── URL sync ──
    hydrateFromURL() {
      const p = new URLSearchParams(location.search);
      this.mode = p.get("mode") || (p.get("q") ? "search" : "browse");
      this.query = p.get("q") || "";
      this.lastQuery = this.query;
      this.filters.code = p.get("code") || "";
      this.filters.from = p.get("from") || "";
      this.filters.to = p.get("to") || "";
      this.filters.genresMode = p.get("gmode") || "any";
      this.filters.genres = (p.get("genres") || "").split(",").filter(Boolean);
      this.similarOf = p.get("sim") || null;

      // Similarity is only meaningful for search/similar; browse defaults to
      // release_date so the URL never poisons a browse request with an
      // unsupported sort value.
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
        if (this.query.trim()) {
          this.doSearch();
        } else if (this.mode === "search" || this.mode === "similar") {
          // Input was cleared → return to browse listing.
          this.doBrowse();
        }
      }, 400);
    },

    doSearch() {
      const q = this.query.trim();
      if (!q) {
        // Empty submit → behave like Browse.
        if (this.mode !== "browse") this.doBrowse();
        return;
      }
      this.mode = "search";
      this.lastQuery = q;
      this.similarOf = null;
      // Semantic search should rank by similarity unless the user explicitly
      // picked another sort (only possible via URL hydration).
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
      // Browse defaults to newest-release order.
      if (!new URLSearchParams(location.search).get("sort")) {
        this.sort = "release_date";
      }
      this.syncURL();
      this.refetch();
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
      this.refetch();
    },

    pickYear(year) {
      this.filters.from = `${year}-01-01`;
      this.filters.to = `${year}-12-31`;
      this.syncURL();
      this.refetch();
    },

    clearFilters() {
      this.filters = {
        code: "",
        from: "",
        to: "",
        genresMode: "any",
        genres: [],
      };
      this.syncURL();
      this.refetch();
    },

    recentYears() {
      return this.facets.years
        .filter((y) => y.year >= 2000)
        .slice(-10)
        .reverse();
    },

    // ── fetching ──
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
      // No early-return on loading — gen-check handles cancellation.
      this.loading = true;
      const gen = ++this._gen;
      try {
        const params = this.buildParams(reset);
        if (!params) {
          // buildParams can bail (empty query); clear loading for this gen.
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

    buildParams(reset) {
      // Normalize multi-code input: split on commas, trim, lowercase, dedupe.
      // Returns null | string | string[].
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

      // Normalize genre list: null | string | string[].
      const getGenreParam = () => {
        if (this.filters.genres.length === 0) return null;
        if (this.filters.genres.length === 1) return this.filters.genres[0];
        return this.filters.genres;
      };

      // Sort/order is mode-aware:
      //   - browse: user-selected (default release_date)
      //   - search: user-selected if explicitly set, otherwise similarity
      //   - similar: always similarity (so undated neighbors are kept)
      const sortFor = (mode) => {
        if (mode === "similar") return "similarity";
        if (mode === "browse") return this.sort || "release_date";
        // search
        return this.sort || "similarity";
      };
      const orderFor = (mode) => {
        if (mode === "similar") return "desc";
        return this.order || "desc";
      };

      if (this.mode === "search") {
        if (!this.lastQuery) {
          // Shouldn't happen once onQueryInput/doSearch are fixed, but be safe:
          // switch to browse and refetch instead of dropping the request.
          this.mode = "browse";
          this.similarOf = null;
          this.syncURL();
          return this.buildParams(reset); // re-enter as browse
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
          },
        };
      }

      // browse
      const p = new URLSearchParams();
      p.set("limit", "20");
      p.set("offset", reset ? "0" : String(this.page * 20));

      const codeVal = getCodeParam();
      if (codeVal) {
        if (Array.isArray(codeVal)) {
          codeVal.forEach((c) => p.append("code", c));
        } else {
          p.set("code", codeVal);
        }
      }

      // /browse only accepts release_date | created_at — never send "similarity".
      const browseSort =
        this.sort === "release_date" || this.sort === "created_at"
          ? this.sort
          : "release_date";
      p.set("sort", browseSort);

      // order is safe in both directions for browse
      p.set("order", this.order || "desc");

      p.set("genres_mode", this.filters.genresMode);

      const genreVal = getGenreParam();
      if (genreVal) {
        if (Array.isArray(genreVal)) {
          genreVal.forEach((g) => p.append("genre", g));
        } else {
          p.set("genre", genreVal);
        }
      }
      return { path: `/browse?${p}`, method: "GET" };
    },

    async fetchFacets() {
      try {
        const r = await fetch(`${API}/facets`);
        this.facets = await r.json();
      } catch {
        /* ignore */
      }
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
