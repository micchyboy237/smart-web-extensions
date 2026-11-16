# Video Search API — Usage

FastAPI server backed by Postgres + pgvector. All semantic search, similarity,
hybrid retrieval, and dynamic clustering is served from a single process.

- **Base URL:** `http://localhost:9001`
- **Content type:** `application/json` (POST bodies), query strings (GET)
- **Auth:** none (local service; CORS is open)
- **Embedding model:** `EMBED_MODEL` from `jet.adapters.llama_cpp.config`
  (default `nomic-embed:2-moe`, 768-dim)

```
POST  /search
POST  /search_clustered
POST  /similar
POST  /hybrid
GET   /browse
GET   /videos/{id}
GET   /videos
GET   /facets
GET   /facets/codes
GET   /health
POST  /ingest
```

---

## Conventions

### Filters (shared by `/search`, `/search_clustered`, `/similar`, `/hybrid`, `/browse`, `/videos`)

| Field                                   | Type                                  | Notes                                                 |
| --------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| `genre`                                 | `string \| string[]`                  | Comma-separated strings are accepted and split.       |
| `genres_mode`                           | `"any" \| "all"`                      | Default `"any"`. `"all"` requires every listed genre. |
| `code`                                  | `string \| string[]`                  | Series code(s); comma-separated accepted.             |
| `min_release_date` / `max_release_date` | ISO-8601 timestamp                    | Inclusive.                                            |
| `completion_filter`                     | `"all" \| "complete" \| "incomplete"` | `"complete"` = title **and** details present.         |

### Pagination

`/search`, `/similar`, `/browse` use a **cursor** or **offset**. The cursor is
opaque — round-trip `next_cursor` verbatim. Cursors are bound to the request
filters; changing them invalidates the cursor (`400 Cursor does not match filters`).

`/search_clustered` is **not paginated**. It fetches up to
`cluster_candidate_limit` rows and returns the full grouped result in one
response. When `diversify_items=true`, use `item_seed` (with
`item_shuffle=true`) to page a cluster's contents instead.

### Sort / order

| Endpoint              | `sort`                                     | `order`       |
| --------------------- | ------------------------------------------ | ------------- |
| `/search`, `/similar` | `similarity \| release_date \| created_at` | `asc \| desc` |
| `/hybrid`             | `release_date \| created_at`               | `asc \| desc` |
| `/browse`             | `release_date \| created_at`               | `asc \| desc` |
| `/search_clustered`   | — (order is cohesion-weighted server-side) | —             |

### The `VideoItem` shape

Returned by every search-ish endpoint.

```jsonc
{
  "id": "jav-100hszg",
  "title": "A Married Woman's ...",
  "details": "Nana is living ...",
  "code": "juc",
  "episode": "707",
  "url": "https://missav.ws/...",
  "preview": "https://fourhoi.com/.../preview.mp4",
  "thumbnail": "https://fourhoi.com/.../cover-n.jpg",
  "release_date": "2011-12-29T11:00:38+08:00",
  "genres": ["Wife", "Mature Woman"],

  // query-dependent — null when the endpoint has no query
  "similarity": 0.8123,

  // /search_clustered only — null elsewhere
  "probability": 0.93,
  "silhouette": 0.71,
  "distance_to_centroid": 0.07,
}
```

| Field                  | Meaning                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `similarity`           | `1 - cosine_distance` to the query vector. `null` on `/browse`, `/hybrid`, and on `/search_clustered` without a query. |
| `probability`          | Cluster membership confidence in `[0,1]` — `cluster_utils.probabilities`.                                              |
| `silhouette`           | Per-item silhouette in `[-1,1]` — negative means "probably in the wrong cluster".                                      |
| `distance_to_centroid` | `1 - cosine(item, centroid)` — `0` = perfectly typical member.                                                         |

---

## `POST /search`

Semantic search with cursor pagination.

### Request

```jsonc
{
  "query": "lonely wife, rainy night",
  "limit": 20,
  "cursor": null,
  "genre": ["Wife", "Drama"],
  "genres_mode": "any",
  "code": null,
  "min_release_date": "2000-01-01T00:00:00Z",
  "max_release_date": null,
  "min_similarity": 0.3,
  "sort": "similarity",
  "order": "desc",
  "completion_filter": "all",
}
```

