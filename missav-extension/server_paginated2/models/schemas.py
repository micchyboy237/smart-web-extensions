from datetime import datetime
from typing import List, Literal, Optional, TypedDict, Union

from pydantic import BaseModel, Field, model_validator

GenreCodeInput = Optional[Union[str, List[str]]]
CompletionFilter = Literal["all", "complete", "incomplete"]
VideoSearchMode = Literal["fts", "semantic", "hybrid"]


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
    id: str
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


class SaveTopicsRequest(BaseModel):
    code: str = Field("juc")
    n_topics: int = Field(5, ge=1)
    n_docs: int = Field(100, ge=1)
    top_k: int = Field(10, ge=1)
    no_llm: bool = Field(False)


class WordScoreTD(TypedDict):
    word: str
    score: float


class CodeDashboardSummaryTD(TypedDict):
    code: str
    run_id: str
    created_at: datetime
    n_topics: int
    n_docs: int
    top_topic_name: Optional[str]
    top_topic_words: List[WordScoreTD]
    top_topic_rep_count: Optional[int]


class DashboardResponse(BaseModel):
    codes: List[CodeDashboardSummaryTD]


class TopicRunListItem(BaseModel):
    id: str
    code: str
    n_topics: int
    n_docs: int
    created_at: datetime


class TopicWordTD(TypedDict):
    word: str
    score: float
    rank: int


class RepresentativeDocTD(TypedDict):
    content: str
    membership_score: Optional[float]


class TopicSummaryTD(TypedDict):
    id: str
    topic_id: int
    name: Optional[str]
    representative_doc_count: int
    words: List[TopicWordTD]
    representative_docs: List[RepresentativeDocTD]


class DocumentAssignmentTD(TypedDict):
    source_index: int
    topic_id: int
    topic_name: str
    scores: List[float]
    content: str


class RunMetadataTD(TypedDict):
    id: str
    code: str
    n_topics: int
    n_docs: int
    top_k: int
    no_llm: bool
    created_at: datetime


class TopicRunDetailTD(TypedDict):
    run: RunMetadataTD
    topics: List[TopicSummaryTD]
    assignments: List[DocumentAssignmentTD]


class TopicSearchResultItem(BaseModel):
    run_id: str
    code: str
    topic_id: int
    topic_name: Optional[str]
    word: str
    score: float
