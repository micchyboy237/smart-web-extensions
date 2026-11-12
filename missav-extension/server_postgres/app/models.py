from datetime import datetime
from typing import List, Literal, Optional, Union

from pydantic import BaseModel, Field


class DateRange(BaseModel):
    start: Optional[datetime] = None
    end: Optional[datetime] = None


class SearchFilters(BaseModel):
    codes: Optional[List[str]] = None
    genres: Optional[List[str]] = None
    date_range: Optional[DateRange] = None
    has_thumbnail: Optional[bool] = None


class SearchRequest(BaseModel):
    mode: Literal["semantic", "hybrid", "metadata", "diverse"] = "semantic"
    query: Optional[Union[str, List[str]]] = None
    limit: int = 10
    keyword_weight: float = Field(0.5, ge=0, le=1)
    diversity_level: float = Field(0.5, ge=0, le=1)
    sort_by: Literal["release_date", "popularity"] = "release_date"
    filters: Optional[SearchFilters] = None
