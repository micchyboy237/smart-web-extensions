"""Video ingest and retrieval endpoints."""

import logging
import time

from fastapi import APIRouter, HTTPException, Query
from models.video import VideoBatchIngest
from services import chroma_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/videos", tags=["videos"])


@router.get("")
async def get_all_videos(
    limit: int = Query(default=100, ge=1, le=1000, description="Max videos to return"),
    offset: int = Query(default=0, ge=0, description="Number of videos to skip"),
):
    """
    Get all videos with pagination.

    Returns a paginated list of all videos stored in ChromaDB.
    Use limit and offset for page-based navigation.

    Query params:
        limit: Max videos to return (default 100, max 1000)
        offset: Skip first N videos (for pagination)

    Returns:
        {
            "videos": [{id, document, metadata}, ...],
            "total": 1234,
            "limit": 100,
            "offset": 0
        }
    """
    logger.info(f"📋 Listing videos (limit={limit}, offset={offset})")
    start_time = time.time()

    try:
        result = chroma_service.get_videos(limit=limit, offset=offset)

        elapsed = (time.time() - start_time) * 1000
        logger.info(
            f"✅ Listed {len(result['videos'])}/{result['total']} videos "
            f"in {elapsed:.2f}ms"
        )

        return result
    except Exception as e:
        logger.error(f"❌ Failed to list videos: {e}", exc_info=True)
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
