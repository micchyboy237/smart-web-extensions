from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


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
