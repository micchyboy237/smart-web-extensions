# Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server/routes/videos.py
"""Video ingest and retrieval endpoints."""

import logging
import time

from fastapi import APIRouter, HTTPException
from models.video import VideoBatchIngest, VideoMetadata
from services import chroma_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/videos", tags=["videos"])


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
        results = chroma_service.collection.get(
            ids=[video_id],
            include=["documents", "metadatas"],
        )

        if not results["ids"]:
            raise HTTPException(status_code=404, detail=f"Video not found: {video_id}")

        return {
            "id": results["ids"][0],
            "document": results["documents"][0],
            "metadata": results["metadatas"][0],
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Get video failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