| Field            | Required | Default | Notes                      |
| ---------------- | -------- | ------- | -------------------------- |
| `query`          | ✅       | —       | `min_length=1`             |
| `limit`          | —        | `20`    | `1..100`                   |
| `cursor`         | —        | `null`  | Opaque; from `next_cursor` |
| `min_similarity` | —        | `null`  | `0..1`; cosine floor       |

### Response

```jsonc
{
  "items": [
    /* VideoItem[] */
  ],
  "next_cursor": "eyJrIjoiMC...",
  "has_more": true,
  "took_ms": 41.2,
}
```

### Example

```bash
curl -s http://localhost:9001/search -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"lonely wife, rainy night","limit":20}' | jq
```

---

## `POST /search_clustered`

Semantic grouping — fetches a candidate pool, hands the embeddings to
`jet.adapters.llama_cpp.cluster_utils.TextsClusterer`, and returns clusters with
full per-item and per-cluster metrics.

**The cluster count is chosen dynamically by `cluster_utils`** (HDBSCAN when
`n_candidates ≥ 10`, Spectral otherwise) from `min_cluster_size` and
`cluster_selection_epsilon`. There is **no `n_clusters` field** — this matches
`cluster_utils.main()` and its `-s` / `-e` CLI flags 1:1.

Noise is **first-class**: items the clusterer labels `-1` come back as a
`"Noise/Outliers"` cluster (`is_noise: true`). The client decides whether to
render it, dim it, or hide it.

### Per-cluster item diversification (opt-in)

By default every cluster returns **all** its members. Set
`diversify_items: true` to run MMR inside each cluster (reusing the candidate
embeddings already fetched — no re-embedding). Combine with
`items_per_cluster` to cap the returned count, and with `item_shuffle` +
`item_seed` to get a different "page" of each cluster on every call.

| Flag                | Default | Effect                                                                                                |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `diversify_items`   | `false` | Enables per-cluster MMR. `ClusterItem.size` then reflects returned count; `full_size` keeps original. |
| `items_per_cluster` | `null`  | Cap on items returned per cluster. Requires `diversify_items=true`. `1..100`.                         |
| `item_diversity`    | `0.6`   | MMR trade-off: `1.0` = max diversity, `0.0` = pure relevance.                                         |
| `diversify_noise`   | `false` | Also diversify the `Noise/Outliers` bucket. Off by default — noise is low-cohesion by definition.     |
| `item_shuffle`      | `false` | Use weighted sample + MMR (`shuffle_and_diversify`); `item_seed` then varies the result.              |
| `item_seed`         | time    | RNG seed; only used when `item_shuffle=true`. Change it for a new "page" per cluster.                 |

Ranking uses `full_size` (unaffected by the cap), so cluster ordering is stable
across `items_per_cluster` values. `centroid_similarity` is computed from the
**full** membership before trimming.

### Request

```jsonc
{
  "query": "mother and son", // optional
  "min_cluster_size": 2, // HDBSCAN -s
  "cluster_selection_epsilon": 0.25, // HDBSCAN -e
  "cluster_candidate_limit": 100, // rows fetched before clustering
  "candidate_source": "recent", // used only when query is null

  // NEW: per-cluster item diversification (opt-in)
  "diversify_items": false,
  "items_per_cluster": null,
  "item_diversity": 0.6,
  "diversify_noise": false,
  "item_shuffle": false,
  "item_seed": 1699999999,

  // shared filters
  "genre": null,
  "genres_mode": "any",
  "code": null,
  "min_release_date": null,
  "max_release_date": null,
  "min_similarity": null,
  "completion_filter": "all",
}
```

