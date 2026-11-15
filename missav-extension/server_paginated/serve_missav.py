"""
Video Search API (FastAPI + psycopg 3 + pgvector).
Target Table: public.videos
Endpoints:
  POST /search     semantic search + filters + cursor pagination
  POST /similar    similar-to-video (reuses stored embedding)
  POST /hybrid     FTS + vector RRF hybrid
  GET  /browse     plain listing (release_date / created_at)
  GET  /videos/{id}
  GET  /facets
  GET  /health
"""

import base64
import hashlib
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime
from functools import lru_cache
from typing import List, Literal, Optional, Tuple

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
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
    try:
        with pool.connection() as conn:
            res = conn.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'videos'
                ) AS exists;
            """).fetchone()
            if not res or not res.get("exists"):
                raise Exception("Table 'public.videos' not found.")
            count = (
                conn.execute("SELECT COUNT(*) AS count FROM public.videos")
                .fetchone()
                .get("count", 0)
            )
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for production
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(20, ge=1, le=100)
    cursor: Optional[str] = None
    genre: Optional[str] = None
    genres: Optional[List[str]] = None
    genres_mode: Literal["any", "all"] = "any"
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    code: Optional[str] = None
    min_similarity: Optional[float] = Field(None, ge=0.0, le=1.0)


class SimilarRequest(BaseModel):
    video_id: str
    limit: int = Field(20, ge=1, le=100)
    cursor: Optional[str] = None
    genres: Optional[List[str]] = None
    genres_mode: Literal["any", "all"] = "any"


class HybridRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(20, ge=1, le=100)
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    genres: Optional[List[str]] = None


class VideoItem(BaseModel):
    id: str
    title: Optional[str]
    details: Optional[str]
    code: str
    episode: str
    url: str
    preview: Optional[str]
    thumbnail: Optional[str]
    release_date: Optional[datetime]
    genres: Optional[List[str]]
    similarity: Optional[float] = None


class SearchResponse(BaseModel):
    items: List[VideoItem]
    next_cursor: Optional[str]
    has_more: bool
    took_ms: float


class FacetsResponse(BaseModel):
    genres: List[dict]  # [{name, count}]
    codes: List[dict]  # [{code, count}]
    years: List[dict]  # [{year, count}]


# --------------------------------------------------------------------------- #
# Cursor helpers
# --------------------------------------------------------------------------- #
def _fingerprint(req: SearchRequest) -> str:
    genre_str = sorted(req.genres) if req.genres else req.genre
    filter_str = "|".join(
        str(x)
        for x in [
            req.query,
            genre_str,
            req.genres_mode,
            req.code,
            req.min_release_date,
            req.max_release_date,
            req.min_similarity,
        ]
    )
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
        raise HTTPException(status_code=400, detail="Invalid cursor")
    if data.get("f") != fp:
        raise HTTPException(status_code=400, detail="Cursor does not match filters")
    return distance, last_id


@lru_cache(maxsize=256)
def _embed_query(text: str) -> tuple:
    logger.info("Embedding query (cache miss): %r", text)
    return tuple(
        embed(text=text, model=EMBED_MODEL, return_format="list", show_progress=False)
    )


def _row_to_item(r: dict, similarity: Optional[float] = None) -> VideoItem:
    if similarity is None and r.get("distance") is not None:
        similarity = 1.0 - r["distance"]
    return VideoItem(
        id=r["id"],
        title=r["title"],
        details=r["details"],
        code=r["code"],
        episode=r["episode"],
        url=r["url"],
        preview=r["preview"],
        thumbnail=r["thumbnail"],
        release_date=r["release_date"],
        genres=r["genres"],
        similarity=similarity,
    )


def _apply_filters(req, params: dict, conds: List[str]) -> None:
    if req.genre:
        conds.append("%(genre)s = ANY(genres)")
        params["genre"] = req.genre
    if req.genres:
        op = "@>" if getattr(req, "genres_mode", "any") == "all" else "&&"
        conds.append(f"genres {op} %(genres)s::text[]")
        params["genres"] = req.genres
    if getattr(req, "code", None):
        conds.append("code = %(code)s")
        params["code"] = req.code
    if getattr(req, "min_release_date", None):
        conds.append("release_date >= %(min_release_date)s")
        params["min_release_date"] = req.min_release_date
    if getattr(req, "max_release_date", None):
        conds.append("release_date <= %(max_release_date)s")
        params["max_release_date"] = req.max_release_date


# --------------------------------------------------------------------------- #
# /search
# --------------------------------------------------------------------------- #
@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    t0 = time.perf_counter()
    fp = _fingerprint(req)
    position = decode_cursor(req.cursor, fp) if req.cursor else None
    emb = list(_embed_query(req.query))

    params: dict = {"emb": emb, "limit": req.limit + 1}
    conds: List[str] = []
    _apply_filters(req, params, conds)

    if position:
        dist_val, id_val = position
        conds.append(
            "((embedding <=> %(emb)s::vector), id) > (%(last_dist)s::float8, %(last_id)s)"
        )
        params["last_dist"] = dist_val
        params["last_id"] = id_val

    if req.min_similarity is not None:
        conds.append("(embedding <=> %(emb)s::vector) <= %(max_dist)s")
        params["max_dist"] = 1.0 - req.min_similarity

    where_sql = " AND ".join(conds) if conds else "TRUE"
    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview,
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
        logger.error("DB error: %s", e)
        raise HTTPException(500, f"Search failed: {e}")

    has_more = len(rows) > req.limit
    rows = rows[: req.limit]
    next_cursor = (
        encode_cursor(rows[-1]["distance"], rows[-1]["id"], fp)
        if has_more and rows
        else None
    )
    took = (time.perf_counter() - t0) * 1000
    logger.info("search ok n=%d more=%s %.1fms", len(rows), has_more, took)
    return SearchResponse(
        items=[_row_to_item(r) for r in rows],
        next_cursor=next_cursor,
        has_more=has_more,
        took_ms=took,
    )


# --------------------------------------------------------------------------- #
# /similar
# --------------------------------------------------------------------------- #
@app.post("/similar", response_model=SearchResponse)
def similar(req: SimilarRequest) -> SearchResponse:
    t0 = time.perf_counter()
    with pool.connection() as conn:
        src = conn.execute(
            "SELECT embedding FROM public.videos WHERE id = %s", (req.video_id,)
        ).fetchone()
    if not src or src["embedding"] is None:
        raise HTTPException(404, "Source video or embedding not found")

    emb = list(src["embedding"])
    # Reuse cursor machinery with a synthetic SearchRequest fingerprint.
    synthetic = SearchRequest(
        query=f"__similar__:{req.video_id}",
        genres=req.genres,
        genres_mode=req.genres_mode,
    )
    fp = _fingerprint(synthetic)
    position = decode_cursor(req.cursor, fp) if req.cursor else None

    params: dict = {"emb": emb, "limit": req.limit + 1}
    conds: List[str] = ["id <> %(src)s"]
    params["src"] = req.video_id
    _apply_filters(synthetic, params, conds)

    if position:
        conds.append(
            "((embedding <=> %(emb)s::vector), id) > (%(last_dist)s::float8, %(last_id)s)"
        )
        params["last_dist"], params["last_id"] = position

    where_sql = " AND ".join(conds)
    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview, embedding <=> %(emb)s::vector AS distance
        FROM public.videos
        WHERE {where_sql}
        ORDER BY embedding <=> %(emb)s::vector, id
        LIMIT %(limit)s
    """
    with pool.connection() as conn:
        if ITERATIVE_SCAN_MODE:
            conn.execute(f"SET LOCAL hnsw.iterative_scan = {ITERATIVE_SCAN_MODE}")
            conn.execute(f"SET LOCAL hnsw.max_scan_tuples = {int(MAX_SCAN_TUPLES)}")
        rows = conn.execute(sql, params).fetchall()

    has_more = len(rows) > req.limit
    rows = rows[: req.limit]
    next_cursor = (
        encode_cursor(rows[-1]["distance"], rows[-1]["id"], fp)
        if has_more and rows
        else None
    )
    took = (time.perf_counter() - t0) * 1000
    return SearchResponse(
        items=[_row_to_item(r) for r in rows],
        next_cursor=next_cursor,
        has_more=has_more,
        took_ms=took,
    )


