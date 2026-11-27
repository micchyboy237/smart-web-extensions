import psycopg

# Database connection parameters
DB_PARAMS = {
    "dbname": "missav_db1",
    "user": "jethroestrada",
    "password": "",
    "host": "localhost",
    "port": 5432,
}


def run_migration(conn):
    """
    Performs the deduplication and adds the unique constraint.
    """
    cur = conn.cursor()

    try:
        print("Starting transaction...")

        # Step 1: Identify IDs to KEEP using the same logic as the preview
        # We use a CTE to rank rows by non-null count, then dates, then ID
        print("Identifying rows to keep...")
        cur.execute("""
            CREATE TEMP TABLE rows_to_keep AS
            SELECT id
            FROM (
                SELECT 
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY video_id 
                        ORDER BY 
                            (
                                CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END +
                                CASE WHEN title IS NOT NULL THEN 1 ELSE 0 END +
                                CASE WHEN thumbnail IS NOT NULL THEN 1 ELSE 0 END +
                                CASE WHEN preview IS NOT NULL THEN 1 ELSE 0 END +
                                CASE WHEN details IS NOT NULL THEN 1 ELSE 0 END +
                                CASE WHEN release_date IS NOT NULL THEN 1 ELSE 0 END +
                                CASE WHEN genres IS NOT NULL THEN 1 ELSE 0 END
                            ) DESC,
                            updated_at DESC, 
                            created_at DESC, 
                            id ASC
                    ) as rn
                FROM public.videos
            ) ranked
            WHERE rn = 1;
        """)

        # Step 2: Delete duplicates
        print("Deleting duplicate rows...")
        cur.execute("""
            DELETE FROM public.videos
            WHERE id NOT IN (SELECT id FROM rows_to_keep)
            AND video_id IN (
                SELECT video_id 
                FROM public.videos 
                GROUP BY video_id 
                HAVING COUNT(*) > 1
            );
        """)
        deleted_count = cur.rowcount
        print(f"Deleted {deleted_count} rows.")

        # Step 3: Verify no duplicates remain
        print("Verifying data integrity...")
        cur.execute("""
            SELECT COUNT(*) 
            FROM public.videos 
            GROUP BY video_id 
            HAVING COUNT(*) > 1
        """)
        remaining_dups = cur.fetchone()[0] if cur.rowcount > 0 else 0

        if remaining_dups > 0:
            raise Exception(
                f"Migration failed: {remaining_dups} duplicate video_ids still exist!"
            )

        # Step 4: Add Unique Constraint
        print("Adding UNIQUE constraint on video_id...")
        cur.execute(
            "ALTER TABLE public.videos ADD CONSTRAINT uq_videos_video_id UNIQUE (video_id);"
        )

        conn.commit()
        print("Migration completed successfully!")

    except Exception as e:
        conn.rollback()
        print(f"Error occurred. Transaction rolled back: {e}")
        raise
    finally:
        cur.close()


def main():
    print("Connecting to database...")
    try:
        with psycopg.connect(**DB_PARAMS) as conn:
            # Optional: Set a statement timeout to prevent long-running queries from hanging
            conn.execute("SET statement_timeout = '300s';")
            run_migration(conn)
    except Exception as e:
        print(f"Connection or execution error: {e}")


if __name__ == "__main__":
    main()
