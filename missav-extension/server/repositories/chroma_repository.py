"""ChromaDB repository — the ONLY module that touches PersistentClient/Collection directly.
Business logic (pagination, similarity scoring, document text building,
singleton lifecycle) stays in services/chroma_service.py. This module
just does CRUD against the vector store.
"""

import logging
from typing import Dict, List, Optional

from chromadb import Documents, EmbeddingFunction, Embeddings, PersistentClient
from chromadb.config import Settings
from jet.adapters.llama_cpp import config as llm_config
from jet.adapters.llama_cpp.embed_utils import embed
from models.chroma import (
    EmbeddingsResult,
    QueryMatch,
    QueryResult,
    VideoRecord,
    VideoRecordPage,
)

logger = logging.getLogger(__name__)

# Chunk size for fetching data to avoid SQLite "too many SQL variables" error
CHUNK_SIZE = 1000


class LlamaCppEmbeddingFunction(EmbeddingFunction):
    """
    Chroma-compatible embedding function backed by the local llama.cpp
    embedding server. Used only for DOCUMENT embedding (add/upsert).
    Query embedding is done separately so query vs. doc prefixes can differ.
    """

    def __call__(self, input: Documents) -> Embeddings:
        prefix = llm_config.EMBED_DOC_PREFIX or None
        logger.info(
            f"🧠 [EmbeddingFn] Embedding {len(input)} texts via llama.cpp "
            f"(doc_prefix={prefix!r})"
        )
        return embed(
            list(input), return_format="list", show_progress=False, prefix=prefix
        )


