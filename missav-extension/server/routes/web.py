"""HTML web interface endpoints for the MissAV Smart Search API.

Provides Jinja2-rendered HTML pages for browsing videos, searching,
exploring topics, and managing preferences through a beautiful web UI.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from services import chroma_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/web", tags=["web-ui"])
templates = Jinja2Templates(directory="templates")


# ── Custom template filters/globals ──────────────────────────────
def format_number(value):
    """Format number with commas (e.g., 1234 → '1,234')."""
    try:
        return f"{int(value):,}"
    except (ValueError, TypeError):
        return str(value)


templates.env.globals["format_number"] = format_number
# ──────────────────────────────────────────────────────────────────


def _get_base_stats() -> dict:
    """Fetch base statistics for template context."""
    try:
        count = chroma_service.get_count()
    except Exception:
        count = 0
    return {
        "total_videos": count,
        "search_time_ms": 0,
        "topic_count": 0,
        "avg_score": 0,
    }


@router.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    """Landing page / dashboard with overview stats."""
    logger.info("🌐 Serving dashboard page")
    try:
        stats = _get_base_stats()
        return templates.TemplateResponse(
            "pages/home.jinja",
            {
                "request": request,
                "active_page": "home",
                "stats": stats,
            },
        )
    except Exception as e:
        logger.error(f"❌ Dashboard error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search", response_class=HTMLResponse)
async def search_page(request: Request):
    """Smart search page with filters and results."""
    logger.info("🌐 Serving search page")
    stats = _get_base_stats()
    return templates.TemplateResponse(
        "pages/search.jinja",
        {
            "request": request,
            "active_page": "search",
            "stats": stats,  # ← Fixed: pass stats to template
            "results": None,
            "search_time_ms": 0,
            "query": "",
        },
    )


@router.get("/search-results", response_class=HTMLResponse)
async def search_results(
    request: Request,
    query: str = Query(..., description="Search query"),
    search_type: str = Query(default="hybrid"),
    top_k: int = Query(default=20, ge=1, le=50),
    diversity_factor: float = Query(default=0.3, ge=0.0, le=1.0),
    include_codes: Optional[str] = Query(default=None),
    exclude_codes: Optional[str] = Query(default=None),
):
    """Render search results (used by HTMX for dynamic updates)."""
    import time

    from models.video import SearchQuery
    from utils.search_strategies import diversity_search

    from routes.search import _apply_post_filters, _build_where_filter

    logger.info(f"🔍 Web search: '{query[:100]}' (type={search_type})")
    start_time = time.time()

    try:
        include_list = (
            [c.strip() for c in include_codes.split(",") if c.strip()]
            if include_codes
            else []
        )
        exclude_list = (
            [c.strip() for c in exclude_codes.split(",") if c.strip()]
            if exclude_codes
            else []
        )

        search_query_obj = SearchQuery(
            query=query,
            search_type=search_type,
            top_k=top_k,
            diversity_factor=diversity_factor,
            include_codes=include_list,
            exclude_codes=exclude_list,
        )

        where_filter = _build_where_filter(search_query_obj)
        candidate_k = min(top_k * 3, 100)
        results = chroma_service.search(
            query=query,
            top_k=candidate_k,
            where=where_filter,
        )
        results = _apply_post_filters(results, search_query_obj)

        if diversity_factor > 0 and len(results) > 1:
            diversity_search.diversity_factor = diversity_factor
            ids = [r["id"] for r in results]
            embeddings = chroma_service.get_embeddings(ids)
            results = diversity_search.apply_diversity(results, embeddings)
            results = results[:top_k]
        else:
            results = results[:top_k]

        elapsed = (time.time() - start_time) * 1000
        stats = _get_base_stats()
        stats["search_time_ms"] = elapsed

        return templates.TemplateResponse(
            "partials/search_results.jinja",
            {
                "request": request,
                "stats": stats,
                "results": results,
                "search_time_ms": elapsed,
                "query": query,
                "total_results": len(results),
            },
        )
    except Exception as e:
        logger.error(f"❌ Search error: {e}", exc_info=True)
        return HTMLResponse(
            content=f'<div class="alert alert-danger">{str(e)}</div>',
            status_code=500,
        )


@router.get("/videos", response_class=HTMLResponse)
async def video_library(
    request: Request,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=24, ge=12, le=100),
):
    """Video library browser with pagination."""
    logger.info(f"🌐 Serving video library (page={page}, per_page={per_page})")
    try:
        offset = (page - 1) * per_page
        result = chroma_service.get_videos(limit=per_page, offset=offset)
        total_pages = max(1, (result["total"] + per_page - 1) // per_page)
        stats = _get_base_stats()
        stats["total_videos"] = result["total"]

        return templates.TemplateResponse(
            "pages/videos.jinja",
            {
                "request": request,
                "active_page": "videos",
                "stats": stats,
                "videos": result["videos"],
                "total": result["total"],
                "page": page,
                "per_page": per_page,
                "total_pages": total_pages,
            },
        )
    except Exception as e:
        logger.error(f"❌ Video library error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/videos/{video_id}", response_class=HTMLResponse)
async def video_detail(request: Request, video_id: str):
    """Single video detail page."""
    logger.info(f"🌐 Serving video detail: {video_id}")
    try:
        video = chroma_service.get_video(video_id)
        if not video:
            raise HTTPException(status_code=404, detail="Video not found")
        stats = _get_base_stats()
        return templates.TemplateResponse(
            "pages/video_detail.jinja",
            {
                "request": request,
                "active_page": "videos",
                "stats": stats,
                "video": video,
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Video detail error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/topics", response_class=HTMLResponse)
async def topic_explorer(request: Request):
    """Topic explorer page."""
    logger.info("🌐 Serving topic explorer")
    stats = _get_base_stats()
    return templates.TemplateResponse(
        "pages/topics.jinja",
        {
            "request": request,
            "active_page": "topics",
            "stats": stats,
            "topics": [],
            "has_results": False,
        },
    )


@router.get("/preferences", response_class=HTMLResponse)
async def preferences_page(request: Request):
    """User preferences management page."""
    logger.info("🌐 Serving preferences page")
    stats = _get_base_stats()
    return templates.TemplateResponse(
        "pages/preferences.jinja",
        {
            "request": request,
            "active_page": "preferences",
            "stats": stats,
        },
    )
