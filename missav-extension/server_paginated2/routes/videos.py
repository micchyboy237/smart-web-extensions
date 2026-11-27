from datetime import datetime
from typing import Annotated, List, Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from models.schemas.video import (
    DiscoverRequest,
    GroupedSearchRequest,
    GroupedSearchResponse,
    HybridRequest,
    IngestRequest,
    IngestResponse,
    SearchRequest,
    SearchResponse,
    SimilarRequest,
    VideoItem,
    VideoListResponse,
)
from models.types.common import CompletionFilter, VideoSearchMode
from services.utils import embed_query
from services.video_service import (
    browse_videos,
    discover_videos,
    get_video,
    grouped_search_core,
    hybrid_search,
    ingest_videos,
    list_videos,
    search_video,
    similar_video,
)

router = APIRouter()


@router.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    return search_video(req)


@router.post("/similar", response_model=SearchResponse)
def similar(req: SimilarRequest) -> SearchResponse:
    return similar_video(req)


@router.post("/hybrid", response_model=SearchResponse)
def hybrid(req: HybridRequest) -> SearchResponse:
    return hybrid_search(req)


@router.get("/browse", response_model=SearchResponse)
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
    return browse_videos(
        limit, offset, genre, genres_mode, code, sort, order, completion_filter
    )


@router.get("/videos/{video_id}", response_model=VideoItem)
def get_video_endpoint(video_id: str):
    return get_video(video_id)


@router.get("/videos", response_model=VideoListResponse)
def list_videos_endpoint(
    code: Annotated[Optional[List[str]], Query()] = None,
    genre: Annotated[Optional[List[str]], Query()] = None,
    genres_mode: Literal["any", "all"] = "any",
    completion_filter: CompletionFilter = Query("all"),
    min_release_date: Optional[datetime] = None,
    max_release_date: Optional[datetime] = None,
    limit: Optional[int] = Query(None, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    fields: Literal["id", "summary", "full"] = "summary",
    query: Optional[str] = Query(None, min_length=1),
    mode: VideoSearchMode = Query("semantic"),
    search_sort: Literal["relevance", "id"] = Query("relevance"),
    min_similarity: Optional[float] = Query(None, ge=0.0, le=1.0),
):
    return list_videos(
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
    )


@router.post("/discover", response_model=VideoListResponse)
def discover(req: DiscoverRequest) -> VideoListResponse:
    return discover_videos(req)


@router.post("/ingest", response_model=IngestResponse)
def ingest(req: IngestRequest) -> IngestResponse:
    return ingest_videos(req)


@router.get("/search_grouped", response_model=GroupedSearchResponse)
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
    cursor: Optional[str] = Query(None),
    fetch_k: Optional[int] = Query(None, ge=1, le=10000),
    diversity: float = Query(0.0, ge=0.0, le=1.0),
):
    if query is None and min_similarity is not None:
        raise HTTPException(400, "min_similarity requires a query")
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
    emb = list(embed_query(query)) if query is not None else None
    return grouped_search_core(
        tag="search_grouped", req=req, emb=emb, limit=limit, cursor=cursor
    )


