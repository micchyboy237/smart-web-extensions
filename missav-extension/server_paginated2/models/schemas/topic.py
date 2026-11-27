from datetime import datetime
from typing import List, Optional, Union

from pydantic import BaseModel, Field, field_validator

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
    max_rep_docs: Optional[int] = Field(
        None,
        ge=1,
        description="Max number of representative docs per topic. None means no limit.",
    )
    use_ngram_fusion: bool = Field(
        True, description="If true, breaks query into n-grams for fusion search"
    )


class SaveTopicsRequest(BaseModel):
    code: Union[str, List[str]] = Field(
        "juc", description="One code or a list of codes"
    )
    n_topics: int = Field(5, ge=1)
    n_docs: int = Field(100, ge=1)
    top_k: int = Field(10, ge=1)
    no_llm: bool = Field(False)

    @field_validator("code", mode="before")
    @classmethod
    def _normalize_code(cls, v):
        items = [v] if isinstance(v, str) else list(v or [])
        out: List[str] = []
        for item in items:
            for part in str(item).split(","):
                part = part.strip()
                if part and part not in out:  # dedupe, keep order
                    out.append(part)
        if not out:
            raise ValueError("code must contain at least one non-empty value")
        if len(out) > 20:
            raise ValueError("At most 20 codes per request")
        # keep a plain str when only one was given (backward compatible)
        return out[0] if isinstance(v, str) and len(out) == 1 else out

    @property
    def codes(self) -> List[str]:
        return [self.code] if isinstance(self.code, str) else self.code

    @property
    def is_batch(self) -> bool:
        return isinstance(self.code, list)


class SaveTopicsFailure(BaseModel):
    code: str
    error: str


class BatchSaveTopicsResponse(BaseModel):
    results: List["CodeDashboardSummary"]
    failed: List[SaveTopicsFailure]
    took_ms: float


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
