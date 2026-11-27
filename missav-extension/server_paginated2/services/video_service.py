import logging
import time
from typing import List, Optional, Tuple

import numpy as np
from config import ITERATIVE_SCAN_MODE, MAX_SCAN_TUPLES
from db import pool
from fastapi import HTTPException
from jet.adapters.llama_cpp.chunking_utils import truncate_texts
from jet.adapters.llama_cpp.config import EMBED_DOC_PREFIX, EMBED_MODEL
from jet.adapters.llama_cpp.diversity_utils.mmr import mmr_rerank
from jet.adapters.llama_cpp.diversity_utils.semhash import (
    compute_shuffle_fetch_k,
    shuffle_and_diversify,
)
from jet.adapters.llama_cpp.embed_utils import embed
from models.schemas.video import (
    DiscoverRequest,
    GroupedSearchRequest,
    GroupedSearchResponse,
    GroupedVideoItem,
    HybridRequest,
    IngestRequest,
    IngestResponse,
    SearchRequest,
    SearchResponse,
    SimilarRequest,
    VideoIngestItem,
    VideoItem,
    VideoListResponse,
)

from services.utils import (
    clean_fields,
    decode_cursor,
    decode_grouped_cursor,
    embed_query,
    encode_cursor,
    encode_grouped_cursor,
    fingerprint,
    grouped_fingerprint,
    normalize_episode,
    normalize_list_input,
    to_float_list,
)

logger = logging.getLogger(__name__)


def apply_filters(req, params: dict, conds: List[str]) -> None:
    genre_list = normalize_list_input(getattr(req, "genre", None))
    if genre_list:
        mode = getattr(req, "genres_mode", "any")
        op = "@>" if mode == "all" else "&&"
        conds.append(f"genres {op} %(genres)s::text[]")
        params["genres"] = genre_list
    code_list = normalize_list_input(getattr(req, "code", None))
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


def build_order_clause(
    sort_col: str, order_dir: str, distance_sql: Optional[str] = None
) -> Tuple[str, str]:
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


