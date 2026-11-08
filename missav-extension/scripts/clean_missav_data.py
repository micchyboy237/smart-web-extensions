# /Users/jethroestrada/Desktop/External_Projects/Jet_Apps/web-extensions/smart-web-extensions/missav-extension/scripts/clean_missav_data.py

import logging
from pathlib import Path

import chromadb

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

PERSIST_DIR = str(Path("~/.cache/chrome_db/missav/chroma_data").expanduser().resolve())


def clean_video_metadata():
    logger.info(f"Connecting to ChromaDB at: {PERSIST_DIR}")

    try:
        # 1. Connect to persistent client
        client = chromadb.PersistentClient(path=PERSIST_DIR)

        # 2. Get the collection
        collection = client.get_collection("missav_videos")

        # 3. Get all IDs to process
        # We only need IDs for the update operation
        logger.info("Fetching all video IDs...")
        all_data = collection.get(include=[])
        ids = all_data["ids"]

        if not ids:
            logger.info("No videos found in the database.")
            return

        logger.info(f"Found {len(ids)} videos to process.")

        # 4. Prepare metadata updates
        # ChromaDB requires metadata to be a list of dicts matching the order of IDs
        # We set the specific fields to None.
        # Note: In ChromaDB, setting a value to None effectively removes it or marks it as null
        # depending on the version, but for our ingestion logic, None is treated as "missing".
        metadatas_to_update = [{"details": None, "release_date": None} for _ in ids]

        # 5. Batch update
        # We process in batches to avoid memory issues or timeout with very large datasets
        batch_size = 500
        total_updated = 0

        logger.info(f"Starting cleanup in batches of {batch_size}...")

        for i in range(0, len(ids), batch_size):
            batch_ids = ids[i : i + batch_size]
            batch_metadatas = metadatas_to_update[i : i + batch_size]

            try:
                collection.update(ids=batch_ids, metadatas=batch_metadatas)
                total_updated += len(batch_ids)
                logger.info(f"Processed {total_updated}/{len(ids)} videos...")
            except Exception as e:
                logger.error(f"Error updating batch starting at index {i}: {e}")

        logger.info(f"✅ Cleanup complete. Updated {total_updated} videos.")
        logger.info("Note: 'details' and 'release_date' are now set to None.")

    except Exception as e:
        logger.error(f"❌ Failed to connect or clean data: {e}")


if __name__ == "__main__":
    clean_video_metadata()
