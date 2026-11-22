"""
Video Search API (FastAPI + psycopg 3 + pgvector).
Target Table: public.videos

Endpoints:
  POST /search          semantic search + filters + cursor pagination
  POST /search_clustered semantic search + dynamic clustering (cluster_utils)
  POST /similar         similar-to-video (reuses stored embedding)
  POST /hybrid          FTS + vector RRF hybrid
  GET  /browse          plain listing (release_date / created_at)
  GET  /videos/{id}
  GET  /videos
  GET  /facets
  GET  /facets/codes
  GET  /health
  POST /ingest
"""

import base64
import hashlib
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime
from functools import lru_cache
from typing import Annotated, Dict, List, Literal, Optional, Tuple, Union

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from jet.adapters.llama_cpp.chunking_utils import truncate_texts
from jet.adapters.llama_cpp.cluster_utils import TextsClusterer
from jet.adapters.llama_cpp.config import (
    EMBED_DOC_PREFIX,
    EMBED_MODEL,
    EMBED_QUERY_PREFIX,
)
from jet.adapters.llama_cpp.diversity_utils.mmr import mmr_rerank
from jet.adapters.llama_cpp.diversity_utils.semhash import (
    compute_shuffle_fetch_k,
    shuffle_and_diversify,
)
from jet.adapters.llama_cpp.embed_utils import embed, shutdown_embed_pool
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field, model_validator

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger("video_search_api")

DB_CONNINFO = "dbname=missav_db1 user=jethroestrada host=localhost port=5432"
ITERATIVE_SCAN_MODE: Optional[str] = "strict_order"
MAX_SCAN_TUPLES = 20000
INGEST_MAX_TOKENS = 500

# --------------------------------------------------------------------------- #
# /search_clustered caps.
#
# `cluster_candidate_limit` is optional in the request. When omitted, the
# server uses one of these caps depending on whether a query was provided:
#
#   * Query mode: the pool is top-N by cosine distance — the query already
#     narrows the candidates semantically, so a large cap (default 5000) is
#     both useful and fast on the HNSW index.
#
#   * Query-less mode: the pool is a recent/random sample — a large cap
#     gives the clusterer more structure to work with, but "recent 50k" is
#     dominated by the newest ingestion batch and "random 50k" is a full
#     seq scan. 5000 is a stable, bounded default.
#
# Both caps are env-overridable so an operator can tune per deployment
# without touching code. Explicit `cluster_candidate_limit` values are
# clamped to the relevant cap (never exceed it), but a client may ask for
# *fewer* candidates (e.g. for latency).
# --------------------------------------------------------------------------- #
CLUSTER_CANDIDATE_CAP_QUERY = int(os.getenv("CLUSTER_CANDIDATE_CAP_QUERY", "5000"))
CLUSTER_CANDIDATE_CAP_BROWSE = int(os.getenv("CLUSTER_CANDIDATE_CAP_BROWSE", "5000"))

_PREFIX_RE = re.compile(r"^\s*([A-Za-z0-9]+)-\d+\s*[:\-\u2013\u2014]?\s*")


def _strip_code_prefix(text: Optional[str], code: str) -> Optional[str]:
    """
    Remove a leading "<code>-<episode>" prefix from `text` when the embedded
    code matches the row's `code` (case-insensitive).
    Only strips when the code in the text equals the row's code, so unrelated
    leading tokens are left alone. Safe for None / empty inputs.
    """
    if not text or not code:
        return text
    m = _PREFIX_RE.match(text)
    if not m:
        return text
    if m.group(1).lower() != code.lower():
        return text
    return text[m.end() :].lstrip()


def _clean_fields(
    title: Optional[str], details: Optional[str], code: str
) -> Tuple[Optional[str], Optional[str]]:
    """Return (clean_title, clean_details) with any code prefix removed."""
    return (
        _strip_code_prefix(title, code),
        _strip_code_prefix(details, code),
    )


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

GenreCodeInput = Optional[Union[str, List[str]]]
CompletionFilter = Literal["all", "complete", "incomplete"]
VideoSearchMode = Literal["fts", "semantic", "hybrid"]


# --------------------------------------------------------------------------- #
# /search, /similar, /hybrid — request models
# --------------------------------------------------------------------------- #
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
    completion_filter: CompletionFilter = "all"


class SimilarRequest(BaseModel):
    video_id: str
    limit: int = Field(20, ge=1, le=100)
    cursor: Optional[str] = None
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    code: GenreCodeInput = None
    sort: Literal["release_date", "created_at", "similarity"] = "similarity"
    order: Literal["asc", "desc"] = "desc"
    completion_filter: CompletionFilter = "all"


class HybridRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(20, ge=1, le=100)
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    code: GenreCodeInput = None
    sort: Literal["release_date", "created_at"] = "release_date"
    order: Literal["asc", "desc"] = "desc"
    completion_filter: CompletionFilter = "all"


# --------------------------------------------------------------------------- #
# Video model — used by every endpoint.
# The cluster metric fields (probability, silhouette, distance_to_centroid) are
# only populated by /search_clustered; other endpoints leave them None.
# --------------------------------------------------------------------------- #
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
    similarity: Optional[float] = Field(
        None,
        description="Cosine similarity to the query; None when no query was provided.",
    )

    # Cluster metrics — populated by /search_clustered only.
    probability: Optional[float] = Field(
        None,
        ge=0.0,
        le=1.0,
        description="Membership confidence in its cluster (cluster_utils probabilities).",
    )
    silhouette: Optional[float] = Field(
        None,
        ge=-1.0,
        le=1.0,
        description="Per-item silhouette (cluster_utils silhouette_scores).",
    )
    distance_to_centroid: Optional[float] = Field(
        None,
        ge=0.0,
        description="Cosine distance to its cluster centroid (cluster_utils distances_to_centroid).",
    )


class VideoListResponse(BaseModel):
    took_ms: float
    count: int
    items: List[dict]


class SearchResponse(BaseModel):
    items: List[VideoItem]
    next_cursor: Optional[str]
    has_more: bool
    took_ms: float


class FacetsResponse(BaseModel):
    genres: List[dict]
    codes: List[dict]
    years: List[dict]


# --------------------------------------------------------------------------- #
# Ingest models
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
# Clustered search — request
#
# NOTE: `n_clusters` is intentionally absent. The clusterer (TextsClusterer,
# same as cluster_utils.main()) picks k dynamically via HDBSCAN or Spectral
# based on `min_cluster_size` and `cluster_selection_epsilon`, which map 1:1
# to the CLI's `-s / --min-cluster-size` and `-e / --epsilon` flags.
#
# `cluster_candidate_limit` is ALSO optional. When omitted (the recommended
# usage), the server uses CLUSTER_CANDIDATE_CAP_QUERY or
# CLUSTER_CANDIDATE_CAP_BROWSE depending on whether a query was provided.
# Explicit values are clamped to that cap so a client can request fewer
# candidates (for latency) but never more than the deployment allows.
# --------------------------------------------------------------------------- #
class ClusteredSearchRequest(BaseModel):
    query: Optional[str] = Field(
        None,
        min_length=1,
        description=(
            "Optional semantic query. When omitted, candidates are drawn from "
            "the filtered pool via `candidate_source` and clustered by mutual "
            "embedding similarity. When present, candidates are the top-N rows "
            "by cosine distance and `similarity` is populated on each item."
        ),
    )

    # cluster_utils tuning — mirrors the CLI flags.
    min_cluster_size: int = Field(
        2,
        ge=2,
        le=20,
        description="HDBSCAN min_cluster_size (-s / --min-cluster-size).",
    )
    cluster_selection_epsilon: float = Field(
        0.25,
        ge=0.0,
        le=1.0,
        description=(
            "HDBSCAN cluster_selection_epsilon (-e / --epsilon). "
            "Lower = stricter, tighter groups with more noise."
        ),
    )

    # Candidate fetching.
    cluster_candidate_limit: Optional[int] = Field(
        None,
        ge=10,
        le=50_000,
        description=(
            "How many candidate rows to fetch before clustering. "
            "When omitted (recommended), the server uses its configured cap "
            "(CLUSTER_CANDIDATE_CAP_QUERY for query mode, "
            "CLUSTER_CANDIDATE_CAP_BROWSE for query-less mode). "
            "Explicit values are clamped to that cap — a client can request "
            "fewer candidates for latency but never more than the cap."
        ),
    )
    candidate_source: Literal["recent", "random"] = Field(
        "recent",
        description=(
            "Only used when `query` is omitted. 'recent' orders by "
            "release_date/created_at desc; 'random' uses random() ordering."
        ),
    )

    # Standard filters.
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    code: GenreCodeInput = None
    min_similarity: Optional[float] = Field(
        None,
        ge=0.0,
        le=1.0,
        description="Requires `query`; rejected when query is None.",
    )
    completion_filter: CompletionFilter = "all"

    @model_validator(mode="after")
    def _check_query_dependencies(self) -> "ClusteredSearchRequest":
        if self.query is None and self.min_similarity is not None:
            raise ValueError("min_similarity requires a query")
        return self


