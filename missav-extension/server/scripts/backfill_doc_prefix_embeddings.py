"""
One-off script: re-embed all existing documents in the `missav_videos`
collection using the current EMBED_DOC_PREFIX (jet.adapters.llama_cpp.config).

Existing docs were embedded *before* doc/query-prefix support was added to
chroma_service, so their stored vectors don't reflect the prefix. This
script re-embeds each document with the prefix applied and swaps ONLY the
embedding vectors in place — ids/documents/metadatas are left untouched.

Run once after setting EMBED_DOC_PREFIX. Re-running is safe (idempotent —
it just re-embeds again with whatever prefix is currently active), but
there's no reason to run it twice unless the prefix or embed model changes.

Usage:
    export EMBED_DOC_PREFIX="search_document: "   # set before running
    python backfill_doc_prefix_embeddings.py
    python backfill_doc_prefix_embeddings.py --batch-size 50
    python backfill_doc_prefix_embeddings.py --dry-run
"""

import argparse
import logging
import sys
import time
from pathlib import Path

from chromadb import PersistentClient
from chromadb.config import Settings
from jet.adapters.llama_cpp import config as llm_config
from jet.adapters.llama_cpp.embed_utils import embed

sys.path.insert(0, str(Path(__file__).parent.parent))
from services.chroma_service import PERSIST_DIR, LlamaCppEmbeddingFunction

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("backfill_doc_prefix_embeddings")

COLLECTION_NAME = "missav_videos"


def _log_active_config() -> None:
    """Print active config so a missing/wrong prefix is caught before writes."""
    logger.info(
        "⚙️ Active embed config -> "
        f"EMBED_MODEL={llm_config.EMBED_MODEL!r}, "
        f"EMBED_DOC_PREFIX={llm_config.EMBED_DOC_PREFIX!r}, "
        f"EMBED_QUERY_PREFIX={llm_config.EMBED_QUERY_PREFIX!r}"
    )


def backfill(
    persist_directory: str = PERSIST_DIR,
    collection_name: str = COLLECTION_NAME,
    batch_size: int = 100,
    dry_run: bool = False,
) -> dict:
    """
    Re-embed every document in `collection_name` with EMBED_DOC_PREFIX
    applied, replacing only the stored embeddings.
    """
    _log_active_config()

    if not llm_config.EMBED_DOC_PREFIX:
        logger.warning(
            "⚠️ EMBED_DOC_PREFIX is empty — nothing to backfill. "
            "Set it in your env before running this script."
        )
        return {"updated": 0, "total": 0, "skipped_reason": "EMBED_DOC_PREFIX not set"}

    client = PersistentClient(
        path=persist_directory,
        settings=Settings(anonymized_telemetry=False),
    )
    collection = client.get_collection(
        collection_name, embedding_function=LlamaCppEmbeddingFunction()
    )

    logger.info(f"📂 Reading all documents from '{collection_name}'")
    all_data = collection.get(include=["documents"])
    ids = all_data["ids"]
    docs = all_data["documents"]
    total = len(ids)
    logger.info(f"📊 Found {total} documents")

    if total == 0:
        logger.warning("⚠️ Collection is empty, nothing to do")
        return {"updated": 0, "total": 0}

    if dry_run:
        sample = docs[0] if docs else ""
        logger.info(
            "🧪 Dry run — no writes performed. Sample prefixed text: "
            f"{(llm_config.EMBED_DOC_PREFIX + sample)[:100]!r}..."
        )
        return {"updated": 0, "total": total, "dry_run": True}

    updated = 0
    start_time = time.time()
    for batch_start in range(0, total, batch_size):
        batch_end = batch_start + batch_size
        b_ids = ids[batch_start:batch_end]
        b_docs = docs[batch_start:batch_end]

        batch_t0 = time.time()
        try:
            new_embeddings = embed(
                b_docs,
                return_format="list",
                show_progress=False,
                prefix=llm_config.EMBED_DOC_PREFIX,
            )
            collection.update(ids=b_ids, embeddings=new_embeddings)
            updated += len(b_ids)
            elapsed = (time.time() - batch_t0) * 1000
            logger.info(
                f"✅ Batch {batch_start}-{batch_end}: {len(b_ids)} docs "
                f"re-embedded in {elapsed:.0f}ms ({updated}/{total} total)"
            )
        except Exception as e:
            logger.error(f"❌ Batch {batch_start}-{batch_end} failed: {e}")
            raise

    total_elapsed = time.time() - start_time
    logger.info(
        f"🏁 Backfill finished: {updated}/{total} embeddings replaced "
        f"in {total_elapsed:.1f}s"
    )
    return {"updated": updated, "total": total}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--persist-dir", default=PERSIST_DIR)
    parser.add_argument("--collection", default=COLLECTION_NAME)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    summary = backfill(
        persist_directory=args.persist_dir,
        collection_name=args.collection,
        batch_size=args.batch_size,
        dry_run=args.dry_run,
    )
    logger.info(f"📋 Summary: {summary}")
