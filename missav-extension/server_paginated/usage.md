# Video Search API — Usage

FastAPI server backed by Postgres + pgvector. All semantic search, similarity,
hybrid retrieval, dynamic clustering, and shuffle-discovery is served from a
single process.

- **Base URL:** `http://localhost:9001`
- **Content type:** `application/json` (POST bodies), query strings (GET)
- **Auth:** none (local service; CORS is open)
- **Embedding model:** `EMBED_MODEL` from `jet.adapters.llama_cpp.config`
  (default `nomic-embed:2-moe`, 768-dim)

```
POST  /search
POST  /search_clustered
POST  /discover
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

### Filters (shared by `/search`, `/search_clustered`, `/discover`, `/hybrid`, `/browse`, `/videos`)

> `/similar` supports only `genre`, `genres_mode`, `code`, and `completion_filter`.
> Date-range filters are **not** part of the `/similar` request model.

| Field                                   | Type                                  | Notes                                                 |
| --------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| `genre`                                 | `string \| string[]`                  | Comma-separated strings are accepted and split.       |
| `genres_mode`                           | `"any" \| "all"`                      | Default `"any"`. `"all"` requires every listed genre. |
| `code`                                  | `string \| string[]`                  | Series code(s); comma-separated accepted.             |
| `min_release_date` / `max_release_date` | ISO-8601 timestamp                    | Inclusive.                                            |
| `completion_filter`                     | `"all" \| "complete" \| "incomplete"` | `"complete"` = title **and** details present.         |

### Pagination

- **Cursor** — `/search`, `/similar`. Cursor is opaque — round-trip `next_cursor`
  verbatim. Cursors are bound to the request filters; changing them invalidates
  the cursor (`400 Cursor does not match filters`).
- **Offset** — `/browse`, `/videos`.
- **Not paginated** — `/search_clustered` (single-shot grouping), `/hybrid`
  (RRF shortlist), `/discover` (use `seed` to vary the batch), `/facets`,
  `/facets/codes`, `/ingest`.

### Sort / order

| Endpoint              | `sort`                                     | `order`       | Notes                                                 |
| --------------------- | ------------------------------------------ | ------------- | ----------------------------------------------------- |
| `/search`, `/similar` | `similarity \| release_date \| created_at` | `asc \| desc` |                                                       |
| `/hybrid`             | `release_date \| created_at`               | `asc \| desc` | Accepted but **ignored** — output is RRF score order. |
| `/browse`             | `release_date \| created_at`               | `asc \| desc` |                                                       |
| `/search_clustered`   | —                                          | —             | Order is cohesion-weighted server-side.               |
| `/discover`           | —                                          | —             | Shuffle/MMR order server-side.                        |
| `/videos`             | —                                          | —             | Always `id ASC`.                                      |

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
| `distance_to_centroid` | Cosine distance to cluster centroid — `0` = perfectly typical member.                                                  |

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

### Examples

**Basic query:**

```bash
curl -s http://localhost:9001/search -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"lonely wife, rainy night","limit":20}' | jq
```

**Full filter stack (`genre` + `genres_mode: "all"` + `min_similarity` + sort):**

```bash
curl -s http://localhost:9001/search -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "query":"lonely wife, rainy night",
    "limit":20,
    "genre":["Wife","Drama"],
    "genres_mode":"all",
    "code":"juc",
    "min_release_date":"2000-01-01T00:00:00Z",
    "max_release_date":"2024-12-31T00:00:00Z",
    "min_similarity":0.3,
    "sort":"release_date",
    "order":"asc",
    "completion_filter":"complete"
  }' | jq
