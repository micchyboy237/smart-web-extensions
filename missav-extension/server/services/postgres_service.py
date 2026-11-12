"""PostgreSQL service for video storage and search."""

import logging
import re
import time
from typing import Any, Dict, List, Optional

import numpy as np
from jet.adapters.llama_cpp.config import EMBED_DOC_PREFIX, EMBED_QUERY_PREFIX
from jet.adapters.llama_cpp.embed_utils import embed
from models.internal import (
    CodeResponse,
    CodeSummary,
    GroupedVideoResponse,
    SearchResultItem,
    Video,
    VideoGroup,
    VideoListResponse,
    VideoRow,
)
from repositories.postgres_repository import PostgresVideoRepository
from utils.search_diversity import (
    compute_fetch_k,
    compute_shuffle_fetch_k,
    diversify_results,
    shuffle_and_diversify,
)

logger = logging.getLogger(__name__)


def clean_title(title: str) -> str:
    if not title:
        return ""
    pattern = r"^[A-Za-z0-9]+-[A-Za-z0-9]+\s+"
    return re.sub(pattern, "", title).strip()


def format_for_embedding(record: Dict[str, Any]) -> str:
    parts = []
    if record.get("title"):
        parts.append(record["title"])
    if record.get("details"):
        parts.append(record["details"])
    if record.get("code"):
        parts.append(f"Series: {record['code']}")
    if record.get("episode"):
        parts.append(f"Episode: {record['episode']}")
    genres = record.get("genres")
    if genres and isinstance(genres, list):
        parts.append(f"Genres: {', '.join(genres)}")
    return " | ".join(parts)


