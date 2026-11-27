from typing import List, Optional

from fastapi import APIRouter, Query
from models.schemas import (
    CodeDashboardSummaryTD,
    DashboardResponse,
    SaveTopicsRequest,
    TopicRunDetailTD,
    TopicRunListItem,
    TopicSearchResultItem,
)
from services.cluster_service import (
    get_topic_run_detail,
    get_topics_dashboard,
    list_topic_runs,
    save_topics,
    search_topics_by_word,
)

router = APIRouter()


@router.post("/save_topics", response_model=CodeDashboardSummaryTD)
def save_topics_endpoint(req: SaveTopicsRequest) -> CodeDashboardSummaryTD:
    return save_topics(req.code, req.n_topics, req.n_docs, req.top_k, req.no_llm)


@router.get("/runs", response_model=List[TopicRunListItem])
def list_topic_runs_endpoint(
    code: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    return list_topic_runs(code, limit, offset)


@router.get("/runs/{run_id}", response_model=TopicRunDetailTD)
def get_topic_run_detail_endpoint(run_id: str):
    return get_topic_run_detail(run_id)


@router.get("/search", response_model=List[TopicSearchResultItem])
def search_topics_by_word_endpoint(
    word: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=50),
):
    return search_topics_by_word(word, limit)


@router.get("/dashboard", response_model=DashboardResponse)
def get_topics_dashboard_endpoint():
    return get_topics_dashboard()
