"""
Video Search API with Metadata Filtering (FastAPI + psycopg 3 + pgvector).
Target Table: public.videos
"""

import base64
import hashlib
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime
from functools import lru_cache
from typing import List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from jet.adapters.llama_cpp.config import EMBED_MODEL
from jet.adapters.llama_cpp.embed_utils import embed, shutdown_embed_pool
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger("video_search_api")

DB_CONNINFO = "dbname=missav_db1 user=jethroestrada host=localhost port=5432"
ITERATIVE_SCAN_MODE: Optional[str] = "strict_order"
MAX_SCAN_TUPLES = 20000


# ---------- DB pool ----------
def _configure(conn) -> None:
    register_vector(conn)
    conn.commit()


pool = ConnectionPool(
    DB_CONNINFO,
    min_size=1,
    max_size=10,
    open=False,
    configure=_configure,
    kwargs={"row_factory": dict_row},
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool.open(wait=True)
    logger.info("DB pool opened")

    # Startup Verification
    try:
        with pool.connection() as conn:
            # Check if table exists using named column access for dict_row
            res = conn.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_name = 'videos'
                ) AS exists;
            """).fetchone()

            # Access by key because we use dict_row
            if not res or not res.get("exists"):
                raise Exception(
                    "Table 'public.videos' not found. Please check your schema."
                )

            # Check row count
            count_res = conn.execute(
                "SELECT COUNT(*) AS count FROM public.videos"
            ).fetchone()
            count = count_res.get("count", 0)
            logger.info(f"Verified: public.videos exists with {count} rows.")

    except Exception as e:
        logger.error("Startup verification failed: %s", e)
        pool.close()
        raise e

    yield
    pool.close()
    shutdown_embed_pool()
    logger.info("DB pool and embed pool closed")


app = FastAPI(title="Video Semantic Search", lifespan=lifespan)


# ---------- Schemas ----------
class SearchRequest(BaseModel):
    query: str = Field(min_length=1, description="Semantic search query")
    limit: int = Field(10, ge=1, le=100)
    cursor: Optional[str] = None

    # Metadata Filters
    genre: Optional[str] = None  # Single genre filter
    genres: Optional[List[str]] = None  # Multiple genre filter (OR logic)
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    code: Optional[str] = None  # Exact match for video code


class VideoItem(BaseModel):
    id: str
    title: Optional[str]
    code: str
    episode: str
    release_date: Optional[datetime]
    genres: Optional[List[str]]
    thumbnail: Optional[str]
    similarity: float


class SearchResponse(BaseModel):
    items: List[VideoItem]
    next_cursor: Optional[str]
    has_more: bool


# ---------- Cursor helpers ----------
def _fingerprint(req: SearchRequest) -> str:
    """Create a unique fingerprint for the search configuration."""
    # Sort lists to ensure consistent fingerprint regardless of order
    genre_str = sorted(req.genres) if req.genres else req.genre
    filter_str = f"{req.query}|{genre_str}|{req.code}|{req.min_release_date}|{req.max_release_date}"
    return hashlib.sha256(filter_str.encode()).hexdigest()[:12]


def encode_cursor(distance: float, last_id: str, fp: str) -> str:
    raw = json.dumps({"d": distance, "i": last_id, "f": fp}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode()


def decode_cursor(cursor: str, fp: str) -> Tuple[float, str]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        distance = float(data["d"])
        last_id = str(data["i"])
    except Exception:
        logger.warning("Rejected undecodable cursor")
        raise HTTPException(status_code=400, detail="Invalid cursor")

    if data.get("f") != fp:
        logger.warning("Rejected cursor from different search context")
        raise HTTPException(
            status_code=400, detail="Cursor does not match current filters"
        )

    return distance, last_id


# ---------- Embedding ----------
@lru_cache(maxsize=256)
def _embed_query(text: str) -> tuple:
    logger.info("Embedding query (cache miss): %r", text)
    return tuple(
        embed(text=text, model=EMBED_MODEL, return_format="list", show_progress=False)
    )


# ---------- Endpoint ----------
@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    t0 = time.perf_counter()
    fp = _fingerprint(req)
    position = decode_cursor(req.cursor, fp) if req.cursor else None
    emb = list(_embed_query(req.query))

    params: dict = {"emb": emb, "limit": req.limit + 1}
    conditions: List[str] = []

    # 1. Pagination Condition (Keyset)
    if position:
        dist_val, id_val = position
        conditions.append(
            "((embedding <=> %(emb)s::vector), id) > (%(last_dist)s::float8, %(last_id)s)"
        )
        params["last_dist"] = dist_val
        params["last_id"] = id_val

    # 2. Metadata Filters

    # Genre Filter (Native TEXT[] Array)
    if req.genre:
        # Single genre exact match within array
        conditions.append("%(genre)s = ANY(genres)")
        params["genre"] = req.genre

    if req.genres:
        # Multiple genres: Overlap operator (&&) finds rows with ANY of the tags
        conditions.append("genres && %(genres)s::text[]")
        params["genres"] = req.genres

    # Code Filter (Exact Match)
    if req.code:
        conditions.append("code = %(code)s")
        params["code"] = req.code

    # Release Date Range
    if req.min_release_date:
        conditions.append("release_date >= %(min_release_date)s")
        params["min_release_date"] = req.min_release_date

    if req.max_release_date:
        conditions.append("release_date <= %(max_release_date)s")
        params["max_release_date"] = req.max_release_date

    where_sql = " AND ".join(conditions) if conditions else "TRUE"

    sql = f"""
        SELECT id, title, code, episode, release_date, genres, thumbnail,
               embedding <=> %(emb)s::vector AS distance
        FROM public.videos
        WHERE {where_sql}
        ORDER BY embedding <=> %(emb)s::vector, id
        LIMIT %(limit)s
    """

    try:
        with pool.connection() as conn:
            if ITERATIVE_SCAN_MODE:
                conn.execute(f"SET LOCAL hnsw.iterative_scan = {ITERATIVE_SCAN_MODE}")
                conn.execute(f"SET LOCAL hnsw.max_scan_tuples = {int(MAX_SCAN_TUPLES)}")

            rows = conn.execute(sql, params).fetchall()
    except Exception as e:
        logger.error("Database error: %s", e)
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

    has_more = len(rows) > req.limit
    rows = rows[: req.limit]

    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        next_cursor = encode_cursor(last["distance"], last["id"], fp)

    items = [
        VideoItem(
            id=r["id"],
            title=r["title"],
            code=r["code"],
            episode=r["episode"],
            release_date=r["release_date"],
            genres=r["genres"],
            thumbnail=r["thumbnail"],
            similarity=1.0 - r["distance"],
        )
        for r in rows
    ]

    logger.info(
        "search ok: returned=%d has_more=%s took=%.1fms",
        len(items),
        has_more,
        (time.perf_counter() - t0) * 1000,
    )

    return SearchResponse(items=items, next_cursor=next_cursor, has_more=has_more)


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting Video Search Server on http://0.0.0.0:9001")
    uvicorn.run(app, host="0.0.0.0", port=9001, log_level="info")