class PostgresVideoService:
    def __init__(self, table_name: str = "videos"):
        self.repository = PostgresVideoRepository(table_name=table_name)
        self.table_name = table_name
        logger.info(f"🧩 [PostgresService] Ready (table={table_name})")

    def get_video(self, video_id: str) -> Optional[Video]:
        return self.repository.get_by_id(video_id)

    def get_videos_by_ids(self, video_ids: List[str]) -> List[Video]:
        return self.repository.get_by_ids(video_ids)

    def get_videos(
        self, limit: Optional[int] = None, offset: int = 0, where: Optional[Dict] = None
    ) -> VideoListResponse:
        if limit is not None:
            limit = min(limit, 1000)

        result = self.repository.get_all(where=where, limit=limit, offset=offset)

        actual_limit = limit if limit is not None else len(result["records"])

        return {
            "total": result["total"],
            "limit": actual_limit,
            "offset": offset,
            "videos": result["records"],
        }

    def get_codes(self) -> CodeResponse:
        counts = self.repository.get_all_codes()
        codes: List[CodeSummary] = [{"code": k, "count": v} for k, v in counts.items()]

        return {
            "code_count": len(codes),
            "total_videos": sum(counts.values()),
            "codes": codes,
        }

    def get_videos_grouped_by_code(
        self, min_count: int = 1, top_n: Optional[int] = None, limit_per_group: int = 20
    ) -> GroupedVideoResponse:
        counts = self.repository.get_all_codes()
        filtered_codes = {k: v for k, v in counts.items() if v >= min_count}
        sorted_codes = sorted(filtered_codes.items(), key=lambda x: x[1], reverse=True)

        if top_n:
            sorted_codes = sorted_codes[:top_n]

        groups: List[VideoGroup] = []
        total_videos = sum(v for _, v in filtered_codes.items())

        for code, count in sorted_codes:
            page = self.repository.get_all(
                where={"code": code}, limit=limit_per_group, offset=0
            )
            groups.append({"code": code, "count": count, "videos": page["records"]})

        return {
            "groups": groups,
            "group_count": len(groups),
            "total_videos": total_videos,
        }

    def upsert_videos(self, videos: List[Dict]) -> int:
        if not videos:
            return 0

        start_time = time.time()
        rows_to_upsert: List[VideoRow] = []
        texts_to_embed: List[str] = []

        all_ids = [
            v.get("id") or v.get("videoId")
            for v in videos
            if v.get("id") or v.get("videoId")
        ]

        existing_map: Dict[str, VideoRow] = {}
        if all_ids:
            existing_records = self.repository.get_by_ids(all_ids)
            for rec in existing_records:
                existing_map[rec["id"]] = rec

        for video in videos:
            video_id = video.get("id") or video.get("videoId")
            if not video_id:
                continue

            raw_title = video.get("text") or video.get("title") or ""
            clean_title_val = clean_title(raw_title)

            def clean(v: Any) -> Optional[str]:
                if isinstance(v, str) and v.strip() == "":
                    return None
                return v

            # Initialize as VideoRow so we can add embedding later
            row: VideoRow = {
                "id": video_id,
                "url": clean(video.get("url")),
                "code": clean(video.get("code")),
                "episode": clean(video.get("episode")),
                "video_id": clean(video.get("videoId")),
                "title": clean(clean_title_val),
                "thumbnail": clean(video.get("thumbnail")),
                "preview": clean(video.get("preview")),
                "details": clean(video.get("details")),
                "release_date": clean(
                    video.get("releaseDate") or video.get("release_date")
                ),
                "genres": video.get("genres")
                if isinstance(video.get("genres"), list)
                else None,
                "embedding": None,  # Placeholder
            }

            if not all([row["url"], row["code"], row["episode"], row["video_id"]]):
                logger.warning(
                    f"Skipping video {video_id} due to missing required fields"
                )
                continue

            # Smart Merge Logic
            if video_id in existing_map:
                old = existing_map[video_id]
                for key in ["details", "release_date", "thumbnail", "preview", "title"]:
                    new_val = row.get(key)
                    old_val = old.get(key)
                    if (not new_val) and old_val:
                        row[key] = old_val

                if not row.get("genres") and old.get("genres"):
                    row["genres"] = old["genres"]

            embed_text = format_for_embedding(row)

            # Check if content changed to avoid re-embedding
            if video_id in existing_map:
                old = existing_map[video_id]
                old_embed_text = format_for_embedding(old)
                if embed_text == old_embed_text:
                    continue

            texts_to_embed.append(embed_text)
            rows_to_upsert.append(row)

        if not rows_to_upsert:
            logger.info("No new or updated videos to process.")
            return 0

        try:
            logger.info(f"Generating embeddings for {len(texts_to_embed)} items...")
            embeddings = embed(
                texts_to_embed, return_format="list", prefix=EMBED_DOC_PREFIX
            )
            for j, row in enumerate(rows_to_upsert):
                row["embedding"] = embeddings[j]
        except Exception as e:
            logger.error(f"Failed to generate embeddings: {e}")
            return 0

        count = self.repository.upsert(rows_to_upsert)
        elapsed = (time.time() - start_time) * 1000
        logger.info(f"Upserted {count} videos in {elapsed:.2f}ms")
        return count

    def search(
        self,
        query: str,
        top_k: int = 20,
        where: Optional[Dict] = None,
        candidate_ids: Optional[List[str]] = None,
        score_threshold: Optional[float] = None,
        diversity: float = 0.5,
        shuffle_seed: Optional[int] = None,
    ) -> List[SearchResultItem]:
        """
        Semantic search with optional diversity and shuffling.
        Returns a list of SearchResultItem, which includes score/distance.
        """
        start_time = time.time()
        query_embedding = embed(query, return_format="list", prefix=EMBED_QUERY_PREFIX)

        max_from_pool = len(candidate_ids) if candidate_ids else None
        effective_top_k = (
            min(top_k, max_from_pool) if max_from_pool is not None else top_k
        )

        is_shuffle = shuffle_seed is not None

        if is_shuffle:
            fetch_k = compute_shuffle_fetch_k(effective_top_k)
        elif diversity > 0:
            fetch_k = compute_fetch_k(effective_top_k, diversity)
        else:
            fetch_k = effective_top_k

        if score_threshold is not None and fetch_k > effective_top_k:
            fetch_k = int(fetch_k * 1.5)

        if max_from_pool is not None:
            fetch_k = min(fetch_k, max_from_pool)

        # Repository returns List[SearchMatch]
        results = self.repository.query_by_embedding(
            query_embedding=query_embedding,
            n_results=fetch_k * 2 if candidate_ids else fetch_k,
            score_threshold=None,
        )

        if candidate_ids:
            candidate_set = set(candidate_ids)
            results = [r for r in results if r["id"] in candidate_set]

        if score_threshold is not None:
            results = [r for r in results if r["score"] >= score_threshold]

        # If no further processing is needed, return early
        if len(results) <= effective_top_k and not is_shuffle and diversity <= 0:
            return results[:effective_top_k]

        def get_embeddings_fn(ids: List[str]) -> Optional[np.ndarray]:
            embs = self.repository.get_embeddings(ids)
            if not embs:
                return None
            arr = [embs[vid] for vid in ids if vid in embs]
            return np.array(arr) if len(arr) == len(ids) else None

        # Diversify/Shuffle logic expects List[Dict] but works with TypedDicts
        # as long as keys are present. We cast the return to List[SearchResultItem]
        # because the structure remains identical (just reordered/subset).

        if is_shuffle:
            if diversity > 0:
                diversified = shuffle_and_diversify(
                    results,
                    top_k=effective_top_k,
                    diversity=diversity,
                    seed=shuffle_seed,
                    get_embeddings_fn=get_embeddings_fn,
                )
                return diversified
            else:
                from utils.search_diversity import sample_candidate_pool

                sampled = sample_candidate_pool(
                    results,
                    sample_size=effective_top_k,
                    seed=shuffle_seed,
                    relevance_bias=1.0,
                )
                sampled.sort(key=lambda r: r["score"], reverse=True)
                return sampled

        if diversity > 0:
            diversified = diversify_results(
                results,
                top_k=effective_top_k,
                diversity=diversity,
                get_embeddings_fn=get_embeddings_fn,
            )
            return diversified

        return results[:effective_top_k]

    def get_count(self) -> int:
        return self.repository.count()

    def delete_videos(self, ids: List[str]) -> None:
        self.repository.delete(ids)


