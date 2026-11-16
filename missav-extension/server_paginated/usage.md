# Video Search API — Usage

Complete sample `curl` commands covering **every** endpoint and **every**
parameter of `serve_missav.py` (port 9001). All responses are piped through
`python3 -m json.tool` for readability.

Base URL: `http://localhost:9001`

Endpoints:
`GET /health` · `POST /search` · `POST /similar` · `POST /hybrid` ·
`GET /browse` · `GET /videos/{id}` · `GET /facets` · `GET /facets/codes` ·
`POST /ingest`

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

`similarity` is `1 - cosine_distance` (higher = closer).

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

`genre` accepts either a single string **or** a JSON array. Use the plural
`genres` key for arrays in the examples below; both keys behave identically.

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

⚠️ `release_date` is **~80% NULL** in this schema (`genres` is ~80% NULL too)
— expect a small result set.

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

## 5. Filter by code (single)

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "leak",
    "limit": 10,
    "code": "sprd"
  }' | python3 -m json.tool
```

> **Note:** `code` values are stored lowercase (`mdyd`, `sprd`, …) —
> match the casing returned by `/facets`.

## 5b. Filter by code (multiple)

`code` accepts a single string **or** an array. Arrays match **any** of the
listed series (`code = ANY(...)`).

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "leak",
    "limit": 10,
    "code": ["sprd", "mdyd"]
  }' | python3 -m json.tool
```

---

## 5c. Combined filters (code + genre + date)

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "leak",
    "limit": 10,
    "code": ["sprd", "mdyd"],
    "genre": "Uncensored leak",
    "genres_mode": "any",
    "min_release_date": "2020-01-01T00:00:00Z"
  }' | python3 -m json.tool
```

---

## 5d. Only complete rows (`complete_only`)

Most rows in the DB are incomplete — `details` is ~78% NULL and many `title`s
are empty. Pass `complete_only: true` to restrict results to items that have
**both** a non-empty `title` **and** a non-empty `details` (rows that have
already been enriched).

The filter is applied alongside your other filters, so combine it with
`genre`/`code`/`sort` as usual. It is supported on `/search`, `/similar`,
`/hybrid`, `/browse`, `/facets`, and `/facets/codes`.

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "leak",
    "limit": 10,
    "code": ["sprd", "mdyd"],
    "complete_only": true
  }' | python3 -m json.tool
```

Because the flag is part of the filter fingerprint, a cursor issued under one
value of `complete_only` is invalid for another (HTTP 400
`"Cursor does not match filters"`).

---

## 6. Minimum similarity threshold

Only return results whose cosine similarity is ≥ 0.30.
Server-side translates to `distance <= 1 - min_similarity` (inclusive `>=`).

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

## 6b. Sorting and order

`sort` accepts `"similarity"` (default), `"release_date"`, or `"created_at"`.
`order` accepts `"desc"` (default) or `"asc"`.

> **Similarity direction is flipped:** for `sort:"similarity"`,
> `order:"desc"` means _closest first_ (server maps desc → `distance ASC`);
> `order:"asc"` means _farthest first_.

```bash
# newest releases first (same as default for release_date)
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "sensual story",
    "limit": 5,
    "sort": "release_date",
    "order": "desc"
  }' | python3 -m json.tool

# oldest releases first
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "sensual story",
    "limit": 5,
    "sort": "release_date",
    "order": "asc"
  }' | python3 -m json.tool

# most recently ingested first
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "sensual story",
    "limit": 5,
    "sort": "created_at",
    "order": "desc"
  }' | python3 -m json.tool
```

---

## 7. Pagination via cursor (search)

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

Changing `query`, `genre`, `genres`, `genres_mode`, `code`,
`min/max_release_date`, `min_similarity`, `sort`, `order`, or `complete_only`
invalidates the cursor and returns:

```json
{ "detail": "Cursor does not match filters" } // HTTP 400
```

Send `"cursor": null` to start over with fresh parameters.

---

## 8. Hybrid search (FTS + vector RRF)

