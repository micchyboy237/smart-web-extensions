from typing import List, Optional, Union

from fastapi import APIRouter, Query
from models.schemas.topic import (
    BatchSaveTopicsResponse,
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
    save_topics_batch,
    search_topics_by_ngrams,
)

router = APIRouter()


@router.post(
    "/save_topics",
    response_model=Union[CodeDashboardSummary, BatchSaveTopicsResponse],
)
def save_topics_endpoint(req: SaveTopicsRequest):
    if not req.is_batch:
        return save_topics(
            req.codes[0], req.n_topics, req.n_docs, req.top_k, req.no_llm
        )
    return save_topics_batch(req.codes, req.n_topics, req.n_docs, req.top_k, req.no_llm)


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


@router.get("/dashboard", response_model=DashboardResponse)
def get_topics_dashboard_endpoint():
    return get_topics_dashboard()


@router.get("/search", response_model=List[TopicSearchResultItem])
def search_topics_endpoint(
    query: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(10, ge=1, le=50),
    min_topic_score: float = Query(0.0, ge=0.0, le=1.0),
    min_doc_score: float = Query(0.0, ge=0.0, le=1.0),
    max_rep_docs: int = Query(5, ge=1, le=20),
    use_ngram_fusion: bool = Query(
        True, description="Enable multi-ngram semantic fusion"
    ),
    require_word_match: bool = Query(
        True,
        description="Filter results to only include topics whose top words match query terms",
    ),
):
    """
    Search topics using Multi-Vector Semantic Fusion.
    Automatically breaks the query into n-grams for better precision and recall.
    """
    return search_topics_by_ngrams(
        query=query,
        limit=limit,
        min_topic_score=min_topic_score,
        min_doc_score=min_doc_score,
        max_rep_docs=max_rep_docs,
        use_ngram_fusion=use_ngram_fusion,
        require_word_match=require_word_match,
    )