| Field                       | Required | Default    | Notes                                                                                                                 |
| --------------------------- | -------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `query`                     | —        | `null`     | When omitted, `candidate_source` decides the pool and `similarity` is `null` on every item.                           |
| `min_cluster_size`          | —        | `2`        | `2..20`. Raise to get fewer/tighter groups; lower to get more/smaller groups. Maps to `-s` in `cluster_utils.main()`. |
| `cluster_selection_epsilon` | —        | `0.25`     | `0..1`. Lower = stricter (more noise, tighter groups). Maps to `-e`.                                                  |
| `cluster_candidate_limit`   | —        | `100`      | `10..500`. Pool size fetched from Postgres before clustering.                                                         |
| `candidate_source`          | —        | `"recent"` | `"recent"` (newest release / created desc) or `"random"`. Ignored when `query` is present.                            |
| `min_similarity`            | —        | `null`     | Rejected (`422`) when `query` is `null`.                                                                              |
| `diversify_items`           | —        | `false`    | Enables per-cluster MMR. See "Per-cluster item diversification" above.                                                |
| `items_per_cluster`         | —        | `null`     | Cap on returned items per cluster. Requires `diversify_items=true`. `1..100`.                                         |
| `item_diversity`            | —        | `0.6`      | MMR diversity weight `[0,1]`. Only used when `diversify_items=true`.                                                  |
| `diversify_noise`           | —        | `false`    | Also diversify the noise bucket.                                                                                      |
| `item_shuffle`              | —        | `false`    | Use shuffle+MMR per cluster; makes `item_seed` effective. Requires `diversify_items=true`.                            |
| `item_seed`                 | —        | time-based | RNG seed for per-cluster shuffle. Only used when `item_shuffle=true`.                                                 |

### Response

```jsonc
{
  "query": "mother and son",
  "total_results": 100, // rows fetched before clustering
  "n_clusters": 4, // summary.n_clusters (non-noise only)
  "n_noise": 6, // summary.n_noise
  "total_misplaced_items": 11, // summary.total_misplaced_items
  "clusters": [
    {
      "cluster_id": 2,
      "label": null, // "Noise/Outliers" for the -1 bucket
      "size": 10, // items RETURNED after per-cluster diversification
      "full_size": 31, // original membership count (== size when diversify_items=false)
      "centroid_similarity": 0.71, // mean query-similarity over FULL membership; null without query
      "consistency_score": 0.84, // cluster_utils: L2 norm of mean unit embedding
      "avg_silhouette": 0.42, // cluster_utils: mean per-item silhouette
      "misplaced_items_count": 2, // members with negative silhouette
      "is_noise": false,
      "diversified": true, // true when per-cluster MMR ran on this cluster
      "items": [
        /* VideoItem[] — returned count is capped when items_per_cluster is set */
      ],
    },
    {
      "cluster_id": -1,
      "label": "Noise/Outliers",
      "size": 6,
      "full_size": 6,
      "centroid_similarity": 0.19,
      "consistency_score": 0.0,
      "avg_silhouette": 0.0,
      "misplaced_items_count": 0,
      "is_noise": true,
      "diversified": false, // noise bucket untouched unless diversify_noise=true
      "items": [
        /* VideoItem[] */
      ],
    },
  ],
  "took_ms": 112.6,
}
```

### Per-cluster metric glossary

Mirrors the module docstring of `cluster_utils`.

| Field                   | Range    | Meaning                                                                                                                     |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `size`                  | `≥0`     | Number of items **returned** in `items` (post-diversification).                                                             |
| `full_size`             | `≥0`     | Original cluster membership count. Equals `size` when `diversify_items=false`. Use this for ranking / stats.                |
| `consistency_score`     | `[0,1]`  | L2 norm of the cluster's mean unit embedding. `1` = all members point the same direction (tight); `0` = orthogonal (loose). |
| `avg_silhouette`        | `[-1,1]` | Mean per-item silhouette. `>0` = members are better explained by their own cluster than by neighbors.                       |
| `misplaced_items_count` | `≥0`     | Members with **negative** silhouette — likely mis-assigned.                                                                 |
| `centroid_similarity`   | `[0,1]`  | Mean of members' `similarity` to the query, over full membership. Only meaningful when `query` is present.                  |
| `is_noise`              | `bool`   | `true` only for the `-1` bucket.                                                                                            |
| `diversified`           | `bool`   | `true` when per-cluster MMR ran on this cluster's items.                                                                    |

### Cluster ordering

Clusters are sorted server-side by **`consistency_score × full_size` descending**,
with the noise bucket always last. The intent is "tight and substantive first".
Because `full_size` (not the possibly-capped `size`) is used, the ordering is
identical whether or not `items_per_cluster` is set — clients can toggle the
cap without the cluster list reshuffling. Clients should preserve this order.

Item order inside a cluster is whatever `cluster_utils.get_detailed_analysis()`
produced — already sorted by `(silhouette, probability)` **descending**, so
representative members come first and fringe members come last. When
`diversify_items=true`, the returned subset preserves that order (the set is
MMR-selected, the sort is unchanged).

### Cluster quality tiers (client helper)

