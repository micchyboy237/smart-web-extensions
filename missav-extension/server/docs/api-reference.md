# API Reference

Here are comprehensive CURL examples covering all search features of your MissAV Smart Search API.

## API Endpoint Overview

| Method | Endpoint                     | Purpose                     |
| ------ | ---------------------------- | --------------------------- |
| GET    | `/api/health`                | Server health check         |
| POST   | `/api/videos/ingest`         | Ingest video batch          |
| GET    | `/api/videos`                | List all videos (paginated) |
| GET    | `/api/videos/{video_id}`     | Get single video            |
| GET    | `/api/videos/count`          | Total video count           |
| POST   | `/api/search`                | Smart search                |
| POST   | `/api/preferences`           | Update user preferences     |
| GET    | `/api/preferences/{user_id}` | Get user preferences        |

---

## 1. Health Check

```bash
# Basic health check
curl -X GET http://localhost:8000/api/health

# With CORS origin header (simulating browser)
curl -X GET http://localhost:8000/api/health \
  -H "Origin: https://missav.com"
```

**Response:**

```json
{
  "status": "healthy",
  "timestamp": 1752443321.123,
  "cors_origin": "https://missav.com",
  "videos_count": 1234,
  "endpoints": [...]
}
```

---

## 2. Video Ingestion

```bash
# Ingest a batch of videos
curl -X POST http://localhost:8000/api/videos/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "source": "extension",
    "videos": [
      {
        "id": "juq-373",
        "url": "https://missav.com/juq-373",
        "text": "JUQ-373 Beautiful Actress",
        "thumbnail": "https://example.com/thumb.jpg",
        "preview": "https://example.com/preview.mp4",
        "videoId": "juq-373",
        "code": "juq",
        "episode": "373"
      },
      {
        "id": "mxgs-1200",
        "url": "https://missav.com/mxgs-1200",
        "text": "MXGS-1200 New Release",
        "code": "mxgs",
        "episode": "1200"
      }
    ]
  }'
```

---

## 3. Video Retrieval

```bash
# Get all videos (default 100)
curl -X GET "http://localhost:8000/api/videos"

# Paginated: 50 videos, skip first 100
curl -X GET "http://localhost:8000/api/videos?limit=50&offset=100"

# Get video count
curl -X GET http://localhost:8000/api/videos/count

# Get single video by ID
curl -X GET http://localhost:8000/api/videos/juq-373
```

---

## 4. Smart Search - All Features

### Basic Semantic Search

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "beautiful actress",
    "search_type": "semantic"
  }'
```

### Keyword Search

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "juq 373",
    "search_type": "keyword"
  }'
```

### Hybrid Search (semantic + keyword + query understanding)

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "popular juq videos from 300-500",
    "search_type": "hybrid"
  }'
```

### Ensemble Search (all signals combined)

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "new mxgs content not fc2",
    "search_type": "ensemble"
  }'
```

### With Code Inclusion Filter

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "latest releases",
    "top_k": 30,
    "include_codes": ["juq", "mxgs", "ssis"]
  }'
```

### With Code Exclusion Filter

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "popular videos",
    "exclude_codes": ["fc2", "heyzo"]
  }'
```

### With Episode Range Filter

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "juq series",
    "include_codes": ["juq"],
    "include_episode_range": [300, 500]
  }'
```

### With Specific Episode Filter

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "specific episodes",
    "include_episodes": ["373", "420", "999"]
  }'
```

### Exclude Already Watched Videos

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "drama videos",
    "exclude_ids": ["juq-373", "mxgs-1200", "ssis-500"]
  }'
```

### High Diversity Search

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "something diverse like juq-373",
    "diversity_factor": 0.8,
    "search_type": "hybrid"
  }'
```

### Low Diversity (Focused) Search

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "exact match juq videos",
    "diversity_factor": 0.1,
    "include_codes": ["juq"]
  }'
```

### With Max Per Code Limit

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "variety of content",
    "diversity_factor": 0.5,
    "max_per_code": 3,
    "top_k": 20
  }'
```

### Complex Combined Query

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "top trending juq and mxgs videos not fc2 from 300-500",
    "top_k": 25,
    "include_codes": ["juq", "mxgs"],
    "exclude_codes": ["fc2"],
    "exclude_ids": ["mxgs-1200"],
    "include_episode_range": [300, 500],
    "diversity_factor": 0.4,
    "max_per_code": 5,
    "search_type": "ensemble"
  }'
```

---

## 5. User Preferences

### Update/Create Preferences

```bash
curl -X POST http://localhost:8000/api/preferences \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user123",
    "favorite_codes": ["juq", "mxgs"],
    "blocked_codes": ["fc2", "heyzo"],
    "watched_ids": ["juq-373", "mxgs-1200"],
    "preferred_episode_range": [300, 500],
    "diversity_preference": 0.4
  }'
```

### Get User Preferences

```bash
curl -X GET http://localhost:8000/api/preferences/user123

# Default user
curl -X GET http://localhost:8000/api/preferences/default
```

---

## Search Types Comparison

| Type       | Description               | Signals Used                              |
| ---------- | ------------------------- | ----------------------------------------- |
| `semantic` | Pure embedding similarity | ChromaDB vector search                    |
| `keyword`  | BM25/text matching        | ChromaDB keyword search                   |
| `hybrid`   | Semantic + keyword + NLU  | Combined + QueryUnderstanding             |
| `ensemble` | All signals weighted      | Semantic + Keyword + Recency + Preference |

## Filter Summary

| Filter                  | ChromaDB Level       | Python Level      |
| ----------------------- | -------------------- | ----------------- |
| `exclude_codes`         | ✅ `$ne`             | ❌                |
| `exclude_ids`           | ✅ `$ne`             | ❌                |
| `include_codes`         | ❌                   | ✅                |
| `include_episodes`      | ❌                   | ✅                |
| `include_episode_range` | ❌                   | ✅                |
| `diversity_factor`      | ❌                   | ✅ (MMR/Metadata) |
| `max_per_code`          | ❌                   | ✅                |
| `top_k`                 | ✅ (candidate fetch) | ✅ (final limit)  |
