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
from jet.adapters.llama_cpp.cluster_utils import (
    TextsClusterer,
    calculate_custom_confidence,
)
from jet.adapters.llama_cpp.config import (
    EMBED_DOC_PREFIX,
    EMBED_MODEL,
    EMBED_QUERY_PREFIX,
)
from jet.adapters.llama_cpp.embed_utils import embed, shutdown_embed_pool
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field, model_validator
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_samples
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.preprocessing import normalize

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger("video_search_api")
DB_CONNINFO = "dbname=missav_db1 user=jethroestrada host=localhost port=5432"
ITERATIVE_SCAN_MODE: Optional[str] = "strict_order"
MAX_SCAN_TUPLES = 20000
INGEST_MAX_TOKENS = 512

# Single shared pattern for both title and details.
# Matches a leading "<code>-<digits>" followed by optional punctuation
# (colon / hyphen / en-dash / em-dash) and whitespace.
# Group 1 = the code as written in the text.
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

    # --- display / ranking signals (populated by /search_clustered) ---
    probability: Optional[float] = Field(
        None,
        ge=0.0,
        le=1.0,
        description="Membership confidence in its cluster (cosine sim to centroid).",
    )
    silhouette: Optional[float] = Field(
        None,
        ge=-1.0,
        le=1.0,
        description="Per-item silhouette; negative = likely misplaced.",
    )
    distance_to_centroid: Optional[float] = Field(
        None,
        ge=0.0,
        description="Cosine distance to its cluster centroid (0 = perfectly typical).",
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


class ClusteredSearchRequest(BaseModel):
    query: Optional[str] = Field(
        None,
        min_length=1,
        description=(
            "Optional semantic query. When omitted, candidates are drawn from "
            "the filtered pool via `candidate_source` and clustered by mutual "
            "embedding similarity — no query vector is used, so `similarity`, "
            "`min_similarity`, and `centroid_similarity` are not populated."
        ),
    )

    n_clusters: int = Field(
        3,
        ge=2,
        le=10,
        description=(
            "Target number of semantic groups. The clusterer auto-selects k; "
            "the endpoint then merges/splits to land exactly on this value."
        ),
    )
    cluster_candidate_limit: int = Field(
        100,
        ge=10,
        le=500,
        description="Top-N candidates fetched before clustering.",
    )
    min_cluster_size: int = Field(
        2,
        ge=2,
        le=20,
        description="HDBSCAN min_cluster_size; smaller = more, tighter groups.",
    )
    cluster_selection_epsilon: float = Field(
        0.25,
        ge=0.0,
        le=1.0,
        description="HDBSCAN cluster_selection_epsilon; lower = stricter, more noise.",
    )
    include_noise: bool = Field(
        False,
        description=(
            "If true, keep a separate 'Noise/Outliers' cluster in the response. "
            "If false (default), noise items are folded into their nearest "
            "centroid cluster so every result appears exactly once."
        ),
    )

    candidate_source: Literal["recent", "random"] = Field(
        "recent",
        description=(
            "Only used when `query` is omitted. 'recent' orders by "
            "release_date/created_at desc; 'random' uses random() ordering for "
            "variety across requests."
        ),
    )

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


class ClusterItem(BaseModel):
    cluster_id: int
    label: Optional[str] = Field(
        None,
        description="Human-readable label, when available (e.g. 'Noise/Outliers').",
    )
    size: int
    centroid_similarity: Optional[float] = Field(
        None,
        description=(
            "Mean query-similarity of members. None when no query was provided."
        ),
    )
    consistency_score: Optional[float] = Field(
        None,
        ge=0.0,
        le=1.0,
        description="Cluster cohesion (L2 norm of mean unit embedding); higher = tighter.",
    )
    avg_silhouette: Optional[float] = Field(
        None,
        ge=-1.0,
        le=1.0,
        description="Mean per-item silhouette of members.",
    )
    misplaced_items_count: Optional[int] = Field(
        None,
        ge=0,
        description="Members with negative silhouette (worth hiding or re-ranking).",
    )
    is_noise: bool = Field(
        False,
        description="True only for the optional 'Noise/Outliers' bucket.",
    )
    items: List[VideoItem]


class ClusteredSearchResponse(BaseModel):
    query: str = Field(
        "",
        description="Echo of the request query; empty string when query was None.",
    )
    total_results: int
    n_clusters: int = Field(..., description="Number of clusters actually returned.")
    n_noise: int = Field(0, description="Items in the noise bucket (0 if folded).")
    clusters: List[ClusterItem]
    took_ms: float


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
            "AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL)"
        )
    elif completion_filter == "incomplete":
        conds.append(
            "(COALESCE(NULLIF(title, ''), NULL) IS NULL "
            "OR COALESCE(NULLIF(details, ''), NULL) IS NULL)"
        )


