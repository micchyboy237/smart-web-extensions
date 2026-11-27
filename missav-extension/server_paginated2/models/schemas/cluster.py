from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, model_validator

from models.schemas.video import VideoItem
from models.types.common import CompletionFilter, GenreCodeInput


class ClusteredSearchRequest(BaseModel):
    query: Optional[str] = Field(None, min_length=1)
    min_cluster_size: int = Field(2, ge=2, le=20)
    cluster_selection_epsilon: float = Field(0.25, ge=0.0, le=1.0)
    cluster_candidate_limit: Optional[int] = Field(None, ge=10, le=50_000)
    candidate_source: Literal["recent", "random"] = "recent"
    genre: GenreCodeInput = None
    genres_mode: Literal["any", "all"] = "any"
    min_release_date: Optional[datetime] = None
    max_release_date: Optional[datetime] = None
    code: GenreCodeInput = None
    min_similarity: Optional[float] = Field(None, ge=0.0, le=1.0)
    completion_filter: CompletionFilter = "all"

    @model_validator(mode="after")
    def _check_query_dependencies(self) -> "ClusteredSearchRequest":
        if self.query is None and self.min_similarity is not None:
            raise ValueError("min_similarity requires a query")
        return self


class ClusterItem(BaseModel):
    cluster_id: int
    label: Optional[str] = None
    size: int
    centroid_similarity: Optional[float] = None
    consistency_score: Optional[float] = None
    avg_silhouette: Optional[float] = None
    misplaced_items_count: Optional[int] = None
    is_noise: bool = False
    items: List[VideoItem]


class ClusteredSearchResponse(BaseModel):
    query: str
    total_results: int
    candidate_limit: int
    n_clusters: int
    n_noise: int
    total_misplaced_items: int
    clusters: List[ClusterItem]
    took_ms: float
