"""Public API contracts for the videos router."""

from typing import List, Optional

from pydantic import BaseModel, Field, field_validator


class VideoIngestItem(BaseModel):
    """A single video as sent by the browser extension for ingestion."""

    model_config = {"populate_by_name": True}

    id: Optional[str] = Field(default=None)
    url: Optional[str] = Field(default=None)
    title: Optional[str] = Field(default=None, alias="text")
    code: Optional[str] = Field(default=None)
    episode: Optional[str] = Field(default=None)
    video_id: Optional[str] = Field(default=None, alias="videoId")
    thumbnail: Optional[str] = Field(default=None)
    preview: Optional[str] = Field(default=None)
    details: Optional[str] = Field(default=None)
    release_date: Optional[str] = Field(default=None, alias="releaseDate")
    genres: Optional[List[str]] = Field(default=None)

    @field_validator("url", "code", "episode", "video_id", mode="before")
    @classmethod
    def require_non_empty(cls, v):
        if isinstance(v, str) and v.strip() == "":
            return None
        return v

    @field_validator(
        "title", "thumbnail", "preview", "details", "release_date", mode="before"
    )
    @classmethod
    def clean_optional(cls, v):
        if isinstance(v, str) and v.strip() == "":
            return None
        return v


class VideoBatchIngest(BaseModel):
    source: str
    videos: List[VideoIngestItem] = Field(default_factory=list)


class VideoSummary(BaseModel):
    id: str
    title: Optional[str] = None
    url: Optional[str] = None
    code: Optional[str] = None
    episode: Optional[str] = None
    thumbnail: Optional[str] = None


class VideoListResponse(BaseModel):
    total: int = 0
    limit: int = 0
    offset: int = 0
    videos: List[VideoSummary] = Field(default_factory=list)


class VideosByIdsResponse(BaseModel):
    requested: int = 0
    found: int = 0
    missing: List[str] = Field(default_factory=list)
    videos: List[VideoSummary] = Field(default_factory=list)


class IngestResponse(BaseModel):
    success: bool
    ingested: int = 0
    total: int = 0
    time_ms: float = 0.0


class CodeSummary(BaseModel):
    code: str
    count: int


class CodesResponse(BaseModel):
    code_count: int = 0
    total_videos: int = 0
    codes: List[CodeSummary] = Field(default_factory=list)


class VideoGroup(BaseModel):
    code: str
    count: int
    videos: List[VideoSummary] = Field(default_factory=list)


class GroupedVideosResponse(BaseModel):
    group_count: int = 0
    total_videos: int = 0
    limit: int = 0
    min_count: int = 1
    top_n: int = 0
    groups: List[VideoGroup] = Field(default_factory=list)
