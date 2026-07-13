## New HTML Web Endpoints (Full URLs)

| Method  | Full URL                                             | Purpose          | Key Features                                                                          |
| ------- | ---------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| **GET** | `http://localhost:8000/web`                          | Dashboard        | Overview stats (total videos, topics, avg score) + quick search form                  |
| **GET** | `http://localhost:8000/web/search`                   | Search Page      | Full smart search with filter sidebar (search type, diversity, codes, pagination)     |
| **GET** | `http://localhost:8000/web/search-results?query=...` | Search Results   | HTMX partial — renders results as cards with scores, diversity indicators, and timing |
| **GET** | `http://localhost:8000/web/videos`                   | Video Library    | Paginated video browser (24 per page default)                                         |
| **GET** | `http://localhost:8000/web/videos/{video_id}`        | Video Detail     | Single video view (placeholder — ready for detail template)                           |
| **GET** | `http://localhost:8000/web/topics`                   | Topic Explorer   | Topic discovery page (ready for BERTopic integration)                                 |
| **GET** | `http://localhost:8000/web/preferences`              | User Preferences | Manage favorite codes, blocked codes, watched IDs, diversity preference               |

### Example URLs with Query Parameters

| Full URL                                                                                                                   | Description                       |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `http://localhost:8000/web/search-results?query=popular+juq+videos&search_type=hybrid&top_k=20&diversity_factor=0.3`       | Hybrid search with diversity      |
| `http://localhost:8000/web/search-results?query=new+content&include_codes=juq,mxgs&exclude_codes=fc2&diversity_factor=0.6` | Filtered search with exclusions   |
| `http://localhost:8000/web/videos?page=1&per_page=24`                                                                      | Video library page 1              |
| `http://localhost:8000/web/videos?page=2&per_page=48`                                                                      | Video library page 2, 48 per page |
| `http://localhost:8000/web/videos/juq-373`                                                                                 | Single video detail               |
