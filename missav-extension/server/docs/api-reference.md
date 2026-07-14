# API Reference

Here are comprehensive CURL examples covering all features of your MissAV Smart Search API.

## API Endpoint Overview

| Method | Endpoint                                 | Purpose                     |
| ------ | ---------------------------------------- | --------------------------- |
| GET    | `/api/health`                            | Server health check         |
| GET    | `/api/analysis/health`                   | Analysis module health      |
| POST   | `/api/analysis/topics`                   | Extract topics via BERTopic |
| GET    | `/api/analysis/topics/{topic_id}/videos` | Get videos for a topic      |
| POST   | `/api/videos/ingest`                     | Ingest video batch          |
| GET    | `/api/videos`                            | List all videos (paginated) |
| GET    | `/api/videos/{video_id}`                 | Get single video            |
| GET    | `/api/videos/count`                      | Total video count           |
| POST   | `/api/search`                            | Smart search                |
| POST   | `/api/preferences`                       | Update user preferences     |
| GET    | `/api/preferences/{user_id}`             | Get user preferences        |

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

## 2. Analysis — BERTopic Integration

### Analysis Health Check

```bash
# Check if BERTopic/embedding server is ready
curl -X GET http://localhost:8000/api/analysis/health
```

**Response:**

```json
{
  "status": "available",
  "embedder_ready": true,
  "model_info": {
    "backend": "llama.cpp",
    "min_topic_size_default": 3,
    "supports_keybert": true
  }
}
```

### Extract Topics from All Videos

```bash
# Run BERTopic on the entire video collection
curl -X POST http://localhost:8000/api/analysis/topics \
  -H "Content-Type: application/json" \
  -d '{
    "min_topic_size": 3,
    "top_n_words": 10,
    "remove_stop_words": true,
    "use_keybert": true,
    "n_representative_docs": null
  }'
```

**Response:**

```json
{
  "topics": [
    {
      "topic_id": 0,
      "name": "0_actress_drama_beautiful",
      "keywords": ["actress", "drama", "beautiful", "story", "romance"],
      "size": 3,
      "representative_docs": [
        "JUQ-373 Beautiful Actress | Series: juq | Episode: 373...",
        "SSIS-500 Romantic Drama Story | Series: ssis | Episode: 500...",
        "MXGS-1200 Actress Debut | Series: mxgs | Episode: 1200..."
      ]
    },
    {
      "topic_id": 1,
      "name": "1_new_release_recent",
      "keywords": ["new", "release", "recent", "latest", "debut"],
      "size": 2,
      "representative_docs": [
        "MXGS-1300 New Release | Series: mxgs | Episode: 1300...",
        "JUQ-400 Latest Release | Series: juq | Episode: 400..."
      ]
    }
  ],
  "topic_count": 2,
  "document_count": 100,
  "outlier_count": 23,
  "extraction_time_ms": 4521.34,
  "timestamp": "2026-07-14T10:30:00.000Z"
}
```

### Extract Topics from Specific Videos

```bash
curl -X POST http://localhost:8000/api/analysis/topics \
  -H "Content-Type: application/json" \
  -d '{
    "video_ids": ["juq-373", "mxgs-1200", "ssis-500"],
    "min_topic_size": 2,
    "top_n_words": 5,
    "remove_stop_words": true,
    "use_keybert": true,
    "n_representative_docs": null
  }'
```

### Extract Topics with Lower Granularity (more topics)

```bash
curl -X POST http://localhost:8000/api/analysis/topics \
  -H "Content-Type: application/json" \
  -d '{
    "min_topic_size": 2,
    "top_n_words": 15,
    "remove_stop_words": true,
    "use_keybert": true,
    "n_representative_docs": null
  }'
```

### Get Videos for a Specific Topic

```bash
# After extraction, explore which videos belong to topic 0
curl -X GET "http://localhost:8000/api/analysis/topics/0/videos?limit=10&offset=0"
```

**Response:**

```json
{
  "topic_id": 0,
  "topic_name": "0_actress_drama_beautiful",
  "keywords": ["actress", "drama", "beautiful", "story", "romance"],
  "videos": [
    {
      "id": "juq-373",
      "document": "JUQ-373 Beautiful Actress | Series: juq | Episode: 373...",
      "metadata": {
        "code": "juq",
        "episode": "373",
        "text": "JUQ-373 Beautiful Actress"
      }
    }
  ],
  "total": 45,
  "limit": 10,
  "offset": 0
}
```

## 3. Video Ingestion

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

## 4. Video Retrieval

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

## 5. Smart Search - All Features

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

### Limit to Specific Video IDs (Page-Loaded Mode)

Restrict search to only the videos currently loaded in the browser. The extension sends the video IDs scraped from the active tab, and the server searches exclusively within that subset using ChromaDB's `$in` filter.

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "best scenes",
    "top_k": 10,
    "limit_to_ids": [
      "jav-abc123", "jav-def456", "jav-ghi789",
      "jav-jkl012", "jav-mno345", "jav-pqr678"
    ]
  }'
```

### Limit to Page with Additional Filters

Combining `limit_to_ids` with other filters lets you narrow down the current page's videos even further.

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "drama",
    "top_k": 5,
    "limit_to_ids": [
      "jav-abc123", "jav-def456", "jav-ghi789",
      "jav-jkl012", "jav-mno345", "jav-pqr678",
      "jav-stu901", "jav-vwx234"
    ],
    "exclude_codes": ["fc2"],
    "include_episode_range": [100, 500]
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

### Search Parameter Reference

| Parameter               | Type         | Default    | Description                                                    |
| ----------------------- | ------------ | ---------- | -------------------------------------------------------------- |
| `query`                 | `string`     | required   | Natural language or keyword search query                       |
| `search_type`           | `string`     | `"hybrid"` | One of: `semantic`, `keyword`, `hybrid`, `ensemble`            |
| `top_k`                 | `int`        | `20`       | Number of results to return (1-100)                            |
| `include_codes`         | `string[]`   | `[]`       | Only include videos with these series codes                    |
| `exclude_codes`         | `string[]`   | `[]`       | Exclude videos with these series codes                         |
| `include_episodes`      | `string[]`   | `[]`       | Only include specific episode numbers                          |
| `include_episode_range` | `[int, int]` | `null`     | Episode range `[min, max]`                                     |
| `exclude_ids`           | `string[]`   | `[]`       | Exclude specific video IDs (e.g., already watched)             |
| `limit_to_ids`          | `string[]`   | `null`     | **Restrict search to only these video IDs** (page-loaded mode) |
| `diversity_factor`      | `float`      | `0.3`      | 0 = relevance only, 1 = maximum diversity                      |
| `max_per_code`          | `int`        | `null`     | Max results per series code (for diversity)                    |

---

## 6. User Preferences

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

## Topic Representative Docs

| Field                 | Type        | Description                                                                                         |
| --------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `representative_docs` | `List[str]` | Multiple representative document snippets, sorted by representativeness (most representative first) |
| `size`                | `int`       | Total number of documents in this topic                                                             |

**Example:**

```json
{
  "topic_id": 0,
  "name": "0_actress_drama_beautiful",
  "keywords": ["actress", "drama", "beautiful"],
  "size": 45,
  "representative_docs": [
    "Most representative document...",
    "Second most representative document...",
    "Third most representative document..."
  ]
}
```

> **Tip:** After running `POST /api/analysis/topics`, use `GET /api/analysis/topics` to browse cached results sorted by size (largest first) without re-extracting.
