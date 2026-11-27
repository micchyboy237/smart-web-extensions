"""
Migration script to create tables for storing MissAV topic modeling results.
Target Schema: public
"""

import psycopg
from psycopg.rows import dict_row

DB_CONNINFO = "dbname=missav_db1 user=jethroestrada host=localhost port=5432"


def run_migration():
    print("Starting migration for topic modeling tables...")

    conn = psycopg.connect(DB_CONNINFO, row_factory=dict_row)
    cur = conn.cursor()

    try:
        # 1. Create topic_runs table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.topic_runs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                code TEXT NOT NULL,
                n_topics INT NOT NULL,
                n_docs INT NOT NULL,
                top_k INT NOT NULL,
                no_llm BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                model_params JSONB
            );
        """)
        print("Created table: topic_runs")

        # 2. Create topics table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.topics (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                run_id UUID NOT NULL REFERENCES public.topic_runs(id) ON DELETE CASCADE,
                topic_id INT NOT NULL, -- Local ID from KeyNMF
                name TEXT,
                representative_doc_count INT,
                UNIQUE(run_id, topic_id)
            );
        """)
        print("Created table: topics")

        # 3. Create topic_words table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.topic_words (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                topic_id UUID NOT NULL REFERENCES public.topics(id) ON DELETE CASCADE,
                word TEXT NOT NULL,
                score FLOAT NOT NULL,
                rank INT NOT NULL
            );
        """)
        print("Created table: topic_words")

        # 4. Create topic_representative_docs table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.topic_representative_docs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                topic_id UUID NOT NULL REFERENCES public.topics(id) ON DELETE CASCADE,
                content TEXT,
                membership_score FLOAT,
                source_index INT,
                video_id TEXT -- Optional link to public.videos.id if resolvable
            );
        """)
        print("Created table: topic_representative_docs")

        # 5. Create document_topic_assignments table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.document_topic_assignments (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                run_id UUID NOT NULL REFERENCES public.topic_runs(id) ON DELETE CASCADE,
                source_index INT NOT NULL,
                topic_id INT NOT NULL, -- Local ID from KeyNMF
                topic_name TEXT,
                scores FLOAT[], -- Array of probabilities for all topics
                content TEXT
            );
        """)
        print("Created table: document_topic_assignments")

        # Create indexes for performance
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_topic_words_topic_id 
            ON public.topic_words(topic_id);
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_topic_rep_docs_topic_id 
            ON public.topic_representative_docs(topic_id);
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_doc_topic_assignments_run_id 
            ON public.document_topic_assignments(run_id);
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_doc_topic_assignments_topic_id 
            ON public.document_topic_assignments(run_id, topic_id);
        """)

        conn.commit()
        print("Migration completed successfully.")

    except Exception as e:
        conn.rollback()
        print(f"Migration failed: {e}")
        raise e
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    run_migration()
