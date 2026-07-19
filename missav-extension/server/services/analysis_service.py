"""Analysis service for BERTopic topic extraction and management.
Reuses ChromaDB's existing embeddings to avoid duplicate embedding work.
"""

import logging
from collections import Counter
from typing import Dict, List, Optional, Tuple

import numpy as np
from services import chroma_service
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import CountVectorizer

logger = logging.getLogger(__name__)


class AnalysisService:
    """
    Service wrapper for topic extraction using existing ChromaDB data.
    Key design decisions:
    - Reuses chroma_service.get_embeddings() to avoid re-embedding
    - Tracks video_id → topic mapping for the /topics/{id}/videos endpoint
    - Minimal state: only _video_topic_map is kept between calls
    State:
    - _video_topic_map: Dict of video_id → topic_id for session-based lookups
    """

    MAX_ANALYSIS_VIDEOS = 2000

    def __init__(self):
        """Initialize with empty state."""
        self._video_topic_map: Dict[str, int] = {}
        logger.info("🧩 AnalysisService initialized (ChromaDB-embedding reuse mode)")

    def check_embedder(self) -> bool:
        """
        Verify embeddings are available via chroma_service.
        Returns True if we can fetch embeddings from the existing collection.
        """
        try:
            count = chroma_service.get_count()
            if count == 0:
                logger.warning("No videos in ChromaDB — nothing to analyze")
                return False
            all_videos = chroma_service.get_videos(limit=5, offset=0)
            if not all_videos["videos"]:
                return False
            ids = [v["id"] for v in all_videos["videos"]]
            embeddings = chroma_service.get_embeddings(ids)
            if embeddings is None or len(embeddings) == 0:
                logger.warning("ChromaDB has no embeddings stored")
                return False
            logger.info(
                f"✅ Embedding check passed: shape={embeddings.shape}, "
                f"dims={embeddings.shape[1]}"
            )
            return True
        except Exception as e:
            logger.warning(f"Embedder check failed: {e}")
            return False

    def extract_topics(
        self,
        video_ids: Optional[List[str]] = None,
        min_topic_size: int = 3,
        top_n_words: int = 10,
        n_topics: Optional[int] = None,
        n_representative_docs: Optional[int] = None,
        **kwargs,
    ) -> dict:
        """
        Extract topics using existing ChromaDB embeddings.
        Pipeline:
        1. Fetch documents + embeddings from ChromaDB
        2. Determine optimal cluster count (or use provided n_topics)
        3. KMeans clustering on embeddings
        4. Extract keywords per cluster via CountVectorizer
        5. Filter small clusters (< min_topic_size)
        6. Store video→topic mapping for later queries
        Args:
            video_ids: Specific videos to analyze (None = all, capped)
            min_topic_size: Discard clusters smaller than this
            top_n_words: Keywords to extract per topic
            n_topics: Force a specific number of topics (auto-detected if None)
            n_representative_docs: Max representative docs per topic (None = all)
            **kwargs: Accepted but ignored (compatibility with BERTopic params)
        Returns:
            Dict with 'topics', 'topic_labels', 'topic_info' keys
        """
        logger.info(
            f"🔬 Topic extraction: {'specific IDs' if video_ids else 'all videos'}, "
            f"min_topic_size={min_topic_size}"
        )
        docs, embeds, ids = self._fetch_data(video_ids)
        if len(docs) < min_topic_size:
            logger.warning(
                f"Only {len(docs)} documents — need at least {min_topic_size}"
            )
            return self._empty_result()
        logger.info(
            f"📊 Processing {len(docs)} documents, embedding shape={embeds.shape}"
        )
        if n_topics is None:
            n_topics = self._estimate_topic_count(len(docs), min_topic_size)
        n_topics = max(2, min(n_topics, len(docs) // min_topic_size))
        logger.info(f"🎯 Clustering into {n_topics} topics")
        cluster_labels = self._cluster_embeddings(embeds, n_topics)
        topics = self._build_topics(
            docs,
            ids,
            cluster_labels,
            top_n_words,
            min_topic_size,
            n_representative_docs,
        )
        self._video_topic_map = dict(zip(ids, cluster_labels))
        topic_info_df = self._build_topic_info_df(topics, cluster_labels)
        logger.info(
            f"✅ Extracted {len(topics)} topics "
            f"(dropped {n_topics - len(topics)} small clusters)"
        )
        return {
            "topics": topics,
            "topic_labels": cluster_labels.tolist(),
            "topic_info": topic_info_df,
        }

    def _fetch_data(
        self, video_ids: Optional[List[str]]
    ) -> Tuple[List[str], np.ndarray, List[str]]:
        """
        Fetch documents and embeddings from ChromaDB.
        Returns:
            (documents, embeddings_array, video_ids)
        """
        if video_ids:
            documents = []
            valid_ids = []
            for vid in video_ids:
                video = chroma_service.get_video(vid)
                if video:
                    documents.append(
                        video.get("document", video.get("metadata", {}).get("text", ""))
                    )
                    valid_ids.append(vid)
            if not valid_ids:
                return [], np.array([]), []
            embeddings = chroma_service.get_embeddings(valid_ids)
            if embeddings is None:
                logger.warning("No embeddings returned for specific IDs")
                return [], np.array([]), []
            return documents, embeddings, valid_ids
        else:
            all_videos = chroma_service.get_videos(
                limit=self.MAX_ANALYSIS_VIDEOS, offset=0
            )
            videos = all_videos["videos"]
            if not videos:
                return [], np.array([]), []
            ids = [v["id"] for v in videos]
            documents = [
                v.get("document", v.get("metadata", {}).get("text", "")) for v in videos
            ]
            embeddings = chroma_service.get_embeddings(ids)
            if embeddings is None:
                logger.warning("No embeddings available — cannot extract topics")
                return [], np.array([]), []
            return documents, embeddings, ids

    def _estimate_topic_count(self, n_docs: int, min_topic_size: int) -> int:
        """
        Heuristic to estimate a reasonable number of topics.
        Based on: sqrt(n_docs / 2) clamped to sensible bounds.
        """
        import math

        estimated = int(math.sqrt(n_docs / 2))
        max_topics = n_docs // min_topic_size
        return max(2, min(estimated, max_topics, 15))

    def _cluster_embeddings(
        self, embeddings: np.ndarray, n_clusters: int
    ) -> np.ndarray:
        """
        Cluster embeddings using KMeans (fast, deterministic).
        For high-dimensional embeddings, optionally apply PCA first
        to reduce noise and speed up clustering.
        """
        if embeddings.shape[1] > 100 and embeddings.shape[0] > 50:
            pca = PCA(n_components=min(50, embeddings.shape[0] - 1))
            reduced = pca.fit_transform(embeddings)
            logger.debug(
                f"PCA: {embeddings.shape[1]} → {reduced.shape[1]} dims "
                f"(variance retained: {pca.explained_variance_ratio_.sum():.2%})"
            )
        else:
            reduced = embeddings
        kmeans = KMeans(
            n_clusters=n_clusters,
            random_state=42,
            n_init=10,
            max_iter=300,
        )
        labels = kmeans.fit_predict(reduced)
        sizes = Counter(labels)
        logger.debug(f"Cluster sizes: {dict(sorted(sizes.items()))}")
        return labels

    def _build_topics(
        self,
        documents: List[str],
        video_ids: List[str],
        cluster_labels: np.ndarray,
        top_n_words: int,
        min_topic_size: int,
        n_representative_docs: Optional[int] = None,
    ) -> List[dict]:
        """
        Build topic representations from clusters.
        For each cluster:
        1. Check if it meets min_topic_size
        2. Extract top keywords using CountVectorizer
        3. Build representative docs list (all or capped)
        4. Generate topic name from keywords
        """
        vectorizer = CountVectorizer(
            stop_words="english",
            ngram_range=(1, 2),
            max_features=1000,
        )
        topics = []
        unique_labels = sorted(set(cluster_labels))
        for label in unique_labels:
            mask = cluster_labels == label
            cluster_docs = [documents[i] for i, m in enumerate(mask) if m]
            cluster_ids = [video_ids[i] for i, m in enumerate(mask) if m]
            cluster_size = len(cluster_docs)
            if cluster_size < min_topic_size:
                logger.debug(
                    f"Skipping cluster {label}: size={cluster_size} < {min_topic_size}"
                )
                continue
            try:
                tf_matrix = vectorizer.fit_transform(cluster_docs)
                feature_names = vectorizer.get_feature_names_out()
                scores = np.array(tf_matrix.sum(axis=0)).flatten()
                top_indices = scores.argsort()[-top_n_words:][::-1]
                keywords = [feature_names[i] for i in top_indices]
            except Exception:
                keywords = ["mixed_content"]

            # Build representative docs list (all or capped)
            if n_representative_docs is not None:
                representative_docs = [
                    doc[:200] for doc in cluster_docs[:n_representative_docs]
                ]
                logger.debug(
                    "Topic %d: %d docs available, capped to %d representative docs",
                    label,
                    cluster_size,
                    n_representative_docs,
                )
            else:
                representative_docs = [doc[:200] for doc in cluster_docs]
                logger.debug(
                    "Topic %d: returning all %d representative docs",
                    label,
                    cluster_size,
                )

            name = "_".join(keywords[:3])
            topics.append(
                {
                    "topic_id": int(label),
                    "name": name,
                    "keywords": keywords,
                    "size": cluster_size,
                    "representative_docs": representative_docs,
                    "video_ids": cluster_ids,
                }
            )
        return topics

    def _build_topic_info_df(self, topics: List[dict], labels: np.ndarray):
        """
        Build a DataFrame-compatible structure (matches BERTopic format).
        Used for compatibility with existing result types.
        """
        import pandas as pd

        rows = []
        for t in topics:
            rows.append(
                {
                    "Topic": t["topic_id"],
                    "Count": t["size"],
                    "Name": t["name"],
                    "Representation": t["keywords"],
                    "Representative_Docs": t.get("representative_docs", []),
                }
            )
        outlier_count = sum(
            1 for l in labels if l not in [t["topic_id"] for t in topics]
        )
        if outlier_count > 0:
            rows.append(
                {
                    "Topic": -1,
                    "Count": outlier_count,
                    "Name": "Outlier",
                    "Representation": [],
                    "Representative_Docs": [],
                }
            )
        return pd.DataFrame(rows)

    def _empty_result(self) -> dict:
        """Return empty result structure."""
        return {
            "topics": [],
            "topic_labels": [],
            "topic_info": None,
        }

    def get_topic_documents(self, topic_id: int) -> List[dict]:
        """
        Get actual video documents assigned to a topic.
        Only works after extract_topics() has been called in the same session.
        """
        if not self._video_topic_map:
            logger.warning("No topic mapping available — run extract_topics first")
            return []
        matching_ids = [
            vid for vid, tid in self._video_topic_map.items() if tid == topic_id
        ]
        logger.debug(
            "Topic %d: found %d videos in session mapping",
            topic_id,
            len(matching_ids),
        )
        videos = []
        for vid in matching_ids:
            video = chroma_service.get_video(vid)
            if video:
                videos.append(
                    {
                        "id": vid,
                        "document": video.get("document", ""),
                        "metadata": video.get("metadata", {}),
                    }
                )
        return videos


_analysis_instance: Optional[AnalysisService] = None


def init_analysis_service() -> AnalysisService:
    """Initialize the analysis service singleton (called at startup)."""
    global _analysis_instance
    _analysis_instance = AnalysisService()
    logger.info("🧩 AnalysisService singleton initialized (ChromaDB-embedding mode)")
    return _analysis_instance


def get_analysis_service() -> AnalysisService:
    """Get the shared analysis service instance."""
    global _analysis_instance
    if _analysis_instance is None:
        logger.warning("⚠️ AnalysisService not initialized — creating with defaults")
        _analysis_instance = AnalysisService()
    return _analysis_instance


# ── Module-level convenience functions ──────────────────────────────────


def check_embedder() -> bool:
    """
    Verify embeddings are available via chroma_service.

    Convenience wrapper — equivalent to get_analysis_service().check_embedder().
    """
    logger.info("🔍 [analysis_service] Module-level check_embedder() called")
    result = get_analysis_service().check_embedder()
    logger.info(f"✅ [analysis_service] Embedder check result: {result}")
    return result


def extract_topics(
    video_ids: Optional[List[str]] = None,
    min_topic_size: int = 3,
    top_n_words: int = 10,
    n_topics: Optional[int] = None,
    n_representative_docs: Optional[int] = None,
    **kwargs,
) -> dict:
    """
    Extract topics from ChromaDB video embeddings.

    Convenience wrapper — equivalent to get_analysis_service().extract_topics(...).
    """
    logger.info(
        f"🔬 [analysis_service] Module-level extract_topics() called "
        f"(video_ids={'provided' if video_ids else 'all'}, "
        f"min_topic_size={min_topic_size}, top_n_words={top_n_words})"
    )
    service = get_analysis_service()
    result = service.extract_topics(
        video_ids=video_ids,
        min_topic_size=min_topic_size,
        top_n_words=top_n_words,
        n_topics=n_topics,
        n_representative_docs=n_representative_docs,
        **kwargs,
    )
    topic_count = len(result.get("topics", []))
    logger.info(f"✅ [analysis_service] Extracted {topic_count} topics")
    return result


def get_topic_documents(topic_id: int) -> List[dict]:
    """
    Get actual video documents assigned to a topic.

    Convenience wrapper — equivalent to get_analysis_service().get_topic_documents(topic_id).
    Only works after extract_topics() has been called in the same session.
    """
    logger.info(
        f"📋 [analysis_service] Module-level get_topic_documents(topic_id={topic_id})"
    )
    service = get_analysis_service()
    result = service.get_topic_documents(topic_id)
    logger.info(
        f"✅ [analysis_service] Found {len(result)} documents for topic {topic_id}"
    )
    return result


def get_video_topic_map() -> Dict[str, int]:
    """
    Get the current video_id → topic_id mapping.

    Only populated after extract_topics() has been called.
    Returns a copy to prevent accidental mutation.
    """
    service = get_analysis_service()
    mapping = dict(service._video_topic_map)
    logger.debug(
        f"🗺️ [analysis_service] get_video_topic_map: {len(mapping)} entries, "
        f"{len(set(mapping.values()))} unique topics"
    )
    return mapping


def get_topic_count() -> int:
    """
    Get the number of unique topics in the current session mapping.

    Returns 0 if extract_topics() hasn't been called yet.
    """
    service = get_analysis_service()
    count = len(set(service._video_topic_map.values()))
    logger.info(f"📊 [analysis_service] Current topic count: {count}")
    return count


def reset_topics() -> None:
    """
    Clear the current topic mapping (resets session state).

    Useful for re-running extraction with different parameters.
    """
    logger.info("🔄 [analysis_service] Resetting topic mapping")
    service = get_analysis_service()
    service._video_topic_map.clear()
    logger.info("✅ [analysis_service] Topic mapping cleared")