```

**Sort by `created_at` desc:**

```bash
curl -s http://localhost:9001/search -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"office romance","sort":"created_at","order":"desc","limit":10}' | jq
```

**Cursor pagination round-trip:**

```bash
# Page 1 — capture next_cursor
NEXT=$(curl -s http://localhost:9001/search -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"lonely wife","limit":20}' | jq -r '.next_cursor')

# Page 2 — pass it back
curl -s http://localhost:9001/search -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"lonely wife\",\"limit\":20,\"cursor\":\"$NEXT\"}" | jq
```

**Cursor mismatch → 400:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:9001/search -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"a different query","cursor":"eyJrIjoiMC4xLCJpIjoieCIsImYiOiJkZWFkYmVlZiJ9"}'
# → 400
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

**Every cluster returns all its members.** The endpoint performs no
per-cluster diversification or item-level paging — for an endless-diversity
feed, use `POST /discover` instead.

### Request

```jsonc
{
  "query": "mother and son", // optional
  "min_cluster_size": 2, // HDBSCAN -s
  "cluster_selection_epsilon": 0.25, // HDBSCAN -e
  "cluster_candidate_limit": 100, // rows fetched before clustering
  "candidate_source": "recent", // used only when query is null
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
| `cluster_candidate_limit`   | —        | `null`     | `10..50000`. When omitted the server uses its configured cap (see below). Explicit values are clamped to the cap.     |
| `candidate_source`          | —        | `"recent"` | `"recent"` (newest release / created desc) or `"random"`. Ignored when `query` is present.                            |
| `min_similarity`            | —        | `null`     | Rejected (`422`) when `query` is `null`.                                                                              |

#### Candidate cap (server-side)

The effective `cluster_candidate_limit` is `min(requested_or_null, cap)`, where
the cap depends on mode:

| Env var                        | Default | Used when          |
| ------------------------------ | ------- | ------------------ |
| `CLUSTER_CANDIDATE_CAP_QUERY`  | `5000`  | `query` is present |
| `CLUSTER_CANDIDATE_CAP_BROWSE` | `5000`  | `query` is absent  |

When `cluster_candidate_limit` is omitted, the cap itself is used. The effective
value is echoed back as `candidate_limit` in the response.

### Response

```jsonc
{
  "query": "mother and son",
  "total_results": 100, // rows fetched before clustering
  "candidate_limit": 100, // effective limit used (post-clamp)
  "n_clusters": 4, // summary.n_clusters (non-noise only)
  "n_noise": 6, // summary.n_noise
  "total_misplaced_items": 11, // summary.total_misplaced_items
  "clusters": [
    {
      "cluster_id": 2,
      "label": null, // "Noise/Outliers" for the -1 bucket
      "size": 10, // number of members in this cluster
      "centroid_similarity": 0.71, // mean query-similarity; null without query
      "consistency_score": 0.84, // cluster_utils: L2 norm of mean unit embedding
      "avg_silhouette": 0.42, // cluster_utils: mean per-item silhouette
      "misplaced_items_count": 2, // members with negative silhouette
      "is_noise": false,
      "items": [
        /* VideoItem[] — the cluster's full membership */
      ],
    },
    {
      "cluster_id": -1,
      "label": "Noise/Outliers",
      "size": 6,
      "centroid_similarity": 0.19,
      "consistency_score": 0.0,
      "avg_silhouette": 0.0,
      "misplaced_items_count": 0,
      "is_noise": true,
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
| `size`                  | `≥0`     | Number of members returned in `items`.                                                                                      |
| `consistency_score`     | `[0,1]`  | L2 norm of the cluster's mean unit embedding. `1` = all members point the same direction (tight); `0` = orthogonal (loose). |
| `avg_silhouette`        | `[-1,1]` | Mean per-item silhouette. `>0` = members are better explained by their own cluster than by neighbors.                       |
| `misplaced_items_count` | `≥0`     | Members with **negative** silhouette — likely mis-assigned.                                                                 |
| `centroid_similarity`   | `[0,1]`  | Mean of members' `similarity` to the query. Only meaningful when `query` is present.                                        |
| `is_noise`              | `bool`   | `true` only for the `-1` bucket.                                                                                            |

### Cluster ordering

Clusters are sorted server-side by **`consistency_score × size` descending**,
with the noise bucket always last. The intent is "tight and substantive first".
Clients should preserve this order.

Item order inside a cluster is whatever `cluster_utils.get_detailed_analysis()`
produced — already sorted by `(silhouette, probability)` **descending**, so
representative members come first and fringe members come last.

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

**Query mode with shared filters (`genre` + `genres_mode: "all"` + `min_similarity`):**

```bash
curl -s http://localhost:9001/search_clustered -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "query":"office romance",
    "genre":["Wife","Drama"],
    "genres_mode":"all",
    "code":"juc",
    "min_release_date":"2010-01-01T00:00:00Z",
    "max_release_date":"2024-12-31T00:00:00Z",
    "min_similarity":0.35,
    "completion_filter":"complete",
    "cluster_candidate_limit":200
  }' | jq
```

**Confirm the candidate cap is applied (requesting above the 5000 default):**

```bash
curl -s http://localhost:9001/search_clustered -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"anything","cluster_candidate_limit":99999}' \
  | jq '{candidate_limit, total_results}'
# → candidate_limit == 5000 (capped), total_results == 5000 (if data allows)
```

**`min_similarity` without query → 422:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:9001/search_clustered -X POST \
  -H 'Content-Type: application/json' \
  -d '{"min_similarity":0.3}'
# → 422
```

**`cluster_candidate_limit` below 10 → 422:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:9001/search_clustered -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"x","cluster_candidate_limit":5}'
# → 422
```

**Tuning recipes**

| Goal                       | Knob                                 |
| -------------------------- | ------------------------------------ |
| Fewer, larger groups       | Increase `min_cluster_size`          |
| More, smaller groups       | Decrease `min_cluster_size`          |
| Tighter groups, more noise | Decrease `cluster_selection_epsilon` |
| Looser groups, less noise  | Increase `cluster_selection_epsilon` |
| More candidates to cluster | Increase `cluster_candidate_limit`   |

### Errors

| Status | When                                                                                |
| ------ | ----------------------------------------------------------------------------------- |
| `422`  | `min_similarity` set while `query` is `null` (validation error).                    |
| `422`  | Any field fails its constraints (e.g. `cluster_candidate_limit < 10` or `> 50000`). |
| `500`  | DB error while fetching candidates.                                                 |

---

## `POST /discover`

Shuffle / "endless browse" feed. Fetches a wider candidate pool, then applies
weighted sampling + MMR (`jet.adapters.llama_cpp.diversity_utils.shuffle_and_diversify`)
to return a diverse batch.

- If `query` is provided: candidates come from vector search, biased toward the
  topic (`similarity` populated on each item).
- If `query` is omitted: candidates come from a `random()` ordering, and
  `similarity` is `null` on every item.
- **Not cursor-paginated.** Change `seed` to get a different "page".

### Request

```jsonc
{
  "query": "rainy night", // optional
  "limit": 20, // 1..50
  "seed": 1699999999, // change for a new feed
  "diversity": 0.6, // 0.0 = relevance/recency, 1.0 = max diversity
  "genre": null,
  "genres_mode": "any",
  "code": null,
  "min_release_date": null,
  "max_release_date": null,
  "completion_filter": "all",
}
```

| Field               | Default    | Notes                                                              |
| ------------------- | ---------- | ------------------------------------------------------------------ |
| `query`             | `null`     | Optional semantic bias.                                            |
| `limit`             | `20`       | `1..50`.                                                           |
| `seed`              | time-based | RNG seed. Same `(seed, filters, query)` reproduces the same batch. |
| `diversity`         | `0.6`      | `0.0` = relevance/recency, `1.0` = max diversity (MMR).            |
| `completion_filter` | `all`      |                                                                    |

### Response

```jsonc
{
  "count": 20,
  "items": [
    /* VideoItem[] — count == limit when enough candidates exist */
  ],
  "took_ms": 87.4,
}
```

### Examples

**Topic-biased discovery:**

```bash
curl -s http://localhost:9001/discover -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"office romance","limit":20,"seed":1,"diversity":0.7}' | jq
```

**Endless "surprise me" feed — vary seed for new pages:**

```bash
for seed in 1 2 3; do
  curl -s http://localhost:9001/discover -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"limit\":15,\"seed\":$seed,\"diversity\":0.8}" \
    | jq --arg s "$seed" '{seed:$s, ids:[.items[].id]}'