# --------------------------------------------------------------------------- #
# /hybrid  (FTS + vector reciprocal rank fusion)
# --------------------------------------------------------------------------- #
@app.post("/hybrid", response_model=SearchResponse)
def hybrid(req: HybridRequest) -> SearchResponse:
    t0 = time.perf_counter()
    emb = list(_embed_query(req.query))
    k = 60  # RRF constant
    cand = req.limit * 4

    vec_params: dict = {"emb": emb, "limit": cand}
    vec_conds: List[str] = []
    if req.genres:
        vec_conds.append("genres && %(genres)s::text[]")
        vec_params["genres"] = req.genres
    if req.min_release_date:
        vec_conds.append("release_date >= %(min_release_date)s")
        vec_params["min_release_date"] = req.min_release_date
    if req.max_release_date:
        vec_conds.append("release_date <= %(max_release_date)s")
        vec_params["max_release_date"] = req.max_release_date
    vec_where = " AND ".join(vec_conds) if vec_conds else "TRUE"

    fts_params: dict = {"q": req.query, "limit": cand}
    fts_conds = [
        "title IS NOT NULL",
        "to_tsvector('english', title) @@ plainto_tsquery('english', %(q)s)",
    ]
    if req.genres:
        fts_conds.append("genres && %(genres)s::text[]")
        fts_params["genres"] = req.genres
    if req.min_release_date:
        fts_conds.append("release_date >= %(min_release_date)s")
        fts_params["min_release_date"] = req.min_release_date
    if req.max_release_date:
        fts_conds.append("release_date <= %(max_release_date)s")
        fts_params["max_release_date"] = req.max_release_date
    fts_where = " AND ".join(fts_conds)

    with pool.connection() as conn:
        conn.execute(f"SET LOCAL hnsw.iterative_scan = {ITERATIVE_SCAN_MODE}")
        conn.execute(f"SET LOCAL hnsw.max_scan_tuples = {int(MAX_SCAN_TUPLES)}")

        vec_rows = conn.execute(
            f"""
            SELECT id, title, details, url, code, episode, release_date, genres,
                   thumbnail, preview, embedding <=> %(emb)s::vector AS distance
            FROM public.videos
            WHERE {vec_where}
            ORDER BY embedding <=> %(emb)s::vector, id
            LIMIT %(limit)s
        """,
            vec_params,
        ).fetchall()

        fts_rows = conn.execute(
            f"""
            SELECT id, title, details, url, code, episode, release_date, genres,
                   thumbnail, preview, 0.0 AS distance
            FROM public.videos
            WHERE {fts_where}
            ORDER BY ts_rank_cd(to_tsvector('english', title),
                                plainto_tsquery('english', %(q)s)) DESC,
                     id
            LIMIT %(limit)s
        """,
            fts_params,
        ).fetchall()

    scores: dict = {}
    by_id: dict = {}
    for rank, r in enumerate(vec_rows):
        scores[r["id"]] = scores.get(r["id"], 0) + 1.0 / (k + rank)
        by_id[r["id"]] = r
    for rank, r in enumerate(fts_rows):
        scores[r["id"]] = scores.get(r["id"], 0) + 1.0 / (k + rank)
        by_id.setdefault(r["id"], r)

    ordered = sorted(scores.items(), key=lambda kv: -kv[1])[: req.limit]
    items = [_row_to_item(by_id[v_id], similarity=None) for v_id, _ in ordered]
    took = (time.perf_counter() - t0) * 1000
    return SearchResponse(items=items, next_cursor=None, has_more=False, took_ms=took)