# --------------------------------------------------------------------------- #
# Clustered search — response
# --------------------------------------------------------------------------- #
class ClusterItem(BaseModel):
    """One cluster, translated from cluster_utils.get_detailed_analysis()."""

    cluster_id: int = Field(
        ...,
        description="-1 for the noise bucket, else the cluster_utils label.",
    )
    label: Optional[str] = Field(
        None,
        description="'Noise/Outliers' for the -1 bucket, else None.",
    )
    size: int
    centroid_similarity: Optional[float] = Field(
        None,
        description="Mean query-similarity of members; None when query is None.",
    )
    consistency_score: Optional[float] = Field(
        None,
        ge=0.0,
        le=1.0,
        description="cluster_utils consistency_score (L2 norm of mean unit embedding).",
    )
    avg_silhouette: Optional[float] = Field(
        None,
        ge=-1.0,
        le=1.0,
        description="Mean per-item silhouette (cluster_utils avg_silhouette_score).",
    )
    misplaced_items_count: Optional[int] = Field(
        None,
        ge=0,
        description="Members with negative silhouette (cluster_utils misplaced_items_count).",
    )
    is_noise: bool = Field(
        False,
        description="True only for the -1 bucket ('Noise/Outliers').",
    )
    items: List[VideoItem]


class ClusteredSearchResponse(BaseModel):
    """Native cluster_utils output (analysis + summary), translated to JSON."""

    query: str = Field("", description="Echo of the request query.")
    total_results: int = Field(..., description="Candidates fetched before clustering.")
    candidate_limit: int = Field(
        ...,
        description=(
            "Effective candidate limit used for this request. Equals the "
            "request's `cluster_candidate_limit` when provided (after "
            "clamping), otherwise the server-side cap for the active mode."
        ),
    )
    n_clusters: int = Field(
        ..., description="Non-noise clusters returned (summary.n_clusters)."
    )
    n_noise: int = Field(
        0, description="Items in the -1 noise bucket (summary.n_noise)."
    )
    total_misplaced_items: int = Field(
        0,
        description="summary.total_misplaced_items (members with negative silhouette).",
    )
    clusters: List[ClusterItem]
    took_ms: float


# --------------------------------------------------------------------------- #
# Grouped search
# --------------------------------------------------------------------------- #
class GroupedSearchRequest(BaseModel):
    """Internal request model for fingerprinting and filter application."""

    query: Optional[str] = None
    code: GenreCodeInput = None
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    completion_filter: CompletionFilter = "all"
    min_similarity: Optional[float] = None
    diversity: float = 0.0
    fetch_k: Optional[int] = None


class GroupedVideoItem(BaseModel):
    id: str
    video_id: str
    code: str
    episode: str
    video_count: int
    title: Optional[str]
    details: Optional[str]
    thumbnail: Optional[str]
    preview: Optional[str]
    release_date: Optional[datetime]
    genres: Optional[List[str]]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]
    url: Optional[str]
    url_uncnsrd: Optional[str]
    url_engsub: Optional[str]
    score: Optional[float] = Field(
        None,
        description=(
            "Best member cosine similarity (1 - distance) for the query; "
            "null when no query is provided."
        ),
    )


class GroupedSearchResponse(BaseModel):
    took_ms: float
    count: int
    next_cursor: Optional[str] = None
    has_more: bool = False
    has_previous: bool = False
    diversity_applied: bool = False
    items: List[GroupedVideoItem]
    """True when MMR reordered results; in that case the returned cursor is
    keyed on the max underlying (code, episode) of the fetched window, not on
    items[-1], so the next page never skips or duplicates groups."""


# --------------------------------------------------------------------------- #
# Diversity search — request
# --------------------------------------------------------------------------- #
class DiscoverRequest(BaseModel):
    query: Optional[str] = Field(
        None,
        min_length=1,
        description="Optional semantic query. If provided, discovery is biased toward this topic.",
    )
    limit: int = Field(20, ge=1, le=50)
    seed: int = Field(
        default_factory=lambda: int(time.time() * 1000) % 10**9,
        description="Random seed for reproducibility. Change this to get a new 'feed'.",
    )
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    code: GenreCodeInput = None
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    completion_filter: CompletionFilter = "all"
    diversity: float = Field(
        0.6,
        ge=0.0,
        le=1.0,
        description="Trade-off between diversity (1.0) and relevance/recency (0.0).",
    )


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #
def _normalize_list_input(val: GenreCodeInput) -> Optional[List[str]]:
    if val is None:
        return None
    out: List[str] = []
    if isinstance(val, str):
        out.extend(s.strip() for s in val.split(",") if s.strip())
    else:
        for item in val:
            if not isinstance(item, str):
                continue
            out.extend(s.strip() for s in item.split(",") if s.strip())
    return out or None


def _fingerprint(req: Union[SearchRequest, SimilarRequest, HybridRequest]) -> str:
    genre_list = _normalize_list_input(getattr(req, "genre", None))
    code_list = _normalize_list_input(getattr(req, "code", None))
    filter_parts = [
        getattr(req, "query", ""),
        sorted(genre_list) if genre_list else None,
        getattr(req, "genres_mode", "any"),
        sorted(code_list) if code_list else None,
        getattr(req, "min_release_date", None),
        getattr(req, "max_release_date", None),
        getattr(req, "min_similarity", None),
        getattr(req, "sort", None),
        getattr(req, "order", None),
        getattr(req, "completion_filter", "all"),
        getattr(req, "video_id", None),
    ]
    filter_str = "|".join(str(x) for x in filter_parts)
    return hashlib.sha256(filter_str.encode()).hexdigest()[:12]


