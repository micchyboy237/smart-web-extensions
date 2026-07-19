"""ChromaDB service for video storage and search."""

import logging
import time
from pathlib import Path
from typing import Optional

import numpy as np
from jet.adapters.llama_cpp import config as llm_config
from jet.adapters.llama_cpp.embed_utils import embed
from repositories.chroma_repository import ChromaVideoRepository

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

        # Deduplicate while preserving order
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

        # Log any missing IDs
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

        # Apply safety cap only if limit is provided
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
        # Prepare documents for embedding
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
                    "id": video_id,  # <-- Mirrors the Chroma-native id
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
        # Always upsert (insert new, update existing)
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
            List of {id, score, document, metadata} dicts
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


# ====================== MODULE-LEVEL SINGLETON ======================
# routes/*.py do `from services import chroma_service` and then call
# chroma_service.get_count(), chroma_service.search(...) directly on
# the MODULE. These wrappers delegate to one shared instance so every
# route hits the same ChromaDB collection instead of each creating
# (or worse, needing but not having) its own.
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
) -> list[dict]:
    """
    Semantic search with optional ID restriction and score filtering.

    Args:
        query: Search query
        top_k: Number of results
        where: Metadata filter (ChromaDB where clause)
        where_document: Document content filter
        candidate_ids: Optional whitelist of video IDs to search within.
                       When provided, only these IDs are considered.
                       Used for "limit to page" mode.
        score_threshold: If set, drop results with similarity below this
                         value. Applied after the query, so may return
                         fewer than top_k.
    """
    combined_where = where
    if candidate_ids:
        id_filter = {"id": {"$in": candidate_ids}}
        combined_where = (
            {"$and": [id_filter, combined_where]} if combined_where else id_filter
        )
        logger.info(
            f"🔍 [chroma_service] search: query='{query[:80]}', "
            f"candidate_ids={len(candidate_ids)}, top_k={top_k}"
        )

    results = get_service().search(query, top_k, combined_where, where_document)

    if score_threshold is not None:
        before = len(results)
        results = [r for r in results if r["score"] >= score_threshold]
        logger.info(
            f"🎯 [chroma_service] score_threshold={score_threshold} kept "
            f"{len(results)}/{before} results"
        )

    return results


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
