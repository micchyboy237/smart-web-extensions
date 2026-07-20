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


class VideoBatchIngest(BaseModel):
    """Batch of videos to ingest from extension."""

    videos: list[VideoMetadata]
    source: str = "extension"


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
