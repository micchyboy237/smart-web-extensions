"""ChromaDB service for video storage and search."""

import logging
import time
from pathlib import Path
from typing import Optional

import numpy as np
from jet.adapters.llama_cpp import config as llm_config
from jet.adapters.llama_cpp.embed_utils import embed
from repositories.chroma_repository import ChromaVideoRepository
from utils.search_diversity import (
    compute_fetch_k,
    compute_shuffle_fetch_k,
    diversify_results,
    shuffle_and_diversify,
)

try:
    from app.config import PERSIST_DIR
except ImportError:
    PERSIST_DIR = str(
        Path("~/.cache/chrome_db/missav/chroma_data").expanduser().resolve()
    )

logger = logging.getLogger(__name__)


class ChromaVideoService:
    """
    ChromaDB-based video storage with embedding search.
    Uses persistent storage for video documents and their embeddings.
    """

    def __init__(
        self,
        persist_directory: str = PERSIST_DIR,
        collection_name: str = "missav_videos",
    ):
        """Initialize the service on top of the ChromaDB repository."""
        self.repository = ChromaVideoRepository(
            persist_directory=persist_directory,
            collection_name=collection_name,
        )
        self.collection_name = collection_name
        logger.info(
            f"🧩 [ChromaService] Ready (collection={collection_name}, "
            f"dir={persist_directory})"
        )

    def get_video(self, video_id: str) -> Optional[dict]:
        """Get a single video document + metadata by ID."""
        logger.info(f"🔍 [ChromaService] Fetching video by id: {video_id}")
        record = self.repository.get_by_id(video_id)
        if record is None:
            logger.warning(f"⚠️ [ChromaService] No video found for id: {video_id}")
            return None
        return {
            "id": record.id,
            "document": record.document,
            "metadata": record.metadata,
        }

    def get_videos_by_ids(self, video_ids: list[str]) -> list[dict]:
        """
        Get multiple videos by their IDs in a single call.

        Args:
            video_ids: List of video IDs to fetch

        Returns:
            List of {id, document, metadata} dicts for found videos.
            Missing IDs are silently skipped — check the returned list length.
        """
        if not video_ids:
            logger.info(
                "🔍 [ChromaService] get_videos_by_ids: empty list, returning []"
            )
            return []
        unique_ids = list(dict.fromkeys(video_ids))
        logger.info(
            f"🔍 [ChromaService] Fetching {len(unique_ids)} videos by ids: "
            f"{unique_ids[:5]}{'...' if len(unique_ids) > 5 else ''}"
        )
        start_time = time.time()
        page = self.repository.get_by_ids(unique_ids)
        videos = [
            {"id": r.id, "document": r.document, "metadata": r.metadata}
            for r in page.records
        ]
        found_ids = {r.id for r in page.records}
        missing = [vid for vid in unique_ids if vid not in found_ids]
        if missing:
            logger.warning(
                f"⚠️ [ChromaService] {len(missing)} IDs not found: {missing[:10]}"
                f"{'...' if len(missing) > 10 else ''}"
            )
        elapsed = (time.time() - start_time) * 1000
        logger.info(
            f"✅ [ChromaService] Found {len(videos)}/{len(unique_ids)} videos "
            f"in {elapsed:.2f}ms"
        )
        return videos

    def get_videos(
        self,
        limit: Optional[int] = None,
        offset: int = 0,
        where: Optional[dict] = None,
    ) -> dict:
        """
        Get all videos with pagination and optional metadata filtering.

        ChromaDB doesn't have a native "get all" with offset, so we use
        collection.get() which returns all items when no filters are given,
        then slice manually. For very large collections, consider using
        the where filter to narrow results.

        Args:
            limit: Max results to return (None = all videos, max 1000 if provided).
            offset: Number of results to skip (for pagination)
            where: Optional metadata filter (ChromaDB where clause)

        Returns:
            dict with keys:
                - videos: list of {id, document, metadata} dicts
                - total: total count matching the filter
                - limit: requested limit (or total count if None)
                - offset: requested offset
        """
        logger.info(
            f"📋 [ChromaService] Getting videos (limit={limit}, offset={offset})"
        )
        start_time = time.time()
        if limit is not None:
            limit = min(limit, 1000)
        page = self.repository.get_all(where=where)
        total = page.total
        if limit is not None:
            slice_end = offset + limit
            records_slice = page.records[offset:slice_end]
        else:
            records_slice = page.records[offset:]
        videos = [
            {"id": r.id, "document": r.document, "metadata": r.metadata}
            for r in records_slice
        ]
        elapsed = (time.time() - start_time) * 1000
        actual_limit = limit if limit is not None else len(videos)
        logger.info(
            f"✅ [ChromaService] Retrieved {len(videos)}/{total} videos "
            f"in {elapsed:.2f}ms"
        )
        return {
            "videos": videos,
            "total": total,
            "limit": actual_limit,
            "offset": offset,
        }

    def add_videos(self, videos: list[dict]) -> int:
        """
        Add videos to ChromaDB with embeddings.

        Now always uses upsert for "insert if new, update if existing".

        Args:
            videos: List of video metadata dicts

        Returns:
            Number of videos added/upserted
        """
        if not videos:
            return 0
        start_time = time.time()
        ids = []
        documents = []
        metadatas = []
        for video in videos:
            video_id = video.get("id") or video.get("videoId")
            if not video_id:
                continue
            doc_text = self._create_document_text(video)
            ids.append(video_id)
            documents.append(doc_text)
            metadatas.append(
                {
                    "id": video_id,
                    "url": video.get("url") or "",
                    "text": video.get("text") or "",
                    "code": video.get("code") or "",
                    "episode": video.get("episode") or "",
                    "video_id": video.get("videoId") or "",
                    "thumbnail": video.get("thumbnail") or "",
                    "preview": video.get("preview") or "",
                }
            )
        if not ids:
            logger.warning("No valid videos to add")
            return 0
        try:
            self.repository.upsert(ids=ids, documents=documents, metadatas=metadatas)
            elapsed = (time.time() - start_time) * 1000
            logger.info(f"Upserted {len(ids)} videos in {elapsed:.2f}ms")
        except Exception as e:
            logger.error(f"Failed to upsert videos: {e}")
            raise
        return len(ids)

    def search(
        self,
        query: str,
        top_k: int = 20,
        where: Optional[dict] = None,
        where_document: Optional[dict] = None,
    ) -> list[dict]:
        """
        Semantic search with optional metadata filtering.

        Args:
            query: Search query
            top_k: Number of results
            where: Metadata filter (ChromaDB where clause)
            where_document: Document content filter

        Returns:
            List of {id, score, document, metadata} dicts,
            sorted by score descending (best match first).
        """
        start_time = time.time()
        query_prefix = llm_config.EMBED_QUERY_PREFIX or None
        logger.info(f"🧠 [ChromaService] Embedding query with prefix={query_prefix!r}")
        query_embedding = embed(
            query,
            return_format="list",
            prefix=query_prefix,
        )
        query_result = self.repository.query_by_embedding(
            query_embedding=query_embedding,
            n_results=top_k,
            where=where,
            where_document=where_document,
        )
        elapsed = (time.time() - start_time) * 1000
        logger.info(
            f"✅ [ChromaService] search completed in {elapsed:.2f}ms, "
            f"returned {len(query_result.matches)} results"
        )
        formatted = []
        for match in query_result.matches:
            similarity = 1 - (match.distance / 2)
            formatted.append(
                {
                    "id": match.id,
                    "score": float(similarity),
                    "document": match.document,
                    "metadata": match.metadata,
                }
            )
        return formatted

    def get_embeddings(self, ids: list[str]) -> Optional[np.ndarray]:
        """Get embeddings for specific video IDs."""
        result = self.repository.get_embeddings(ids)
        if result.is_empty:
            return None
        return result.vectors

    def get_count(self) -> int:
        """Get total number of videos in collection."""
        return self.repository.count()

    def delete_videos(self, ids: list[str]) -> None:
        """Delete videos by ID."""
        if ids:
            self.repository.delete(ids)

    def _create_document_text(self, video: dict) -> str:
        """Create searchable text from video metadata."""
        parts = []
        if video.get("text"):
            parts.append(video["text"])
        if video.get("code"):
            parts.append(f"Series: {video['code']}")
        if video.get("episode"):
            parts.append(f"Episode: {video['episode']}")
        if video.get("videoId"):
            parts.append(f"ID: {video['videoId']}")
        return " | ".join(parts)


