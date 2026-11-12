"""
Migration Script: ChromaDB -> PostgreSQL (missav_db1)
Optimized for large datasets using chunked processing and bulk ingestion.
"""

import re
import sys
from datetime import datetime
from pathlib import Path

SERVER_DIR = Path(__file__).parent.resolve()
sys.path.append(str(SERVER_DIR))

from app.config import CHROMA_DIR
from jet.adapters.llama_cpp.config import EMBED_DIMS, EMBED_DOC_PREFIX
from jet.adapters.llama_cpp.embed_utils import embed
from jet.db.postgres.config import (
    DEFAULT_HOST,
    DEFAULT_PASSWORD,
    DEFAULT_PORT,
    DEFAULT_USER,
)
from jet.db.postgres.pgvector import PgVectorClient
from jet.logger import logger
from repositories.chroma_repository import ChromaVideoRepository

PG_DB_NAME = "missav_db1"
PG_USER = DEFAULT_USER
PG_PASSWORD = DEFAULT_PASSWORD
PG_HOST = DEFAULT_HOST
PG_PORT = DEFAULT_PORT
TABLE_NAME = "videos"
EMBEDDING_DIM = EMBED_DIMS
CHUNK_SIZE = 1000  # Process 1000 items at a time


def clean_title(title: str) -> str:
    if not title:
        return ""
    pattern = r"^[A-Za-z0-9]+-[A-Za-z0-9]+\s+"
    cleaned = re.sub(pattern, "", title)
    return cleaned.strip()


def clean_value(val):
    if isinstance(val, str) and val.strip() == "":
        return None
    return val


def format_for_embedding(record: dict) -> str:
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


