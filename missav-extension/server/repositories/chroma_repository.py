"""ChromaDB repository — the ONLY module that touches PersistentClient/Collection directly.

Business logic (pagination, similarity scoring, document text building,
singleton lifecycle) stays in services/chroma_service.py. This module
just does CRUD against the vector store.
"""

import logging
from typing import Optional

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
        result = self.collection.get(ids=unique_ids, include=["documents", "metadatas"])

        records = [
            VideoRecord(
                id=result["ids"][i],
                document=result["documents"][i],
                metadata=result["metadatas"][i] or {},
            )
            for i in range(len(result["ids"]))
        ]
        logger.debug(
            f"✅ [ChromaRepository] Found {len(records)}/{len(unique_ids)} records"
        )
        return VideoRecordPage(records=records, total=len(records))

    def get_all(self, where: Optional[dict] = None) -> VideoRecordPage:
        """Fetch all records matching an optional metadata filter (no slicing)."""
        logger.debug(f"📋 [ChromaRepository] get_all (where={where})")
        try:
            result = self.collection.get(
                where=where, include=["documents", "metadatas"]
            )
        except Exception as e:
            logger.error(f"❌ [ChromaRepository] get_all failed: {e}")
            return VideoRecordPage(records=[], total=0)

        records = [
            VideoRecord(
                id=result["ids"][i],
                document=result["documents"][i],
                metadata=result["metadatas"][i] or {},
            )
            for i in range(len(result["ids"]))
        ]
        return VideoRecordPage(records=records, total=len(records))

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
            result = self.collection.get(ids=ids, include=["embeddings"])
            if result["embeddings"] is not None and len(result["embeddings"]) > 0:
                return EmbeddingsResult(ids=ids, vectors=np.array(result["embeddings"]))
        except Exception as e:
            logger.warning(f"⚠️ [ChromaRepository] get_embeddings failed: {e}")
        return EmbeddingsResult(ids=ids, vectors=None)

    def count(self) -> int:
        return self.collection.count()

    def delete(self, ids: list[str]) -> None:
        if ids:
            self.collection.delete(ids=ids)
            logger.info(f"🗑️ [ChromaRepository] Deleted {len(ids)} records")