def cursor_predicate(
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


def row_to_item(r: dict, similarity: Optional[float] = None) -> VideoItem:
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


def search_video(req: SearchRequest) -> SearchResponse:
    t0 = time.perf_counter()
    fp = fingerprint(req)
    sort_key: Optional[str] = None
    last_id: Optional[str] = None
    if req.cursor:
        sort_key, last_id = decode_cursor(req.cursor, fp)

    emb = list(embed_query(req.query))
    params: dict = {"emb": emb, "limit": req.limit + 1}
    conds: List[str] = []
    apply_filters(req, params, conds)

    if req.min_similarity is not None:
        conds.append("(embedding <=> %(emb)s::vector) <= %(max_dist)s")
        params["max_dist"] = 1.0 - req.min_similarity

    distance_sql = "(embedding <=> %(emb)s::vector)"
    order_clause, _ = build_order_clause(req.sort, req.order, distance_sql=distance_sql)

    if last_id is not None:
        params["_cursor_key"] = sort_key
        params["_cursor_id"] = last_id
        cursor_predicate(req.sort, req.order, params, conds, distance_sql=distance_sql)

    where_sql = " AND ".join(conds) if conds else "TRUE"
    sql = f"""
        SELECT id, title, details, url, code, episode, release_date, genres,
               thumbnail, preview, {distance_sql} AS distance
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
                if isinstance(sv, type(req.min_release_date))
                else (str(sv) if sv is not None else None)
            )
        next_cursor = encode_cursor(key_val, last["id"], fp)

    took = (time.perf_counter() - t0) * 1000
    return SearchResponse(
        items=[row_to_item(r) for r in rows],
        next_cursor=next_cursor,
        has_more=has_more,
        took_ms=took,
    )


def similar_video(req: SimilarRequest) -> SearchResponse:
    t0 = time.perf_counter()
    with pool.connection() as conn:
        src = conn.execute(
            "SELECT embedding FROM public.videos WHERE id = %s", (req.video_id,)
        ).fetchone()

    raw_emb = src["embedding"] if src else None
    if not src or raw_emb is None:
        raise HTTPException(404, "Source video or embedding not found")

    emb = to_float_list(raw_emb)

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
    fp = fingerprint(synthetic)
    sort_key: Optional[str] = None
    last_id: Optional[str] = None
    if req.cursor:
        sort_key, last_id = decode_cursor(req.cursor, fp)

    params: dict = {"emb": emb, "limit": req.limit + 1}
    conds: List[str] = ["id <> %(src)s"]
    params["src"] = req.video_id
    apply_filters(synthetic, params, conds)

    distance_sql = "(embedding <=> %(emb)s::vector)"
    order_clause, _ = build_order_clause(req.sort, req.order, distance_sql=distance_sql)

    if last_id is not None:
        params["_cursor_key"] = sort_key
        params["_cursor_id"] = last_id
        cursor_predicate(req.sort, req.order, params, conds, distance_sql=distance_sql)

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
                if isinstance(sv, type(req.min_release_date))
                else (str(sv) if sv is not None else None)
            )
        next_cursor = encode_cursor(key_val, last["id"], fp)

    took = (time.perf_counter() - t0) * 1000
    return SearchResponse(
        items=[row_to_item(r) for r in rows],
        next_cursor=next_cursor,
        has_more=has_more,
        took_ms=took,
    )


def hybrid_search(req: HybridRequest) -> SearchResponse:
    t0 = time.perf_counter()
    emb = list(embed_query(req.query))
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
    apply_filters(vec_req, vec_params, vec_conds)
    vec_where = " AND ".join(vec_conds) if vec_conds else "TRUE"

    fts_params: dict = {"q": req.query, "limit": cand}
    fts_conds = [
        "title IS NOT NULL",
        "to_tsvector('english', title) @@ plainto_tsquery('english', %(q)s)",
    ]
    apply_filters(vec_req, fts_params, fts_conds)
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
                                plainto_tsquery('english', %(q)s)) DESC, id
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
    items = [row_to_item(by_id[v_id], similarity=None) for v_id, _ in ordered]
    took = (time.perf_counter() - t0) * 1000
    return SearchResponse(items=items, next_cursor=None, has_more=False, took_ms=took)


def browse_videos(
    limit: int, offset: int, genre, genres_mode, code, sort, order, completion_filter
) -> SearchResponse:
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
    apply_filters(req_obj, params, conds)
    where_sql = " AND ".join(conds) if conds else "TRUE"
    order_clause, _ = build_order_clause(sort, order)

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
        items=[row_to_item(r, similarity=None) for r in rows],
        next_cursor=str(offset + limit) if has_more else None,
        has_more=has_more,
        took_ms=took,
    )


def get_video(video_id: str) -> VideoItem:
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
    return row_to_item(r, similarity=None)


def list_videos(
    code,
    genre,
    genres_mode,
    completion_filter,
    min_release_date,
    max_release_date,
    limit,
    offset,
    fields,
    query,
    mode,
    search_sort,
    min_similarity,
) -> VideoListResponse:
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
    apply_filters(req, params, conds)

    _VLIST_FIELDS = {
        "id": "id",
        "summary": "id, code, episode, title, release_date, complete",
        "full": "id, title, details, url, code, episode, release_date, genres, thumbnail, preview",
    }
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
    emb: Optional[List[float]] = None
    if use_semantic:
        emb = list(embed_query(query))
        params["emb"] = emb

    if query is not None:
        if mode == "fts":
            conds.append(
                "title IS NOT NULL AND to_tsvector('english', title) @@ plainto_tsquery('english', %(q)s)"
            )
            params["q"] = query
            if search_sort == "relevance":
                order_sql = "ORDER BY ts_rank_cd(to_tsvector('english', title), plainto_tsquery('english', %(q)s)) DESC, id ASC"
        elif mode == "semantic":
            conds.append("embedding IS NOT NULL")
            distance_sql = "(embedding <=> %(emb)s::vector)"
            similarity_sql = f"GREATEST(0.0, LEAST(1.0, 1.0 - {distance_sql}))"
            if min_similarity is not None:
                conds.append(f"{distance_sql} <= %(max_dist)s")
                params["max_dist"] = 1.0 - float(min_similarity)
            if fields != "id":
                extra_select.append(f"{similarity_sql} AS similarity")
            if search_sort == "relevance":
                order_sql = f"ORDER BY {distance_sql} ASC, id ASC"
        elif mode == "hybrid":
            params["q"] = query
            params["rrf_k"] = 60
            params["cand_limit"] = max(eff_limit + offset, 200)
            base_conds = list(conds)
            base_where = " AND ".join(base_conds) if base_conds else "TRUE"
            if min_similarity is not None:
                sem_cond = "(embedding IS NOT NULL AND (embedding <=> %(emb)s::vector) <= %(max_dist)s)"
                params["max_dist"] = 1.0 - float(min_similarity)
            else:
                sem_cond = "embedding IS NOT NULL"
            params["emb"] = list(embed_query(query))

            sql = f"""
                WITH vec AS (
                    SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> %(emb)s::vector, id) AS rn
                    FROM public.videos WHERE {base_where} AND {sem_cond}
                    ORDER BY embedding <=> %(emb)s::vector, id LIMIT %(cand_limit)s
                ),
                fts AS (
                    SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(to_tsvector('english', title), plainto_tsquery('english', %(q)s)) DESC, id) AS rn
                    FROM public.videos WHERE {base_where} AND title IS NOT NULL AND to_tsvector('english', title) @@ plainto_tsquery('english', %(q)s)
                    ORDER BY ts_rank_cd(to_tsvector('english', title), plainto_tsquery('english', %(q)s)) DESC, id LIMIT %(cand_limit)s
                ),
                fused AS (
                    SELECT id, SUM(1.0 / (%(rrf_k)s + rn))::float8 AS score
                    FROM (SELECT id, rn FROM vec UNION ALL SELECT id, rn FROM fts) u
                    GROUP BY id
                )
                SELECT v.id, v.title, v.details, v.url, v.code, v.episode, v.release_date, v.genres, v.thumbnail, v.preview, f.score AS score
                FROM fused f JOIN public.videos v ON v.id = f.id
                ORDER BY f.score DESC, v.id ASC LIMIT %(limit)s OFFSET %(offset)s
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
                items=[dict(r) for r in rows], count=len(rows), took_ms=took
            )

    where_sql = " AND ".join(conds) if conds else "TRUE"
    select_full = ", ".join([select_cols] + extra_select)
    sql = f"""
        SELECT {select_full} FROM public.videos WHERE {where_sql} {order_sql} LIMIT %(limit)s OFFSET %(offset)s
    """
    with pool.connection() as conn:
        if use_semantic and ITERATIVE_SCAN_MODE:
            conn.execute(f"SET LOCAL hnsw.iterative_scan = {ITERATIVE_SCAN_MODE}")
            conn.execute(f"SET LOCAL hnsw.max_scan_tuples = {int(MAX_SCAN_TUPLES)}")
        rows = conn.execute(sql, params).fetchall()

    took = (time.perf_counter() - t0) * 1000
    return VideoListResponse(
        items=[dict(r) for r in rows], count=len(rows), took_ms=took
    )