@router.get("/similar_grouped", response_model=GroupedSearchResponse)
def similar_grouped(
    video_id: str = Query(..., min_length=1),
    code: Annotated[Optional[List[str]], Query()] = None,
    genre: Annotated[Optional[List[str]], Query()] = None,
    genres_mode: Literal["any", "all"] = "any",
    min_release_date: Optional[datetime] = None,
    max_release_date: Optional[datetime] = None,
    completion_filter: CompletionFilter = Query("all"),
    min_similarity: Optional[float] = Query(None, ge=0.0, le=1.0),
    limit: int = Query(50, ge=1, le=500),
    cursor: Optional[str] = Query(None),
    fetch_k: Optional[int] = Query(None, ge=1, le=10000),
    diversity: float = Query(0.0, ge=0.0, le=1.0),
):
    import time

    from db import pool

    t0 = time.perf_counter()
    with pool.connection() as conn:
        src = conn.execute(
            "SELECT embedding, code, episode FROM public.videos WHERE id = %s",
            (video_id,),
        ).fetchone()
    if not src or src["embedding"] is None:
        raise HTTPException(404, "Source video or embedding not found")
    from services.utils import to_float_list

    emb = to_float_list(src["embedding"])
    req = GroupedSearchRequest(
        video_id=video_id,
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
    return grouped_search_core(
        tag="similar_grouped",
        req=req,
        emb=emb,
        limit=limit,
        cursor=cursor,
        exclude_group=(src["code"], src["episode"]),
    )


@router.get("/facets")
def facets(top_genres: int = 60, top_codes: int = 40, completion_filter: str = "all"):
    from db import pool

    def _completion_filter_sql(cf: str) -> str:
        if cf == "complete":
            return "AND COALESCE(NULLIF(title, ''), NULL) IS NOT NULL AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL AND release_date IS NOT NULL AND genres IS NOT NULL AND cardinality(genres) > 0"
        elif cf == "incomplete":
            return "AND (COALESCE(NULLIF(title, ''), NULL) IS NULL OR COALESCE(NULLIF(details, ''), NULL) IS NULL OR release_date IS NULL OR genres IS NULL OR cardinality(genres) = 0)"
        return ""

    extra = _completion_filter_sql(completion_filter)
    with pool.connection() as conn:
        genres = conn.execute(
            f"SELECT g AS name, COUNT(*)::int AS count FROM public.videos, unnest(genres) AS g WHERE genres IS NOT NULL {extra} GROUP BY g ORDER BY count DESC NULLS LAST LIMIT %s",
            (top_genres,),
        ).fetchall()
        codes = conn.execute(
            f"SELECT code, COUNT(*)::int AS count FROM public.videos WHERE TRUE {extra} GROUP BY code ORDER BY count DESC LIMIT %s",
            (top_codes,),
        ).fetchall()
        years = conn.execute(
            f"SELECT EXTRACT(YEAR FROM release_date)::int AS year, COUNT(*)::int AS count FROM public.videos WHERE release_date IS NOT NULL {extra} GROUP BY 1 ORDER BY 1"
        ).fetchall()
    return {
        "genres": [{"name": r["name"], "count": r["count"]} for r in genres],
        "codes": [{"code": r["code"], "count": r["count"]} for r in codes],
        "years": [{"year": r["year"], "count": r["count"]} for r in years],
    }


@router.get("/facets/codes")
def facets_codes(completion_filter: str = "all"):
    from db import pool

    def _completion_filter_sql(cf: str) -> str:
        if cf == "complete":
            return "AND COALESCE(NULLIF(title, ''), NULL) IS NOT NULL AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL AND release_date IS NOT NULL AND genres IS NOT NULL AND cardinality(genres) > 0"
        elif cf == "incomplete":
            return "AND (COALESCE(NULLIF(title, ''), NULL) IS NULL OR COALESCE(NULLIF(details, ''), NULL) IS NULL OR release_date IS NULL OR genres IS NULL OR cardinality(genres) = 0)"
        return ""

    extra = _completion_filter_sql(completion_filter)
    with pool.connection() as conn:
        codes = conn.execute(
            f"SELECT code, COUNT(*)::int AS count, SUM(CASE WHEN COALESCE(NULLIF(title, ''), NULL) IS NOT NULL AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL AND release_date IS NOT NULL AND genres IS NOT NULL AND cardinality(genres) > 0 THEN 1 ELSE 0 END)::int AS completed FROM public.videos WHERE code IS NOT NULL {extra} GROUP BY code ORDER BY count DESC"
        ).fetchall()
        return {
            "code_count": len(codes),
            "codes": [
                {"code": r["code"], "count": r["count"], "completed": r["completed"]}
                for r in codes
            ],
        }


@router.get("/facets/genres")
def facets_genres(completion_filter: str = "all"):
    from db import pool

    def _completion_filter_sql(cf: str) -> str:
        if cf == "complete":
            return "AND COALESCE(NULLIF(title, ''), NULL) IS NOT NULL AND COALESCE(NULLIF(details, ''), NULL) IS NOT NULL AND release_date IS NOT NULL AND genres IS NOT NULL AND cardinality(genres) > 0"
        elif cf == "incomplete":
            return "AND (COALESCE(NULLIF(title, ''), NULL) IS NULL OR COALESCE(NULLIF(details, ''), NULL) IS NULL OR release_date IS NULL OR genres IS NULL OR cardinality(genres) = 0)"
        return ""

    extra = _completion_filter_sql(completion_filter)
    with pool.connection() as conn:
        genres = conn.execute(
            f"SELECT g AS name, COUNT(*)::int AS count FROM public.videos, unnest(genres) AS g WHERE genres IS NOT NULL {extra} GROUP BY g ORDER BY count DESC NULLS LAST"
        ).fetchall()
        return {
            "genre_count": len(genres),
            "genres": [{"name": r["name"], "count": r["count"]} for r in genres],
        }
