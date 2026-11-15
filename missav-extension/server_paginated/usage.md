# Video Search API — Usage

Complete sample `curl` commands covering every endpoint of `serve_missav.py`
(port 9001). All responses are piped through `python3 -m json.tool` for
readability.

Base URL: `http://localhost:9001`

---

## 0. Health check

Confirm the server is up and the DB is reachable.

```bash
curl -s localhost:9001/health | python3 -m json.tool
```

```json
{ "ok": true, "db_ms": 1.83 }
```

---

## 1. Semantic search (basic)

Search by concept — no filters, first page.

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "sensual story",
    "limit": 20
  }' | python3 -m json.tool
```

Response shape (trimmed):

```json
{
  "items": [
    {
      "id": "jav-63v9uv",
      "title": "Invitation of a mannequin Nanami Hirose",
      "details": "A shock runs to Nanami...",
      "code": "mdyd",
      "episode": "948",
      "url": "https://missav.ws/dm2/en/mdyd-948-english-subtitle",
      "preview": "https://fourhoi.com/.../preview.mp4",
      "thumbnail": "https://fourhoi.com/.../cover-t.jpg",
      "release_date": "2014-09-07T12:00:28+08:00",
      "genres": ["English subtitle", "Mature Woman", "Wife"],
      "similarity": 0.8123
    }
  ],
  "next_cursor": "eyJkIjowLjE4NzcsImkiOiJqYXYtNjN2OXV2IiwiZiI6ImFiYzEyMyJ9",
  "has_more": true,
  "took_ms": 42.17
}
```

---

## 2. Filter by single genre

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "family drama",
    "limit": 20,
    "genre": "Mature Woman"
  }' | python3 -m json.tool
```

---

## 3. Filter by multiple genres — OR logic (default)

Videos that contain **either** "Wife" **or** "Individual".

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "romantic encounter",
    "limit": 20,
    "genres": ["Wife", "Individual"],
    "genres_mode": "any"
  }' | python3 -m json.tool
```

## 3b. Filter by multiple genres — AND logic

Videos that contain **both** "Wife" **and** "Individual".
(`genres_mode` defaults to `"any"`; set it to `"all"` for strict containment.)

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "romantic encounter",
    "limit": 20,
    "genres": ["Wife", "Individual"],
    "genres_mode": "all"
  }' | python3 -m json.tool
```

---

## 4. Filter by date range

Videos released between 2014 and 2016.
⚠️ `release_date` is ~94.5% NULL in this schema — expect a small result set.

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "english subtitle",
    "limit": 20,
    "min_release_date": "2014-01-01T00:00:00Z",
    "max_release_date": "2016-12-31T23:59:59Z"
  }' | python3 -m json.tool
```

---

## 5. Combined filters (code + genre + date)

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "leak",
    "limit": 10,
    "code": "sprd",
    "genre": "Uncensored leak",
    "min_release_date": "2020-01-01T00:00:00Z"
  }' | python3 -m json.tool
```

> **Note:** `code` values are stored lowercase (`mdyd`, `sprd`, `mdyd`, …) —
> match the casing returned by `/facets`.

---

## 6. Minimum similarity threshold

Only return results whose cosine similarity is ≥ 0.30.
Server-side translates to `distance <= 1 - min_similarity`.

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "mother and son",
    "limit": 20,
    "min_similarity": 0.30
  }' | python3 -m json.tool
```

---

## 7. Pagination via cursor

**Step 1** — first page; capture `next_cursor`:

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "sensual story",
    "limit": 20
  }' | python3 -c 'import sys,json;print(json.load(sys.stdin)["next_cursor"])'
```

**Step 2** — next page. Cursors are bound to the exact query + filter set
(fingerprint), so reuse **all** the same parameters:

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "sensual story",
    "limit": 20,
    "cursor": "<PASTE_CURSOR_HERE>"
  }' | python3 -m json.tool
```

**Step 3** — stop when `has_more` is `false` and `next_cursor` is `null`.

Changing `query`, `genre`, `genres`, `code`, `min/max_release_date`, or
`min_similarity` invalidates the cursor and returns:

```json
{ "detail": "Cursor does not match filters" } // HTTP 400
```

---

## 8. Hybrid search (FTS + vector RRF)

Blends BM25-ish full-text ranking (uses `videos_title_fts_idx`) with vector
similarity via Reciprocal Rank Fusion. Great for named-keyword queries like
"Nanami Hirose".

```bash
curl -s -X POST localhost:9001/hybrid \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "Nanami Hirose",
    "limit": 20,
    "genres": ["English subtitle"]
  }' | python3 -m json.tool