done
```

**Shared filters + max diversity (`diversity: 1.0`):**

```bash
curl -s http://localhost:9001/discover -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "genre":["Wife"],
    "genres_mode":"any",
    "code":"juc",
    "min_release_date":"2015-01-01T00:00:00Z",
    "completion_filter":"complete",
    "limit":20,
    "seed":42,
    "diversity":1.0
  }' | jq
```

**Pure relevance mode (`diversity: 0.0`):**

```bash
curl -s http://localhost:9001/discover -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"rainy night","limit":10,"seed":7,"diversity":0.0}' | jq
```

### Reproducibility

The batch is a pure function of `(seed, diversity, query, filters, current
candidate pool)`. When `query` is `null` the underlying candidate order is
`random()`, so identical requests may return different batches; the seed still
controls the _diversification_ of the fetched pool.

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

> Date-range filters and `min_similarity` are **not** supported on this endpoint
> (they are not part of the request model).

### Response

Same `SearchResponse` as `/search`. The source video is excluded from results.

### Examples

**Basic:**

```bash
curl -s http://localhost:9001/similar -X POST \
  -H 'Content-Type: application/json' \
  -d '{"video_id":"jav-100hszg","limit":10}' | jq
```

**With filters + `sort: release_date`:**

```bash
curl -s http://localhost:9001/similar -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "video_id":"jav-100hszg",
    "limit":20,
    "genre":["Wife"],
    "genres_mode":"any",
    "code":"juc",
    "sort":"release_date",
    "order":"desc",
    "completion_filter":"complete"
  }' | jq