Blends full-text ranking (uses `videos_title_fts_idx` with
`ts_rank_cd`/`plainto_tsquery`) with vector similarity via Reciprocal Rank
Fusion (k=60). Great for named-keyword queries like "Nanami Hirose".

```bash
curl -s -X POST localhost:9001/hybrid \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "Nanami Hirose",
    "limit": 20,
    "genres": ["English subtitle"]
  }' | python3 -m json.tool
```

Hybrid is a **single-shot** endpoint: no cursor, `next_cursor` is always
`null`, `has_more` is always `false`. Increase `limit` (max 100) if you need
more than 20.

> **Note:** `/hybrid` has **no `genres_mode`** — genre filtering always behaves
> as `"any"` internally.

## 8b. Hybrid with date range + multi-code

`/hybrid` also supports `min_release_date`, `max_release_date`, `code`
(single or list), `sort` (`"release_date"`/`"created_at"`), and `order`.

```bash
curl -s -X POST localhost:9001/hybrid \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "Nanami",
    "limit": 20,
    "code": ["mdyd", "sprd"],
    "min_release_date": "2014-01-01T00:00:00Z",
    "max_release_date": "2016-12-31T23:59:59Z",
    "sort": "release_date",
    "order": "asc"
  }' | python3 -m json.tool
```

## 8c. Hybrid — only complete rows

```bash
curl -s -X POST localhost:9001/hybrid \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "Nanami",
    "limit": 20,
    "complete_only": true
  }' | python3 -m json.tool
```

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

**Step 3** — similar with genre filter:

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

## 9b. Similar with AND genres + multi-code + sort

```bash
curl -s -X POST localhost:9001/similar \
  -H 'Content-Type: application/json' \
  -d '{
    "video_id": "jav-63v9uv",
    "limit": 20,
    "genres": ["Wife", "Individual"],
    "genres_mode": "all",
    "code": ["mdyd", "sprd"],
    "sort": "release_date",
    "order": "asc"
  }' | python3 -m json.tool
```

## 9c. Similar — only complete rows

```bash
curl -s -X POST localhost:9001/similar \
  -H 'Content-Type: application/json' \
  -d '{
    "video_id": "jav-63v9uv",
    "limit": 20,
    "complete_only": true
  }' | python3 -m json.tool
```

## 9d. Similar with cursor pagination

Cursors are fingerprint-bound (same rules as `/search`). Reuse identical
filters + the same `video_id`.

```bash
# page 1 — save response
curl -s -X POST localhost:9001/similar \
  -H 'Content-Type: application/json' \
  -d '{"video_id":"jav-63v9uv","limit":5,"genres":["Wife","Individual"],"genres_mode":"all"}' \
  | tee /tmp/sim1.json | python3 -m json.tool

# page 2 — same filters + cursor
CURSOR=$(python3 -c 'import json;print(json.load(open("/tmp/sim1.json"))["next_cursor"])')
curl -s -X POST localhost:9001/similar \
  -H 'Content-Type: application/json' \
  -d "{\"video_id\":\"jav-63v9uv\",\"limit\":5,\"genres\":[\"Wife\",\"Individual\"],\"genres_mode\":\"all\",\"cursor\":\"$CURSOR\"}" \
  | python3 -m json.tool
```

`similar` accepts `video_id`, `limit`, `cursor`, `genre`/`genres`,
`genres_mode`, `code` (single or list), `sort`, `order`, and `complete_only`
— but **no** date or similarity filters. The source video is always excluded
from results.

---

## 10. Browse (no embedding needed)

Plain listing sorted by `release_date DESC` (or `created_at`). Uses
`offset` pagination. Useful when the search box is empty.

> ⚠️ The endpoint's declared query params are `genre` and `genres_mode`
> (singular `genre`, repeatable). There is **no** `genres` param on `/browse`
> — pass `genre=...` multiple times for OR logic.

**Newest releases:**

```bash
curl -s 'localhost:9001/browse?limit=20&offset=0' | python3 -m json.tool
```

**Browse a specific code (series):**