_service_instance: Optional["ChromaVideoService"] = None


def init_service(persist_directory: str) -> "ChromaVideoService":
    """Call ONCE at startup (server.py) to create the shared instance."""
    global _service_instance
    _service_instance = ChromaVideoService(persist_directory=persist_directory)
    logger.info(f"🧩 [ChromaService] Singleton initialized (dir={persist_directory})")
    return _service_instance


def get_service() -> "ChromaVideoService":
    """Get the shared instance, lazily creating it with defaults if needed."""
    global _service_instance
    if _service_instance is None:
        logger.warning(
            "⚠️ [ChromaService] Singleton not initialized yet — using default dir"
        )
        _service_instance = ChromaVideoService()
    return _service_instance


def get_count() -> int:
    return get_service().get_count()


def search(
    query: str,
    top_k: int = 20,
    where: Optional[dict] = None,
    where_document: Optional[dict] = None,
    candidate_ids: Optional[list[str]] = None,
    score_threshold: Optional[float] = None,
    diversity: float = 0.5,
    shuffle_seed: Optional[int] = None,
) -> list[dict]:
    """
    Semantic search with optional ID restriction, score filtering,
    diversity-aware result selection, and shuffle support.

    Shuffle is now INDEPENDENT of diversity:
    - If shuffle_seed is provided, shuffle activates regardless of diversity value
    - Shuffle can work with diversity=0.0 (pure relevance)
    - When both shuffle and diversity are active, shuffle samples first, then MMR diversifies
    ...
    """
    diversity = max(0.0, min(1.0, diversity))

    # Shuffle activates if seed is provided, regardless of diversity
    is_shuffle = shuffle_seed is not None

    max_from_pool = len(candidate_ids) if candidate_ids else None
    effective_top_k = min(top_k, max_from_pool) if max_from_pool is not None else top_k

    logger.info(
        f"🔍 [chroma_service.search] Received: "
        f"query='{query[:80]}', top_k={top_k}, "
        f"diversity={diversity}, shuffle_seed={shuffle_seed}, "
        f"is_shuffle={is_shuffle}, "
        f"candidate_ids={'present(' + str(len(candidate_ids)) + ')' if candidate_ids else 'None'}"
    )

    combined_where = where
    if candidate_ids:
        id_filter = {"id": {"$in": candidate_ids}}
        combined_where = (
            {"$and": [id_filter, combined_where]} if combined_where else id_filter
        )

    # Calculate fetch_k based on whether we're shuffling or diversifying
    if is_shuffle:
        # Shuffle needs a larger pool to sample from
        raw_fetch_k = compute_shuffle_fetch_k(effective_top_k)
        logger.info(f"🔀 [chroma_service] Shuffle mode: using shuffle_fetch_k")
    elif diversity > 0:
        # Normal diversity path
        raw_fetch_k = compute_fetch_k(effective_top_k, diversity)
        logger.info(f"🎨 [chroma_service] Diversity mode: using normal fetch_k")
    else:
        # Pure relevance, no overfetching needed
        raw_fetch_k = effective_top_k
        logger.info(f"🔍 [chroma_service] Relevance-only mode: no overfetching")

    fetch_k = (
        min(raw_fetch_k, max_from_pool) if max_from_pool is not None else raw_fetch_k
    )

    logger.info(
        f"🔍 [chroma_service] fetch_k={fetch_k} "
        f"(raw={raw_fetch_k}, max_from_pool={max_from_pool}, "
        f"diversity={diversity}, is_shuffle={is_shuffle})"
    )

    results = get_service().search(query, fetch_k, combined_where, where_document)

    logger.info(
        f"🔍 [chroma_service] ChromaDB returned {len(results)} results "
        f"(fetch_k={fetch_k})"
    )

    if candidate_ids:
        candidate_set = set(candidate_ids)
        before_filter = len(results)
        results = [r for r in results if r["id"] in candidate_set]
        if len(results) < before_filter:
            logger.warning(
                f"⚠️ [chroma_service] Post-filtered out "
                f"{before_filter - len(results)} results not in candidate_ids"
            )

    if score_threshold is not None:
        before = len(results)
        results = [r for r in results if r["score"] >= score_threshold]
        logger.info(
            f"🎯 [chroma_service] score_threshold={score_threshold} kept "
            f"{len(results)}/{before} results"
        )

    if len(results) <= effective_top_k:
        logger.info(
            f"🔍 [chroma_service] {len(results)} results "
            f"(≤ effective_top_k={effective_top_k}), returning all"
        )
        return results

    # Apply shuffle if seed is provided (regardless of diversity)
    if is_shuffle:
        logger.info(f"🔀 [chroma_service] Shuffling with seed={shuffle_seed}")

        # If diversity is also enabled, shuffle then diversify
        if diversity > 0:
            logger.info(
                f"🔀🎨 [chroma_service] Shuffle + Diversity: "
                f"shuffling first, then applying MMR with diversity={diversity}"
            )
            return shuffle_and_diversify(
                results,
                top_k=effective_top_k,
                diversity=diversity,
                seed=shuffle_seed,
                get_embeddings_fn=get_embeddings,
            )
        else:
            # Shuffle without diversity: just sample and return
            logger.info(
                f"🔀 [chroma_service] Shuffle only (no diversity): "
                f"sampling with seed={shuffle_seed}"
            )
            from utils.search_diversity import sample_candidate_pool

            sampled = sample_candidate_pool(
                results,
                sample_size=effective_top_k,
                seed=shuffle_seed,
                relevance_bias=1.0,  # Balanced bias for shuffle-only mode
            )
            # Sort by score after sampling to maintain some relevance ordering
            sampled.sort(key=lambda r: r["score"], reverse=True)
            return sampled

    # Apply diversity without shuffle
    if diversity > 0:
        logger.info(
            f"🎨 [chroma_service] Diversifying (no shuffle) with diversity={diversity}"
        )
        return diversify_results(
            results,
            top_k=effective_top_k,
            diversity=diversity,
            get_embeddings_fn=get_embeddings,
        )

    # Pure relevance, no shuffle, no diversity
    logger.info(
        f"🔍 [chroma_service] Returning top {effective_top_k} results by score "
        f"(no diversity, no shuffle)"
    )
    return results[:effective_top_k]


