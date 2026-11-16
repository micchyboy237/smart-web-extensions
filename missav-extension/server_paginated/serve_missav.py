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
from typing import List, Literal, Optional, Tuple, Union

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from jet.adapters.llama_cpp.config import (
    EMBED_DOC_PREFIX,
    EMBED_MODEL,
    EMBED_QUERY_PREFIX,
)
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
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Unified type for genre and code inputs
GenreCodeInput = Optional[Union[str, List[str]]]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(20, ge=1, le=100)
    cursor: Optional[str] = None
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    code: GenreCodeInput = None
    min_similarity: Optional[float] = Field(None, ge=0.0, le=1.0)
    sort: Literal["release_date", "created_at", "similarity"] = "similarity"
    order: Literal["asc", "desc"] = "desc"


class SimilarRequest(BaseModel):
    video_id: str
    limit: int = Field(20, ge=1, le=100)
    cursor: Optional[str] = None
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    code: GenreCodeInput = None
    sort: Literal["release_date", "created_at", "similarity"] = "similarity"
    order: Literal["asc", "desc"] = "desc"


class HybridRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(20, ge=1, le=100)
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    genre: GenreCodeInput = None
    code: GenreCodeInput = None
    sort: Literal["release_date", "created_at"] = "release_date"
    order: Literal["asc", "desc"] = "desc"


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
    genres: List[dict]
    codes: List[dict]
    years: List[dict]


class VideoIngestItem(BaseModel):
    id: str
    url: str
    code: str
    episode: str
    video_id: str
    title: Optional[str] = None
    thumbnail: Optional[str] = None
    preview: Optional[str] = None
    details: Optional[str] = None
    release_date: Optional[datetime] = None
    genres: Optional[List[str]] = None


class IngestRequest(BaseModel):
    items: List[VideoIngestItem] = Field(..., min_length=1, max_length=500)
    upsert: bool = True


class IngestResponse(BaseModel):
    inserted: int
    updated: int
    skipped: int
    took_ms: float


def _fingerprint(req: Union[SearchRequest, SimilarRequest, HybridRequest]) -> str:
    # Normalize genre for fingerprinting
    genre_val = req.genre
    if isinstance(genre_val, list):
        genre_str = sorted(genre_val)
    else:
        genre_str = genre_val

    # Normalize code for fingerprinting
    code_val = req.code if hasattr(req, "code") else None
    if isinstance(code_val, list):
        code_str = sorted(code_val)
    else:
        code_str = code_val

    filter_parts = [
        getattr(req, "query", ""),
        genre_str,
        getattr(req, "genres_mode", "any"),
        code_str,
        getattr(req, "min_release_date", None),
        getattr(req, "max_release_date", None),
        getattr(req, "min_similarity", None),
        getattr(req, "sort", None),
        getattr(req, "order", None),
    ]

    filter_str = "|".join(str(x) for x in filter_parts)
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
        embed(
            text=text,
            model=EMBED_MODEL,
            return_format="list",
            show_progress=False,
            prefix=EMBED_QUERY_PREFIX,
        )
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


def _normalize_list_input(val: GenreCodeInput) -> Optional[List[str]]:
    """Converts Optional[str] | Optional[List[str]] to Optional[List[str]]"""
    if val is None:
        return None
    if isinstance(val, str):
        return [val]
    return val


def _apply_filters(req, params: dict, conds: List[str]) -> None:
    # Handle unified genre parameter
    genre_list = _normalize_list_input(getattr(req, "genre", None))
    if genre_list:
        mode = getattr(req, "genres_mode", "any")
        op = "@>" if mode == "all" else "&&"
        conds.append(f"genres {op} %(genres)s::text[]")
        params["genres"] = genre_list

    # Handle unified code parameter
    code_list = _normalize_list_input(getattr(req, "code", None))
    if code_list:
        if len(code_list) == 1:
            conds.append("code = %(code)s")
            params["code"] = code_list[0]
        else:
            conds.append("code = ANY(%(codes)s)")
            params["codes"] = code_list

    if getattr(req, "min_release_date", None):
        conds.append("release_date >= %(min_release_date)s")
        params["min_release_date"] = req.min_release_date
    if getattr(req, "max_release_date", None):
        conds.append("release_date <= %(max_release_date)s")
        params["max_release_date"] = req.max_release_date


