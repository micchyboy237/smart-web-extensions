import logging

from config import DB_CONNINFO
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

logger = logging.getLogger(__name__)


def _configure(conn) -> None:
    register_vector(conn)
    conn.commit()


# Singleton pool instance
pool = ConnectionPool(
    DB_CONNINFO,
    min_size=1,
    max_size=10,
    open=False,
    configure=_configure,
    kwargs={"row_factory": dict_row},
)


async def init_db():
    """Open the connection pool."""
    pool.open(wait=True)
    logger.info("DB pool opened")

    # Verify table existence
    try:
        with pool.connection() as conn:
            res = conn.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'videos'
                ) AS exists;
            """).fetchone()
            if not res or not res.get("exists"):
                raise Exception("Table 'public.videos' not found.")
            count = (
                conn.execute("SELECT COUNT(*) AS count FROM public.videos")
                .fetchone()
                .get("count", 0)
            )
            logger.info(f"Verified: public.videos exists with {count} rows.")
    except Exception as e:
        logger.error("Startup verification failed: %s", e)
        pool.close()
        raise e


async def close_db():
    """Close the connection pool."""
    pool.close()
    logger.info("DB pool closed")