def _reorder_by_candidate_ids(
    results: list[dict], candidate_ids: list[str]
) -> list[dict]:
    """
    Reorder search results to match the order of candidate_ids.
    Results not in candidate_ids are placed at the end, sorted by score descending.

    Args:
        results: Search results from ChromaDB (similarity-ordered)
        candidate_ids: The desired order of IDs

    Returns:
        Results reordered to match candidate_ids order
    """
    # Build a lookup by ID
    results_by_id = {r["id"]: r for r in results}

    reordered = []
    seen_ids = set()

    # First, add results in candidate_ids order
    for cid in candidate_ids:
        if cid in results_by_id and cid not in seen_ids:
            reordered.append(results_by_id[cid])
            seen_ids.add(cid)

    # Then append any remaining results (not in candidate_ids), sorted by score
    remaining = [r for r in results if r["id"] not in seen_ids]
    remaining.sort(key=lambda r: r["score"], reverse=True)
    reordered.extend(remaining)

    logger.info(
        f"📋 [_reorder_by_candidate_ids] Reordered {len(reordered)} results: "
        f"{len(reordered) - len(remaining)} from candidate_ids + {len(remaining)} extra"
    )

    return reordered


def get_embeddings(ids: list[str]) -> Optional[np.ndarray]:
    return get_service().get_embeddings(ids)


def add_videos(videos: list[dict]) -> int:
    return get_service().add_videos(videos)


def get_video(video_id: str) -> Optional[dict]:
    return get_service().get_video(video_id)


def get_videos_by_ids(video_ids: list[str]) -> list[dict]:
    """Get multiple videos by their IDs. Returns only found videos."""
    return get_service().get_videos_by_ids(video_ids)


def get_videos(
    limit: Optional[int] = None,
    offset: int = 0,
    where: Optional[dict] = None,
) -> dict:
    return get_service().get_videos(limit=limit, offset=offset, where=where)


def delete_videos(ids: list[str]) -> None:
    return get_service().delete_videos(ids)


if __name__ == "__main__":
    from main._main_chroma_service import main

    main()
