# Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server/routes/search.py
"""Smart search endpoint with diversity and filters."""

import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from models.video import (
    SearchQuery,
    SearchResponse,
    SearchResult,
)
from services import chroma_service
from utils.search_strategies import QueryUnderstanding, diversity_search

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["search"])


@router.post("/search", response_model=SearchResponse)
async def smart_search(query: SearchQuery):
    """
    Smart search with inclusion/exclusion filters and diversity.

    Supports:
    - Semantic, keyword, hybrid, and ensemble search strategies
    - Code and episode inclusion/exclusion
    - Diversity-aware ranking (MMR algorithm)
    - Query understanding for natural language queries

    Examples:
    - "popular juq videos from 300-500" → code=juq, episode_range=[300,500]
    - "new mxgs content not fc2" → include=mxgs, exclude=fc2
    - "something diverse like juq-373" → diversity=high, similar_to=juq-373
    """

    start_time = time.time()
    logger.info(f"🔍 Search: '{query.query[:100]}...' (type={query.search_type})")

    try:
        # Step 1: Understand the query (natural language parsing)
        understanding = _parse_query_intent(query)

        # Step 2: Build ChromaDB where filter (exclusions)
        where_filter = _build_where_filter(query)

        # Step 3: Execute search (get more candidates for diversity filtering)
        candidate_k = min(query.top_k * 3, 100)

        results = chroma_service.search(
            query=query.query,
            top_k=candidate_k,
            where=where_filter,
        )

        logger.info(f"📊 Retrieved {len(results)} candidates")

        # Step 4: Apply post-retrieval filters (inclusions, ranges)
        results = _apply_post_filters(results, query)

        # Step 5: Apply diversity (MMR algorithm)
        if query.diversity_factor > 0 and len(results) > 1:
            diversity_search.diversity_factor = query.diversity_factor
            diversity_search.max_per_code = query.max_per_code

            # Get embeddings for MMR if available
            embeddings = None
            if query.diversity_factor > 0:
                ids = [r["id"] for r in results]
                embeddings = chroma_service.get_embeddings(ids)
                logger.info(
                    f"📊 Fetched {len(embeddings) if embeddings is not None else 0} embeddings for diversity"
                )

            results = diversity_search.apply_diversity(results, embeddings)
            logger.info(
                f"🎨 Diversified to {len(results)} results "
                f"(factor={query.diversity_factor})"
            )

        # Step 6: Limit to requested top_k
        results = results[: query.top_k]

        # Step 7: Format response
        elapsed = (time.time() - start_time) * 1000

        search_results = [
            SearchResult(
                id=r["id"],
                score=r["score"],
                document=r.get("document", ""),
                metadata=r.get("metadata", {}),
                rank=idx + 1,
            )
            for idx, r in enumerate(results)
        ]

        return SearchResponse(
            results=search_results,
            total_candidates=candidate_k,
            filters_applied={
                "include_codes": query.include_codes,
                "exclude_codes": query.exclude_codes,
                "exclude_ids": query.exclude_ids,
                "diversity_factor": query.diversity_factor,
                "max_per_code": query.max_per_code,
                "search_type": query.search_type,
            },
            search_time_ms=elapsed,
            query_understanding=understanding,
        )
    except Exception as e:
        logger.error(f"❌ Search failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _parse_query_intent(query: SearchQuery) -> Optional[dict]:
    """
    Parse natural language query to extract intent and filters.
    Only used for hybrid and ensemble search types.
    """
    if query.search_type not in ("hybrid", "ensemble"):
        return None

    understanding = QueryUnderstanding.parse(query.query)
    logger.info(f"🧠 Query understanding: {understanding}")

    # Apply extracted filters if not explicitly set by user
    if not query.include_codes and understanding.get("extracted_codes"):
        query.include_codes = understanding["extracted_codes"]
    if not query.exclude_codes and understanding.get("exclude_codes"):
        query.exclude_codes = understanding["exclude_codes"]
    if understanding.get("diversity_hint") == "high":
        query.diversity_factor = max(query.diversity_factor, 0.5)

    return understanding


def _build_where_filter(query: SearchQuery) -> Optional[dict]:
    """
    Build ChromaDB where filter from query parameters.

    ChromaDB supports metadata filtering with $and, $or, $ne operators.
    Only exclusion filters are applied here (inclusions done post-retrieval).
    """
    conditions = []

    # Exclude codes (e.g., block fc2 series)
    if query.exclude_codes:
        for code in query.exclude_codes:
            conditions.append({"code": {"$ne": code}})

    # Exclude specific IDs (watched videos)
    if query.exclude_ids:
        for vid_id in query.exclude_ids:
            conditions.append({"video_id": {"$ne": vid_id}})

    if not conditions:
        return None

    return {"$and": conditions} if len(conditions) > 1 else conditions[0]


def _apply_post_filters(
    results: list[dict],
    query: SearchQuery,
) -> list[dict]:
    """
    Apply inclusion filters and range queries.

    Done in Python because ChromaDB doesn't support complex inclusion
    lists or range queries efficiently in the where clause.
    """
    filtered = []

    for r in results:
        metadata = r.get("metadata", {})
        code = metadata.get("code", "")
        episode = metadata.get("episode", "")

        # Include only specific codes
        if query.include_codes and code not in query.include_codes:
            continue

        # Include only specific episodes
        if query.include_episodes and episode not in query.include_episodes:
            continue

        # Episode range filter
        if query.include_episode_range:
            try:
                ep_num = int(episode)
                if not (
                    query.include_episode_range[0]
                    <= ep_num
                    <= query.include_episode_range[1]
                ):
                    continue
            except (ValueError, TypeError):
                continue

        filtered.append(r)

    removed = len(results) - len(filtered)
    if removed > 0:
        logger.debug(f"🔍 Post-filters removed {removed} results")

    return filtered
