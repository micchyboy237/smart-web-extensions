from app.models import SearchRequest
from app.services.search_service import search_service
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/search", tags=["Search"])


@router.post("/smart")
def smart_search_endpoint(request: SearchRequest):
    try:
        results = search_service.execute_search(request)
        return {"count": len(results), "results": results}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/related/{video_id}")
def related_videos_endpoint(video_id: str, limit: int = 5, diverse: bool = True):
    results = search_service.get_related_videos(video_id, limit, diverse)
    if not results:
        raise HTTPException(status_code=404, detail="Video not found or no relations")
    return {"results": results}