# --------------------------------------------------------------------------- #
# /browse   (no embedding required)
# --------------------------------------------------------------------------- #
@app.get("/browse", response_model=SearchResponse)
def browse(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100_000),
    genre: Optional[str] = None,
    genres: Optional[List[str]] = Query(None),
    code: Optional[str] = None,
    sort: Literal["release_date", "created_at"] = "release_date",
):
    t0 = time.perf_counter()
    params: dict = {"limit": limit, "offset": offset}
    conds: List[str] = []
    if genre:
        conds.append("%(genre)s = ANY(genres)")
        params["genre"] = genre
    if genres:
        conds.append("genres && %(genres)s::text[]")
        params["genres"] = genres
    if code:
        conds.append("code = %(code)s")
        params["code"] = code
    where_sql = " AND ".join(conds) if conds else "TRUE"

    # fetch one extra to compute has_more
    params["limit"] = limit + 1
    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview
        FROM public.videos
        WHERE {where_sql}
        ORDER BY {sort} DESC NULLS LAST, id
        LIMIT %(limit)s OFFSET %(offset)s
    """
    with pool.connection() as conn:
        rows = conn.execute(sql, params).fetchall()

    has_more = len(rows) > limit
    rows = rows[:limit]
    took = (time.perf_counter() - t0) * 1000
    return SearchResponse(
        items=[_row_to_item(r, similarity=None) for r in rows],
        next_cursor=str(offset + limit) if has_more else None,
        has_more=has_more,
        took_ms=took,
    )


# --------------------------------------------------------------------------- #
# /videos/{id}
# --------------------------------------------------------------------------- #
@app.get("/videos/{video_id}", response_model=VideoItem)
def get_video(video_id: str):
    with pool.connection() as conn:
        r = conn.execute(
            """
            SELECT id, title, details, url, code, episode, release_date, genres,
                   thumbnail, preview
            FROM public.videos WHERE id = %s
        """,
            (video_id,),
        ).fetchone()
    if not r:
        raise HTTPException(404, "Video not found")
    return _row_to_item(r, similarity=None)


# --------------------------------------------------------------------------- #
# /facets
# --------------------------------------------------------------------------- #
@app.get("/facets", response_model=FacetsResponse)
def facets(top_genres: int = 60, top_codes: int = 40):
    with pool.connection() as conn:
        genres = conn.execute(
            """
            SELECT g AS name, COUNT(*)::int AS count
            FROM public.videos, unnest(genres) AS g
            WHERE genres IS NOT NULL
            GROUP BY g ORDER BY count DESC NULLS LAST
            LIMIT %s
        """,
            (top_genres,),
        ).fetchall()

        codes = conn.execute(
            """
            SELECT code, COUNT(*)::int AS count
            FROM public.videos GROUP BY code
            ORDER BY count DESC LIMIT %s
        """,
            (top_codes,),
        ).fetchall()

        years = conn.execute("""
            SELECT EXTRACT(YEAR FROM release_date)::int AS year,
                   COUNT(*)::int AS count
            FROM public.videos
            WHERE release_date IS NOT NULL
            GROUP BY 1 ORDER BY 1
        """).fetchall()

    return FacetsResponse(
        genres=[{"name": r["name"], "count": r["count"]} for r in genres],
        codes=[{"code": r["code"], "count": r["count"]} for r in codes],
        years=[{"year": r["year"], "count": r["count"]} for r in years],
    )


# --------------------------------------------------------------------------- #
# /health
# --------------------------------------------------------------------------- #
@app.get("/health")
def health():
    t0 = time.perf_counter()
    with pool.connection() as conn:
        conn.execute("SELECT 1").fetchone()
    return {"ok": True, "db_ms": (time.perf_counter() - t0) * 1000}


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting Video Search Server on http://0.0.0.0:9001")
    uvicorn.run(app, host="0.0.0.0", port=9001, log_level="info")