```bash
curl -s 'localhost:9001/browse?code=sprd&limit=20' | python3 -m json.tool
```

**Browse by multiple genres (OR) — repeat `genre`:**

```bash
curl -s -G localhost:9001/browse \
  --data-urlencode 'limit=20' \
  --data-urlencode 'genre=Wife' \
  --data-urlencode 'genre=Individual' | python3 -m json.tool
```

**Browse by multiple genres (AND) — add `genres_mode=all`:**

```bash
curl -s -G localhost:9001/browse \
  --data-urlencode 'limit=20' \
  --data-urlencode 'genres_mode=all' \
  --data-urlencode 'genre=Wife' \
  --data-urlencode 'genre=Individual' | python3 -m json.tool
```

**Browse multiple codes — repeat `code`:**

```bash
curl -s -G localhost:9001/browse \
  --data-urlencode 'limit=20' \
  --data-urlencode 'code=sprd' \
  --data-urlencode 'code=mdyd' | python3 -m json.tool
```

**Sort by ingestion time** (useful for "what's new in the DB" views):

```bash
curl -s 'localhost:9001/browse?limit=20&sort=created_at' | python3 -m json.tool
```

**Oldest releases first (`order=asc`):**

```bash
curl -s 'localhost:9001/browse?limit=20&sort=release_date&order=asc' | python3 -m json.tool
```

**Only complete rows:**

```bash
curl -s 'localhost:9001/browse?limit=20&complete_only=true' | python3 -m json.tool
```

`complete_only` is a plain boolean query param here (no JSON body on GET).
Pass `true`/`false`; omission defaults to `false`.

**Next page** (`next_cursor` on `/browse` is just the next numeric offset):

```bash
curl -s 'localhost:9001/browse?limit=20&offset=20' | python3 -m json.tool
```

`offset` is capped at 100,000.

---

## 11. Video detail

```bash
curl -s localhost:9001/videos/jav-63v9uv | python3 -m json.tool
```

404 if the id doesn't exist:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:9001/videos/does-not-exist
# → 404
```

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

Tune sizes (`top_genres` default 60, `top_codes` default 40):

```bash
curl -s 'localhost:9001/facets?top_genres=100&top_codes=60' | python3 -m json.tool
```

**Facets over complete rows only** — useful for sidebar counts that match a
`complete_only=true` view:

```bash
curl -s 'localhost:9001/facets?complete_only=true' | python3 -m json.tool
```

`complete_only` (boolean query param, default `false`) applies the same "title
AND details both non-empty" predicate before aggregating, so counts reflect
the filtered subset only.

---

## 13. All codes (complete list)

Unlike `/facets` (which caps to `top_codes`), `/facets/codes` returns **every**
distinct code with its count. No size parameter — with ~3,200 distinct codes
this is still small enough to send whole.

```bash
curl -s localhost:9001/facets/codes | python3 -m json.tool
```

```json
{
  "code_count": 3199,
  "codes": [
    { "code": "mdyd", "count": 1211 },
    { "code": "sprd", "count": 986 }
  ]
}
```

Use this to populate a complete series/code picker; use `/facets?top_codes=N`
when you only need a truncated sidebar.

**Codes for complete rows only:**

```bash
curl -s 'localhost:9001/facets/codes?complete_only=true' | python3 -m json.tool
```

Same boolean query param as `/facets`; counts reflect only rows with a
non-empty `title` and `details`.

---

## 14. Ingest (bulk insert / upsert)

Insert or upsert 1–500 rows into `public.videos`. **Embeddings are always
regenerated server-side** from the item fields (title/details/code/episode/
genres) using the same `|`-joined format as the ChromaDB→Postgres migration,
so ingested rows stay comparable to migrated ones for semantic search.

Embedding inputs are additionally **truncated with `truncate_texts`** to a
token budget (`INGEST_MAX_TOKENS`, default 2048) before being sent to the
embedding server, so very long `title`/`details` combinations cannot exceed the
model's context window. The stored `title`/`details` columns are unaffected —
only the text fed to `embed()` is truncated.

### 14a. Single item (upsert)

```bash
curl -s -X POST localhost:9001/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "items": [
      {
        "id": "jav-example-001",
        "url": "https://missav.ws/dm2/en/exm-001",
        "code": "exm",
        "episode": "001",
        "video_id": "exm-001",
        "title": "Example Title",
        "thumbnail": "https://fourhoi.com/exm-001/cover-n.jpg",
        "preview": "https://fourhoi.com/exm-001/preview.mp4",
        "details": "Example details text.",
        "release_date": "2024-01-01T00:00:00Z",
        "genres": ["Drama", "Wife"]
      }
    ],
    "upsert": true
  }' | python3 -m json.tool
