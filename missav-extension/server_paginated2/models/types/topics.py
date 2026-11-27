from datetime import datetime
from typing import List, Optional, TypedDict


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
