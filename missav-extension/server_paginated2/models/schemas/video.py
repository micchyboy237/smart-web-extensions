from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field

from models.types.common import CompletionFilter, GenreCodeInput


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(20, ge=1, le=100)
    cursor: Optional[str] = None
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    code: GenreCodeInput = None
    min_similarity: Optional[float] = Field(None, ge=0.0, le=1.0)
    sort: Literal["release_date", "created_at", "similarity"] = "similarity"
    order: Literal["asc", "desc"] = "desc"
    completion_filter: CompletionFilter = "all"


class SimilarRequest(BaseModel):
    video_id: str
    limit: int = Field(20, ge=1, le=100)
    cursor: Optional[str] = None
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    code: GenreCodeInput = None
    sort: Literal["release_date", "created_at", "similarity"] = "similarity"
    order: Literal["asc", "desc"] = "desc"
    completion_filter: CompletionFilter = "all"


class HybridRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(20, ge=1, le=100)
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    code: GenreCodeInput = None
    sort: Literal["release_date", "created_at"] = "release_date"
    order: Literal["asc", "desc"] = "desc"
    completion_filter: CompletionFilter = "all"


class VideoItem(BaseModel):
    id: str
    title: Optional[str]
    details: Optional[str]
    code: str
    episode: str
    url: str
    preview: Optional[str]
    thumbnail: Optional[str]
    release_date: Optional[datetime]
    genres: Optional[List[str]]
    similarity: Optional[float] = None
    probability: Optional[float] = None
    silhouette: Optional[float] = None
    distance_to_centroid: Optional[float] = None


class SearchResponse(BaseModel):
    items: List[VideoItem]
    next_cursor: Optional[str]
    has_more: bool
    took_ms: float


class VideoListResponse(BaseModel):
    took_ms: float
    count: int
    items: List[dict]


class FacetsResponse(BaseModel):
    genres: List[dict]
    codes: List[dict]
    years: List[dict]


class VideoIngestItem(BaseModel):
    id: Optional[str] = None  # Made optional; will be generated if missing
    url: str
    code: str
    episode: str
    video_id: str
    title: Optional[str] = None
    thumbnail: Optional[str] = None
    preview: Optional[str] = None
    details: Optional[str] = None
    release_date: Optional[datetime] = None
    genres: Optional[List[str]] = None


class IngestRequest(BaseModel):
    items: List[VideoIngestItem] = Field(..., min_length=1, max_length=500)
    upsert: bool = True


class IngestResponse(BaseModel):
    inserted: int
    updated: int
    skipped: int
    took_ms: float


class DiscoverRequest(BaseModel):
    query: Optional[str] = Field(None, min_length=1)
    limit: int = Field(20, ge=1, le=50)
    seed: int = Field(
        default_factory=lambda: int(datetime.now().timestamp() * 1000) % 10**9
    )
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    code: GenreCodeInput = None
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    completion_filter: CompletionFilter = "all"
    diversity: float = Field(0.6, ge=0.0, le=1.0)


class GroupedSearchRequest(BaseModel):
    query: Optional[str] = None
    video_id: Optional[str] = None
    code: GenreCodeInput = None
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    completion_filter: CompletionFilter = "all"
    min_similarity: Optional[float] = None
    diversity: float = 0.0
    fetch_k: Optional[int] = None


class GroupedVideoItem(BaseModel):
    id: str
    video_id: str
    code: str
    episode: str
    video_count: int
    title: Optional[str]
    details: Optional[str]
    thumbnail: Optional[str]
    preview: Optional[str]
    release_date: Optional[datetime]
    genres: Optional[List[str]]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]
    url: Optional[str]
    url_uncnsrd: Optional[str]
    url_engsub: Optional[str]
    score: Optional[float] = None


class GroupedSearchResponse(BaseModel):
    took_ms: float
    count: int
    next_cursor: Optional[str] = None
    has_more: bool = False
    has_previous: bool = False
    diversity_applied: bool = False
    items: List[GroupedVideoItem]
