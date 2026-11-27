from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field

from models.types.topic import WordScoreTD


class TopicSearchRequest(BaseModel):
    query: str = Field(
        ...,
        min_length=1,
        description="The search query. Can be a single word or phrase.",
    )
    limit: int = Field(10, ge=1, le=50)
    min_topic_score: float = Field(
        0.0, ge=0.0, le=1.0, description="Minimum relevance score for a topic"
    )
    min_doc_score: float = Field(
        0.0,
        ge=0.0,
        le=1.0,
        description="Minimum membership score for representative docs",
    )
    max_rep_docs: int = Field(
        5, ge=1, le=20, description="Max number of representative docs per topic"
    )
    use_ngram_fusion: bool = Field(
        True, description="If true, breaks query into n-grams for fusion search"
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


class RepresentativeDocWithVideo(BaseModel):
    video_id: str
    title: Optional[str]
    thumbnail: Optional[str]
    preview: Optional[str]
    release_date: Optional[datetime]
    membership_score: float
    content_snippet: Optional[str]


class TopicSearchResultItem(BaseModel):
    run_id: str
    code: str
    topic_id: int
    topic_name: Optional[str]
    doc_count: int = Field(alias="representative_doc_count")
    created_at: datetime
    relevance_score: float
    matched_ngrams: List[str] = Field(
        default_factory=list, description="Which n-grams contributed to this result"
    )
    top_words: List[WordScoreTD] = Field(default_factory=list)
    representative_docs: List[RepresentativeDocWithVideo] = Field(default_factory=list)

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