def encode_cursor(sort_key: Optional[Union[float, str]], last_id: str, fp: str) -> str:
    payload = {
        "k": sort_key if sort_key is None else str(sort_key),
        "i": last_id,
        "f": fp,
    }
    raw = json.dumps(payload, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode()


def decode_cursor(cursor: str, fp: str) -> Tuple[Optional[str], str]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        sort_key = data.get("k")
        last_id = str(data["i"])
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid cursor")
    if data.get("f") != fp:
        raise HTTPException(status_code=400, detail="Cursor does not match filters")
    return sort_key, last_id


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


def _apply_filters(req, params: dict, conds: List[str]) -> None:
    genre_list = _normalize_list_input(getattr(req, "genre", None))
    if genre_list:
        mode = getattr(req, "genres_mode", "any")
        op = "@>" if mode == "all" else "&&"
        conds.append(f"genres {op} %(genres)s::text[]")
        params["genres"] = genre_list

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

    completion_filter = getattr(req, "completion_filter", "all")
    if completion_filter == "complete":
        conds.append(
            "(COALESCE(NULLIF(title, ''), NULL) IS NOT NULL "
            "AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL "
            "AND release_date IS NOT NULL "
            "AND genres IS NOT NULL AND cardinality(genres) > 0)"
        )
    elif completion_filter == "incomplete":
        conds.append(
            "(COALESCE(NULLIF(title, ''), NULL) IS NULL "
            "OR COALESCE(NULLIF(details, ''), NULL) IS NULL "
            "OR release_date IS NULL "
            "OR genres IS NULL OR cardinality(genres) = 0)"
        )


def _build_order_clause(
    sort_col: str,
    order_dir: str,
    distance_sql: Optional[str] = None,
) -> Tuple[str, str]:
    """
    Returns (order_by_sql, sort_key_expr_sql).
    PostgreSQL forbids aliasing a SELECT-list output inside ORDER BY
    expressions, so for similarity we substitute the raw distance expression.
    """
    actual_dir = "ASC" if order_dir == "desc" else "DESC"
    if sort_col == "similarity":
        if distance_sql is None:
            raise ValueError("distance_sql required when sort_col='similarity'")
        order = f"ORDER BY {distance_sql} {actual_dir}, id ASC"
        key_expr = distance_sql
        return order, key_expr
    if sort_col not in ("release_date", "created_at"):
        raise ValueError(f"Unsupported sort_col: {sort_col}")
    real_dir = order_dir.upper()
    nulls = "NULLS LAST" if real_dir == "DESC" else "NULLS FIRST"
    order = f"ORDER BY {sort_col} {real_dir} {nulls}, id ASC"
    key_expr = sort_col
    return order, key_expr


def _cursor_predicate(
    sort_col: str,
    order_dir: str,
    params: dict,
    conds: List[str],
    distance_sql: Optional[str] = None,
) -> None:
    sort_key = params.get("_cursor_key")
    last_id = params.get("_cursor_id")
    if sort_key is None and last_id is None:
        return
    if sort_key == "" or sort_key == "None":
        sort_key = None
    if sort_col == "similarity":
        conds.append(
            f"(({distance_sql}), id) > (%(_cursor_key)s::float8, %(_cursor_id)s)"
        )
        params["_cursor_key"] = float(sort_key)
    else:
        op = "<" if order_dir == "desc" else ">"
        if sort_key is None or sort_key == "None":
            conds.append(f"(id {op} %(_cursor_id)s)")
        else:
            conds.append(
                f"(({sort_col}, id) {op} (%(_cursor_key)s::"
                f"{'timestamp with time zone' if sort_col in ('release_date', 'created_at') else 'float8'}"
                f", %(_cursor_id)s)) OR {sort_col} IS NULL"
            )
        params["_cursor_key"] = sort_key
    params["_cursor_id"] = last_id


def _to_float_list(value) -> List[float]:
    """
    Normalize a pgvector column value into a plain list[float].
    Defensive against the several Vector variants across pgvector versions.
    """
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [float(x) for x in value]
    for attr in ("to_list", "tolist"):
        fn = getattr(value, attr, None)
        if callable(fn):
            return [float(x) for x in fn()]
    fn = getattr(value, "to_numpy", None)
    if callable(fn):
        return [float(x) for x in fn().tolist()]
    try:
        return [float(x) for x in memoryview(value).cast("f")]
    except Exception:
        pass
    if isinstance(value, str):
        s = value.strip().strip("[]")
        return [float(x) for x in s.split(",") if x.strip()]
    raise TypeError(
        f"Unsupported embedding value: type={type(value).__name__} "
        f"dir={[a for a in dir(value) if not a.startswith('__')][:20]}"
    )


# --------------------------------------------------------------------------- #
# /search
# --------------------------------------------------------------------------- #
@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    t0 = time.perf_counter()
    fp = _fingerprint(req)
    sort_key: Optional[str] = None
    last_id: Optional[str] = None
    if req.cursor:
        sort_key, last_id = decode_cursor(req.cursor, fp)
    emb = list(_embed_query(req.query))
    params: dict = {"emb": emb, "limit": req.limit + 1}
    conds: List[str] = []
    _apply_filters(req, params, conds)
    if req.min_similarity is not None:
        conds.append("(embedding <=> %(emb)s::vector) <= %(max_dist)s")
        params["max_dist"] = 1.0 - req.min_similarity
    distance_sql = "(embedding <=> %(emb)s::vector)"
    order_clause, _ = _build_order_clause(
        req.sort, req.order, distance_sql=distance_sql
    )
    if last_id is not None:
        params["_cursor_key"] = sort_key
        params["_cursor_id"] = last_id
        _cursor_predicate(req.sort, req.order, params, conds, distance_sql=distance_sql)
    where_sql = " AND ".join(conds) if conds else "TRUE"
    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview,
               {distance_sql} AS distance
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
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        if req.sort == "similarity":
            key_val: Optional[str] = str(last["distance"])
        else:
            sv = last.get(req.sort)
            key_val = (
                sv.isoformat()
                if isinstance(sv, datetime)
                else (str(sv) if sv is not None else None)
            )
        next_cursor = encode_cursor(key_val, last["id"], fp)
    took = (time.perf_counter() - t0) * 1000
    logger.info("search ok n=%d more=%s %.1fms", len(rows), has_more, took)
    return SearchResponse(
        items=[_row_to_item(r) for r in rows],
        next_cursor=next_cursor,
        has_more=has_more,
        took_ms=took,
    )


# --------------------------------------------------------------------------- #
# /search_clustered
#
# The endpoint has exactly two responsibilities:
#   1. Fetch candidate rows from Postgres (the only DB concern).
#   2. Hand the embeddings to TextsClusterer and translate its native
#      output (FitPredictResult + DetailedAnalysis + SummaryData) into the
#      response shape.
#
# Everything else — k selection, HDBSCAN vs Spectral, noise (-1) bucket,
# probabilities, centroids, consistency scores, silhouettes, and per-item
# ordering inside a cluster — comes from cluster_utils unchanged.
# --------------------------------------------------------------------------- #
def _resolve_cluster_candidate_limit(req: ClusteredSearchRequest) -> int:
    """
    Resolve the effective candidate limit for /search_clustered.

    Rules:
      * Query mode  → hard cap = CLUSTER_CANDIDATE_CAP_QUERY.
      * No query    → hard cap = CLUSTER_CANDIDATE_CAP_BROWSE.
      * If the request omits `cluster_candidate_limit`, use the cap.
      * If it sets one, clamp it to [10, cap] (never exceed the cap).
    """
    cap = (
        CLUSTER_CANDIDATE_CAP_QUERY
        if req.query is not None
        else CLUSTER_CANDIDATE_CAP_BROWSE
    )
    if req.cluster_candidate_limit is None:
        return cap
    return max(10, min(req.cluster_candidate_limit, cap))


def _fetch_clustered_candidates(req: ClusteredSearchRequest, limit: int) -> List[dict]:
    params: dict = {"limit": limit}
    conds: List[str] = ["embedding IS NOT NULL"]
    _apply_filters(req, params, conds)

    # Query branch: top-N by cosine distance.
    if req.query is not None:
        emb = _to_float_list(_embed_query(req.query))
        params["emb"] = emb
        distance_sql = "(embedding <=> %(emb)s::vector)"
        if req.min_similarity is not None:
            conds.append("(embedding <=> %(emb)s::vector) <= %(max_dist)s")
            params["max_dist"] = 1.0 - req.min_similarity
        where_sql = " AND ".join(conds)
        sql = f"""
            SELECT id, title, details, url, code, episode, release_date, genres,
                   thumbnail, preview, embedding,
                   {distance_sql} AS distance
            FROM public.videos
            WHERE {where_sql}
            ORDER BY {distance_sql} ASC, id ASC
            LIMIT %(limit)s
        """
        with pool.connection() as conn:
            if ITERATIVE_SCAN_MODE:
                conn.execute(f"SET LOCAL hnsw.iterative_scan = {ITERATIVE_SCAN_MODE}")
                conn.execute(f"SET LOCAL hnsw.max_scan_tuples = {int(MAX_SCAN_TUPLES)}")
            return conn.execute(sql, params).fetchall()

    # Query-less branch: recent or random.
    where_sql = " AND ".join(conds)
    if req.candidate_source == "random":
        order_sql = "ORDER BY random()"
    else:
        order_sql = (
            "ORDER BY release_date DESC NULLS LAST, created_at DESC NULLS LAST, id ASC"
        )
    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview, embedding,
               NULL::float8 AS distance
        FROM public.videos
        WHERE {where_sql}
        {order_sql}
        LIMIT %(limit)s
    """
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchall()


@app.post("/search_clustered", response_model=ClusteredSearchResponse)
def search_clustered(req: ClusteredSearchRequest) -> ClusteredSearchResponse:
    t0 = time.perf_counter()

    # ---- 0. Resolve the effective candidate limit (request or server cap) ----
    limit = _resolve_cluster_candidate_limit(req)

    # ---- 1. Fetch candidates ----
    try:
        rows = _fetch_clustered_candidates(req, limit)
    except Exception as e:
        logger.error("search_clustered DB error: %s", e)
        raise HTTPException(500, f"Search failed: {e}")

    if not rows:
        return ClusteredSearchResponse(
            query=req.query or "",
            total_results=0,
            candidate_limit=limit,
            n_clusters=0,
            n_noise=0,
            total_misplaced_items=0,
            clusters=[],
            took_ms=(time.perf_counter() - t0) * 1000,
        )

    # ---- 2. Build the embedding matrix once ----
    matrix = np.asarray(
        [_to_float_list(r["embedding"]) for r in rows], dtype=np.float32
    )

    # ---- 3. Hand everything to cluster_utils ----
    #
    # `texts` are only used as labels by get_detailed_analysis(); the
    # embeddings drive clustering. Dedup is off because row ids are unique
    # and `original_indices` must line up 1:1 with `rows`.
    #
    # TextsClusterer picks `k` automatically via HDBSCAN (n >= 10) or
    # Spectral (n < 10), exactly like cluster_utils.main() does. It also
    # computes probabilities, centroids, cluster_consistency, and silhouette
    # scores — the endpoint never touches any of that.
    texts = [f"{r['id']}" for r in rows]
    clusterer = TextsClusterer(
        min_cluster_size=req.min_cluster_size,
        cluster_selection_epsilon=req.cluster_selection_epsilon,
    )
    clusterer.fit_predict(
        texts,
        indices=list(range(len(rows))),
        deduplicate=False,
        embeddings=matrix,
    )

    analysis = clusterer.get_detailed_analysis()
    summary = clusterer.get_summary(analysis)

    # ---- 4. Translate cluster_utils output to the response shape ----
    #
    # For each analysis entry:
    #   - "original_indices" → row indices (we passed indices=range(len(rows)))
    #   - "all_texts"        → row ids, same order as original_indices
    #   - "probabilities", "distances_to_centroid", "silhouette_scores"
    #     are aligned with all_texts.
    # get_detailed_analysis already sorts members by (silhouette, probability)
    # descending, so items within each cluster come out core-first.
    by_id: Dict[str, dict] = {r["id"]: r for r in rows}

    clusters: List[ClusterItem] = []
    for cluster_name, info in analysis.items():
        is_noise = cluster_name == "Noise/Outliers"
        cluster_id = -1 if is_noise else int(cluster_name.split(" ")[1])

        texts_in_cluster = info["all_texts"]
        probs = info["probabilities"]
        dists = info["distances_to_centroid"]
        sils = info["silhouette_scores"]

        items: List[VideoItem] = []
        for row_id, prob, dist, sil in zip(texts_in_cluster, probs, dists, sils):
            row = by_id.get(row_id)
            if row is None:
                continue
            sim = (1.0 - row["distance"]) if row["distance"] is not None else None
            item = _row_to_item(row, similarity=sim)
            item.probability = float(prob)
            item.distance_to_centroid = float(dist)
            item.silhouette = float(sil)
            items.append(item)

        # Query-dependent cluster field. None when no query was provided.
        centroid_sim = None
        if req.query is not None and items:
            sims = [it.similarity for it in items if it.similarity is not None]
            if sims:
                centroid_sim = float(np.mean(sims))

        # Per-cluster rollups live in get_summary()['cluster_details'].
        detail = summary["cluster_details"].get(cluster_name, {})

        clusters.append(
            ClusterItem(
                cluster_id=cluster_id,
                label="Noise/Outliers" if is_noise else None,
                size=len(items),
                centroid_similarity=centroid_sim,
                consistency_score=float(detail.get("consistency_score", 0.0)),
                avg_silhouette=float(detail.get("avg_silhouette_score", 0.0)),
                misplaced_items_count=int(detail.get("misplaced_items_count", 0)),
                is_noise=is_noise,
                items=items,
            )
        )

    # Cluster ordering: cohesion × size, noise last. Member ordering inside
    # each cluster is already handled by get_detailed_analysis().
    clusters.sort(key=lambda c: (c.is_noise, -((c.consistency_score or 0.0) * c.size)))

    took = (time.perf_counter() - t0) * 1000
    logger.info(
        "search_clustered ok query=%s limit=%d rows=%d k=%d noise=%d took=%.1fms",
        bool(req.query),
        limit,
        len(rows),
        summary["summary"]["n_clusters"],
        summary["summary"]["n_noise"],
        took,
    )
    return ClusteredSearchResponse(
        query=req.query or "",
        total_results=len(rows),
        candidate_limit=limit,
        n_clusters=summary["summary"]["n_clusters"],
        n_noise=summary["summary"]["n_noise"],
        total_misplaced_items=summary["summary"]["total_misplaced_items"],
        clusters=clusters,
        took_ms=took,
    )


def _grouped_fingerprint(req: GroupedSearchRequest) -> str:
    """Stable fingerprint of all filters that affect grouping/pagination.

    `limit` is excluded (it's page size, not stream identity). `fetch_k` IS
    included: the cursor's page boundary is the full window's max
    (code, episode), which depends on `fetch_k`. Changing `fetch_k`
    mid-walk would silently shift page boundaries, so we invalidate
    cursors on change — matching the "cursor bound to request" contract.
    `diversity` is included: it changes MMR's reorder, but not the
    cursor's anchor; still, invalidating on change is the safe default.
    """
    genre_list = _normalize_list_input(req.genre)
    code_list = _normalize_list_input(req.code)
    parts = [
        req.query or "",
        sorted(genre_list) if genre_list else None,
        req.genres_mode,
        sorted(code_list) if code_list else None,
        req.min_release_date,
        req.max_release_date,
        req.completion_filter,
        req.min_similarity,
        round(float(req.diversity), 6),
        int(req.fetch_k) if req.fetch_k is not None else None,
    ]
    return hashlib.sha256("|".join(str(x) for x in parts).encode()).hexdigest()[:12]


def _encode_grouped_cursor(
    last_code: str,
    last_episode: str,
    fp: str,
    direction: Literal["next", "prev"],
) -> str:
    payload = {
        "c": last_code,
        "e": last_episode,
        "f": fp,
        "d": direction,
    }
    raw = json.dumps(payload, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_grouped_cursor(
    cursor: str, fp: str
) -> Tuple[str, str, Literal["next", "prev"]]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        last_code = str(data["c"])
        last_episode = str(data["e"])
        direction = data.get("d", "next")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid cursor")
    if data.get("f") != fp:
        raise HTTPException(
            status_code=400, detail="Cursor does not match current filters"
        )
    if direction not in ("next", "prev"):
        raise HTTPException(status_code=400, detail="Invalid cursor direction")
    return last_code, last_episode, direction


def _normalize_episode(episode: str) -> str:
    """Zero-pad numeric episodes so lexicographic == numeric ordering.

    '9' -> '00000009', '431' -> '00000431'. Non-numeric episodes are
    lowercased/trimmed so they sort deterministically. Applied identically
    in the ORDER BY and cursor predicate, so pagination stays consistent
    regardless of the underlying storage format.
    """
    ep = (episode or "").strip()
    if ep.isdigit():
        return ep.zfill(8)
    return ep.lower()


@app.get("/search_grouped", response_model=GroupedSearchResponse)
def search_grouped(
    query: Optional[str] = Query(None, min_length=1),
    code: Annotated[Optional[List[str]], Query()] = None,
    genre: Annotated[Optional[List[str]], Query()] = None,
    genres_mode: Literal["any", "all"] = "any",
    min_release_date: Optional[datetime] = None,
    max_release_date: Optional[datetime] = None,
    completion_filter: CompletionFilter = Query("all"),
    min_similarity: Optional[float] = Query(None, ge=0.0, le=1.0),
    limit: int = Query(50, ge=1, le=500),
    cursor: Optional[str] = Query(
        None,
        description=(
            "Opaque keyset cursor. Walk forward with the previous response's "
            "`next_cursor`; walk backward by replaying the stored parent "
            "cursor (the one used to fetch the page you want to return to). "
            "Bound to the request's filters *and* to `fetch_k`; a mismatch "
            "returns HTTP 400."
        ),
    ),
    fetch_k: Optional[int] = Query(
        None,
        ge=1,
        le=10000,
        description=(
            "Candidate window fetched before MMR reordering. Defaults to "
            "max(limit*3, limit+1). MMR reorders *the whole window*; the "
            "endpoint then slices to `limit`. Only used when `diversity > 0`. "
            "Held constant across a pagination walk — the cursor's page "
            "boundary depends on it."
        ),
    ),
    diversity: float = Query(
        0.0,
        ge=0.0,
        le=1.0,
        description=(
            "MMR trade-off (0 = pure relevance, 1 = pure diversity). When > 0, "
            "MMR reorders the full `fetch_k` window; the cursor still advances "
            "by the window's max (code, episode), so no group is skipped or "
            "duplicated across pages."
        ),
    ),
):
    """
    Grouped search over `public.videos`, keyed on `(code, episode)`.

    Pagination contract:
      * Walk forward with `next_cursor` / `has_more`.
      * Walk backward by replaying the stored parent cursor. The server accepts
        both `direction=next` and `direction=prev` tokens.
      * `has_previous` is returned so the client can enable/disable a back
        button without inspecting tokens.
      * Cursors are bound to a fingerprint of filters *and* `fetch_k`;
        mismatches yield HTTP 400 rather than silently wrong pages.

    Sort order:
      * With `query`: by best-member cosine distance ASC, then (code, episode).
      * Without `query`: by (code, episode) ASC (episodes zero-padded).
      * With `diversity > 0`: MMR reorders *within the fetched `fetch_k`
        window only*. The endpoint then slices to `limit`. The cursor advances
        by the *full window's* max (code, episode), so no group is ever
        skipped or duplicated across pages — including the window tail.
    """
    if query is None and min_similarity is not None:
        raise HTTPException(400, "min_similarity requires a query")

    t0 = time.perf_counter()
    req = GroupedSearchRequest(
        query=query,
        code=code,
        genre=genre,
        genres_mode=genres_mode,
        min_release_date=min_release_date,
        max_release_date=max_release_date,
        completion_filter=completion_filter,
        min_similarity=min_similarity,
        diversity=diversity,
        fetch_k=fetch_k,
    )
    fp = _grouped_fingerprint(req)

    backward = False
    cursor_code: Optional[str] = None
    cursor_episode: Optional[str] = None
    if cursor:
        cursor_code, cursor_episode, direction = _decode_grouped_cursor(cursor, fp)
        backward = direction == "prev"

    params: dict = {}
    conds: List[str] = [
        "btrim(v.code) <> ''",
        "btrim(v.episode) <> ''",
        "v.title IS NOT NULL",
        "v.details IS NOT NULL",
        "v.release_date IS NOT NULL",
        "v.genres IS NOT NULL",
        "cardinality(v.genres) > 0",
    ]
    _apply_filters(req, params, conds)

    query_mode = query is not None
    if query_mode:
        params["emb"] = list(_embed_query(query))
        distance_sql = "(v.embedding <=> %(emb)s::vector)"
        conds.append("v.embedding IS NOT NULL")
        if min_similarity is not None:
            params["max_dist"] = 1.0 - float(min_similarity)

    ep_norm_sql = (
        "CASE WHEN btrim(v.episode) ~ '^[0-9]+$' "
        "THEN lpad(btrim(v.episode), 8, '0') "
        "ELSE lower(btrim(v.episode)) END"
    )

    if cursor_code is not None and cursor_episode is not None:
        params["cur_code"] = cursor_code
        params["cur_ep"] = _normalize_episode(cursor_episode)
        op = "<" if backward else ">"
        conds.append(f"(v.code, ({ep_norm_sql})) {op} (%(cur_code)s, %(cur_ep)s)")

    where_sql = " AND ".join(conds)

    diversity_on = diversity > 0.0

    # --- Candidate window sizing -------------------------------------------
    # When diversity is on, fetch `base_fetch` groups and let MMR reorder the
    # WHOLE window, then slice to `limit`. We over-fetch by 1 so `has_more`
    # can distinguish "window full, DB may have more" from "DB exhausted".
    if diversity_on:
        base_fetch = fetch_k if fetch_k else max(limit * 3, limit + 1)
    else:
        base_fetch = limit
    params["limit"] = base_fetch + 1  # +1 sentinel for has_more

    if query_mode:
        score_select = f"MIN({distance_sql})::float8 AS best_distance,"
        group_having = (
            f"HAVING MIN({distance_sql}) <= %(max_dist)s"
            if min_similarity is not None
            else ""
        )
        forward_order = f"ORDER BY best_distance ASC, v.code ASC, ({ep_norm_sql}) ASC"
        backward_order = (
            f"ORDER BY best_distance DESC, v.code DESC, ({ep_norm_sql}) DESC"
        )
    else:
        score_select = "NULL::float8 AS best_distance,"
        group_having = ""
        forward_order = f"ORDER BY v.code ASC, ({ep_norm_sql}) ASC"
        backward_order = f"ORDER BY v.code DESC, ({ep_norm_sql}) DESC"

    order_sql = backward_order if backward else forward_order
    embed_select = "AVG(v.embedding) AS group_embedding," if diversity_on else ""

    sql = f"""
        SELECT
            v.code,
            v.episode,
            (array_agg(v.id ORDER BY
                CASE
                    WHEN v.url NOT LIKE '%%-uncensored-leak'
                     AND v.url NOT LIKE '%%-english-subtitle' THEN 0
                    WHEN v.url LIKE '%%-uncensored-leak' THEN 1
                    ELSE 2
                END, v.id))[1] AS id,
            (array_agg(v.video_id ORDER BY
                CASE
                    WHEN v.url NOT LIKE '%%-uncensored-leak'
                     AND v.url NOT LIKE '%%-english-subtitle' THEN 0
                    WHEN v.url LIKE '%%-uncensored-leak' THEN 1
                    ELSE 2
                END, v.id))[1] AS video_id,
            count(DISTINCT v.id)::int AS video_count,
            (array_agg(v.title ORDER BY length(v.title) ASC NULLS LAST))[1] AS title,
            (array_agg(v.details ORDER BY length(v.details) ASC NULLS LAST))[1] AS details,
            (array_agg(v.thumbnail ORDER BY v.id))[1] AS thumbnail,
            (array_agg(v.preview ORDER BY v.id))[1] AS preview,
            (array_agg(v.release_date ORDER BY
                CASE
                    WHEN v.url NOT LIKE '%%-uncensored-leak'
                     AND v.url NOT LIKE '%%-english-subtitle' THEN 0
                    WHEN v.url LIKE '%%-uncensored-leak' THEN 1
                    ELSE 2
                END, v.id))[1] AS release_date,
            array_agg(DISTINCT g.genre) FILTER (
                WHERE g.genre IS NOT NULL
                  AND g.genre <> ''
                  AND lower(btrim(g.genre)) NOT IN
                      ('uncensored leak', 'english subtitle')
            ) AS genres,
            (array_agg(v.url ORDER BY v.id) FILTER (
                WHERE v.url NOT LIKE '%%-uncensored-leak'
                  AND v.url NOT LIKE '%%-english-subtitle'))[1] AS url,
            (array_agg(v.url ORDER BY v.id) FILTER (
                WHERE v.url LIKE '%%-uncensored-leak'))[1] AS url_uncnsrd,
            (array_agg(v.url ORDER BY v.id) FILTER (
                WHERE v.url LIKE '%%-english-subtitle'))[1] AS url_engsub,
            {score_select}
            {embed_select}
            min(v.created_at) AS created_at,
            max(v.updated_at) AS updated_at
        FROM public.videos v
        LEFT JOIN LATERAL unnest(v.genres) AS g(genre) ON true
        WHERE {where_sql}
        GROUP BY v.code, v.episode
        {group_having}
        {order_sql}
        LIMIT %(limit)s
    """

    try:
        with pool.connection() as conn:
            if query_mode and ITERATIVE_SCAN_MODE:
                conn.execute(f"SET LOCAL hnsw.iterative_scan = {ITERATIVE_SCAN_MODE}")
                conn.execute(f"SET LOCAL hnsw.max_scan_tuples = {int(MAX_SCAN_TUPLES)}")
            rows = conn.execute(sql, params).fetchall()
    except Exception as e:
        logger.error("search_grouped DB error: %s", e)
        raise HTTPException(500, f"Grouped search failed: {e}")

    # `rows` now holds up to `base_fetch + 1` groups.
    # `has_more` means "DB has more groups past this window's end".
    has_more_from_db = len(rows) > base_fetch
    window = rows[:base_fetch]

    # --- Cursor anchor: FULL window's max key, computed BEFORE trimming ----
    def _max_key(rs: List[dict]) -> Optional[Tuple[str, str]]:
        if not rs:
            return None
        return max(
            ((r["code"], _normalize_episode(r["episode"])) for r in rs),
            key=lambda x: x,
        )

    window_anchor = _max_key(window)

    # For backward pagination: anchor is the *min* key of the window
    # (the previous page's forward walk anchored on its max; we walk back
    # from the window's min so we can fetch the page before it).
    window_min_key = None
    if window:
        window_min_key = min(
            ((r["code"], _normalize_episode(r["episode"])) for r in window),
            key=lambda x: x,
        )

    # --- MMR over the FULL window (fix #1) ----------------------------------
    diversity_applied = False
    ordered_window = window
    if diversity_on and window:
        doc_vecs: List[Optional[List[float]]] = []
        for r in window:
            emb = r.get("group_embedding")
            doc_vecs.append(_to_float_list(emb) if emb is not None else None)

        mmr_eligible = [i for i, v in enumerate(doc_vecs) if v is not None]
        null_count = len(window) - len(mmr_eligible)
        if null_count:
            # Fix #6: make the silent-degradation path observable.
            logger.warning(
                "search_grouped diversity: %d/%d groups have NULL group_embedding; "
                "they bypass MMR and are appended at the end of the page.",
                null_count,
                len(window),
            )

        if len(mmr_eligible) >= 2:
            matrix = np.array([doc_vecs[i] for i in mmr_eligible], dtype=np.float32)
            query_vec = (
                np.array(params["emb"], dtype=np.float32)
                if query_mode
                else matrix.mean(axis=0)
            )
            # MMR over the ENTIRE eligible window (not just `limit` items).
            mmr_results = mmr_rerank(
                query_vec=query_vec,
                doc_vecs=matrix,
                top_k=len(mmr_eligible),
                lambda_param=1.0 - diversity,
            )
            reordered_idx = [mmr_eligible[res["index"]] for res in mmr_results]
            tail = [i for i in range(len(window)) if doc_vecs[i] is None]
            ordered_window = [window[i] for i in reordered_idx + tail]
            diversity_applied = True

    # --- Slice AFTER MMR (fix #1) -------------------------------------------
    page_rows = ordered_window[:limit]

    # --- has_more / has_previous --------------------------------------------
    # has_more: true if the DB returned more than the window (sentinel row),
    # OR (when MMR reorders) if MMR itself surfaced additional rows beyond
    # `limit` within the window — but the cursor advance is by the window's
    # max key, so the next page is the post-window groups regardless. The
    # sentinel captures the DB-more case; window-tail-more is captured by
    # the fact that we returned < len(window) items but the window anchor
    # still points past the last returned item. To keep the contract simple,
    # we report `has_more = has_more_from_db or (diversity_on and len(ordered_window) > limit)`.
    if diversity_on:
        has_more = has_more_from_db or (len(ordered_window) > limit)
    else:
        has_more = has_more_from_db

    has_previous = cursor is not None

    # Backward: reverse the (already sliced) page so the returned page reads
    # in forward order, and the caller sees the page *before* the cursor.
    if backward:
        page_rows = list(reversed(page_rows))

    # --- Build items --------------------------------------------------------
    items: List[GroupedVideoItem] = []
    for r in page_rows:
        best_dist = r.get("best_distance")
        items.append(
            GroupedVideoItem(
                id=r["id"],
                video_id=r["video_id"],
                code=r["code"],
                episode=r["episode"],
                video_count=int(r["video_count"]),
                title=r["title"],
                details=r["details"],
                thumbnail=r["thumbnail"],
                preview=r["preview"],
                release_date=r["release_date"],
                genres=r["genres"],
                created_at=r["created_at"],
                updated_at=r["updated_at"],
                url=r["url"],
                url_uncnsrd=r["url_uncnsrd"],
                url_engsub=r["url_engsub"],
                score=(1.0 - float(best_dist)) if best_dist is not None else None,
            )
        )

    # --- Cursor (fix #1: anchored on FULL window, not trimmed page) --------
    next_cursor: Optional[str] = None
    if has_more and window_anchor:
        # Forward walk: next page starts strictly after the full window's max.
        # The window tail (window[limit:base_fetch]) is consumed by this
        # cursor even though it wasn't returned — that is correct: MMR
        # already ranked it, and the caller will see the next page's window
        # start at the first group past the anchor. No group is duplicated
        # or skipped.
        next_cursor = _encode_grouped_cursor(
            window_anchor[0], window_anchor[1], fp, "next"
        )

    took = (time.perf_counter() - t0) * 1000
    logger.info(
        "search_grouped ok n=%d more=%s prev=%s div=%s back=%s window=%d/%d %.1fms",
        len(items),
        has_more,
        has_previous,
        diversity_applied,
        backward,
        len(window),
        base_fetch,
        took,
    )
    return GroupedSearchResponse(
        items=items,
        count=len(items),
        took_ms=took,
        next_cursor=next_cursor,
        has_more=has_more,
        has_previous=has_previous,
        diversity_applied=diversity_applied,
    )


@app.post("/discover", response_model=VideoListResponse)
def discover(req: DiscoverRequest) -> VideoListResponse:
    """
    Shuffle/Discovery mode for endless browsing.

    - If `query` is provided: Fetches relevant candidates via vector search,
      then applies weighted sampling + MMR to ensure diverse coverage of the topic.
    - If `query` is omitted: Fetches random candidates and diversifies them
      for a broad "surprise me" experience.

    Does not use cursors; clients should change the 'seed' for subsequent batches.
    """
    t0 = time.perf_counter()

    # 1. Determine how many candidates to fetch from DB
    fetch_k = compute_shuffle_fetch_k(req.limit)

    # 2. Build SQL to fetch a large candidate pool
    params: dict = {"limit": fetch_k}
    conds: List[str] = ["embedding IS NOT NULL"]  # Ensure we have embeddings for MMR

    # Apply standard filters
    class FilterReq:
        def __init__(self, source_req):
            self.genre = source_req.genre
            self.genres_mode = source_req.genres_mode
            self.code = source_req.code
            self.min_release_date = source_req.min_release_date
            self.max_release_date = source_req.max_release_date
            self.completion_filter = source_req.completion_filter

    filter_req = FilterReq(req)
    _apply_filters(filter_req, params, conds)
    where_sql = " AND ".join(conds)

    has_query = req.query is not None
    emb = None

    if has_query:
        # Query mode: Fetch top-K by similarity to ensure relevance
        emb = list(_embed_query(req.query))
        params["emb"] = emb
        distance_sql = "(embedding <=> %(emb)s::vector)"
        order_sql = f"ORDER BY {distance_sql} ASC"
        select_cols = f"""
            id, title, details, url, code, episode, release_date, genres,
            thumbnail, preview, embedding,
            {distance_sql} AS distance
        """
    else:
        # Random mode: Fetch random sample
        order_sql = "ORDER BY random()"
        select_cols = """
            id, title, details, url, code, episode, release_date, genres,
            thumbnail, preview, embedding,
            NULL::float8 AS distance
        """

    sql = f"""
        SELECT {select_cols}
        FROM public.videos
        WHERE {where_sql}
        {order_sql}
        LIMIT %(limit)s
    """

    try:
        with pool.connection() as conn:
            rows = conn.execute(sql, params).fetchall()
    except Exception as e:
        logger.error("Discover DB error: %s", e)
        raise HTTPException(500, f"Discovery failed: {e}")

    if not rows:
        return VideoListResponse(
            items=[], count=0, took_ms=(time.perf_counter() - t0) * 1000
        )

    # 3. Prepare data for diversity_utils
    search_results = []
    embeddings_list = []

    for r in rows:
        # Create a simple document string for semantic comparison
        doc_text = f"{r['title']} {r['details']}" if r["details"] else r["title"]

        # Calculate score: 1 - distance if query exists, else 1.0 (neutral)
        score = (1.0 - r["distance"]) if r["distance"] is not None else 1.0

        search_results.append(
            {
                "id": r["id"],
                "score": score,
                "document": doc_text or "",
            }
        )
        embeddings_list.append(_to_float_list(r["embedding"]))

    embeddings_matrix = np.array(embeddings_list, dtype=np.float32)

    # 4. Apply Shuffle and Diversify
    diversified_results = shuffle_and_diversify(
        results=search_results,
        top_k=req.limit,
        diversity=req.diversity,
        seed=req.seed,
        relevance_bias=1.0,  # Bias toward the calculated 'score'
        embeddings=embeddings_matrix,
    )

    # 5. Map back to full VideoItem objects
    row_map = {r["id"]: r for r in rows}
    final_items = []

    for res in diversified_results:
        original_row = row_map.get(res["id"])
        if original_row:
            # If query exists, pass similarity to VideoItem
            sim = (
                (1.0 - original_row["distance"])
                if has_query and original_row["distance"] is not None
                else None
            )
            final_items.append(_row_to_item(original_row, similarity=sim))

    took = (time.perf_counter() - t0) * 1000
    logger.info(
        "discover ok query=%s seed=%d limit=%d fetched=%d returned=%d %.1fms",
        bool(has_query),
        req.seed,
        req.limit,
        len(rows),
        len(final_items),
        took,
    )

    return VideoListResponse(
        items=[dict(item) for item in final_items], count=len(final_items), took_ms=took
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
    raw_emb = src["embedding"] if src else None
    logger.info(
        "similar debug: video_id=%r src_present=%s raw_emb_type=%s",
        req.video_id,
        src is not None,
        type(raw_emb).__name__ if raw_emb is not None else None,
    )
    if not src or raw_emb is None:
        raise HTTPException(404, "Source video or embedding not found")
    emb = _to_float_list(raw_emb)

    class SyntheticReq:
        def __init__(self, source_req):
            self.query = ""
            self.video_id = source_req.video_id
            self.genre = source_req.genre
            self.genres_mode = source_req.genres_mode
            self.code = source_req.code
            self.min_release_date = None
            self.max_release_date = None
            self.min_similarity = None
            self.sort = source_req.sort
            self.order = source_req.order
            self.completion_filter = source_req.completion_filter

    synthetic = SyntheticReq(req)
    fp = _fingerprint(synthetic)
    sort_key: Optional[str] = None
    last_id: Optional[str] = None
    if req.cursor:
        sort_key, last_id = decode_cursor(req.cursor, fp)
    params: dict = {"emb": emb, "limit": req.limit + 1}
    conds: List[str] = ["id <> %(src)s"]
    params["src"] = req.video_id
    _apply_filters(synthetic, params, conds)
    distance_sql = "(embedding <=> %(emb)s::vector)"
    order_clause, _ = _build_order_clause(
        req.sort, req.order, distance_sql=distance_sql
    )
    if last_id is not None:
        params["_cursor_key"] = sort_key
        params["_cursor_id"] = last_id
        _cursor_predicate(req.sort, req.order, params, conds, distance_sql=distance_sql)
    where_sql = " AND ".join(conds)
    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview, {distance_sql} AS distance
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
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        if req.sort == "similarity":
            key_val: Optional[str] = str(last["distance"])
        else:
            sv = last.get(req.sort)
            key_val = (
                sv.isoformat()
                if isinstance(sv, datetime)
                else (str(sv) if sv is not None else None)
            )
        next_cursor = encode_cursor(key_val, last["id"], fp)
    took = (time.perf_counter() - t0) * 1000
    return SearchResponse(
        items=[_row_to_item(r) for r in rows],
        next_cursor=next_cursor,
        has_more=has_more,
        took_ms=took,
    )


# --------------------------------------------------------------------------- #
# /hybrid
# --------------------------------------------------------------------------- #
@app.post("/hybrid", response_model=SearchResponse)
def hybrid(req: HybridRequest) -> SearchResponse:
    t0 = time.perf_counter()
    emb = list(_embed_query(req.query))
    k = 60
    cand = req.limit * 4
    vec_params: dict = {"emb": emb, "limit": cand}
    vec_conds: List[str] = []

    class VecReq:
        def __init__(self, source_req):
            self.genre = source_req.genre
            self.genres_mode = source_req.genres_mode
            self.code = source_req.code
            self.min_release_date = source_req.min_release_date
            self.max_release_date = source_req.max_release_date
            self.completion_filter = source_req.completion_filter

    vec_req = VecReq(req)
    _apply_filters(vec_req, vec_params, vec_conds)
    vec_where = " AND ".join(vec_conds) if vec_conds else "TRUE"
    fts_params: dict = {"q": req.query, "limit": cand}
    fts_conds = [
        "title IS NOT NULL",
        "to_tsvector('english', title) @@ plainto_tsquery('english', %(q)s)",
    ]
    _apply_filters(vec_req, fts_params, fts_conds)
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
# /browse
# --------------------------------------------------------------------------- #
@app.get("/browse", response_model=SearchResponse)
def browse(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100_000),
    genre: Annotated[Optional[List[str]], Query()] = None,
    genres_mode: Literal["any", "all"] = "any",
    code: Annotated[Optional[List[str]], Query()] = None,
    sort: Literal["release_date", "created_at"] = "release_date",
    order: Literal["asc", "desc"] = "desc",
    completion_filter: CompletionFilter = Query("all"),
):
    t0 = time.perf_counter()

    class BrowseReq:
        def __init__(self):
            self.genre = genre
            self.genres_mode = genres_mode
            self.code = code
            self.min_release_date = None
            self.max_release_date = None
            self.completion_filter = completion_filter

    req_obj = BrowseReq()
    params: dict = {"limit": limit + 1, "offset": offset}
    conds: List[str] = []
    _apply_filters(req_obj, params, conds)
    where_sql = " AND ".join(conds) if conds else "TRUE"
    order_clause, _ = _build_order_clause(sort, order)
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
# /videos
# --------------------------------------------------------------------------- #
_VLIST_FIELDS = {
    "id": "id",
    "summary": "id, code, episode, title, release_date, complete",
    "full": (
        "id, title, details, url, code, episode, release_date, genres, "
        "thumbnail, preview"
    ),
}


@app.get("/videos", response_model=VideoListResponse)
def list_videos(
    code: Annotated[Optional[List[str]], Query()] = None,
    genre: Annotated[Optional[List[str]], Query()] = None,
    genres_mode: Literal["any", "all"] = "any",
    completion_filter: CompletionFilter = Query("all"),
    min_release_date: Optional[datetime] = None,
    max_release_date: Optional[datetime] = None,
    limit: Optional[int] = Query(
        None,
        ge=1,
        le=5000,
        description="Omit or null to fetch all matching rows (capped at 5000).",
    ),
    offset: int = Query(0, ge=0),
    fields: Literal["id", "summary", "full"] = "summary",
    # --- NEW: optional free-text / semantic search ---
    query: Optional[str] = Query(
        None,
        min_length=1,
        description=(
            "Optional free-text query. When omitted, the endpoint behaves "
            "exactly like before (stable id ASC offset pagination). When "
            "provided, results are ordered by relevance according to `mode`. "
            "Use `search_sort=id` to fall back to deterministic id ordering "
            "even when a query is present."
        ),
    ),
    mode: VideoSearchMode = Query(
        "semantic",
        description=(
            "Relevance mode when `query` is provided. "
            "'fts' uses title full-text search. "
            "'semantic' uses embedding cosine distance. "
            "'hybrid' fuses FTS + vector via Reciprocal Rank Fusion."
        ),
    ),
    search_sort: Literal["relevance", "id"] = Query(
        "relevance",
        description=(
            "Ordering when `query` is provided. 'relevance' sorts by score "
            "(best first). 'id' keeps deterministic id ASC ordering while "
            "still filtering to matches."
        ),
    ),
    min_similarity: Optional[float] = Query(
        None,
        ge=0.0,
        le=1.0,
        description=(
            "Optional similarity floor applied in 'semantic' and 'hybrid' "
            "modes. Ignored in 'fts' mode."
        ),
    ),
):
    """
    Stable, id-ordered listing for sync/export tooling.

    Behavior:
      * Without `query`:
          - No `release_date IS NOT NULL` guard, no keyset cursor.
          - Sorted by `id ASC` so offset pagination is deterministic
            across concurrent inserts.
      * With `query`:
          - Same filters are applied, plus a match predicate based on `mode`.
          - Ordering is by relevance (`search_sort='relevance'`, default)
            or by `id ASC` (`search_sort='id'`).
          - Still supports offset pagination.
    """
    t0 = time.perf_counter()
    EFFECTIVE_CAP = 5000
    eff_limit = EFFECTIVE_CAP if limit is None else min(limit, EFFECTIVE_CAP)

    class _Req:
        pass

    req = _Req()
    req.genre = genre
    req.genres_mode = genres_mode
    req.code = code
    req.min_release_date = min_release_date
    req.max_release_date = max_release_date
    req.completion_filter = completion_filter

    params: dict = {"limit": eff_limit, "offset": offset}
    conds: List[str] = []
    _apply_filters(req, params, conds)

    # Resolve SELECT list (with optional distance column for semantic modes)
    select_cols = _VLIST_FIELDS[fields]
    if fields == "summary":
        select_cols = (
            "id, code, episode, title, release_date, "
            "(COALESCE(NULLIF(title, ''), NULL) IS NOT NULL "
            " AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL "
            " AND release_date IS NOT NULL "
            " AND genres IS NOT NULL AND cardinality(genres) > 0) AS complete"
        )

    extra_select: List[str] = []
    order_sql = "ORDER BY id ASC"
    use_semantic = query is not None and mode in ("semantic", "hybrid")
    use_fts = query is not None and mode in ("fts", "hybrid")

    # Embed the query once (cached) if any semantic mode is requested.
    emb: Optional[List[float]] = None
    if use_semantic:
        emb = list(_embed_query(query))
        params["emb"] = emb

    # --- Relevance setup -------------------------------------------------
    if query is not None:
        if mode == "fts":
            conds.append(
                "title IS NOT NULL AND "
                "to_tsvector('english', title) @@ plainto_tsquery('english', %(q)s)"
            )
            params["q"] = query
            if search_sort == "relevance":
                order_sql = (
                    "ORDER BY ts_rank_cd("
                    "to_tsvector('english', title), "
                    "plainto_tsquery('english', %(q)s)"
                    ") DESC, id ASC"
                )

        elif mode == "semantic":
            conds.append("embedding IS NOT NULL")
            distance_sql = "(embedding <=> %(emb)s::vector)"
            # similarity is the user-facing score; distance stays internal
            similarity_sql = f"GREATEST(0.0, LEAST(1.0, 1.0 - {distance_sql}))"
            if min_similarity is not None:
                conds.append(f"{distance_sql} <= %(max_dist)s")
                params["max_dist"] = 1.0 - float(min_similarity)
            # Only project the score when the caller asked for more than ids.
            if fields != "id":
                extra_select.append(f"{similarity_sql} AS similarity")
            # Order by raw distance ASC (closest first); this is what the
            # HNSW index is built to serve and matches /search's semantics.
            if search_sort == "relevance":
                order_sql = f"ORDER BY {distance_sql} ASC, id ASC"

        elif mode == "hybrid":
            # Hybrid is a two-pass RRF: fetch candidates from FTS and vector,
            # then fuse. To keep this endpoint offset-paginatable and stable,
            # we materialize the fused ranking in a CTE and then slice.
            params["q"] = query
            params["rrf_k"] = 60
            params["cand_limit"] = max(eff_limit + offset, 200)

            # Build the same base WHERE (filters only) for candidate CTEs,
            # then add FTS/vector predicates per-CTE.
            base_conds = list(conds)  # filters only; no query predicates yet
            base_where = " AND ".join(base_conds) if base_conds else "TRUE"

            # For hybrid we assemble the full SQL directly (not via the
            # generic scaffold below), so do it and return early.
            if min_similarity is not None:
                sem_cond = (
                    "(embedding IS NOT NULL AND "
                    "(embedding <=> %(emb)s::vector) <= %(max_dist)s)"
                )
                params["max_dist"] = 1.0 - float(min_similarity)
            else:
                sem_cond = "embedding IS NOT NULL"

            # For hybrid, semantic candidate selection always needs the emb.
            params["emb"] = list(_embed_query(query))

            sql = f"""
                WITH vec AS (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               ORDER BY embedding <=> %(emb)s::vector, id
                           ) AS rn
                    FROM public.videos
                    WHERE {base_where} AND {sem_cond}
                    ORDER BY embedding <=> %(emb)s::vector, id
                    LIMIT %(cand_limit)s
                ),
                fts AS (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               ORDER BY ts_rank_cd(
                                   to_tsvector('english', title),
                                   plainto_tsquery('english', %(q)s)
                               ) DESC, id
                           ) AS rn
                    FROM public.videos
                    WHERE {base_where}
                      AND title IS NOT NULL
                      AND to_tsvector('english', title)
                          @@ plainto_tsquery('english', %(q)s)
                    ORDER BY ts_rank_cd(
                        to_tsvector('english', title),
                        plainto_tsquery('english', %(q)s)
                    ) DESC, id
                    LIMIT %(cand_limit)s
                ),
                fused AS (
                    SELECT id, SUM(1.0 / (%(rrf_k)s + rn))::float8 AS score
                    FROM (
                        SELECT id, rn FROM vec
                        UNION ALL
                        SELECT id, rn FROM fts
                    ) u
                    GROUP BY id
                )
                SELECT v.id, v.title, v.details, v.url, v.code, v.episode,
                       v.release_date, v.genres, v.thumbnail, v.preview,
                       f.score AS score
                FROM fused f
                JOIN public.videos v ON v.id = f.id
                ORDER BY f.score DESC, v.id ASC
                LIMIT %(limit)s OFFSET %(offset)s
            """

            with pool.connection() as conn:
                if ITERATIVE_SCAN_MODE:
                    conn.execute(
                        f"SET LOCAL hnsw.iterative_scan = {ITERATIVE_SCAN_MODE}"
                    )
                    conn.execute(
                        f"SET LOCAL hnsw.max_scan_tuples = {int(MAX_SCAN_TUPLES)}"
                    )
                rows = conn.execute(sql, params).fetchall()

            took = (time.perf_counter() - t0) * 1000
            return VideoListResponse(
                items=[dict(r) for r in rows],
                count=len(rows),
                took_ms=took,
            )

    # --- Assemble generic SQL (no-query, fts, or semantic) --------------
    where_sql = " AND ".join(conds) if conds else "TRUE"
    select_full = ", ".join([select_cols] + extra_select)

    sql = f"""
        SELECT {select_full}
        FROM public.videos
        WHERE {where_sql}
        {order_sql}
        LIMIT %(limit)s OFFSET %(offset)s
    """

    with pool.connection() as conn:
        if use_semantic and ITERATIVE_SCAN_MODE:
            conn.execute(f"SET LOCAL hnsw.iterative_scan = {ITERATIVE_SCAN_MODE}")
            conn.execute(f"SET LOCAL hnsw.max_scan_tuples = {int(MAX_SCAN_TUPLES)}")
        rows = conn.execute(sql, params).fetchall()

    took = (time.perf_counter() - t0) * 1000
    return VideoListResponse(
        items=[dict(r) for r in rows],
        count=len(rows),
        took_ms=took,
    )


# --------------------------------------------------------------------------- #
# /facets
# --------------------------------------------------------------------------- #
def _completion_filter_sql(completion_filter: CompletionFilter) -> str:
    if completion_filter == "complete":
        return (
            "AND COALESCE(NULLIF(title, ''), NULL) IS NOT NULL "
            "AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL "
            "AND release_date IS NOT NULL "
            "AND genres IS NOT NULL AND cardinality(genres) > 0"
        )
    elif completion_filter == "incomplete":
        return (
            "AND (COALESCE(NULLIF(title, ''), NULL) IS NULL "
            "OR COALESCE(NULLIF(details, ''), NULL) IS NULL "
            "OR release_date IS NULL "
            "OR genres IS NULL OR cardinality(genres) = 0)"
        )
    else:
        return ""


@app.get("/facets", response_model=FacetsResponse)
def facets(
    top_genres: int = 60,
    top_codes: int = 40,
    completion_filter: CompletionFilter = Query("all"),
):
    extra = _completion_filter_sql(completion_filter)
    with pool.connection() as conn:
        genres = conn.execute(
            f"""
            SELECT g AS name, COUNT(*)::int AS count
            FROM public.videos, unnest(genres) AS g
            WHERE genres IS NOT NULL {extra}
            GROUP BY g ORDER BY count DESC NULLS LAST
            LIMIT %s
        """,
            (top_genres,),
        ).fetchall()
        codes = conn.execute(
            f"""
            SELECT code, COUNT(*)::int AS count
            FROM public.videos
            WHERE TRUE {extra}
            GROUP BY code
            ORDER BY count DESC LIMIT %s
        """,
            (top_codes,),
        ).fetchall()
        years = conn.execute(
            f"""
            SELECT EXTRACT(YEAR FROM release_date)::int AS year,
                   COUNT(*)::int AS count
            FROM public.videos
            WHERE release_date IS NOT NULL {extra}
            GROUP BY 1 ORDER BY 1
        """
        ).fetchall()
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
            SELECT code,
                    COUNT(*)::int AS count,
                    SUM(CASE
                        WHEN COALESCE(NULLIF(title, ''), NULL) IS NOT NULL
                                AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL
                                AND release_date IS NOT NULL
                                AND genres IS NOT NULL AND cardinality(genres) > 0
                        THEN 1 ELSE 0 END)::int AS completed
            FROM public.videos
            WHERE code IS NOT NULL
            GROUP BY code
            ORDER BY count DESC
        """
        ).fetchall()
    return {
        "code_count": len(codes),
        "codes": [
            {"code": r["code"], "count": r["count"], "completed": r["completed"]}
            for r in codes
        ],
    }