```

```json
{ "inserted": 1, "updated": 0, "skipped": 0, "took_ms": 312.5 }
```

### 14b. Batch with an intentionally skipped item

Items with **neither** `title` nor `details` have nothing to embed and land in
`skipped` (not inserted).

```bash
curl -s -X POST localhost:9001/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "items": [
      {"id":"jav-ex-002","url":"https://missav.ws/dm2/en/exm-002","code":"exm","episode":"002","video_id":"exm-002","title":"Batch A"},
      {"id":"jav-ex-003","url":"https://missav.ws/dm2/en/exm-003","code":"exm","episode":"003","video_id":"exm-003","title":"Batch B"},
      {"id":"jav-ex-004","url":"https://missav.ws/dm2/en/exm-004","code":"exm","episode":"004","video_id":"exm-004"}
    ],
    "upsert": true
  }' | python3 -m json.tool
```

```json
{ "inserted": 2, "updated": 0, "skipped": 1, "took_ms": 401.2 }
```

### 14c. Insert-only (`upsert: false`)

Existing ids are **not** modified and count as `skipped`.

```bash
curl -s -X POST localhost:9001/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "items": [
      {"id":"jav-ex-002","url":"https://missav.ws/dm2/en/exm-002","code":"exm","episode":"002","video_id":"exm-002","title":"Ignored (exists)"}
    ],
    "upsert": false
  }' | python3 -m json.tool
```

```json
{ "inserted": 0, "updated": 0, "skipped": 1, "took_ms": 88.4 }
```

### Ingest semantics

- **Skipped rows:** items with neither `title` nor `details`.
- **`upsert: true`** (default) — `ON CONFLICT (id) DO UPDATE`; nullable fields
  use `COALESCE(EXCLUDED.*, videos.*)` so a sparse update never nulls out
  existing data. `embedding` and `updated_at` are always overwritten.
- **`upsert: false`** — `ON CONFLICT (id) DO NOTHING`; existing ids count as
  `skipped`.
- **Required fields per item:** `id`, `url`, `code`, `episode`, `video_id`.
- **Batch size:** 1–500 items (`400` if outside).
- **Truncation:** embedding inputs longer than `INGEST_MAX_TOKENS` tokens
  (title+details+code+episode+genres combined) are truncated by
  `truncate_texts` before embedding; the stored columns are untouched.
- Whole batch runs in one transaction.

---

## 15. End-to-end smoke test

Run every endpoint in one go:

```bash
#!/usr/bin/env bash
set -euo pipefail

H=http://localhost:9001

echo "== health ==";        curl -sf $H/health | jq .
echo "== facets ==";        curl -sf $H/facets | jq '.genres[:3]'
echo "== facets codes ==";  curl -sf $H/facets/codes | jq '.code_count'
echo "== search ==";        curl -sf -X POST $H/search -H 'Content-Type: application/json' \
                                 -d '{"query":"sensual story","limit":5}' | jq '.items[0].id'
echo "== search sorted =="; curl -sf -X POST $H/search -H 'Content-Type: application/json' \
                                 -d '{"query":"sensual story","limit":3,"sort":"release_date","order":"asc"}' | jq '.items|length'
echo "== search complete =="; curl -sf -X POST $H/search -H 'Content-Type: application/json' \
                                 -d '{"query":"sensual story","limit":3,"complete_only":true}' | jq '.items|length'
