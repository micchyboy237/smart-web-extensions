from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field

from models.types.topic import MatchType, WordScoreTD


class TopicSearchRequest(BaseModel):
    word: str = Field(..., min_length=1)
    limit: int = Field(10, ge=1, le=50)
    match_type: MatchType = Field(
        "all", description="Filter by match strategy: all, semantic, keyword, or hybrid"
    )


class SaveTopicsRequest(BaseModel):
    code: str = Field("juc")
    n_topics: int = Field(5, ge=1)
    n_docs: int = Field(100, ge=1)
    top_k: int = Field(10, ge=1)
    no_llm: bool = Field(False)


class TopicRunListItem(BaseModel):
    id: str
    code: str
    n_topics: int
    n_docs: int
    created_at: datetime


class TopicSearchResultItem(BaseModel):
    run_id: str
    code: str
    topic_id: int
    topic_name: Optional[str]
    doc_count: int = Field(alias="representative_doc_count")
    created_at: datetime
    relevance_score: float
    matched_keywords: List[str] = Field(default_factory=list)
    match_type: Literal["semantic", "keyword", "hybrid"]

    # New fields for rich client rendering
    top_words: List[WordScoreTD] = Field(
        default_factory=list, description="Top 5 defining words for this topic"
    )
    representative_snippet: Optional[str] = Field(
        None, description="Content snippet from the most representative document"
    )

    class Config:
        populate_by_name = True


class CodeDashboardSummary(BaseModel):
    """Pydantic version of CodeDashboardSummaryTD for API responses"""

    code: str
    run_id: str
    created_at: datetime
    n_topics: int
    n_docs: int
    top_topic_name: Optional[str]
    top_topic_words: List[WordScoreTD]
    top_topic_rep_count: Optional[int]


class DashboardResponse(BaseModel):
    codes: List[CodeDashboardSummary]
