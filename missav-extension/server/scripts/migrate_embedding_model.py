"""
One-time migration: copy all videos from the old embedding collection
into a new collection embedded with whatever model is currently
configured via jet.adapters.llama_cpp.config (LLAMA_CPP_EMBED_MODEL
env var). Model-agnostic — re-run this any time you want to try a
different embed model, just change the env var and --target name.

IMPORTANT: before running, set your shell env so config.EMBED_MODEL
points to the model you want to try, e.g. in ~/.zshrc:
    export LLAMA_CPP_EMBED_MODEL="<model alias from models.ini>"
    export LLAMA_CPP_EMBED_DIMS="<matching dims>"
Then open a fresh shell (or `source ~/.zshrc`) before running this script.
The "⚙️ Active embed config" log line on startup always confirms which
model + dims are actually active for that run.

Give --target a name that reflects the model being tried, e.g.:
    --target missav_videos_embedding_gemma_300m
    --target missav_videos_qwen3_embed_0_6b
    --target missav_videos_nomic_embed_1_5
so multiple experiments can coexist side by side without collisions.

Safety model (blue-green):
  - The SOURCE collection is opened read-only and is NEVER modified.
  - All new vectors go into a brand-new TARGET collection.
  - If anything goes wrong, delete the target collection and nothing
    about your existing data has changed.

Usage:
    python migrate_to_embedding_gemma.py --target missav_videos_embedding_gemma_300m
    python migrate_to_embedding_gemma.py --target missav_videos_qwen3_embed_0_6b --dry-run
    python migrate_to_embedding_gemma.py --target missav_videos_nomic_embed_1_5 --batch-size 50
"""

import argparse
import logging
import sys
import time
from pathlib import Path

from chromadb import PersistentClient
from chromadb.config import Settings
from jet.adapters.llama_cpp import config as llm_config

sys.path.insert(0, str(Path(__file__).parent.parent))
from services.chroma_service import PERSIST_DIR, LlamaCppEmbeddingFunction

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("migrate_embedding_gemma")

SOURCE_COLLECTION = "missav_videos"
TARGET_COLLECTION = "missav_videos_embedding_gemma_300m"


def _log_active_config() -> None:
    """Print the currently-active embed config so a wrong env var is
    caught before any writes happen, not after."""
    logger.info(
        "⚙️ Active embed config -> "
        f"EMBED_MODEL={llm_config.EMBED_MODEL!r}, "
        f"EMBED_BASE_URL={llm_config.EMBED_BASE_URL!r}, "
        f"EMBED_DIMS={llm_config.EMBED_DIMS}"
    )


