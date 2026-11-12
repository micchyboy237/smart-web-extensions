### Usage Examples

#### 1. Semantic Search (Simple)

```bash
curl -X POST "http://localhost:8000/search/smart" \
     -H "Content-Type: application/json" \
     -d '{
           "mode": "semantic",
           "query": "summer beach vibes",
           "limit": 5
         }'
```

#### 2. Semantic Search (Multi-Query)

```bash
curl -X POST "http://localhost:8000/search/smart" \
     -H "Content-Type: application/json" \
     -d '{
           "mode": "semantic",
           "query": ["beach", "outdoor", "sun"],
           "limit": 5
         }'
```

#### 3. Hybrid Search (Tunable)

```bash
curl -X POST "http://localhost:8000/search/smart" \
     -H "Content-Type: application/json" \
     -d '{
           "mode": "hybrid",
           "query": "SSIS-123 office lady",
           "keyword_weight": 0.7,
           "limit": 5
         }'
```

#### 4. Metadata Browsing

```bash
curl -X POST "http://localhost:8000/search/smart" \
     -H "Content-Type: application/json" \
     -d '{
           "mode": "metadata",
           "filters": {
             "codes": ["SSIS-100", "ABP-200"],
             "date_range": { "start": "2023-01-01T00:00:00Z" }
           },
           "sort_by": "release_date",
           "limit": 10
         }'
```

#### 5. Diverse Discovery

```bash
curl -X POST "http://localhost:8000/search/smart" \
     -H "Content-Type: application/json" \
     -d '{
           "mode": "diverse",
           "query": "action",
           "diversity_level": 0.6,
           "limit": 5
         }'
```

#### 6. Complex Filtered Search

```bash
curl -X POST "http://localhost:8000/search/smart" \
     -H "Content-Type: application/json" \
     -d '{
           "mode": "semantic",
           "query": "romantic",
           "filters": {
             "genres": ["Romance"],
             "has_thumbnail": true,
             "date_range": { "start": "2024-01-01T00:00:00Z" }
           },
           "limit": 5
         }'
```

This flattened structure is much more intuitive. The `mode` field acts as a clear switch, and all other parameters are available at the top level, making it easy to mix and match features like `query` + `filters` + `diversity_level`.