The UI derives a tier from `consistency_score` and `centroid_similarity`:

| Tier  | Rule (query present)                                     | Rule (no query)          | Label                                                 |
| ----- | -------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| green | `consistency ≥ 0.75` **and** `centroid_similarity ≥ 0.7` | `consistency ≥ 0.75`     | "Very relevant · tightly grouped" / "Tightly grouped" |
| amber | `consistency ≥ 0.55` **or** `centroid_similarity ≥ 0.6`  | `consistency ≥ 0.55`     | "Related · grouped" / "Loosely grouped"               |
| grey  | otherwise, or `is_noise`                                 | otherwise, or `is_noise` | "Tangential · mixed" / "Mixed"                        |

### Examples

**Semantic grouping (query present):**

```bash
curl -s http://localhost:9001/search_clustered -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "mother and son",
    "cluster_candidate_limit": 120,
    "min_cluster_size": 3,
    "cluster_selection_epsilon": 0.2
  }' | jq '.n_clusters, .n_noise, [.clusters[] | {id:.cluster_id, size, cons:.consistency_score}]'
```

**Browse by topic (query-less, recent pool):**

```bash
curl -s http://localhost:9001/search_clustered -X POST \
  -H 'Content-Type: application/json' \
  -d '{"candidate_source":"recent","cluster_candidate_limit":150}' | jq
```

**Surprise me (query-less, random pool):**

```bash
curl -s http://localhost:9001/search_clustered -X POST \
  -H 'Content-Type: application/json' \
  -d '{"candidate_source":"random","cluster_candidate_limit":100}' | jq
```

**Diversified page — cap each cluster to 10 diverse representatives:**

```bash
curl -s http://localhost:9001/search_clustered -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "office romance",
    "cluster_candidate_limit": 200,
    "diversify_items": true,
    "items_per_cluster": 10,
    "item_diversity": 0.7
  }' | jq '[.clusters[] | {id:.cluster_id, size, full_size, diversified}]'
```

**Endless per-cluster browse — bump `item_seed` for a new page:**

```bash
for seed in 1 2 3; do
  curl -s http://localhost:9001/search_clustered -X POST \
    -H 'Content-Type: application/json' \
    -d "{
      \"candidate_source\":\"recent\",
      \"cluster_candidate_limit\":200,
      \"diversify_items\":true,
      \"items_per_cluster\":8,
      \"item_diversity\":0.8,
      \"item_shuffle\":true,
      \"item_seed\":$seed
    }" | jq --arg s "$seed" '{seed:$s, ids:[.clusters[0].items[].id]}'
done
```

**Include the noise bucket in diversification:**

```bash
curl -s http://localhost:9001/search_clustered -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "anything",
    "diversify_items": true,
    "items_per_cluster": 5,
    "diversify_noise": true
  }' | jq
```

**Tuning recipes**

| Goal                       | Knob                                         |
| -------------------------- | -------------------------------------------- |
| Fewer, larger groups       | Increase `min_cluster_size`                  |
| More, smaller groups       | Decrease `min_cluster_size`                  |
| Tighter groups, more noise | Decrease `cluster_selection_epsilon`         |
| Looser groups, less noise  | Increase `cluster_selection_epsilon`         |
| More candidates to cluster | Increase `cluster_candidate_limit`           |
| Diverse reps per cluster   | `diversify_items=true` + `items_per_cluster` |
| More diversity per cluster | Increase `item_diversity` toward `1.0`       |
| Vary cluster contents      | `item_shuffle=true` + change `item_seed`     |

### Errors

| Status | When                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------- |
| `422`  | `min_similarity` set while `query` is `null` (validation error).                                  |
| `422`  | `items_per_cluster` set while `diversify_items=false`.                                            |
| `422`  | `item_shuffle=true` while `diversify_items=false`.                                                |
| `422`  | Any field fails its constraints (e.g. `cluster_candidate_limit < 10`, `items_per_cluster > 100`). |
| `500`  | DB error while fetching candidates.                                                               |

> Per-cluster MMR failures are **non-fatal**: if `diversify_results` raises on a
> single cluster, that cluster falls back to its full membership with
> `diversified=false`; other clusters are unaffected, and the request returns
> `200`.

---

## `POST /similar`

Returns videos semantically close to an existing `video_id`, reusing its stored
embedding (no re-embedding).

### Request

