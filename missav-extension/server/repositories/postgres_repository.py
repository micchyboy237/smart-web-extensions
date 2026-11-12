"""PostgreSQL repository for video storage and search."""

import logging
from typing import Any, Dict, List, Optional

import numpy as np
from jet.adapters.llama_cpp.config import EMBED_DIMS
from jet.db.postgres.config import (
    DEFAULT_HOST,
    DEFAULT_PASSWORD,
    DEFAULT_PORT,
    DEFAULT_USER,
)
from jet.db.postgres.pgvector import PgVectorClient
from models.internal import (
    EmbeddingsResult,
    PaginatedResult,
    SearchMatch,
    Video,
    VideoRow,
)

logger = logging.getLogger(__name__)

PG_DB_NAME = "missav_db1"
PG_USER = DEFAULT_USER
PG_PASSWORD = DEFAULT_PASSWORD
PG_HOST = DEFAULT_HOST
PG_PORT = DEFAULT_PORT

# Define columns explicitly to avoid fetching embeddings unnecessarily
VIDEO_COLUMNS = [
    "id",
    "url",
    "code",
    "episode",
    "video_id",
    "title",
    "thumbnail",
    "preview",
    "details",
    "release_date",
    "genres",
    "created_at",
    "updated_at",
]
VIDEO_SELECT_CLAUSE = ", ".join(VIDEO_COLUMNS)


