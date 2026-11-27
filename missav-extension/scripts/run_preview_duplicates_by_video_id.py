import json
import shutil
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

OUTPUT_DIR = Path(__file__).parent / "generated" / Path(__file__).stem
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

OUTPUT_FILE = str(OUTPUT_DIR / "deduplication_preview.json")

# Database connection parameters
DB_PARAMS = {
    "dbname": "missav_db1",
    "user": "jethroestrada",  # Replace with your DB user
    "password": "",  # Replace with your DB password
    "host": "localhost",  # Replace with your DB host if remote
    "port": 5432,
}


def get_deduplication_preview(conn):
    """
    Queries the database to identify duplicates.
    Priority for keeping a row:
    1. Highest number of non-null fields (most complete data).
    2. Most recent updated_at.
    3. Most recent created_at.
    4. Smallest id (for determinism).
    """
    query = """
    WITH ranked_videos AS (
        SELECT 
            *,
            -- Count non-null values across all optional/important fields
            (
                CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN title IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN thumbnail IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN preview IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN details IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN release_date IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN genres IS NOT NULL THEN 1 ELSE 0 END
            ) as non_null_count,
            ROW_NUMBER() OVER (
                PARTITION BY video_id 
                ORDER BY 
                    -- Primary sort: Most complete row
                    (
                        CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END +
                        CASE WHEN title IS NOT NULL THEN 1 ELSE 0 END +
                        CASE WHEN thumbnail IS NOT NULL THEN 1 ELSE 0 END +
                        CASE WHEN preview IS NOT NULL THEN 1 ELSE 0 END +
                        CASE WHEN details IS NOT NULL THEN 1 ELSE 0 END +
                        CASE WHEN release_date IS NOT NULL THEN 1 ELSE 0 END +
                        CASE WHEN genres IS NOT NULL THEN 1 ELSE 0 END
                    ) DESC,
                    -- Secondary sort: Most recently updated
                    updated_at DESC, 
                    -- Tertiary sort: Most recently created
                    created_at DESC, 
                    -- Final tie-breaker: Smallest ID
                    id ASC
            ) as keep_rank,
            COUNT(*) OVER (PARTITION BY video_id) as total_duplicates
        FROM public.videos
    )
    SELECT 
        id,
        video_id,
        url,
        code,
        episode,
        title,
        thumbnail,
        preview,
        details,
        release_date,
        created_at,
        updated_at,
        genres,
        embedding, -- Included as requested, though large vectors make JSON heavy
        non_null_count,
        keep_rank,
        total_duplicates,
        CASE 
            WHEN keep_rank = 1 THEN 'KEEP'
            ELSE 'DELETE'
        END as action
    FROM ranked_videos
    WHERE total_duplicates > 1
    ORDER BY video_id, keep_rank;
    """

    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(query)
        return cur.fetchall()


def serialize_data(data):
    """
    Custom serializer to handle datetime objects, UUIDs, and other non-JSON types.
    """

    def default_serializer(obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        if isinstance(obj, bytes):
            # Handle vector type if it comes back as bytes or specific object
            return str(obj)
        raise TypeError(f"Object of type {type(obj)} is not JSON serializable")

    return json.dumps(data, indent=2, default=default_serializer)


def main():
    print("Connecting to database...")
    try:
        with psycopg.connect(**DB_PARAMS) as conn:
            print("Fetching deduplication preview...")
            results = get_deduplication_preview(conn)

            if not results:
                print("No duplicates found. The table is already clean!")
                return

            print(f"Found {len(results)} rows involved in duplication.")

            # Calculate summary stats
            to_keep = sum(1 for r in results if r["action"] == "KEEP")
            to_delete = sum(1 for r in results if r["action"] == "DELETE")

            print(f"  - Rows to KEEP: {to_keep}")
            print(f"  - Rows to DELETE: {to_delete}")

            # Save to JSON
            json_output = serialize_data(results)
            with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
                f.write(json_output)

            print(f"Preview saved successfully to '{OUTPUT_FILE}'")

    except Exception as e:
        print(f"An error occurred: {e}")


if __name__ == "__main__":
    main()
