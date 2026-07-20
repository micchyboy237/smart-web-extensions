"""Smart search endpoint with diversity and filters."""

import logging
import time
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from services import chroma_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["search"])

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class SearchRequest(BaseModel):
    """Request body for the smart search endpoint."""

    query: str = Field(
        ...,
        min_length=1,
        description="Natural language search query",
        examples=["cute idol"],
    )
    top_k: int = Field(
        default=20,
        ge=1,
        le=200,
        description="Maximum number of results to return",
    )
    diversity: Literal["low", "medium", "high"] = Field(
        default="medium",
        description=(
            "Diversity level for result selection. "
            "'low' = pure relevance (0.0), "
            "'medium' = balanced (0.5), "
            "'high' = maximum diversity (1.0)"
        ),
    )
    auto_shuffle: bool = Field(
        default=False,
        description=(
            "When True, automatically generates a unique shuffle seed "
            "so every call returns a different (but still diverse & "
            "relevant) ordering. The seed is returned in the response "
            "so the same shuffle can be reproduced later if desired."
        ),
    )
    shuffle_seed: Optional[int] = Field(
        default=None,
        description=(
            "Explicit shuffle seed for reproducible shuffles. "
            "Has no effect when diversity='low'. "
            "Ignored when auto_shuffle=True."
        ),
    )
    candidate_ids: Optional[list[str]] = Field(
        default=None,
        description="Restrict search to these video IDs (e.g., current page)",
    )
    score_threshold: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Minimum similarity score (0.0-1.0) to include a result",
    )


class SearchResultItem(BaseModel):
    """A single search result."""

    id: str
    score: float
    document: str
    metadata: dict


class SearchResponse(BaseModel):
    """Response body for the smart search endpoint."""

    results: list[SearchResultItem]
    query: str
    diversity: float
    diversity_label: Literal["low", "medium", "high"]
    shuffle_seed: Optional[int] = None
    auto_shuffle: bool
    total_found: int
    time_ms: float


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Map friendly labels → numeric diversity values
DIVERSITY_MAP: dict[str, float] = {
    "low": 0.0,
    "medium": 0.5,
    "high": 1.0,
}


def _resolve_shuffle_seed(
    auto_shuffle: bool, explicit_seed: Optional[int]
) -> Optional[int]:
    """
    Resolve the effective shuffle seed.

    Flow:
    ┌──────────────┬────────────────┬──────────────────────────┐
    │ auto_shuffle │ explicit_seed  │ Result                   │
    ├──────────────┼────────────────┼──────────────────────────┤
    │ True         │ any            │ random UUID-based seed   │
    │ False        │ provided       │ explicit_seed            │
    │ False        │ None           │ None (no shuffle)        │
    └──────────────┴────────────────┴──────────────────────────┘
    """
    if auto_shuffle:
        # Generate a unique, reproducible-from-response seed.
        # Using UUID4 int is overkill but guarantees uniqueness per call.
        seed = uuid.uuid4().int & 0x7FFFFFFF  # keep it positive 31-bit
        logger.info(f"🔀 Auto-shuffle enabled — generated seed={seed}")
        return seed
    return explicit_seed


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post("/search", response_model=SearchResponse)
async def smart_search(req: SearchRequest):
    """
    Smart semantic search with diversity-aware ranking and optional shuffling.

    **Diversity levels:**
    - `low`    → pure relevance (best semantic match first)
    - `medium` → balanced (default, good mix of relevance & variety)
    - `high`   → maximum diversity (most varied results)

    **Shuffle behaviour:**
    - Set `auto_shuffle=true` to get a fresh ordering on every call.
      The generated seed is returned so you can replay the same shuffle.
    - Pass an explicit `shuffle_seed` for reproducible shuffles.
    - Shuffle has no effect when diversity is `low`.

    **Candidate restriction:**
    - Provide `candidate_ids` to limit search to a specific set of videos
      (e.g., only videos visible on the current page).
    """
    start_time = time.time()

    # --- Resolve diversity -------------------------------------------------
    diversity_value = DIVERSITY_MAP[req.diversity]
    logger.info(
        f"🔍 [search] query='{req.query[:100]}' top_k={req.top_k} "
        f"diversity={req.diversity}({diversity_value}) "
        f"auto_shuffle={req.auto_shuffle} candidate_ids={len(req.candidate_ids) if req.candidate_ids else 'all'}"
    )

    # --- Resolve shuffle seed ----------------------------------------------
    effective_seed = _resolve_shuffle_seed(req.auto_shuffle, req.shuffle_seed)
    if effective_seed is not None and diversity_value == 0.0:
        logger.info("🔍 [search] Shuffle requested but diversity=low — shuffle ignored")

    # --- Run search ---------------------------------------------------------
    try:
        results = chroma_service.search(
            query=req.query,
            top_k=req.top_k,
            candidate_ids=req.candidate_ids,
            score_threshold=req.score_threshold,
            diversity=diversity_value,
            shuffle_seed=effective_seed,
        )
    except Exception as e:
        logger.error(f"❌ [search] Search failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

    elapsed = (time.time() - start_time) * 1000

    # --- Build response -----------------------------------------------------
    items = [SearchResultItem(**r) for r in results]
    logger.info(
        f"✅ [search] Returned {len(items)} results in {elapsed:.2f}ms "
        f"(seed={effective_seed})"
    )

    return SearchResponse(
        results=items,
        query=req.query,
        diversity=diversity_value,
        diversity_label=req.diversity,
        shuffle_seed=effective_seed,
        auto_shuffle=req.auto_shuffle,
        total_found=len(items),
        time_ms=round(elapsed, 2),
    )