```jsonc
{
  "video_id": "jav-100hszg",
  "limit": 20,
  "cursor": null,
  "genre": null,
  "genres_mode": "any",
  "code": null,
  "sort": "similarity",
  "order": "desc",
  "completion_filter": "all",
}
```

### Response

Same `SearchResponse` as `/search`. The source video is excluded from results.

### Example

```bash
curl -s http://localhost:9001/similar -X POST \
  -H 'Content-Type: application/json' \
  -d '{"video_id":"jav-100hszg","limit":10}' | jq
```

---

## `POST /hybrid`

FTS (title) + vector (cosine) fused with Reciprocal Rank Fusion (`k = 60`). Not
paginated — the fusion shortlist is returned in one shot.

### Request

```jsonc
{
  "query": "married wife drama",
  "limit": 20,
  "genre": null,
  "genres_mode": "any",
  "code": null,
  "min_release_date": null,
  "max_release_date": null,
  "sort": "release_date",
  "order": "desc",
  "completion_filter": "all",
}
```

### Response

Same `SearchResponse`; `next_cursor` is always `null`, `has_more` always
`false`, and `similarity` is `null` on every item (ranking is RRF, not cosine).

---

## `GET /browse`

Plain listing with offset pagination. Default sort is `release_date`.

### Query parameters

| Param               | Default        | Notes                           |
| ------------------- | -------------- | ------------------------------- |
| `limit`             | `20`           | `1..100`                        |
| `offset`            | `0`            | `0..100000`                     |
| `genre`             | —              | Repeatable (`?genre=A&genre=B`) |
| `genres_mode`       | `any`          | `any \| all`                    |
| `code`              | —              | Repeatable                      |
| `sort`              | `release_date` | `release_date \| created_at`    |
| `order`             | `desc`         | `asc \| desc`                   |
| `completion_filter` | `all`          | `all \| complete \| incomplete` |

### Response

`SearchResponse` with `next_cursor` containing the next `offset` as a string.

### Example

```bash
curl -s 'http://localhost:9001/browse?limit=20&sort=release_date&order=desc' | jq
```

---

## `GET /videos/{id}`

Single video.

```bash
curl -s http://localhost:9001/videos/jav-100hszg | jq
```

`404` when the id is unknown.

---

## `GET /videos`

Stable, id-ordered listing for sync/export. Offset pagination only — never a
keyset cursor. Caps at `5000` rows.

### Query parameters

| Param                                   | Default   | Notes                   |
| --------------------------------------- | --------- | ----------------------- |
| `code`                                  | —         | Repeatable              |
| `genre`                                 | —         | Repeatable              |
| `genres_mode`                           | `any`     |                         |
| `completion_filter`                     | `all`     |                         |
| `min_release_date` / `max_release_date` | —         | ISO-8601                |
| `limit`                                 | `5000`    | `1..5000`               |
| `offset`                                | `0`       |                         |
| `fields`                                | `summary` | `id \| summary \| full` |

### Response

```jsonc
{
  "count": 20,
  "items": [
    {
      "id": "...",
      "code": "juc",
      "episode": "707",
      "title": "...",
      "release_date": "...",
      "complete": true,
    },
  ],
  "took_ms": 8.1,
}
```

The `summary` payload also includes `complete: bool` — `true` when title **and**
details are present.

---

## `GET /facets`

Genre / code / year counts for building filter UIs.

### Query parameters

| Param               | Default |
| ------------------- | ------- |
| `top_genres`        | `60`    |
| `top_codes`         | `40`    |
| `completion_filter` | `all`   |

### Response

```jsonc
{
  "genres": [{"name": "Wife", "count": 4821}, ...],
  "codes":  [{"code": "juc", "count": 210}, ...],
  "years":  [{"year": 2011, "count": 1024}, ...]
}
```

---

## `GET /facets/codes`

All codes (uncapped), plus a completion count per code.

```jsonc
{
  "code_count": 3199,
  "codes": [{"code": "juc", "count": 210, "completed": 187}, ...]
}
```

---

## `GET /health`

Liveness + round-trip to Postgres.

```jsonc
{ "ok": true, "db_ms": 1.42 }
```

---

## `POST /ingest`

Batch insert / upsert of videos. Embeds missing vectors with
`EMBED_DOC_PREFIX` before writing. Deduplicates the input by `id`.

### Request

