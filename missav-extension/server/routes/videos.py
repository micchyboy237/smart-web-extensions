"""Video ingest and retrieval endpoints."""

import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from models.video import CodesResponse, GroupedVideosResponse, VideoBatchIngest
from services import chroma_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/videos", tags=["videos"])


def _parse_codes_param(codes: Optional[str]) -> Optional[list[str]]:
    """Parse a comma-separated 'codes' query param into a clean list, or None."""
    if not codes:
        return None
    parsed = [c.strip().lower() for c in codes.split(",") if c.strip()]
    return parsed or None


def _build_codes_where(code_list: Optional[list[str]]) -> Optional[dict]:
    """Build a ChromaDB where clause for a list of codes."""
    if not code_list:
        return None
    if len(code_list) == 1:
        return {"code": code_list[0]}
    return {"code": {"$in": code_list}}


@router.get("")
async def get_videos(
    limit: Optional[int] = Query(
        default=100,
        ge=1,
        le=1000,
        description="Max videos to return (default 100, max 1000)",
    ),
    offset: int = Query(default=0, ge=0, description="Number of videos to skip"),
    codes: Optional[str] = Query(
        default=None,
        description=(
            "Comma-separated list of codes to filter by, e.g. 'abp,mxgs'. "
            "Matches the 'code' metadata field exactly (case-insensitive)."
        ),
    ),
):
    """
    Get all videos with pagination and optional code filtering.

    Returns a paginated list of videos stored in ChromaDB. Use limit and
    offset for page-based navigation. Pass 'codes' to restrict results to
    one or more specific codes.

    Query params:
        limit: Max videos to return (default 100, max 1000)
        offset: Skip first N videos (for pagination)
        codes: Comma-separated codes to filter by, e.g. "abp,mxgs" (optional)

    Returns:
        {
            "videos": [{id, document, metadata}, ...],
            "total": 1234,
            "limit": 100,
            "offset": 0
        }
    """
    code_list = _parse_codes_param(codes)
    logger.info(
        f"📋 Listing videos (limit={limit}, offset={offset}, codes={code_list})"
    )
    start_time = time.time()

    try:
        api_limit = limit if limit is not None else 100
        where = _build_codes_where(code_list)
        result = chroma_service.get_videos(limit=api_limit, offset=offset, where=where)

        elapsed = (time.time() - start_time) * 1000
        logger.info(
            f"✅ Listed {len(result['videos'])}/{result['total']} videos "
            f"in {elapsed:.2f}ms"
        )
        return result
    except Exception as e:
        logger.error(f"❌ Failed to list videos: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/by-ids")
async def get_videos_by_ids(video_ids: list[str]):
    """
    Get multiple videos by their IDs.

    Accepts a list of video ID strings in the request body.
    Returns only the videos that were found. Missing IDs are silently skipped.

    Request body example:
        ["juq-373", "mxgs-884", "abp-123"]

    Response:
        {
            "videos": [{id, document, metadata}, ...],
            "requested": 3,
            "found": 2,
            "missing": ["abp-123"]
        }
    """
    if not video_ids:
        raise HTTPException(status_code=400, detail="video_ids list cannot be empty")

    logger.info(f"📋 Batch fetching {len(video_ids)} videos by IDs")
    start_time = time.time()

    try:
        videos = chroma_service.get_videos_by_ids(video_ids)

        elapsed = (time.time() - start_time) * 1000
        found_ids = {v["id"] for v in videos}
        missing = [vid for vid in dict.fromkeys(video_ids) if vid not in found_ids]

        logger.info(
            f"✅ Batch fetch: {len(videos)}/{len(video_ids)} found in {elapsed:.2f}ms"
        )
        return {
            "videos": videos,
            "requested": len(video_ids),
            "found": len(videos),
            "missing": missing,
        }
    except Exception as e:
        logger.error(f"❌ Batch fetch failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/ingest")