```

Hybrid is a single-shot endpoint (no cursor). Increase `limit` if you need
more than 20.

---

## 9. Similar videos ("more like this")

Uses the video's stored embedding — no query text needed.

**Step 1** — pick any video id:

```bash
curl -s localhost:9001/videos/jav-63v9uv | python3 -m json.tool
```

**Step 2** — find neighbors:

```bash
curl -s -X POST localhost:9001/similar \
  -H 'Content-Type: application/json' \
  -d '{
    "video_id": "jav-63v9uv",
    "limit": 20
  }' | python3 -m json.tool
```

**Step 3** — similar with genre filter, then paginate with `cursor`:

```bash
curl -s -X POST localhost:9001/similar \
  -H 'Content-Type: application/json' \
  -d '{
    "video_id": "jav-63v9uv",
    "limit": 20,
    "genres": ["Wife"],
    "genres_mode": "any"
  }' | python3 -m json.tool
```

---

## 10. Browse (no embedding needed)

Plain listing sorted by `release_date DESC` (or `created_at`). Uses
`offset` pagination. Useful when the search box is empty.

**Newest releases:**

```bash
curl -s 'localhost:9001/browse?limit=20&offset=0' | python3 -m json.tool
```

**Browse a specific code (series):**

```bash
curl -s 'localhost:9001/browse?code=sprd&limit=20' | python3 -m json.tool
```

**Browse by multiple genres (OR):**

```bash
curl -s -G localhost:9001/browse \
  --data-urlencode 'limit=20' \
  --data-urlencode 'genres=Wife' \
  --data-urlencode 'genres=Individual' | python3 -m json.tool
```

**Sort by ingestion time** (useful for "what's new in the DB" views):

```bash
curl -s 'localhost:9001/browse?limit=20&sort=created_at' | python3 -m json.tool
```

**Next page:**

```bash
curl -s 'localhost:9001/browse?limit=20&offset=20' | python3 -m json.tool
```

---

## 11. Video detail

```bash
curl -s localhost:9001/videos/jav-63v9uv | python3 -m json.tool
```

404 if the id doesn't exist.

---

## 12. Facets (for the filter sidebar)

Returns the most-used genres, the top codes, and a per-year histogram of
non-NULL `release_date`s.

```bash
curl -s localhost:9001/facets | python3 -m json.tool
```

```json
{
  "genres": [
    { "name": "English subtitle", "count": 21488 },
    { "name": "Mature Woman", "count": 9871 }
  ],
  "codes": [
    { "code": "mdyd", "count": 1211 },
    { "code": "sprd", "count": 986 }
  ],
  "years": [
    { "year": 2013, "count": 401 },
    { "year": 2014, "count": 588 }
  ]
}
```

Tune sizes:

```bash
curl -s 'localhost:9001/facets?top_genres=100&top_codes=60' | python3 -m json.tool
```

---

## 13. End-to-end smoke test

Run all endpoints in one go:

```bash
#!/usr/bin/env bash
set -euo pipefail
H=http://localhost:9001

echo "== health ==";      curl -sf $H/health | jq .
echo "== facets ==";      curl -sf $H/facets | jq '.genres[:3]'
echo "== search ==";      curl -sf -X POST $H/search -H 'Content-Type: application/json' \
                               -d '{"query":"sensual story","limit":5}' | jq '.items[0].id'
echo "== similar ==";     curl -sf -X POST $H/similar -H 'Content-Type: application/json' \
                               -d '{"video_id":"jav-63v9uv","limit":3}' | jq '.items | length'
echo "== hybrid ==";      curl -sf -X POST $H/hybrid -H 'Content-Type: application/json' \
                               -d '{"query":"Nanami","limit":3}' | jq '.items | length'
echo "== browse ==";      curl -sf "$H/browse?limit=3" | jq '.items | length'
echo "== detail ==";      curl -sf $H/videos/jav-63v9uv | jq '.code'
echo "OK"
```

---

## Tips

- **Pretty print:** every command above pipes through `python3 -m json.tool`;
  if you have `jq`, swap in `| jq .` for colorized output.
- **Case sensitivity:** `genres` values and `code` values are **case-sensitive**
  in the DB (e.g. `"Mature Woman"` ≠ `"mature woman"`). Use `/facets` to see
  canonical values.
- **NULL-heavy columns:** `release_date` and `genres` are ~94.5% NULL — any
  filter on them can drastically shrink the result set. Drop the filter first
  if you're getting empty pages.
- **Cursor invalidation:** reusing a cursor with a different filter/query set
  returns HTTP 400 `"Cursor does not match filters"`. Send a fresh request
  with `"cursor": null` to start over.
- **Similar request body:** `similar` uses `video_id`, not `id` — the source
  video's id.
- **Empty query:** `search` requires a non-empty `query`. To browse without a
  query, use `GET /browse`.