```jsonc
{
  "upsert": true,
  "items": [
    {
      "id": "jav-100hszg",
      "url": "https://missav.ws/...",
      "code": "juc",
      "episode": "707",
      "video_id": "juc-707",
      "title": "A Married Woman's ...",
      "thumbnail": "https://.../cover-n.jpg",
      "preview": "https://.../preview.mp4",
      "details": "Nana is living ...",
      "release_date": "2011-12-29T11:00:38+08:00",
      "genres": ["Wife", "Mature Woman"],
    },
  ],
}
```

| Field              | Notes                                                            |
| ------------------ | ---------------------------------------------------------------- |
| `items`            | `1..500` entries.                                                |
| `upsert`           | `true` (default) updates existing rows; `false` skips conflicts. |
| `title`, `details` | Code prefix (`juc-707 ...`) is stripped before embedding.        |

### Response

```jsonc
{ "inserted": 12, "updated": 480, "skipped": 8, "took_ms": 1820.4 }
```

`skipped` counts items with no embeddable text.

---

## Error model

All errors return FastAPI's standard envelope:

```jsonc
{ "detail": "Cursor does not match filters" }
```

`422` errors from Pydantic validation include a structured `detail[]` with
`loc`, `msg`, and `type` per field.

---

## Client integration cheat-sheet

### Clustered view — quick map

```
mode = "clustered"
  ├─ POST /search_clustered
  │    ├─ query present   → ranked candidates + clusters with centroid_similarity
  │    └─ query null      → recent/random candidates, similarity == null
  ├─ render clusters in response order (tight+big first, noise last)
  ├─ tier = green | amber | grey  (see Cluster quality tiers)
  ├─ per-cluster items (optional):
  │    ├─ diversify_items=true + items_per_cluster=N → diverse reps, capped
  │    └─ item_shuffle=true + changing item_seed   → new "page" per cluster
  └─ per item:
       ├─ probability       → confidence bar
       ├─ silhouette < 0    → dim (fringe)
       └─ silhouette ≥ 0.4 && probability ≥ 0.7 → "core" badge
```

### Tuning the clustered view from the UI

```jsonc
{
  "min_cluster_size": 2, // fewer/larger groups ← higher
  "cluster_selection_epsilon": 0.25, // tighter/more-noise ← lower
  "cluster_candidate_limit": 100, // more candidates   ← higher
}
```

The three knobs above are the **primary** tuning controls exposed to end users.
`n_clusters` no longer exists — it was replaced by `cluster_utils`' dynamic
selection. If a client previously exposed "groups = 3..10", replace it with
"min_cluster_size" + "epsilon", or with a coarse preset:

| Preset   | `min_cluster_size` | `cluster_selection_epsilon` | Effect                              |
| -------- | ------------------ | --------------------------- | ----------------------------------- |
| Tight    | `4`                | `0.15`                      | Few, cohesive groups, more noise.   |
| Balanced | `2`                | `0.25`                      | Default.                            |
| Loose    | `2`                | `0.45`                      | Fewer noise points, broader groups. |

A secondary group of controls (behind an "advanced" toggle) enables per-cluster
diversification:

| Preset  | `diversify_items` | `items_per_cluster` | `item_diversity` | `item_shuffle` | Effect                                          |
| ------- | ----------------- | ------------------- | ---------------- | -------------- | ----------------------------------------------- |
| Off     | `false`           | `null`              | —                | —              | Historical behavior (all members).              |
| Reorder | `true`            | `null`              | `0.6`            | `false`        | Same members, MMR order (most diverse first).   |
| Capped  | `true`            | `10`                | `0.7`            | `false`        | 10 diverse reps per cluster, deterministic.     |
| Paged   | `true`            | `8`                 | `0.8`            | `true`         | 8 reps per cluster; change `item_seed` to page. |

### Reproducibility

Clustering is deterministic for a given `(candidate pool, query, candidate_source)`:
`TextsClusterer` seeds Spectral with `random_state=42` and HDBSCAN is
deterministic. The only non-determinism is `candidate_source: "random"`
(server-side `random()` ordering).

Per-cluster item selection is deterministic when `item_shuffle=false`
(`diversify_results` is greedy MMR with no RNG). When `item_shuffle=true`, the
result is a pure function of `(cluster items, item_seed, item_diversity)`, so
the same `item_seed` reproduces the same page.
