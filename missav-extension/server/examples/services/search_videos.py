"""
Search Demo: MissAV Video Database
Demonstrates Semantic, Keyword, and Hybrid search capabilities
using the migrated PostgreSQL vector store.
"""

import sys
from pathlib import Path

# Add server root to path
SERVER_DIR = Path(__file__).parent.parent.parent.resolve()
sys.path.append(str(SERVER_DIR))

from jet.adapters.llama_cpp.config import EMBED_QUERY_PREFIX
from jet.adapters.llama_cpp.embed_utils import embed
from jet.db.postgres.config import (
    DEFAULT_HOST,
    DEFAULT_PASSWORD,
    DEFAULT_PORT,
    DEFAULT_USER,
)
from jet.db.postgres.pgvector import PgVectorClient
from jet.logger import logger

PG_DB_NAME = "missav_db1"
TABLE_NAME = "videos"


def print_results(results, search_type):
    print(f"\n--- {search_type} Results ---")
    if not results:
        print("No results found.")
        return

    for i, res in enumerate(results, 1):
        title = res.get("title", "N/A")
        code = res.get("code", "N/A")
        episode = res.get("episode", "N/A")

        # Handle different score keys depending on search type
        if "hybrid_score" in res:
            score_info = f"Hybrid Score: {res['hybrid_score']:.4f}"
        elif "score" in res:
            score_info = f"Sim Score: {res['score']:.4f}"
        else:
            score_info = ""

        print(f"{i}. [{code}-{episode}] {title}")
        print(f"   {score_info}")
        if res.get("distance"):
            print(f"   Distance: {res['distance']:.4f}")


def main():
    logger.info(f"Connecting to PostgreSQL database: {PG_DB_NAME}")
    client = PgVectorClient(
        dbname=PG_DB_NAME,
        user=DEFAULT_USER,
        password=DEFAULT_PASSWORD,
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
    )

    try:
        # Test Queries
        queries = [
            # "Beautiful actress in red dress",  # Semantic
            # "SSIS-123",  # Exact Code (Keyword)
            # "Outdoor beach scene summer",  # Hybrid (Semantic + Keyword)
            "cuckold wife",
        ]

        for query_text in queries:
            logger.info(f"\nProcessing query: '{query_text}'")

            # 1. Generate Query Embedding
            query_embedding = embed(query_text, prefix=EMBED_QUERY_PREFIX).tolist()

            # 2. Semantic Search (Vector Only)
            semantic_results = client.search(
                table_name=TABLE_NAME,
                query_embedding=query_embedding,
                top_k=3,
                metric="cosine",
            )
            print_results(semantic_results, "Semantic Search")

            # 3. Hybrid Search (Vector + Keyword)
            # Uses Reciprocal Rank Fusion (RRF)
            hybrid_results = client.hybrid_search(
                table_name=TABLE_NAME,
                query_text=query_text,
                query_embedding=query_embedding,
                top_k=3,
                text_weight=1.0,
                vector_weight=1.0,
                content_column="title",  # Search keywords in title
            )
            print_results(hybrid_results, "Hybrid Search (RRF)")

    except Exception as e:
        logger.error(f"An error occurred during search demo: {e}")
    finally:
        client.close()
        logger.info("Connection closed.")


if __name__ == "__main__":
    main()