def discover_videos(req: DiscoverRequest) -> VideoListResponse:
    t0 = time.perf_counter()
    fetch_k = compute_shuffle_fetch_k(req.limit)
    params: dict = {"limit": fetch_k}
    conds: List[str] = ["embedding IS NOT NULL"]

    class FilterReq:
        def __init__(self, source_req):
            self.genre = source_req.genre
            self.genres_mode = source_req.genres_mode
            self.code = source_req.code
            self.min_release_date = source_req.min_release_date
            self.max_release_date = source_req.max_release_date
            self.completion_filter = source_req.completion_filter

    filter_req = FilterReq(req)
    apply_filters(filter_req, params, conds)
    where_sql = " AND ".join(conds)
    has_query = req.query is not None
    emb = None
    if has_query:
        emb = list(embed_query(req.query))
        params["emb"] = emb
        distance_sql = "(embedding <=> %(emb)s::vector)"
        order_sql = f"ORDER BY {distance_sql} ASC"
        select_cols = f"id, title, details, url, code, episode, release_date, genres, thumbnail, preview, embedding, {distance_sql} AS distance"
    else:
        order_sql = "ORDER BY random()"
        select_cols = "id, title, details, url, code, episode, release_date, genres, thumbnail, preview, embedding, NULL::float8 AS distance"

    sql = f"SELECT {select_cols} FROM public.videos WHERE {where_sql} {order_sql} LIMIT %(limit)s"
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

    search_results = []
    embeddings_list = []
    for r in rows:
        doc_text = f"{r['title']} {r['details']}" if r["details"] else r["title"]
        score = (1.0 - r["distance"]) if r["distance"] is not None else 1.0
        search_results.append(
            {"id": r["id"], "score": score, "document": doc_text or ""}
        )
        embeddings_list.append(to_float_list(r["embedding"]))

    embeddings_matrix = np.array(embeddings_list, dtype=np.float32)
    diversified_results = shuffle_and_diversify(
        results=search_results,
        top_k=req.limit,
        diversity=req.diversity,
        seed=req.seed,
        relevance_bias=1.0,
        embeddings=embeddings_matrix,
    )

    row_map = {r["id"]: r for r in rows}
    final_items = []
    for res in diversified_results:
        original_row = row_map.get(res["id"])
        if original_row:
            sim = (
                (1.0 - original_row["distance"])
                if has_query and original_row["distance"] is not None
                else None
            )
            final_items.append(row_to_item(original_row, similarity=sim))

    took = (time.perf_counter() - t0) * 1000
    return VideoListResponse(
        items=[dict(item) for item in final_items], count=len(final_items), took_ms=took
    )