```

**Cursor pagination round-trip:**

```bash
NEXT=$(curl -s http://localhost:9001/similar -X POST \
  -H 'Content-Type: application/json' \
  -d '{"video_id":"jav-100hszg","limit":10}' | jq -r '.next_cursor')

curl -s http://localhost:9001/similar -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"video_id\":\"jav-100hszg\",\"limit\":10,\"cursor\":\"$NEXT\"}" | jq
```

**Unknown `video_id` → 404:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:9001/similar -X POST \
  -H 'Content-Type: application/json' \
  -d '{"video_id":"does-not-exist"}'
# → 404
```

---

## `POST /hybrid`

FTS (title) + vector (cosine) fused with Reciprocal Rank Fusion (`k = 60`). Not
paginated — the fusion shortlist is returned in one shot.

> `sort` and `order` are accepted for schema compatibility but do **not** affect
> output ordering — results are always returned in RRF-score order.

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

### Examples

**Basic hybrid:**

```bash
curl -s http://localhost:9001/hybrid -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"married wife drama","limit":20}' | jq
```

**Hybrid with full filter stack:**

```bash
curl -s http://localhost:9001/hybrid -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "query":"married wife drama",
    "limit":20,
    "genre":["Wife","Drama"],
    "genres_mode":"all",
    "code":"juc",
    "min_release_date":"2010-01-01T00:00:00Z",
    "max_release_date":"2024-12-31T00:00:00Z",
    "completion_filter":"complete"
  }' | jq
```

**Note — `sort`/`order` are ignored:**

```bash
# Same query, different sort — verify identical ordering
curl -s http://localhost:9001/hybrid -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"wife","limit":5,"sort":"release_date","order":"asc"}' | jq '[.items[].id]'
curl -s http://localhost:9001/hybrid -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"wife","limit":5,"sort":"created_at","order":"desc"}' | jq '[.items[].id]'
# → identical id order (RRF order)
```

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

### Examples

**Basic:**

```bash
curl -s 'http://localhost:9001/browse?limit=20&sort=release_date&order=desc' | jq
```

**Sort by `created_at` asc:**

```bash
curl -s 'http://localhost:9001/browse?sort=created_at&order=asc&limit=10' | jq
```

**Filters (`genre`, `code`, `completion_filter`):**

```bash
curl -s 'http://localhost:9001/browse?genre=Wife&genre=Drama&genres_mode=all&code=juc&completion_filter=complete&limit=10' | jq
```

**Offset paging via `next_cursor`:**

```bash
OFF=$(curl -s 'http://localhost:9001/browse?limit=20' | jq -r '.next_cursor')
curl -s "http://localhost:9001/browse?limit=20&offset=$OFF" | jq
```

---

## `GET /videos/{id}`

Single video.

### Examples

**Found:**

```bash
curl -s http://localhost:9001/videos/jav-100hszg | jq
```

