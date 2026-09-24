"""Public API contracts for the videos router (request/response payloads).

Kept separate from models/chroma.py, which describes raw repository
shapes. These models describe what clients (the browser extension,
API consumers) actually send and receive.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


# ============================================================================
# Ingest
# ============================================================================
class VideoIngestItem(BaseModel):
    """A single video as sent by the browser extension for ingestion."""

    model_config = ConfigDict(populate_by_name=True)

    id: Optional[str] = Field(default=None, description="Unique video identifier")
    url: Optional[str] = Field(default=None, description="Source page URL")
    text: Optional[str] = Field(default=None, description="Raw title/alt text")
    code: Optional[str] = Field(
        default=None, description="Extracted JAV code, e.g. 'abp'"
    )
    episode: Optional[str] = Field(default=None, description="Episode number, if any")
    video_id: Optional[str] = Field(
        default=None, alias="videoId", description="Site-specific video ID"
    )
    thumbnail: Optional[str] = Field(default=None, description="Thumbnail image URL")
    preview: Optional[str] = Field(default=None, description="Preview video/gif URL")


class VideoBatchIngest(BaseModel):
    """Request body for POST /api/videos/ingest."""

    source: str = Field(description="Origin of this batch, e.g. 'missav-extension'")
    videos: List[VideoIngestItem] = Field(default_factory=list)


# ============================================================================
# Retrieval — single / batch / list
# ============================================================================
class VideoSummary(BaseModel):
    """Lightweight video representation used across list/group responses."""

    id: str
    document: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class VideoListResponse(BaseModel):
    """Response body for GET /api/videos."""

    total: int = 0
    limit: int = 0
    offset: int = 0
    videos: List[VideoSummary] = Field(default_factory=list)


class VideosByIdsResponse(BaseModel):
    """Response body for POST /api/videos/by-ids."""

    requested: int = 0
    found: int = 0
    missing: List[str] = Field(default_factory=list)
    videos: List[VideoSummary] = Field(default_factory=list)


class VideoCountResponse(BaseModel):
    """Response body for GET /api/videos/count."""

    count: int = 0
    timestamp: float = 0.0


class IngestResponse(BaseModel):
    """Response body for POST /api/videos/ingest."""

    success: bool
    ingested: int = 0
    total: int = 0
    time_ms: float = 0.0


# ============================================================================
# Codes & grouping
# ============================================================================
class CodeSummary(BaseModel):
    """One code and its video count, as returned by GET /api/videos/codes."""

    code: str
    count: int


class CodesResponse(BaseModel):
    """Response body for GET /api/videos/codes."""

    code_count: int = 0
    total_videos: int = 0
    codes: List[CodeSummary] = Field(default_factory=list)


class VideoGroup(BaseModel):
    """All videos sharing a single code."""

    code: str
    count: int
    videos: List[VideoSummary] = Field(default_factory=list)


class GroupedVideosResponse(BaseModel):
    """Response body for GET /api/videos/grouped-by-code."""

    group_count: int = 0
    total_videos: int = 0
    limit: int = 0
    min_count: int = 1
    top_n: int = 0
    groups: List[VideoGroup] = Field(default_factory=list)