def migrate(
    persist_directory: str = PERSIST_DIR,
    source_name: str = SOURCE_COLLECTION,
    target_name: str = TARGET_COLLECTION,
    batch_size: int = 100,
    dry_run: bool = False,
) -> dict:
    """
    Copy all docs from source_name into target_name, re-embedded with
    whatever model config.EMBED_MODEL currently points to.
    Safe to re-run: already-migrated IDs are skipped.
    """
    _log_active_config()

    client = PersistentClient(
        path=persist_directory,
        settings=Settings(anonymized_telemetry=False),
    )

    # --- 1. Open SOURCE read-only. We only read documents/metadatas,
    #     never call add/upsert/delete on it, and never touch its
    #     embeddings (wrong model, wrong space). ---
    logger.info(f"📂 Opening source collection: {source_name}")
    source = client.get_collection(source_name)
    source_count = source.count()
    logger.info(f"📊 Source has {source_count} items")

    if source_count == 0:
        logger.warning("⚠️ Source collection is empty, nothing to migrate")
        return {"migrated": 0, "skipped": 0, "source_total": 0, "target_total": 0}

    # --- 2. Get or create TARGET using the default embedding function,
    #     which reads config.EMBED_MODEL under the hood ---
    new_embedding_fn = LlamaCppEmbeddingFunction()
    try:
        target = client.get_collection(target_name, embedding_function=new_embedding_fn)
        logger.info(f"✅ Found existing target collection: {target_name}")
    except Exception:
        target = client.create_collection(
            name=target_name,
            metadata={"hnsw:space": "cosine"},
            embedding_function=new_embedding_fn,
        )
        logger.info(f"🆕 Created target collection: {target_name}")

    # --- 3. Figure out what's already migrated, so re-runs are cheap ---
    existing_target_ids = set(target.get(include=[])["ids"])
    logger.info(f"🔁 {len(existing_target_ids)} items already present in target")

    # --- 4. Pull everything from source once (docs + metadatas only) ---
    all_source = source.get(include=["documents", "metadatas"])
    all_ids = all_source["ids"]
    all_docs = all_source["documents"]
    all_metas = all_source["metadatas"]

    todo_ids, todo_docs, todo_metas = [], [], []
    for _id, doc, meta in zip(all_ids, all_docs, all_metas):
        if _id in existing_target_ids:
            continue
        todo_ids.append(_id)
        todo_docs.append(doc)
        todo_metas.append(meta)

    logger.info(f"🚚 {len(todo_ids)} items to embed and copy")

    if dry_run:
        logger.info("🧪 Dry run — stopping before any writes")
        return {
            "migrated": 0,
            "skipped": len(existing_target_ids),
            "source_total": source_count,
            "target_total": target.count(),
            "pending": len(todo_ids),
        }

    # --- 5. Batch through, re-embedding and adding to target ---
    migrated = 0
    start_time = time.time()
    for batch_start in range(0, len(todo_ids), batch_size):
        batch_end = batch_start + batch_size
        b_ids = todo_ids[batch_start:batch_end]
        b_docs = todo_docs[batch_start:batch_end]
        b_metas = todo_metas[batch_start:batch_end]

        batch_t0 = time.time()
        try:
            # target.add() triggers new_embedding_fn(b_docs) internally —
            # this is where re-embedding with the new model happens.
            target.add(ids=b_ids, documents=b_docs, metadatas=b_metas)
            migrated += len(b_ids)
            elapsed = (time.time() - batch_t0) * 1000
            logger.info(
                f"✅ Batch {batch_start}-{batch_end}: {len(b_ids)} items "
                f"in {elapsed:.0f}ms ({migrated}/{len(todo_ids)} total)"
            )
        except Exception as e:
            logger.error(f"❌ Batch {batch_start}-{batch_end} failed: {e}")
            raise  # stop rather than silently produce a partial migration

    total_elapsed = time.time() - start_time
    logger.info(f"🏁 Migration finished in {total_elapsed:.1f}s")

    # --- 6. Verify: target should now match source in count ---
    target_total = target.count()
    ok = target_total == source_count
    logger.info(
        f"{'✅' if ok else '⚠️'} Verification: source={source_count}, "
        f"target={target_total}, match={ok}"
    )

    return {
        "migrated": migrated,
        "skipped": len(existing_target_ids),
        "source_total": source_count,
        "target_total": target_total,
        "verified": ok,
    }


def spot_check(
    persist_directory: str = PERSIST_DIR,
    target_name: str = TARGET_COLLECTION,
    query: str = "test",
    top_k: int = 3,
) -> None:
    """Quick sanity check: run one query against the new collection."""
    client = PersistentClient(
        path=persist_directory, settings=Settings(anonymized_telemetry=False)
    )
    target = client.get_collection(
        target_name, embedding_function=LlamaCppEmbeddingFunction()
    )
    results = target.query(query_texts=[query], n_results=top_k)
    logger.info(f"🔍 Spot-check query='{query}' -> {results['ids'][0]}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--persist-dir", default=PERSIST_DIR)
    parser.add_argument("--source", default=SOURCE_COLLECTION)
    parser.add_argument("--target", default=TARGET_COLLECTION)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    summary = migrate(
        persist_directory=args.persist_dir,
        source_name=args.source,
        target_name=args.target,
        batch_size=args.batch_size,
        dry_run=args.dry_run,
    )
    logger.info(f"📋 Summary: {summary}")

    if not args.dry_run and summary.get("verified"):
        spot_check(persist_directory=args.persist_dir, target_name=args.target)