class ChromaVideoRepository:
    """Thin wrapper around a ChromaDB PersistentClient collection."""

    def __init__(
        self,
        persist_directory: str,
        collection_name: str = "missav_videos",
    ):
        self.client = PersistentClient(
            path=persist_directory,
            settings=Settings(anonymized_telemetry=False),
        )
        logger.info(f"💾 [ChromaRepository] Persistent storage at: {persist_directory}")
        self.embedding_function = LlamaCppEmbeddingFunction()
        self.collection_name = collection_name
        try:
            self.collection = self.client.get_collection(
                collection_name, embedding_function=self.embedding_function
            )
            logger.info(
                f"✅ [ChromaRepository] Loaded existing collection: {collection_name}"
            )
        except Exception:
            self.collection = self.client.create_collection(
                name=collection_name,
                metadata={"hnsw:space": "cosine"},
                embedding_function=self.embedding_function,
            )
            logger.info(
                f"🆕 [ChromaRepository] Created new collection: {collection_name}"
            )

    def _get_all_ids(self) -> List[str]:
        """Fetch all IDs from the collection. Safe for large datasets."""
        try:
            # Fetching only IDs is lighter, but still subject to limits if very large.
            # However, usually IDs are shorter than full documents/metadata.
            result = self.collection.get(include=[])
            return result["ids"]
        except Exception as e:
            logger.error(f"❌ [ChromaRepository] Failed to fetch all IDs: {e}")
            return []

    def _fetch_in_chunks(self, ids: List[str], include: List[str]) -> Dict:
        """
        Fetch data for a list of IDs in chunks to avoid SQL variable limits.
        Returns a merged dictionary with 'ids', 'documents', 'metadatas', etc.
        """
        if not ids:
            return {"ids": [], "documents": [], "metadatas": [], "embeddings": []}

        merged_results = {"ids": [], "documents": [], "metadatas": [], "embeddings": []}

        total = len(ids)
        for i in range(0, total, CHUNK_SIZE):
            chunk_ids = ids[i : i + CHUNK_SIZE]
            try:
                result = self.collection.get(ids=chunk_ids, include=include)
                merged_results["ids"].extend(result["ids"])

                if "documents" in include and result.get("documents"):
                    merged_results["documents"].extend(result["documents"])

                if "metadatas" in include and result.get("metadatas"):
                    merged_results["metadatas"].extend(result["metadatas"])

                if "embeddings" in include and result.get("embeddings"):
                    merged_results["embeddings"].extend(result["embeddings"])

            except Exception as e:
                logger.error(
                    f"❌ [ChromaRepository] Failed to fetch chunk {i}-{i + len(chunk_ids)}: {e}"
                )

        return merged_results

    def get_by_id(self, video_id: str) -> Optional[VideoRecord]:
        """Fetch a single record by ID. Returns None if not found."""
        logger.debug(f"🔍 [ChromaRepository] get_by_id: {video_id}")
        result = self.collection.get(ids=[video_id], include=["documents", "metadatas"])
        if not result["ids"]:
            logger.warning(f"⚠️ [ChromaRepository] No record for id: {video_id}")
            return None
        return VideoRecord(
            id=result["ids"][0],
            document=result["documents"][0],
            metadata=result["metadatas"][0] or {},
        )

    def get_by_ids(self, video_ids: list[str]) -> VideoRecordPage:
        """Fetch multiple records by ID. Missing IDs are silently skipped."""
        if not video_ids:
            return VideoRecordPage(records=[], total=0)

        unique_ids = list(dict.fromkeys(video_ids))
        logger.debug(f"🔍 [ChromaRepository] get_by_ids: {len(unique_ids)} ids")

        # Use chunked fetching for safety
        result = self._fetch_in_chunks(unique_ids, include=["documents", "metadatas"])

        records = [
            VideoRecord(
                id=result["ids"][i],
                document=result["documents"][i] if result["documents"] else "",
                metadata=result["metadatas"][i] if result["metadatas"] else {},
            )
            for i in range(len(result["ids"]))
        ]
        logger.debug(
            f"✅ [ChromaRepository] Found {len(records)}/{len(unique_ids)} records"
        )
        return VideoRecordPage(records=records, total=len(records))

    def get_all(self, where: Optional[dict] = None) -> VideoRecordPage:
        """Fetch all records matching an optional metadata filter."""
        logger.debug(f"📋 [ChromaRepository] get_all (where={where})")

        # If a filter is present, we rely on Chroma's internal filtering.
        # If no filter, we fetch all IDs first then chunk.
        if where:
            try:
                result = self.collection.get(
                    where=where, include=["documents", "metadatas"]
                )
                records = [
                    VideoRecord(
                        id=result["ids"][i],
                        document=result["documents"][i],
                        metadata=result["metadatas"][i] or {},
                    )
                    for i in range(len(result["ids"]))
                ]
                return VideoRecordPage(records=records, total=len(result["ids"]))
            except Exception as e:
                logger.error(f"❌ [ChromaRepository] get_all with where failed: {e}")
                return VideoRecordPage(records=[], total=0)

        # No filter: Fetch all IDs then chunk
        all_ids = self._get_all_ids()
        if not all_ids:
            return VideoRecordPage(records=[], total=0)

        result = self._fetch_in_chunks(all_ids, include=["documents", "metadatas"])
        records = [
            VideoRecord(
                id=result["ids"][i],
                document=result["documents"][i] if result["documents"] else "",
                metadata=result["metadatas"][i] if result["metadatas"] else {},
            )
            for i in range(len(result["ids"]))
        ]
        return VideoRecordPage(records=records, total=len(result["ids"]))

    def get_all_codes(self) -> Dict[str, int]:
        """
        Aggregate video counts per 'code' metadata field.
        Uses chunked fetching to avoid SQL variable limits.
        """
        logger.debug("🏷️ [ChromaRepository] get_all_codes: fetching metadatas")

        all_ids = self._get_all_ids()
        if not all_ids:
            return {}

        # We only need metadatas
        result = self._fetch_in_chunks(all_ids, include=["metadatas"])

        counts: Dict[str, int] = {}
        for metadata in result.get("metadatas") or []:
            code = (metadata or {}).get("code")
            if not code:
                continue
            counts[code] = counts.get(code, 0) + 1

        logger.debug(
            f"✅ [ChromaRepository] get_all_codes: {len(counts)} unique codes, "
            f"{sum(counts.values())} tagged videos"
        )
        return counts

    def upsert(
        self, ids: list[str], documents: list[str], metadatas: list[dict]
    ) -> None:
        """Insert-or-update records. Delegates embedding to the attached embedding function."""
        if not ids:
            return
        logger.debug(f"⬆️ [ChromaRepository] upsert: {len(ids)} records")
        self.collection.upsert(ids=ids, documents=documents, metadatas=metadatas)

    def query_by_embedding(
        self,
        query_embedding: list[float],
        n_results: int,
        where: Optional[dict] = None,
        where_document: Optional[dict] = None,
    ) -> QueryResult:
        """Vector similarity search using a precomputed query embedding."""
        result = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            where=where,
            where_document=where_document,
            include=["documents", "metadatas", "distances"],
        )
        matches = [
            QueryMatch(
                id=result["ids"][0][i],
                document=result["documents"][0][i],
                metadata=result["metadatas"][0][i] or {},
                distance=result["distances"][0][i],
            )
            for i in range(len(result["ids"][0]))
        ]
        return QueryResult(matches=matches)

    def get_embeddings(self, ids: list[str]) -> EmbeddingsResult:
        """Fetch stored embedding vectors for the given IDs."""
        import numpy as np

        try:
            # Embeddings might also be large, so we chunk here too
            result = self._fetch_in_chunks(ids, include=["embeddings"])
            if result["embeddings"] and len(result["embeddings"]) > 0:
                return EmbeddingsResult(
                    ids=result["ids"], vectors=np.array(result["embeddings"])
                )
        except Exception as e:
            logger.warning(f"⚠️ [ChromaRepository] get_embeddings failed: {e}")
        return EmbeddingsResult(ids=ids, vectors=None)

    def count(self) -> int:
        return self.collection.count()

    def delete(self, ids: list[str]) -> None:
        if ids:
            self.collection.delete(ids=ids)
            logger.info(f"🗑️ [ChromaRepository] Deleted {len(ids)} records")
