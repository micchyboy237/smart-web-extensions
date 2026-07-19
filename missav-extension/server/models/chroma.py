"""Typed contracts for the ChromaDB repository layer.

These models describe what the repository returns/accepts. They are
intentionally separate from models/video.py (which describes the public
API surface) since the repository deals in raw stored shapes, not
validated request/response payloads.
"""

from typing import Any, Dict, List, Optional

import numpy as np
from pydantic import BaseModel, ConfigDict, Field


class VideoRecord(BaseModel):
    """A single record as stored in ChromaDB (id + document + metadata)."""

    id: str
    document: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class VideoRecordPage(BaseModel):
    """Unsliced page of records returned by a repository fetch."""

    records: List[VideoRecord] = Field(default_factory=list)
    total: int = 0


class QueryMatch(BaseModel):
    """A single nearest-neighbor match from a vector query."""

    id: str
    document: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    distance: float


class QueryResult(BaseModel):
    """Result of a vector similarity query (single query vector)."""

    matches: List[QueryMatch] = Field(default_factory=list)


class EmbeddingsResult(BaseModel):
    """Embeddings fetched for a set of IDs. Arbitrary numpy type allowed."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    ids: List[str]
    vectors: Optional[np.ndarray] = None

    @property
    def is_empty(self) -> bool:
        return self.vectors is None or len(self.vectors) == 0
