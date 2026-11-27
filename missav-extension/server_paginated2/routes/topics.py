from typing import List, Optional

from fastapi import APIRouter, Query
from models.schemas.topic import (
    CodeDashboardSummary,
    DashboardResponse,
    SaveTopicsRequest,
    TopicRunListItem,
    TopicSearchResultItem,
)
from models.types.topic import (
    TopicRunDetailTD,
)
from services.cluster_service import (
    get_topic_run_detail,
    get_topics_dashboard,
    list_topic_runs,
    save_topics,
    search_topics_by_word,
)

router = APIRouter()


@router.post("/save_topics", response_model=CodeDashboardSummary)
def save_topics_endpoint(req: SaveTopicsRequest) -> CodeDashboardSummary:
    summary = save_topics(req.code, req.n_topics, req.n_docs, req.top_k, req.no_llm)
    return summary


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
    match_type: str = Query(
        "all", description="Filter by match strategy: all, semantic, keyword, or hybrid"
    ),
    min_topic_score: float = Query(
        0.0, ge=0.0, le=1.0, description="Minimum relevance score for a topic"
    ),
    min_doc_score: float = Query(
        0.0,
        ge=0.0,
        le=1.0,
        description="Minimum membership score for representative docs",
    ),
    max_rep_docs: int = Query(
        5, ge=1, le=20, description="Max number of representative docs per topic"
    ),
):
    """
    Search topics by word using Hybrid Search.
    Results include full video metadata for representative documents.
    """
    return search_topics_by_word(
        word=word,
        limit=limit,
        match_type=match_type,
        min_topic_score=min_topic_score,
        min_doc_score=min_doc_score,
        max_rep_docs=max_rep_docs,
    )


@router.get("/dashboard", response_model=DashboardResponse)
def get_topics_dashboard_endpoint():
    return get_topics_dashboard()