def ingest_videos(req: IngestRequest) -> IngestResponse:
    t0 = time.perf_counter()
    inserted = updated = skipped = 0
    unique_items_map = {}
    for item in req.items:
        if item.id:
            unique_items_map[item.id] = item
    unique_items = list(unique_items_map.values())
    duplicate_count = len(req.items) - len(unique_items)

    embeddable: List[Tuple[int, VideoIngestItem, str]] = []
    for idx, item in enumerate(unique_items):
        parts: List[str] = []
        clean_title, clean_details = clean_fields(item.title, item.details, item.code)
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
        if text:
            embeddable.append((idx, item, text))
        else:
            skipped += 1

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
        max_tokens=500,
        strict_sentences=False,
        show_progress=False,
    )
    if isinstance(truncated_texts, str):
        truncated_texts = [truncated_texts]

    embeddings = embed(truncated_texts, return_format="list", prefix=EMBED_DOC_PREFIX)

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
    rows: List[tuple] = []
    for (_, item, _), emb in zip(embeddable, embeddings):
        clean_title, clean_details = clean_fields(item.title, item.details, item.code)
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
            url = EXCLUDED.url, code = EXCLUDED.code, episode = EXCLUDED.episode,
            video_id = EXCLUDED.video_id, title = COALESCE(EXCLUDED.title, videos.title),
            thumbnail = COALESCE(EXCLUDED.thumbnail, videos.thumbnail),
            preview = COALESCE(EXCLUDED.preview, videos.preview),
            details = COALESCE(EXCLUDED.details, videos.details),
            release_date = COALESCE(EXCLUDED.release_date, videos.release_date),
            genres = COALESCE(EXCLUDED.genres, videos.genres),
            embedding = EXCLUDED.embedding, updated_at = now()
        RETURNING (xmax = 0) AS inserted"""
        if req.upsert
        else "ON CONFLICT (id) DO NOTHING RETURNING false AS inserted"
    )
    sql = f"INSERT INTO public.videos ({', '.join(_INGEST_COLS)}) VALUES {placeholders} {on_conflict}"

    try:
        with pool.connection() as conn:
            from pgvector.psycopg import register_vector

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
    return IngestResponse(
        inserted=inserted, updated=updated, skipped=skipped, took_ms=took
    )


def grouped_search_core(
    tag: str,
    req: GroupedSearchRequest,
    emb: Optional[List[float]],
    limit: int,
    cursor: Optional[str],
    exclude_group: Optional[Tuple[str, str]] = None,
) -> GroupedSearchResponse:
    t0 = time.perf_counter()
    fp = grouped_fingerprint(req)
    diversity = req.diversity
    fetch_k = req.fetch_k
    min_similarity = req.min_similarity

    anchor: Optional[Tuple[Optional[float], str, str]] = None
    window_offset = 0
    if cursor:
        anchor, window_offset = decode_grouped_cursor(cursor, fp)

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
    apply_filters(req, params, conds)
    if exclude_group is not None:
        params["ex_code"], params["ex_ep"] = exclude_group
        conds.append("NOT (v.code = %(ex_code)s AND v.episode = %(ex_ep)s)")

    query_mode = emb is not None
    distance_sql = ""
    if query_mode:
        params["emb"] = emb
        distance_sql = "(v.embedding <=> %(emb)s::vector)"
        conds.append("v.embedding IS NOT NULL")

    ep_norm_sql = "CASE WHEN btrim(v.episode) ~ '^[0-9]+$' THEN lpad(btrim(v.episode), 8, '0') ELSE lower(btrim(v.episode)) END"
    having: List[str] = []
    if query_mode:
        if min_similarity is not None:
            params["max_dist"] = 1.0 - float(min_similarity)
            having.append(f"MIN({distance_sql}) <= %(max_dist)s")
        if anchor is not None:
            params["cur_dist"] = float(anchor[0])
            params["cur_code"] = anchor[1]
            params["cur_ep"] = anchor[2]
            having.append(
                f"(MIN({distance_sql})::float8, v.code, ({ep_norm_sql})) > (%(cur_dist)s::float8, %(cur_code)s, %(cur_ep)s)"
            )
        score_select = f"MIN({distance_sql})::float8 AS best_distance,"
        order_sql = f"ORDER BY best_distance ASC, v.code ASC, ({ep_norm_sql}) ASC"
    else:
        if anchor is not None:
            params["cur_code"] = anchor[1]
            params["cur_ep"] = anchor[2]
            conds.append(f"(v.code, ({ep_norm_sql})) > (%(cur_code)s, %(cur_ep)s)")
        score_select = "NULL::float8 AS best_distance,"
        order_sql = f"ORDER BY v.code ASC, ({ep_norm_sql}) ASC"

    group_having = ("HAVING " + " AND ".join(having)) if having else ""
    where_sql = " AND ".join(conds)
    diversity_on = diversity > 0.0
    if diversity_on:
        base_fetch = max(fetch_k if fetch_k else limit * 3, limit + 1)
    else:
        base_fetch = limit

    params["limit"] = base_fetch + 1
    embed_select = "AVG(v.embedding) AS group_embedding," if diversity_on else ""

    sql = f"""
        SELECT
            v.code, v.episode,
            (array_agg(v.id ORDER BY CASE WHEN v.url NOT LIKE '%%-uncensored-leak' AND v.url NOT LIKE '%%-english-subtitle' THEN 0 WHEN v.url LIKE '%%-uncensored-leak' THEN 1 ELSE 2 END, v.id))[1] AS id,
            (array_agg(v.video_id ORDER BY CASE WHEN v.url NOT LIKE '%%-uncensored-leak' AND v.url NOT LIKE '%%-english-subtitle' THEN 0 WHEN v.url LIKE '%%-uncensored-leak' THEN 1 ELSE 2 END, v.id))[1] AS video_id,
            count(DISTINCT v.id)::int AS video_count,
            (array_agg(v.title ORDER BY length(v.title) ASC NULLS LAST))[1] AS title,
            (array_agg(v.details ORDER BY length(v.details) ASC NULLS LAST))[1] AS details,
            (array_agg(v.thumbnail ORDER BY v.id))[1] AS thumbnail,
            (array_agg(v.preview ORDER BY v.id))[1] AS preview,
            (array_agg(v.release_date ORDER BY CASE WHEN v.url NOT LIKE '%%-uncensored-leak' AND v.url NOT LIKE '%%-english-subtitle' THEN 0 WHEN v.url LIKE '%%-uncensored-leak' THEN 1 ELSE 2 END, v.id))[1] AS release_date,
            array_agg(DISTINCT g.genre) FILTER (WHERE g.genre IS NOT NULL AND g.genre <> '' AND lower(btrim(g.genre)) NOT IN ('uncensored leak', 'english subtitle')) AS genres,
            (array_agg(v.url ORDER BY v.id) FILTER (WHERE v.url NOT LIKE '%%-uncensored-leak' AND v.url NOT LIKE '%%-english-subtitle'))[1] AS url,
            (array_agg(v.url ORDER BY v.id) FILTER (WHERE v.url LIKE '%%-uncensored-leak'))[1] AS url_uncnsrd,
            (array_agg(v.url ORDER BY v.id) FILTER (WHERE v.url LIKE '%%-english-subtitle'))[1] AS url_engsub,
            {score_select} {embed_select}
            min(v.created_at) AS created_at, max(v.updated_at) AS updated_at
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
        logger.error("%s DB error: %s", tag, e)
        raise HTTPException(500, f"Grouped search failed: {e}")

    has_more_from_db = len(rows) > base_fetch
    window = rows[:base_fetch]
    window_end_anchor: Optional[Tuple[Optional[float], str, str]] = None
    if window:
        last = window[-1]
        bd = last.get("best_distance")
        window_end_anchor = (
            float(bd) if bd is not None else None,
            last["code"],
            normalize_episode(last["episode"]),
        )

    diversity_applied = False
    ordered_window = window
    if diversity_on and window:
        doc_vecs: List[Optional[List[float]]] = []
        for r in window:
            g_emb = r.get("group_embedding")
            doc_vecs.append(to_float_list(g_emb) if g_emb is not None else None)
        mmr_eligible = [i for i, v in enumerate(doc_vecs) if v is not None]
        null_count = len(window) - len(mmr_eligible)
        if null_count:
            logger.warning(
                "%s diversity: %d/%d groups have NULL group_embedding",
                tag,
                null_count,
                len(window),
            )
        if len(mmr_eligible) >= 2:
            matrix = np.array([doc_vecs[i] for i in mmr_eligible], dtype=np.float32)
            query_vec = (
                np.array(emb, dtype=np.float32) if query_mode else matrix.mean(axis=0)
            )
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

    page_rows = ordered_window[window_offset : window_offset + limit]
    consumed = window_offset + len(page_rows)
    window_has_remaining = consumed < len(ordered_window)
    next_cursor: Optional[str] = None
    if window_has_remaining:
        next_cursor = encode_grouped_cursor(anchor, consumed, fp)
        has_more = True
    elif has_more_from_db and window_end_anchor is not None:
        next_cursor = encode_grouped_cursor(window_end_anchor, 0, fp)
        has_more = True
    else:
        has_more = False

    has_previous = cursor is not None
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

    took = (time.perf_counter() - t0) * 1000
    return GroupedSearchResponse(
        items=items,
        count=len(items),
        took_ms=took,
        next_cursor=next_cursor,
        has_more=has_more,
        has_previous=has_previous,
        diversity_applied=diversity_applied,
    )