# --------------------------------------------------------------------------- #
# /health
# --------------------------------------------------------------------------- #
@app.get("/health")
def health():
    t0 = time.perf_counter()
    with pool.connection() as conn:
        conn.execute("SELECT 1").fetchone()
    return {"ok": True, "db_ms": (time.perf_counter() - t0) * 1000}


# --------------------------------------------------------------------------- #
# /ingest
# --------------------------------------------------------------------------- #
def _format_for_embedding(item: VideoIngestItem) -> Optional[str]:
    parts: List[str] = []
    clean_title, clean_details = _clean_fields(item.title, item.details, item.code)
    if clean_title:
        parts.append(clean_title)
    if clean_details:
        parts.append(clean_details)
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
    t0 = time.perf_counter()
    inserted = updated = skipped = 0
    unique_items_map = {}
    for item in req.items:
        if item.id:
            unique_items_map[item.id] = item
    unique_items = list(unique_items_map.values())
    duplicate_count = len(req.items) - len(unique_items)
    if duplicate_count > 0:
        logger.info(
            f"Deduped input: {len(req.items)} -> {len(unique_items)} "
            f"(removed {duplicate_count} duplicates)"
        )
    embeddable: List[Tuple[int, VideoIngestItem, str]] = []
    for idx, item in enumerate(unique_items):
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
    raw_texts = [t for _, _, t in embeddable]
    truncated_texts = truncate_texts(
        raw_texts,
        model=EMBED_MODEL,
        max_tokens=INGEST_MAX_TOKENS,
        strict_sentences=False,
        show_progress=False,
    )
    if isinstance(truncated_texts, str):
        truncated_texts = [truncated_texts]
    logger.info("Generating embeddings for %d ingest items...", len(truncated_texts))
    embeddings = embed(truncated_texts, return_format="list", prefix=EMBED_DOC_PREFIX)
    rows: List[tuple] = []
    for (_, item, _), emb in zip(embeddable, embeddings):
        clean_title, clean_details = _clean_fields(item.title, item.details, item.code)
        rows.append(
            (
                item.id,
                item.url,
                item.code,
                item.episode,
                item.video_id,
                clean_title,
                item.thumbnail,
                item.preview,
                clean_details,
                item.release_date,
                item.genres,
                emb,
            )
        )
    if not rows:
        return IngestResponse(
            inserted=0,
            updated=0,
            skipped=skipped,
            took_ms=(time.perf_counter() - t0) * 1000,
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
    except Exception as e:
        logger.exception("Ingest failed")
        raise HTTPException(500, f"Ingest failed: {e}")
    took = (time.perf_counter() - t0) * 1000
    logger.info(
        "ingest ok ins=%d upd=%d skip=%d dupes=%d %.1fms",
        inserted,
        updated,
        skipped,
        duplicate_count,
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
