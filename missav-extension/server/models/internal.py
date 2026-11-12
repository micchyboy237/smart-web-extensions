"""Internal typed dictionaries for strict type checking."""

from typing import List, Optional, TypedDict

import numpy as np


class Video(TypedDict, total=False):
    """Public-facing video data structure. Excludes embedding."""

    id: str
    url: str
    code: str
    episode: str
    video_id: str
    title: Optional[str]
    thumbnail: Optional[str]
    preview: Optional[str]
    details: Optional[str]
    release_date: Optional[str]
    genres: Optional[List[str]]


class VideoRow(Video):
    """Internal DB row structure. Includes embedding for upserts."""

    embedding: Optional[List[float]]


class SearchMatch(TypedDict):
    """Raw result from pgvector query. Includes distance/score."""

    id: str
    rank: int
    score: float
    distance: float
    url: str
    code: str
    episode: str
    video_id: str
    title: Optional[str]
    thumbnail: Optional[str]
    preview: Optional[str]
    details: Optional[str]
    release_date: Optional[str]
    genres: Optional[List[str]]


class SearchResultItem(SearchMatch):
    """A single item in a search response.
    Inherits all fields from SearchMatch.
    """

    pass


class CodeCount(TypedDict):
    """Aggregated code count."""

    code: str
    count: int


class VideoGroup(TypedDict):
    """A group of videos sharing a code."""

    code: str
    count: int
    videos: List[Video]


class PaginatedResult(TypedDict):
    """Generic paginated response structure."""

    records: List[Video]
    total: int


class VideoListResponse(TypedDict):
    """Response for get_videos."""

    videos: List[Video]
    total: int
    limit: int
    offset: int


class CodeSummary(TypedDict):
    """Single code summary item."""

    code: str
    count: int


class CodeResponse(TypedDict):
    """Response for get_codes."""

    codes: List[CodeSummary]
    code_count: int
    total_videos: int


class GroupedVideoResponse(TypedDict):
    """Response for get_videos_grouped_by_code."""

    groups: List[VideoGroup]
    group_count: int
    total_videos: int


class EmbeddingsResult(TypedDict):
    """Result of fetching embeddings for a set of IDs."""

    ids: List[str]
    vectors: np.ndarray  # Shape: (n_ids, embedding_dim)
