# Jet_Apps/server/models/video.py
"""Video data models for the MissAV smart search server."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class VideoMetadata(BaseModel):
    """Metadata for a single video extracted by the extension."""

    url: str = Field(..., description="Full video URL")
    text: str = Field(..., description="Video title/description")
    thumbnail: Optional[str] = Field(None, description="Thumbnail image URL")
    preview: Optional[str] = Field(None, description="Preview video URL")
    video_id: Optional[str] = Field(
        None, alias="videoId", description="JAV code like 'juq-373'"
    )
    code: Optional[str] = Field(None, description="Series code like 'juq'")
    episode: Optional[str] = Field(None, description="Episode number like '373'")

    class Config:
        populate_by_name = True
        extra = "allow"


class VideoDocument(BaseModel):
    """Document stored in ChromaDB with embedding."""

    id: str
    content: str  # Searchable text (title + code + episode)
    metadata: VideoMetadata
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)


class SearchQuery(BaseModel):
    """Smart search request."""

    query: str = Field(..., description="Natural language or keyword search")
    top_k: int = Field(default=20, ge=1, le=100)

    # Inclusion filters
    include_codes: list[str] = Field(
        default_factory=list,
        description="Only include videos with these codes (e.g., ['juq', 'mxgs'])",
    )
    include_episodes: list[str] = Field(
        default_factory=list, description="Only include specific episodes"
    )
    include_episode_range: Optional[tuple[int, int]] = Field(
        None, description="Episode range [min, max]"
    )

    # Exclusion filters
    exclude_codes: list[str] = Field(
        default_factory=list, description="Exclude videos with these codes"
    )
    exclude_episodes: list[str] = Field(
        default_factory=list, description="Exclude specific episodes"
    )
    exclude_ids: list[str] = Field(
        default_factory=list, description="Exclude specific video IDs (already watched)"
    )

    # Diversity settings
    diversity_factor: float = Field(
        default=0.3, ge=0.0, le=1.0, description="0=relevance only, 1=maximum diversity"
    )
    max_per_code: Optional[int] = Field(
        None, description="Maximum results per series code (for diversity)"
    )

    # Search strategy
    search_type: str = Field(
        default="semantic",
        pattern="^(semantic|keyword|hybrid|ensemble)$",
        description="Search strategy to use",
    )
    limit_to_ids: Optional[list[str]] = Field(
        default=None,
        description="Only search within these specific video IDs (page-limited mode)",
    )


class VideoBatchIngest(BaseModel):
    """Batch of videos to ingest from extension."""

    videos: list[VideoMetadata]
    source: str = "extension"


class SearchResult(BaseModel):
    """Single search result."""

    id: str
    score: float
    document: str
    metadata: VideoMetadata
    diversity_score: Optional[float] = None
    rank: int


class SearchResponse(BaseModel):
    """Search response with results and metadata."""

    results: list[SearchResult]
    total_candidates: int
    filters_applied: dict
    search_time_ms: float
    query_understanding: Optional[dict] = None


class UserPreference(BaseModel):
    """User preference for smart filtering."""

    user_id: str = "default"
    favorite_codes: list[str] = Field(default_factory=list)
    blocked_codes: list[str] = Field(default_factory=list)
    watched_ids: list[str] = Field(default_factory=list)
    preferred_episode_range: Optional[tuple[int, int]] = None
    diversity_preference: float = Field(default=0.3, ge=0.0, le=1.0)
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