def _build_order_clause(
    sort_col: str,
    order_dir: str,
    has_distance: bool = False,
    distance_sql: str = "distance",
) -> str:
    """
    Builds a safe ORDER BY clause.

    PostgreSQL forbids using a SELECT-list output alias inside an expression
    (e.g. `CASE WHEN TRUE THEN distance END` raises:
        column "distance" does not exist).
    So for similarity sorts we substitute the raw distance expression
    (e.g. `(embedding <=> %(emb)s::vector)`) instead of the alias `distance`.
    """
    safe_cols = {
        "release_date": "release_date",
        "created_at": "created_at",
    }

    if sort_col == "similarity":
        # Use the raw expression, never the alias.
        col = distance_sql
        # Cosine distance: smaller = closer. So "closest first" (user-facing
        # desc) maps to SQL ASC, and vice versa.
        actual_dir = "ASC" if order_dir == "desc" else "DESC"
    else:
        col = safe_cols.get(sort_col, "release_date")
        actual_dir = order_dir.upper()

    return f"ORDER BY {col} {actual_dir}, id ASC"


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

    if req.sort == "release_date":
        conds.append("release_date IS NOT NULL")

    where_sql = " AND ".join(conds) if conds else "TRUE"

    order_clause = _build_order_clause(
        req.sort,
        req.order,
        has_distance=True,
        distance_sql="(embedding <=> %(emb)s::vector)",
    )

    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview,
               embedding <=> %(emb)s::vector AS distance
        FROM public.videos
        WHERE {where_sql}
        {order_clause}
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

    class SyntheticReq:
        def __init__(self, source_req):
            self.genre = source_req.genre
            self.genres_mode = source_req.genres_mode
            self.code = source_req.code
            self.min_release_date = None
            self.max_release_date = None
            self.sort = source_req.sort
            self.order = source_req.order

    synthetic = SyntheticReq(req)
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

    if req.sort == "release_date":
        conds.append("release_date IS NOT NULL")

    where_sql = " AND ".join(conds)

    order_clause = _build_order_clause(
        req.sort,
        req.order,
        has_distance=True,
        distance_sql="(embedding <=> %(emb)s::vector)",
    )

    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview, embedding <=> %(emb)s::vector AS distance
        FROM public.videos
        WHERE {where_sql}
        {order_clause}
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


@app.post("/hybrid", response_model=SearchResponse)
def hybrid(req: HybridRequest) -> SearchResponse:
    t0 = time.perf_counter()
    emb = list(_embed_query(req.query))
    k = 60
    cand = req.limit * 4

    # Vector Search Part
    vec_params: dict = {"emb": emb, "limit": cand}
    vec_conds: List[str] = []

    # Apply filters to vector search
    class VecReq:
        def __init__(self, source_req):
            self.genre = source_req.genre
            self.genres_mode = "any"  # Hybrid usually uses any for broader recall
            self.code = source_req.code
            self.min_release_date = source_req.min_release_date
            self.max_release_date = source_req.max_release_date

    vec_req = VecReq(req)
    _apply_filters(vec_req, vec_params, vec_conds)

    vec_where = " AND ".join(vec_conds) if vec_conds else "TRUE"

    # FTS Search Part
    fts_params: dict = {"q": req.query, "limit": cand}
    fts_conds = [
        "title IS NOT NULL",
        "to_tsvector('english', title) @@ plainto_tsquery('english', %(q)s)",
    ]

    # Apply filters to FTS search
    _apply_filters(vec_req, fts_params, fts_conds)

    fts_where = " AND ".join(fts_conds)

    # Determine sort for final ranking?
    # Hybrid usually ranks by RRF score, but we can sort the candidates before RRF if needed.
    # For simplicity, we keep the internal sorts as default (distance/rank) and let RRF handle final order.

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


@app.get("/browse", response_model=SearchResponse)
def browse(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100_000),
    genre: GenreCodeInput = None,
    genres_mode: Literal["any", "all"] = "any",
    code: GenreCodeInput = None,
    sort: Literal["release_date", "created_at"] = "release_date",
    order: Literal["asc", "desc"] = "desc",
):
    t0 = time.perf_counter()

    class BrowseReq:
        def __init__(self):
            self.genre = genre
            self.genres_mode = genres_mode
            self.code = code
            self.min_release_date = None
            self.max_release_date = None

    req_obj = BrowseReq()
    params: dict = {"limit": limit + 1, "offset": offset}
    conds: List[str] = []
    _apply_filters(req_obj, params, conds)

    if sort == "release_date":
        conds.append("release_date IS NOT NULL")

    where_sql = " AND ".join(conds) if conds else "TRUE"

    # No embedding here — sort is date-only.
    order_clause = _build_order_clause(sort, order)

    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview
        FROM public.videos
        WHERE {where_sql}
        {order_clause}
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


@app.get("/facets/codes")
def facets_codes():
    with pool.connection() as conn:
        codes = conn.execute(
            """
            SELECT code, COUNT(*)::int AS count
            FROM public.videos 
            WHERE code IS NOT NULL
            GROUP BY code 
            ORDER BY count DESC
        """
        ).fetchall()

    return {
        "code_count": len(codes),
        "codes": [{"code": r["code"], "count": r["count"]} for r in codes],
    }


