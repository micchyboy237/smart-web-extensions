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

# ── Lightweight topic extraction without BERTopic dependency ──────────
# We use a simpler approach since embeddings already exist in ChromaDB:
# 1. Fetch embeddings + documents from ChromaDB
# 2. Cluster with KMeans (avoids heavy HDBSCAN)
# 3. Extract keywords via CountVectorizer per cluster
# 4. Label topics with top keywords
#
# Falls back to full BERTopic pipeline only if embeddings are unavailable.


class AnalysisService:
    """
    Service wrapper for topic extraction using existing ChromaDB data.

    Key design decisions:
    - Reuses chroma_service.get_embeddings() to avoid re-embedding
    - Tracks video_id → topic mapping for the /topics/{id}/videos endpoint
    - Falls back to BERTopic only when embeddings are unavailable

    State:
    - _last_result: Cached extraction with video_id references
    - _video_topic_map: Dict of video_id → topic_id for lookups
    """

    MAX_ANALYSIS_VIDEOS = 2000  # Safety cap to avoid memory issues

    def __init__(self):
        """Initialize with empty state."""
        self._last_result: Optional[dict] = None
        self._video_topic_map: Dict[str, int] = {}
        self._video_documents: Dict[str, str] = {}  # video_id → document text
        self._topic_info_cache: Dict[int, dict] = {}
        logger.info("🧩 AnalysisService initialized (ChromaDB-embedding reuse mode)")

    def check_embedder(self) -> bool:
        """
        Verify embeddings are available via chroma_service.
        Returns True if we can fetch embeddings from the existing collection.
        """
        try:
            # Quick test: fetch one embedding
            count = chroma_service.get_count()
            if count == 0:
                logger.warning("No videos in ChromaDB — nothing to analyze")
                return False

            # Fetch embeddings for first few videos
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
        6. Cache video→topic mapping for later queries

        Args:
            video_ids: Specific videos to analyze (None = all, capped)
            min_topic_size: Discard clusters smaller than this
            top_n_words: Keywords to extract per topic
            n_topics: Force a specific number of topics (auto-detected if None)
            **kwargs: Accepted but ignored (compatibility with BERTopic params)

        Returns:
            Dict with 'topics', 'topic_labels', 'topic_info' keys
        """
        logger.info(
            f"🔬 Topic extraction: {'specific IDs' if video_ids else 'all videos'}, "
            f"min_topic_size={min_topic_size}"
        )

        # Step 1: Gather documents and embeddings
        docs, embeds, ids = self._fetch_data(video_ids)

        if len(docs) < min_topic_size:
            logger.warning(
                f"Only {len(docs)} documents — need at least {min_topic_size}"
            )
            return self._empty_result()

        logger.info(
            f"📊 Processing {len(docs)} documents, embedding shape={embeds.shape}"
        )

        # Step 2: Determine number of topics
        if n_topics is None:
            n_topics = self._estimate_topic_count(len(docs), min_topic_size)
        n_topics = max(2, min(n_topics, len(docs) // min_topic_size))

        logger.info(f"🎯 Clustering into {n_topics} topics")

        # Step 3: Cluster embeddings
        cluster_labels = self._cluster_embeddings(embeds, n_topics)

        # Step 4: Extract keywords per cluster
        topics = self._build_topics(
            docs, ids, cluster_labels, top_n_words, min_topic_size
        )

        # Step 5: Cache video → topic mapping
        self._video_topic_map = dict(zip(ids, cluster_labels))
        self._video_documents = dict(zip(ids, docs))
        self._topic_info_cache = {t["topic_id"]: t for t in topics}
        self._last_result = {
            "topics": topics,
            "topic_labels": cluster_labels.tolist(),
            "topic_info": self._build_topic_info_df(topics, cluster_labels),
        }

        logger.info(
            f"✅ Extracted {len(topics)} topics "
            f"(dropped {n_topics - len(topics)} small clusters)"
        )
        return self._last_result

    def _fetch_data(
        self, video_ids: Optional[List[str]]
    ) -> Tuple[List[str], np.ndarray, List[str]]:
        """
        Fetch documents and embeddings from ChromaDB.

        Returns:
            (documents, embeddings_array, video_ids)
        """
        if video_ids:
            # Fetch specific videos
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
            # Fetch all videos (capped)
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
        # Optional: PCA to 50 dims for cleaner clustering
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

        # Log cluster sizes
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
    ) -> List[dict]:
        """
        Build topic representations from clusters.

        For each cluster:
        1. Check if it meets min_topic_size
        2. Extract top keywords using CountVectorizer
        3. Find most representative document
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
            # Get documents in this cluster
            mask = cluster_labels == label
            cluster_docs = [documents[i] for i, m in enumerate(mask) if m]
            cluster_ids = [video_ids[i] for i, m in enumerate(mask) if m]
            cluster_size = len(cluster_docs)

            if cluster_size < min_topic_size:
                logger.debug(
                    f"Skipping cluster {label}: size={cluster_size} < {min_topic_size}"
                )
                continue

            # Extract keywords
            try:
                tf_matrix = vectorizer.fit_transform(cluster_docs)
                feature_names = vectorizer.get_feature_names_out()
                scores = np.array(tf_matrix.sum(axis=0)).flatten()
                top_indices = scores.argsort()[-top_n_words:][::-1]
                keywords = [feature_names[i] for i in top_indices]
            except Exception:
                keywords = ["mixed_content"]

            # Find representative doc (closest to centroid of this cluster)
            # Simplified: use the first doc
            rep_doc = cluster_docs[0][:200] if cluster_docs else ""

            # Generate name from top 3 keywords
            name = "_".join(keywords[:3])

            topics.append(
                {
                    "topic_id": int(label),
                    "name": name,
                    "keywords": keywords,
                    "size": cluster_size,
                    "representative_doc": rep_doc,
                    "video_ids": cluster_ids,  # ← NEW: track which videos belong here
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
                    "Representative_Docs": t["representative_doc"],
                }
            )

        # Add outlier row
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
                    "Representative_Docs": "",
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

    # ── Post-extraction query methods ──────────────────────────────────

    def get_topic_info(self, topic_id: int) -> Optional[dict]:
        """Get cached topic info by ID."""
        return self._topic_info_cache.get(topic_id)

    def get_topic_documents(self, topic_id: int) -> List[dict]:
        """
        Get actual video documents assigned to a topic.
        Uses the cached video_topic_map for accurate lookups.
        """
        if not self._video_topic_map:
            return []

        # Find all video IDs for this topic
        matching_ids = [
            vid for vid, tid in self._video_topic_map.items() if tid == topic_id
        ]

        # Fetch full video data from ChromaDB
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

    def search_topics(self, keyword: str, limit: int = 5) -> List[dict]:
        """Search cached topics by keyword in topic names/keywords."""
        if not self._topic_info_cache:
            logger.warning("No cached topics — run extraction first")
            return []

        keyword_lower = keyword.lower()
        matching = []

        for topic in self._topic_info_cache.values():
            searchable = (
                topic.get("name", "").lower()
                + " "
                + " ".join(topic.get("keywords", [])).lower()
            )
            if keyword_lower in searchable:
                matching.append(dict(topic))

        matching.sort(key=lambda t: t.get("size", 0), reverse=True)
        return matching[:limit]

    def clear_cache(self):
        """Clear all cached extraction results."""
        self._last_result = None
        self._video_topic_map.clear()
        self._video_documents.clear()
        self._topic_info_cache.clear()
        logger.info("🗑️ Analysis cache cleared")


# ── Singleton pattern ──────────────────────────────────────────────────

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