**Unknown id → 404:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9001/videos/does-not-exist
# → 404
```

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

### `fields` shapes

| `fields`  | Columns returned                                                                   |
| --------- | ---------------------------------------------------------------------------------- |
| `id`      | `id`                                                                               |
| `summary` | `id, code, episode, title, release_date, complete`                                 |
| `full`    | `id, title, details, url, code, episode, release_date, genres, thumbnail, preview` |

`complete` is a computed boolean: `true` when both `title` and `details` are
non-empty.

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

### Examples

**Default `summary` shape:**

```bash
curl -s 'http://localhost:9001/videos?limit=20' | jq
```

**`fields: id` (lightweight sync):**

```bash
curl -s 'http://localhost:9001/videos?fields=id&limit=100' | jq
```

**`fields: full` (full payload export):**

```bash
curl -s 'http://localhost:9001/videos?fields=full&limit=50' | jq
```

**Offset paging + filters:**

```bash
curl -s 'http://localhost:9001/videos?genre=Wife&genres_mode=all&code=juc&min_release_date=2010-01-01T00:00:00Z&max_release_date=2024-12-31T00:00:00Z&completion_filter=complete&limit=100&offset=200' | jq
```

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
  "genres": [{ "name": "Wife", "count": 4821 }],
  "codes": [{ "code": "juc", "count": 210 }],
  "years": [{ "year": 2011, "count": 1024 }],
}
```

### Examples

**Defaults:**

```bash
curl -s 'http://localhost:9001/facets' | jq
```

**Custom `top_*` + `completion_filter: complete`:**

```bash
curl -s 'http://localhost:9001/facets?top_genres=20&top_codes=10&completion_filter=complete' | jq
```

---

## `GET /facets/codes`

All codes (uncapped), plus a completion count per code.

```jsonc
{
  "code_count": 3199,
  "codes": [{ "code": "juc", "count": 210, "completed": 187 }],
}
```

### Example

```bash
curl -s 'http://localhost:9001/facets/codes' | jq
```

---

## `GET /health`

Liveness + round-trip to Postgres.

```jsonc
{ "ok": true, "db_ms": 1.42 }
```

### Example

```bash
curl -s 'http://localhost:9001/health' | jq
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

#### Upsert semantics (`upsert: true`)

- On conflict, mutable fields are updated from `EXCLUDED`; `title`, `thumbnail`,
  `preview`, `details`, `release_date`, and `genres` use `COALESCE(EXCLUDED.x, videos.x)`
  so a `null` in the incoming item preserves the existing value.
- `embedding` is always overwritten.
- `updated_at` is set to `now()`.

#### Upsert semantics (`upsert: false`)

- `ON CONFLICT (id) DO NOTHING` — existing rows are not modified and the count
  lands in `updated` (returning `inserted = false` for each conflict).

### Response

```jsonc
{ "inserted": 12, "updated": 480, "skipped": 8, "took_ms": 1820.4 }
```

`skipped` counts items with no embeddable text.

### Examples

**Insert new rows (`upsert: true`):**

```bash
curl -s http://localhost:9001/ingest -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "upsert": true,
    "items": [
      {
        "id": "jav-100hszg",
        "url": "https://missav.ws/...",
        "code": "juc",
        "episode": "707",
        "video_id": "juc-707",
        "title": "A Married Woman\u0027s ...",
        "thumbnail": "https://.../cover-n.jpg",
        "preview": "https://.../preview.mp4",
        "details": "Nana is living ...",
        "release_date": "2011-12-29T11:00:38+08:00",
        "genres": ["Wife", "Mature Woman"]
      }
    ]
  }' | jq
```

**Update with nulls (COALESCE-preserve proof):**

```bash
# Re-send same id with title/details omitted — existing values should survive
curl -s http://localhost:9001/ingest -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "upsert": true,
    "items": [
      {
        "id": "jav-100hszg",
        "url": "https://missav.ws/updated-url",
        "code": "juc",
        "episode": "707",
        "video_id": "juc-707",
        "genres": ["Wife"]
      }
    ]
  }' | jq