@app.get("/health")
def health():
    t0 = time.perf_counter()
    with pool.connection() as conn:
        conn.execute("SELECT 1").fetchone()
    return {"ok": True, "db_ms": (time.perf_counter() - t0) * 1000}


def _embed_text_for(item: VideoIngestItem) -> Optional[str]:
    txt = item.title or item.details
    if not txt:
        return None
    return txt


def _format_for_embedding(item: VideoIngestItem) -> Optional[str]:
    """Build the embedding text exactly as migrate_chroma_to_postgres.py does.
    Returns None if there is nothing meaningful to embed.
    """
    parts: List[str] = []
    if item.title:
        parts.append(item.title)
    if item.details:
        parts.append(item.details)
    if item.code:
        parts.append(f"Series: {item.code}")
    if item.episode:
        parts.append(f"Episode: {item.episode}")
    if item.genres:
        parts.append(f"Genres: {', '.join(item.genres)}")
    text = " | ".join(parts).strip()
    return text or None


_INGEST_COLS = [
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
    "embedding",
]


@app.post("/ingest", response_model=IngestResponse)
def ingest(req: IngestRequest) -> IngestResponse:
    """Insert or upsert rows into public.videos.
    Embeddings are ALWAYS regenerated server-side from the item fields using
    the same format as the ChromaDB migration script, so ingested rows are
    comparable with migrated rows for semantic search.
    """
    t0 = time.perf_counter()
    inserted = updated = skipped = 0
    embeddable: List[Tuple[int, VideoIngestItem, str]] = []

    for idx, item in enumerate(req.items):
        text = _format_for_embedding(item)
        if text is None:
            skipped += 1
            continue
        embeddable.append((idx, item, text))

    if not embeddable:
        return IngestResponse(
            inserted=0,
            updated=0,
            skipped=skipped,
            took_ms=(time.perf_counter() - t0) * 1000,
        )

    texts = [t for _, _, t in embeddable]
    logger.info("Generating embeddings for %d ingest items...", len(texts))
    embeddings = embed(texts, return_format="list", prefix=EMBED_DOC_PREFIX)

    rows: List[tuple] = []
    for (_, item, _), emb in zip(embeddable, embeddings):
        rows.append(
            (
                item.id,
                item.url,
                item.code,
                item.episode,
                item.video_id,
                item.title,
                item.thumbnail,
                item.preview,
                item.details,
                item.release_date,
                item.genres,
                emb,
            )
        )

    placeholders = ", ".join(
        "(" + ", ".join(["%s"] * len(_INGEST_COLS)) + ")" for _ in rows
    )
    flat_params: List = [v for r in rows for v in r]

    on_conflict = (
        f"""ON CONFLICT (id) DO UPDATE SET
            url          = EXCLUDED.url,
            code         = EXCLUDED.code,
            episode      = EXCLUDED.episode,
            video_id     = EXCLUDED.video_id,
            title        = COALESCE(EXCLUDED.title,       videos.title),
            thumbnail    = COALESCE(EXCLUDED.thumbnail,   videos.thumbnail),
            preview      = COALESCE(EXCLUDED.preview,     videos.preview),
            details      = COALESCE(EXCLUDED.details,     videos.details),
            release_date = COALESCE(EXCLUDED.release_date, videos.release_date),
            genres       = COALESCE(EXCLUDED.genres,      videos.genres),
            embedding    = EXCLUDED.embedding,
            updated_at   = now()
        RETURNING (xmax = 0) AS inserted"""
        if req.upsert
        else "ON CONFLICT (id) DO NOTHING RETURNING false AS inserted"
    )

    sql = f"""
        INSERT INTO public.videos ({", ".join(_INGEST_COLS)})
        VALUES {placeholders}
        {on_conflict}
    """

    try:
        with pool.connection() as conn:
            register_vector(conn)
            with conn.transaction():
                cur = conn.execute(sql, flat_params)
                for row in cur.fetchall():
                    if row["inserted"]:
                        inserted += 1
                    else:
                        updated += 1
                skipped += len(rows) - inserted - updated
    except Exception as e:
        logger.exception("Ingest failed")
        raise HTTPException(500, f"Ingest failed: {e}")

    took = (time.perf_counter() - t0) * 1000
    logger.info(
        "ingest ok ins=%d upd=%d skip=%d %.1fms",
        inserted,
        updated,
        skipped,
        took,
    )
    return IngestResponse(
        inserted=inserted,
        updated=updated,
        skipped=skipped,
        took_ms=took,
    )


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting Video Search Server on http://0.0.0.0:9001")
    uvicorn.run(app, host="0.0.0.0", port=9001, log_level="info")
