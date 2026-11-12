from typing import Any, Dict, List, Optional

from app.config import PG_DB_NAME, PG_HOST, PG_PASSWORD, PG_PORT, PG_USER
from app.models import SearchFilters, SearchRequest
from jet.adapters.llama_cpp.config import EMBED_QUERY_PREFIX
from jet.adapters.llama_cpp.embed_utils import embed
from jet.db.postgres.pgvector import PgVectorClient

_client = None


def get_client() -> PgVectorClient:
    global _client
    if _client is None:
        _client = PgVectorClient(
            dbname=PG_DB_NAME,
            user=PG_USER,
            password=PG_PASSWORD,
            host=PG_HOST,
            port=PG_PORT,
        )
    return _client


def translate_filters(filters: Optional[SearchFilters]) -> Optional[Dict[str, Any]]:
    if not filters:
        return None

    db_filters = {}

    if filters.codes:
        db_filters["code"] = {"$in": filters.codes}

    if filters.genres:
        db_filters["genres"] = {"$contains": filters.genres}

    if filters.date_range:
        d = {}
        if filters.date_range.start:
            d["$gte"] = filters.date_range.start.isoformat()
        if filters.date_range.end:
            d["$lte"] = filters.date_range.end.isoformat()
        if d:
            db_filters["release_date"] = d

    if filters.has_thumbnail is not None:
        if filters.has_thumbnail:
            # Ensure your FilterBuilder supports $not_null or handle it via raw SQL
            db_filters["thumbnail"] = {"$not_null": True}
        else:
            db_filters["thumbnail"] = None  # IS NULL

    return db_filters if db_filters else None


class SearchService:
    def __init__(self):
        self.client = get_client()
        self.table_name = "videos"

    def execute_search(self, request: SearchRequest) -> List[Dict]:
        q = request.query
        queries = [q] if isinstance(q, str) else (q if isinstance(q, list) else [])

        db_filters = translate_filters(request.filters)

        if request.mode == "semantic":
            if not queries:
                raise ValueError("Semantic search requires a query")
            return self.client.multi_query_search(
                self.table_name, queries, request.limit, filters=db_filters
            )

        elif request.mode == "hybrid":
            if not queries:
                raise ValueError("Hybrid search requires a query")
            vec = embed(queries[0], prefix=EMBED_QUERY_PREFIX).tolist()
            text = " ".join(queries)
            return self.client.hybrid_search(
                self.table_name,
                text,
                vec,
                request.limit,
                text_weight=request.keyword_weight,
                vector_weight=(1 - request.keyword_weight),
                filters=db_filters,
            )

        elif request.mode == "metadata":
            if not request.filters:
                raise ValueError("Metadata search requires filters")
            return self.client.get_filtered_rows(
                self.table_name,
                filters=db_filters,
                limit=request.limit,
                order_by=(request.sort_by, "DESC"),
            )

        elif request.mode == "diverse":
            if not queries:
                raise ValueError("Diverse search requires a query")
            vec = embed(queries[0], prefix=EMBED_QUERY_PREFIX).tolist()
            return self.client.diverse_search(
                self.table_name,
                vec,
                request.limit,
                lambda_mult=request.diversity_level,
                filters=db_filters,
            )

        return []

    def get_related_videos(
        self, video_id: str, limit: int = 5, diverse: bool = True
    ) -> List[Dict]:
        source_emb = self.client.get_embedding_by_id(self.table_name, video_id)
        if source_emb is None:
            return []
        vec = source_emb.tolist()
        if diverse:
            return self.client.diverse_search(
                self.table_name, vec, limit, lambda_mult=0.5
            )
        else:
            return self.client.search(self.table_name, vec, limit)


search_service = SearchService()
