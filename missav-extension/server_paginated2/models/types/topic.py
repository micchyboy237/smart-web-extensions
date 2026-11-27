from datetime import datetime
from typing import List, Literal, Optional, TypedDict

MatchType = Literal["all", "semantic", "keyword", "hybrid"]


class WordScoreTD(TypedDict):
    word: str
    score: float


class CodeDashboardSummaryTD(TypedDict):
    """Lightweight summary for the dashboard grid."""

    code: str
    run_id: str
    created_at: datetime
    n_topics: int
    n_docs: int
    top_topic_name: Optional[str]
    top_topic_words: List[WordScoreTD]
    top_topic_rep_count: Optional[int]


class TopicWordTD(TypedDict):
    word: str
    score: float
    rank: int


class RepresentativeDocTD(TypedDict):
    content: str
    membership_score: Optional[float]
    video_id: Optional[str]
    thumbnail: Optional[str]
    preview: Optional[str]
    title: Optional[str]


class TopicSummaryTD(TypedDict):
    id: str
    topic_id: int
    name: Optional[str]
    representative_doc_count: int
    words: List[TopicWordTD]
    representative_docs: List[RepresentativeDocTD]
    embedding: Optional[List[float]]


class DocumentAssignmentTD(TypedDict):
    source_index: int
    video_id: str
    topic_id: int
    topic_name: str
    scores: List[float]
    content: str
    thumbnail: Optional[str]
    preview: Optional[str]
    title: Optional[str]


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


class VideoRowTD(TypedDict, total=False):
    """Represents a row from public.videos used in clustering."""

    id: str
    title: Optional[str]
    details: Optional[str]
    url: str
    code: str
    episode: str
    release_date: Optional[datetime]
    genres: Optional[List[str]]
    thumbnail: Optional[str]
    preview: Optional[str]
    embedding: Optional[List[float]]
    distance: Optional[float]


class TopicDataTD(TypedDict):
    """Intermediate structure for topic insertion."""

    topic_id: int
    name: Optional[str]
    representative_doc_count: int
    words: List[TopicWordTD]
    representative_docs: List[RepresentativeDocTD]
    embedding: Optional[List[float]]


class AssignmentDataTD(TypedDict):
    """Intermediate structure for assignment insertion."""

    source_index: int
    video_id: str  # Added
    topic_id: int
    topic_name: str
    scores: List[float]
    content: str


class RunDB(TypedDict):
    """Represents a row from public.topic_runs."""

    id: str
    code: str
    n_topics: int
    n_docs: int
    top_k: int
    no_llm: bool
    created_at: datetime
    model_params: Optional[str]
