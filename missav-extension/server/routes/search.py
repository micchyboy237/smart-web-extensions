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
    enable_diversity: bool = Field(
        default=False,
        description="Enable diversity-aware result selection. When False, returns pure relevance-ranked results.",
    )
    diversity: Literal["low", "medium", "high"] = Field(
        default="medium",
        description=(
            "Diversity level for result selection. "
            "'low' = pure relevance (0.0), "
            "'medium' = balanced (0.5), "
            "'high' = maximum diversity (1.0). "
            "Only applied when enable_diversity=True."
        ),
    )
    auto_shuffle: bool = Field(
        default=False,
        description=(
            "When True, automatically generates a unique shuffle seed "
            "so every call returns a different (but still diverse & "
            "relevant) ordering. The seed is returned in the response "
            "so the same shuffle can be reproduced later if desired. "
            "Only applied when enable_diversity=True."
        ),
    )
    shuffle_seed: Optional[int] = Field(
        default=None,
        description=(
            "Explicit shuffle seed for reproducible shuffles. "
            "Has no effect when diversity='low' or enable_diversity=False. "
            "Ignored when auto_shuffle=True."
        ),
    )
    candidate_ids: Optional[list[str]] = Field(
        default=None,
        description="Restrict search to these video IDs (e.g., current page). Results are always sorted by score descending.",
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

    Shuffle is now INDEPENDENT of diversity settings.

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
        seed = uuid.uuid4().int & 0x7FFFFFFF
        logger.info(f"🔀 Auto-shuffle enabled — generated seed={seed}")
        return seed

    if explicit_seed is not None:
        logger.info(f"🔀 Using explicit shuffle seed={explicit_seed}")
        return explicit_seed

    logger.debug("🔀 No shuffle requested")
    return None


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post("/search", response_model=SearchResponse)
async def smart_search(req: SearchRequest):
    """
    Smart semantic search with optional diversity-aware ranking and shuffling.

    **Shuffle behaviour (INDEPENDENT of diversity):**
    - Set `auto_shuffle=true` to get a fresh ordering on every call.
      The generated seed is returned so you can replay the same shuffle.
    - Pass an explicit `shuffle_seed` for reproducible shuffles.
    - Shuffle works with ANY diversity setting (including "low"/disabled).

    **Diversity control:**
    - Set `enable_diversity=true` to activate MMR-based diversity re-ranking.
    - When `enable_diversity=false` (default), returns pure relevance-ranked results.
    ...
    """
    start_time = time.time()

    # Log incoming request parameters for debugging
    logger.info(
        f"📥 [search] Incoming request: "
        f"enable_diversity={req.enable_diversity}, "
        f"diversity={req.diversity}, "
        f"auto_shuffle={req.auto_shuffle}, "
        f"shuffle_seed={req.shuffle_seed}"
    )

    # Resolve diversity value
    if req.enable_diversity:
        diversity_value = DIVERSITY_MAP[req.diversity]
        logger.info(
            f"⚙️ [search] Diversity ENABLED: level={req.diversity} ({diversity_value})"
        )
    else:
        diversity_value = 0.0
        logger.info("🔍 [search] Diversity DISABLED — pure relevance ranking")

    # Resolve shuffle seed (INDEPENDENT of diversity)
    effective_seed = _resolve_shuffle_seed(req.auto_shuffle, req.shuffle_seed)

    # Determine if shuffle will actually be applied
    will_shuffle = effective_seed is not None
    logger.info(
        f"🔀 [search] Shuffle status: "
        f"enabled={will_shuffle}, seed={effective_seed}, "
        f"auto_shuffle={req.auto_shuffle}"
    )

    logger.info(
        f"🔍 [search] Executing search: query='{req.query[:100]}' "
        f"top_k={req.top_k} "
        f"diversity={req.diversity}({diversity_value}) "
        f"shuffle_seed={effective_seed} "
        f"candidate_ids={len(req.candidate_ids) if req.candidate_ids else 'all'}"
    )

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
    items = [SearchResultItem(**r) for r in results]

    logger.info(
        f"✅ [search] Returned {len(items)} results in {elapsed:.2f}ms "
        f"(diversity={diversity_value}, seed={effective_seed})"
    )

    return SearchResponse(
        results=items,
        query=req.query,
        diversity=diversity_value,
        diversity_label=req.diversity if req.enable_diversity else "low",
        shuffle_seed=effective_seed,
        auto_shuffle=req.auto_shuffle,
        total_found=len(items),
        time_ms=round(elapsed, 2),
    )