_service_instance: Optional["PostgresVideoService"] = None


def init_service(table_name: str = "videos") -> "PostgresVideoService":
    global _service_instance
    _service_instance = PostgresVideoService(table_name=table_name)
    return _service_instance


def get_service() -> "PostgresVideoService":
    global _service_instance
    if _service_instance is None:
        _service_instance = PostgresVideoService()
    return _service_instance


def get_count() -> int:
    return get_service().get_count()


def search(query: str, top_k: int = 20, **kwargs) -> List[SearchResultItem]:
    return get_service().search(query, top_k, **kwargs)


def upsert_videos(videos: List[Dict]) -> int:
    return get_service().upsert_videos(videos)


def get_video(video_id: str) -> Optional[Video]:
    return get_service().get_video(video_id)


def get_videos_by_ids(video_ids: List[str]) -> List[Video]:
    return get_service().get_videos_by_ids(video_ids)


def get_videos(
    limit: Optional[int] = None, offset: int = 0, where: Optional[Dict] = None
) -> VideoListResponse:
    return get_service().get_videos(limit=limit, offset=offset, where=where)


def get_codes() -> CodeResponse:
    return get_service().get_codes()


def get_videos_grouped_by_code(
    min_count: int = 1, top_n: Optional[int] = None, limit_per_group: int = 20
) -> GroupedVideoResponse:
    return get_service().get_videos_grouped_by_code(
        min_count=min_count, top_n=top_n, limit_per_group=limit_per_group
    )


def delete_videos(ids: List[str]) -> None:
    return get_service().delete_videos(ids)