async def ingest_videos(batch: VideoBatchIngest):
    """
    Ingest videos from the browser extension.

    Called by the extension when new videos are detected on MissAV.
    Videos are stored in ChromaDB with embeddings for semantic search.
    """
    start_time = time.time()
    logger.info(f"📥 Ingesting {len(batch.videos)} videos from {batch.source}")

    try:
        videos = [v.model_dump(by_alias=True) for v in batch.videos]
        count = chroma_service.add_videos(videos)

        elapsed = (time.time() - start_time) * 1000
        logger.info(f"✅ Ingested {count} videos in {elapsed:.2f}ms")

        return {
            "success": True,
            "ingested": count,
            "total": chroma_service.get_count(),
            "time_ms": elapsed,
        }
    except Exception as e:
        logger.error(f"❌ Ingest failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/count")
async def get_video_count():
    """
    Get total video count in database.
    """
    count = chroma_service.get_count()
    return {"count": count, "timestamp": time.time()}


@router.get("/codes", response_model=CodesResponse)
async def get_all_codes():
    """
    Get all unique JAV codes with their video counts, sorted by count desc.

    Response:
        {"codes": [{"code": "abp", "count": 42}, ...], "code_count": 87, "total_videos": 1234}
    """
    logger.info("🏷️ Listing all codes")
    start_time = time.time()

    try:
        result = chroma_service.get_codes()

        elapsed = (time.time() - start_time) * 1000
        logger.info(
            f"✅ Listed {result['code_count']} codes ({result['total_videos']} videos) "
            f"in {elapsed:.2f}ms"
        )
        return result
    except Exception as e:
        logger.error(f"❌ Failed to list codes: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/grouped-by-code", response_model=GroupedVideosResponse)
async def get_videos_grouped_by_code(
    min_count: int = Query(
        default=1, ge=1, description="Only include codes with at least this many videos"
    ),
    top_n: Optional[int] = Query(
        default=20,
        ge=1,
        le=200,
        description="Max number of code groups to return, ranked by count (max 200)",
    ),
    limit_per_group: int = Query(
        default=20,
        ge=1,
        le=1000,
        description="Max videos returned per group (default 20, max 1000)",
    ),
):
    """
    Get videos grouped by JAV code (e.g. "abp-123" -> code "abp").

    Server-side equivalent of groupByCode.js's grouping/filtering logic.

    Query params:
        min_count: Only include codes with >= this many videos (default 1)
        top_n: Max number of groups to return (default 20, max 200)
        limit_per_group: Max videos returned per group (default 20, max 1000)

    Response:
        {
            "groups": [{"code": "abp", "count": 42, "videos": [{id, document, metadata}, ...]}, ...],
            "group_count": 20,
            "total_videos": 980,
            "limit": 20,
            "min_count": 1,
            "top_n": 20
        }
    """
    logger.info(
        f"🏷️ Grouping videos by code (min_count={min_count}, top_n={top_n}, "
        f"limit_per_group={limit_per_group})"
    )
    start_time = time.time()

    try:
        result = chroma_service.get_videos_grouped_by_code(
            min_count=min_count, top_n=top_n, limit_per_group=limit_per_group
        )

        elapsed = (time.time() - start_time) * 1000
        logger.info(
            f"✅ Grouped into {result['group_count']} groups "
            f"({result['total_videos']} videos) in {elapsed:.2f}ms"
        )
        return {
            **result,
            "limit": limit_per_group,
            "min_count": min_count,
            "top_n": top_n if top_n is not None else result["group_count"],
        }
    except Exception as e:
        logger.error(f"❌ Failed to group videos by code: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{video_id}")
async def get_video(video_id: str):
    """
    Get a single video by ID.

    Returns video document and metadata from ChromaDB.
    """
    logger.info(f"🔍 Getting video: {video_id}")

    try:
        result = chroma_service.get_video(video_id)
        if not result:
            raise HTTPException(status_code=404, detail=f"Video not found: {video_id}")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Get video failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