class PostgresVideoRepository:
    """Thin wrapper around PgVectorClient for video operations."""

    def __init__(
        self,
        table_name: str = "videos",
    ):
        self.table_name = table_name
        self.dimension = EMBED_DIMS
        try:
            self.client = PgVectorClient(
                dbname=PG_DB_NAME,
                user=PG_USER,
                password=PG_PASSWORD,
                host=PG_HOST,
                port=PG_PORT,
            )
            additional_columns = {
                "url": "TEXT NOT NULL",
                "code": "TEXT NOT NULL",
                "episode": "TEXT NOT NULL",
                "video_id": "TEXT NOT NULL",
                "title": "TEXT",
                "thumbnail": "TEXT",
                "preview": "TEXT",
                "details": "TEXT",
                "release_date": "TIMESTAMPTZ",
                "genres": "JSONB",
            }
            self.client.create_vector_table(
                table_name=self.table_name,
                dimension=self.dimension,
                additional_columns=additional_columns,
                include_timestamps=True,
            )
            logger.info(f"✅ [PostgresRepository] Connected to table: {table_name}")
        except Exception as e:
            logger.error(f"❌ [PostgresRepository] Initialization failed: {e}")
            raise

    def get_by_id(self, video_id: str) -> Optional[Video]:
        """Fetch a single record by ID, excluding embedding."""
        query = f"SELECT {VIDEO_SELECT_CLAUSE} FROM {self.table_name} WHERE id = %s;"
        results = self.client.execute_raw_query(query, (video_id,), fetch_all=False)
        return results if results else None

    def get_by_ids(self, video_ids: List[str]) -> List[Video]:
        """Fetch multiple records by ID, excluding embedding."""
        if not video_ids:
            return []
        query = (
            f"SELECT {VIDEO_SELECT_CLAUSE} FROM {self.table_name} WHERE id = ANY(%s);"
        )
        results = self.client.execute_raw_query(query, (video_ids,), fetch_all=True)
        return results

    def get_all(
        self, where: Optional[Dict] = None, limit: Optional[int] = None, offset: int = 0
    ) -> PaginatedResult:
        """Fetch records with optional filtering and pagination, excluding embedding."""
        base_query = f"SELECT {VIDEO_SELECT_CLAUSE} FROM {self.table_name}"
        count_query = f"SELECT COUNT(*) FROM {self.table_name}"
        params: List[Any] = []
        where_clauses: List[str] = []

        if where:
            for k, v in where.items():
                where_clauses.append(f"{k} = %s")
                params.append(v)

        if where_clauses:
            where_str = " WHERE " + " AND ".join(where_clauses)
            base_query += where_str
            count_query += where_str

        total_result = self.client.execute_raw_query(
            count_query, tuple(params), fetch_all=False
        )
        total = total_result["count"] if total_result else 0

        base_query += " ORDER BY created_at DESC"
        if limit:
            base_query += " LIMIT %s OFFSET %s"
            params.extend([limit, offset])
        else:
            base_query += " OFFSET %s"
            params.append(offset)

        results = self.client.execute_raw_query(
            base_query, tuple(params), fetch_all=True
        )

        return {"records": results, "total": total}

    def get_all_codes(self) -> Dict[str, int]:
        """Aggregate video counts per 'code' field."""
        query = """
            SELECT code, COUNT(*) as count 
            FROM videos 
            WHERE code IS NOT NULL AND code != '' 
            GROUP BY code 
            ORDER BY count DESC
        """
        results = self.client.execute_raw_query(query)
        return {row["code"]: row["count"] for row in results}

    def upsert(self, rows: List[VideoRow]) -> int:
        """Insert or update records. Expects 'embedding' key in each row."""
        if not rows:
            return 0
        inserted = 0
        for row in rows:
            if "id" not in row:
                continue
            try:
                # create_or_update_row handles the embedding column internally
                self.client.create_or_update_row(
                    self.table_name, row, dimension=self.dimension
                )
                inserted += 1
            except Exception as e:
                logger.warning(f"Failed to upsert {row.get('id')}: {e}")
        return inserted

    def query_by_embedding(
        self,
        query_embedding: List[float],
        n_results: int,
        score_threshold: Optional[float] = None,
    ) -> List[SearchMatch]:
        """Vector similarity search."""
        # Note: pgvector search usually returns distance/score.
        # If your client.search implementation allows selecting specific columns,
        # you should exclude embedding there too.
        # If it returns full rows, you might still need to strip it here
        # or update the underlying client method.
        results = self.client.search(
            self.table_name,
            query_embedding=query_embedding,
            top_k=n_results,
            threshold=score_threshold,
        )

        # If client.search returns full rows including embedding, strip it here
        # Otherwise, if it returns only metadata/score, this is fine.
        cleaned_results = []
        for r in results:
            if "embedding" in r:
                del r["embedding"]
            cleaned_results.append(r)

        return [SearchMatch(**r) for r in cleaned_results]

    def get_embeddings(self, ids: List[str]) -> EmbeddingsResult:
        """Fetch stored embedding vectors specifically when needed."""
        raw_data = self.client.get_embeddings(self.table_name, ids)

        if not raw_data:
            return {"ids": [], "vectors": np.array([]).reshape(0, 0)}

        # Sort by input ids to ensure alignment
        sorted_ids = []
        sorted_vectors = []

        for vid in ids:
            if vid in raw_data:
                sorted_ids.append(vid)
                sorted_vectors.append(raw_data[vid])

        if not sorted_vectors:
            return {"ids": [], "vectors": np.array([]).reshape(0, 0)}

        # Create 2D numpy array
        vectors_array = np.array(sorted_vectors, dtype=np.float32)

        # Ensure 2D shape even if only one ID is requested
        if vectors_array.ndim == 1:
            vectors_array = vectors_array.reshape(1, -1)

        return {"ids": sorted_ids, "vectors": vectors_array}

    def count(self, where: Optional[Dict] = None) -> int:
        """Get total count."""
        if where:
            where_clauses: List[str] = []
            params: List[Any] = []
            for k, v in where.items():
                where_clauses.append(f"{k} = %s")
                params.append(v)
            where_str = " WHERE " + " AND ".join(where_clauses)
            query = f"SELECT COUNT(*) FROM {self.table_name}{where_str}"
            result = self.client.execute_raw_query(
                query, tuple(params), fetch_all=False
            )
            return result["count"] if result else 0
        else:
            return self.client.vector.count_embeddings(self.table_name)

    def delete(self, ids: List[str]) -> None:
        """Delete records by ID."""
        if not ids:
            return
        placeholders = ",".join(["%s"] * len(ids))
        query = f"DELETE FROM {self.table_name} WHERE id IN ({placeholders});"
        self.client.execute_raw_query(query, tuple(ids), fetch_all=False)
        logger.info(f"🗑️ [PostgresRepository] Deleted {len(ids)} records")