def parse_release_date(val):
    if not val or not isinstance(val, str) or val.strip() == "":
        return None
    val = val.strip()
    try:
        if len(val) > 10:
            datetime.fromisoformat(val.replace("Z", "+00:00"))
            return val
        else:
            datetime.strptime(val, "%Y-%m-%d")
            return val
    except ValueError:
        pass

    formats = ["%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%B %d, %Y", "%b %d, %Y"]
    for fmt in formats:
        try:
            dt = datetime.strptime(val, fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def flatten_and_clean_record(record: dict) -> dict:
    meta = record.get("metadata", {})
    doc = record.get("document", "")
    raw_title = meta.get("text", "") or doc
    clean_title_val = clean_title(raw_title)
    raw_release_date = meta.get("release_date")
    cleaned_release_date = parse_release_date(raw_release_date)

    genres = meta.get("genres")
    # Ensure genres is a list or None, not a string representation of a list
    if isinstance(genres, str):
        try:
            genres = json.loads(genres)
        except:
            genres = [genres]

    return {
        "id": record["id"],
        "url": clean_value(meta.get("url")),
        "code": clean_value(meta.get("code")),
        "episode": clean_value(meta.get("episode")),
        "video_id": clean_value(meta.get("video_id")),
        "title": clean_value(clean_title_val),
        "thumbnail": clean_value(meta.get("thumbnail")),
        "preview": clean_value(meta.get("preview")),
        "details": clean_value(meta.get("details")),
        "release_date": cleaned_release_date,
        "genres": genres if isinstance(genres, list) else None,
    }


def migrate(limit: int = None):
    logger.info(f"Starting migration from ChromaDB to PostgreSQL ({PG_DB_NAME})")

    # 1. Initialize Chroma
    try:
        chroma_repo = ChromaVideoRepository(persist_directory=CHROMA_DIR)
        total_count = chroma_repo.count()
        logger.info(f"Found {total_count} records in ChromaDB")
    except Exception as e:
        logger.error(f"Failed to initialize ChromaDB: {e}")
        return

    if total_count == 0:
        logger.warning("ChromaDB is empty.")
        return

    # 2. Initialize PostgreSQL
    try:
        pg_client = PgVectorClient(
            dbname=PG_DB_NAME,
            user=PG_USER,
            password=PG_PASSWORD,
            host=PG_HOST,
            port=PG_PORT,
        )

        additional_columns = {
            "url": "TEXT NOT NULL",
            "code": "TEXT NOT NULL",
            "episode": "TEXT NOT NULL",
            "video_id": "TEXT NOT NULL",
            "title": "TEXT",
            "thumbnail": "TEXT",
            "preview": "TEXT",
            "details": "TEXT",
            "release_date": "TIMESTAMPTZ",
            "genres": "JSONB",
        }

        pg_client.create_vector_table(
            table_name=TABLE_NAME,
            dimension=EMBEDDING_DIM,
            additional_columns=additional_columns,
            include_timestamps=True,
        )
        logger.info(f"PostgreSQL table '{TABLE_NAME}' ready.")
    except Exception as e:
        logger.error(f"Failed to initialize PostgreSQL: {e}")
        return

    # 3. Fetch Data in Chunks
    # Note: For very large DBs, get_all might be heavy.
    # In a production env, you might want to iterate IDs or use pagination if supported.
    logger.info("Fetching data from ChromaDB...")
    page = chroma_repo.get_all(where=None)
    all_records = page.records
    if limit:
        all_records = all_records[:limit]

    total_to_process = len(all_records)
    logger.info(f"Processing {total_to_process} records in chunks of {CHUNK_SIZE}...")

    total_inserted = 0
    total_skipped = 0
    total_unchanged = 0

    for i in range(0, total_to_process, CHUNK_SIZE):
        chunk_records = all_records[i : i + CHUNK_SIZE]
        chunk_rows = []
        chunk_texts = []

        logger.info(
            f"Processing chunk {i // CHUNK_SIZE + 1} ({len(chunk_records)} records)..."
        )

        for record in chunk_records:
            try:
                row = flatten_and_clean_record(
                    {
                        "id": record.id,
                        "document": record.document,
                        "metadata": record.metadata,
                    }
                )

                # Validate required fields
                if not all([row["url"], row["code"], row["episode"], row["video_id"]]):
                    total_skipped += 1
                    continue

                # Check if already exists and unchanged
                existing = pg_client.get_row(TABLE_NAME, row["id"])
                if existing:
                    embed_text_new = format_for_embedding(row)
                    embed_text_old = format_for_embedding(existing)
                    if embed_text_new == embed_text_old:
                        total_unchanged += 1
                        continue

                chunk_texts.append(format_for_embedding(row))
                chunk_rows.append(row)

            except Exception as e:
                logger.warning(f"Error processing record {record.id}: {e}")
                total_skipped += 1

        if not chunk_rows:
            continue

        # Generate Embeddings for this chunk
        try:
            logger.info(f"Generating embeddings for {len(chunk_texts)} items...")
            embeddings = embed(
                chunk_texts, return_format="list", prefix=EMBED_DOC_PREFIX
            )

            # Attach embeddings
            for j, row in enumerate(chunk_rows):
                row["embedding"] = embeddings[j]

            # Bulk Ingest this chunk
            count = pg_client.bulk_ingest(
                TABLE_NAME, chunk_rows, dimension=EMBEDDING_DIM
            )
            total_inserted += count
            logger.success(f"Chunk saved: {count} records inserted/updated.")

        except Exception as e:
            logger.error(f"Error in chunk processing: {e}")

    logger.info(f"\n--- Migration Summary ---")
    logger.info(f"Total Inserted/Updated: {total_inserted}")
    logger.info(f"Total Unchanged: {total_unchanged}")
    logger.info(f"Total Skipped: {total_skipped}")

    # 4. Create Indexes (Do this at the end for performance)
    try:
        logger.info("Creating HNSW index for Cosine similarity...")
        pg_client.create_index(TABLE_NAME, metric="cosine", method="hnsw")

        logger.info("Creating Full-Text Search index...")
        pg_client.create_fts_index(TABLE_NAME, column_name="title")
        logger.success("Indexes created successfully.")

    except Exception as e:
        logger.error(f"Error creating indexes: {e}")

    pg_client.close()
    logger.info("Migration completed.")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Migrate ChromaDB to PostgreSQL")
    parser.add_argument("-l", "--limit", type=int, default=None, help="Limit records")
    args = parser.parse_args()
    migrate(limit=args.limit)
