"""Analysis models for BERTopic-powered topic extraction."""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class TopicResult(BaseModel):
    """Single topic extracted by BERTopic."""

    topic_id: int = Field(..., description="BERTopic-assigned topic ID")
    name: str = Field(..., description="Auto-generated topic name")
    keywords: List[str] = Field(..., description="Top keywords for the topic")
    size: int = Field(..., description="Number of documents in this topic")
    representative_doc: str = Field(
        ..., description="Most representative document snippet"
    )


class TopicExtractionRequest(BaseModel):
    """Request to extract topics from videos."""

    video_ids: Optional[List[str]] = Field(
        None, description="Specific video IDs to analyze (omit for all videos)"
    )
    min_topic_size: int = Field(
        default=3, ge=2, le=50, description="Minimum documents per topic"
    )
    top_n_words: int = Field(
        default=10, ge=3, le=30, description="Number of keywords per topic"
    )
    remove_stop_words: bool = Field(
        default=True, description="Remove English stop words for cleaner keywords"
    )
    use_keybert: bool = Field(
        default=True,
        description="Use KeyBERT-inspired representation for better topics",
    )


class TopicExtractionResponse(BaseModel):
    """Response from topic extraction analysis."""

    topics: List[TopicResult]
    topic_count: int = Field(..., description="Total topics found")
    document_count: int = Field(..., description="Total documents analyzed")
    outlier_count: int = Field(
        default=0, description="Documents not assigned to any topic (topic -1)"
    )
    extraction_time_ms: float = Field(..., description="Total time in milliseconds")
    timestamp: datetime = Field(default_factory=datetime.now)


class TopicSearchRequest(BaseModel):
    """Search for videos belonging to specific topics."""

    topic_id: int = Field(..., description="Topic ID to retrieve videos for")
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class TopicSearchResponse(BaseModel):
    """Response with videos matching a topic."""

    topic_id: int
    topic_name: str
    keywords: List[str]
    videos: List[dict]
    total: int
    limit: int
    offset: int


class AnalysisHealthResponse(BaseModel):
    """Health status for the analysis module."""

    status: str = "available"
    embedder_ready: bool
    model_info: dict
