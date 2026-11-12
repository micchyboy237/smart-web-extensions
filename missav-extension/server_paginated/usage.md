Here are complete sample `curl` commands to test your video search API, covering basic search, metadata filtering, and pagination.

### 1. Basic Semantic Search

Search for videos matching the concept of "sensual story" without any filters.

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "sensual story",
    "limit": 20
  }' | python3 -m json.tool
```

### 2. Filter by Single Genre

Find videos that specifically contain the genre "Mature Woman".

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "family drama",
    "limit": 20,
    "genre": "Mature Woman"
  }' | python3 -m json.tool
```

### 3. Filter by Multiple Genres (OR Logic)

Find videos that have **either** "Wife" **or** "Individual" in their genres.

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "romantic encounter",
    "limit": 20,
    "genres": ["Wife", "Individual"]
  }' | python3 -m json.tool
```

### 4. Filter by Date Range

Find videos released between 2014 and 2016.

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

### 5. Combined Filters (Genre + Code + Date)

A complex query looking for a specific series code within a date range and genre.

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "leak",
    "limit": 10,
    "code": "SPRD",
    "genre": "Uncensored leak",
    "min_release_date": "2020-01-01T00:00:00Z"
  }' | python3 -m json.tool
```

### 6. Pagination (Using Cursor)

First, run a search to get a `next_cursor`. Then use it to fetch the next page.
_(Replace `<PASTE_CURSOR_HERE>` with the actual string from the first response)_

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "sensual story",
    "limit": 20,
    "cursor": "<PASTE_CURSOR_HERE>"
  }' | python3 -m json.tool
```

### 7. Hybrid-like Search (Keyword in Query + Metadata)

Since you have a full-text index on `title`, you can also try putting specific keywords in the `query` field while filtering by metadata.

```bash
curl -s -X POST localhost:9001/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "Nanami Hirose",
    "limit": 20,
    "genre": "English subtitle"
  }' | python3 -m json.tool
```

### Tips for Testing:

- **Pretty Print:** I added `| python3 -m json.tool` to make the JSON output readable in your terminal.
- **Null Handling:** If a filter returns no results, check if the column has high null percentages (like `release_date` which is ~95% null in your schema).
- **Case Sensitivity:** Ensure the `genre` strings in your curl commands exactly match the case in your database (e.g., "Mature Woman" vs "mature woman").