def _build_order_clause(
    sort_col: str,
    order_dir: str,
    distance_sql: Optional[str] = None,
) -> Tuple[str, str]:
    """
    Returns (order_by_sql, sort_key_expr_sql).
    - order_by_sql is the full ORDER BY clause.
    - sort_key_expr_sql is the expression whose value is used in the cursor.
    PostgreSQL forbids aliasing a SELECT-list output inside ORDER BY expressions,
    so for similarity we substitute the raw distance expression.
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
    if not params.get("_cursor_key") and params.get("_cursor_key") is not None:
        pass
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
                f"(({sort_col}, id) {op} (%(_cursor_key)s::{'timestamp with time zone' if sort_col in ('release_date', 'created_at') else 'float8'}, %(_cursor_id)s))"
                f" OR {sort_col} IS NULL"
            )
        params["_cursor_key"] = sort_key
    params["_cursor_id"] = last_id


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
# Subclass: make TextsClusterer safe for a request handler.
# --------------------------------------------------------------------------- #
class _RequestSafeClusterer(TextsClusterer):
    """
    TextsClusterer with the two request-hostile behaviours removed:
      - no t-SNE (hundreds of ms, fragile perplexity for small N, unused)
      - no extra stdout chatter beyond what super() already emits
    Everything else — HDBSCAN/Spectral selection, probabilities, centroids,
    consistency scores, silhouette — is inherited unchanged.
    """

    def _generate_2d_coordinates(self) -> None:
        n = len(self.embeddings) if self.embeddings is not None else 0
        self.coordinates_2d = np.zeros((n, 2), dtype=np.float32)


# --------------------------------------------------------------------------- #
# Cluster-count reconciliation: honor req.n_clusters even when the auto-pick
# (HDBSCAN / Spectral) lands on a different k.
# --------------------------------------------------------------------------- #
def _reconcile_k(
    embeddings: np.ndarray,
    labels: np.ndarray,
    target_k: int,
    rng_seed: int = 42,
) -> np.ndarray:
    """
    Force `labels` to contain exactly `target_k` non-noise clusters.
      - Too many: merge the two whose centroids are most cosine-similar.
      - Too few: split the largest cluster with a 2-way KMeans.
      - Noise (-1) is left alone; folding happens later in the endpoint.
    """
    labels = labels.copy()

    def _centroids(lbl: np.ndarray) -> Dict[int, np.ndarray]:
        out: Dict[int, np.ndarray] = {}
        for cid in np.unique(lbl):
            if cid == -1:
                continue
            c = embeddings[lbl == cid].mean(axis=0)
            n = np.linalg.norm(c)
            out[int(cid)] = c / n if n > 0 else c
        return out

    # --- merge down ---
    while True:
        cents = _centroids(labels)
        if len(cents) <= target_k:
            break
        cids = list(cents.keys())
        mat = np.vstack([cents[c] for c in cids])
        sim = cosine_similarity(mat)
        np.fill_diagonal(sim, -np.inf)
        i, j = np.unravel_index(np.argmax(sim), sim.shape)
        keep, drop = cids[i], cids[j]
        labels[labels == drop] = keep

    # --- split up ---
    while True:
        cids = [c for c in np.unique(labels) if c != -1]
        if len(cids) >= target_k:
            break
        sizes = {c: int((labels == c).sum()) for c in cids}
        biggest = max(sizes, key=sizes.get)
        mask = labels == biggest
        sub = embeddings[mask]
        if sub.shape[0] < 2:
            break
        km = KMeans(n_clusters=2, random_state=rng_seed, n_init="auto").fit(sub)
        next_id = max(int(c) for c in np.unique(labels)) + 1
        labels[mask] = np.where(km.labels_ == 0, biggest, next_id)

    return labels


# --------------------------------------------------------------------------- #
# Fold noise back into the nearest centroid cluster.
# --------------------------------------------------------------------------- #
def _fold_noise(
    embeddings: np.ndarray,
    labels: np.ndarray,
) -> Tuple[np.ndarray, int]:
    """
    Reassign every -1 label to the non-noise cluster whose centroid is
    cosine-closest to that item. Returns (new_labels, n_folded).
    If there are no non-noise clusters, everything becomes cluster 0.
    """
    labels = labels.copy()
    noise_mask = labels == -1
    n_folded = int(noise_mask.sum())
    if n_folded == 0:
        return labels, 0

    cids = [c for c in np.unique(labels) if c != -1]
    if not cids:
        labels[noise_mask] = 0
        return labels, n_folded

    cents = np.vstack([embeddings[labels == c].mean(axis=0) for c in cids])
    norms = np.linalg.norm(cents, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    cents = cents / norms

    sims = cosine_similarity(embeddings[noise_mask], cents)
    nearest = np.argmax(sims, axis=1)
    labels[noise_mask] = np.asarray(cids)[nearest]
    return labels, n_folded


# --------------------------------------------------------------------------- #
# Recompute metric bundle after a label change (reconcile / fold).
# Mirrors cluster_utils' _calculate_centroids + _calculate_silhouette_scores
# so the numbers stay consistent with what TextsClusterer would produce.
# --------------------------------------------------------------------------- #
def _refresh_cluster_metrics(
    clusterer: "_RequestSafeClusterer",
    matrix: np.ndarray,
    labels: np.ndarray,
) -> None:
    normalized = normalize(matrix)
    clusterer.labels = labels
    clusterer.probabilities = calculate_custom_confidence(normalized, labels)

    centroids: Dict[int, np.ndarray] = {}
    consistency: Dict[int, float] = {}
    for cid in np.unique(labels):
        if cid == -1:
            continue
        sub = normalized[labels == cid]
        raw = sub.mean(axis=0)
        n = np.linalg.norm(raw)
        consistency[int(cid)] = float(n)
        centroids[int(cid)] = raw / n if n > 0 else raw
    clusterer.centroids = centroids
    clusterer.cluster_consistency = consistency

    sil = np.zeros(len(labels), dtype=np.float32)
    mask = labels != -1
    if mask.sum() >= 2 and np.unique(labels[mask]).size >= 2:
        try:
            sil[mask] = silhouette_samples(
                normalized[mask], labels[mask], metric="cosine"
            )
        except Exception:
            pass
    clusterer.silhouette_scores = sil


# --------------------------------------------------------------------------- #
# Candidate fetch — query branch and query-less branch.
# --------------------------------------------------------------------------- #
def _fetch_clustered_candidates(
    req: ClusteredSearchRequest,
) -> List[dict]:
    params: dict = {"limit": req.cluster_candidate_limit}
    conds: List[str] = ["embedding IS NOT NULL"]
    _apply_filters(req, params, conds)

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

    # query-less branch
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


# --------------------------------------------------------------------------- #
# Endpoint
# --------------------------------------------------------------------------- #
@app.post("/search_clustered", response_model=ClusteredSearchResponse)
def search_clustered(req: ClusteredSearchRequest) -> ClusteredSearchResponse:
    t0 = time.perf_counter()

    # ---- 1. Fetch candidates ----
    try:
        rows = _fetch_clustered_candidates(req)
    except Exception as e:
        logger.error("search_clustered DB error: %s", e)
        raise HTTPException(500, f"Search failed: {e}")

    if not rows:
        return ClusteredSearchResponse(
            query=req.query or "",
            total_results=0,
            n_clusters=0,
            n_noise=0,
            clusters=[],
            took_ms=(time.perf_counter() - t0) * 1000,
        )

    # ---- 2. Embedding matrix ----
    matrix = np.asarray(
        [_to_float_list(r["embedding"]) for r in rows], dtype=np.float32
    )

    # ---- 3. Degenerate: fewer rows than requested clusters ----
    if len(rows) < req.n_clusters:
        items: List[VideoItem] = []
        for r in rows:
            sim = (1.0 - r["distance"]) if r["distance"] is not None else None
            item = _row_to_item(r, similarity=sim)
            item.probability = 1.0 if len(rows) == 1 else None
            item.silhouette = 0.0
            item.distance_to_centroid = 0.0
            items.append(item)
        clusters = (
            [
                ClusterItem(
                    cluster_id=0,
                    size=len(items),
                    centroid_similarity=(
                        float(
                            np.mean(
                                [
                                    i.similarity
                                    for i in items
                                    if i.similarity is not None
                                ]
                            )
                        )
                        if req.query is not None and items
                        else None
                    ),
                    consistency_score=1.0 if len(items) == 1 else None,
                    avg_silhouette=0.0,
                    misplaced_items_count=0,
                    is_noise=False,
                    items=items,
                )
            ]
            if items
            else []
        )
        return ClusteredSearchResponse(
            query=req.query or "",
            total_results=len(rows),
            n_clusters=len(clusters),
            n_noise=0,
            clusters=clusters,
            took_ms=(time.perf_counter() - t0) * 1000,
        )

    # ---- 4. Cluster: pass DB embeddings straight in (no re-embedding) ----
    texts = [f"{r['id']}" for r in rows]
    clusterer = _RequestSafeClusterer(
        min_cluster_size=req.min_cluster_size,
        cluster_selection_epsilon=req.cluster_selection_epsilon,
    )
    try:
        clusterer.fit_predict(
            texts,
            indices=list(range(len(rows))),
            deduplicate=False,
            embeddings=matrix,
        )
    except Exception:
        logger.exception("clustering failed; falling back to single cluster")
        _refresh_cluster_metrics(clusterer, matrix, np.zeros(len(rows), dtype=int))

    # ---- 5. Force exactly req.n_clusters non-noise groups ----
    labels = np.asarray(clusterer.labels)
    auto_k = len([c for c in np.unique(labels) if c != -1])
    if auto_k != req.n_clusters:
        labels = _reconcile_k(matrix, labels, req.n_clusters)
        _refresh_cluster_metrics(clusterer, matrix, labels)

    # ---- 6. Handle the noise bucket ----
    labels = np.asarray(clusterer.labels)
    n_noise_raw = int((labels == -1).sum())
    if req.include_noise:
        n_noise = n_noise_raw
    else:
        labels, _ = _fold_noise(normalize(matrix), labels)
        _refresh_cluster_metrics(clusterer, matrix, labels)
        n_noise = 0

    # ---- 7. Assemble per-item items with metric annotations ----
    normalized_matrix = normalize(matrix)
    items_by_cluster: Dict[int, List[VideoItem]] = {}
    for i, r in enumerate(rows):
        cid = int(labels[i])
        sim = (1.0 - r["distance"]) if r["distance"] is not None else None
        item = _row_to_item(r, similarity=sim)
        item.probability = (
            float(clusterer.probabilities[i])
            if clusterer.probabilities is not None
            else None
        )
        item.silhouette = (
            float(clusterer.silhouette_scores[i])
            if clusterer.silhouette_scores is not None
            else None
        )
        if cid in clusterer.centroids:
            cent = clusterer.centroids[cid].reshape(1, -1)
            sim_centroid = float(
                cosine_similarity(normalized_matrix[i : i + 1], cent)[0, 0]
            )
            item.distance_to_centroid = 1.0 - sim_centroid
        else:
            item.distance_to_centroid = 0.0
        items_by_cluster.setdefault(cid, []).append(item)

    # ---- 8. Sort items inside each cluster: core items first ----
    for items in items_by_cluster.values():
        items.sort(
            key=lambda it: (
                it.silhouette if it.silhouette is not None else 0.0,
                it.probability if it.probability is not None else 0.0,
                it.similarity if it.similarity is not None else 0.0,
            ),
            reverse=True,
        )

    # ---- 9. Build ClusterItem list ----
    clusters: List[ClusterItem] = []
    for cid, items in items_by_cluster.items():
        sils = [it.silhouette for it in items if it.silhouette is not None]
        misplaced = sum(1 for s in sils if s < 0)
        centroid_sim = None
        if req.query is not None and items:
            sims = [it.similarity for it in items if it.similarity is not None]
            if sims:
                centroid_sim = float(np.mean(sims))
        clusters.append(
            ClusterItem(
                cluster_id=cid,
                label="Noise/Outliers" if cid == -1 else None,
                size=len(items),
                centroid_similarity=centroid_sim,
                consistency_score=(
                    clusterer.cluster_consistency.get(cid) if cid != -1 else 0.0
                ),
                avg_silhouette=float(np.mean(sils)) if sils else None,
                misplaced_items_count=misplaced,
                is_noise=(cid == -1),
                items=items,
            )
        )

    # ---- 10. Sort clusters: cohesion-weighted, noise bucket last ----
    clusters.sort(
        key=lambda c: (
            c.is_noise,
            -((c.consistency_score or 0.0) * c.size),
        )
    )

    took = (time.perf_counter() - t0) * 1000
    logger.info(
        "search_clustered ok query=%s rows=%d k=%d noise=%d took=%.1fms",
        bool(req.query),
        len(rows),
        len(clusters),
        n_noise,
        took,
    )
    return ClusteredSearchResponse(
        query=req.query or "",
        total_results=len(rows),
        n_clusters=len(clusters),
        n_noise=n_noise,
        clusters=clusters,
        took_ms=took,
    )


def _to_float_list(value) -> List[float]:
    """
    Normalize a pgvector column value into a plain list[float].

    pgvector has shipped several Vector variants across versions:
      - pgvector.Vector           -> has .to_list() (and sometimes .tolist())
      - pgvector._vector.Vector   -> C-extension, has .to_numpy() / .to_list()
      - plain list/tuple of floats
      - str like "[0.1,0.2,...]"  (rare, but seen with some cursor/dict paths)
    Be defensive so we never fall into `list(Vector)` which raises TypeError.
    """
    if value is None:
        return []
    # Native python sequence
    if isinstance(value, (list, tuple)):
        return [float(x) for x in value]
    # pgvector.Vector variants
    for attr in ("to_list", "tolist"):
        fn = getattr(value, attr, None)
        if callable(fn):
            return [float(x) for x in fn()]
    # numpy-backed variants
    fn = getattr(value, "to_numpy", None)
    if callable(fn):
        return [float(x) for x in fn().tolist()]
    # Last resort: buffer protocol (C ext Vector in some builds)
    try:
        return [float(x) for x in memoryview(value).cast("f")]
    except Exception:
        pass
    # Textual form
    if isinstance(value, str):
        s = value.strip().strip("[]")
        return [float(x) for x in s.split(",") if x.strip()]
    raise TypeError(
        f"Unsupported embedding value: type={type(value).__name__} "
        f"dir={[a for a in dir(value) if not a.startswith('__')][:20]}"
    )


@app.post("/similar", response_model=SearchResponse)
def similar(req: SimilarRequest) -> SearchResponse:
    t0 = time.perf_counter()
    with pool.connection() as conn:
        src = conn.execute(
            "SELECT embedding FROM public.videos WHERE id = %s", (req.video_id,)
        ).fetchone()

    # ---- DEBUG: inspect what the driver actually returns ----
    raw_emb = src["embedding"] if src else None
    logger.info(
        "similar debug: video_id=%r src_present=%s raw_emb_type=%s mro=%s "
        "has_tolist=%s has_to_list=%s has_to_numpy=%s has_iter=%s has_getitem=%s "
        "dir_sample=%s",
        req.video_id,
        src is not None,
        type(raw_emb).__name__,
        [c.__name__ for c in type(raw_emb).__mro__] if raw_emb is not None else None,
        hasattr(raw_emb, "tolist"),
        hasattr(raw_emb, "to_list"),
        hasattr(raw_emb, "to_numpy"),
        hasattr(raw_emb, "__iter__"),
        hasattr(raw_emb, "__getitem__"),
        [a for a in dir(raw_emb) if not a.startswith("__")][:40]
        if raw_emb is not None
        else None,
    )
    # ---------------------------------------------------------

    if not src or raw_emb is None:
        raise HTTPException(404, "Source video or embedding not found")

    emb = _to_float_list(raw_emb)
    logger.info(
        "similar debug: emb resolved type=%s len=%s sample=%s",
        type(emb).__name__,
        len(emb),
        emb[:3],
    )

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
):
    """
    Stable, id-ordered listing for sync/export tooling.
    Unlike /browse, this never applies a `release_date IS NOT NULL` guard,
    never uses a keyset cursor, and sorts by `id ASC` so offset pagination
    is deterministic across concurrent inserts.
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
    where_sql = " AND ".join(conds) if conds else "TRUE"
    select_cols = _VLIST_FIELDS[fields]
    if fields == "summary":
        select_cols = (
            "id, code, episode, title, release_date, "
            "(COALESCE(NULLIF(title, ''), NULL) IS NOT NULL "
            " AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL) AS complete"
        )
    sql = f"""
        SELECT {select_cols}
        FROM public.videos
        WHERE {where_sql}
        ORDER BY id ASC
        LIMIT %(limit)s OFFSET %(offset)s
    """
    with pool.connection() as conn:
        rows = conn.execute(sql, params).fetchall()
    took = (time.perf_counter() - t0) * 1000
    return VideoListResponse(
        items=[dict(r) for r in rows],
        count=len(rows),
        took_ms=took,
    )


def _completion_filter_sql(completion_filter: CompletionFilter) -> str:
    if completion_filter == "complete":
        return (
            "AND COALESCE(NULLIF(title, ''), NULL) IS NOT NULL "
            "AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL"
        )
    elif completion_filter == "incomplete":
        return (
            "AND (COALESCE(NULLIF(title, ''), NULL) IS NULL "
            "OR COALESCE(NULLIF(details, ''), NULL) IS NULL)"
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


@app.get("/health")
def health():
    t0 = time.perf_counter()
    with pool.connection() as conn:
        conn.execute("SELECT 1").fetchone()
    return {"ok": True, "db_ms": (time.perf_counter() - t0) * 1000}


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
