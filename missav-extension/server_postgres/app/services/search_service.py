# Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server_postgres/app/services/search_service.py
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
            db_filters["thumbnail"] = {"$not_null": True}
        else:
            db_filters["thumbnail"] = None

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

            # Use Raw SQL for Metadata Mode to support custom ORDER BY
            from jet.db.postgres.managers.filter_builder import FilterBuilder
            from psycopg import sql

            where_clause, where_params = FilterBuilder.build(db_filters)

            with self.client.conn.cursor() as cur:
                # Get columns dynamically
                cur.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = %s AND column_name != 'embedding';",
                    (self.table_name,),
                )
                cols = [r["column_name"] for r in cur.fetchall()]

                if not cols:
                    return []

                select_cols = sql.SQL(", ").join(map(sql.Identifier, cols))

                # Build the query using psycopg.sql for safety
                query = sql.SQL("SELECT {} FROM {}{}").format(
                    select_cols, sql.Identifier(self.table_name), where_clause
                )

                # Add Order By
                order_col = (
                    request.sort_by
                    if request.sort_by in ["release_date", "id", "created_at"]
                    else "release_date"
                )
                query = sql.SQL("{} ORDER BY {} DESC").format(
                    query, sql.Identifier(order_col)
                )

                # Add Limit with a placeholder
                query = sql.SQL("{} LIMIT %s").format(query)

                # Combine filter params + limit param
                final_params = where_params + [request.limit]

                cur.execute(query, final_params)
                return [dict(row) for row in cur.fetchall()]

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
