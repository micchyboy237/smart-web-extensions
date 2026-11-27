from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field

from models.types.topics import (
    CodeDashboardSummaryTD,  # Note: We might need a Pydantic version if strict validation is needed, but for read-only APIs TypedDict often suffices if returned directly. However, FastAPI prefers Pydantic. Let's create Pydantic wrappers.
)


# Re-defining specific Pydantic models for Topic API responses to ensure proper serialization
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
    word: str
    score: float


class DashboardResponse(BaseModel):
    codes: List[CodeDashboardSummaryTD]


class SaveTopicsRequest(BaseModel):
    code: str = Field("juc")
    n_topics: int = Field(5, ge=1)
    n_docs: int = Field(100, ge=1)
    top_k: int = Field(10, ge=1)
    no_llm: bool = Field(False)