echo "== similar ==";       curl -sf -X POST $H/similar -H 'Content-Type: application/json' \
                                 -d '{"video_id":"jav-63v9uv","limit":3}' | jq '.items | length'
echo "== hybrid ==";        curl -sf -X POST $H/hybrid -H 'Content-Type: application/json' \
                                 -d '{"query":"Nanami","limit":3}' | jq '.items | length'
echo "== browse ==";        curl -sf "$H/browse?limit=3" | jq '.items | length'
echo "== browse complete =="; curl -sf "$H/browse?limit=3&complete_only=true" | jq '.items | length'
echo "== browse multi ==" ; curl -sf -G "$H/browse" --data-urlencode 'limit=3' \
                                 --data-urlencode 'code=sprd' --data-urlencode 'code=mdyd' | jq '.items|length'
echo "== detail ==";        curl -sf $H/videos/jav-63v9uv | jq '.code'
echo "== ingest ==";        curl -sf -X POST $H/ingest -H 'Content-Type: application/json' \
                                 -d '{"items":[{"id":"jav-smoke-001","url":"https://example/x","code":"smk","episode":"001","video_id":"smk-001","title":"Smoke Test"}]}' \
                                 | jq '{inserted,updated,skipped}'

echo "OK"
```

---

## Tips

- **Pretty print:** every command above pipes through `python3 -m json.tool`;
  if you have `jq`, swap in `| jq .` for colorized output.
- **Case sensitivity:** `genres` values and `code` values are **case-sensitive**
  in the DB (e.g. `"Mature Woman"` ≠ `"mature woman"`). Use `/facets` to see
  canonical values.
- **NULL-heavy columns:** `release_date` and `genres` are **~80% NULL** — any
  filter on them can drastically shrink the result set. Drop the filter first
  if you're getting empty pages.
- **Complete rows:** most rows have a NULL `details` (~78%) and some have an
  empty `title`. Pass `complete_only: true` (JSON body) or
  `?complete_only=true` (query param) to restrict any endpoint to items whose
  `title` **and** `details` are both non-empty.
- **Multi-value filters:** `genre`/`genres` and `code` accept either a single
  string **or** a list in all JSON bodies (`/search`, `/similar`, `/hybrid`).
  On `/browse`, repeat the query param (`genre=...&genre=...`,
  `code=...&code=...`) instead.
- **`genres_mode`:** `"any"` = overlap (OR, default), `"all"` = strict
  containment (AND). Supported on `/search`, `/similar`, `/browse` — **not**
  `/hybrid` (always `"any"`).
- **Two kinds of cursor:**
  - `/search` and `/similar` use opaque, **fingerprint-bound** cursors. Reusing
    one with a different query/filter set (including a different
    `complete_only` value) returns HTTP 400
    `"Cursor does not match filters"`. Send `"cursor": null` to start over.
  - `/browse` uses **offset** pagination; its `next_cursor` is just the next
    integer offset (`"20"`, `"40"`, …). It is not fingerprint-bound.
- **Hybrid has no pagination:** `next_cursor` is always `null` and `has_more`
  always `false`. Raise `limit` (max 100) instead.
- **`similar` request body:** uses `video_id` (the source video's id), not
  `id`.
- **`/browse` uses `genre`, not `genres`:** repeat the `genre` param for OR
  logic; add `genres_mode=all` for AND.
- **Empty query:** `search` requires a non-empty `query`. To browse without a
  query, use `GET /browse`.
- **Ingest regenerates embeddings:** you cannot supply your own embedding — the
  server computes it from the item text. Rows with no `title` and no `details`
  are skipped.
- **Ingest truncates embedding input:** the `|`-joined embedding text is
  truncated with `truncate_texts` to `INGEST_MAX_TOKENS` (default 2048), so
  long inputs don't blow past the embedding model context. Stored `title` and
  `details` are not truncated.
- **Similarity direction flip:** for `sort:"similarity"`, `order:"desc"` means
  closest first; `order:"asc"` means farthest first.