# → {"inserted":0,"updated":1,...}; title/details/thumbnail/preview preserved
```

**Skip on conflict (`upsert: false`):**

```bash
curl -s http://localhost:9001/ingest -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "upsert": false,
    "items": [
      {
        "id": "jav-100hszg",
        "url": "https://missav.ws/will-not-overwrite",
        "code": "juc",
        "episode": "707",
        "video_id": "juc-707",
        "title": "Ignored"
      }
    ]
  }' | jq
# → {"inserted":0,"updated":1,...}; row untouched
```

**Dedupe by `id` (duplicate entries in one call collapse):**

```bash
curl -s http://localhost:9001/ingest -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "items": [
      {"id":"dup-1","url":"https://a","code":"x","episode":"1","video_id":"x-1","title":"First"},
      {"id":"dup-1","url":"https://b","code":"x","episode":"1","video_id":"x-1","title":"Second (wins)"}
    ]
  }' | jq
# → only one row written; last occurrence wins
```

**Code-prefix stripping (embedding quality):**

```bash
# Both of these produce the same embedding text after prefix stripping
curl -s http://localhost:9001/ingest -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "items": [
      {"id":"p-1","url":"https://a","code":"juc","episode":"707","video_id":"juc-707","title":"juc-707 Married Woman","details":"juc-707 Nana lives"}
    ]
  }' | jq
# Internally embedded as: "Married Woman | Nana lives | Series: juc | Episode: 707"
```

**`skipped` counter (no embeddable text):**

```bash
curl -s http://localhost:9001/ingest -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "items": [
      {"id":"empty-1","url":"https://a","code":"x","episode":"1","video_id":"x-1"}
    ]
  }' | jq
# → {"inserted":0,"updated":0,"skipped":1,...}
```

---

## Error model

All errors return FastAPI's standard envelope:

```jsonc
{ "detail": "Cursor does not match filters" }
```

`422` errors from Pydantic validation include a structured `detail[]` with
`loc`, `msg`, and `type` per field.

### Examples

```bash
# 400 — cursor bound to different filters
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:9001/search -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"x","cursor":"eyJrIjoiMCIsImkiOiJhIiwiZiI6ImRlYWRiZWVmIn0="}'
# → 400

# 422 — missing required field
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:9001/search -X POST \
  -H 'Content-Type: application/json' \
  -d '{}'
# → 422

# 404 — unknown video
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9001/videos/nope
# → 404
```

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
  └─ per item:
       ├─ probability       → confidence bar
       ├─ silhouette < 0    → dim (fringe)
       └─ silhouette ≥ 0.4 && probability ≥ 0.7 → "core" badge
```

### Endless / discovery feed — quick map

```
mode = "discover"
  ├─ POST /discover  (query optional)
  ├─ results are already diversified (diversity knob 0..1)
  ├─ change `seed` for a new "page"
  └─ similarity present only when `query` was supplied
```

### Tuning the clustered view from the UI

```jsonc
{
  "min_cluster_size": 2, // fewer/larger groups ← higher
  "cluster_selection_epsilon": 0.25, // tighter/more-noise ← lower
  "cluster_candidate_limit": 100, // more candidates    ← higher
}
```

The three knobs above are the **only** tuning controls exposed to end users for
`/search_clustered`. `n_clusters` does not exist — it was replaced by
`cluster_utils`' dynamic selection. If a client previously exposed
"groups = 3..10", replace it with "min_cluster_size" + "epsilon", or with a
coarse preset:

| Preset   | `min_cluster_size` | `cluster_selection_epsilon` | Effect                              |
| -------- | ------------------ | --------------------------- | ----------------------------------- |
| Tight    | `4`                | `0.15`                      | Few, cohesive groups, more noise.   |
| Balanced | `2`                | `0.25`                      | Default.                            |
| Loose    | `2`                | `0.45`                      | Fewer noise points, broader groups. |

### Reproducibility

Clustering is deterministic for a given `(candidate pool, query,
candidate_source)`: `TextsClusterer` seeds Spectral with `random_state=42` and
HDBSCAN is deterministic. The only non-determinism is
`candidate_source: "random"` (server-side `random()` ordering).

`/discover` is a pure function of `(seed, diversity, query, filters, candidate
pool)`; when `query` is `null` the candidate pool is `random()`-ordered, so
identical requests may differ.
