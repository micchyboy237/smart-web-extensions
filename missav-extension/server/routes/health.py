# Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server/routes/health.py
"""Health check and CORS test endpoints."""

import logging
import time

from fastapi import APIRouter, Request
from services import chroma_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health_check(request: Request):
    """
    Health check endpoint - confirms server and CORS are working.
    """
    origin = request.headers.get("origin", "unknown")

    return {
        "status": "healthy",
        "timestamp": time.time(),
        "cors_origin": origin,
        "videos_count": chroma_service.get_count(),
        "endpoints": [
            "GET  /api/health",
            "GET  /api/cors-test",
            "POST /api/videos/ingest",
            "POST /api/search",
            "GET  /api/videos/{video_id}",
            "GET  /api/videos/count",
            "POST /api/preferences",
            "GET  /api/preferences/{user_id}",
        ],
    }
