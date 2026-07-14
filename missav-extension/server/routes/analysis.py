"""BERTopic analysis endpoints for topic extraction and exploration."""

import logging
import time

from fastapi import APIRouter, HTTPException
from models.analysis import (
    AnalysisHealthResponse,
    TopicExtractionRequest,
    TopicExtractionResponse,
    TopicResult,
    TopicSearchResponse,
)
from services import chroma_service
from services.analysis_service import (
    get_analysis_service,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/analysis", tags=["analysis"])


@router.get("/health", response_model=AnalysisHealthResponse)
async def analysis_health():
    """
    Check if the BERTopic analysis module is ready.
    Verifies the embedding server is reachable and the model
    is properly configured.
    """
    logger.info("🏥 Checking analysis health...")
    try:
        service = get_analysis_service()
        embedder_ready = service.check_embedder()
        return AnalysisHealthResponse(
            status="available" if embedder_ready else "embedder_unavailable",
            embedder_ready=embedder_ready,
            model_info={
                "backend": "llama.cpp",
                "min_topic_size_default": 3,
                "supports_keybert": True,
            },
        )
    except Exception as e:
        logger.error(f"❌ Analysis health check failed: {e}")
        return AnalysisHealthResponse(
            status="unavailable",
            embedder_ready=False,
            model_info={"error": str(e)},
        )


@router.post("/topics", response_model=TopicExtractionResponse)
async def extract_topics(request: TopicExtractionRequest):
    """
    Extract topics from video documents using BERTopic.
    This endpoint runs topic modeling on the video collection:
    1. Fetches video documents (all or specified IDs)
    2. Extracts topics using BERTopic with llama.cpp embeddings
    3. Returns structured topic information with representative docs
    Topics are returned sorted by size (largest first).
    Use cases:
    - Discover content categories in your video collection
    - Find thematic patterns across series
    - Identify outlier videos that don't fit common themes
    Performance note:
    Topic extraction is CPU/memory intensive for large collections.
    Consider filtering video_ids for targeted analysis.
    """
    start_time = time.time()
    logger.info(
        f"🔬 Topic extraction requested "
        f"(videos={request.video_ids or 'all'}, "
        f"min_topic_size={request.min_topic_size})"
    )
    try:
        if request.video_ids:
            documents = []
            for vid_id in request.video_ids:
                video = chroma_service.get_video(vid_id)
                if video:
                    documents.append(video["document"])
            if not documents:
                raise HTTPException(
                    status_code=404, detail="No videos found for the provided IDs"
                )
        else:
            all_videos = chroma_service.get_videos(limit=5000, offset=0)
            documents = [v["document"] for v in all_videos["videos"]]
        logger.info(f"📄 Gathered {len(documents)} documents for analysis")
        service = get_analysis_service()
        result = service.extract_topics(
            documents=documents,
            min_topic_size=request.min_topic_size,
            top_n_words=request.top_n_words,
            remove_stop_words=request.remove_stop_words,
            use_keybert=request.use_keybert,
            n_representative_docs=request.n_representative_docs,
        )
        topics_list = []
        for topic in result["topics"]:
            topics_list.append(
                TopicResult(
                    topic_id=topic["topic_id"],
                    name=topic["name"],
                    keywords=topic["keywords"],
                    size=topic["size"],
                    representative_docs=topic.get("representative_docs", []),
                )
            )
        # Sort by size descending
        topics_list.sort(key=lambda t: t.size, reverse=True)
        outlier_count = sum(1 for label in result["topic_labels"] if label == -1)
        elapsed = (time.time() - start_time) * 1000
        logger.info(
            f"✅ Extracted {len(topics_list)} topics "
            f"from {len(documents)} documents "
            f"({outlier_count} outliers) in {elapsed:.0f}ms"
        )
        return TopicExtractionResponse(
            topics=topics_list,
            topic_count=len(topics_list),
            document_count=len(documents),
            outlier_count=outlier_count,
            extraction_time_ms=elapsed,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Topic extraction failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/topics/{topic_id}/videos", response_model=TopicSearchResponse)
async def get_topic_videos(
    topic_id: int,
    limit: int = 20,
    offset: int = 0,
):
    """
    Retrieve videos belonging to a specific topic.
    Only works after running POST /api/analysis/topics in the same server session.
    Args:
        topic_id: The topic ID from extraction results
        limit: Max videos to return (default 20, max 100)
        offset: Skip first N videos for pagination
    """
    logger.info(
        f"🔍 Fetching videos for topic {topic_id} (limit={limit}, offset={offset})"
    )
    try:
        service = get_analysis_service()
        topic_docs = service.get_topic_documents(topic_id)
        if not topic_docs:
            raise HTTPException(
                status_code=404,
                detail=f"Topic {topic_id} not found. Run POST /api/analysis/topics first.",
            )
        total = len(topic_docs)
        paginated = topic_docs[offset : offset + limit]
        return TopicSearchResponse(
            topic_id=topic_id,
            topic_name=f"Topic_{topic_id}",
            keywords=[],
            videos=paginated,
            total=total,
            limit=limit,
            offset=offset,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Topic video fetch failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
